// 数据库核对（只读）—— 放到服务器上用后端自己的 dotenv + mysql2 跑
// 用法（服务器上）：node __reconcile.js
require('dotenv').config();
const mysql = require('mysql2/promise');

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
};

const money = (v) => (v === null ? 'NULL' : Number(v).toFixed(2));

(async () => {
  const c = await mysql.createConnection(cfg);
  const out = [];
  const q = async (sql) => (await c.query(sql))[0];

  // ① 表与行数
  const tables = await q('SHOW TABLES');
  const rows = {};
  for (const t of tables) {
    const k = Object.values(t)[0];
    const [n] = (await q('SELECT COUNT(*) n FROM `' + k + '`')).map((r) => r.n);
    rows[k] = n;
  }
  out.push(['表清单', JSON.stringify(rows)]);

  // ② 索引
  const idx = {};
  for (const t of ['users', 'contacts', 'transactions']) {
    if (rows[t] === undefined) continue;
    idx[t] = (await q('SHOW INDEX FROM `' + t + '`')).map((r) => r.Key_name + '(' + r.Column_name + ')');
  }
  out.push(['索引', JSON.stringify(idx)]);

  // ③ 字符集
  const [cs] = await q('SELECT @@character_set_server s, @@collation_database col');
  out.push(['字符集', cs.s + ' / ' + cs.col]);

  // ④ 余额 vs 流水对账：余额 = 应收(3) + 回款(5) - 应付(4) - 付款(6)
  const bad = await q(`
    SELECT c.id, c.name, c.balance,
      ROUND(COALESCE(SUM(CASE WHEN t.type=3 THEN t.amount END),0)
          + COALESCE(SUM(CASE WHEN t.type=5 THEN t.amount END),0)
          - COALESCE(SUM(CASE WHEN t.type=4 THEN t.amount END),0)
          - COALESCE(SUM(CASE WHEN t.type=6 THEN t.amount END),0), 2) AS calc
    FROM contacts c LEFT JOIN transactions t ON t.contact_id = c.id
    GROUP BY c.id, c.name, c.balance
    HAVING ABS(c.balance - calc) > 0.01
  `);
  out.push(['余额对不上账的往来', String(bad.length)]);
  bad.forEach((r) => out.push(['  ✗ id=' + r.id + ' ' + r.name, '存=' + money(r.balance) + ' 流水算=' + money(r.calc)]));

  // ⑤ 挂在往来上但没有金额的流水（会让余额算错）
  const [zero] = await q(`SELECT COUNT(*) n FROM transactions WHERE contact_id IS NOT NULL AND contact_id > 0 AND (amount IS NULL OR amount = 0)`);
  out.push(['挂往来但金额为 0/NULL 的流水', String(zero.n)]);

  // ⑥ 同一用户下重名往来（会把两家的账混在一起）
  const dup = await q(`SELECT user_id, name, COUNT(*) c FROM contacts GROUP BY user_id, name HAVING c > 1`);
  out.push(['同户重名往来', String(dup.length)]);
  dup.forEach((r) => out.push(['  ✗ user=' + r.user_id, r.name + ' ×' + r.c]));

  // ⑦ 孤儿流水（contact_id 指向不存在的往来）
  const orph = await q(`SELECT COUNT(*) n FROM transactions t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.contact_id IS NOT NULL AND t.contact_id > 0 AND c.id IS NULL`);
  out.push(['指向不存在往来的流水', String(orph[0].n)]);

  // ⑧ 没有 user_id 的流水（多租户隔离的底线）
  const noOwner = await q(`SELECT COUNT(*) n FROM transactions WHERE user_id IS NULL OR user_id = 0`);
  out.push(['没有归属用户的流水', String(noOwner[0].n)]);

  // ⑨ 库大小
  const [sz] = await q(`SELECT ROUND(SUM(data_length + index_length)/1024/1024, 1) mb FROM information_schema.tables WHERE table_schema = DATABASE()`);
  out.push(['库大小', sz.mb + ' MB']);

  // ⑩ 同一台库上有没有别家的库（占用了磁盘/备份面）
  const dbs = (await q('SHOW DATABASES')).map((r) => r.Database);
  out.push(['服务器上的库', dbs.join(', ')]);

  out.forEach(([k, v]) => console.log('  ' + (k.startsWith('  ') ? k : k.padEnd(22, '　')) + ' : ' + v));

  const fails = out.filter(([k]) => k.startsWith('  ✗'));
  console.log('\n' + (fails.length ? '✗ 有 ' + fails.length + ' 项对不上' : '✓ 数据一致性全部通过'));
  await c.end();
})().catch((e) => {
  console.error('连库失败：' + e.message);
  process.exit(1);
});
