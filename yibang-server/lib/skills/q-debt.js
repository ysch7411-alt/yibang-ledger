/**
 * 能力：谁欠我最多 / 我欠谁最多（往来排行）
 *
 * 为什么单独一个能力，而不是塞进 q_contact：
 * 「谁欠我最多」问的是**排行**，不是某个具体对象 —— 走 q_contact 会得到
 * 「没听出要查谁」，把一个本来能答的问题答丢了。**这是最容易被忽略的倒退。**
 * 两个问题形状不同，就该是两个能力。
 *
 * 方向由 params.direction 决定（在 lib/skills/params.js 里从问法抽出来）：
 *   owed = 谁欠我（balance > 0）；owe = 我欠谁（balance < 0）
 * 口径与 lib/ledger.js 的 recalcBalance 一致：正数=对方欠我，负数=我欠对方。
 */
const pool = require('../../db/config');
const { round2 } = require('../ledger');

const TOP = 5;

module.exports = {
  name: 'q_debt',
  when: '老板问谁欠我的钱、谁欠我最多、我欠谁钱、欠款排行。' +
    '问的是"有哪些人/排名"，不是在问某一个具体对象。',
  params: {
    direction: { type: 'string', desc: 'owed=谁欠我（默认）；owe=我欠谁' }
  },
  risk: 'read',

  async run(userId, p) {
    const dir = p.direction === 'owe' ? 'owe' : 'owed';

    const [owed] = await pool.query(
      'SELECT name, balance FROM contacts WHERE user_id = ? AND balance > 0 ' +
      'ORDER BY balance DESC, id DESC LIMIT ?', [userId, TOP]
    );
    const [owe] = await pool.query(
      'SELECT name, balance FROM contacts WHERE user_id = ? AND balance < 0 ' +
      'ORDER BY balance ASC, id DESC LIMIT ?', [userId, TOP]
    );

    const fmt = (rows, abs) => rows.map((r) => ({
      name: r.name,
      amount: round2(abs ? Math.abs(Number(r.balance)) : Number(r.balance))
    }));

    return {
      direction: dir,
      owed: fmt(owed, false),      // 对方欠我，正数直接显示
      owe: fmt(owe, true),         // 我欠对方，显示绝对值
      owedTotal: round2(owed.reduce((s, r) => s + Number(r.balance), 0)),
      oweTotal: round2(owe.reduce((s, r) => s + Math.abs(Number(r.balance)), 0))
    };
  },

  summarize(r) {
    const parts = [];
    if (r.owed.length) {
      parts.push('欠我钱的共 ' + r.owed.length + ' 个，合计 ¥' + r.owedTotal.toFixed(2) + '：' +
        r.owed.map((x) => x.name + ' ¥' + x.amount.toFixed(2)).join('、'));
    } else {
      parts.push('目前没有人欠我钱');
    }
    if (r.owe.length) {
      parts.push('我欠别人的有 ' + r.owe.length + ' 个，合计 ¥' + r.oweTotal.toFixed(2) + '：' +
        r.owe.map((x) => x.name + ' ¥' + x.amount.toFixed(2)).join('、'));
    }
    return parts.join('；') + '。';
  }
};
