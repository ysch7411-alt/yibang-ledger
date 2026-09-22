// 验证索引真的被用上了 —— 建了不等于用了，必须 EXPLAIN 看一眼
require('dotenv').config();
const pool = require('./db/config');

(async () => {
  const cases = [
    ['按区间查流水', "SELECT t.*, c.name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = 1 AND t.record_date >= '2026-09-01' AND t.record_date <= '2026-09-30' ORDER BY t.record_date DESC"],
    ['按日分组汇总', "SELECT DATE_FORMAT(record_date,'%Y-%m-%d') k, SUM(amount) FROM transactions WHERE user_id = 1 AND record_date BETWEEN '2026-09-01' AND '2026-09-30' GROUP BY k"],
    ['往来列表', 'SELECT * FROM contacts WHERE user_id = 1'],
    ['往来余额汇总', 'SELECT SUM(balance) FROM contacts WHERE user_id = 1'],
    ['上传文件列表', 'SELECT * FROM files WHERE user_id = 1']
  ];

  for (const [label, sql] of cases) {
    const [rows] = await pool.query('EXPLAIN ' + sql);
    const r = rows[0];
    const key = r.key || r.possible_keys || '(无)';
    const used = r.key ? '✓ 走索引' : '✗ 全表扫';
    console.log('  ' + used + '  ' + label.padEnd(12) + '  type=' + String(r.type).padEnd(7) + ' key=' + key + '  rows≈' + r.rows);
  }
  process.exit(0);
})();
