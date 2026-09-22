// pages/account/account.js
// 账号与安全：手机号绑定、退出登录、注销账号。
//
// 为什么必须有这一页（不是可选项）：微信《开发者合规开发指引》明确要求
// 「带有账户系统的小程序，必须开发清晰可找、正常可用的退出注销功能，
// 用户可自主注销账号、清除个人数据」。
// 原来「我的」页里那个「设置」点开只弹一句「设置功能开发中」—— 属于"未完善功能"，
// 审核会挑，而且用户真要注销账号时根本找不到入口。这里把它替换成真页面。
const app = getApp();
const api = require('../../utils/api');

const MASK = (p) => (p && p.length >= 7 ? p.slice(0, 3) + '****' + p.slice(-4) : p || '');

Page({
  data: {
    loggedIn: false,
    phone: '',
    userId: null,
    busy: false
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const user = app.globalData.userInfo || {};
    this.setData({
      loggedIn: !!app.globalData.userId,
      phone: MASK(user.phone),
      userId: app.globalData.userId || null
    });
  },

  goBindPhone() {
    wx.navigateTo({ url: '/pages/bind-phone/bind-phone' });
  },

  /**
   * 退出登录。
   * 实话实说：小程序的账号绑在微信上，**退出也退不掉这个绑定** ——
   * 重新登录还是同一个账号。想换账号只能换微信号。
   * 所以这里写清楚它到底做了什么，不要给用户"换个账号试试"的错觉。
   *
   * ⚠️ 第②条是 2026-09-20 加的：退出改成只在**本次运行**内有效之后，
   * 下次打开小程序会自动用微信再登一次。不写出来的话，用户会以为"我明明退出了"，
   * 结果重进又看到自己的账 —— 那比不让他退出更让人心里没底。
   */
  logout() {
    if (this.data.busy) return;
    wx.showModal({
      title: '退出登录',
      content: '退出后这台手机就不再登录了。\n\n两点说明：\n① 账号绑在你的微信上，重新登录还是同一个账号，想换账号要换微信号；\n② 下次打开小程序，会自动用微信再登录一次。',
      confirmText: '退出',
      success: (r) => {
        if (!r.confirm) return;
        app.logout();
        app.beacon('logout', '');
        this.refresh();
        wx.showToast({ title: '已退出', icon: 'success' });
      }
    });
  },

  /** 退出后再点登录：清掉退出标记，重新走一次微信静默登录 */
  async relogin() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    wx.showLoading({ title: '登录中…', mask: true });
    try {
      await app.relogin();
      wx.hideLoading();
      this.setData({ busy: false });
      this.refresh();
      wx.showToast({ title: '已登录', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showToast({ title: '登录失败，请重试', icon: 'none' });
    }
  },

  /**
   * 注销账号：两次确认 + 强提示，然后彻底删数据。
   * 这是不可逆操作，必须让用户清楚知道后果，并建议他先留存。
   */
  deleteAccount() {
    if (this.data.busy || !this.data.loggedIn) return;

    wx.showModal({
      title: '注销账号',
      content: '会永久删除你的全部账目、往来对象、采购单和上传的照片，无法恢复。\n\n建议先到「报表」截图留存。先备份过再继续。',
      confirmText: '我已备份',
      confirmColor: '#D92D20',
      success: (r1) => {
        if (!r1.confirm) return;
        wx.showModal({
          title: '最后确认',
          content: '删除后没有任何办法找回。确定要注销这个账号吗？',
          confirmText: '确认注销',
          confirmColor: '#D92D20',
          success: async (r2) => {
            if (!r2.confirm) return;
            await this.doDelete();
          }
        });
      }
    });
  },

  async doDelete() {
    this.setData({ busy: true });
    wx.showLoading({ title: '正在删除…', mask: true });
    try {
      const r = await api.call(
        app.request('/user/delete-account', {
          method: 'POST',
          data: { confirm: 'DELETE' },
          silent: true,
          timeout: api.AI_TIMEOUT     // 删的表多，给足时间
        })
      );
      wx.hideLoading();
      this.setData({ busy: false });

      if (!r.reached) {
        wx.showModal({ title: '没删成', content: r.msg || '网络不通，请稍后重试。', showCancel: false });
        return;
      }
      if (r.code !== 0) {
        wx.showModal({ title: '没删成', content: r.msg || '服务端拒绝了这次请求', showCancel: false });
        return;
      }

      app.beacon('account-deleted', '');
      app.logout();
      wx.showModal({
        title: '已注销',
        content: '你的数据已经全部删除。这个微信号下次进入会是一个全新的空账本。',
        showCancel: false,
        confirmText: '知道了',
        success: () => wx.switchTab({ url: '/pages/record/record' })
      });
    } catch (err) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showModal({ title: '没删成', content: '删除过程出错，请稍后重试。', showCancel: false });
    }
  }
});
