// pages/notifications/notifications.js
const app = getApp();

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
   */
  formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr.replace(/-/g, '/'));
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
