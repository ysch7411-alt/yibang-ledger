// pages/bind-phone/bind-phone.js
// 绑定手机号（**不是**注册门槛）。
//
// 为什么改：这一页原来是「强制注册页」—— 没手机号就 reLaunch 到这里，不去不让用。
// 那正好撞上微信《开发者合规开发指引》点名的两条违规：
//   ①「进入小程序后立即提示授权手机号」（用户还没浏览就被要求授权）
//   ②「用户不同意授权则拒绝提供服务」（拒绝后无法继续使用）
// 正规做法是**先让用户完整用上功能，需要时再请求**。所以现在：
//   · 首次进入不再拦截，微信静默登录拿到的 openid 就足够把账记在他名下；
//   · 这一页变成「主动来绑」的页，底部有「先不绑，直接用」；
//   · 入口放在「我的」→「手机号」。
//
// 手机号的价值还是有的，页面里如实说清：换手机能找回、生成给客户的对账单要用。
//
// 关于「手机号快速验证组件」要不要开通（官方文档 2026-09 核实）：
//   **它不是一个需要申请的开关。** 只要小程序是「非个人主体 + 已完成微信认证」就自动可用，
//   并且每个小程序自带 1000 次体验额度（正式/体验/开发版共用，先扣体验额度再扣资源包）。
//   0.03 元/次成功调用，超出后需在 mp 后台「付费管理」买资源包。
//   真正要用不起来只有三种情况：主体/认证不满足、额度用完（前端 errno 1400001）、
//   《用户隐私保护指引》没声明「手机号」。
const app = getApp();
const api = require('../../utils/api');

const MASK = (p) => (p && p.length >= 7 ? p.slice(0, 3) + '****' + p.slice(-4) : p || '');

/** 两套文案。同一页两种身份，别让"绑定手机号"这种工具页的说法出现在新用户第一眼 */
const COPY = {
  welcome: {
    title: '易帮账本',
    slogan: '会思考，越用越懂你的账本',
    sub: '说一句话、拍一张单子，账就记好了',
    cardTitle: '为什么值得注册',
    btn: '一键注册，马上开始',
    btnBusy: '正在注册…',
    skip: '先进入看看'
  },
  bind: {
    title: '绑定手机号',
    slogan: '换手机也能把账本找回来',
    sub: '不绑也能用，这一步只是为了以后更方便',
    cardTitle: '为什么值得绑一下',
    btn: '一键绑定手机号',
    btnBusy: '正在绑定…',
    skip: '先不绑，直接用'
  }
};

Page({
  data: {
    // 欢迎模式：新用户第一次进来看到的"注册页"。默认是绑定模式（从「我的」主动来绑）
    welcome: false,
    t: COPY.bind,
    agreed: false,
    busy: false,
    errorTip: '',
    showTerms: false,
    bound: '',            // 已绑定的手机号（掩码），非空表示已绑定
    values: [
      {
        icon: '/images/ic-scan.svg',
        text: '换手机也能把账本找回来，不怕手机丢了、换机了'
      },
      {
        icon: '/images/ic-say.svg',
        text: '生成给客户的对账单时，账本上要留个能联系到你的号码'
      },
      {
        icon: '/images/ic-learn.svg',
        text: '不读通讯录、不读相册、不发营销短信，只用来认你的账号'
      }
    ],
    terms: [
      {
        t: '我们收集什么',
        d: '只有手机号，来自下面这一次微信授权。微信昵称和头像不做要求，你可以不提供。'
      },
      {
        t: '用来做什么',
        d: '账号识别、换手机后找回、生成给客户的对账单。不会发送营销短信，也不会把手机号给第三方。'
      },
      {
        t: '我们不做的事',
        d: '不读取通讯录、不读取相册、不读取位置。照片和录音只在你主动按住说话或拍照时上传，用于当次识别。'
      }
    ]
  },

  onLoad(options) {
    const welcome = String((options && options.mode) || '') === 'welcome';
    const user = app.globalData.userInfo || {};

    // 已经绑过手机号的人不该再看欢迎页 —— 直接放他进去
    if (welcome && user.phone) {
      app.beacon('welcome-skip-bound', '');
      wx.reLaunch({ url: '/pages/record/record' });
      return;
    }

    this.setData({ welcome, t: welcome ? COPY.welcome : COPY.bind, bound: MASK(user.phone) });
    app.beacon(welcome ? 'welcome-view' : 'bindphone-view', 'bound=' + (user.phone ? 'yes' : 'no'));
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed, errorTip: '' });
  },

  needAgree() {
    if (this.data.busy) return;
    wx.showToast({ title: '请先勾选下面的协议', icon: 'none' });
  },

  /**
   * 退路 —— 这一条是合规的命门，任何时候都要看得见、点得到。
   * 欢迎模式是被 reLaunch 过来的（没有上一页可退），所以直接去记账页。
   */
  skip() {
    app.beacon(this.data.welcome ? 'welcome-skip' : 'bindphone-skip', '');
    const pages = getCurrentPages();
    if (!this.data.welcome && pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/record/record' });
  },

  openTerms() {
    this.setData({ showTerms: true });
  },

  closeTerms() {
    this.setData({ showTerms: false });
  },

  agreeAndClose() {
    this.setData({ agreed: true, showTerms: false, errorTip: '' });
  },

  noop() {
    /* 弹层挡背景滚动用 */
  },

  /**
   * 微信手机号授权回调。
   * e.detail: { errMsg, errno, code }
   *   - code 是给服务端换号码用的一次性凭证（5 分钟有效，只能消费一次）
   *   - errno 1400001 表示「手机号验证次数已达本小程序上限」
   */
  async onGetPhone(e) {
    const d = (e && e.detail) || {};
    const errMsg = String(d.errMsg || '');

    // 额度用尽必须单独判。不判的话会掉进下面「用户取消」的分支，
    // 明明是没额度了却告诉用户"你取消了授权"，把人往完全错的方向引。
    if (Number(d.errno) === 1400001 || /quota/i.test(errMsg)) {
      app.beacon('bindphone-noquota', errMsg + ' errno=' + d.errno);
      this.setData({
        errorTip: '本小程序的手机号验证次数已用完（微信按次收费）。请把这个提示发给易帮账本的工作人员，补充额度后即可绑定。'
      });
      return;
    }

    // 用户点了「不允许」—— 不是错误，给条退路就好
    if (errMsg.indexOf(':ok') === -1) {
      app.beacon('bindphone-deny', errMsg.slice(0, 80) + ' errno=' + d.errno);
      this.setData({ errorTip: '没关系，你可以先用着。这个入口一直在「我的」页，想绑随时点。' });
      return;
    }

    // 基础库太旧拿不到 code（2.21.2 之前只有加密串，本产品不支持那条老路）
    if (!d.code) {
      app.beacon('bindphone-nocode', JSON.stringify(d).slice(0, 120));
      this.setData({ errorTip: '当前微信版本太旧，拿不到授权凭证，请把微信升级到最新版再试。' });
      return;
    }

    if (this.data.busy) return;
    this.setData({ busy: true, errorTip: '' });

    try {
      const r = await api.call(
        app.request('/user/bind-phone', { method: 'POST', data: { code: d.code } })
      );

      if (!r.reached) {
        app.beacon('bindphone-unreached', r.raw || r.msg);
        this.setData({ busy: false, errorTip: r.msg || '网络不通，请检查网络后重试。' });
        return;
      }
      if (r.code !== 0) {
        app.beacon('bindphone-fail', r.code + ' ' + (r.msg || ''));
        this.setData({ busy: false, errorTip: r.msg || '绑定失败，请稍后重试。' });
        return;
      }

      // 服务端回了新 token（带手机号状态），必须落盘
      app.setUser(r.data.token, r.data.user);
      app.beacon('bindphone-ok', '');

      this.setData({ busy: false, bound: MASK(r.data.user && r.data.user.phone) });
      wx.showToast({ title: '绑定成功', icon: 'success', duration: 1200 });
      setTimeout(() => {
        const pages = getCurrentPages();
        if (pages.length > 1) wx.navigateBack();
        else wx.switchTab({ url: '/pages/record/record' });
      }, 900);
    } catch (err) {
      app.beacon('bindphone-throw', (err && err.message) || String(err));
      this.setData({ busy: false, errorTip: '绑定过程出错了，请稍后重试。' });
    }
  }
});
