// 线上后端功能验证：用真实 token 打全部新接口
const axios = require('/www/wwwroot/yibang-server/node_modules/axios');
const jwt = require('/www/wwwroot/yibang-server/node_modules/jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  → ' + detail); }
}

(async () => {
  // 1. 本月汇总
  console.log('\n=== /record/month-summary ===');
  try {
    const m = new Date().toISOString().slice(0, 7);
    const r = await axios.get(BASE + '/record/month-summary?month=' + m, { headers: H });
    ok('本月汇总', r.data.code === 0, JSON.stringify(r.data.data));
  } catch (e) { ok('本月汇总', false, e.message); }

  // 2. 往来详情
  console.log('\n=== /contact/detail ===');
  let contactId = null;
  try {
    const cl = await axios.get(BASE + '/contact/list', { headers: H });
    contactId = cl.data.data[0] && cl.data.data[0].id;
    const r = await axios.get(BASE + '/contact/detail?id=' + contactId, { headers: H });
    ok('往来详情', r.data.code === 0 && !!r.data.data.contact,
      r.data.data.contact.name + ' 余额 ' + r.data.data.contact.balance + '，明细 ' + r.data.data.records.length + ' 条');
  } catch (e) { ok('往来详情', false, e.message); }

  // 3. 推广信息
  console.log('\n=== /promote/info ===');
  try {
    const r = await axios.get(BASE + '/promote/info', { headers: H });
    ok('推广信息', r.data.code === 0, JSON.stringify(r.data.data).slice(0, 120));
  } catch (e) { ok('推广信息', false, e.message); }

  // 4. AI 多笔解析
  console.log('\n=== /record/ai-parse 多笔 ===');
  try {
    const r = await axios.post(BASE + '/record/ai-parse',
      { text: '昨天收张老板5000块货款，今天买菜花了320，还欠李四800块' },
      { headers: H, timeout: 60000 });
    const recs = r.data.data && r.data.data.records || [];
    ok('一句话多笔', r.data.code === 0 && recs.length >= 2,
      recs.length + ' 笔: ' + recs.map((x) => x.type + x.amount + (x.contact ? '/' + x.contact : '') + '@' + x.date).join(' | '));
  } catch (e) { ok('一句话多笔', false, (e.response && JSON.stringify(e.response.data)) || e.message); }

  // 5. OCR
  console.log('\n=== /ai/ocr-parse ===');
  try {
    const r = await axios.post(BASE + '/ai/ocr-parse', { fileUrl: '/uploads/probe.jpg' }, { headers: H, timeout: 120000 });
    ok('图片取文', r.data.code === 0 && (r.data.data.text || '').length > 10,
      JSON.stringify(r.data.data.text || r.data.msg).slice(0, 110));
  } catch (e) { ok('图片取文', false, (e.response && JSON.stringify(e.response.data)) || e.message); }

  // 6. ASR
  console.log('\n=== /ai/asr ===');
  const fs = require('fs');
  const upDir = process.env.UPLOAD_DIR;
  const mp3 = fs.readdirSync(upDir).filter((f) => f.endsWith('.mp3')).sort().pop();
  try {
    const r = await axios.post(BASE + '/ai/asr', { fileUrl: '/uploads/' + mp3 }, { headers: H, timeout: 120000 });
    ok('语音转文字', r.data.code === 0, '文件 ' + mp3 + ' → ' + JSON.stringify(r.data.data && r.data.data.text || r.data.msg).slice(0, 90));
  } catch (e) { ok('语音转文字', false, (e.response && JSON.stringify(e.response.data)) || e.message); }

  // 7. 建 → 改 → 删（含余额联动）
  console.log('\n=== /record/create → update → delete（往来余额联动）===');
  let newId = null;
  try {
    const c = await axios.post(BASE + '/record/create',
      { type: 3, amount: 1000, content: '测试应收', contact_name: '测试客户A' }, { headers: H });
    newId = c.data.data.id;
    const cid = c.data.data.contact_id;
    ok('新建应收 1000 并建档', c.data.code === 0 && !!cid, '余额=' + c.data.data.balance + '（应 1000）');

    const u = await axios.post(BASE + '/record/update', { id: newId, amount: 1500 }, { headers: H });
    const ck = await axios.get(BASE + '/contact/detail?id=' + cid, { headers: H });
    ok('改成 1500 后余额联动', u.data.code === 0 && Number(ck.data.data.contact.balance) === 1500,
      '余额=' + ck.data.data.contact.balance + '（应 1500）');

    const d = await axios.post(BASE + '/record/delete', { id: newId }, { headers: H });
    const ck2 = await axios.get(BASE + '/contact/detail?id=' + cid, { headers: H });
    ok('删除后余额归零', d.data.code === 0 && Number(ck2.data.data.contact.balance) === 0,
      '余额=' + ck2.data.data.contact.balance + '（应 0）');

    const d2 = await axios.post(BASE + '/record/delete', { id: newId }, { headers: H });
    ok('重复删除被拒', d2.data.code !== 0, d2.data.msg);
  } catch (e) { ok('增删改链路', false, (e.response && JSON.stringify(e.response.data)) || e.message); }

  // 8. AI 问答
  console.log('\n=== /ai/chat ===');
  try {
    const r = await axios.post(BASE + '/ai/chat', { question: '我最近生意怎么样？' }, { headers: H, timeout: 60000 });
    ok('AI 问答', r.data.code === 0 && (r.data.data.answer || '').length > 5,
      JSON.stringify(r.data.data && r.data.data.answer || r.data.msg).slice(0, 130));
  } catch (e) { ok('AI 问答', false, (e.response && JSON.stringify(e.response.data)) || e.message); }

  console.log('\n================ 通过 ' + pass + ' / 失败 ' + fail + ' ================');
  process.exit(fail ? 1 : 0);
})();
