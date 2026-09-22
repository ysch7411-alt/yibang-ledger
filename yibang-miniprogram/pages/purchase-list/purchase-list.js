// pages/purchase-list/purchase-list.js
// 采购单历史 + 分类统计。
//
// 这是一页两种看法，共用一个入口：
//   · 单据 —— 拍过、入过库的单子，点一下就地看明细
//   · 按供应商 / 按品类 —— 同一批采购换两个维度看，回答「这钱都进谁家了」「都买了些什么」
//
// 为什么要并成一页：老板看采购只有两个问题——「那张单子找出来」和「这阵子钱花哪了」。
// 拆成两个页面就要多一个入口、多一次跳转，还会出现两个页面各写一套日期区间对不上的问题。
//
// 统计为什么能拆开：合并成一张采购单是对的（一笔账），但明细行上单独存了
// supplier_name / category，所以统计走明细行、不走表头。表头只有一个供应商名，
// 多供应商的单子一旦合并，靠表头统计就全糊成一团了。
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const cfgStore = require('../../utils/config');

const TABS = [
  { k: 'list', t: '单据' },
  { k: 'supplier', t: '按供应商' },
  { k: 'category', t: '按品类' }
];

const RANGES = [
  { k: 'd7', t: '近 7 天' },
  { k: 'd30', t: '近 30 天' },
  { k: 'month', t: '本月' },
  { k: 'lastMonth', t: '上月' }
];

Page({
  data: {
    tabs: TABS,
    tab: 'list',

    // —— 单据态 ——
    loading: true,
    list: [],
    totalCount: 0,
    expandedId: null,      // 当前展开的单据 id
    detailMap: {},         // id -> 明细数组（懒加载后缓存，避免反复请求）
    detailLoading: 0,

    // —— 统计态 ——
    ranges: RANGES,
    statRange: 'd30',
    statLoading: false,
    stat: null,            // null = 还没取到；取不到时 statFailed=true
    statFailed: false
  },

  onLoad() {
    this._statCache = {};   // 'groupBy|range' -> 统计结果，切来切去不重复请求
    this.syncTabs();
    this.loadList();
  },

  onShow() {
    // 统计维度可以被后台一键关掉：关掉时分段控件收回「单据」，已经停在统计态也要弹回来
    this.syncTabs();
  },

  syncTabs() {
    const statsOn = cfgStore.get('features.purchaseStats', true) !== false;
    const tabs = statsOn ? TABS : [TABS[0]];
    const patch = {};
    if (tabs.length !== this.data.tabs.length) patch.tabs = tabs;
    if (!statsOn && this.data.tab !== 'list') patch.tab = 'list';
    if (Object.keys(patch).length) this.setData(patch);
  },

  /* ---------------- 单据 ---------------- */

  async loadList() {
    const rows = await api.getPurchaseList(1, 50);
    const list = rows.map((r) => Object.assign({}, r, {
      _date: fmt.dayKey(r.order_date) || r.order_date || '',
      _dateLabel: fmt.dayLabel ? fmt.dayLabel(fmt.dayKey(r.order_date) || '') : (fmt.dayKey(r.order_date) || ''),
      _money: fmt.money(r.total_amount),
      _count: Number(r.item_count) || 0,
      _supplier: r.supplier_name || '未写供应商',
      _orderNo: r.order_no || ''
    }));
    this.setData({ list, totalCount: list.length, loading: false });
  },

  /** 点击一行：已展开就收起，否则懒加载明细后展开 */
  async toggleRow(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;

    if (this.data.expandedId === id) {
      this.setData({ expandedId: null });
      return;
    }
    if (this.data.detailMap[id]) {
      this.setData({ expandedId: id });
      return;
    }

    this.setData({ detailLoading: id });
    const detail = await api.getPurchaseDetail(id);
    const items = (detail.items || []).map((it, i) => Object.assign({}, it, {
      _seq: Number(it.seq) || i + 1,
      _name: it.item_name || '未填写品名',
      _spec: it.spec || '',
      _unit: it.unit || '',
      _qty: this.trimNum(it.qty),
      _price: fmt.money(it.unit_price),
      _amount: fmt.money(it.amount),
      _cat: it.category || '',
      // 明细行上带供应商：多供应商的单子合并成一张后，逐行才能看出这一项是谁家的
      _sup: it.supplier_name || ''
    }));

    const map = this.data.detailMap;
    map[id] = items;
    this.setData({ detailMap: map, expandedId: id, detailLoading: 0 });
  },

  /** 2.500 → 2.5：数据库是 DECIMAL，直接显示会拖一堆 0 */
  trimNum(v) {
    const n = fmt.toNum(v);
    if (!n && n !== 0) return '—';
    return String(parseFloat(n.toFixed(3)));
  },

  /* ---------------- 统计 ---------------- */

  switchTab(e) {
    const tab = e.currentTarget.dataset.v;
    if (!tab || tab === this.data.tab) return;
    this.setData({ tab });
    if (tab !== 'list') this.loadStats();
  },

  pickRange(e) {
    const statRange = e.currentTarget.dataset.v;
    if (!statRange || statRange === this.data.statRange) return;
    this.setData({ statRange });
    this.loadStats();
  },

  async loadStats() {
    const { tab, statRange } = this.data;
    if (tab === 'list') return;

    const key = tab + '|' + statRange;
    if (this._statCache[key]) {
      this.setData({ stat: this._statCache[key], statFailed: false, statLoading: false });
      return;
    }

    this.setData({ statLoading: true, statFailed: false });
    const stat = await api.getPurchaseStats({ groupBy: tab, range: statRange });

    // 竞态保护：老板手快连点时，晚到的旧响应不能覆盖新选择
    if (this.data.tab !== tab || this.data.statRange !== statRange) return;

    if (!stat) {
      this.setData({ statLoading: false, stat: null, statFailed: true });
      return;
    }
    this._statCache[key] = stat;
    const noun = tab === 'supplier' ? '供应商' : '品类';
    this.setData({
      statLoading: false,
      statFailed: false,
      stat: Object.assign({}, stat, {
        noun,
        rangeLabel: fmt.rangeOf(statRange).label
      })
    });
  },

  /* ---------------- 通用 ---------------- */

  goRecord() {
    wx.switchTab({ url: '/pages/record/record' });
  },

  onPullDownRefresh() {
    this._statCache = {};
    this.setData({ detailMap: {}, expandedId: null, stat: null });
    const t = this.data.tab === 'list' ? this.loadList() : this.loadStats();
    t.then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return { title: '易帮账本 · 拍一张单子就入库', path: '/pages/record/record' };
  }
});
