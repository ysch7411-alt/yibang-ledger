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
    stat: { records: 0, contacts: 0, days: 0 },

    // 改昵称 / 店名
    showProfile: false,
    form: { nickname: '', shop_name: '' },
    savingProfile: false
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

  /* ---------------- 改昵称 / 店名 ---------------- */

  openProfile() {
    this.setData({
      showProfile: true,
      form: {
        nickname: this.data.userInfo.nickname || '',
        shop_name: this.data.userInfo.shop_name || ''
      }
    });
  },

  closeProfile() {
    this.setData({ showProfile: false });
  },

  onFormShop(e) {
    this.setData({ 'form.shop_name': e.detail.value });
  },

  onFormNick(e) {
    this.setData({ 'form.nickname': e.detail.value });
  },

  async saveProfile() {
    if (this.data.savingProfile) return;
    this.setData({ savingProfile: true });

    const d = await api.safe(
      app.request('/user/profile', { method: 'POST', data: this.data.form, silent: true }),
      null
    );
    this.setData({ savingProfile: false });

    if (!d || !d.user) {
      wx.showToast({ title: '没保存上，再试一次', icon: 'none' });
      return;
    }

    // 同步到全局与本地缓存：首页问候、分享出去的店名都读这里
    app.globalData.userInfo = d.user;
    try {
      wx.setStorageSync('userInfo', d.user);
    } catch (e) {
      /* 存不下不影响本次显示 */
    }

    this.setData({
      showProfile: false,
      userInfo: d.user,
      initial: (d.user.nickname || d.user.shop_name || '易').slice(0, 1)
    });
    wx.showToast({ title: '已保存', icon: 'success' });
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
