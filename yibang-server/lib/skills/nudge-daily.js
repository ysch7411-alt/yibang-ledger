/**
 * 能力：每日经营早报 —— 打开参谋页就主动说一件事，不等老板问
 *
 * 这是从"你问我答"变成"我主动说"的第一块。价值在于：**老板想不到要问的东西**。
 *
 * 三层各司其职：
 *   ① 这里用 SQL 把**聚合数字**算出来（不许模型算）；
 *   ② 交给 Jev 判断「今天有没有值得打扰老板的事 / 是哪一件 / 多急」
 *      —— state 里**只有数字，没有客户姓名**（出境红线）；
 *   ③ 判断结论 + 带姓名的明细一起交给**国内**大模型，让它说成一句人话
 *      （姓名只在国内这一段出现，不出境）。
 *
 * ⚠️ 基准很关键：判断"挂了 47 天算不算久"必须有该店自己的回款周期作参照。
 *    实测过 —— 不给基准 Jev 的置信度 0.81，给了之后 0.97。
 *    给不出基准时（样本不足）就说给不出来，**不要编一个"一般 30 天"**。
 */
const pool = require('../../db/config');
const { round2 } = require('../ledger');
const { receivableAges, avgCollectionDays, recordPace } = require('./_shared');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function ymShift(ym, n) {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1 + n, 1);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1);
}
async function monthSum(userId, ym) {
  const [rows] = await pool.query(
    'SELECT COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) AS income, ' +
    'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) AS expense, COUNT(*) AS cnt ' +
    "FROM transactions WHERE user_id = ? AND status = 1 AND DATE_FORMAT(record_date,'%Y-%m') = ?",
    [userId, ym]
  );
  const r = rows[0] || {};
  return { income: round2(r.income), expense: round2(r.expense), cnt: Number(r.cnt) || 0 };
}

/** 昨日收入与笔数 —— 订阅消息「记账提醒」模板里有一个「昨日收入」槽，正好要这个 */
async function yesterdaySum(userId, today) {
  const [rows] = await pool.query(
    'SELECT COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) AS income, ' +
    'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) AS expense, ' +
    // ⚠️ 笔数只算**收入侧**：这个槽的标签是"昨日收入"，
    //    把当天所有笔数（含支出）放进来会变成「¥0.00（1笔）」这种自相矛盾的读数
    'SUM(CASE WHEN type IN (1,5) THEN 1 ELSE 0 END) AS in_cnt, ' +
    'COUNT(*) AS cnt ' +
    'FROM transactions WHERE user_id = ? AND status = 1 AND record_date = DATE_SUB(?, INTERVAL 1 DAY)',
    [userId, today]
  );
  const r = rows[0] || {};
  return {
    income: round2(r.income), expense: round2(r.expense),
    inCnt: Number(r.in_cnt) || 0, cnt: Number(r.cnt) || 0
  };
}

/**
 * 最近一笔记账的日期（推送里当"记账时间"用）。
 *
 * 🔴 **必须用 DATE_FORMAT 让 MySQL 输出字符串**。
 * 直接用 MAX(record_date)：连接池没设 `dateStrings`，mysql2 会把 DATE 转成 **JS Date 对象**，
 * 而 `String(date).slice(0,10)` 得到的是 `"Mon Sep 21"` —— 不是 `2026-09-21`。
 * 微信的 time 类型字段只认 `yyyy-MM-dd HH:mm`，塞进去就是 **47003 整体失败**。
 * （这个"DATE 变成 Date 对象"的坑项目里栽过好几次，contact-detail 的日期乱码是同一个根因。）
 */
async function lastRecordDay(userId) {
  const [rows] = await pool.query(
    "SELECT DATE_FORMAT(MAX(record_date), '%Y-%m-%d') AS d FROM transactions WHERE user_id = ? AND status = 1",
    [userId]
  );
  return rows[0] && rows[0].d ? String(rows[0].d) : '';
}

module.exports = {
  name: 'nudge_daily',
  when: '老板问今天有什么要注意的、有没有什么异常、最近怎么样。' +
    '也用于打开参谋页时主动给一份经营早报。',
  params: {},
  risk: 'read',

  async run(userId) {
    const today = todayStr();
    const ym = today.slice(0, 7);
    const [cur, prev, ages, pace, cov, yst, lastAt] = await Promise.all([
      monthSum(userId, ym),
      monthSum(userId, ymShift(ym, -1)),
      receivableAges(userId, today),
      recordPace(userId, today),
      avgCollectionDays(userId),
      // 下面两个是给**订阅消息模板**用的（「记账提醒」有"昨日收入"和"记账时间"两个槽）——
      // 一次查出来，省得推送那边再查一遍
      yesterdaySum(userId, today),
      lastRecordDay(userId)
    ]);

    const debtTotal = round2(ages.reduce((s, x) => s + x.openAmount, 0));
    const maxDays = ages.length ? ages[0].oldestDays : 0;

    // ① 给 Jev 的 state：**只有聚合数字，没有姓名**
    const state =
      '本月收入 ' + cur.income + ' 元，支出 ' + cur.expense + ' 元，结余 ' + round2(cur.income - cur.expense) + ' 元；' +
      '上月收入 ' + prev.income + ' 元，支出 ' + prev.expense + ' 元；' +
      '未收欠款 ' + ages.length + ' 笔共 ' + debtTotal + ' 元，最长一笔挂了 ' + maxDays + ' 天；' +
      (cov ? '这家店平时的回款周期约 ' + cov.days + ' 天；' : '（这家店还没有足够的回款记录，估不出平时的回款周期）；') +
      '近 7 天记了 ' + pace.last7 + ' 笔，平时每天约 ' + pace.perDay + ' 笔。';

    // ② 让决策模型判断要不要说、说哪件、多急
    //    ⚠️ 这里**惰性 require**：lib/decide 会 require 整个能力注册表来拿技能清单，
    //    而能力注册表又 require 本文件 —— 顶层 require 会成环。
    //    在函数里 require 就绕开了（两者都已加载完）。
    const decide = require('../decide');
    const nudge = await decide.shouldNudge(state);

    return { nudge, state, cur, prev, ages, pace, cov, debtTotal, maxDays, yst, lastAt, today };
  },

  summarize(r) {
    const n = r.nudge || {};
    // 决策模型不可用时的保守兜底：只用确定性规则说一句，**不猜**
    if (n.source !== 'jev') {
      if (r.ages.length && r.maxDays >= 30) {
        return '有一笔欠款挂了 ' + r.maxDays + ' 天了（' + r.ages[0].name + ' ¥' + r.ages[0].openAmount.toFixed(2) + '），值得问一句。';
      }
      return '今天没有需要特别提醒的事。';
    }
    if (!n.push) return '今天没有需要特别提醒的事。';

    if (n.what === 'overdue' && r.ages.length) {
      const a = r.ages[0];
      return '最该看一件事：' + a.name + ' 那笔 ¥' + a.openAmount.toFixed(2) +
        ' 已经挂了 ' + a.oldestDays + ' 天' +
        (r.cov ? '（这家店平时回款约 ' + r.cov.days + ' 天）' : '') +
        '。共有 ' + r.ages.length + ' 笔欠款没收回，合计 ¥' + r.debtTotal.toFixed(2) + '。';
    }
    if (n.what === 'cost') {
      const diff = round2(r.cur.expense - r.prev.expense);
      return '最该看一件事：本月支出 ¥' + r.cur.expense.toFixed(2) +
        (r.prev.cnt === 0 ? '（上月没有记录，没有可比性）'
          : '，比上月' + (diff >= 0 ? '多' : '少') + ' ¥' + Math.abs(diff).toFixed(2)) + '。';
    }
    if (n.what === 'gap') {
      return '最该看一件事：近 7 天只记了 ' + r.pace.last7 + ' 笔，平时每天约 ' + r.pace.perDay +
        ' 笔 —— 是不是落下了几笔没记？语音补一下很快。';
    }
    return '今天没有需要特别提醒的事。';
  }
};
