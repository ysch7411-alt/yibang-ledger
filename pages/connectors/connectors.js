// pages/connectors/connectors.js
/**
 * 连接器列表 + 开通/关闭
 *
 * 后端 /api/connectors（列表，含 opened 状态）与
 * /api/connectors/:code/toggle（开通/关闭）现已打通。
 * 开关是"受控"的——只有后端返回成功才翻转，避免假成功。
 */
const api = require('../../utils/api');

Page({
  data: {
    list: [],
    loading: true,
    busyCode: null
  },

  onShow() { this.load(); },

  load() {
    this.setData({ loading: true });
    api.getConnectors()
      .then((d) => this.setData({ list: (d && d.list) || [], loading: false }))
      .catch((e) => {
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败：' + (e.message || ''), icon: 'none' });
      });
  },

  onToggle(e) {
    const code = e.currentTarget.dataset.code;
    const next = e.detail.value; // 用户想要的新状态
    if (this.data.busyCode) return;
    this.setData({ busyCode: code });
    api.toggleConnector(code, next)
      .then((d) => {
        const r = d && d.data;
        const opened = r ? r.opened : next;
        const list = this.data.list.map((c) =>
          c.code === code ? Object.assign({}, c, { opened: opened }) : c
        );
        this.setData({ list, busyCode: null });
        wx.showToast({ title: opened ? '已开通' : '已关闭', icon: 'none' });
      })
      .catch((err) => {
        this.setData({ busyCode: null });
        wx.showToast({ title: '操作失败：' + (err.message || ''), icon: 'none' });
      });
  }
});
