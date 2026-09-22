/**
 * 能力：查某个往来对象（客户/供应商）的欠款与往来
 *
 * 「谁欠我最多」「老王总共给了我多少」「张老板还欠多少」—— 这类问题的答案
 * 现在只存在于往来详情页里，老板得一层层点进去翻；问 AI 是最自然的入口。
 *
 * 口径与 lib/ledger.js 的 recalcBalance 完全一致：
 *   余额 = 应收(3) − 回款(5) − 应付(4) + 付款(6)
 *   正数 = 对方欠我；负数 = 我欠对方
 * 这里的数字**一律由 SQL 现算**，不读 contacts.balance 缓存 ——
 * 万一哪次写入没同步缓存，读缓存就会给出一个和明细对不上的数，
 * 而"对不上账"是老板最不能容忍的事。
 */
const pool = require('../../db/config');
const { round2 } = require('../ledger');

const BALANCE_SQL =
  'COALESCE(SUM(CASE WHEN type = 3 THEN amount ELSE 0 END),0) ' +
  '- COALESCE(SUM(CASE WHEN type = 5 THEN amount ELSE 0 END),0) ' +
  '- COALESCE(SUM(CASE WHEN type = 4 THEN amount ELSE 0 END),0) ' +
  '+ COALESCE(SUM(CASE WHEN type = 6 THEN amount ELSE 0 END),0)';

module.exports = {
  name: 'q_contact',
  when: '老板问某个客户或供应商的欠款、往来、总共收付了多少、还欠多少。' +
    '必须先能指出具体对象（人名/公司名）才用它。',
  params: {
    name: { type: 'string', desc: '客户或供应商的名字，可以只给一部分（会模糊匹配）' }
  },
  risk: 'read',

  async run(userId, p) {
    const kw = String(p.name || '').trim();
    if (!kw) return { found: false, reason: '没给出要查的对象名字' };

    // 模糊匹配；同名多个人时不猜，把候选交回去让上层追问
    const [cands] = await pool.query(
      'SELECT id, name, type FROM contacts WHERE user_id = ? AND name LIKE ? ORDER BY id DESC LIMIT 6',
      [userId, '%' + kw + '%']
    );
    if (!cands.length) return { found: false, reason: 'no_contact', kw };
    if (cands.length > 1) return { found: false, reason: 'ambiguous', kw, candidates: cands.map((c) => c.name) };

    const c = cands[0];
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS cnt, ' +
      'COALESCE(SUM(CASE WHEN type = 3 THEN amount ELSE 0 END),0) AS recv, ' +
      'COALESCE(SUM(CASE WHEN type = 5 THEN amount ELSE 0 END),0) AS back, ' +
      'COALESCE(SUM(CASE WHEN type = 4 THEN amount ELSE 0 END),0) AS owe, ' +
      'COALESCE(SUM(CASE WHEN type = 6 THEN amount ELSE 0 END),0) AS paid, ' +
      BALANCE_SQL + ' AS balance, ' +
      // ⚠️ DATE_FORMAT 必须加：不然 mysql2 返回 JS Date 对象，
      // String(...).slice(0,10) 会得到 "Sat Sep 19" 这种串（不是 2026-09-19）
      "DATE_FORMAT(MAX(record_date), '%Y-%m-%d') AS last_date " +
      'FROM transactions WHERE user_id = ? AND contact_id = ? AND status = 1',
      [userId, c.id]
    );
    const r = rows[0] || {};
    return {
      found: true,
      name: c.name,
      cnt: Number(r.cnt) || 0,
      balance: round2(r.balance),
      recv: round2(r.recv), back: round2(r.back),
      owe: round2(r.owe), paid: round2(r.paid),
      lastDate: r.last_date ? String(r.last_date) : ''
    };
  },

  /**
   * 这次的数据够不够回答？
   *  · found       → 够
   *  · ambiguous   → 够（"有多个同名对象，你要问哪个"本身就是一个有用的回答）
   *  · 没听出是谁  → **不够**，调用方要退回老路。
   *    因为「谁欠我最多」这类问法问的是排行、该命中 q_debt；
   *    如果在这里答一句"没听出要查谁"，等于把一个本来能答的问题答丢了。
   */
  usable(raw) {
    return !!raw.found || raw.reason === 'ambiguous';
  },

  summarize(r) {
    if (!r.found) {
      if (r.reason === 'no_contact') return '账本里没有名字带「' + r.kw + '」的往来对象，请老板确认一下名字。';
      if (r.reason === 'ambiguous') {
        return '有多个对象名字里带「' + r.kw + '」：' + r.candidates.join('、') + '。要问哪一个？';
      }
      return '没听出要查谁，请老板说一个名字。';
    }
    if (r.cnt === 0) return r.name + '还没有任何往来记录。';

    // 方向由代码定死：正数=对方欠我，负数=我欠对方。绝不让下游自己判断正负含义
    const dir = r.balance > 0
      ? '对方还欠我 ¥' + r.balance.toFixed(2)
      : (r.balance < 0 ? '我还欠对方 ¥' + Math.abs(r.balance).toFixed(2) : '两边已经结清');
    return r.name + '：' + dir + '。' +
      '累计应收 ¥' + r.recv.toFixed(2) + '，已回款 ¥' + r.back.toFixed(2) + '；' +
      '累计应付 ¥' + r.owe.toFixed(2) + '，已付款 ¥' + r.paid.toFixed(2) + '；' +
      '共 ' + r.cnt + ' 笔往来，最近一笔在 ' + r.lastDate + '。';
  }
};
