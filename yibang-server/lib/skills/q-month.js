/**
 * 能力：查某个月的收支汇总（含环比）
 *
 * 这是老板问得最多的一类：「这个月赚了多少」「上个月花了多少」。
 *
 * 🔴 铁律（整个 skills 层都适用）：
 *    run() 里用 SQL 算出来的数字就是**最终数字**，summarize() 交出去的必须是
 *    **已经算好的一句话** —— 下游的大模型只负责把它说圆，**没有机会自己算**。
 *    理由：老板分不清"AI 算错"和"账记错"，一次算错他就连整个账本都不信。
 */
const pool = require('../../db/config');
const { isMonth, round2 } = require('../ledger');

/* 账目语义（与 lib/ledger.js 的 recalcBalance 同一套口径，别在这里另立一套）：
   1 收入 / 2 支出 / 3 应收 / 4 应付 / 5 回款 / 6 付款
   收支 = (1,5) 进 (2,6) 出；**应收应付 (3,4) 是往来账，不计入收支** */
const IN = [1, 5];
const OUT = [2, 6];

/** 往前推 n 个月，返回 YYYY-MM */
function shiftMonth(ym, n) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5));
  const d = new Date(y, m - 1 + n, 1);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1);
}

async function sumOf(userId, ym) {
  const [rows] = await pool.query(
    'SELECT ' +
    'COALESCE(SUM(CASE WHEN type IN (?) THEN amount ELSE 0 END),0) AS income, ' +
    'COALESCE(SUM(CASE WHEN type IN (?) THEN amount ELSE 0 END),0) AS expense, ' +
    'COUNT(*) AS cnt ' +
    'FROM transactions WHERE user_id = ? AND status = 1 ' +
    "AND DATE_FORMAT(record_date, '%Y-%m') = ?",
    [IN, OUT, userId, ym]
  );
  const r = rows[0] || {};
  return { income: round2(r.income), expense: round2(r.expense), cnt: Number(r.cnt) || 0 };
}

module.exports = {
  name: 'q_month',
  when: '老板问某个月的整体收入、支出、结余、赚了多少、花了多少。' +
    '问「这个月」「上个月」「X月」这种整月尺度的问题用它。',
  params: {
    month: { type: 'string', desc: '要查的月份，格式 YYYY-MM；不填就是本月' }
  },
  risk: 'read',

  async run(userId, p) {
    const now = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    const thisMonth = now.getFullYear() + '-' + p2(now.getMonth() + 1);
    const ym = isMonth(p.month) ? p.month : thisMonth;

    const cur = await sumOf(userId, ym);
    const prev = await sumOf(userId, shiftMonth(ym, -1));

    // 环比：上月一条账都没有时说"翻了几倍"是胡说，要单独标出来
    const prevEmpty = prev.cnt === 0;
    const diff = prevEmpty ? null : round2(cur.expense - prev.expense);
    const incomeDiff = prevEmpty ? null : round2(cur.income - prev.income);

    return { ym, isThisMonth: ym === thisMonth, cur, prev, prevEmpty, diff, incomeDiff };
  },

  /** 交给大模型的是这段**已经算好的话**，不是原始行 —— 它没机会自己算 */
  summarize(r) {
    const label = r.isThisMonth ? '本月' : r.ym + ' 这个月';
    // 结余在代码里算死，不让下游再算一次
    const net = round2(r.cur.income - r.cur.expense);
    let s = label + '（' + r.ym + '）收入 ¥' + r.cur.income.toFixed(2) +
      '，支出 ¥' + r.cur.expense.toFixed(2) +
      '，结余 ¥' + net.toFixed(2) +
      '，共 ' + r.cur.cnt + ' 笔账。';

    if (r.cur.cnt === 0) {
      s += '这个月还没记账。';
    }
    if (r.prevEmpty) {
      s += '上月没有任何记录，所以没有环比可比。';
    } else {
      const dir = (n) => (n >= 0 ? '多' : '少');
      s += '上月收入 ¥' + r.prev.income.toFixed(2) + '、支出 ¥' + r.prev.expense.toFixed(2) + '；' +
        '收入比上月' + dir(r.incomeDiff) + ' ¥' + Math.abs(r.incomeDiff).toFixed(2) +
        '，支出比上月' + dir(r.diff) + ' ¥' + Math.abs(r.diff).toFixed(2) + '。';
    }
    return s;
  }
};
