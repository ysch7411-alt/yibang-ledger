// pages/profile/profile.js
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');

/** 手机号掩码：列表里没必要展示完整号码 */
const maskPhone = (p) => (p && String(p).length >= 7 ? String(p).slice(0, 3) + '****' + String(p).slice(-4) : '');

Page({
  data: {
    userInfo: {},
    initial: '',
    isPro: false,
    pendingCount: 0,
    phone: '',
    // 先给一个空结构，避免 wxml 在 loadData 返回前取 memo.xxx 报错
    memo: { termCount: 0, nameCount: 0, learnedFromUser: 0, correctionCount: 0, nameMap: [], reasons: [] },
    stat: { records: 0, contacts: 0, days: 0 }
  },

  onShow() {
    this.loadData();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 4 });
  },

  async loadData() {
    const [user, records, contacts, staff, memo] = await Promise.all([
      api.safe(app.request('/user/info', { silent: true }), {}),
      api.getRecords(1, 200),
      api.getContactList(),
      api.getStaffList(),
      api.getMemoryInfo()
    ]);

    const days = new Set(records.map((r) => fmt.dayKey(r.record_date)));
    const info = user || {};

    this.setData({
      userInfo: info,
      // 头像用昵称首字，替代原来的 👤 emoji —— emoji 在各端字形不一致
      initial: (info.nickname || info.shop_name || '易').slice(0, 1),
      // plan_type: 0 免费 / 1 终身 —— 原实现读的是不存在的 plan 字段，付费用户永远显示「免费版」
      isPro: Number(info.plan_type) > 0,
      pendingCount: staff.pendingCount,
      phone: maskPhone(info.phone),
      memo,
      stat: {
        records: records.length,
        contacts: contacts.length,
        days: days.size
      }
    });
  },

  goToStaff() {
    wx.navigateTo({ url: '/pages/staff/staff' });
  },
  goToPlan() {
    wx.navigateTo({ url: '/pages/plan/plan' });
  },
  goToPromote() {
    wx.navigateTo({ url: '/pages/promote/promote' });
  },
  goToAccount() {
    wx.navigateTo({ url: '/pages/account/account' });
  },

  showAbout() {
    wx.showModal({
      title: '易帮账本',
      content: '说句话、拍张照就能记账，账目永不丢。\n\n出品：重庆大头针人工智能有限责任公司\n版本：v1.0.0',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
