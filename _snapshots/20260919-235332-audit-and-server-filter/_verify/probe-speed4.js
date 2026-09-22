// 采购单识别提速：快路（视觉一次调用）vs 慢路（OCR + 文本结构化）实测对照
// 测试图：_verify/make-note-image.js 生成的标准送货单，真值已知，可逐字段判对错。
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const { callModel, extractJson, toDataUri, cleanOcrText } = require('/www/wwwroot/yibang-server/lib/ledger');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 1800 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const IMG = '/uploads/delivery-note.jpg';
const FILE = '/www/wwwroot/yibang-server/uploads/delivery-note.jpg';
const TODAY = '2026-09-19';
const pad = (s, n = 26) => (s + ' '.repeat(n)).slice(0, n);

// 真值
const TRUTH = {
  supplier: '重庆鑫达钢材有限公司',
  orderNo: 'XS-20260919-008',
  date: '2026-09-19',
  total: 17700,
  items: [
    { name: '螺纹钢', spec: 'HRB400 12mm', unit: '吨', qty: 2.5, price: 3800, amount: 9500 },
    { name: '圆钢', spec: 'Q235 20mm', unit: '吨', qty: 1.2, price: 4200, amount: 5040 },
    { name: '角钢', spec: '50×50×5', unit: '吨', qty: 0.8, price: 3950, amount: 3160 }
  ]
};

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function judge(d) {
  const bad = [];
  if (!d) return ['没有结果'];
  if (String(d.supplier || '').trim() !== TRUTH.supplier) bad.push('供应商=' + JSON.stringify(d.supplier));
  if (String(d.orderNo || '').trim() !== TRUTH.orderNo) bad.push('单号=' + JSON.stringify(d.orderNo));
  if (String(d.date || '').slice(0, 10) !== TRUTH.date) bad.push('日期=' + d.date);
  if (n(d.total) !== TRUTH.total) bad.push('合计=' + d.total);
  const its = Array.isArray(d.items) ? d.items : [];
  if (its.length !== 3) bad.push('明细行数=' + its.length);
  TRUTH.items.forEach((w, i) => {
    const g = its[i] || {};
    if (String(g.name || '').trim() !== w.name) bad.push('第' + (i + 1) + '行品名=' + JSON.stringify(g.name));
    if (n(g.qty) !== w.qty) bad.push('第' + (i + 1) + '行数量=' + g.qty);
    if (n(g.price) !== w.price) bad.push('第' + (i + 1) + '行单价=' + g.price);
    if (n(g.amount) !== w.amount) bad.push('第' + (i + 1) + '行金额=' + g.amount);
    if (w.spec && String(g.spec || '').replace(/\s/g, '') !== w.spec.replace(/\s/g, '')) bad.push('第' + (i + 1) + '行规格=' + JSON.stringify(g.spec));
    if (w.unit && String(g.unit || '').trim() !== w.unit) bad.push('第' + (i + 1) + '行单位=' + JSON.stringify(g.unit));
  });
  return bad;
}

const URI = toDataUri(FILE, 'jpg', 'image');
const DOC_PROMPT = require('fs').readFileSync('/www/wwwroot/yibang-server/routes/purchase.js', 'utf8')
  .match(/const DOC_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/);
const DOC = eval('[' + DOC_PROMPT[1] + "].join('\\n')").replace('__TODAY__', TODAY);

async function direct(label, model, content, timeout = 120000) {
  const t0 = Date.now();
  try {
    const out = await callModel({ model, messages: [{ role: 'user', content }], temperature: 0.1 }, timeout);
    return { ms: Date.now() - t0, text: out };
  } catch (e) {
    return { ms: Date.now() - t0, err: e.response ? JSON.stringify(e.response.data).slice(0, 120) : e.message };
  }
}

(async () => {
  console.log('测试图：标准送货单 1654×2339，真值 3 行明细 / 合计 17700 / 供应商 重庆鑫达钢材有限公司\n');

  /* ---------- A. 走真实接口（新代码的快路） ---------- */
  console.log('========== A. 真实接口 POST /purchase/parse-doc（现在走快路）==========');
  {
    const t0 = Date.now();
    const r = await axios.post(BASE + '/purchase/parse-doc', { fileUrl: IMG }, { headers: H, timeout: 120000 }).then((x) => x.data).catch((e) => ({ code: -1, msg: String(e.message) }));
    const took = Date.now() - t0;
    if (r.code !== 0) {
      console.log('  失败 code=' + r.code + ' msg=' + r.msg);
    } else {
      const bad = judge(r.data);
      console.log('  用时 ' + took + 'ms（含 HTTP）');
      console.log('  结果: 供应商=' + JSON.stringify(r.data.supplier) + ' 单号=' + r.data.orderNo + ' 日期=' + r.data.date + ' 合计=' + r.data.total + ' 明细=' + (r.data.items || []).length + ' 行');
      (r.data.items || []).forEach((it, i) => console.log('    ' + (i + 1) + '. ' + it.name + ' | ' + it.spec + ' | ' + it.unit + ' | ' + it.qty + ' × ' + it.price + ' = ' + it.amount));
      console.log('  判定: ' + (bad.length ? '✗ ' + bad.join('  ') : '✓ 全对'));
    }
  }

  /* ---------- B. 快路单次视觉调用（多个模型） ---------- */
  console.log('\n========== B. 快路：视觉模型一次调用直接出 JSON ==========');
  for (const m of ['qwen3-vl-flash', 'qwen3-vl-flash-2026-01-22', 'qwen-vl-max', 'qwen-vl-ocr-latest']) {
    const r = await direct('x', m, [
      { type: 'image_url', image_url: { url: URI } },
      { type: 'text', text: DOC }
    ], 90000);
    const d = r.err ? null : extractJson(r.text);
    const g = d ? { supplier: d.supplier, orderNo: d.orderNo, date: d.date, total: d.total, items: d.items } : null;
    const bad = r.err ? ['调用失败 ' + r.err] : judge(g);
    console.log('  ' + pad(m) + String(r.ms).padStart(6) + 'ms  ' + (bad.length ? '✗ ' + bad.slice(0, 3).join(' ') : '✓ 全对'));
  }

  /* ---------- C. 慢路：OCR 取文 + 文本结构化 ---------- */
  console.log('\n========== C. 慢路：OCR 取文 → 文本结构化 ==========');
  const OCR_Q = '这是一张采购/送货单据。把上面所有文字和表格原样读出来，保留每一行的品名、规格、数量、单价、金额，以及单据号和日期。只输出文字，不要解释，不要用 LaTeX 公式包裹。';
  for (const ocrModel of ['qwen3.5-ocr', 'qwen-vl-ocr-latest', 'qwen3-vl-flash']) {
    const t0 = Date.now();
    const ocr = await direct('x', ocrModel, [
      { type: 'image_url', image_url: { url: URI } },
      { type: 'text', text: OCR_Q }
    ], 120000);
    const ocrMs = Date.now() - t0;
    if (ocr.err) { console.log('  ' + pad(ocrModel + ' 取文') + String(ocrMs).padStart(6) + 'ms  失败: ' + ocr.err); continue; }
    const content = cleanOcrText(ocr.text);
    console.log('  ' + pad(ocrModel + ' 取文') + String(ocrMs).padStart(6) + 'ms  取到 ' + content.replace(/\s/g, '').length + ' 字');
    for (const structModel of ['qwen-flash', 'qwen-plus']) {
      const s0 = Date.now();
      const st = await direct('x', structModel, [
        { type: 'text', text: DOC.replace('从下面提供的单据里（可能是一段文字，也可能是一张单据图片）提取', '从下面的文字里提取') + '\n\n' + content }
      ], 60000);
      const sMs = Date.now() - s0;
      const d = st.err ? null : extractJson(st.text);
      const bad = st.err ? ['结构化失败'] : judge(d);
      console.log('      ├ ' + pad(structModel, 14) + String(sMs).padStart(6) + 'ms  ' +
        (bad.length ? '✗ ' + bad.slice(0, 3).join(' ') : '✓ 全对') +
        '   合计两步 ' + (ocrMs + sMs) + 'ms');
    }
  }

  /* ---------- D. 纯文字入口（语音/打字那条链的归类） ---------- */
  console.log('\n========== D. 对照：文字入口（无 OCR）==========');
  for (const m of ['qwen-flash', 'qwen-plus']) {
    const t0 = Date.now();
    const r = await axios.post(BASE + '/purchase/parse-doc', { text: '螺纹钢 HRB400 12mm 2.5吨 3800元一吨' }, { headers: H, timeout: 60000 }).then((x) => x.data).catch(() => ({ code: -1 }));
    console.log('  ' + pad('接口/model=' + m) + String(Date.now() - t0).padStart(6) + 'ms  code=' + r.code + ' items=' + ((r.data && r.data.items) || []).length);
  }
})();
