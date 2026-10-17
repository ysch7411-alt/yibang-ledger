/**
 * 取 openid
 *
 * 🔴 这个云函数是**必需的**，不是可选的：
 *   小程序要有一个自己的租户标识，而它必须是**微信身份**——
 *   伪造不了。云托管虽然也会在网关注入 openid，
 *   但小程序端主动取一次更可靠：能在本地就发现"取不到"，
 *   而不是等接口返回 401 才怀疑身份。
 *
 * 为什么这么短：它只做一件事——把微信运行时已经知道的 OPENID 交出去。
 *   不查库、不建店、不做任何判断。那些事在云托管的 yibang-api 里做。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: 'dtzai-d4gg0x0uf147b4584' });

exports.main = async () => {
  const ctx = cloud.getWXContext();
  return {
    openId: ctx.OPENID,
    appId: ctx.APPID
  };
};
