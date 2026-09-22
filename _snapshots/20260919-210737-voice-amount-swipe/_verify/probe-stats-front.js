// 前端统计层的端到端验证：真实 utils/api.js + 真实 utils/format.js + 真实后端
//
// 为什么要在服务端跑前端的模块：api.js 里 `app()` 只是 `getApp()` 的一层壳，
// 把它替换成一个直接打 axios 的 request 就能脱离小程序环境跑通整条链路。
// 这样验的是**页面真正会用到的那份代码**，而不是照着它再写一遍的仿制品。
//
// 用法（在 /www/wwwroot/yibang-server 下）：
//   cp <小程序>/utils/{api,format}.js /tmp/yb/    # 保持相对 require 关系
//   node probe-stats-front.js
const path = require('path');
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3000/api';
const U = (process.env.PROBE_DIR || '/tmp/yb');

const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });

// getApp() 的替身：把 /xxx 转成真实 HTTP 请求，返回后端原始 {code,msg,data}
let deadPort = false;
global.getApp = () => ({
  request(url, opts) {
    const o = opts || {};
    const cfg = {
      url: (deadPort ? 'http://127.0.0.1:59999/api' : BASE) + url,
      method: o.method || 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 30000
    };
    if (o.data !== undefined) cfg.data = o.data;
    return axios(cfg).then((r) => r.data);
  }
});

const api = require(path.join(U, 'api.js'));
const fmt = require(path.join(U, 'format.js'));

const rows = [];
const say = (ok, label, detail) => {
  rows.push(ok);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : ''));
};
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

(async () => {
  console.log('=== ① 统计区间口径（rangeOf）===');
  const d7 = fmt.rangeOf('d7');
  const d30 = fmt.rangeOf('d30');
  const mon = fmt.rangeOf('month');
  const last = fmt.rangeOf('lastMonth');
  const now = new Date();
  const ymdMon = (y, m, dd) => y + '-' + String(m).padStart(2, '0') + '-' + String(dd).padStart(2, '0');

  say(d7.to === day(0), '近 7 天止于今天', d7.from + ' ~ ' + d7.to);
  say(d7.from === day(-6), '近 7 天含今天共 7 天', '起 ' + d7.from);
  say(d30.from === day(-29), '近 30 天含今天共 30 天', '起 ' + d30.from);
  say(mon.from === ymdMon(now.getFullYear(), now.getMonth() + 1, 1), '本月从 1 号算起', mon.from + ' ~ ' + mon.to);
  say(
    last.from === ymdMon(now.getFullYear(), now.getMonth() - 1 <= 0 ? 12 : now.getMonth(), 1),
    '上月从 1 号算起',
    last.from + ' ~ ' + last.to
  );
  // 上月末日必须是真末日：new Date(y, m, 0) 的写法不能把 2 月算成 30 号
  const lastEnd = new Date(last.to + 'T00:00:00');
  const nextDay = new Date(lastEnd.getTime() + 86400000);
  say(nextDay.getDate() === 1, '上月末日的次日是 1 号', last.to + ' → ' + fmt.ymd(nextDay));

  console.log('\n=== ② 拿不到数据必须返回 null，不能编一份全 0 的假报表 ===');
  deadPort = true;
  const dead = await api.getPurchaseStats({ groupBy: 'supplier', range: 'd30' });
  deadPort = false;
  say(dead === null, '后端不可达时返回 null', '实际 ' + JSON.stringify(dead));

  console.log('\n=== ③ 铺一批有明确真值的多供应商数据 ===');
  const today = fmt.ymd();
  const items = [
    { name: '螺纹钢', category: '钢材', supplierName: '重庆鑫达钢材有限公司', unit: '吨', qty: 2.5, price: 3800, amount: 9500 },
    { name: '圆钢', category: '钢材', supplierName: '重庆鑫达钢材有限公司', unit: '吨', qty: 1.2, price: 4200, amount: 5040 },
    { name: '手电钻', category: '五金', supplierName: '成都五金机电', unit: '台', qty: 1, price: 890, amount: 890 },
    { name: '自攻螺丝', category: '五金', supplierName: '成都五金机电', unit: '盒', qty: 3, price: 70, amount: 210 },
    { name: '气泡膜', category: '包装', supplierName: '渝北包装材料', unit: '卷', qty: 2, price: 45, amount: 90 }
  ];
  const saved = await api.safe(
    global.getApp().request('/purchase/save', { method: 'POST', data: { supplier: '', date: today, items } }),
    null
  );
  say(!!(saved && saved.orderId), '合并成一张保存成功', 'orderId=' + (saved && saved.orderId));
  const orderId = saved && saved.orderId;
  if (!orderId) { console.log('无法继续'); process.exit(1); }

  console.log('\n=== ④ 按供应商统计（页面拿到手的形状）===');
  const s1 = await api.getPurchaseStats({ groupBy: 'supplier', range: 'd7' });
  say(!!s1, '拿到了统计对象');
  say(s1.groupBy === 'supplier', 'groupBy 正确', s1.groupBy);
  s1.list.forEach((r) => console.log('      #' + r.rank + ' ' + r.key + '  ¥' + r.amountText + '  ' + r.count + ' 项 / ' + r.orders + ' 张 · ' + r.share + '% · 条长 ' + r.pct + '%'));
  const m1 = {};
  s1.list.forEach((r) => { m1[r.key] = r.amount; });
  say(m1['重庆鑫达钢材有限公司'] === 14540, '重庆鑫达 = 14540', '实际 ' + m1['重庆鑫达钢材有限公司']);
  say(m1['成都五金机电'] === 1100, '成都五金 = 1100', '实际 ' + m1['成都五金机电']);
  say(m1['渝北包装材料'] === 90, '渝北包装 = 90', '实际 ' + m1['渝北包装材料']);
  say(s1.list[0].pct === 100, '榜首条长 100%', '实际 ' + s1.list[0].pct);
  say(s1.list.every((r) => r.pct >= 6 && r.pct <= 100), '其余条长都在 6%~100%', s1.list.map((r) => r.pct).join('/'));
  say(s1.list.every((r, i) => i === 0 || r.amount <= s1.list[i - 1].amount), '金额从大到小排好');
  const shareSum = s1.list.reduce((a, r) => a + r.share, 0);
  say(Math.abs(shareSum - 100) <= 1, '占比加总 ≈ 100%', '实际 ' + shareSum);

  console.log('\n=== ⑤ 按品类统计 ===');
  const s2 = await api.getPurchaseStats({ groupBy: 'category', range: 'd7' });
  s2.list.forEach((r) => console.log('      #' + r.rank + ' ' + r.key + '  ¥' + r.amountText + '  ' + r.count + ' 项 · ' + r.share + '%'));
  const m2 = {};
  s2.list.forEach((r) => { m2[r.key] = r.amount; });
  say(m2['钢材'] === 14540, '钢材 = 14540', '实际 ' + m2['钢材']);
  say(m2['五金'] === 1100, '五金 = 1100', '实际 ' + m2['五金']);
  say(m2['包装'] === 90, '包装 = 90', '实际 ' + m2['包装']);
  say(s2.groupBy === 'category', 'groupBy 正确', s2.groupBy);

  console.log('\n=== ⑥ 非法 groupBy 由前端白名单挡下（不能悄悄给出另一种口径）===');
  const s3 = await api.getPurchaseStats({ groupBy: '__evil__', range: 'd7' });
  say(s3 && s3.groupBy === 'supplier', '前端把它当 supplier 处理', s3 && s3.groupBy);

  console.log('\n=== ⑦ 空区间：回空列表 + 合计 0，不是失败 ===');
  const s4 = await api.getPurchaseStats({ from: '2020-01-01', to: '2020-01-31', groupBy: 'supplier' });
  say(!!s4 && s4.total === 0 && s4.list.length === 0, '空区间干净回空', 'total=' + (s4 && s4.total) + ' list=' + (s4 && s4.list.length));
  say(!!s4 && s4.totalText === '0.00', 'totalText 是 0.00 而不是 NaN', s4 && s4.totalText);

  console.log('\n=== ⑧ 后端原样返回 from/to，页面标题才对得上 ===');
  say(s4.from === '2020-01-01' && s4.to === '2020-01-31', '回显请求区间', s4.from + ' ~ ' + s4.to);

  // 清理
  await pool.query('DELETE FROM purchase_items WHERE order_id = ?', [orderId]);
  await pool.query('DELETE FROM purchase_orders WHERE id = ?', [orderId]);
  await pool.query('DELETE FROM transactions WHERE user_id = 1 AND content LIKE ?', ['采购：螺纹钢%']);
  await pool.query("DELETE FROM contacts WHERE user_id = 1 AND name IN ('成都五金机电','渝北包装材料')");
  console.log('\n测试数据已清理');

  const bad = rows.filter((x) => !x).length;
  console.log('\n================ 汇总 ================');
  console.log('前端统计层：' + (rows.length - bad) + ' / ' + rows.length + ' 通过');
  process.exit(bad ? 1 : 0);
})();
