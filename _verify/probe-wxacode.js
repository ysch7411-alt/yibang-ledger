// 实测：未发布的小程序能不能生成「小程序码」。
// 这题必须先验 —— 海报的核心就是那个码，能生成才谈得上做海报。
require('dotenv').config();
const axios = require('axios');
const { getAccessToken } = require('./lib/wxtoken');

(async () => {
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.log('拿 access_token 失败：' + e.message);
    // 直接自己拉一次，把原始返回打出来看
    const r = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: { grant_type: 'client_credential', appid: process.env.WX_APPID, secret: process.env.WX_SECRET },
      timeout: 15000
    });
    console.log('原始 token 返回：' + JSON.stringify(r.data).slice(0, 200));
    process.exit(0);
  }
  console.log('access_token 拿到：' + String(token).slice(0, 12) + '…（长度 ' + String(token).length + '）\n');

  const cases = [
    ['getUnlimited scene=inviter%3D1', 'https://api.weixin.qq.com/wxa/getwxacodeunlimit',
      { scene: 'inviter=1', page: 'pages/record/record', check_path: false, env_version: 'trial' }],
    ['getUnlimited scene=1 无 env_version', 'https://api.weixin.qq.com/wxa/getwxacodeunlimit',
      { scene: '1', page: 'pages/record/record', check_path: false }],
    ['getwxacode（旧接口，path 带参）', 'https://api.weixin.qq.com/wxa/getwxacode',
      { path: 'pages/record/record?inviter=1', width: 430 }]
  ];

  for (const [label, url, body] of cases) {
    try {
      const r = await axios.post(url + '?access_token=' + token, body, {
        timeout: 30000, responseType: 'arraybuffer', validateStatus: () => true
      });
      const buf = Buffer.from(r.data);
      const ct = r.headers['content-type'] || '';
      if (ct.indexOf('image') >= 0) {
        // 是图片
        const magic = buf.slice(0, 4).toString('hex');
        console.log('  ✓ ' + label + '  → 图片 ' + buf.length + ' 字节，magic=' + magic +
          (magic === '89504e47' ? '（PNG ✓）' : ''));
        require('fs').writeFileSync('/tmp/wxacode-' + label.replace(/[^\w]/g, '_') + '.png', buf);
      } else {
        let j;
        try { j = JSON.parse(buf.toString('utf8')); } catch (e) { j = buf.toString('utf8').slice(0, 200); }
        console.log('  ✗ ' + label + '  → 不是图片：' + JSON.stringify(j).slice(0, 220));
      }
    } catch (e) {
      console.log('  ✗ ' + label + '  → 请求失败：' + (e.message || ''));
    }
  }
  process.exit(0);
})();
