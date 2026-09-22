// 成本对比的第一步：把「每次调用实际烧多少 token」量出来。
// token 数取决于图片像素，所以必须用真实照片测，不能用估算。
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const BASE = process.env.DASHSCOPE_BASE_URL;
const KEY = process.env.DASHSCOPE_API_KEY;
const UP = '/www/wwwroot/yibang-server/uploads';
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);

const IMG = process.argv[2] || '1789807771796-xh7fd.jpg';   // 真机那张 555K 照片
const IMG2 = process.argv[3] || '1789807760252-z71a9k.mp3';

function toDataUri(p, mime) {
  return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
}

async function post(body, timeout = 120000) {
  const t0 = Date.now();
  const r = await axios.post(BASE + '/chat/completions', body, {
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, timeout
  });
  return { ms: Date.now() - t0, data: r.data };
}

const DOC_PROMPT = '你是采购单据识别助手。从下面提供的单据里提取结构化信息。严格按单据上写的填，看不清或没有的字段一律填空字符串或 null，不要编造。字段：supplier 供应商；orderNo 单据号；date YYYY-MM-DD；items 明细数组每行含 name/spec/unit/qty/price/amount；total 合计。只输出 JSON。';

const VL_MODELS = [
  'qwen3-vl-flash',
  'qwen3-vl-flash-2026-01-22',
  'qwen-vl-ocr-latest',
  'qwen-vl-ocr-2025-11-20',
  'qwen3.5-ocr',
  'qwen-vl-plus',
  'qwen3-vl-plus',
  'qwen-vl-max'
];

(async () => {
  const size = Math.round(fs.statSync(path.join(UP, IMG)).size / 1024);
  console.log('测试图：' + IMG + '（' + size + 'KB）');
  console.log('');

  console.log('=========== 图片 → JSON（产品实际用法）===========');
  console.log('  ' + pad('模型', 30) + pad('用时', 10) + pad('输入tok', 10) + pad('输出tok', 10));
  const imgUsage = {};
  for (const m of VL_MODELS) {
    try {
      const r = await post({
        model: m,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: toDataUri(path.join(UP, IMG), 'image/jpeg') } },
          { type: 'text', text: DOC_PROMPT }
        ]}],
        temperature: 0.1
      });
      const u = (r.data && r.data.usage) || {};
      imgUsage[m] = u;
      console.log('  ' + pad(m, 30) + pad(r.ms + 'ms', 10) + pad(u.prompt_tokens ?? '?', 10) + pad(u.completion_tokens ?? '?', 10));
    } catch (e) {
      const d = e.response ? JSON.stringify(e.response.data).slice(0, 90) : e.message;
      console.log('  ' + pad(m, 30) + '失败 ' + d);
    }
  }

  console.log('\n=========== 语音转写 ============');
  const aFmt = IMG2.split('.').pop();
  try {
    const r = await post({
      model: 'qwen3-asr-flash-2026-02-10',
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: toDataUri(path.join(UP, IMG2), 'audio/mpeg'), format: aFmt } }] }]
    });
    console.log('  ' + pad('qwen3-asr-flash', 30) + pad(r.ms + 'ms', 10) + 'usage=' + JSON.stringify(r.data.usage || {}));
  } catch (e) {
    console.log('  失败 ' + (e.response ? JSON.stringify(e.response.data).slice(0, 90) : e.message));
  }

  console.log('\n=========== 文本结构化 ============');
  const SAMPLE = '送货单 供货单位：重庆鑫达钢材有限公司 单号：XS-20260919-008 日期：2026年9月19日 1 螺纹钢 HRB400 12mm 吨 2.5 3800.00 9500.00 2 圆钢 Q235 20mm 吨 1.2 4200.00 5040.00 3 角钢 50×50×5 吨 0.8 3950.00 3160.00 合计 17700.00';
  for (const m of ['qwen-flash', 'qwen-plus', 'qwen-turbo', 'qwen3.6-flash']) {
    try {
      const r = await post({
        model: m,
        messages: [{ role: 'system', content: DOC_PROMPT }, { role: 'user', content: SAMPLE }],
        temperature: 0.1
      }, 60000);
      const u = r.data.usage || {};
      console.log('  ' + pad(m, 30) + pad(r.ms + 'ms', 10) + 'in=' + pad(u.prompt_tokens ?? '?', 8) + 'out=' + pad(u.completion_tokens ?? '?', 8));
    } catch (e) {
      console.log('  ' + pad(m, 30) + '失败 ' + (e.response ? JSON.stringify(e.response.data).slice(0, 80) : e.message));
    }
  }

  console.log('\n=========== 网关有没有暴露价格 ============');
  for (const p of ['/models', '/pricing', '/price', '/model/pricing', '/models/pricing']) {
    try {
      const r = await axios.get(BASE + p, { headers: { Authorization: 'Bearer ' + KEY }, timeout: 20000 });
      const body = JSON.stringify(r.data);
      console.log('  ' + pad(p, 20) + 'HTTP ' + r.status + '  长度 ' + body.length + '  片段 ' + body.slice(0, 140));
    } catch (e) {
      console.log('  ' + pad(p, 20) + (e.response ? 'HTTP ' + e.response.status : 'ERR ' + e.message));
    }
  }

  // 看看 /models 单条记录里有没有价格字段
  try {
    const r = await axios.get(BASE + '/models', { headers: { Authorization: 'Bearer ' + KEY }, timeout: 30000 });
    const list = (r.data && r.data.data) || [];
    const one = list.find((m) => m.id === 'qwen3-vl-flash') || list[0];
    console.log('\n  /models 单条记录字段: ' + Object.keys(one || {}).join(', '));
    console.log('  样例: ' + JSON.stringify(one).slice(0, 300));
  } catch (e) { /* 上面已经报过 */ }
})();
