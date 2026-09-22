// 快路候选模型复测：看稳定性和波动，别用一个样本下结论
const fs = require('fs');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const { callModel, extractJson, toDataUri } = require('/www/wwwroot/yibang-server/lib/ledger');

const FILE = '/www/wwwroot/yibang-server/uploads/delivery-note.jpg';
const TODAY = '2026-09-19';
const URI = toDataUri(FILE, 'jpg', 'image');

const src = fs.readFileSync('/www/wwwroot/yibang-server/routes/purchase.js', 'utf8');
const DOC = eval('[' + src.match(/const DOC_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/)[1] + "].join('\\n')").replace('__TODAY__', TODAY);

const TRUTH = { supplier: '重庆鑫达钢材有限公司', orderNo: 'XS-20260919-008', date: '2026-09-19', total: 17700 };
const WANT_ITEMS = [['螺纹钢', 2.5, 3800, 9500], ['圆钢', 1.2, 4200, 5040], ['角钢', 0.8, 3950, 3160]];
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function judge(d) {
  if (!d) return 'JSON解析失败';
  const bad = [];
  if (String(d.supplier || '').trim() !== TRUTH.supplier) bad.push('供应商');
  if (String(d.orderNo || '').trim() !== TRUTH.orderNo) bad.push('单号');
  if (String(d.date || '').slice(0, 10) !== TRUTH.date) bad.push('日期');
  if (n(d.total) !== TRUTH.total) bad.push('合计');
  const its = Array.isArray(d.items) ? d.items : [];
  if (its.length !== 3) bad.push('行数' + its.length);
  WANT_ITEMS.forEach((w, i) => {
    const g = its[i] || {};
    if (String(g.name || '').trim() !== w[0] || n(g.qty) !== w[1] || n(g.price) !== w[2] || n(g.amount) !== w[3]) bad.push('第' + (i + 1) + '行');
  });
  return bad.length ? '✗ ' + bad.join('/') : '✓ 全对';
}

const CANDIDATES = ['qwen3-vl-flash', 'qwen-vl-ocr-latest', 'qwen3-vl-flash-2026-01-22', 'qwen-vl-plus'];
const ROUNDS = 3;

(async () => {
  const tally = {};
  for (const m of CANDIDATES) tally[m] = { ok: 0, times: [], notes: [] };

  for (let r = 1; r <= ROUNDS; r++) {
    console.log('--- 第 ' + r + ' 轮 ---');
    for (const m of CANDIDATES) {
      const t0 = Date.now();
      let j = null, err = '';
      try {
        const out = await callModel({
          model: m,
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: URI } }, { type: 'text', text: DOC }] }],
          temperature: 0.1
        }, 90000);
        j = extractJson(out);
      } catch (e) {
        err = e.response ? JSON.stringify(e.response.data).slice(0, 60) : e.message;
      }
      const took = Date.now() - t0;
      tally[m].times.push(took);
      const v = err ? '调用失败 ' + err : judge(j);
      if (v === '✓ 全对') tally[m].ok++;
      else tally[m].notes.push(v);
      console.log('  ' + (m + '                        ').slice(0, 26) + String(took).padStart(6) + 'ms  ' + v);
    }
  }

  console.log('\n================ 汇总（' + ROUNDS + ' 轮）================');
  for (const m of CANDIDATES) {
    const t = tally[m].times;
    console.log((m + '                        ').slice(0, 26) +
      '正确 ' + tally[m].ok + '/' + ROUNDS +
      '   最快 ' + Math.min(...t) + 'ms   最慢 ' + Math.max(...t) + 'ms   平均 ' + Math.round(t.reduce((a, b) => a + b, 0) / t.length) + 'ms' +
      (tally[m].notes.length ? '   ' + tally[m].notes.join(' | ') : ''));
  }
})();
