// 清理本轮分页测试数据，并核对账本基线
require('dotenv').config();
const pool = require('./db/config');

(async () => {
  const [d] = await pool.query("DELETE FROM transactions WHERE user_id = 1 AND content LIKE 'ZZTEST%'");
  console.log('已删测试流水 ' + d.affectedRows + ' 行');

  const [s] = await pool.query(
    'SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) inc, ' +
    'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) exp FROM transactions WHERE user_id = 1'
  );
  console.log('账本基线：' + s[0].n + ' 条，收入 ¥' + s[0].inc + '，支出 ¥' + s[0].exp + '（应为 7 / 7500.00 / 45.14）');

  const [c] = await pool.query('SELECT COUNT(*) n FROM contacts WHERE user_id = 1');
  console.log('往来对象 ' + c[0].n + ' 个（应为 4）');

  const [sh] = await pool.query('SELECT COUNT(*) n FROM shares');
  console.log('分享记录 ' + sh[0].n + ' 条（应为 0）');

  const [rest] = await pool.query("SELECT COUNT(*) n FROM transactions WHERE content LIKE 'ZZTEST%'");
  console.log('残留测试数据 ' + rest[0].n + ' 条（应为 0）');
  process.exit(0);
})();
