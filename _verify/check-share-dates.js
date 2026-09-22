// 复核分享记录的日期口径 + 服务器时区（避免 toISOString 差一天的老坑）
require('dotenv').config();
const pool = require('./db/config');

(async () => {
  console.log('服务器时间：' + new Date().toString());
  console.log('时区偏移（分钟）：' + new Date().getTimezoneOffset());
  console.log('');

  const [rows] = await pool.query(
    "SELECT token, user_id, period, " +
    "DATE_FORMAT(from_date,'%Y-%m-%d') AS f, " +
    "DATE_FORMAT(to_date,'%Y-%m-%d') AS t, " +
    "DATE_FORMAT(created_at,'%Y-%m-%d %H:%i') AS c, is_valid, view_count " +
    'FROM shares ORDER BY id'
  );
  console.log('分享记录 ' + rows.length + ' 条：');
  rows.forEach((x) => {
    console.log('  user_id=' + x.user_id + ' ' + x.period + ' 区间=' + x.f + ' ~ ' + x.t +
      ' 建于 ' + x.c + ' 有效=' + x.is_valid + ' 被看=' + x.view_count + ' 次');
  });

  // 今天按两种口径各取一次，确认服务端算的"今天"是哪一天
  const [d] = await pool.query('SELECT DATE_FORMAT(CURDATE(), "%Y-%m-%d") AS today, NOW() AS nowv');
  console.log('');
  console.log('MySQL 认为的今天：' + d[0].today + '，当前时间：' + d[0].nowv);
  process.exit(0);
})();
