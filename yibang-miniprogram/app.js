// app.js —— 易帮账本
// 必须在最顶部：全局 Page 注入（主题/文案/功能开关）要在任何页面加载前就位
require('./utils/page-config');
const appConfig = require('./utils/config');

App({
  globalData: {
    userInfo: null,
    userId: null,
    token: '',
    apiBase: 'https://api.dtzai.cn/api',
    // 邀请人 id 来自分享路径或小程序码
    inviterId: null
  },

  onLaunch(options) {
    // 远程配置（主题/文案/布局/开关）：启动就拉，不等登录。
    // 失败静默 —— 页面会用兜底值先渲染，onShow 时版本变了再补上。
    appConfig.load(true);

    // 老版本把「已退出」写进本地存储 → 退出过一次，以后每次进来都不会再自动登录，
    // 只能自己去「我的」里手动点一下。现在退出只在**本次运行**内有效（见 logout），
    // 所以启动时顺手把这个遗留键清掉。
    try { wx.removeStorageSync('logged_out'); } catch (e) { /* 清不掉不影响启动 */ }

    const token = wx.getStorageSync('token');
    const user = wx.getStorageSync('userInfo');
    if (token) this.globalData.token = token;
    if (user) {
      this.globalData.userInfo = user;
      this.globalData.userId = user.id || null;
    }
    this.captureInvite(options);

    // 每次启动都重新走一遍微信静默登录校验（2026-09-20 用户要求）：
    //   通过 → 什么都不用做，tabBar 首页就是记账页
    //   没通过 → 去登录页。
    // 为什么不能像以前那样"失败就静默留在记账页"：那一页看起来完全正常，
    // 只是所有列表都是空的 —— 老板会以为是自己没记账，而不是"登录没成功"。
    this.login().catch((err) => this.gotoLogin(err));
  },

  onShow(options) {
    // 热启动也要接一次：从小程序码/分享再次进入时 onLaunch 不会重跑
    this.captureInvite(options);
  },

  /**
   * 记下邀请人（扫码分享注册的那条链）。
   * 两种来源：分享路径的 query（inviter=5），或小程序码的 scene（scene=inviter%3D5，也可能只是 "5"）。
   * 立刻落到本地存储 —— 登录是异步的，中间还可能跳注册页，只放内存会丢。
   */
  captureInvite(options) {
    try {
      const q = (options && options.query) || {};
      let id = q.inviter || q.from || '';
      if (!id && q.scene) {
        const scene = decodeURIComponent(String(q.scene));
        const m = /(?:^|[?&])inviter=(\d+)/.exec(scene) || /^(\d+)$/.exec(scene);
        if (m) id = m[1];
      }
      id = String(id).replace(/\D/g, '');
      if (id && id !== String(this.globalData.userId || '')) {
        wx.setStorageSync('pending_inviter', id);
      }
      const saved = wx.getStorageSync('pending_inviter');
      if (saved) this.globalData.inviterId = String(saved);
    } catch (e) {
      /* 邀请参数解析失败不能影响启动 */
    }
  },

  /**
   * 微信静默登录。
   * 并发去重：多个页面 onLoad 同时打请求时只发一次 code2session，避免无效登录风暴。
   *
   * 2026-09-21 大改（鸿蒙真机实测：wx.login 会**间歇性挂起**——既不 success 也不 fail，
   * 今早成功 3 次、11:52 还成功一次，11:53 重开就哑火，10 秒守卫把用户踢进登录页，
   * 再点「微信一键登录」还是一样的，用户彻底进不来）：
   * ① **有本地 token 先探 checkSession**：微信会话有效 → openid 没变 → 旧 token 继续用，
   *    完全不碰 wx.login。既躲开挂起，每次启动还少一次网络往返。
   *    （token 真过期了接口会 401，401 自愈带 force 走真登录，见 request()。）
   * ② **wx.login 挂起自动重试**：单次 8 秒没回调就重调（挂起是间歇性的，重试常好）；
   *    明确失败（fail 回调）不重试。两次都哑火才抛错，绝不无限 pending。
   */
  login(opts) {
    const force = !!(opts && opts.force);
    // 用户主动退出过就不要再偷偷登回来 —— 否则「退出登录」按下去毫无效果
    if (this.isLoggedOut()) return Promise.reject(new Error('已退出登录'));
    if (this._loginTask) return this._loginTask;

    this._loginTask = (async () => {
      // ① 本地 token + 微信会话有效 → 直接放行，不碰 wx.login
      if (!force) {
        const token = wx.getStorageSync('token');
        if (token) {
          const alive = await this.checkSessionQuiet();
          if (alive) {
            this.bindPendingInvite();
            this.maybeWelcome();
            return { token, user: wx.getStorageSync('userInfo') || null, skipped: true };
          }
        }
      }
      // ② 真登录（带重试的 wx.login）
      const code = await this.wxLoginWithRetry();
      const result = await this.request('/user/login', {
        method: 'POST',
        data: { code },
        silent: true
      });
      if (!result || result.code !== 0) {
        throw new Error((result && result.msg) || '登录失败');
      }
      this.setUser(result.data.token, result.data.user);
      this.bindPendingInvite();
      this.maybeWelcome();
      return result.data;
    })().finally(() => {
      this._loginTask = null;
    });

    return this._loginTask;
  },

  /**
   * 探微信会话还有效吗。带 3 秒超时——checkSession 自己也可能哑火，
   * 超时当无效，走后面的 wx.login（那条路有重试兜底）。
   * 返回值只有 true/false，永不抛错：它是"能不能跳过登录"的探测，不该把启动搞挂。
   */
  checkSessionQuiet() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; resolve(v); };
      const timer = setTimeout(() => done(false), 3000);
      try {
        wx.checkSession({
          success: () => { clearTimeout(timer); done(true); },
          fail: () => { clearTimeout(timer); done(false); }
        });
      } catch (e) {
        clearTimeout(timer);
        done(false);
      }
    });
  },

  /**
   * wx.login 带重试。单次 8 秒没回调就重调，最多 2 次。
   * 只对"超时哑火"重试；明确失败（fail 回调）不重试——那是真错，重试没意义。
   */
  wxLoginWithRetry() {
    const tryOnce = () => new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; fn(v); };
      const guard = setTimeout(() => done(reject, new Error('__timeout__')), 8000);
      wx.login({
        success: (res) => {
          clearTimeout(guard);
          if (!res || !res.code) return done(reject, new Error('wx.login 未返回 code'));
          done(resolve, res.code);
        },
        fail: (err) => { clearTimeout(guard); done(reject, err || new Error('wx.login 失败')); }
      });
    });

    return (async () => {
      let lastErr = null;
      for (let i = 0; i < 2; i++) {
        try {
          return await tryOnce();
        } catch (err) {
          lastErr = err;
          if (!err || err.message !== '__timeout__') throw err;
        }
      }
      throw lastErr || new Error('登录没响应，重新打开小程序试试');
    })();
  },

  setUser(token, user) {
    this.globalData.token = token || '';
    this.globalData.userInfo = user || null;
    this.globalData.userId = (user && user.id) || null;
    wx.setStorageSync('token', token || '');
    wx.setStorageSync('userInfo', user || null);
  },

  /**
   * ⚠️ 这里曾经是**强制注册门槛** —— 没手机号就 reLaunch 到注册页，不去不让用。
   * 那是明确的违规（微信《开发者合规开发指引》点名两条：
   *   ①「进入小程序后立即提示授权手机号」；②「用户不同意授权则拒绝提供服务」）。
   *
   * 现在改成**可跳过的欢迎页**：新用户第一次进来会看到注册页（品牌 + 价值 + 注册入口），
   * 但底部一直有「先进入看看」，不绑也能把功能用全 —— 这样就不碰那两条红线。
   *
   * 三个前提，缺一不弹：
   *   ① 从没弹过（`welcomed` 标记）—— 只在第一次，之后再也不打扰；
   *   ② 还没绑手机号；
   *   ③ 不是主动退出过的状态（退出了就该停在登录流程上，别再塞注册页）。
   */
  maybeWelcome() {
    try {
      if (wx.getStorageSync('welcomed')) return;
      const user = this.globalData.userInfo || {};
      if (user.phone) return;
      if (this.isLoggedOut()) return;

      // 先打标记再跳 —— 万一下面 reLaunch 失败或用户立刻杀掉小程序，
      // 也不会下次再弹一遍。这一页只该出现一次。
      wx.setStorageSync('welcomed', 1);
      this.beacon('welcome-trigger', '');
      wx.reLaunch({ url: '/pages/bind-phone/bind-phone?mode=welcome' });
    } catch (e) {
      /* 欢迎页拉不起来不能影响正常使用 */
    }
  },

  /**
   * 本次运行内是否主动退出过。
   *
   * ⚠️ 只读**内存**，不落盘 —— 这是 2026-09-20 用户明确要求的行为：
   * 退出后再进小程序，要重新走一遍微信自动登录校验，而不是永久停在"已退出"。
   * 落盘的话「退出一次 = 以后每次进来都得手动点登录」，可用户的身份本来就是微信给的，
   * 多那一步纯属为难人。内存标记足够表达"这次运行里别再偷偷登回来"。
   */
  isLoggedOut() {
    return !!this._loggedOut;
  },

  /**
   * 退出登录：清掉本地登录态（openid 在微信侧，清不掉也不该清）。
   * 「退出」管的是**当下这一次运行**：立刻退回未登录、别被 token 悄悄带回去；
   * 下次打开小程序重新校验一次微信登录。
   */
  logout() {
    this.globalData.token = '';
    this.globalData.userInfo = null;
    this.globalData.userId = null;
    wx.removeStorageSync('token');
    wx.removeStorageSync('userInfo');
    this._loggedOut = true;
  },

  /** 手动登录（退出后用 / 登录页重试）：清掉退出标记再走一次真登录。
   *  带 force —— 用户是明确点了「微信一键登录」，该真去微信拿新身份，
   *  不能被 checkSession 网关放行（那个网关是给启动时的老 token 用的）。 */
  relogin() {
    this._loggedOut = false;
    this._loginTask = null;
    return this.login({ force: true });
  },

  /**
   * 静默登录没通过时，把用户带到登录页。
   *
   * 加节流是因为可能有两个来源几乎同时失败（启动校验 + 某个页面请求 401 后的自动重试），
   * 连跳两次会让页面栈闪一下、也可能在登录页上叠一个登录页。
   */
  gotoLogin(err) {
    const now = Date.now();
    if (now - (this._lastGotoLogin || 0) < 3000) return;
    this._lastGotoLogin = now;

    const msg = (err && err.message) || String(err || '');
    this.beacon('login-goto', msg.slice(0, 120));
    // 已经在登录页上就别再跳一次（用户可能正点着重试）
    const pages = getCurrentPages();
    const top = pages.length ? pages[pages.length - 1].route : '';
    if (top === 'pages/login/login') return;

    wx.reLaunch({ url: '/pages/login/login?why=' + encodeURIComponent(msg.slice(0, 60)) });
  },

  /**
   * 统一请求封装
   * - 后端鉴权失败返回的是 HTTP 200 + body.code === 401（不是 HTTP 401），
   *   因此这里必须判断 body.code，否则 token 过期后所有页面只会静默空白。
   * - silent: 内部调用（如自动登录）不弹错误提示。
   * - timeout: 默认 15 秒够一般的数据库读写；**AI 类接口必须显式传更长**，
   *   因为它在服务端要串起 OCR/语音/大模型，实测偶发 15 秒以上
   *   （2026-09-19 真机就因此报 `request:fail timeout`，用户看到「没成功」）。
   */
  request(url, options = {}) {
    const { silent = false, _retry = false, timeout = 15000 } = options;

    return new Promise((resolve, reject) => {
      wx.request({
        url: this.globalData.apiBase + url,
        method: options.method || 'GET',
        data: options.data || {},
        timeout,
        header: {
          Authorization: 'Bearer ' + (this.globalData.token || ''),
          'Content-Type': 'application/json'
        },
        success: async (res) => {
          const body = res.data || {};

          // 鉴权失败 → 重新登录后重放一次
          if (body.code === 401 && !_retry) {
            try {
              // force：token 已经被服务端判死了，必须真去微信拿新身份，
              // 不能被 checkSession 网关放行成"继续用旧 token"
              await this.login({ force: true });
              const retry = await this.request(url, Object.assign({}, options, { _retry: true }));
              return resolve(retry);
            } catch (err) {
              return reject(err);
            }
          }

          if (!silent && body.code && body.code !== 0) {
            wx.showToast({ title: body.msg || '请求失败', icon: 'none' });
          }
          resolve(body);
        },
        fail: (err) => {
          const raw = (err && err.errMsg) || '';
          const e = new Error(this.explainRequestError(raw));
          e.errMsg = raw;
          if (!silent) wx.showToast({ title: e.message, icon: 'none' });
          reject(e);
        }
      });
    });
  },

  /**
   * 把 wx.request 的原始 errMsg 翻成人话。
   * 原来直接把 errMsg 丢掉，页面只能回一句「处理失败」；真机排查时
   * 「超时」和「域名没白名单」是完全不同的两件事，必须分开说。
   */
  explainRequestError(msg) {
    const m = String(msg || '');
    if (/timeout/i.test(m)) return '等太久了，再试一次';
    if (/url not in domain list/i.test(m)) return '接口域名没在小程序后台白名单里';
    if (/ssl|certificate/i.test(m)) return '证书校验失败';
    if (/network|net::|ERR_/i.test(m)) return '网络断了，检查一下网络';
    const tail = m.replace(/^request:fail\s*/i, '').trim();
    return tail ? '请求失败：' + tail.slice(0, 40) : '请求失败';
  },

  /**
   * 错误信标。
   * 真机上出问题时，服务端 nginx 只记得到「200 + N 字节」，前端拿到响应之后
   * 断在哪一步、为什么断，服务器侧完全看不见。所以让前端主动把「哪一步 + 原因」
   * 报回来。只发这一步的上下文，不带任何账目数据；失败静默，绝不影响主流程。
   */
  beacon(step, detail) {
    try {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const cur = pages && pages.length ? pages[pages.length - 1] : null;
      wx.request({
        url: this.globalData.apiBase + '/debug/beacon',
        method: 'POST',
        timeout: 5000,
        data: {
          step: String(step || ''),
          detail: detail == null ? '' : String(detail),
          page: (cur && cur.route) || '',
          ver: (this.globalData.userInfo && this.globalData.userInfo.id) || ''
        },
        success: () => {},
        fail: () => {}
      });
    } catch (e) {
      /* 信标失败绝不影响业务 */
    }
  },

  /**
   * 首次登录后把「扫码分享进来的邀请关系」落库。
   * 放在登录成功之后立刻做（而不是等绑定手机号），因为邀请关系跟手机号无关，
   * 让被邀请人先记上账才是正事。
   * 失败不重试不打扰 —— 邀请关系丢一次不值得打断用户；成功过就打标记不重复发。
   */
  bindPendingInvite() {
    const inviterId = this.globalData.inviterId;
    if (!inviterId || wx.getStorageSync('inviter_bound')) return;

    this.request('/promote/bind', { method: 'POST', data: { inviterId }, silent: true })
      .then((r) => {
        if (r && r.code === 0) {
          wx.setStorageSync('inviter_bound', 1);
          wx.removeStorageSync('pending_inviter');
          this.globalData.inviterId = null;
          this.beacon('invite-bound', 'inviter=' + inviterId);
        }
      })
      .catch(() => {
        /* 静默失败，下次登录再试 */
      });
  },

  /** 文件上传（图片 / 语音 / 文档共用） */
  /**
   * 文件上传（图片 / 语音 / 文档共用）。
   *
   * ⚠️ 2026-09-20 补 401 自愈：之前只有 request() 会在 token 失效时自动重登重放，
   * 上传这条路径**没有** —— 于是一旦 token 过期或被清掉（清缓存 / 重编译 / 退出登录），
   * 用户按一下录音，看到的就是后端原样返回的「token无效」。
   * 录音和拍照都要先上传，这个洞让**录入主路径在最常见的场景下直接断掉**。
   * 现在和 request() 对齐：先重登、再用新 token 重放一次，用户全程无感。
   */
  upload(filePath, formData = {}, _retry = false) {
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: this.globalData.apiBase + '/file/upload',
        filePath,
        name: 'file',
        formData,
        timeout: 60000,
        header: { Authorization: 'Bearer ' + (this.globalData.token || '') },
        success: async (res) => {
          let body;
          try {
            body = JSON.parse(res.data);
          } catch (e) {
            return reject(new Error('上传返回格式异常'));
          }
          // token 失效 → 重新登录后重放一次（只重放一次，避免死循环）
          if (body && body.code === 401 && !_retry) {
            try {
              // force：token 已经被服务端判死了，必须真去微信拿新身份，
              // 不能被 checkSession 网关放行成"继续用旧 token"
              await this.login({ force: true });
              return resolve(this.upload(filePath, formData, true));
            } catch (err) {
              return reject(err);
            }
          }
          resolve(body);
        },
        fail: (err) => {
          const raw = (err && err.errMsg) || '';
          const e = new Error(this.explainUploadError(raw));
          e.errMsg = raw;
          reject(e);
        }
      });
    });
  },

  /**
   * 把微信的原始 errMsg 翻成人话。
   * 之前这里直接吞掉 errMsg，用户只能看到「上传失败」，完全无法判断是
   * 域名没白名单、网络超时还是文件太大 —— 排查成本极高。
   */
  explainUploadError(msg) {
    const m = String(msg || '');
    if (/url not in domain list/i.test(m)) return '上传域名没在小程序后台白名单里';
    if (/domain/i.test(m) && /not in/i.test(m)) return '上传域名没在小程序后台白名单里';
    if (/timeout/i.test(m)) return '上传超时，检查网络';
    if (/ssl|certificate/i.test(m)) return '证书校验失败';
    if (/abort/i.test(m)) return '上传被中断';
    if (/\b413\b/) return '文件超过 10MB 限制';
    if (/\b403\b/) return '上传被拒绝';
    const tail = m.replace(/^uploadFile:fail\s*/i, '').trim();
    return tail ? '上传失败：' + tail.slice(0, 48) : '上传失败';
  }
});
