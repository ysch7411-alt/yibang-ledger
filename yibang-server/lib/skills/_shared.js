/**
 * skills 层内部共享的账目计算
 *
 * 放在这里而不是 lib/ledger.js：这些是**能力层专用**的派生量，
 * ledger.js 管的是"账目语义的底线"（金额校验、余额口径），不该被业务派生物撑大。
 * 但同一层内绝不重复实现 —— 账龄现在被「报账」用，接下来的「催款话术」也要用。
 */
const pool = require('../../db/config');
const { round2 } = require('../ledger');

/**
 * 账龄：每个"还欠我钱"的对象，最早那笔**未结清**应收挂了多少天。
 *
 * 为什么必须 FIFO 核销，而不是直接取"最早一笔应收的日期"：
 *   一个客户往往有多笔应收 + 多笔回款。若他已经还过一部分，
 *   用"最早那笔应收"当账龄会**虚高** —— 而这条数字直接决定"要不要催他"。
 *   虚高的后果是让老板去催一个其实刚付过钱的客户，**比不提醒更伤信任**。
 *
 * 规则（标准账龄法）：回款按时间顺序冲抵最早的应收，冲不完的那部分里
 * 最早一笔的日期，才是真正的挂账起点。只算 type 3(应收) / 5(回款)，
 * 与 lib/ledger.js 的 recalcBalance 口径一致（余额 = 3 − 5 − 4 + 6）。
 *
 * @returns {Array<{name, balance, oldestDays, openAmount, openSince}>} 按挂账天数倒序
 */
async function receivableAges(userId, today) {
  // 只需要有欠款的对象：余额 > 0。余额口径与 recalcBalance 一致
  const [cs] = await pool.query(
    'SELECT id, name, balance FROM contacts WHERE user_id = ? AND balance > 0 ORDER BY balance DESC LIMIT 20',
    [userId]
  );
  if (!cs.length) return [];

  const ids = cs.map((c) => c.id);
  const [rows] = await pool.query(
    // ⚠️ 必须 DATE_FORMAT 成字符串：连接池没设 dateStrings，mysql2 会把 DATE 给成 JS Date 对象，
    // 再 String(...).slice(0,10) 就得到 "Sat Sep 19"（而不是 2026-09-19）。
    // 这里后面要用它算"挂了几天"，一旦变成那种串，new Date() 会解析成 2001 年 → 天数差上万。
    "SELECT contact_id, type, amount, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date " +
    'FROM transactions ' +
    'WHERE user_id = ? AND status = 1 AND contact_id IN (?) AND type IN (3,5) ' +
    'ORDER BY contact_id, record_date, id',
    [userId, ids]
  );

  const byContact = {};
  for (const r of rows) {
    const k = String(r.contact_id);
    (byContact[k] = byContact[k] || []).push({
      isReceivable: Number(r.type) === 3,
      amount: Number(r.amount) || 0,
      date: String(r.record_date)          // 已经是 'YYYY-MM-DD'（见上面 SQL 的 DATE_FORMAT）
    });
  }

  const dayMs = 86400000;
  const t0 = new Date(today + 'T00:00:00').getTime();
  const daysAgo = (d) => Math.max(0, Math.round((t0 - new Date(d + 'T00:00:00').getTime()) / dayMs));

  const out = [];
  for (const c of cs) {
    const list = byContact[String(c.id)] || [];
    // FIFO：应收排队等着被回款冲抵
    const q = [];
    let paidPool = 0;
    for (const m of list) {
      if (m.isReceivable) {
        // 先拿手头的回款冲掉这笔
        let amt = m.amount;
        if (paidPool > 0) {
          const use = Math.min(paidPool, amt);
          paidPool = round2(paidPool - use);
          amt = round2(amt - use);
        }
        if (amt > 0.005) q.push({ amount: amt, date: m.date });
      } else {
        // 回款：冲最早的那些应收
        let left = m.amount;
        while (left > 0.005 && q.length) {
          const head = q[0];
          const use = Math.min(left, head.amount);
          head.amount = round2(head.amount - use);
          left = round2(left - use);
          if (head.amount <= 0.005) q.shift();
        }
        if (left > 0.005) paidPool = round2(paidPool + left);   // 多付的挂账，留给后面的应收
      }
    }
    const open = q.reduce((s, x) => s + x.amount, 0);
    if (!q.length) continue;                 // 其实已经结清（余额缓存和明细不符时以明细为准）
    out.push({
      name: c.name,
      balance: round2(open),
      openAmount: round2(open),
      openSince: q[0].date,                  // 最早那笔未结清的应收
      oldestDays: daysAgo(q[0].date)
    });
  }
  return out.sort((a, b) => b.oldestDays - a.oldestDays);
}

/**
 * 这家店自己的一个基准：回款周期大约多久。
 * 用"已收回的那些欠款，从最早那笔应收到收回花了多久"来估。
 * 样本不足（没有已收回记录）时返回 null —— **基准给不出来就说给不出来，不要编**。
 */
async function avgCollectionDays(userId) {
  const [rows] = await pool.query(
    // 同上：DATE 必须格式化成字符串再交给 new Date()，否则会算成 2001 年
    "SELECT contact_id, type, amount, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date " +
    'FROM transactions ' +
    'WHERE user_id = ? AND status = 1 AND contact_id IS NOT NULL AND type IN (3,5) ' +
    'ORDER BY contact_id, record_date, id',
    [userId]
  );
  const byContact = {};
  for (const r of rows) {
    const k = String(r.contact_id);
    (byContact[k] = byContact[k] || []).push({
      isReceivable: Number(r.type) === 3,
      amount: Number(r.amount) || 0,
      date: String(r.record_date)
    });
  }

  const dayMs = 86400000;
  const spans = [];
  for (const k of Object.keys(byContact)) {
    const q = [];
    for (const m of byContact[k]) {
      if (m.isReceivable) q.push({ amount: m.amount, date: m.date });
      else {
        let left = m.amount;
        while (left > 0.005 && q.length) {
          const head = q[0];
          const use = Math.min(left, head.amount);
          const span = (new Date(m.date).getTime() - new Date(head.date).getTime()) / dayMs;
          if (span >= 0) spans.push(span);
          head.amount = round2(head.amount - use);
          left = round2(left - use);
          if (head.amount <= 0.005) q.shift();
        }
      }
    }
  }
  if (spans.length < 2) return null;    // 少于 2 次完整回款，估不出周期
  return { days: Math.round(spans.reduce((s, x) => s + x, 0) / spans.length), samples: spans.length };
}

/** 近 N 天记了多少笔 + 平时日均（用来判断"是不是断了好几天没记"） */
async function recordPace(userId, today) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS recent FROM transactions ' +
    'WHERE user_id = ? AND status = 1 AND record_date >= DATE_SUB(?, INTERVAL 7 DAY)',
    [userId, today]
  );
  const [all] = await pool.query(
    // 同上：MIN(record_date) 也是 DATE，不格式化成字符串的话下面 span 会算成上万天
    "SELECT COUNT(*) AS total, DATE_FORMAT(MIN(record_date), '%Y-%m-%d') AS first_day " +
    'FROM transactions WHERE user_id = ? AND status = 1',
    [userId]
  );
  const total = Number((all[0] || {}).total) || 0;
  const firstDay = (all[0] || {}).first_day;
  let perDay = 0;
  if (firstDay) {
    const span = Math.max(1, Math.round((new Date(today).getTime() - new Date(String(firstDay)).getTime()) / 86400000) + 1);
    perDay = round2(total / span);
  }
  return { last7: Number((rows[0] || {}).recent) || 0, total, perDay };
}

module.exports = { receivableAges, avgCollectionDays, recordPace };
