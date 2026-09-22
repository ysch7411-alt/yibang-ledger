/**
 * _verify/cleanup-test-records.js —— 清理本轮录入验证产生的记录
 *
 * 纪律（项目里栽过）：
 *   · 只对 user_id = 1（开发者工具测试账号）动手
 *   · **先列出来给我看，再删**；不用"收/付开头"这种宽正则（曾因此多删 13 条）
 *   · 判据：created_at 在本次验证的时间窗内（2026-09-22 20:1x 之后）
 *
 * 用法： node __cleanup-test.js          # 只列，不删
 *        node __cleanup-test.js --go     # 真删
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const pool = require('/www/wwwroot/yibang-server/db/config');

const UID = 1;
const SINCE = '2026-09-22 20:15:00';   // 本次验证开始的时间
const GO = process.argv.includes('--go');

(async () => {
  const [rows] = await pool.query(
    'SELECT id, amount, content, category, created_at FROM transactions ' +
    'WHERE user_id = ? AND created_at >= ? ORDER BY id',
    [UID, SINCE]
  );

  console.log('user ' + UID + ' 在 ' + SINCE + ' 之后创建的记录（' + rows.length + ' 条）：');
  rows.forEach((r) => console.log('  #' + r.id, '¥' + r.amount, JSON.stringify(r.content), '品类=' + JSON.stringify(r.category), r.created_at));

  // 安全检查：确认没碰到别的用户
  const [others] = await pool.query(
    'SELECT COUNT(*) n FROM transactions WHERE user_id <> ? AND created_at >= ?',
    [UID, SINCE]
  );
  console.log('\n同期其它用户的记录数: ' + others[0].n + '（应为 0，非 0 就停下别删）');

  if (!GO) {
    console.log('\n（试运行。加 --go 才真删）');
    process.exit(0);
  }
  if (others[0].n > 0) { console.log('⚠️ 检测到其它用户同期有记录，拒绝执行删除'); process.exit(1); }

  const [del] = await pool.query('DELETE FROM transactions WHERE user_id = ? AND created_at >= ?', [UID, SINCE]);
  console.log('已删除 ' + del.affectedRows + ' 条');
  // 顺手清掉验证时沉淀进词表的品类
  const [t] = await pool.query("DELETE FROM merchant_terms WHERE user_id = ? AND kind = 'category'", [UID]);
  console.log('清掉 kind=category 词表 ' + t.affectedRows + ' 条');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
