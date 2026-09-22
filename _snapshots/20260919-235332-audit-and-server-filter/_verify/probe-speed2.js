// OCR / ASR 提速：A/B 对照（准确率不能掉）
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const { callModel, extractJson, toDataUri } = require('/www/wwwroot/yibang-server/lib/ledger');

const UP = '/www/wwwroot/yibang-server/uploads';
const T = () => Date.now();
const pad = (s, n = 38) => (s + ' '.repeat(n)).slice(0, n);

async function run(label, model, content, timeout = 90000) {
  const t0 = T();
  try {
    const out = await callModel({ model, messages: [{ role: 'user', content }], temperature: 0.1 }, timeout);
    return { ms: T() - t0, text: out };
  } catch (e) {
    return { ms: T() - t0, err: e.response ? JSON.stringify(e.response.data).slice(0, 120) : e.message };
  }
}

const uri = (f) => toDataUri(path.join(UP, f), 'jpg', 'image');

/* ============ A/B ① 结构化：同一段真实送货单文字，换模型比准确率 ============ */
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

const DOC_PROMPT = [
  '你是采购单据识别助手。从下面的文字里提取一张采购/送货/磅单的结构化信息。',
  '严格按单据上写的填，看不清或没有的字段一律填空字符串或 null，不要编造。',
  '只输出 JSON：{"supplier":"","orderNo":"","date":"","total":0,"items":[{"name":"","spec":"","unit":"","qty":0,"price":0,"amount":0}]}'
].join('\n');

function score(d) {
  if (!d || !Array.isArray(d.items)) return '解析失败';
  const names = d.items.map((i) => i.name).join('/');
  const ok3 = d.items.length === 3 && names === '螺纹钢/圆钢/角钢';
  const totalOk = Number(d.total) === 17700;
  const supOk = d.supplier === '重庆鑫达钢材有限公司';
  return (ok3 ? '3行✓' : '行数/品名✗(' + d.items.length + ':' + names + ')') +
    ' ' + (totalOk ? '合计✓' : '合计✗(' + d.total + ')') +
    ' ' + (supOk ? '供应商✓' : '供应商✗') +
    ' 规格1=' + (d.items[0] && d.items[0].spec);
}

(async () => {
  console.log('========== A/B ① 文本结构化：换更快的模型，准确率会不会掉 ==========');
  console.log('期望：3 行（螺纹钢/圆钢/角钢）· 合计 17700 · 供应商重庆鑫达钢材有限公司\n');
  for (const m of ['qwen-plus', 'qwen-flash', 'qwen-turbo', 'qwen3.7-flash', 'qwen3.6-flash']) {
    const r = await run('x', m, [{ type: 'text', text: DOC_PROMPT + '\n\n' + DOC }]);
    console.log(pad(m) + String(r.ms).padStart(6) + 'ms   ' +
      (r.err ? '失败: ' + r.err : score(extractJson(r.text))));
  }

  /* ============ A/B ② 图片 OCR：原图 vs 压缩到 1600/1200 ============ */
  console.log('\n========== A/B ② OCR 取文：图片压小会不会明显掉字 ==========');
  const OCR_Q = '这是一张单据。把上面所有文字原样读出来，保留品名、数量、单价、金额、单据号和日期。只输出文字，不要解释，不要用 LaTeX 包裹。';
  const ocrOut = {};
  for (const f of ['1789807771796-xh7fd.jpg', '__small_1600.jpg', '__small_1200.jpg']) {
    const size = Math.round(fs.statSync(path.join(UP, f)).size / 1024);
    const r = await run('x', 'qwen3.5-ocr', [{ type: 'image_url', image_url: { url: uri(f) } }, { type: 'text', text: OCR_Q }], 120000);
    const txt = String(r.text || '').replace(/\s+/g, '');
    ocrOut[f] = txt;
    console.log(pad(f, 32) + String(size).padStart(5) + 'KB  ' + String(r.ms).padStart(6) + 'ms  字数 ' +
      txt.length + (r.err ? '  失败:' + r.err : ''));
  }
  const base = ocrOut['1789807771796-xh7fd.jpg'] || '';
  for (const f of ['__small_1600.jpg', '__small_1200.jpg']) {
    const cur = ocrOut[f] || '';
    const keep = base ? Math.round((cur.length / base.length) * 100) : 0;
    console.log('  → ' + f + ' 字数保留 ' + keep + '%');
  }

  /* ============ A/B ③ 单次「看图→JSON」：省掉第二次模型调用 ============ */
  console.log('\n========== A/B ③ 单次看图直接出 JSON（当前是 OCR+结构化两次串行）==========');
  const VL_Q = '这是一张采购/送货单据的图片。直接输出 JSON：{"supplier":"","orderNo":"","date":"YYYY-MM-DD","total":0,"items":[{"name":"","spec":"","unit":"","qty":0,"price":0,"amount":0}]}。看不清或没有的字段填空字符串或 0，不要编造，只输出 JSON。';
  for (const f of ['1789807771796-xh7fd.jpg', '__small_1600.jpg', '__small_1200.jpg']) {
    const size = Math.round(fs.statSync(path.join(UP, f)).size / 1024);
    for (const m of ['qwen-vl-plus', 'qwen3-vl-flash', 'qwen3-vl-flash-2026-01-22', 'qwen3-vl-plus', 'qwen-vl-ocr-latest']) {
      const r = await run('x', m, [{ type: 'image_url', image_url: { url: uri(f) } }, { type: 'text', text: VL_Q }], 90000);
      const j = r.err ? null : extractJson(r.text);
      const brief = r.err ? '失败:' + r.err
        : (j ? 'supplier=' + JSON.stringify(j.supplier) + ' items=' + (j.items ? j.items.length : '?') + ' 可解析✓' : 'JSON 解析失败');
      console.log(pad(f.replace('1789807771796-xh7fd.jpg', '原图').replace('__small_', '').replace('.jpg', ''), 10) +
        String(size).padStart(5) + 'KB  ' + pad(m, 26) + String(r.ms).padStart(6) + 'ms   ' + brief);
    }
  }
})();
