// 验证「合并成一张，但可按供应商 / 按品类统计」
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const post = (p, d) => axios.post(BASE + p, d, { headers: H, timeout: 120000 }).then((r) => r.data).catch((e) => ({ code: -1, msg: e.message }));
const get = (p) => axios.get(BASE + p, { headers: H, timeout: 30000 }).then((r) => r.data).catch((e) => ({ code: -1, msg: e.message }));

(async () => {
  const rows = [];
  const say = (ok, label, detail) => { rows.push(ok); console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : '')); };

  console.log('=== ① AI 识别是否输出品类 ===');
  const p = await post('/purchase/parse-doc', { text: '螺纹钢 HRB400 12mm 2.5吨 3800元一吨\n圆钢 Q235 20mm 1.2吨 4200元一吨' });
  const cats = ((p.data && p.data.items) || []).map((x) => x.category);
  say(p.code === 0 && cats.filter(Boolean).length > 0, '每行都带上了品类', 'code=' + p.code + ' msg=' + (p.msg || '') + ' 实际: ' + JSON.stringify(cats));

  console.log('\n=== ② 保存一张「多供应商汇总」的采购单 ===');
  const items = [
    { name: '螺纹钢', category: '钢材', supplierName: '重庆鑫达钢材有限公司', spec: 'HRB400 12mm', unit: '吨', qty: 2.5, price: 3800, amount: 9500 },
    { name: '圆钢', category: '钢材', supplierName: '重庆鑫达钢材有限公司', spec: 'Q235 20mm', unit: '吨', qty: 1.2, price: 4200, amount: 5040 },
    { name: '手电钻', category: '五金', supplierName: '成都五金机电', unit: '台', qty: 1, price: 890, amount: 890 },
    { name: '自攻螺丝', category: '五金', supplierName: '成都五金机电', unit: '盒', qty: 3, price: 70, amount: 210 },
    { name: '气泡膜', category: '包装', supplierName: '渝北包装材料', unit: '卷', qty: 2, price: 45, amount: 90 }
  ];
  const r = await post('/purchase/save', { supplier: '', date: '2026-09-19', items });
  say(r.code === 0, '合并成一张保存成功', 'orderId=' + (r.data && r.data.orderId) + ' 合计=' + (r.data && r.data.total) + ' 项数=' + (r.data && r.data.itemCount));
  const orderId = r.data && r.data.orderId;
  if (!orderId) { console.log('无法继续'); process.exit(1); }

  console.log('\n=== ③ 明细行是否逐行保住了供应商与品类 ===');
  const d = await get('/purchase/detail?id=' + orderId);
  const its = (d.data && d.data.items) || [];
  say(its.length === 5, '明细 5 行');
  say(its.every((x) => x.supplier_name && x.category), '每行都有 supplier_name + category');
  its.forEach((x) => console.log('      ' + x.seq + '. ' + x.item_name + '  [' + x.category + ']  ' + x.supplier_name + '  ¥' + x.amount));

  console.log('\n=== ④ 按供应商统计 ===');
  const s1 = await get('/purchase/stats?from=2026-09-19&to=2026-09-19&groupBy=supplier');
  (s1.data && s1.data.list || []).forEach((x) => console.log('      ' + x.key + '  ¥' + x.amount + '  ' + x.count + ' 项 / 涉及 ' + x.orders + ' 张单'));
  const m = {};
  ((s1.data && s1.data.list) || []).forEach((x) => { m[x.key] = x.amount; });
  say(m['重庆鑫达钢材有限公司'] === 14540, '重庆鑫达 = 14540', '实际 ' + m['重庆鑫达钢材有限公司']);
  say(m['成都五金机电'] === 1100, '成都五金 = 1100', '实际 ' + m['成都五金机电']);
  say(m['渝北包装材料'] === 90, '渝北包装 = 90', '实际 ' + m['渝北包装材料']);
  const mine = ['重庆鑫达钢材有限公司','成都五金机电','渝北包装材料'].reduce((a, k) => a + (m[k] || 0), 0);
  say(mine === 15730, '三家的合计 = 15730（= 测试单据合计）', '实际 ' + mine);

  console.log('\n=== ⑤ 按品类统计 ===');
  const s2 = await get('/purchase/stats?from=2026-09-19&to=2026-09-19&groupBy=category');
  (s2.data && s2.data.list || []).forEach((x) => console.log('      ' + x.key + '  ¥' + x.amount + '  ' + x.count + ' 项'));
  const m2 = {};
  ((s2.data && s2.data.list) || []).forEach((x) => { m2[x.key] = x.amount; });
  say(m2['钢材'] === 14540, '钢材 = 14540', '实际 ' + m2['钢材']);
  say(m2['五金'] === 1100, '五金 = 1100', '实际 ' + m2['五金']);
  say(m2['包装'] === 90, '包装 = 90', '实际 ' + m2['包装']);

  console.log('\n=== ⑥ 品类是否沉淀进词表（下次解析会优先复用）===');
  const [terms] = await pool.query("SELECT canonical, hits FROM merchant_terms WHERE user_id = 1 AND kind = 'category' ORDER BY canonical");
  say(terms.length >= 3, '词表里出现了品类', terms.map((t) => t.canonical).join('、'));

  console.log('\n=== ⑦ groupBy 兜底（乱传也不能出错）===');
  const s3 = await get('/purchase/stats?groupBy=__evil__');
  say(s3.code === 0, '非法 groupBy 回落到 supplier', 'groupBy=' + (s3.data && s3.data.groupBy));

  // 清理
  await pool.query('DELETE FROM purchase_items WHERE order_id = ?', [orderId]);
  await pool.query('DELETE FROM purchase_orders WHERE id = ?', [orderId]);
  await pool.query('DELETE FROM transactions WHERE user_id = 1 AND content LIKE ?', ['采购：螺纹钢%']);
  await pool.query("DELETE FROM contacts WHERE user_id = 1 AND name IN ('成都五金机电','渝北包装材料')");
  await pool.query("DELETE FROM merchant_terms WHERE user_id = 1 AND kind = 'category'");
  console.log('\n测试数据已清理');

  const bad = rows.filter((x) => !x).length;
  console.log('\n================ 汇总 ================');
  console.log('分类统计：' + (rows.length - bad) + ' / ' + rows.length + ' 通过');
  process.exit(0);
})();
