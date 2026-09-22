// 验证：多张汇总的采购单保存 → 回读，source_file_ids 要完整记下所有来源照片
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const post = (p, d) => axios.post(BASE + p, d, { headers: H, timeout: 60000 }).then((r) => r.data).catch((e) => ({ code: -1, msg: e.message }));
const get = (p) => axios.get(BASE + p, { headers: H, timeout: 30000 }).then((r) => r.data).catch((e) => ({ code: -1 }));

(async () => {
  const rows = [];
  const say = (ok, label, detail) => { rows.push(ok); console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : '')); };

  // 造两张来源照片记录（fileIds 要能对上）
  const [f1] = await pool.query("INSERT INTO files (user_id, file_url, file_type, file_size) VALUES (1, '/uploads/__multi_a.jpg', 'image/jpeg', 1000)");
  const [f2] = await pool.query("INSERT INTO files (user_id, file_url, file_type, file_size) VALUES (1, '/uploads/__multi_b.jpg', 'image/jpeg', 1000)");

  const items = [
    { name: '螺纹钢', spec: 'HRB400 12mm', unit: '吨', qty: 2.5, price: 3800, amount: 9500 },
    { name: '圆钢', spec: 'Q235 20mm', unit: '吨', qty: 1.2, price: 4200, amount: 5040 },
    { name: '角钢', spec: '50×50×5', unit: '吨', qty: 0.8, price: 3950, amount: 3160 }
  ];

  console.log('=== ① 多张汇总保存（不带 supplier，带 fileIds）===');
  const r = await post('/purchase/save', {
    supplier: '', date: '2026-09-19', fileId: f1.insertId, fileIds: [f1.insertId, f2.insertId], items
  });
  say(r.code === 0, '保存成功', r.code === 0 ? ('orderId=' + r.data.orderId + ' 合计=' + r.data.total + ' 项数=' + r.data.itemCount) : ('msg=' + r.msg));
  const orderId = r.data && r.data.orderId;
  if (!orderId) { console.log('无法继续'); process.exit(1); }

  console.log('\n=== ② 合计必须按行重算 ===');
  say(Number(r.data.total) === 17700, '合计 = 各行之和 17700', '实际 ' + r.data.total);

  console.log('\n=== ③ 回读：来源照片是否完整记下 ===');
  const d = await get('/purchase/detail?id=' + orderId);
  const o = (d.data && d.data.order) || {};
  say(String(o.source_file_ids) === f1.insertId + ',' + f2.insertId, 'source_file_ids 记下了两张', '实际 ' + o.source_file_ids);
  say(Number(o.source_file_id) === f1.insertId, 'source_file_id 仍是第一张（老字段兼容）', '实际 ' + o.source_file_id);
  say(((d.data && d.data.items) || []).length === 3, '明细 3 行');

  console.log('\n=== ④ 顺带生成的支出流水 ===');
  const [tx] = await pool.query("SELECT amount, content FROM transactions WHERE user_id = 1 AND content LIKE '采购：角钢%' OR (user_id = 1 AND content LIKE '采购：螺纹钢%') ORDER BY id DESC LIMIT 1");
  say(tx.length === 1 && Number(tx[0].amount) === 17700, '流水金额 17700', tx.length ? tx[0].content : '无');

  console.log('\n=== ⑤ 兼容：单张（只传 fileId）仍要能存 ===');
  const r2 = await post('/purchase/save', { supplier: '单张测试', date: '2026-09-19', fileId: f1.insertId, items: [items[0]] });
  const d2 = await get('/purchase/detail?id=' + (r2.data && r2.data.orderId));
  const o2 = (d2.data && d2.data.order) || {};
  say(r2.code === 0 && Number(o2.source_file_id) === f1.insertId && String(o2.source_file_ids) === String(f1.insertId),
    '单张也正确落 source_file_ids', 'file_id=' + o2.source_file_id + ' file_ids=' + o2.source_file_ids);

  // 清理
  await pool.query('DELETE FROM purchase_items WHERE user_id = 1 AND order_id IN (?, ?)', [orderId, r2.data && r2.data.orderId]);
  await pool.query('DELETE FROM purchase_orders WHERE id IN (?, ?)', [orderId, r2.data && r2.data.orderId]);
  await pool.query('DELETE FROM transactions WHERE user_id = 1 AND content LIKE ?', ['采购：螺纹钢 等 3 项%']);
  await pool.query('DELETE FROM transactions WHERE user_id = 1 AND content LIKE ?', ['采购：螺纹钢%']);
  await pool.query('DELETE FROM files WHERE id IN (?, ?)', [f1.insertId, f2.insertId]);
  await pool.query('DELETE FROM contacts WHERE user_id = 1 AND name = ?', ['单张测试']);
  console.log('\n测试数据已清理');

  const bad = rows.filter((x) => !x).length;
  console.log('\n================ 汇总 ================');
  console.log('多张汇总保存：' + (rows.length - bad) + ' / ' + rows.length + ' 通过');
  process.exit(0);
})();
