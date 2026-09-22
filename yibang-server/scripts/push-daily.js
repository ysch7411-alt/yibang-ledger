/**
 * 每日经营提醒 —— 真下发（cron 调这个）
 *
 * 用法：node scripts/push-daily.js          # 真发
 *      node scripts/push-daily.js --dry    # 只算不发（看今天会推给谁、推什么）
 *
 * ── 为什么"值得说才发"，而不是每天固定发一条 ──
 * 微信订阅消息是**一次性授权**（授权一次只能发一条），额度很贵；
 * 更要紧的是：**没事也推，老板就会关掉通知** —— 那才是最大的损失。
 * 所以每天的判断交给 lib/skills/nudge-daily.js（Jev 判"有没有值得说的/说哪件/多急"），
 * 它说没事就**一条都不发**。这也正好省额度。
 *
 * ── 三道守卫 ──
 * ① 没配模板 id 直接退出（不报错）—— 这样代码可以先上线，模板后补；
 * ② 当天已经发过的用户跳过（cron 被误触发两次也不会重复打扰）；
 * ③ 只有**成功下发**才扣额度（失败还扣，用户就白授权了）。
 *
 * 同时写一条站内信：订阅消息可能因为额度/授权状态发不出去，
 * **打开小程序要看得到** —— 两个通道互为兜底，不能让老板什么都收不到。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../db/config');
const push = require('../lib/push');
const notif = require('../lib/notification');
const skills = require('../lib/skills');

const DRY = process.argv.includes('--dry');
/** 跳过"值不值得说"的判断，强制组装并下发。
 *  只用于**测推送链路本身**（模板字段对不对、能不能发出去）——
 *  平时绝不要用：它绕过了"没事不打扰"那条最重要的规矩。 */
const FORCE = process.argv.includes('--force');

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 读配置：模板 id + 字段映射 + 跳转页。**换模板只改配置，不改代码** */
async function loadCfg() {
  const [rows] = await pool.query("SELECT payload FROM app_configs WHERE cfg_key = 'global'");
  const cfg = (rows[0] && rows[0].payload) || {};
  const d = (cfg.push && cfg.push.daily) || {};
  return {
    tmplId: String(d.tmplId || '').trim(),
    fields: d.fields || {},
    page: d.page || 'pages/advisor/advisor'
  };
}

(async () => {
  const cfg = await loadCfg();
  if (!cfg.tmplId) {
    // 代码可以先上线、模板后补 —— 没配就当"这个功能还没开"，静默退出
    console.log('[push] 还没配订阅消息模板（app_configs 的 push.daily.tmplId），跳过');
    process.exit(0);
  }
  if (!Object.keys(cfg.fields).length) {
    console.log('[push] 配了模板 id 但没有字段映射（push.daily.fields），跳过 —— 硬发会报 47003');
    process.exit(0);
  }

  await push.ensureTable();
  const users = await push.withQuota(cfg.tmplId);
  console.log('[push] 有额度的用户: ' + users.length + (DRY ? '（试运行，不发）' : ''));

  const today = nowStr().slice(0, 10);
  let sent = 0, skipped = 0, failed = 0;

  for (const u of users) {
    // ② 今天已经发过就跳过（cron 被触发两次也不会重复打扰）
    const [done] = await pool.query(
      "SELECT id FROM push_quota WHERE user_id = ? AND tmpl_id = ? AND sent_at IS NOT NULL AND DATE(sent_at) = ?",
      [u.user_id, cfg.tmplId, today]
    );
    if (done.length) { skipped++; continue; }

    let r;
    try {
      r = await skills.run('nudge_daily', u.user_id, {}, {});
    } catch (err) {
      console.error('[push] 用户 ' + u.user_id + ' 算早报失败:', err.message);
      failed++;
      continue;
    }
    if (!r.ok || r.usable === false) { failed++; continue; }

    // 决策模型说没事 → 一条都不发。这是本功能最重要的一个分支
    // （--force 时跳过，只用于测链路）
    const nudge = (r.data && r.data.nudge) || {};
    if (!FORCE && (nudge.source !== 'jev' || !nudge.push)) { skipped++; continue; }

    /* 四个槽分别填什么 —— 字段名是从微信接口返回的 content 里取的（`{{thing2.DATA}}`），
       **不是照截图猜的**：填错一个就是 47003 整体失败，而且报错看不出是哪个字段。

       ⚠️ thing1 的标签虽然写「时间」，但它其实是**自由文本**
       （微信给的示例是「12月16日（周三）日报」）—— 所以这里放
       **"今天为什么提醒你"**。否则推送就只剩干巴巴的数字，
       老板看不出这条消息跟他有什么关系。超 20 字由 push.clip 按规则截断。 */
    const yst = r.data.yst || {};
    const cur = r.data.cur || {};
    const net = Math.round((cur.income - cur.expense) * 100) / 100;
    const n = r.data.nudge || {};
    let head = '今日经营提醒';
    if (n.what === 'overdue' && r.data.ages && r.data.ages.length) {
      head = r.data.ages[0].name + '欠款挂了' + r.data.ages[0].oldestDays + '天';
    } else if (n.what === 'cost') {
      head = '本月支出比上月高';
    } else if (n.what === 'gap') {
      head = '近几天没记账';
    }
    // --force 时 nudge 可能判定"没事"，但消息照发 —— 必须**自己标明是测试**，
    // 否则老板收到一条「今日经营提醒：今天没有需要特别提醒的事」会一头雾水
    if (FORCE && !n.push) head = '链路测试 · 经营提醒';

    const values = {
      head,                                                     // → thing1 时间（自由文本）
      yIncome: '¥' + Number(yst.income || 0).toFixed(2) + '（' + (yst.inCnt || 0) + '笔）',  // → thing2 昨日收入
      monthStat: '本月结余 ¥' + net.toFixed(2),                  // → thing3 本月统计
      lastAt: r.data.lastAt || r.data.today                      // → time5 记账时间
    };
    const data = push.buildData(cfg.fields, values);

    if (DRY) {
      console.log('  → 会给用户 ' + u.user_id + ' 发：' + JSON.stringify(data));
      sent++;
      continue;
    }

    // 站内信先写：这是兜底通道，订阅消息发不出去时老板还能在小程序里看到
    // （站内信里放**完整那句话**，推送里因为模板槽位有限只能放数字）
    await notif.send(u.user_id, 'daily', values.head, r.text, { page: cfg.page });

    const res = await push.sendOne(u.openid, cfg.tmplId, data, cfg.page);
    if (res.ok) {
      // ③ 成功才扣额度
      await pool.query(
        'UPDATE push_quota SET remain = GREATEST(remain - 1, 0), sent_at = NOW() WHERE user_id = ? AND tmpl_id = ?',
        [u.user_id, cfg.tmplId]
      );
      sent++;
      console.log('  ✓ 已推给用户 ' + u.user_id + '：' + values.head);
    } else {
      failed++;
      console.log('  ✗ 用户 ' + u.user_id + ' 下发失败 errcode=' + res.errcode + ' ' + res.errmsg +
        (res.errcode === 43101 ? '（用户已撤授权/额度用尽，额度未扣）' : ''));
    }
  }

  console.log('[push] 完成：发出 ' + sent + '，跳过 ' + skipped + '，失败 ' + failed);
  process.exit(0);
})().catch((err) => {
  console.error('[push] 任务异常:', err.message);
  process.exit(1);
});
