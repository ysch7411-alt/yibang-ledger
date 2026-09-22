// OCR / ASR 提速：先把每个环节的耗时量出来，再看网关有哪些更快的模型可选
const fs = require('fs');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const { callModel, toDataUri, detectKind, resolveUpload } = require('/www/wwwroot/yibang-server/lib/ledger');

const T = () => Date.now();
const ms = (t0) => (Date.now() - t0) + 'ms';

const AUDIO = '/uploads/1789807760252-z71a9k.mp3';   // 真机语音 38K
const IMAGE = '/uploads/1789807771796-xh7fd.jpg';    // 真机照片 555K

async function timed(label, fn) {
  const t0 = T();
  try {
    const r = await fn();
    console.log(pad(label) + ' ' + ms(t0) + '   ' + r);
  } catch (e) {
    console.log(pad(label) + ' ' + ms(t0) + '   失败: ' + (e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message));
  }
}
const pad = (s) => (s + ' '.repeat(46)).slice(0, 46);

(async () => {
  console.log('================ ① 文件侧开销（读盘 + base64 + 拼 data URI）================');
  for (const [name, url] of [['音频 38K', AUDIO], ['图片 555K', IMAGE]]) {
    const p = resolveUpload(url);
    const { kind, format } = detectKind(p);
    const size = fs.statSync(p).size;
    await timed(name + ' 读盘+base64', async () => {
      const uri = toDataUri(p, format, kind);
      return '源码 ' + size + 'B → dataURI ' + uri.length + 'B';
    });
  }

  console.log('\n================ ② ASR / OCR 单次模型调用 =================');
  const aPath = resolveUpload(AUDIO);
  const aFmt = detectKind(aPath).format;
  const aUri = toDataUri(aPath, aFmt, 'audio');
  await timed('ASR qwen3-asr-flash', async () => {
    const t = await callModel({
      model: 'qwen3-asr-flash-2026-02-10',
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: aUri, format: aFmt } }] }]
    }, 120000);
    return '「' + String(t).trim().slice(0, 24) + '」';
  });

  const iPath = resolveUpload(IMAGE);
  const iFmt = detectKind(iPath).format;
  const iUri = toDataUri(iPath, iFmt, 'image');
  const OCR_Q = '这是一张采购/送货单据。把上面所有文字和表格原样读出来，保留每一行的品名、规格、数量、单价、金额，以及单据号和日期。只输出文字，不要解释，不要用 LaTeX 公式包裹。';
  await timed('OCR qwen3.5-ocr', async () => {
    const t = await callModel({
      model: 'qwen3.5-ocr',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: iUri } }, { type: 'text', text: OCR_Q }] }]
    }, 120000);
    return String(t).replace(/\s+/g, ' ').slice(0, 60);
  });

  console.log('\n================ ③ 纯文本结构化（qwen-plus，当前用的）================');
  const DOC_PROMPT = '你是采购单据识别助手。从下面的文字里提取一张采购/送货/磅单的结构化信息。严格按单据上写的填，看不清或没有的字段一律填空字符串或 null，不要编造。字段说明：supplier 供应商；orderNo 单据号；date YYYY-MM-DD；items 明细数组每行含 name/spec/unit/qty/price/amount；total 合计。只输出 JSON。';
  const SAMPLE = '上海华博商贸有限公司 螺纹钢 HRB400 12mm 吨 2.5 3800 9500 圆钢 Q235 20mm 吨 1.2 4200 5040 合计 14540';
  for (const model of ['qwen-plus', 'qwen-flash', 'qwen-turbo', 'qwen3-max']) {
    await timed('结构化 ' + model, async () => {
      const t = await callModel({
        model,
        messages: [{ role: 'system', content: DOC_PROMPT }, { role: 'user', content: SAMPLE }],
        temperature: 0.1
      }, 60000);
      return String(t).replace(/\s+/g, ' ').slice(0, 50);
    });
  }

  console.log('\n================ ④ 有没有「看图直接出 JSON」的视觉模型（省掉第二次调用）================');
  const VL_PROMPT = '这是一张采购/送货单据的图片。直接输出结构化 JSON：{"supplier":"","orderNo":"","date":"YYYY-MM-DD","total":0,"items":[{"name":"","spec":"","unit":"","qty":0,"price":0,"amount":0}]}。看不清或没有的字段填空字符串或 0，不要编造，只输出 JSON。';
  for (const model of ['qwen-vl-max', 'qwen3-vl-plus', 'qwen-vl-plus', 'qwen3.5-ocr', 'qwen2.5-vl-72b-instruct']) {
    await timed('单次看图→JSON ' + model, async () => {
      const t = await callModel({
        model,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: iUri } }, { type: 'text', text: VL_PROMPT }] }],
        temperature: 0.1
      }, 90000);
      return String(t).replace(/\s+/g, ' ').slice(0, 70);
    });
  }

  console.log('\n================ ⑤ 网关可用模型（筛相关的）================');
  try {
    const r = await axios.get(process.env.DASHSCOPE_BASE_URL + '/models', {
      headers: { Authorization: 'Bearer ' + process.env.DASHSCOPE_API_KEY }, timeout: 30000
    });
    const ids = (r.data && r.data.data ? r.data.data : []).map((m) => m.id);
    console.log('总模型数: ' + ids.length);
    console.log('\n-- 语音识别类 --');
    console.log(ids.filter((i) => /asr|audio|voice/i.test(i)).join('\n'));
    console.log('\n-- 视觉类（vl / ocr）--');
    console.log(ids.filter((i) => /vl|ocr|vision/i.test(i)).join('\n'));
    console.log('\n-- flash / turbo 类文本模型 --');
    console.log(ids.filter((i) => /flash|turbo|lite/i.test(i)).slice(0, 30).join('\n'));
  } catch (e) {
    console.log('列模型失败: ' + (e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message));
  }
})();
