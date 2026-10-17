// pages/team/team.js
Page({
  data: {},
  onTapInvite() {
    wx.showModal({
      title: '邀请成员',
      content: '多人协作功能开发中。\n\n当前为单店主模式，记账只属于你。\n\n后续可邀请收银员/会计。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
