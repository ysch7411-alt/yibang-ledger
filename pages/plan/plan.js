// pages/plan/plan.js
const api = require('../../utils/api');

Page({
  data: {
    info: null
  },
  onShow() {
    // 真后端接通时拉 /api/promote/info
    api.getPromoteInfo().then((d) => {
      this.setData({ info: d || { inviteCount: 0, target: 2, unlocked: false, list: [] } });
    }).catch(() => {
      this.setData({ info: { inviteCount: 0, target: 2, unlocked: false, list: [], degraded: true } });
    });
  },
  onTapShowCode() {
    wx.showToast({ title: '推广码生成中…', icon: 'none' });
    // 真后端接通时这里调 /api/promote/wxacode 显示小程序码
    setTimeout(() => {
      wx.showModal({
        title: '邀请码功能',
        content: '微信小程序码生成需要 access_token。\n\n接通真后端后会自动显示你的专属码。',
        showCancel: false,
        confirmText: '知道了'
      });
    }, 800);
  }
});
