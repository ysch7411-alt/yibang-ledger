/**
 * 能力：某个月「钱花在哪」—— 按品类汇总支出，从高到低
 *
 * 这是老板做成本控制时最想知道的：「这个月哪项支出最大」。
 * 报表页有同款卡片，但那里只能看当月，而 AI 这里可以问任意月份、还能接着追问。
 *
 * 只统计**支出侧**（2 支出 / 6 付款）—— 收入按品类汇总没有经营意义，
 * 老板问「钱花在哪」时想的一定是花出去的钱。
 */
const pool = require('../../db/config');
const { isMonth, round2 } = require('../ledger');

module.exports = {
  name: 'q_category',
  when: '老板问某个月钱花在哪、哪项支出最大、某项开销多少（按品类/项目看支出结构）。',
  params: {
    month: { type: 'string', desc: '要查的月份，格式 YYYY-MM；不填就是本月' }
  },
  risk: 'read',

  async run(userId, p) {
    const now = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    const thisMonth = now.getFullYear() + '-' + p2(now.getMonth() + 1);
    const ym = isMonth(p.month) ? p.month : thisMonth;

    const [rows] = await pool.query(
      'SELECT category, SUM(amount) AS amt, COUNT(*) AS cnt ' +
      'FROM transactions ' +
      'WHERE user_id = ? AND status = 1 AND type IN (2,6) ' +
      "AND DATE_FORMAT(record_date, '%Y-%m') = ? " +
      'GROUP BY category ORDER BY amt DESC LIMIT 8',
      [userId, ym]
    );

    const list = rows.map((r) => ({
      // 品类没填的归到「未分类」—— 直接显示 null 老板看不懂
      name: (r.category && String(r.category).trim()) || '未分类',
      amount: round2(r.amt),
      cnt: Number(r.cnt) || 0
    }));
    const total = round2(list.reduce((s, x) => s + x.amount, 0));
    return { ym, isThisMonth: ym === thisMonth, list, total };
  },

  summarize(r) {
    const label = r.isThisMonth ? '本月' : r.ym;
    if (!r.list.length) return label + '还没有支出记录。';
    const top = r.list[0];
    const share = r.total > 0 ? Math.round((top.amount / r.total) * 100) : 0;
    const rest = r.list.slice(1, 4)
      .map((x) => x.name + ' ¥' + x.amount.toFixed(2)).join('、');
    return label + '支出共 ¥' + r.total.toFixed(2) + '，最大一项是「' + top.name +
      '」¥' + top.amount.toFixed(2) + '，占 ' + share + '%' +
      (rest ? '；其次是 ' + rest : '') + '。';
  }
};
