// pages/automations/automations.js
/**
 * 自动化列表 + 手动运行
 *
 * 后端 /api/automations（列表）与 /api/automations/run（手动跑一次）现已打通。
 * 运行结果弹层展示，方便老板立刻看到这次生成了什么。
 */
const api = require('../../utils/api');

Page({
  data: {
    list: [],
    loading: true,
    runningId: null,
    result: null
  },

  onShow() { this.load(); },

  load() {
    this.setData({ loading: true });
    api.getAutomations()
      .then((d) => this.setData({ list: (d && d.list) || [], loading: false }))
      .catch((e) => {
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败：' + (e.message || ''), icon: 'none' });
      });
  },

  onRun(e) {
    const id = e.currentTarget.dataset.id;
    const code = e.currentTarget.dataset.code;
    if (this.data.runningId) return;
    this.setData({ runningId: id, result: null });
    api.runAutomation(code || id)
      .then((d) => {
        const r = d && d.data;
        this.setData({
          runningId: null,
          result: r ? { name: r.name, ok: r.ok, text: r.text } : null
        });
        this.load();
      })
      .catch((err) => {
        this.setData({ runningId: null });
        wx.showToast({ title: '运行失败：' + (err.message || ''), icon: 'none' });
      });
  },

  closeResult() { this.setData({ result: null }); },
  noop() {}
});
