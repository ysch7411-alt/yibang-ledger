// 验证 GET /promote/wxacode —— 分销海报的「专属小程序码」接口。
//
// 要验的不是「HTTP 200」，而是这四件事：
//   ① 鉴权：没 token 拿不到码（否则别人的海报能挂你的邀请关系）
//   ② 首次生成：返回的确实是图片（看 base64 解出来的魔数，不看 content-type）
//   ③ 缓存：第二次必须 cached:true 且字节完全一致（同一个人码永不变，别白发微信请求）
//   ④ 按用户隔离：1 号和 2 号各存一份，不能互相覆盖
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const axios = require('axios');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000/api';
const CODE_DIR = path.join(process.env.UPLOAD_DIR || '/www/wwwroot/yibang-server/uploads', 'wxacode');
const mk = (uid) => ({ Authorization: 'Bearer ' + jwt.sign({ userId: uid }, process.env.JWT_SECRET, { expiresIn: 600 }) });

let pass = 0, fail = 0;
function say(ok, label, extra) {
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (extra ? '  → ' + extra : ''));
}

const magicOf = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return { magic: buf.slice(0, 4).toString('hex'), size: buf.length };
};

(async () => {
  console.log('=== ① 鉴权 ===');
  try {
    const r = await axios.get(BASE + '/promote/wxacode', { timeout: 30000, validateStatus: () => true });
    say(r.data && r.data.code === 401, '无 token → code 401', 'HTTP ' + r.status + ' code=' + (r.data && r.data.code));
  } catch (e) {
    say(false, '无 token 请求', e.message);
  }

  console.log('\n=== ② 首次生成 + 干净开局（先删缓存，确保真的走了一次微信）===');
  const f1 = path.join(CODE_DIR, 'u1.jpg');
  if (fs.existsSync(f1)) { fs.unlinkSync(f1); console.log('  · 已删除旧缓存 u1.jpg'); }

  let first = null;
  try {
    const r = await axios.get(BASE + '/promote/wxacode', { headers: mk(1), timeout: 40000, validateStatus: () => true });
    first = r.data;
    const d = r.data && r.data.data;
    say(r.data && r.data.code === 0, 'code 0', 'msg=' + (r.data && r.data.msg || '-') + '  ' + (Date.now() ? '' : ''));
    if (d) {
      const m = magicOf(d.imageBase64 || '');
      say(d.cached === false, 'cached=false（确实现生成）', 'cached=' + d.cached);
      // JPEG = ffd8，PNG = 89504e47
      say(m.magic.indexOf('ffd8') === 0 || m.magic === '89504e47', '返回的是真图片', 'magic=' + m.magic + ' size=' + m.size + 'B');
      say(m.size > 2000, '图片体积合理（>2KB，不是错误占位）', m.size + 'B');
    } else {
      say(false, 'data 不为空', JSON.stringify(r.data).slice(0, 160));
    }
  } catch (e) {
    say(false, '首次生成请求', e.message);
  }

  console.log('\n=== ③ 落盘 + 缓存命中 ===');
  say(fs.existsSync(f1), 'u1.jpg 已落盘', fs.existsSync(f1) ? fs.statSync(f1).size + 'B' : '不存在');

  try {
    const r = await axios.get(BASE + '/promote/wxacode', { headers: mk(1), timeout: 40000, validateStatus: () => true });
    const d = r.data && r.data.data;
    say(r.data && r.data.code === 0, '第二次 code 0');
    say(d && d.cached === true, 'cached=true（没再打微信）', 'cached=' + (d && d.cached));
    if (d && first && first.data) {
      const same = d.imageBase64 === first.data.imageBase64;
      say(same, '两次字节完全一致（码是稳定的）', same ? 'identical' : 'DIFFERENT!');
    }
  } catch (e) {
    say(false, '缓存命中请求', e.message);
  }

  console.log('\n=== ④ 按用户隔离：2 号各存一份，不互相覆盖 ===');
  const f2 = path.join(CODE_DIR, 'u2.jpg');
  const hadF2 = fs.existsSync(f2);
  try {
    const r = await axios.get(BASE + '/promote/wxacode', { headers: mk(2), timeout: 40000, validateStatus: () => true });
    const d = r.data && r.data.data;
    say(r.data && r.data.code === 0, '用户2 code 0', 'msg=' + (r.data && r.data.msg || '-'));
    say(fs.existsSync(f2), 'u2.jpg 已落盘', fs.existsSync(f2) ? fs.statSync(f2).size + 'B' : '不存在');
    say(fs.existsSync(f1), 'u1.jpg 仍在（没被覆盖）', fs.existsSync(f1) ? fs.statSync(f1).size + 'B' : '丢了!');
    if (d && first && first.data) {
      say(d.imageBase64 !== first.data.imageBase64, '两个人拿到的是不同的码', d.imageBase64 === first.data.imageBase64 ? 'ALIKE!' : 'different ✓');
    }
  } catch (e) {
    say(false, '用户2 请求', e.message);
  }

  console.log('\n=== ⑤ scene 长度约束（微信硬限 32 字符）===');
  // scene = 'inviter=<userId>'，userId 是自增 int，现实中不会超 —— 这里只是留个哨兵
  const worst = ('inviter=' + Number.MAX_SAFE_INTEGER).length;
  say(worst <= 32, "最长可能的 scene 仍 <=32", "worst='" + 'inviter=' + Number.MAX_SAFE_INTEGER + "' len=" + worst);

  console.log('\n=== 附：落盘目录 ===');
  try {
    fs.readdirSync(CODE_DIR).forEach((f) => {
      const s = fs.statSync(path.join(CODE_DIR, f));
      console.log('  · ' + f + '  ' + s.size + 'B  ' + s.mtime.toISOString());
    });
  } catch (e) { console.log('  (读目录失败 ' + e.message + ')'); }

  console.log('\n' + (fail ? '✗ ' + fail + ' 项不合格' : '✓ 全部通过') + '（通过 ' + pass + '，失败 ' + fail + '）');
  process.exit(fail ? 1 : 0);
})();
