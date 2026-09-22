// 实测：小程序自己的 access_token 能不能调隐私保护指引接口
// 先做只读探测，确认凭据是否被接受，再决定能不能写。
const axios = require('axios');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const API = 'https://api.weixin.qq.com';
const show = (label, d) => console.log('  ' + label + ' → ' + JSON.stringify(d));

(async () => {
  // ① 普通 access_token（小程序自己的凭据）
  let token = '';
  try {
    const r = await axios.get(API + '/cgi-bin/token', {
      params: { grant_type: 'client_credential', appid: process.env.WX_APPID, secret: process.env.WX_SECRET },
      timeout: 15000
    });
    if (r.data.access_token) {
      token = r.data.access_token;
      console.log('① 普通 access_token 取得成功（长度 ' + token.length + '，尾 6 位 …' + token.slice(-6) + '）\n');
    } else {
      console.log('① 取 token 失败：' + JSON.stringify(r.data));
      process.exit(1);
    }
  } catch (e) {
    console.log('① 取 token 异常：' + e.message);
    process.exit(1);
  }

  // ② 只读探测：查询隐私保护指引（component 系列，服务商专用）
  console.log('② 用普通 token 尝试查询隐私保护指引（只读）');
  for (const path of ['/cgi-bin/component/getprivacysetting', '/wxa/getprivacysetting', '/wxa/security/getprivacysetting']) {
    for (const body of [{ privacy_ver: 2 }, { privacy_ver: 1 }]) {
      try {
        const r = await axios.post(API + path + '?access_token=' + token, body, { timeout: 15000 });
        show('POST ' + path + ' ' + JSON.stringify(body), r.data);
      } catch (e) {
        show('POST ' + path, e.response ? e.response.data : e.message);
      }
    }
  }

  // ③ 对照：确认这个 token 在普通接口上是好的（排除 token 本身有问题）
  console.log('\n③ 对照：普通接口是否正常（证明 token 本身有效）');
  try {
    const r = await axios.get(API + '/wxa/business/getuserphonenumber?access_token=' + token, { timeout: 15000 });
    show('POST getuserphonenumber（空 code）', r.data);
  } catch (e) {
    show('getuserphonenumber', e.response ? e.response.data : e.message);
  }
  try {
    const r = await axios.post(API + '/wxa/business/getuserphonenumber?access_token=' + token, { code: 'x' }, { timeout: 15000 });
    show('对照 getuserphonenumber（假 code）', r.data);
  } catch (e) {
    show('对照', e.response ? e.response.data : e.message);
  }
})();
