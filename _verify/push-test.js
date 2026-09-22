/**
 * _verify/push-test.js —— 真发一条订阅消息，把微信的返回原样打出来
 *
 * 为什么值得单独测：推送链路上有三个"不说就不知道"的未知项 ——
 *   ① 模板 id 认不认（错了是 40037）
 *   ② 字段名对不对（错了是 47003，而且**不告诉你是哪个字段**）
 *   ③ 用户到底授权了没有（没授权是 43101）
 * 这三个错误码含义完全不同，混在一起就会误判成"功能没做好"。
 * 所以这里把组装好的 data 和微信的原始返回都打出来。
 *
 * ⚠️ 会**临时给一个用户记一次额度**（因为额度表才是下发的门槛），
 *    跑完会把它删掉 —— 不留假额度，否则明天定时任务会多发一条。
 *
 * 用法（服务器上跑）：node __push-test.js [userId]
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const pool = require('/www/wwwroot/yibang-server/db/config');
const push = require('/www/wwwroot/yibang-server/lib/push');
const skills = require('/www/wwwroot/yibang-server/lib/skills');

const UID = Number(process.argv[2] || 1);

(async () => {
  const [rows] = await pool.query("SELECT payload FROM app_configs WHERE cfg_key = 'global'");
  const cfg = ((rows[0] || {}).payload || {});
  const d = (cfg.push && cfg.push.daily) || {};
  if (!d.tmplId) { console.log('✗ 没配模板 id'); process.exit(1); }

  const [u] = await pool.query('SELECT id, openid FROM users WHERE id = ?', [UID]);
  if (!u.length) { console.log('✗ 找不到用户 ' + UID); process.exit(1); }
  console.log('用户 ' + UID + '  openid 尾6位: ...' + String(u[0].openid).slice(-6));

  // 组装一条真实内容（用 skill 算出真数据，不是编的）
  const r = await skills.run('nudge_daily', UID, {}, {});
  if (!r.ok) { console.log('✗ 算早报失败:', r.msg); process.exit(1); }
  const yst = (r.data && r.data.yst) || {};
  const cur = (r.data && r.data.cur) || {};
  const net = Math.round(((cur.income || 0) - (cur.expense || 0)) * 100) / 100;
  const values = {
    head: '链路测试 · 今日经营提醒',
    yIncome: '¥' + Number(yst.income || 0).toFixed(2) + '（' + (yst.cnt || 0) + '笔）',
    monthStat: '本月结余 ¥' + net.toFixed(2),
    lastAt: (r.data && r.data.lastAt) || (r.data && r.data.today)
  };
  const data = push.buildData(d.fields, values);

  console.log('\n组装好的下发内容（字段名 → 值）：');
  Object.keys(data).forEach((k) => {
    console.log('  ' + k + ' = ' + JSON.stringify(data[k].value) +
      '  （' + String(data[k].value).length + ' 字）');
  });

  // 临时记一次额度，让用户进入"有额度"的集合
  await push.grant(UID, d.tmplId, 1);
  console.log('\n已临时记 1 次额度（跑完会删）');

  const res = await push.sendOne(u[0].openid, d.tmplId, data, d.page);
  console.log('\n微信返回：errcode=' + res.errcode + '  errmsg=' + res.errmsg);

  const EXPLAIN = {
    0: '✅ 真的发出去了 —— 微信已受理（用户微信里应该会收到）',
    40037: '❌ 模板 id 不对：这个 id 不属于当前 appid，或模板已被删除',
    47003: '❌ 模板参数不合法：字段名对不上或某个值超了长度（注意它不告诉你是哪个字段）',
    43101: '⚠️ 用户还没订阅/额度已用尽 —— 这是**预期结果**：说明模板和字段都通过了校验，'
      + '只是这个用户还没在手机上点过授权。让他在小程序里点一次「好」，再跑一次就有额度了。',
    40003: '❌ openid 无效',
    45009: '❌ 接口调用频率超限'
  };
  console.log('  → ' + (EXPLAIN[res.errcode] || '（未收录的错误码，按微信文档查）'));

  // 清掉临时额度：留着的话明天定时任务会多发一条
  await pool.query('DELETE FROM push_quota WHERE user_id = ? AND tmpl_id = ?', [UID, d.tmplId]);
  console.log('\n临时额度已清除' + (res.ok ? '（注意：这次是真发出去了，用户微信里会有一条）' : ''));
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
