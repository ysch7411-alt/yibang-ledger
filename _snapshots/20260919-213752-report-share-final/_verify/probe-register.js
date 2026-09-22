// 注册链路接口验证：登录状态、绑定手机号的各个失败分支必须给出可读原因
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const post = (p, data, headers) =>
  axios.post(BASE + p, data, { headers: headers || H, timeout: 30000 })
    .then((r) => ({ http: r.status, body: r.data }))
    .catch((e) => ({ http: e.response ? e.response.status : 'ERR', body: e.response ? e.response.data : e.message }));
const get = (p, headers) =>
  axios.get(BASE + p, { headers: headers || H, timeout: 20000 })
    .then((r) => ({ http: r.status, body: r.data }))
    .catch((e) => ({ http: e.response ? e.response.status : 'ERR', body: e.response ? e.response.data : e.message }));

(async () => {
  console.log('=== ① /user/info 应带 phone 与 needPhone ===');
  let r = await get('/user/info');
  console.log('  HTTP ' + r.http + '  ' + JSON.stringify(r.body));

  console.log('\n=== ② /user/bind-phone 无 token → 必须 401 ===');
  r = await post('/user/bind-phone', { code: 'x' }, { 'Content-Type': 'application/json' });
  console.log('  HTTP ' + r.http + '  ' + JSON.stringify(r.body));

  console.log('\n=== ③ /user/bind-phone 有 token 但没 code → 可读提示 ===');
  r = await post('/user/bind-phone', {});
  console.log('  HTTP ' + r.http + '  ' + JSON.stringify(r.body));

  console.log('\n=== ④ /user/bind-phone 假 code → 会真的去微信换号码 ===');
  console.log('  （这一步同时验证了 WX_APPID/WX_SECRET 有效、access_token 能取到）');
  r = await post('/user/bind-phone', { code: 'fake-code-for-test' });
  console.log('  HTTP ' + r.http + '  ' + JSON.stringify(r.body));

  console.log('\n=== ⑤ /user/login 缺 code → 400 ===');
  r = await post('/user/login', {});
  console.log('  HTTP ' + r.http + '  ' + JSON.stringify(r.body));

  console.log('\n=== ⑥ /user/login 假 code → 微信侧报错，要如实透传 ===');
  r = await post('/user/login', { code: 'fake-code-for-test' });
  console.log('  HTTP ' + r.http + '  ' + JSON.stringify(r.body));
})();
