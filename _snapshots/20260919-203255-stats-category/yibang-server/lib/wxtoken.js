// lib/wxtoken.js —— 小程序服务端 access_token 缓存
//
// 为什么必须缓存：access_token 有效期 7200 秒，微信对「获取次数」有每日上限，
// 而且两个进程/两次并发同时去取，会让先取到的那一个立刻失效（互相顶掉）。
// 所以这里做三件事：内存缓存 + 并发去重 + 收到 token 失效错误码时强制刷新重试一次。
const axios = require('axios');

const API = 'https://api.weixin.qq.com';
const REFRESH_AHEAD_MS = 5 * 60 * 1000;   // 提前 5 分钟刷新，避免边界上刚好过期
const TOKEN_ERRCODES = [40001, 40014, 42001];  // invalid credential / access_token expired

let cache = { token: '', expireAt: 0 };
let inflight = null;

async function fetchToken() {
  const r = await axios.get(API + '/cgi-bin/token', {
    params: {
      grant_type: 'client_credential',
      appid: process.env.WX_APPID,
      secret: process.env.WX_SECRET
    },
    timeout: 10000
  });
  const d = r.data || {};
  if (!d.access_token) {
    throw new Error('获取 access_token 失败：' + (d.errmsg || JSON.stringify(d)));
  }
  const ttl = Number(d.expires_in || 7200) * 1000;
  cache = { token: d.access_token, expireAt: Date.now() + Math.max(ttl - REFRESH_AHEAD_MS, 60000) };
  return cache.token;
}

/** 取 token：命中缓存直接返回；并发只发一次请求 */
function getAccessToken(force) {
  if (!force && cache.token && Date.now() < cache.expireAt) {
    return Promise.resolve(cache.token);
  }
  if (!inflight) {
    inflight = fetchToken().finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * 调用需要 access_token 的微信接口（POST）。
 * token 失效时自动强刷一次再重试 —— 否则用户侧会莫名其妙看到「获取失败」。
 */
async function callWx(path, data) {
  let token = await getAccessToken();
  let body = (await axios.post(API + path + '?access_token=' + token, data, { timeout: 10000 })).data;
  if (body && TOKEN_ERRCODES.includes(body.errcode)) {
    console.warn('access_token 失效，强刷后重试：', body.errcode, body.errmsg);
    token = await getAccessToken(true);
    body = (await axios.post(API + path + '?access_token=' + token, data, { timeout: 10000 })).data;
  }
  return body;
}

module.exports = { getAccessToken, callWx };
