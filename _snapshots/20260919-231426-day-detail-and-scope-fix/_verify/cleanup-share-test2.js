// 还原测试改动的用户资料，并清理测试分享记录
require('dotenv').config();
const pool = require('./db/config');

(async () => {
  await pool.query('UPDATE users SET shop_name = NULL, nickname = NULL WHERE id = 1');
  const [u] = await pool.query('SELECT shop_name, nickname FROM users WHERE id = 1');
  console.log('用户资料已还原：shop_name=' + JSON.stringify(u[0].shop_name) + ' nickname=' + JSON.stringify(u[0].nickname));

  const [d] = await pool.query('DELETE FROM shares WHERE user_id = 1');
  console.log('已删测试分享 ' + d.affectedRows + ' 条');

  const [chk] = await pool.query(
    'SELECT (SELECT COUNT(*) FROM shares) sh, (SELECT COUNT(*) FROM transactions WHERE user_id=1) tx, ' +
    '(SELECT COUNT(*) FROM contacts WHERE user_id=1) ct, ' +
    "(SELECT COUNT(*) FROM contacts WHERE name LIKE '%ZZTEST%') bad"
  );
  console.log('最终：分享 ' + chk[0].sh + ' / 流水 ' + chk[0].tx + ' / 往来 ' + chk[0].ct + ' / 测试残留 ' + chk[0].bad);
  process.exit(0);
})();
