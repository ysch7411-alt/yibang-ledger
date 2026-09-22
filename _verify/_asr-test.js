const fs = require('fs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const t = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 900 });
const H = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
const dir = '/www/wwwroot/yibang-server/uploads/';
const post = (p, b, to) => axios.post('http://127.0.0.1:3000/api' + p, b, { headers: H, timeout: to || 70000 })
  .then((r) => r.data).catch((e) => ({ code: -1, msg: String(e.message), isTimeout: e.code === 'ECONNABORTED' }));

(async () => {
  const mp3s = fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f)).sort();
  console.log('uploads 里的录音：' + mp3s.join(', '));
  if (!mp3s.length) { console.log('  没有可测的录音'); return; }

  for (const f of mp3s.slice(0, 2)) {
    const kb = (fs.statSync(dir + f).size / 1024).toFixed(0);
    const t0 = Date.now();
    const r = await post('/ai/asr', { fileUrl: '/uploads/' + f });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\n  ' + f + '（' + kb + 'KB）→ ' + sec + 's  code=' + r.code +
      (r.isTimeout ? '  ⚠️ 超时' : '') + (r.msg ? '  msg=' + String(r.msg).slice(0, 60) : ''));
    console.log('  结果：' + String((r.data && r.data.text) || '(空)').slice(0, 80));
  }

  // 关键：测「一个不存在的文件」会不会一直挂着
  console.log('\n  --- 不存在的文件（看会不会挂住） ---');
  const t1 = Date.now();
  const r2 = await post('/ai/asr', { fileUrl: '/uploads/no-such-file.mp3' }, 30000);
  console.log('  ' + ((Date.now() - t1) / 1000).toFixed(1) + 's  code=' + r2.code + '  msg=' + String(r2.msg).slice(0, 60));
})();
