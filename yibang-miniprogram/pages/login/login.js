// pages/login/login.js
//
// 登录页 —— **只在微信静默登录没通过时出现**（app.js 的 gotoLogin 跳过来）。
//
// 为什么单独做一页，而不是复用 bind-phone：
//   那一页办的是「绑手机号」：要走 open-type="getPhoneNumber"、要用户勾协议、
//   每点一次还扣微信的手机号验证次数。而这里要办的只是「再连一次微信」。
//   两件事失败的原因完全不同 —— 手机号授权失败是用户/额度的问题，
//   静默登录失败是网络或微信侧的问题。混在一页上，用户会以为是自己手机号出了毛病。
//
// ⚠️ 底部「先进入看看」是合规命门，任何情况下都不能去掉：
//    微信《开发者合规开发指引》点名的两条违规是"一进门就要求授权"和"拒绝授权则不给用"。
//    登录没连上更不该把人锁在门外 —— 有些内容（比如「我的」）不依赖网络也能看。
const app = getApp();

/**
 * 把技术错误翻成人话。
 * 翻不出来时不硬编 —— 如实说"没连上"，比给一个错的解释强
 * （错的方向会让用户去检查根本不相关的东西）。
 */
function humanize(msg) {
  const m = String(msg || '');
  if (/已退出登录/.test(m)) return '';                       // 主动退出的，不算"失败"
  if (/timeout|超时|等太久/.test(m)) return '刚才等太久了，网络可能不太顺';
  if (/域名|白名单|domain/.test(m)) return '接口没配置好，要联系易帮账本的工作人员';
  if (/network|net::|ERR_|断/i.test(m)) return '刚才没连上网';
  if (/wx\.login|微信/.test(m)) return '没能拿到微信的登录凭证';
  if (m) return '自动登录没成功（' + m.slice(0, 34) + '）';
  return '自动登录没成功';
}

Page({
  data: {
    busy: false,
    reason: '',      // 为什么到了这一页 —— 用户一进来就该看得见，而不是莫名奇妙
    errorTip: ''
  },

  onLoad(options) {
    let why = '';
    try { why = decodeURIComponent((options && options.why) || ''); } catch (e) { why = ''; }
    this.setData({ reason: humanize(why) });
    app.beacon('login-view', why.slice(0, 60));

    // 这里**故意不**做"有 token 就直接跳走"的兜底：
    // 到这一页的前提是启动校验没过，而 globalData.token 里可能还躺着上次登录的
    // 缓存 token（login 失败不会清它）—— 拿它当"已登录"的证据，会让页面闪一下又跳回去，
    // 用户根本来不及看清发生了什么。要跳，就等 doLogin 真的成功。
  },

  async doLogin() {
    if (this.data.busy) return;
    this.setData({ busy: true, errorTip: '' });
    try {
      await app.relogin();
      app.beacon('login-ok', '');
      wx.switchTab({ url: '/pages/record/record' });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      app.beacon('login-fail', msg.slice(0, 120));
      this.setData({ busy: false, errorTip: humanize(msg) + '，再点一次试试' });
    }
  },

  /** 退路：登录不上也能进去看看（合规要求 —— 不能因为没登录就拒绝提供服务） */
  skip() {
    app.beacon('login-skip', '');
    wx.switchTab({ url: '/pages/record/record' });
  }
});
