// pages/notifications/notifications.js
const app = getApp();
// 项目统一的日期还原（专门处理 mysql2 把 DATETIME 序列化成 UTC ISO 串这件事）
const fmt = require('../../utils/format');

Page({
  data: {
    list: [],
    loading: true,
    unreadCount: 0
  },

  onLoad() {
    this.loadNotifications();
  },

  onShow() {
    this.loadNotifications();
  },

  /**
   * 加载通知列表
   */
  async loadNotifications() {
    try {
      this.setData({ loading: true });
      
      const [listRes, unreadRes] = await Promise.all([
        app.request('/notifications/list'),
        app.request('/notifications/unread-count')
      ]);

      if (listRes.code === 0) {
        const list = (listRes.data || []).map(item => ({
          ...item,
          time_text: this.formatTime(item.created_at)
        }));
        this.setData({ list });
      }

      if (unreadRes.code === 0) {
        this.setData({ unreadCount: unreadRes.data.count || 0 });
      }
    } catch (err) {
      console.error('加载通知失败:', err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 点击通知项，标记已读
   */
  async onItemTap(e) {
    const { id } = e.currentTarget.dataset;
    try {
      await app.request('/notifications/read', {
        method: 'POST',
        data: { id }
      });
      // 更新本地状态
      const list = this.data.list.map(item => {
        if (item.id === id) {
          return { ...item, is_read: 1 };
        }
        return item;
      });
      const unreadCount = Math.max(0, this.data.unreadCount - 1);
      this.setData({ list, unreadCount });
    } catch (err) {
      console.error('标记已读失败:', err);
    }
  },

  /**
   * 全部标记已读
   */
  async markAllRead() {
    try {
      const res = await app.request('/notifications/read-all', {
        method: 'POST'
      });
      if (res.code === 0) {
        const list = this.data.list.map(item => ({ ...item, is_read: 1 }));
        this.setData({ list, unreadCount: 0 });
        wx.showToast({ title: '已全部标记已读', icon: 'success' });
      }
    } catch (err) {
      console.error('全部已读失败:', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  /**
   * 格式化时间
   *
   * ⚠️ 这里修过一个真 bug（2026-09-22，界面上显示「NaN月NaN日」）：
   * 原来写的是 `new Date(dateStr.replace(/-/g, '/'))` —— 那个 replace 是为了兼容
   * iOS Safari 对 '2026-09-21 20:14:00' 这种带空格写法的严格解析。
   * 但后端这个接口用的是 `SELECT *`（没走 DATE_FORMAT），mysql2 会把 DATETIME
   * 转成 Date 对象、JSON 序列化后成 **UTC ISO 串** "2026-09-21T12:14:00.000Z"。
   * replace 之后变成 "2026/09/21T12:14:00.000Z" → 非法日期 → getMonth() 返回 NaN。
   * 而且下面那几个 `minutes < 1 / < 60 / < 24 / < 7` 对 NaN 全是 false，
   * 所以一定会掉到最后那个分支把 NaN 显示出来。
   *
   * 修法：先交给 fmt.toLocalDate（它认 ISO 串并保留时区，不会差 8 小时），
   * 认不出来才退回旧的 '-'→'/' 写法。最后加一道 isNaN 兜底 —— 宁可显示空，
   * 也不要给用户看 NaN。（根治仍建议服务端用 DATE_FORMAT 取字符串，见项目约定。）
   */
  formatTime(dateStr) {
    if (!dateStr) return '';
    const date = fmt.toLocalDate(dateStr) || new Date(String(dateStr).replace(/-/g, '/'));
    if (isNaN(date.getTime())) return '';
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return minutes + '分钟前';
    if (hours < 24) return hours + '小时前';
    if (days < 7) return days + '天前';
    
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return month + '月' + day + '日';
  }
});
