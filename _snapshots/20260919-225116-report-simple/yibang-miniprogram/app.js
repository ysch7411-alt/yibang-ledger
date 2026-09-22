// app.js —— 易帮账本
App({
  globalData: {
    userInfo: null,
    userId: null,
    token: '',
    apiBase: 'https://api.dtzai.cn/api',
    // 没绑手机号就要先去注册页；邀请人 id 来自分享路径或小程序码
    needPhone: false,
    inviterId: null
  },

  onLaunch(options) {
    const token = wx.getStorageSync('token');
    const user = wx.getStorageSync('userInfo');
    if (token) this.globalData.token = token;
    if (user) {
      this.globalData.userInfo = user;
      this.globalData.userId = user.id || null;
      this.globalData.needPhone = !!user.needPhone;
    }
    this.captureInvite(options);
    // 主动退出过就不自动登录，等用户自己点「微信一键登录」
    if (!this.isLoggedOut()) {
      this.login().catch(() => {
        /* 启动期登录失败不弹提示，页面各自会走空状态 */
      });
    }
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
   */
  login() {
    // 用户主动退出过就不要再偷偷登回来 —— 否则「退出登录」按下去毫无效果
    if (this.isLoggedOut()) return Promise.reject(new Error('已退出登录'));
    if (this._loginTask) return this._loginTask;

    this._loginTask = new Promise((resolve, reject) => {
      wx.login({
        success: async (res) => {
          if (!res.code) return reject(new Error('wx.login 未返回 code'));
          try {
            const result = await this.request('/user/login', {
              method: 'POST',
              data: { code: res.code },
              silent: true
            });
            if (result && result.code === 0) {
              this.setUser(result.data.token, result.data.user);
              this.bindPendingInvite();
              resolve(result.data);
            } else {
              reject(new Error((result && result.msg) || '登录失败'));
            }
          } catch (err) {
            reject(err);
          }
        },
        fail: reject
      });
    }).finally(() => {
      this._loginTask = null;
    });

    return this._loginTask;
  },

  setUser(token, user) {
    this.globalData.token = token || '';
    this.globalData.userInfo = user || null;
    this.globalData.userId = (user && user.id) || null;
    this.globalData.needPhone = !!(user && user.needPhone);
    wx.setStorageSync('token', token || '');
    wx.setStorageSync('userInfo', user || null);
  },

  /**
   * ⚠️ 曾经这里会把没绑手机号的人 reLaunch 到注册页 —— 已删除，因为那是明确的违规：
   *
   * 微信《开发者合规开发指引》点名了两条：
   *   ①「进入小程序后立即提示授权手机号」—— 用户还没浏览就被要求授权；
   *   ②「用户不同意授权则拒绝提供服务」—— 拒绝后无法继续使用。
   * 正规做法是「先让用户体验完整功能，需要时再请求」。
   *
   * 而且技术上本来就不需要这道门槛：微信静默登录已经拿到 openid，
   * 所有账目都是挂在用户身上的，手机号只是附加信息。绑定入口放在「我的」页，按需触发。
   */
  isLoggedOut() {
    return !!wx.getStorageSync('logged_out');
  },

  /** 退出登录：只清本地登录态（openid 在微信侧，清不掉也不该清）。下次进来需要手动点登录 */
  logout() {
    this.globalData.token = '';
    this.globalData.userInfo = null;
    this.globalData.userId = null;
    this.globalData.needPhone = false;
    wx.removeStorageSync('token');
    wx.removeStorageSync('userInfo');
    wx.setStorageSync('logged_out', 1);
  },

  /** 手动登录（退出后用）：清掉退出标记再走一次静默登录 */
  relogin() {
    wx.removeStorageSync('logged_out');
    this._loginTask = null;
    return this.login();
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
              await this.login();
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
  upload(filePath, formData = {}) {    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: this.globalData.apiBase + '/file/upload',
        filePath,
        name: 'file',
        formData,
        timeout: 60000,
        header: { Authorization: 'Bearer ' + (this.globalData.token || '') },
        success: (res) => {
          try {
            resolve(JSON.parse(res.data));
          } catch (e) {
            reject(new Error('上传返回格式异常'));
          }
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
