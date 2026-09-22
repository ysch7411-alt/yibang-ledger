// pages/operation-logs/operation-logs.js
const app = getApp();
// 项目统一的日期还原（专门处理 mysql2 把 DATETIME 序列化成 UTC ISO 串这件事）
const fmt = require('../../utils/format');

Page({
  data: {
    list: [],
    loading: true
  },

  onLoad() {
    this.loadLogs();
  },

  onShow() {
    this.loadLogs();
  },

  /**
   * 加载操作日志
   */
  async loadLogs() {
    try {
      this.setData({ loading: true });
      const res = await app.request('/roles/logs');
      
      if (res.code === 0) {
        const list = (res.data || []).map(item => ({
          ...item,
          detail_text: this.formatDetail(item),
          time_text: this.formatTime(item.created_at)
        }));
        this.setData({ list });
      }
    } catch (err) {
      console.error('加载操作日志失败:', err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 格式化操作详情
   */
  formatDetail(item) {
    const data = item.content_parsed || {};
    const action = item.action;

    switch (action) {
      case 'confirm_report':
        return `确认了 ${data.month} 的报表`;
      case 'unconfirm_report':
        return `取消确认了 ${data.month} 的报表`;
      case 'add_member':
        return `添加了成员「${data.target_name || '未知'}」为${data.role_name || ''}`;
      case 'remove_member':
        return `移除了成员「${data.target_name || '未知'}」`;
      case 'change_role':
        return `将「${data.target_name || '未知'}」的角色修改为${data.role_name || ''}`;
      case 'request_unlock':
        return `申请解锁 ${data.month} 的报表${data.reason ? '，原因：' + data.reason : ''}`;
      case 'approve_unlock':
        return `批准解锁了 ${data.month} 的报表`;
      case 'reject_unlock':
        return `拒绝解锁了 ${data.month} 的报表${data.reason ? '，原因：' + data.reason : ''}`;
      default:
        return item.content || '';
    }
  },

  /**
   * 格式化时间
   *
   * ⚠️ 与 notifications.js 的 formatTime 是同一个 bug（界面显示「NaN月NaN日」）：
   * `dateStr.replace(/-/g, '/')` 会把后端返回的 UTC ISO 串
   * "2026-09-21T12:14:00.000Z" 搅成非法日期（那个 replace 本来只为兼容 iOS 解析
   * 'YYYY-MM-DD HH:mm:ss' 而写）。现在先走 fmt.toLocalDate，再加 isNaN 兜底。
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
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return month + '月' + day + '日 ' + hour + ':' + minute;
  }
});
