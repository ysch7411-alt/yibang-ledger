/**
 * scripts/reconcile-balance.js —— 往来余额对账（自愈 + 异常发现）
 *
 * 为什么需要它：写账的写序是「先 INSERT 明细 → 再 recalcBalance() 重算余额」，
 * **两者不在一个事务里**（全库 beginTransaction 出现 0 次）。
 * 如果第二步失败（网络抖动、进程重启），明细已入库、余额还是旧值 ✗
 *
 * 好在 recalcBalance 是**全量重算**，所以该对象下次任何写入都会把它修正回来 ——
 * 也就是说：**偏差是有界的，但可能长期存在**（一个再也不会被写入的老客户，
 * 它的余额会一直错着，而且没有任何地方会告诉你）。
 *
 * 这个脚本补上那个缺口：每天把全部往来对象的余额重算一遍，对的放过、错的修掉并记账。
 *
 * 用法：
 *   node scripts/reconcile-balance.js            # 只检查（默认，安全）
 *   node scripts/reconcile-balance.js --fix      # 检查并修复
 *
 * 退出码：0 = 全部一致；1 = 发现偏差（便于挂监控告警）
 *
 * ⚠️ 口径**直接照抄 lib/ledger.js 的 recalcBalance**，不另写一套 ——
 *    两套口径就等于没有口径（对账脚本和被对账的代码必须用同一个公式）。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require('../db/config');

const FIX = process.argv.includes('--fix');

/* 与 lib/ledger.js:recalcBalance 完全相同的口径：
   应收(3) − 回款(5) − 应付(4) + 付款(6)，且只看 status = 1 的有效明细 */
const EXPECTED_SQL = `
  SELECT c.id, c.user_id, c.name, c.balance,
         COALESCE(SUM(CASE WHEN t.type = 3 THEN t.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN t.type = 5 THEN t.amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN t.type = 4 THEN t.amount ELSE 0 END), 0)
       + COALESCE(SUM(CASE WHEN t.type = 6 THEN t.amount ELSE 0 END), 0) AS expected
  FROM contacts c
  LEFT JOIN transactions t
         ON t.contact_id = c.id AND t.user_id = c.user_id AND t.status = 1
  GROUP BY c.id
`;

(async () => {
  const [total] = await pool.query('SELECT COUNT(*) AS n FROM contacts');
  const n = Number(total[0].n) || 0;

  // 只取"对不上"的：一条 SQL 查完，不做 N+1（往来对象可能很多）
  // ⚠️ 用 NULL 安全的 `<=>`：balance 为 NULL 时 `<>` 的结果也是 NULL，会漏掉这一类 ✗
  const [bad] = await pool.query(EXPECTED_SQL + ' HAVING NOT (c.balance <=> expected)');

  console.log('[对账] 往来对象 ' + n + ' 个，余额不一致 ' + bad.length + ' 个' + (FIX ? '（--fix 模式）' : '（只检查）'));

  if (!bad.length) {
    console.log('[对账] ✅ 全部一致，无需处理');
    process.exit(0);
  }

  let fixed = 0;
  for (const r of bad) {
    const stored = r.balance === null ? 'NULL' : Number(r.balance).toFixed(2);
    const exp = Number(r.expected).toFixed(2);
    console.log('  ✗ #' + r.id + ' «' + (r.name || '') + '»  库存 ' + stored + ' → 应为 ' + exp +
      '（差 ' + (Number(exp) - Number(stored === 'NULL' ? 0 : stored)).toFixed(2) + '）');
    if (FIX) {
      await pool.query('UPDATE contacts SET balance = ? WHERE id = ? AND user_id = ?',
        [Number(exp), r.id, r.user_id]);
      fixed++;
    }
  }

  if (FIX) {
    console.log('[对账] 已修正 ' + fixed + ' 个');
    // 复验：修完必须再查一次，确认真的对上了（不确认不算修好）
    const [still] = await pool.query(EXPECTED_SQL + ' HAVING NOT (c.balance <=> expected)');
    console.log(still.length
      ? '[对账] ❌ 仍有 ' + still.length + ' 个不一致，请检查'
      : '[对账] ✅ 复验通过，全部一致');
    process.exit(still.length ? 1 : 0);
  }
  console.log('[对账] 加 --fix 可自动修正');
  process.exit(1);
})().catch((e) => {
  console.error('[对账] 异常:', e.message);
  process.exit(2);
});
