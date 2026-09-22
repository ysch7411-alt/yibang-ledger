// pages/pending/pending.js
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');

Page({
  data: {
    loading: true,
    pendingList: []
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    const list = await api.getPendingList();
    this.setData({
      pendingList: list.map((it) => Object.assign({}, it, {
        _staffInitial: (it._staffName || '店').slice(0, 1),
        _tagCls: (fmt.TYPE_STYLE[Number(it.type)] || fmt.TYPE_STYLE[2]).tag
      })),
      loading: false
    });
  },

  async approveRecord(e) {
    this.audit(e.currentTarget.dataset.id, 1, '已通过并入账');
  },

  rejectRecord(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认驳回？',
      content: '驳回后员工可以修改重新提交',
      confirmText: '驳回',
      confirmColor: '#D92D20',
      success: (res) => {
        if (res.confirm) this.audit(id, 2, '已驳回');
      }
    });
  },

  // 审核接口在后端 /staff/approve（原前端调的 /record/approve 不存在，点了不会生效）
  async audit(id, status, okText) {
    wx.showLoading({ title: '处理中…', mask: true });
    try {
      const res = await app.request('/staff/approve', {
        method: 'POST',
        data: { id, status }
      });
      wx.hideLoading();
      if (res && res.code === 0) {
        wx.showToast({ title: okText, icon: 'success' });
        this.loadData();
      } else {
        wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  }
});
