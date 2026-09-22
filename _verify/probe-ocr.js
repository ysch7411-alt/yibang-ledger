// OCR 模型选型：同一套题、同一套评分，把候选模型全跑一遍
//
// 两个任务分开打分，因为我们要的是两件不同的事：
//   A. 取文（纯 OCR）：把单据文字原样读出来 —— 衡量"认字"能力
//   B. 结构化：直接给 JSON —— 衡量"一边认字一边理解表格"的能力（我们产品实际用的）
//
// 图片是 5 档难度梯度，都是从同一张真值已知的标准送货单生成的：
//   clean 干净高清 / photo 手机翻拍(模糊+1.2°倾斜+重压) / dark 弱光 / far 拍远(800px) / hard 综合最难
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const { callModel, extractJson, toDataUri } = require('/www/wwwroot/yibang-server/lib/ledger');

const UP = '/www/wwwroot/yibang-server/uploads';
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);

/* ---------------- 真值 ---------------- */
const TRUTH_TEXT = [
  '送货单',
  '供货单位：重庆鑫达钢材有限公司',
  '单号：XS-20260919-008　　　日期：2026年9月19日',
  '序号 品名 规格型号 单位 数量 单价 金额',
  '1 螺纹钢 HRB400 12mm 吨 2.5 3800.00 9500.00',
  '2 圆钢 Q235 20mm 吨 1.2 4200.00 5040.00',
  '3 角钢 50×50×5 吨 0.8 3950.00 3160.00',
  '合计 17700.00',
  '备注：货已收到，验收合格。'
].join('\n');

// 取文任务的关键片段：命中率比"整段相似度"更能说明"关键数字有没有读错"
const NEEDLES = [
  '重庆鑫达钢材有限公司', 'XS-20260919-008', '2026年9月19日',
  '螺纹钢', 'HRB400', '2.5', '3800.00', '9500.00',
  '圆钢', 'Q235', '1.2', '4200.00', '5040.00',
  '角钢', '50×50×5', '0.8', '3950.00', '3160.00',
  '17700.00', '吨'
];

const TRUTH_DOC = {
  supplier: '重庆鑫达钢材有限公司', orderNo: 'XS-20260919-008', date: '2026-09-19', total: 17700,
  items: [['螺纹钢', 2.5, 3800, 9500], ['圆钢', 1.2, 4200, 5040], ['角钢', 0.8, 3950, 3160]]
};

const IMAGES = [
  ['clean', 'ocr-clean.jpg', '干净高清 91KB'],
  ['photo', 'ocr-photo.jpg', '手机翻拍 20KB'],
  ['dark', 'ocr-dark.jpg', '弱光 30KB'],
  ['far', 'ocr-far.jpg', '拍远 800px'],
  ['hard', 'ocr-hard.jpg', '综合最难']
];

const OCR_MODELS = [
  'qwen3.5-ocr',
  'qwen-vl-ocr-latest',
  'qwen-vl-ocr-2025-11-20',
  'vanchin/deepseek-ocr',
  'qwen3-vl-flash',
  'qwen3-vl-flash-2026-01-22',
  'qwen3-vl-plus',
  'qwen-vl-max'
];

/* ---------------- 工具 ---------------- */
const uri = (f) => toDataUri(path.join(UP, f), 'jpg', 'image');

function normText(s) {
  return String(s || '')
    .replace(/```[a-z]*/gi, '')
    .replace(/\s+/g, '')
    .replace(/[·・]/g, '')
    .replace(/[×✕xX]/g, '×');
}

// 最长公共子序列占比：容忍插话和少量错字，比"完全相等"更有信息量
function lcsRatio(a, b) {
  const n = a.length, m = b.length;
  if (!n) return 0;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t; cur.fill(0);
  }
  return prev[m] / n;
}

function scoreText(out) {
  const flat = normText(out);
  const hit = NEEDLES.filter((k) => flat.includes(normText(k)));
  const miss = NEEDLES.filter((k) => !flat.includes(normText(k)));
  return { ratio: lcsRatio(normText(TRUTH_TEXT), flat), hits: hit.length, total: NEEDLES.length, miss };
}

function scoreDoc(d) {
  if (!d || typeof d !== 'object') return { ok: 0, bad: ['无 JSON'] };
  const bad = [];
  const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  if (String(d.supplier || '').trim() !== TRUTH_DOC.supplier) bad.push('供应商');
  if (String(d.orderNo || '').trim() !== TRUTH_DOC.orderNo) bad.push('单号');
  if (String(d.date || '').slice(0, 10) !== TRUTH_DOC.date) bad.push('日期');
  if (n(d.total) !== TRUTH_DOC.total) bad.push('合计');
  const its = Array.isArray(d.items) ? d.items : [];
  if (its.length !== 3) bad.push('行数' + its.length);
  TRUTH_DOC.items.forEach((w, i) => {
    const g = its[i] || {};
    const wrong = [];
    if (String(g.name || '').trim() !== w[0]) wrong.push('品名');
    if (n(g.qty) !== w[1]) wrong.push('数量' + g.qty);
    if (n(g.price) !== w[2]) wrong.push('单价' + g.price);
    if (n(g.amount) !== w[3]) wrong.push('金额' + g.amount);
    if (wrong.length) bad.push('第' + (i + 1) + '行:' + wrong.join(','));
  });
  return { ok: bad.length ? 0 : 1, bad };
}

async function ask(model, imgFile, prompt, timeout) {
  const t0 = Date.now();
  try {
    const out = await callModel({
      model,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: uri(imgFile) } }, { type: 'text', text: prompt }] }],
      temperature: 0.1
    }, timeout);
    return { ms: Date.now() - t0, text: out };
  } catch (e) {
    return { ms: Date.now() - t0, err: e.response ? JSON.stringify(e.response.data).slice(0, 70) : String(e.message).slice(0, 70) };
  }
}

const ASK_TEXT = '把这张单据上的所有文字原样读出来，保留每一行的品名、规格、数量、单价、金额，以及单据号、日期、合计。只输出文字，不要解释，不要用 markdown 或 LaTeX 包裹。';

const src = fs.readFileSync('/www/wwwroot/yibang-server/routes/purchase.js', 'utf8');
const DOC_PROMPT = eval('[' + src.match(/const DOC_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/)[1] + "].join('\\n')")
  .replace('__TODAY__', '2026-09-19');

(async () => {
  const rows = [];

  for (const [tag, file, label] of IMAGES) {
    console.log('\n#################### ' + tag + '（' + label + '）####################');

    console.log('--- 任务A：取文（关键片段命中 / 字符相似度 / 耗时）---');
    for (const m of OCR_MODELS) {
      const r = await ask(m, file, ASK_TEXT, 120000);
      let line;
      if (r.err) line = pad('  ' + m, 34) + String(r.ms).padStart(6) + 'ms   ' + (r.err.includes('denied') ? '无权限' : '失败 ' + r.err);
      else {
        const s = scoreText(r.text);
        line = pad('  ' + m, 34) + String(r.ms).padStart(6) + 'ms   命中 ' + s.hits + '/' + s.total +
          '   相似 ' + Math.round(s.ratio * 100) + '%   字数 ' + normText(r.text).length;
        if (s.miss.length) line += '   缺:' + s.miss.slice(0, 4).join(',');
        rows.push({ task: 'A', img: tag, model: m, hits: s.hits, ratio: s.ratio, ms: r.ms });
      }
      console.log(line);
    }

    console.log('--- 任务B：直接出结构化 JSON（字段全对 / 耗时）---');
    for (const m of OCR_MODELS) {
      const r = await ask(m, file, DOC_PROMPT, 120000);
      let line;
      if (r.err) line = pad('  ' + m, 34) + String(r.ms).padStart(6) + 'ms   ' + (r.err.includes('denied') ? '无权限' : '失败 ' + r.err);
      else {
        const d = extractJson(r.text);
        const s = scoreDoc(d);
        line = pad('  ' + m, 34) + String(r.ms).padStart(6) + 'ms   ' +
          (s.ok ? '✓ 全对' : '✗ ' + s.bad.slice(0, 4).join(' | '));
        rows.push({ task: 'B', img: tag, model: m, ok: s.ok, ms: r.ms });
      }
      console.log(line);
    }
  }

  console.log('\n\n================ 汇总 ================');
  console.log('任务A · 取文：平均关键命中率 / 平均字符相似度 / 平均耗时');
  for (const m of OCR_MODELS) {
    const rs = rows.filter((r) => r.task === 'A' && r.model === m);
    if (!rs.length) { console.log('  ' + pad(m, 32) + '  全部失败'); continue; }
    const hit = rs.reduce((s, r) => s + r.hits / 20, 0) / rs.length;
    const sim = rs.reduce((s, r) => s + r.ratio, 0) / rs.length;
    const ms = Math.round(rs.reduce((s, r) => s + r.ms, 0) / rs.length);
    console.log('  ' + pad(m, 32) + '  命中 ' + Math.round(hit * 100) + '%   相似 ' + Math.round(sim * 100) + '%   平均 ' + ms + 'ms');
  }
  console.log('\n任务B · 结构化：逐图是否全对');
  console.log('  ' + pad('模型', 32) + IMAGES.map((i) => pad(i[0], 9)).join('') + ' 通过  平均耗时');
  for (const m of OCR_MODELS) {
    const cells = IMAGES.map((i) => {
      const r = rows.find((x) => x.task === 'B' && x.model === m && x.img === i[0]);
      return pad(r ? (r.ok ? '✓' : '✗') : '—', 9);
    }).join('');
    const rs = rows.filter((r) => r.task === 'B' && r.model === m);
    const pass = rs.filter((r) => r.ok).length;
    const ms = rs.length ? Math.round(rs.reduce((s, r) => s + r.ms, 0) / rs.length) : 0;
    console.log('  ' + pad(m, 32) + cells + pad(pass + '/5', 6) + '  ' + ms + 'ms');
  }
})();
