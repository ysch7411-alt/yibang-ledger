/**
 * _verify/seed-demo-category.js —— 造一批带品类的演示数据（在服务器上跑）
 *
 * 用途：截图验证「钱花在哪」卡片的真实渲染 —— 空数据的卡片看不出排版对不对。
 * 项目纪律：**务必造够数据**，否则截断/多行/条形长度这些分支根本没被跑到。
 *
 * ⚠️ 只写 user_id = 1（开发者工具的测试账号），标记 `品类演示·`，用完立刻删。
 *    线上 2 号是老易本人真实账本，绝不能在它上面造数据。
 *
 * 用法： cd /www/wwwroot/yibang-server && node /tmp/seed-demo-category.js
 *       清理： node /tmp/seed-demo-category.js --clean
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const pool = require('/www/wwwroot/yibang-server/db/config');

const MARK = '品类演示·';
const UID = 1;

(async () => {
  if (process.argv.includes('--clean')) {
    const [d] = await pool.query('DELETE FROM transactions WHERE user_id = ? AND content LIKE ?', [UID, MARK + '%']);
    const [left] = await pool.query('SELECT COUNT(*) n FROM transactions WHERE content LIKE ?', [MARK + '%']);
    console.log('已删除 ' + d.affectedRows + ' 条；带标记残留 ' + left[0].n + ' 条（应为 0）');
    process.exit(0);
  }

  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());

  const rows = [
    [2, 3200, '买菜', '买菜'],
    [2, 1800, '交房租', '房租'],
    [2, 960, '雇车拉货', '运费'],
    [2, 540, '买螺丝和膨胀钉', '五金'],
    [2, 380, '买电线和开关', '电料'],
    [2, 220, '买包装箱', '包装'],
    [2, 60, '买扫帚', '杂项'],
    [1, 5200, '卖货收款', '货款'],
    [1, 680, '卖废纸箱', '废品']
  ];

  for (const [t, a, c, cat] of rows) {
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, content, category, record_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      [UID, t, a, MARK + c, cat, day, UID]
    );
  }

  const [r] = await pool.query(
    'SELECT category, SUM(amount) s, COUNT(*) n FROM transactions WHERE user_id = ? AND content LIKE ? AND type IN (2,6) GROUP BY category ORDER BY s DESC',
    [UID, MARK + '%']
  );
  console.log('已造 ' + rows.length + ' 条（user ' + UID + '），支出分组：');
  r.forEach((x) => console.log('    ' + x.category + '  ¥' + x.s + '  ' + x.n + ' 笔'));
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
