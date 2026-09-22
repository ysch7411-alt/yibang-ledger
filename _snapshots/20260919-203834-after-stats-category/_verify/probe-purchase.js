// 验证采购单：文字 → 结构化明细 → 落库
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 1800 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const post = (p, d) => axios.post(BASE + p, d, { headers: H, timeout: 90000 }).then((r) => r.data);
const get = (p) => axios.get(BASE + p, { headers: H, timeout: 30000 }).then((r) => r.data);

const DOC = `送货单
供货单位：重庆鑫达钢材有限公司
单号：XS-20260919-008
日期：2026年9月19日
序号  品名      规格型号          单位   数量     单价      金额
1     螺纹钢    HRB400 12mm      吨     2.5     3800.00   9500.00
2     圆钢      Q235 20mm        吨     1.2     4200.00   5040.00
3     角钢      50×50×5          吨     0.8     3950.00   3160.00
合计                                                  17700.00
备注：货已收到，验收合格`;

(async () => {
  console.log('=== ① 结构化解析（文字入口）===');
  const p = await post('/purchase/parse-doc', { text: DOC });
  if (p.code !== 0) { console.error('  解析失败:', p.msg); process.exit(1); }
  const d = p.data;
  console.log('  供应商: ' + d.supplier);
  console.log('  单据号: ' + d.orderNo);
  console.log('  日期  : ' + d.date);
  console.log('  合计  : ' + d.total);
  console.log('  明细  :');
  d.items.forEach((it) => {
    console.log('    ' + it.seq + '. ' + it.name + ' | 规格 ' + it.spec + ' | 单位 ' + it.unit +
      ' | 数量 ' + it.qty + ' | 单价 ' + it.price + ' | 金额 ' + it.amount);
  });

  const okSupplier = d.supplier.includes('鑫达');
  const okItems = d.items.length === 3;
  const okSpec = d.items.every((it) => it.spec && it.unit && it.qty && it.price && it.amount);
  const sum = Math.round(d.items.reduce((s, it) => s + (it.amount || 0), 0) * 100) / 100;
  console.log('\n  判定: 供应商' + (okSupplier ? '✓' : '✗') + '  明细3行' + (okItems ? '✓' : '✗') +
    '  规格/单位/数量/单价/金额齐全' + (okSpec ? '✓' : '✗') + '  明细求和=' + sum + (sum === 17700 ? '✓' : '✗'));

  console.log('\n=== ② 保存采购单 ===');
  const s = await post('/purchase/save', {
    supplier: d.supplier, orderNo: d.orderNo, date: d.date, items: d.items
  });
  console.log('  ' + JSON.stringify(s));
  if (s.code !== 0) process.exit(1);
  const orderId = s.data.orderId;

  console.log('\n=== ③ 回读详情 ===');
  const det = await get('/purchase/detail?id=' + orderId);
  console.log('  单据: ' + det.data.order.supplier_name + ' / ' + det.data.order.order_date +
    ' / 合计 ' + det.data.order.total_amount + ' / ' + det.data.order.item_count + ' 项');
  det.data.items.forEach((it) => {
    console.log('    ' + it.seq + '. ' + it.item_name + ' ' + it.spec + ' ' + it.unit +
      ' 数量' + it.qty + ' 单价' + it.unit_price + ' 金额' + it.amount);
  });

  console.log('\n=== ④ 顺带生成的支出流水 ===');
  const [tx] = await pool.query(
    'SELECT type, amount, content, record_date FROM transactions WHERE user_id=1 ORDER BY id DESC LIMIT 1'
  );
  console.log('  ' + JSON.stringify(tx[0]));

  console.log('\n=== 清理 ===');
  await pool.query('DELETE FROM purchase_items WHERE order_id = ?', [orderId]);
  await pool.query('DELETE FROM purchase_orders WHERE id = ?', [orderId]);
  await pool.query("DELETE FROM transactions WHERE user_id=1 AND content LIKE '采购：%'");
  await pool.query("DELETE FROM contacts WHERE user_id=1 AND name LIKE '%鑫达%'");
  console.log('  已清理测试数据');
  process.exit(0);
})().catch((e) => {
  console.error('失败:', (e.response && JSON.stringify(e.response.data)) || e.message);
  process.exit(1);
});
