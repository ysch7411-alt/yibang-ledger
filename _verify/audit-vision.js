const fs = require('fs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const t = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
const dir = '/www/wwwroot/yibang-server/uploads/';
const post = (p, b) => axios.post('http://127.0.0.1:3000/api' + p, b, { headers: H, timeout: 130000 })
  .then((r) => r.data).catch((e) => ({ code: -1, msg: String(e.message) }));

(async () => {
  console.log('=== ① 读图 /ai/vision ===');
  const img = fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort()[0];
  if (!img) console.log('  （uploads 里没有图片，跳过）');
  else {
    const kb = (fs.statSync(dir + img).size / 1024).toFixed(0);
    const t0 = Date.now();
    const r = await post('/ai/vision', { fileUrl: '/uploads/' + img });
    console.log('  图片：' + img + '（' + kb + 'KB）  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  code=' + r.code);
    console.log('  读出的内容：' + String((r.data && r.data.text) || r.msg).slice(0, 260));
  }

  console.log('\n=== ② 听写 /ai/asr（语音链路）===');
  const mp3 = fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f)).sort()[0];
  if (!mp3) console.log('  （uploads 里没有录音，跳过）');
  else {
    const t0 = Date.now();
    const r = await post('/ai/asr', { fileUrl: '/uploads/' + mp3 });
    console.log('  录音：' + mp3 + '  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  code=' + r.code);
    console.log('  听写结果：' + String((r.data && r.data.text) || r.msg).slice(0, 200));
  }

  console.log('\n=== ③ 读图 + 问答串起来（模拟用户拍了张图之后 AI 的回答）===');
  if (img) {
    const v = await post('/ai/vision', { fileUrl: '/uploads/' + img });
    const text = String((v.data && v.data.text) || '').trim();
    if (text && text !== '看不清') {
      const t0 = Date.now();
      const c = await post('/ai/chat', {
        question: '我刚拍了一张图，上面写的是：\n' + text + '\n请用两三句话告诉我这是什么、涉及多少钱、哪一天的。'
      });
      console.log('  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  code=' + c.code);
      console.log('  AI 回答：' + String((c.data && c.data.answer) || c.msg).slice(0, 240));
    } else {
      console.log('  图没读出内容，跳过串联测试（' + text + '）');
    }
  }
})();
