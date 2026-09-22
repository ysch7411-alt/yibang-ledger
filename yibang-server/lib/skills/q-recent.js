/**
 * 能力：最近记了哪些账（最近 N 笔明细）
 *
 * 「我昨天记了什么」「最近这几笔都是啥」—— 老板核对、回看时的高频问题。
 *
 * ⚠️ 排序必须**末尾补 id DESC**（项目铁律）：record_date 只到天、created_at 只到秒，
 *    同一天/同一秒并列时 MySQL 不保证顺序，表现就是"刚记的那笔没排最前"，
 *    老板会以为没记上。这也是分页正确的前提。
 */
const pool = require('../../db/config');
const { round2 } = require('../ledger');

const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };

/** 收入侧 / 支出侧 —— 只用来决定显示时给不给负号，不参与任何金额计算 */
const IN_TYPES = [1, 5];

module.exports = {
  name: 'q_recent',
  when: '老板问最近记了哪些账、昨天/今天记了什么、最近几笔明细。问"总共/汇总"时不要用它。',
  params: {
    limit: { type: 'number', desc: '要几笔，默认 10，最多 30' }
  },
  risk: 'read',

  async run(userId, p) {
    const n = Math.min(Math.max(Number(p.limit) || 10, 1), 30);
    const [rows] = await pool.query(
      // ⚠️ DATE_FORMAT 必须加（同 q-contact）：DATE 列会变成 JS Date 对象，
      // 直接 String(...).slice(0,10) 得到的是 "Sat Sep 19" 而不是 2026-09-19
      "SELECT DATE_FORMAT(t.record_date, '%Y-%m-%d') AS record_date, t.type, t.amount, t.content, " +
      'c.name AS contact_name ' +
      'FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id ' +
      'WHERE t.user_id = ? AND t.status = 1 ' +
      'ORDER BY t.record_date DESC, t.id DESC LIMIT ?',
      [userId, n]
    );
    const list = rows.map((r) => ({
      date: String(r.record_date),
      type: Number(r.type),
      typeText: TYPE_TEXT[Number(r.type)] || '支出',
      amount: round2(r.amount),
      content: r.content || '',
      contact: r.contact_name || ''
    }));
    return { list, asked: n };
  },

  summarize(r) {
    if (!r.list.length) return '账本里还没有任何记录。';
    const lines = r.list.map((x) => {
      const sign = IN_TYPES.includes(x.type) ? '+' : '-';
      return x.date + ' ' + x.typeText + ' ' + sign + '¥' + x.amount.toFixed(2) +
        (x.contact ? '（' + x.contact + '）' : '') + (x.content ? ' ' + x.content : '');
    });
    return '最近 ' + r.list.length + ' 笔：\n' + lines.join('\n');
  }
};
