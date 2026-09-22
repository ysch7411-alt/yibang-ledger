// 复现用户真机上报的「图片识别 / 语音转写都不成功」
// 直接用真机刚上传的文件调三个接口，把完整响应打出来。
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 1800 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const shots = [
  { label: '真机语音 16:49:20（38K）', url: '/uploads/1789807760252-z71a9k.mp3' },
  { label: '真机语音 16:48:04（24K）', url: '/uploads/1789807684054-dkglkg.mp3' }
];
const img = { label: '真机照片 16:49:31（555K）', url: '/uploads/1789807771796-xh7fd.jpg' };

async function post(p, body, timeout = 120000) {
  const t0 = Date.now();
  try {
    const r = await axios.post(BASE + p, body, { headers: H, timeout });
    return { ms: Date.now() - t0, status: r.status, bytes: JSON.stringify(r.data).length, data: r.data };
  } catch (e) {
    return {
      ms: Date.now() - t0,
      status: e.response ? e.response.status : 'ERR',
      bytes: e.response ? JSON.stringify(e.response.data).length : 0,
      data: e.response ? e.response.data : String(e.message),
      httpErr: true
    };
  }
}

function show(tag, r) {
  console.log('--- ' + tag + ' ---');
  console.log('  HTTP ' + r.status + (r.httpErr ? '  （HTTP 层就错了）' : '') + '  用时 ' + r.ms + 'ms  响应 ' + r.bytes + ' 字节');
  console.log('  ' + JSON.stringify(r.data));
  console.log('');
}

(async () => {
  console.log('================ 语音转写 /ai/asr ================');
  for (const s of shots) {
    const r = await post('/ai/asr', { fileUrl: s.url });
    show(s.label, r);
  }

  console.log('================ 图片结构化 /purchase/parse-doc ================');
  show(img.label, await post('/purchase/parse-doc', { fileUrl: img.url }));

  console.log('================ 图片 OCR /ai/ocr-parse ================');
  show(img.label, await post('/ai/ocr-parse', { fileUrl: img.url }));

  console.log('================ 对照：文字入口 /purchase/parse-doc ================');
  show('文字', await post('/purchase/parse-doc', { text: '螺纹钢 HRB400 12mm 2.5吨 3800元' }, 60000));
})();
