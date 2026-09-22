// 注销账号接口验证：参数守卫 / 只删自己 / 真的删干净 / 无 token 拒绝
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const tok = (u) => jwt.sign({ userId: u }, process.env.JWT_SECRET, { expiresIn: 600 });
const post = (p, d, u) =>
  axios.post(BASE + p, d, { headers: u === null ? { 'Content-Type': 'application/json' } : { Authorization: 'Bearer ' + tok(u), 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true })
    .then((r) => ({ http: r.status, body: r.data })).catch((e) => ({ http: 'ERR', body: {} }));

const count = async (t, uid) => Number((await pool.query(`SELECT COUNT(*) c FROM ${t} WHERE user_id = ?`, [uid]))[0][0].c);

(async () => {
  const rows = [];
  await pool.query("DELETE FROM users WHERE openid LIKE '__del_test%'");
  await pool.query('DELETE FROM transactions WHERE content IN (?, ?)', ['__A流水__', '__B流水__']);
  const say = (ok, label, detail) => { rows.push({ ok, label }); console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : '')); };

  // 造一个"待注销"的商户：A（要删）和 B（不能被动到）
  const [a] = await pool.query("INSERT INTO users (openid, phone, role) VALUES ('__del_test_A__', '13800000001', 1)");
  const [b] = await pool.query("INSERT INTO users (openid, phone, role) VALUES ('__del_test_B__', '13800000002', 1)");
  const A = a.insertId, B = b.insertId;

  const [ca] = await pool.query("INSERT INTO contacts (user_id, name) VALUES (?, '__A客户__')", [A]);
  await pool.query("INSERT INTO contacts (user_id, name) VALUES (?, '__B客户__')", [B]);
  await pool.query("INSERT INTO transactions (user_id, type, amount, content, record_date) VALUES (?, 2, 1.11, '__A流水__', '2026-09-19')", [A]);
  await pool.query("INSERT INTO transactions (user_id, type, amount, content, record_date) VALUES (?, 2, 2.22, '__B流水__', '2026-09-19')", [B]);
  await pool.query("INSERT INTO merchant_terms (user_id, kind, alias, canonical) VALUES (?, 'reason', '__A事由__', '__A事由__')", [A]);
  await pool.query("INSERT INTO shares (token, user_id, type) VALUES (?, ?, 1)", ['__del_test_token__', A]);
  const [po] = await pool.query("INSERT INTO purchase_orders (user_id, supplier_name, total_amount) VALUES (?, '__A供应商__', 9.9)", [A]);
  await pool.query("INSERT INTO purchase_items (order_id, user_id, item_name) VALUES (?, ?, '__A品名__')", [po.insertId, A]);

  console.log('A=' + A + '（待注销，已有客户/流水/词表/分享/采购单）  B=' + B + '（不该被动到）\n');

  console.log('=== ① 守卫 ===');
  say((await post('/user/delete-account', {}, null)).body.code === 401, '无 token → 401');
  say((await post('/user/delete-account', {}, A)).body.code === 400, '不带 confirm → 400（防误触）');
  say((await post('/user/delete-account', { confirm: 'delete' }, A)).body.code === 400, 'confirm 大小写不对 → 400');

  console.log('\n=== ② 正常注销 ===');
  const r = await post('/user/delete-account', { confirm: 'DELETE' }, A);
  say(r.body.code === 0, '注销返回成功', 'msg=' + r.body.msg);

  console.log('\n=== ③ A 的数据是否真的删干净 ===');
  for (const t of ['contacts', 'transactions', 'merchant_terms', 'shares', 'purchase_orders', 'purchase_items']) {
    const c = await count(t, A);
    say(c === 0, t + ' 剩 ' + c + ' 行');
  }
  {
    const c = Number((await pool.query('SELECT COUNT(*) c FROM users WHERE id = ?', [A]))[0][0].c);
    say(c === 0, 'users 剩 ' + c + ' 行');
  }
  const [poLeft] = await pool.query("SELECT COUNT(*) c FROM purchase_items WHERE item_name = '__A品名__'");
  say(Number(poLeft[0].c) === 0, '采购单明细也没留下');

  console.log('\n=== ④ B 的数据必须原封不动 ===');
  say((await count('contacts', B)) === 1, 'B 的往来对象还在');
  say((await count('transactions', B)) === 1, 'B 的流水还在');
  say(Number((await pool.query('SELECT COUNT(*) c FROM users WHERE id = ?', [B]))[0][0].c) === 1, 'B 的用户还在');

  // 清理 B
  await pool.query('DELETE FROM transactions WHERE user_id = ?', [B]);
  await pool.query('DELETE FROM contacts WHERE user_id = ?', [B]);
  await pool.query('DELETE FROM users WHERE id = ?', [B]);
  await pool.query("DELETE FROM users WHERE openid LIKE '__del_test%'");
  console.log('\n测试数据已清理');

  const bad = rows.filter((x) => !x.ok);
  console.log('\n================ 汇总 ================');
  console.log('注销账号：' + (rows.length - bad.length) + ' / ' + rows.length + ' 通过');
  if (bad.length) bad.forEach((x) => console.log('  ✗ ' + x.label));
  process.exit(0);
})();
