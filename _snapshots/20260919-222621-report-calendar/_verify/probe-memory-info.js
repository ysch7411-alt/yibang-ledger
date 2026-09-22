// 验证 /api/memory/info：用户能不能看见"它学会了什么"
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const tok = (u) => jwt.sign({ userId: u }, process.env.JWT_SECRET, { expiresIn: 600 });
const info = (u) =>
  axios.get('http://127.0.0.1:3000/api/memory/info', { headers: { Authorization: 'Bearer ' + tok(u) }, timeout: 15000 })
    .then((r) => r.data).catch((e) => ({ code: -1, msg: e.message }));

(async () => {
  console.log('=== ① user 1（有真实使用痕迹）===');
  const r = await info(1);
  console.log(JSON.stringify(r, null, 2));

  console.log('\n=== ② 无 token 必须 401 ===');
  const naked = await axios.get('http://127.0.0.1:3000/api/memory/info', { timeout: 15000, validateStatus: () => true })
    .then((x) => x.data).catch((e) => ({ code: -1 }));
  console.log('  code=' + naked.code + '  ' + (naked.code === 401 ? '✓' : '✗'));

  console.log('\n=== ③ 全新用户（应返回 0，而不是报错）===');
  const [ins] = await pool.query("INSERT INTO users (openid, role) VALUES ('__mem_test__', 1)");
  const fr = await info(ins.insertId);
  console.log('  code=' + fr.code + '  termCount=' + (fr.data && fr.data.termCount) + '  nameCount=' + (fr.data && fr.data.nameCount) + '  列表长度=' + ((fr.data && fr.data.nameMap) || []).length);
  console.log('  ' + (fr.code === 0 && fr.data.nameCount === 0 ? '✓ 新用户是干净的 0' : '✗'));
  await pool.query('DELETE FROM users WHERE openid = ?', ['__mem_test__']);
  console.log('\n测试用户已清理');
  process.exit(0);
})();
