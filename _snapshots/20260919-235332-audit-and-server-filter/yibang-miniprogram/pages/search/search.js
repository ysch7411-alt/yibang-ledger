// pages/search/search.js
//
// 查询页：找出某一笔账。
//
// 关键改动（2026-09-19 用户要求）：**筛选全部挪到服务端**。
// 原来是把最新 200 条拉到本地再筛 —— 搜一个三个月前的人名会静默返回空：
// 用户以为没这笔账，其实是没加载到。数据量越大越明显，而且它不报错、只给错答案。
// 现在每次换条件都重新请求，并且能**上拉加载更多**，多少条都查得完。
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');

/** 时间范围。key 直接复用 fmt.rangeOf 的口径，避免"页面上写一套、算的时候又写一套" */
const RANGES = [
  { key: 'all', text: '全部' },
  { key: 'today', text: '今天' },
  { key: 'd7', text: '近 7 天' },
  { key: 'month', text: '本月' },
  { key: 'lastMonth', text: '上月' }
];

const PAGE_SIZE = 200;   // 一页拉多少。够大，多数查询一页就完；不够就上拉续

Page({
  data: {
    keyword: '',
    typeFilter: 'all',
    range: 'all',
    ranges: RANGES,
    hasFilter: false,

    total: 0,
    sections: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
    failed: false,
    emptyText: '还没有记账',

    showAi: false,
    aiInput: '',
    aiHistory: [],
    aiThinking: false,
    scrollTo: '',
    quickAsks: ['这个月赚了多少钱？', '谁欠我最多？', '这个月哪项支出最大？']
  },

  onLoad() {
    this._page = 1;
    // 不在这儿拉数据：onShow 紧接着就会跑，两处都拉等于进一次页面发两次请求
  },

  onShow() {
    this.reload();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 2 });
  },

  onUnload() {
    if (this._kwTimer) clearTimeout(this._kwTimer);
  },

  /** 到底了 —— 上拉加载下一批 */
  onReachBottom() {
    this.loadMore();
  },

  /** 下拉刷新：列表页的自然手势。开了 enablePullDownRefresh 就必须有它，否则圈一直转 */
  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },

  /* ---------------- 查询 ---------------- */

  /** 把当前筛选条件拼成查询串。分页与服务端筛选共用它，口径只有一处 */
  buildQuery(page) {
    const { keyword, typeFilter, range } = this.data;
    const q = ['page=' + page, 'size=' + PAGE_SIZE, 'withTotal=1'];

    if (range !== 'all') {
      const r = fmt.rangeOf(range);
      q.push('from=' + r.from, 'to=' + r.to);
    }
    if (typeFilter !== 'all') q.push('type=' + typeFilter);

    const kw = String(keyword || '').trim();
    if (kw) q.push('keyword=' + encodeURIComponent(kw));

    return q.join('&');
  },

  /** 重新查第一页（换条件、下拉刷新、进页面都走它） */
  async reload() {
    this.setData({ loading: true, failed: false });
    this._page = 1;

    // 用 call 而不是 safe：要能分清"真没有符合条件的"和"请求没通"，
    // 后者得让用户重试，不能显示成"没有记录"。
    const r = await api.call(app.request('/record/list?' + this.buildQuery(1), { silent: true }));

    if (!r.reached || r.code !== 0) {
      this.setData({ loading: false, failed: true, sections: [], total: 0, hasMore: false });
      return;
    }

    const d = r.data || {};
    this._rows = Array.isArray(d.list) ? d.list : [];
    this.setData({
      loading: false,
      failed: false,
      total: Number(d.total) || 0,
      hasMore: !!d.hasMore
    });
    this.render();
  },

  /** 上拉续下一批，追加到已有结果后面 */
  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });

    const fromPage = this._page || 1;
    const next = fromPage + 1;
    const r = await api.call(app.request('/record/list?' + this.buildQuery(next), { silent: true }));

    // 竞态：加载途中用户改了筛选条件（reload 会把 _page 打回 1），这批就作废 ——
    // 不然后面会把旧条件的结果混进新结果里，列表看着就是错的
    if ((this._page || 1) !== fromPage) {
      this.setData({ loadingMore: false });
      return;
    }
    if (!r.reached || r.code !== 0) {
      this.setData({ loadingMore: false });
      return;
    }

    const d = r.data || {};
    this._page = next;
    this._rows = (this._rows || []).concat(Array.isArray(d.list) ? d.list : []);
    this.setData({
      loadingMore: false,
      total: Number(d.total) || 0,
      hasMore: !!d.hasMore
    });
    this.render();
  },

  /** 分组 + 高亮。数据已经是服务端筛好的，这里只负责摆样子 */
  render() {
    const kw = String(this.data.keyword || '').trim();
    const rows = this._rows || [];

    const sections = fmt.groupByDay(rows).map((g) => ({
      key: g.key,
      label: g.label,
      incomeText: g.incomeText,
      expenseText: g.expenseText,
      hasExpense: g.hasExpense,
      items: g.items.map((r) => Object.assign({}, r, {
        _titleNodes: fmt.highlight(r._title, kw),
        _subNodes: fmt.highlight(r._subText, kw)
      }))
    }));

    this.setData({
      sections,
      hasFilter: this.isFiltered(),
      emptyText: this.emptyHint()
    });
  },

  isFiltered() {
    const { keyword, typeFilter, range } = this.data;
    return !!(String(keyword || '').trim() || typeFilter !== 'all' || range !== 'all');
  },

  /**
   * 空结果时说清是**被哪个条件筛掉的**。
   * 只写一句"没有记录"会让人以为账真的丢了 —— 其实多半是筛选条件太窄。
   */
  emptyHint() {
    const { keyword, typeFilter, range } = this.data;
    const parts = [];
    const kw = String(keyword || '').trim();
    if (kw) parts.push('「' + kw + '」');
    if (typeFilter !== 'all') parts.push(typeFilter === 'in' ? '只收入' : '只支出');
    if (range !== 'all') parts.push(fmt.rangeOf(range).label);
    if (!parts.length) return '还没有记账。记一笔之后这里就能查了';
    return parts.join(' · ') + ' 这些条件下没有记录，把条件放宽一点再试';
  },

  /* ---------------- 筛选交互 ---------------- */

  onInput(e) {
    this.setData({ keyword: e.detail.value });
    // 防抖：每敲一个字就查一次，又费流量又会让结果闪来闪去
    if (this._kwTimer) clearTimeout(this._kwTimer);
    this._kwTimer = setTimeout(() => this.reload(), 350);
  },

  clearKeyword() {
    if (this._kwTimer) clearTimeout(this._kwTimer);
    this.setData({ keyword: '' });
    this.reload();
  },

  pickType(e) {
    const t = e.currentTarget.dataset.t;
    if (t === this.data.typeFilter) return;
    this.setData({ typeFilter: t });
    this.reload();
  },

  pickRange(e) {
    const r = e.currentTarget.dataset.r;
    if (r === this.data.range) return;
    this.setData({ range: r });
    this.reload();
  },

  resetFilter() {
    if (this._kwTimer) clearTimeout(this._kwTimer);
    this.setData({ keyword: '', typeFilter: 'all', range: 'all' });
    this.reload();
  },

  retry() {
    this.reload();
  },

  noop() {},

  goContact(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/contact-detail/contact-detail?id=' + id });
  },

  /** 采购单历史：送货单不在流水列表里，单独给一个入口 */
  goPurchase() {
    wx.navigateTo({ url: '/pages/purchase-list/purchase-list' });
  },

  /* ---------------- AI 问答 ---------------- */

  openAi() {
    this.setData({ showAi: true, scrollTo: '' });
  },

  closeAi() {
    this.setData({ showAi: false, aiThinking: false });
  },

  onAiInput(e) {
    this.setData({ aiInput: e.detail.value });
  },

  askQuick(e) {
    this.setData({ aiInput: e.currentTarget.dataset.q });
    this.sendAi();
  },

  scrollToBottom() {
    this.setData({ scrollTo: 'chatBottom' });
  },

  async sendAi() {
    const q = (this.data.aiInput || '').trim();
    if (!q || this.data.aiThinking) return;

    const history = this.data.aiHistory.concat([{ role: 'user', content: q }]);
    this.setData({ aiHistory: history, aiInput: '', aiThinking: true }, () => this.scrollToBottom());

    try {
      const res = await app.request('/ai/chat', { method: 'POST', data: { question: q }, silent: true });
      if (res && res.code === 0 && res.data && res.data.answer) {
        this.setData({
          aiHistory: history.concat([{ role: 'ai', content: res.data.answer }]),
          aiThinking: false
        });
      } else {
        this.setData({
          aiHistory: history.concat([{
            role: 'ai',
            content: 'AI 问答还在接入中，暂时没法回答这一类问题。\n先用上面的搜索查具体的账，或者去「报表」看汇总。'
          }]),
          aiThinking: false
        });
      }
    } catch (err) {
      this.setData({
        aiHistory: history.concat([{ role: 'ai', content: '网络不太顺畅，稍后再问我一次。' }]),
        aiThinking: false
      });
    }
    this.scrollToBottom();
  }
});
