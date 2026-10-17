/**
 * pages/report-view/report-view.js —— 分享报表公开查看页
 *
 * 2026-10-15。资料包融合。
 *
 * 路径：/pages/report-view/report-view?token=<64位 hex>
 * 对方不需登录 —— token 就是凭证
 *
 * 设计同 workbuddy srv-tenant/share.js + 我们的 CloudBase PG。
 * 关键：服务端返回的是**快照**（to_date / as_of 已钉死），
 *       老板今天分享「今日报表」，对方明天再打开，数字还是今天的。
 */
const api = require('../../utils/api');

/* 账目类型友好标签（与 lib/db 一致） */
const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };

Page({
  data: {
    loading: true,
    err: '',
    data: null,
    typeText: TYPE_TEXT
  },

  onLoad(opts) {
    const token = String(opts && opts.token || '').trim();
    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      this.setData({ loading: false, err: '分享链接无效' });
      return;
    }
    this._token = token;
    this._load();
  },

  onShareAppMessage() {
    /* 让对方也能从这个小程序卡片二次转发给更多人 */
    if (!this.data.data) return {};
    return {
      title: (this.data.data.shop || '易帮AI') + ' · ' + (this.data.data.label || '报表'),
      path: '/pages/report-view/report-view?token=' + this._token
    };
  },

  _load() {
    api.viewShare(this._token)
      .then((d) => {
        this.setData({ loading: false, data: d || null });
      })
      .catch((e) => {
        this.setData({ loading: false, err: (e && e.message) || '分享链接无效或已过期' });
      });
  }
});
