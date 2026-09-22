/**
 * _verify/wx-template.js —— 拉出小程序订阅消息模板的**字段名**
 *
 * 为什么要程序化拉：微信的下发参数是 `{"thing1":{"value":"..."}}`，
 * 而管理后台只显示中文标签（"昨日收入"）。让人对着截图手抄字段名，
 * 错一个字符就是 **47003 整体失败**，而且报错信息看不出是哪个字段。
 * 接口返回的 `content` 里直接带着 `{{thing1.DATA}}` 这种原文，抄它就零风险。
 *
 * 用法（服务器上跑）：node __wx-tmpl.js [模板ID]
 *   GET /wxaapi/newtmpl/gettemplate 需要 access_token —— 走项目已有的 lib/wxtoken。
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const axios = require('axios');
const { getAccessToken } = require('/www/wwwroot/yibang-server/lib/wxtoken');

(async () => {
  const want = process.argv[2] || '';
  const token = await getAccessToken();
  console.log('access_token 已获取（尾4位 ' + String(token).slice(-4) + '）\n');

  const r = await axios.get('https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate', {
    params: { access_token: token },
    timeout: 15000
  });
  const d = r.data || {};
  if (d.errcode) {
    console.log('✗ 微信返回错误:', d.errcode, d.errmsg);
    process.exit(1);
  }
  const list = d.data || [];
  console.log('这个账号下已添加的模板共 ' + list.length + ' 个：\n');

  for (const t of list) {
    const hit = !want || t.priTmplId === want;
    console.log((hit ? '★' : ' ') + ' [' + t.title + ']');
    console.log('    priTmplId: ' + t.priTmplId);
    // content 里就是 {{thing1.DATA}} 这种原文 —— 字段名从这里取，不要靠人认
    const keys = [...String(t.content || '').matchAll(/\{\{([a-z_]+?\d+)\.DATA\}\}/g)].map((m) => m[1]);
    console.log('    字段名: ' + (keys.length ? keys.join('  ') : '（没解析出来）'));
    if (hit) {
      console.log('    content 原文: ' + String(t.content || '').replace(/\n/g, ' | '));
      console.log('    示例: ' + String(t.example || '').replace(/\n/g, ' | '));
      console.log('    type: ' + t.type + '（2=一次性订阅）');
    }
    console.log('');
  }
  process.exit(0);
})().catch((e) => {
  console.error('失败:', (e.response && e.response.data) || e.message);
  process.exit(1);
});
