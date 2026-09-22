// pages/staff/staff.js
const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    userInfo: {},
    initial: '',
    staffList: [],
    pendingCount: 0
  },

  onLoad() {
    const u = app.globalData.userInfo || {};
    this.setData({
      userInfo: u,
      initial: (u.nickname || u.shop_name || '我').slice(0, 1)
    });
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    const staff = await api.getStaffList();
    this.setData({
      staffList: staff.list.map((it) => Object.assign({}, it, {
        _initial: (it._title || '店').slice(0, 1),
        _active: it.status === undefined ? true : Number(it.status) === 1
      })),
      pendingCount: staff.pendingCount,
      loading: false
    });
  },

  goToPending() {
    wx.navigateTo({ url: '/pages/pending/pending' });
  },

  inviteStaff() {
    const uid = app.globalData.userId;
    if (!uid) {
      wx.showToast({ title: '正在登录，请稍后再试', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '邀请员工',
      content: '复制邀请链接发给微信好友，对方接受后即可成为你的员工',
      confirmText: '复制链接',
      success: (res) => {
        if (!res.confirm) return;
        wx.setClipboardData({
          data: 'https://h5.dtzai.cn/invite?boss=' + uid,
          success: () => wx.showToast({ title: '邀请链接已复制', icon: 'none' })
        });
      }
    });
  }
});
