// pages/search/search.js
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');

const RANGES = [
  { key: 'all', text: '全部' },
  { key: 'today', text: '今天' },
  { key: '7d', text: '近 7 天' },
  { key: 'month', text: '本月' }
];

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

    showAi: false,
    aiInput: '',
    aiHistory: [],
    aiThinking: false,
    scrollTo: '',
    quickAsks: ['这个月赚了多少钱？', '谁欠我最多？', '这个月哪项支出最大？']
  },

  onLoad() {
    this.loadRecords();
  },

  onShow() {
    this.loadRecords();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 2 });
  },

  async loadRecords() {
    this.setData({ loading: true });
    this._all = await api.getRecords(1, 200);
    this.applyFilter();
    this.setData({ loading: false });
  },

  onInput(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  clearKeyword() {
    this.setData({ keyword: '' });
    this.applyFilter();
  },

  pickType(e) {
    this.setData({ typeFilter: e.currentTarget.dataset.t });
    this.applyFilter();
  },

  pickRange(e) {
    this.setData({ range: e.currentTarget.dataset.r });
    this.applyFilter();
  },

  resetFilter() {
    this.setData({ keyword: '', typeFilter: 'all', range: 'all' });
    this.applyFilter();
  },

  noop() {},

  /* ---------------- 筛选 + 高亮 ---------------- */

  applyFilter() {
    const { keyword, typeFilter, range } = this.data;
    const kw = keyword.trim();
    const all = this._all || [];

    const today = fmt.ymd();
    const month = fmt.ym();
    const weekAgo = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return fmt.ymd(d);
    })();

    const matched = all.filter((raw) => {
      const t = Number(raw.type) || 2;

      // 收支口径
      if (typeFilter === 'in' && !fmt.isIncomeType(t)) return false;
      if (typeFilter === 'out' && fmt.isIncomeType(t)) return false;

      // 时间范围（按字符串比较，避免 new Date('YYYY-MM-DD') 被当成 UTC 解析而错一天）
      const day = fmt.dayKey(raw.record_date);
      if (range === 'today' && day !== today) return false;
      if (range === '7d' && day < weekAgo) return false;
      if (range === 'month' && day.slice(0, 7) !== month) return false;

      // 关键字
      if (!kw) return true;
      const hay = [raw.contact_name, raw.content, String(raw.amount), fmt.money(raw.amount)]
        .filter(Boolean)
        .join(' ');
      return hay.toLowerCase().indexOf(kw.toLowerCase()) >= 0;
    });

    // 先分组（分组内会补上展示字段），再对命中文本做高亮切片
    const sections = fmt.groupByDay(matched).map((g) => ({
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
      total: matched.length,
      hasFilter: !!(kw || typeFilter !== 'all' || range !== 'all')
    });
  },

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
