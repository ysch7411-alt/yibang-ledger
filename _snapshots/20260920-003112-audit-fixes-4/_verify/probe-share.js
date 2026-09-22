// 分享报表接口回归 —— 公开接口，权限和边界必须一项项验
//
// 用法（在 /www/wwwroot/yibang-server 下）：node __probe-share.js
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const post = (p, d, h) => axios.post(BASE + p, d, { headers: h || H, timeout: 30000 })
  .then((r) => r.data).catch((e) => ({ code: -1, msg: e.message }));
const get = (p, h) => axios.get(BASE + p, { headers: h || {}, timeout: 30000 })
  .then((r) => r.data).catch((e) => ({ code: -1, msg: e.message }));

const rows = [];
const say = (ok, label, detail) => {
  rows.push(ok);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : ''));
};

const created = [];

(async () => {
  console.log('=== ① 创建「今日报表」分享 ===');
  const a = await post('/share/create', { type: 3, period: 'today' });
  say(a.code === 0, '创建成功', 'code=' + a.code + ' ' + (a.msg || ''));
  const tk = a.data && a.data.token;
  if (tk) created.push(tk);
  say(/^[0-9a-f]{64}$/.test(String(tk)), 'token 是 64 位随机 hex', String(tk).slice(0, 16) + '…');
  say(
    a.data && a.data.path === '/pages/report-view/report-view?token=' + tk,
    '返回的是小程序页面路径（不是后端没有渲染页的 http 链接）',
    a.data && a.data.path ? a.data.path.slice(0, 46) + '…' : ''
  );
  const today = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate());
  say(a.data && a.data.from === ymd && a.data.to === ymd, '区间是服务器算的今天', (a.data && a.data.from) + ' ~ ' + (a.data && a.data.to));

  console.log('\n=== ② 对方（未登录）打开 ===');
  const v = await get('/share/view/' + tk);   // 故意不带 Authorization
  say(v.code === 0, '**不带登录凭证也能读到**（对方只需打开小程序）', 'code=' + v.code);
  const d = v.data || {};
  say(d.kind === 'report', 'kind=report', d.kind);
  // 店名可能为空（老板没填）——空就交给客户端按品牌兜底，
  // 后端**不要**在这编一个「一个账本」：对方看到这四个字不知道是谁的账。
  say(typeof d.shop === 'string', 'shop 是字符串（可能为空，客户端兜底）', JSON.stringify(d.shop));
  {
    const [before] = await pool.query('SELECT shop_name FROM users WHERE id = 1');
    const orig = before.length ? before[0].shop_name : null;
    await pool.query('UPDATE users SET shop_name = ? WHERE id = 1', ['测试店名ZZTEST']);
    const vs = await get('/share/view/' + tk);
    say(vs.data && vs.data.shop === '测试店名ZZTEST', '**填了店名就能带出来**（对方才知道这是谁的账）', vs.data && vs.data.shop);
    await pool.query('UPDATE users SET shop_name = ? WHERE id = 1', [orig]);
  }
  say(d.label === '今日报表', 'label 正确', d.label);
  say(typeof d.income === 'number' && typeof d.expense === 'number', '收支是数字不是字符串(DECIMAL 坑)', d.income + ' / ' + d.expense);
  say(d.net === Math.round((d.income - d.expense) * 100) / 100, 'net = 收入-支出', d.net);
  say(Array.isArray(d.details) && d.details.length === d.count, '明细条数与 count 一致', d.count + ' 笔');
  say(typeof d.expireDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.expireDay), '给了有效期(字符串，不是 UTC 串)', d.expireDay);

  console.log('\n=== ③ 对外接口不能漏内部字段 ===');
  const first = (d.details || [])[0] || {};
  const leaked = ['user_id', 'created_by', 'status', 'openid', 'phone'].filter((k) => k in first);
  say(leaked.length === 0, '明细里没有内部字段', leaked.length ? '漏了 ' + leaked.join(',') : '字段：' + Object.keys(first).join(','));
  const topLeak = ['user_id', 'userid', 'phone'].filter((k) => k in d);
  say(topLeak.length === 0, '顶层也没有内部字段', topLeak.join(',') || 'ok');

  console.log('\n=== ④ 访问计数 ===');
  // 断言「每访问一次 +1」，不写死具体数字 ——
  // 上面任何一处多调一次接口都会让硬编码的期望值失效（这次就栽过一次）
  const pre = await get('/share/view/' + tk);
  const v2 = await get('/share/view/' + tk);
  const before = pre.data ? pre.data.viewCount : -1;
  const after = v2.data ? v2.data.viewCount : -1;
  say(after === before + 1, '每访问一次计数 +1', before + ' → ' + after);

  console.log('\n=== ⑤ 「本月报表」的区间 ===');
  const b = await post('/share/create', { type: 3, period: 'month' });
  if (b.data && b.data.token) created.push(b.data.token);
  say(b.code === 0 && b.data.from === ymd.slice(0, 8) + '01', '本月从 1 号起', b.data && b.data.from + ' ~ ' + b.data.to);
  say(b.data && b.data.period === 'month', 'period=month', b.data && b.data.period);

  console.log('\n=== ⑥ 非法 token 一律 404，不给数据库白跑 ===');
  say((await get('/share/view/abc')).code === 404, '太短 → 404');
  say((await get('/share/view/' + 'z'.repeat(64))).code === 404, '64 位但非 hex → 404');
  say((await get('/share/view/' + 'a'.repeat(64))).code === 404, '格式正确但不存在 → 404');

  console.log('\n=== ⑦ 过期就不能再看 ===');
  const c = await post('/share/create', { type: 3, period: 'today' });
  const tkExp = c.data && c.data.token;
  if (tkExp) created.push(tkExp);
  await pool.query('UPDATE shares SET expire_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE token = ?', [tkExp]);
  say((await get('/share/view/' + tkExp)).code === 404, '**过期后 404**', '（不是返回空数据）');

  console.log('\n=== ⑧ 参数校验 ===');
  say((await post('/share/create', { type: 9 })).code === 400, '非法 type → 400');
  say((await post('/share/create', { type: 3, expire_days: 0 })).code === 400, 'expire_days=0 → 400');
  say((await post('/share/create', { type: 3, expire_days: 999 })).code === 400, 'expire_days=999 → 400');
  const badP = await post('/share/create', { type: 3, period: '乱写的' });
  if (badP.data && badP.data.token) created.push(badP.data.token);
  say(badP.code === 0 && badP.data.period === 'today', '乱写的 period 回落到 today（不是报错也不是空）', badP.data && badP.data.period);

  console.log('\n=== ⑨ 越权：拿别人的 contact_id 建对账分享 ===');
  const [ins] = await pool.query(
    'INSERT INTO contacts (user_id, name, type) VALUES (?, ?, 1)',
    [9999, '别人的客户ZZTEST']
  );
  const otherId = ins.insertId;
  const bad = await post('/share/create', { type: 2, contact_id: otherId });
  say(bad.code === 400, '**拒绝创建（原来能建，链接一给出去就是别人客户的名字电话）**', 'code=' + bad.code + ' ' + bad.msg);
  say((await post('/share/create', { type: 2 })).code === 400, '不带 contact_id → 400');
  await pool.query('DELETE FROM contacts WHERE id = ?', [otherId]);

  console.log('\n=== ⑩ 自己的对账分享正常，且读联系人带 user_id ===');
  const [mine] = await pool.query('SELECT id, name FROM contacts WHERE user_id = 1 LIMIT 1');
  if (mine.length) {
    const ok = await post('/share/create', { type: 2, contact_id: mine[0].id });
    if (ok.data && ok.data.token) created.push(ok.data.token);
    say(ok.code === 0, '自己的客户能建', 'code=' + ok.code);
    const cv = await get('/share/view/' + ok.data.token);
    say(cv.code === 0 && cv.data.contact && cv.data.contact.name === mine[0].name, '读得到，名字对得上', cv.data.contact && cv.data.contact.name);
    say(!('user_id' in (cv.data.contact || {})), '联系人也没有漏内部字段', Object.keys(cv.data.contact || {}).join(','));
  }

  // /share/mine 已随接口一起删除（2026-09-19 审计）—— 那时它前端零调用，现在也还没有调用方。
  // 索引号 ⑪ 留空，免得后面的人以为是漏写了。

  // 清理
  if (created.length) {
    await pool.query('DELETE FROM shares WHERE token IN (?)', [created]);
    console.log('\n已清理 ' + created.length + ' 条测试分享记录');
  }

  const bad2 = rows.filter((x) => !x).length;
  console.log('\n================ 汇总 ================');
  console.log('分享接口：' + (rows.length - bad2) + ' / ' + rows.length + ' 通过');
  process.exit(bad2 ? 1 : 0);
})().catch((e) => {
  console.error('探测自身出错：', e.message);
  process.exit(1);
});
