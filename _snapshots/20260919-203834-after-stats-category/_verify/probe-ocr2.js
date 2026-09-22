// 复测：① 快路两个候选定胜负 ② 把「OCR取文+文本结构化」这条慢路拉进来公平对比
//          ③ 缩尺寸梯度（能不能靠缩小图片省上传时间）
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const { callModel, extractJson, toDataUri, cleanOcrText } = require('/www/wwwroot/yibang-server/lib/ledger');

const UP = '/www/wwwroot/yibang-server/uploads';
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
const uri = (f) => toDataUri(path.join(UP, f), 'jpg', 'image');

const src = fs.readFileSync('/www/wwwroot/yibang-server/routes/purchase.js', 'utf8');
const DOC = eval('[' + src.match(/const DOC_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/)[1] + "].join('\\n')").replace('__TODAY__', '2026-09-19');
const DOC_TEXT = DOC.replace('从下面提供的单据里（可能是一段文字，也可能是一张单据图片）提取', '从下面的文字里提取');

const TRUTH = {
  supplier: '重庆鑫达钢材有限公司', orderNo: 'XS-20260919-008', date: '2026-09-19', total: 17700,
  items: [['螺纹钢', 2.5, 3800, 9500], ['圆钢', 1.2, 4200, 5040], ['角钢', 0.8, 3950, 3160]]
};
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function judge(d) {
  if (!d || typeof d !== 'object') return { pass: 0, bad: '无 JSON' };
  const bad = [];
  if (String(d.supplier || '').trim() !== TRUTH.supplier) bad.push('供应商');
  if (String(d.orderNo || '').trim() !== TRUTH.orderNo) bad.push('单号');
  if (String(d.date || '').slice(0, 10) !== TRUTH.date) bad.push('日期');
  if (n(d.total) !== TRUTH.total) bad.push('合计' + d.total);
  const its = Array.isArray(d.items) ? d.items : [];
  if (its.length !== 3) bad.push('行数' + its.length);
  TRUTH.items.forEach((w, i) => {
    const g = its[i] || {};
    const w2 = [];
    if (String(g.name || '').trim() !== w[0]) w2.push('品名');
    if (n(g.qty) !== w[1]) w2.push('量' + g.qty);
    if (n(g.price) !== w[2]) w2.push('价' + g.price);
    if (n(g.amount) !== w[3]) w2.push('额' + g.amount);
    if (w2.length) bad.push('行' + (i + 1) + ':' + w2.join('/'));
  });
  return { pass: bad.length ? 0 : 1, bad: bad.join(' ') };
}

async function call1(model, prompt, imgFile, timeout = 120000) {
  const t0 = Date.now();
  try {
    const content = prompt
      ? [{ type: 'image_url', image_url: { url: uri(imgFile) } }, { type: 'text', text: prompt }]
      : [{ type: 'image_url', image_url: { url: uri(imgFile) } }];
    const out = await callModel({ model, messages: [{ role: 'user', content }], temperature: 0.1 }, timeout);
    return { ms: Date.now() - t0, text: out };
  } catch (e) {
    return { ms: Date.now() - t0, err: e.response ? JSON.stringify(e.response.data).slice(0, 60) : String(e.message).slice(0, 60) };
  }
}

/** 快路：一次看图出 JSON */
async function fastPath(model, imgFile) {
  const r = await call1(model, DOC, imgFile);
  if (r.err) return { ms: r.ms, err: r.err };
  return { ms: r.ms, doc: extractJson(r.text), raw: r.text };
}

/** 慢路：先取文，再文本结构化 */
async function slowPath(imgFile) {
  const t0 = Date.now();
  const ocr = await call1('qwen3.5-ocr', '把这张单据上的所有文字和表格原样读出来，保留品名、规格、数量、单价、金额、单据号、日期、合计。只输出文字，不要解释，不要用 LaTeX 或 markdown 包裹。', imgFile);
  if (ocr.err) return { ms: Date.now() - t0, err: '取文失败 ' + ocr.err };
  const content = cleanOcrText(ocr.text);
  const t1 = Date.now();
  try {
    const out = await callModel({
      model: 'qwen-flash',
      messages: [{ role: 'system', content: DOC_TEXT }, { role: 'user', content }],
      temperature: 0.1
    }, 60000);
    return { ms: Date.now() - t0, ocrMs: t1 - t0, doc: extractJson(out) };
  } catch (e) {
    return { ms: Date.now() - t0, err: '结构化失败' };
  }
}

const PATHS = [
  ['快路 qwen3-vl-flash', (f) => fastPath('qwen3-vl-flash', f)],
  ['快路 qwen3-vl-flash-2026-01-22', (f) => fastPath('qwen3-vl-flash-2026-01-22', f)],
  ['慢路 qwen3.5-ocr+qwen-flash', (f) => slowPath(f)]
];

const IMAGES = [
  ['clean', 'ocr-clean.jpg'], ['photo', 'ocr-photo.jpg'], ['dark', 'ocr-dark.jpg'],
  ['far', 'ocr-far.jpg'], ['hard', 'ocr-hard.jpg']
];

(async () => {
  console.log('=========== 第一部分：两条路公平对比（每格跑 2 轮）===========');
  const acc = {};
  PATHS.forEach(([name]) => { acc[name] = { pass: 0, total: 0, ms: [] }; });

  for (const [tag, file] of IMAGES) {
    console.log('\n---- 图片: ' + tag + ' ----');
    for (const [name, run] of PATHS) {
      for (let round = 1; round <= 2; round++) {
        const r = await run(file);
        acc[name].total++;
        let verdict;
        if (r.err) verdict = '✗ ' + r.err;
        else {
          const j = judge(r.doc);
          if (j.pass) acc[name].pass++;
          verdict = j.pass ? '✓ 全对' : '✗ ' + j.bad;
        }
        acc[name].ms.push(r.ms);
        console.log('  ' + pad(name, 34) + '轮' + round + '  ' + String(r.ms).padStart(6) + 'ms  ' + verdict);
      }
    }
  }

  console.log('\n---- 通过率与耗时 ----');
  for (const [name] of PATHS) {
    const a = acc[name];
    const ms = a.ms.length ? Math.round(a.ms.reduce((s, v) => s + v, 0) / a.ms.length) : 0;
    console.log('  ' + pad(name, 34) + '  通过 ' + a.pass + '/' + a.total + '   平均 ' + ms + 'ms');
  }

  /* ---------- 第二部分：缩尺寸梯度 ---------- */
  console.log('\n\n=========== 第二部分：图片缩到多小就不认得了（干净图，只缩尺寸）===========');
  console.log('  ' + pad('宽度/体积', 22) + pad('快路 qwen3-vl-flash', 26) + pad('慢路 OCR+flash', 26));
  for (const w of [1654, 1400, 1200, 1000, 800]) {
    const file = 'sc' + w + '.jpg';
    const sizeKB = Math.round(fs.statSync(path.join(UP, file)).size / 1024);
    const colA = [];
    const colB = [];
    for (let round = 1; round <= 2; round++) {
      const a = await fastPath('qwen3-vl-flash', file);
      colA.push(a.err ? '✗' : (judge(a.doc).pass ? '✓' : '✗'));
      const b = await slowPath(file);
      colB.push(b.err ? '✗' : (judge(b.doc).pass ? '✓' : '✗'));
    }
    console.log('  ' + pad(w + 'px / ' + sizeKB + 'KB', 22) +
      pad(colA.join(' '), 26) + pad(colB.join(' '), 26));
  }
})();
