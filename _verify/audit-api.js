// 后端全量审计：31 个端点逐个打一遍，判定标准
//   404            → 不合格（路由没挂上）
//   500 / 崩溃     → 不合格（未处理异常）
//   401            → 鉴权正常（仅无 token 的那组允许）
//   400 + 可读原因  → 合格（路由在、参数校验在、错误语义清楚）
//   0              → 合格（读接口正常返回）
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
const cut = (s, n) => (String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n));

const results = [];

async function hit(method, path, body, headers) {
  const t0 = Date.now();
  // 注意：GET 不能带 data:null —— axios 会把它序列化成字符串 "null"，
  // 服务端 express.json() 解析失败。审计脚本自己制造的问题不该算到接口头上。
  const cfg = { method, url: BASE + path, headers: headers || H, timeout: 30000, validateStatus: () => true };
  if (method !== 'get' && body !== undefined) cfg.data = body;
  try {
    const r = await axios(cfg);
    return { http: r.status, ms: Date.now() - t0, body: r.data };
  } catch (e) {
    return { http: e.response ? e.response.status : 'ERR', ms: Date.now() - t0, body: e.response ? e.response.data : String(e.message) };
  }
}

/** 发一个「非法 JSON 字符串」当请求体，验证服务端给的是可读 400 而不是 500 */
async function hitRaw(path, raw) {
  const t0 = Date.now();
  try {
    const r = await axios({ method: 'post', url: BASE + path, data: raw, headers: H, timeout: 15000, validateStatus: () => true });
    return { http: r.status, ms: Date.now() - t0, body: r.data };
  } catch (e) {
    return { http: e.response ? e.response.status : 'ERR', ms: Date.now() - t0, body: e.response ? e.response.data : String(e.message) };
  }
}

async function check(label, method, path, body, expect, headers) {
  const r = await hit(method, path, body, headers);
  const code = r.body && typeof r.body === 'object' ? r.body.code : undefined;
  const msg = r.body && typeof r.body === 'object' ? r.body.msg : r.body;

  let verdict, ok;
  // HTTP 404 只有在「期望的不是 404」时才算不合格 —— 专门测兜底路由的用例期望就是 404
  if (r.http === 404 && !expect.includes(404)) { verdict = '✗ 路由不存在'; ok = false; }
  else if (r.http === 500 || r.http === 'ERR') { verdict = '✗ HTTP ' + r.http; ok = false; }
  else if (typeof code === 'undefined') { verdict = '✗ 返回非 JSON'; ok = false; }
  else if (code === 500) { verdict = '✗ 服务端异常'; ok = false; }
  else if (expect.includes(code)) { verdict = '✓'; ok = true; }
  else { verdict = '? code=' + code; ok = false; }

  results.push({ label, method, path, ok, http: r.http, code, msg: cut(msg, 54), ms: r.ms });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + pad(method + ' ' + path, 34) + pad('HTTP ' + r.http, 9) + pad('code=' + code, 10) + pad(r.ms + 'ms', 8) + cut(msg, 44));
  return r;
}

(async () => {
  const before = await pool.query('SELECT (SELECT COUNT(*) FROM transactions) t, (SELECT COUNT(*) FROM contacts) c, (SELECT COUNT(*) FROM purchase_orders) p, (SELECT COUNT(*) FROM promotions) pr, (SELECT COUNT(*) FROM users) u');
  const b = before[0][0];
  console.log('打点前数据：transactions=' + b.t + ' contacts=' + b.c + ' purchase_orders=' + b.p + ' promotions=' + b.pr + ' users=' + b.u + '\n');

  console.log('=========== 模块：user（登录 / 注册）===========');
  await check('读用户', 'get', '/user/info', null, [0]);
  await check('登录缺参', 'post', '/user/login', {}, [400]);
  await check('绑定手机号缺参', 'post', '/user/bind-phone', {}, [400]);
  await check('注销账号缺参', 'post', '/user/delete-account', {}, [400]);

  console.log('\n=========== 模块：record（记账）===========');
  await check('流水列表', 'get', '/record/list?page=1&size=5', null, [0]);
  await check('日报', 'get', '/record/daily-summary?date=2026-09-19', null, [0]);
  await check('月报', 'get', '/record/month-summary?month=2026-09', null, [0]);
  await check('AI归类缺参', 'post', '/record/ai-parse', {}, [400]);
  await check('建账缺参', 'post', '/record/create', {}, [400, 500]);
  await check('改账缺参', 'post', '/record/update', {}, [400]);
  await check('删账缺参', 'post', '/record/delete', {}, [400]);

  console.log('\n=========== 模块：contact（往来）===========');
  await check('往来列表', 'get', '/contact/list', null, [0]);
  await check('往来汇总', 'get', '/contact/summary', null, [0]);
  await check('往来详情缺参', 'get', '/contact/detail', null, [400]);
  await check('建往来缺参', 'post', '/contact/create', {}, [400]);

  console.log('\n=========== 模块：ai（语音 / 图片 / 问答）===========');
  await check('语音转写缺参', 'post', '/ai/asr', {}, [400]);
  await check('AI问答缺参', 'post', '/ai/chat', {}, [400]);

  console.log('\n=========== 模块：purchase（采购单）===========');
  await check('拆单缺参', 'post', '/purchase/parse-doc', {}, [400]);
  await check('保存缺参', 'post', '/purchase/save', {}, [400]);
  await check('采购单列表', 'get', '/purchase/list', null, [0]);
  await check('采购单详情缺参', 'get', '/purchase/detail', null, [400]);

  console.log('\n=========== 模块：file（上传）===========');
  await check('文件列表', 'get', '/file/list', null, [0]);
  await check('上传无文件', 'post', '/file/upload', {}, [400, 500]);

  console.log('\n=========== 模块：staff（店员审核）===========');
  await check('店员列表', 'get', '/staff/list', null, [0]);
  await check('待审列表', 'get', '/staff/pending', null, [0]);
  await check('审核缺参', 'post', '/staff/approve', {}, [400]);

  console.log('\n=========== 模块：promote / share / debug ===========');
  await check('推广进度', 'get', '/promote/info', null, [0]);
  await check('越用越懂', 'get', '/memory/info', null, [0]);
  await check('绑邀请缺参', 'post', '/promote/bind', {}, [400]);
  await check('建分享缺参', 'post', '/share/create', {}, [400]);
  await check('看分享坏token', 'get', '/share/view/__not_exist__', null, [400, 404]);
  await check('信标', 'post', '/debug/beacon', { step: 'audit' }, [0]);

  console.log('\n=========== 假成功 / 健壮性专项 ===========');
  await check('分享空参数不该成功', 'post', '/share/create', {}, [400]);
  await check('审核空参数不该成功', 'post', '/staff/approve', {}, [400]);
  await check('审核非法 status', 'post', '/staff/approve', { id: 999999, status: 7 }, [400]);
  await check('审核不存在的记录', 'post', '/staff/approve', { id: 999999, status: 1 }, [404]);
  {
    const r = await hitRaw('/record/ai-parse', 'null');
    const code = r.body && r.body.code;
    const ok = code === 400;
    results.push({ label: '坏 body 不该 500', method: 'post', path: '/record/ai-parse', ok, http: r.http, code, msg: cut(r.body && r.body.msg, 54), ms: r.ms });
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + pad('post 坏body /record/ai-parse', 34) + pad('HTTP ' + r.http, 9) + pad('code=' + code, 10) + pad(r.ms + 'ms', 8) + cut(r.body && r.body.msg, 44));
  }

  console.log('\n=========== 鉴权与兜底 ===========');
  await check('无 token 访问', 'get', '/record/list', null, [401], { 'Content-Type': 'application/json' });
  await check('不存在的接口', 'get', '/__no_such_api__', null, [404]);

  const after = await pool.query('SELECT (SELECT COUNT(*) FROM transactions) t, (SELECT COUNT(*) FROM contacts) c, (SELECT COUNT(*) FROM purchase_orders) p, (SELECT COUNT(*) FROM promotions) pr, (SELECT COUNT(*) FROM users) u');
  const a = after[0][0];
  console.log('\n打点后数据：transactions=' + a.t + ' contacts=' + a.c + ' purchase_orders=' + a.p + ' promotions=' + a.pr + ' users=' + a.u);
  const dirty = (a.t - b.t) + (a.c - b.c) + (a.p - b.p) + (a.pr - b.pr) + (a.u - b.u);
  console.log(dirty === 0 ? '✓ 审计没有产生任何脏数据' : '⚠ 产生了 ' + dirty + ' 条数据，需要清理');

  const pass = results.filter((r) => r.ok).length;
  console.log('\n================ 汇总 ================');
  console.log('端点审计：' + pass + ' / ' + results.length + ' 通过');
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('不合格项：');
    failed.forEach((r) => console.log('  ✗ ' + r.method.toUpperCase() + ' ' + r.path + '  HTTP ' + r.http + '  code=' + r.code + '  ' + r.msg));
  }
  process.exit(0);
})();
