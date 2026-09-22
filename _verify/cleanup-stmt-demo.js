/**
 * __cleanup-stmt-demo.js —— 精确清理本轮「对账演示」数据
 * 只动 user_id = 1 且名字带标记的联系人，及其关联账目/分享。先列后删。
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const pool = require('/www/wwwroot/yibang-server/db/config');
const UID = 1;
const MARK = '对账演示·';
const GO = process.argv.includes('--go');

(async () => {
  const [cs] = await pool.query('SELECT id, name FROM contacts WHERE user_id = ? AND name LIKE ?', [UID, MARK + '%']);
  const ids = cs.map((x) => x.id);
  console.log('待清理联系人:', JSON.stringify(cs));

  let txN = 0, shN = 0;
  if (ids.length) {
    const [t] = await pool.query('SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND contact_id IN (?)', [UID, ids]);
    const [s] = await pool.query('SELECT COUNT(*) n FROM shares WHERE user_id = ? AND contact_id IN (?)', [UID, ids]);
    txN = t[0].n; shN = s[0].n;
  }
  console.log('关联账目', txN, '条 / 分享', shN, '条');

  // 安全检查：确认没有别人的数据被卷进来
  const [others] = await pool.query('SELECT COUNT(*) n FROM contacts WHERE user_id <> ? AND name LIKE ?', [UID, MARK + '%']);
  console.log('其它用户的同名联系人:', others[0].n, '（应为 0）');

  if (!GO) { console.log('\n（试运行，加 --go 才真删）'); process.exit(0); }
  if (others[0].n > 0) { console.log('⚠️ 拒绝执行'); process.exit(1); }

  if (ids.length) {
    const [a] = await pool.query('DELETE FROM transactions WHERE user_id = ? AND contact_id IN (?)', [UID, ids]);
    const [b] = await pool.query('DELETE FROM shares WHERE user_id = ? AND contact_id IN (?)', [UID, ids]);
    console.log('已删账目', a.affectedRows, '/ 分享', b.affectedRows);
  }
  const [d] = await pool.query('DELETE FROM contacts WHERE user_id = ? AND name LIKE ?', [UID, MARK + '%']);
  console.log('已删联系人', d.affectedRows);

  const [left] = await pool.query('SELECT COUNT(*) n FROM transactions WHERE content LIKE ?', [MARK + '%']);
  console.log('带标记账目残留:', left[0].n, '（应为 0）');
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
