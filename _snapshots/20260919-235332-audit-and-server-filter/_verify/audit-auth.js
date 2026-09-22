// 越权扫描：所有需要登录的接口，在「不带 token」时必须回 401。
// 任何一个能读到数据的接口都是生产事故级漏洞（多商家 SaaS 尤其致命）。
const axios = require('axios');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const BASE = 'http://127.0.0.1:3000/api';
const NOAUTH = { 'Content-Type': 'application/json' };

// [method, path, body]  —— 全部是"应该需要登录"的接口
const CASES = [
  ['get', '/user/info'],
  ['post', '/user/bind-phone', { code: 'x' }],
  ['post', '/user/delete-account', { confirm: 'DELETE' }],
  ['get', '/record/list'],
  ['get', '/record/daily-summary?date=2026-09-19'],
  ['get', '/record/month-summary?month=2026-09'],
  ['post', '/record/ai-parse', { text: '收张老板5000' }],
  ['post', '/record/create', { amount: 1, type: 1 }],
  ['post', '/record/update', { id: 1, amount: 2 }],
  ['post', '/record/delete', { id: 1 }],
  ['get', '/contact/list'],
  ['get', '/contact/summary'],
  ['get', '/contact/detail?id=1'],
  ['post', '/contact/create', { name: 'x' }],
  ['post', '/ai/asr', { fileUrl: '/uploads/x.mp3' }],
  ['post', '/ai/ocr-parse', { fileUrl: '/uploads/x.jpg' }],
  ['post', '/ai/chat', { question: '这个月赚了多少' }],
  ['post', '/purchase/parse-doc', { text: '螺纹钢 2吨 3800 一吨' }],
  ['post', '/purchase/save', { items: [{ name: 'x', amount: 1 }] }],
  ['get', '/purchase/list'],
  ['get', '/purchase/detail?id=1'],
  ['get', '/file/list'],
  ['post', '/file/upload', {}],
  ['get', '/staff/list'],
  ['get', '/staff/pending'],
  ['post', '/staff/approve', { id: 1, status: 1 }],
  ['get', '/memory/info'],
  ['get', '/promote/info'],
  ['post', '/promote/bind', { inviterId: 1 }],
  ['post', '/share/create', { type: 1 }]
];

(async () => {
  const leak = [];
  const pass = [];
  for (const [method, path, body] of CASES) {
    const cfg = { method, url: BASE + path, headers: NOAUTH, timeout: 20000, validateStatus: () => true };
    if (method !== 'get' && body !== undefined) cfg.data = body;
    let code;
    try {
      const r = await axios(cfg);
      code = r.data && r.data.code;
    } catch (e) {
      code = e.response && e.response.data ? e.response.data.code : 'ERR';
    }
    const ok = code === 401;
    (ok ? pass : leak).push({ method, path, code });
    console.log('  ' + (ok ? '✓ 401' : '✗ ' + code + ' ') + '  ' + method.toUpperCase() + ' ' + path);
  }

  console.log('\n================ 越权扫描汇总 ================');
  console.log('需要登录的接口 ' + CASES.length + ' 个 · 正确拒绝 ' + pass.length + ' 个 · **可未授权访问 ' + leak.length + ' 个**');
  if (leak.length) {
    console.log('\n⚠️ 以下接口没有鉴权就能访问，必须修：');
    leak.forEach((l) => console.log('  ✗ ' + l.method.toUpperCase() + ' ' + l.path + '  → 返回 code=' + l.code));
  } else {
    console.log('✓ 全部正确返回 401');
  }
})();
