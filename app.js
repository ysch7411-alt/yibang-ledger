/**
 * 易帮AI（云开发版 → 自有服务器版）
 *
 * 2026-10-16 改造：后端从腾讯云托管搬到阿里云 ECS（api.dtzai.cn/cb/）。
 * 身份链路从"CloudBase 网关注入 openid"换成主产品同款的：
 *   wx.login() 拿 code → POST /api/wx-login（服务端用 AppSecret 换 openid）
 *   → 服务端签 30 天 JWT → 本地存起来 → 之后每个请求带 Authorization: Bearer。
 *
 * 🔴 与旧版最大的区别：**不再依赖 wx.cloud / 云函数** —— getOpenId 云函数退役。
 */

/* 后端基地址（ECS nginx /cb/ 前缀转发）。带尾斜杠，路径直接拼 */
const API_BASE = 'https://api.dtzai.cn/cb/';

const TOKEN_KEY = 'yibang_token';   // 本地缓存的登录令牌（30 天有效，服务端控制）

App({
  globalData: {
    // 登录态。token=JWT；openid=租户身份（语音管线等处用）
    token: '',
    openId: '',
    shop: null
  },

  onLaunch() {
    /* 登录改为懒加载：首个 API 请求时 ensureToken() 触发。
     * 这里只做一件事——把本地缓存的老 token 捡回来（有就直接用，省一次登录）。 */
    try {
      const t = wx.getStorageSync(TOKEN_KEY);
      if (t) this.globalData.token = t;
    } catch (e) { /* 存储坏了就当没有 */ }
  },

  /**
   * 确保已登录，返回 Promise<{token, openid}>。
   * 有缓存 token 直接用；没有就走 wx.login → /api/wx-login。
   *
   * 🔴 与旧版 ensureOpenId 的区别：旧版靠云函数拿 openid（CloudBase 独有），
   *    新版走自家服务器 code2Session —— AppSecret 只在服务端，前端拿不到也伪造不了。
   */
  ensureToken() {
    return new Promise((resolve, reject) => {
      if (this.globalData.token) {
        return resolve({ token: this.globalData.token, openid: this.globalData.openId });
      }
      wx.login({
        success: (r) => {
          if (!r.code) return reject(new Error('wx.login 没拿到 code'));
          wx.request({
            url: API_BASE + 'api/wx-login',
            method: 'POST',
            data: { code: r.code },
            header: { 'content-type': 'application/json' },
            success: (res) => {
              const body = res.data || {};
              if (body.code !== 0 || !body.data || !body.data.token) {
                return reject(new Error(body.msg || '登录失败（' + (body.code || res.statusCode) + '）'));
              }
              this.globalData.token = body.data.token;
              this.globalData.openId = body.data.openid || '';
              try { wx.setStorageSync(TOKEN_KEY, body.data.token); } catch (e) { /* 存储坏了不影响本次 */ }
              resolve({ token: body.data.token, openid: this.globalData.openId });
            },
            fail: (e) => reject(new Error('登录请求发不出去：' + ((e && e.errMsg) || '')))
          });
        },
        fail: (e) => reject(new Error('wx.login 失败：' + ((e && e.errMsg) || '')))
      });
    });
  },

  /** 登出/令牌失效时清空本地登录态（下次请求会自动重新登录） */
  clearAuth() {
    this.globalData.token = '';
    this.globalData.openId = '';
    try { wx.removeStorageSync(TOKEN_KEY); } catch (e) { /* 忽略 */ }
  }
});
