// 走真实路径（nginx → 后端）验证上传，模拟 wx.uploadFile 的报文特征
const https = require('https');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const agent = new https.Agent({ rejectUnauthorized: false });

// 用 Host 头让 nginx 命中 api.dtzai.cn 这个 server 块（避开 DNS 回环问题）
function post(label, filename, bytes, fieldName) {
  const fd = new FormData();
  fd.append(fieldName || 'file', new Blob([bytes]), filename);
  return fetch('https://127.0.0.1/api/file/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, Host: 'api.dtzai.cn' },
    body: fd,
    dispatcher: undefined,
    agent
  })
    .then((r) => r.text().then((t) => ({ status: r.status, body: t })))
    .then(({ status, body }) => {
      let parsed = body;
      try { parsed = JSON.parse(body); } catch (e) { /* 保持原文 */ }
      console.log('  ' + label.padEnd(34) + ' [HTTP ' + status + '] ' + JSON.stringify(parsed).slice(0, 110));
      return parsed;
    })
    .catch((e) => {
      console.log('  ' + label.padEnd(34) + ' 异常 ' + e.message);
      return null;
    });
}

(async () => {
  console.log('=== 1) 正常上传（不带 content-type，复刻 wx.uploadFile）===');
  await post('jpg 小票 200KB', 'receipt.jpg', Buffer.alloc(200 * 1024, 1));
  await post('mp3 录音 300KB', 'voice.mp3', Buffer.alloc(300 * 1024, 2));
  await post('pdf 对账单 500KB', 'bill.pdf', Buffer.alloc(500 * 1024, 3));

  console.log('\n=== 2) 超过 10MB 限制（应给出可读原因，而不是服务器内部错误）===');
  await post('jpg 12MB', 'huge.jpg', Buffer.alloc(12 * 1024 * 1024, 4));

  console.log('\n=== 3) 字段名不对（应给出可读原因）===');
  await post('字段名传成 filex', 'a.jpg', Buffer.alloc(1024, 5), 'filex');

  console.log('\n=== 4) 无 token（应 401）===');
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.alloc(1024)]), 'a.jpg');
  const r = await fetch('https://127.0.0.1/api/file/upload', {
    method: 'POST', headers: { Host: 'api.dtzai.cn' }, body: fd, agent
  });
  console.log('  无 token                           [HTTP ' + r.status + '] ' + (await r.text()).slice(0, 80));
  process.exit(0);
})();
