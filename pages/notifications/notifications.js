// pages/notifications/notifications.js
/**
 * 通知列表 + 标记已读 + 开启每日提醒
 *
 * 后端 /api/notification/list · /read · /read-all 早已就绪，
 * 之前只差前端调用与界面。这里一次性接上：单条"标已读" + "全部已读"。
 *
 * 🔴 2026-10-17 补：把「订阅消息」这一环接上。
 *    `/api/notification/subscribe`（GET 查状态 / POST 记授权）后端一直是对的，
 *    api.js 里也导出了 subscribeStatus / recordSubscribe，但**没有任何页面调用**——
 *    结果是：push_quota 永远是 0，每日提醒永远发不出去，而代码看起来"功能齐全"。
 *    （api.js 里当时还留了一句"'我的'页订阅状态有调用"的注释，那句话是假的。）
 *
 * ⚠️ 模板 ID 只在服务端（PUSH_TMPL_DAILY）配置，前端不硬编码：
 *    没配就整块不出现 —— 给一个点了必然失败的按钮，比不给更糟。
 */
const api = require('../../utils/api');

Page({
  data: {
    list: [],
    loading: true,
    unread: 0,

    /** 订阅消息状态：configured=false 时界面不出现订阅入口 */
    push: { configured: false, tmplId: '', remain: 0, requesting: false }
  },

  onShow() {
    this.load();
    this.loadPush();
  },

  load() {
    this.setData({ loading: true });
    api.listNotifications({ limit: 50 })
      .then((d) => {
        const list = (d && d.list) || [];
        this.setData({
          list,
          unread: list.filter((n) => !n.is_read).length,
          loading: false
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败：' + (e.message || ''), icon: 'none' });
      });
  },

  /** 查订阅状态 —— 失败不报错：看通知本身不受影响，退回"未配置"（= 不显示入口） */
  loadPush() {
    api.subscribeStatus()
      .then((d) => {
        this.setData({
          push: {
            configured: !!(d && d.configured),
            tmplId: (d && d.tmplId) || '',
            remain: (d && d.remain) || 0,
            requesting: false
          }
        });
      })
      .catch(() => {
        this.setData({ 'push.configured': false });
      });
  },

  /**
   * 开启每日提醒。
   *
   * 两段式：① 微信侧 requestSubscribeMessage 拿授权 ② 服务端记额度。
   * 🔴 第二段失败必须说出来 —— 微信那边弹窗已经同意了，服务端没记上的话
   *    提醒照样发不出来，此时报"已开启"就是假成功。
   */
  onSubscribe() {
    const p = this.data.push;
    if (!p.configured || !p.tmplId || p.requesting) return;

    this.setData({ 'push.requesting': true });

    wx.requestSubscribeMessage({
      tmplIds: [p.tmplId],
      success: (r) => {
        const st = r && r[p.tmplId];
        if (st !== 'accept') {
          this.setData({ 'push.requesting': false });
          wx.showToast({
            title: st === 'reject' ? '您拒绝了，没开启' : '这次没开启成功',
            icon: 'none'
          });
          return;
        }
        api.recordSubscribe()
          .then((d) => {
            this.setData({
              'push.requesting': false,
              'push.remain': (d && d.remain) || (p.remain + 1)
            });
            wx.showToast({ title: '已开启每日提醒', icon: 'none' });
          })
          .catch((e) => {
            this.setData({ 'push.requesting': false });
            wx.showModal({
              title: '没记上',
              content: '微信那边已经同意了，但服务端没记录成功：' +
                ((e && e.message) || '未知原因') +
                '\n\n这种情况提醒可能发不出来，请稍后重试。',
              showCancel: false,
              confirmText: '知道了'
            });
          });
      },
      fail: (e) => {
        this.setData({ 'push.requesting': false });
        wx.showModal({
          title: '没开启',
          content: (e && e.errMsg) || '订阅请求失败',
          showCancel: false,
          confirmText: '知道了'
        });
      }
    });
  },

  onRead(e) {
    const id = e.currentTarget.dataset.id;
    api.markNotificationRead(id)
      .then(() => {
        const list = this.data.list.map((n) =>
          n.id === id ? Object.assign({}, n, { is_read: true }) : n
        );
        this.setData({ list, unread: list.filter((n) => !n.is_read).length });
      })
      .catch((err) => {
        wx.showToast({ title: '标记失败：' + (err.message || ''), icon: 'none' });
      });
  },

  onReadAll() {
    if (!this.data.unread) return;
    api.markAllNotificationsRead()
      .then(() => {
        const list = this.data.list.map((n) => Object.assign({}, n, { is_read: true }));
        this.setData({ list, unread: 0 });
        wx.showToast({ title: '已全部标记已读', icon: 'none' });
      })
      .catch((err) => {
        wx.showToast({ title: '操作失败：' + (err.message || ''), icon: 'none' });
      });
  }
});
