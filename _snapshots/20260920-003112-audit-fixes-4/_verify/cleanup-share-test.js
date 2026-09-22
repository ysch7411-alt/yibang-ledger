// 清理本轮测试产生的分享记录，并核对账本基线
require('dotenv').config();
const pool = require('./db/config');

(async () => {
  const [before] = await pool.query('SELECT COUNT(*) n FROM shares WHERE user_id = 1');
  console.log('清理前 share 记录：' + before[0].n + ' 条');

  const [d] = await pool.query('DELETE FROM shares WHERE user_id = 1');
  console.log('已删测试分享 ' + d.affectedRows + ' 条');

  const [s] = await pool.query(
    'SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) inc, ' +
    'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) exp FROM transactions WHERE user_id = 1'
  );
  console.log('账本基线：' + s[0].n + ' 条流水，收入 ¥' + s[0].inc + '，支出 ¥' + s[0].exp + '（应为 7 / 7500.00 / 45.14）');

  const [c] = await pool.query('SELECT COUNT(*) n FROM contacts WHERE user_id = 1');
  console.log('往来对象 ' + c[0].n + ' 个（应为 4）');

  const [u] = await pool.query('SELECT shop_name, nickname FROM users WHERE id = 1');
  console.log('店名：shop_name=' + JSON.stringify(u[0].shop_name) + ' nickname=' + JSON.stringify(u[0].nickname) + '（应为空，测试没留下改动）');

  const [rest] = await pool.query('SELECT COUNT(*) n FROM contacts WHERE name LIKE ?', ['%ZZTEST%']);
  console.log('残留测试数据：' + rest[0].n + ' 条（应为 0）');
  process.exit(0);
})();
