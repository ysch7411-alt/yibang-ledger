// 探测专属 MaaS 网关上 ASR / OCR 模型的正确请求格式
// 用法: node probe-ai.js /tmp/probe.jpg /tmp/probe.wav
const fs = require('fs');
const path = require('path');
const axios = require('/www/wwwroot/yibang-server/node_modules/axios');

const BASE = process.env.DASHSCOPE_BASE_URL;
const KEY = process.env.DASHSCOPE_API_KEY;
const H = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function tryIt(name, body) {
  try {
    const r = await axios.post(BASE + '/chat/completions', body, { headers: H, timeout: 90000 });
    const c = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    const txt = typeof c === 'string' ? c : JSON.stringify(c);
    console.log('  OK   ' + name + '\n       → ' + String(txt).replace(/\s+/g, ' ').slice(0, 200));
    return true;
  } catch (e) {
    const d = e.response && e.response.data;
    const msg = d ? JSON.stringify(d).slice(0, 220) : e.message;
    console.log('  FAIL ' + name + '\n       → ' + msg);
    return false;
  }
}

(async () => {
  const imgPath = process.argv[2];
  const wavPath = process.argv[3];
  const imgB64 = fs.readFileSync(imgPath).toString('base64');
  const wavB64 = fs.readFileSync(wavPath).toString('base64');
  const imgMime = path.extname(imgPath) === '.png' ? 'image/png' : 'image/jpeg';

  console.log('图片 ' + imgPath + ' → base64 ' + Math.round(imgB64.length / 1024) + 'KB');
  console.log('音频 ' + wavPath + ' → base64 ' + Math.round(wavB64.length / 1024) + 'KB');
  console.log('');

  console.log('===== 视觉 OCR =====');
  await tryIt('qwen3.5-ocr + data URI', {
    model: 'qwen3.5-ocr',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:' + imgMime + ';base64,' + imgB64 } },
        { type: 'text', text: '把图中所有文字原样输出，不要解释' }
      ]
    }]
  });

  console.log('');
  console.log('===== 语音识别 ASR =====');
  const asrModels = ['qwen3-asr-flash-2026-02-10', 'fun-asr-flash-2026-06-15', 'qwen-audio-3.0-asr-flash'];
  for (const m of asrModels) {
    await tryIt(m + ' | input_audio.dataURI', {
      model: m,
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + wavB64, format: 'wav' } }]
      }]
    });
  }
  await tryIt('qwen3-asr-flash-2026-02-10 | input_audio.rawB64', {
    model: 'qwen3-asr-flash-2026-02-10',
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: wavB64, format: 'wav' } }]
    }]
  });
  await tryIt('qwen3-asr-flash-2026-02-10 | audio_url.dataURI', {
    model: 'qwen3-asr-flash-2026-02-10',
    messages: [{
      role: 'user',
      content: [{ type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,' + wavB64 } }]
    }]
  });
})();
