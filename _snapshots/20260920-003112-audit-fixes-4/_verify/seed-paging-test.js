// 一次性：造一批数据把查询页的"分页/上拉加载更多"逼出来，验完删掉。
// 只用 9 条真实数据是验不到分页的 —— 那正是"没验到"和"验过了"的区别。
require('dotenv').config();
const pool = require('./db/config');

const N = 210;

(async () => {
  const vals = [];
  const args = [];
  for (let i = 1; i <= N; i++) {
    vals.push('(1,?,?,?,?,1,1)');
    args.push(i % 2 ? 1 : 2, (i % 97) + 1, 'ZZTEST批量' + i, '2026-08-' + String((i % 28) + 1).padStart(2, '0'));
  }
  await pool.query(
    'INSERT INTO transactions (user_id,type,amount,content,record_date,status,created_by) VALUES ' + vals.join(','),
    args
  );

  const [c] = await pool.query("SELECT COUNT(*) n FROM transactions WHERE user_id = 1 AND content LIKE 'ZZTEST批量%'");
  const [t] = await pool.query('SELECT COUNT(*) n FROM transactions WHERE user_id = 1');
  console.log('已插入 ' + c[0].n + ' 条批量测试数据；当前总共 ' + t[0].n + ' 条');
  process.exit(0);
})();
