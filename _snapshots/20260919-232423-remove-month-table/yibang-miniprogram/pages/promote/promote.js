// pages/promote/promote.js
const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    inviteCount: 0,
    progressPercent: 0,
    inviteList: [],
    rules: [
      '把你的专属邀请链接发给微信好友',
      '好友通过链接注册，并购买 ¥19.9 终身版',
      '累计满 2 人，你免费解锁终身版'
    ]
  },

  onLoad() {
    // 要同时开放「转发给好友」和「分享到朋友圈」两个入口，必须在页面里显式声明
    wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] });
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    // 推广接口尚未上线：降级为 0，页面展示空状态而不是白屏
    const d = await api.safe(app.request('/promote/info', { silent: true }), {});
    const count = Number((d && d.inviteCount) || 0);
    const list = (d && d.list) || [];

    this.setData({
      inviteCount: count,
      progressPercent: Math.min((count / 2) * 100, 100),
      inviteList: list.map((it) => Object.assign({}, it, {
        _initial: (it.name || '友').slice(0, 1)
      })),
      loading: false
    });
  },

  onShareAppMessage() {
    const uid = app.globalData.userId || '';
    // 落在记账页而不是绑定页：好友点进来就能直接记账（合规也要求不能一进来就要手机号），
    // 邀请关系在登录成功后由 app.bindPendingInvite() 自动落库，不依赖绑定手机号。
    return {
      title: '易帮账本 · 说句话就记账，邀请你免费试用',
      path: '/pages/record/record?from=' + uid
    };
  },

  onShareTimeline() {
    return {
      title: '易帮账本 · 说句话就记账',
      query: 'from=' + (app.globalData.userId || '')
    };
  }
});
