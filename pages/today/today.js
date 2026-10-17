// pages/today/today.js
/**
 * 今天 —— 落地后的第一屏
 *
 * 2026-10-07 云开发版。
 *
 * 🔴 这一页的设计来自一个教训：上一版把「今天」做成独立 tab，
 *   用户连否两次（"5 个 tab 太多"）。现在它是第一个 tab，
 *   而且**只放三样**：今天怎么样、要我管的、近 7 天走势。
 *
 *   「要我管的」排在数字**下面** —— 老板先看该动手的，再看报表。
 */
const api = require('../../utils/api');

function fmt(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0.00';
  return Math.abs(n).toFixed(2);
}

Page({
  data: {
    loading: true,
    err: '',
    shopName: '',
    today: { income: '0.00', expense: '0.00', net: '0.00', cnt: 0 },
    pending: 0,
    trend: [],
    /* 近 7 天进账的相对高度（0~100），用来画小柱子。
       ⚠️ 在服务端算好还是前端算？—— 放前端，因为它只是"画图用的比例"，
       不是给老板看的数字。放后端会为了画图多传一堆无用字段。 */
    bars: []
  },

  onShow() { this.load(); },

  onPullDownRefresh() { this.load(() => wx.stopPullDownRefresh()); },

  load(cb) {
    this.setData({ loading: true, err: '' });

    api.getShop()
      .then((shop) => api.getToday().then((d) => ({ shop, d })))
      .then(({ shop, d }) => {
        const t = (d && d.today) || {};
        const trend = (d && d.trend) || [];

        // 柱状图比例：拿最大那根当 100%
        const max = Math.max.apply(null, trend.map((x) => Number(x.income) || 0).concat([1]));

        this.setData({
          loading: false,
          shopName: (shop && shop.name) || '',
          today: {
            income: fmt(t.income),
            expense: fmt(t.expense),
            net: fmt(t.net),
            cnt: Number(t.cnt) || 0
          },
          pending: Number(d && d.pending) || 0,
          trend: trend,
          bars: trend.map((x) => ({
            date: String(x.date || '').slice(5),      // MM-DD
            h: Math.round((Number(x.income) || 0) / max * 100),
            v: fmt(x.income)
          }))
        });
        if (cb) cb();
      })
      .catch((e) => {
        /* 🔴 如实显示失败 + 原因，**不显示成"今天 0 笔"**。
           "空数据"和"服务挂了"在界面上长得一模一样，
           第一次用的人根本分不清 —— 而分不清就会以为"没数据"，
           然后不再来了。 */
        this.setData({ loading: false, err: e.message || '读取失败' });
        if (cb) cb();
      });
  },

  /** 点柱子 → 问那天的账。
   * 🔴 这里原来是 wx.switchTab —— 本 app 无 tabBar，switchTab 必失败且无提示
   *   （用户看到「按了没动」），且 switchTab 本就不支持携带 query。改 navigateTo。 */
  onTapBar(e) {
    const d = e.currentTarget.dataset.date;
    if (!d) return;
    wx.navigateTo({
      url: '/pages/chat/chat?q=' + encodeURIComponent(d + ' 进账多少')
    });
  },

  /** 快捷提问 —— 老板点一下就能问，不用自己想怎么措辞（同上，switchTab→navigateTo） */
  goAsk(e) {
    const q = e.currentTarget.dataset.q || '';
    wx.navigateTo({ url: '/pages/chat/chat?q=' + encodeURIComponent(q) });
  },

  goExperts() { wx.navigateTo({ url: '/pages/experts/experts' }); },

  retry() { this.load(); }
});