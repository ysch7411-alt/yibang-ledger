// 复现小程序上传：文件 part 不带 content-type（wx.uploadFile 的行为），看服务端返回什么
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });

async function tryUpload(label, blob) {
  const fd = new FormData();
  fd.append('file', blob, 'probe.txt');
  try {
    const r = await fetch(BASE + '/file/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: fd
    });
    const text = await r.text();
    console.log('  ' + label + ' → [HTTP ' + r.status + '] ' + text.slice(0, 200));
    return text;
  } catch (e) {
    console.log('  ' + label + ' → 异常 ' + e.message);
    return null;
  }
}

(async () => {
  console.log('mimetype 对照实验：');
  // A: 不带 type（复刻 wx.uploadFile）
  await tryUpload('A 不带 content-type ', new Blob([Buffer.from('hello-A')]));
  // B: 显式 image/jpeg
  await tryUpload('B image/jpeg        ', new Blob([Buffer.from('hello-B')], { type: 'image/jpeg' }));
  // C: 显式 audio/mpeg
  await tryUpload('C audio/mpeg        ', new Blob([Buffer.from('hello-C')], { type: 'audio/mpeg' }));

  console.log('\nfiles 表最近 5 条：');
  const [rows] = await pool.query('SELECT id, file_url, file_type, LENGTH(file_type) AS len, file_size FROM files ORDER BY id DESC LIMIT 5');
  rows.forEach((r) => console.log('  id=' + r.id + '  type=' + r.file_type + ' (len=' + r.len + ')  size=' + r.file_size + '  ' + r.file_url));

  console.log('\nfile_type 列定义：');
  const [cols] = await pool.query("SHOW COLUMNS FROM files LIKE 'file_type'");
  cols.forEach((c) => console.log('  ' + JSON.stringify(c)));
  process.exit(0);
})();
