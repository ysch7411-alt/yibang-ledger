/**
 * _verify/check-last-records.js —— 查刚才通过小程序录入的两笔，品类有没有落库
 * 用法： cd /www/wwwroot/yibang-server && node __check-last.js
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const pool = require('/www/wwwroot/yibang-server/db/config');

(async () => {
  const [rows] = await pool.query(
    "SELECT id, type, amount, content, category, pay_method, record_date, created_at FROM transactions WHERE user_id = 1 ORDER BY id DESC LIMIT 4"
  );
  console.log('user 1 最近 4 笔：');
  rows.forEach((r) => {
    console.log(
      '  #' + r.id,
      '| type=' + r.type,
      '| ¥' + r.amount,
      '| 事由=' + JSON.stringify(r.content),
      '| 品类=' + JSON.stringify(r.category),
      '| 方式=' + JSON.stringify(r.pay_method),
      '| ' + r.record_date
    );
  });
  const withCat = rows.filter((r) => r.category).length;
  console.log('\n带品类的笔数: ' + withCat + ' / ' + rows.length);
  console.log(withCat > 0 ? '✅ 品类真的落库了 —— 说明 解析→映射→入库 三段都通了' : '❌ 品类没落库，链路某一段还在丢字段');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
