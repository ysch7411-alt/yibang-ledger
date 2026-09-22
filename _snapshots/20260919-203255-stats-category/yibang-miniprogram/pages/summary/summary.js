// pages/summary/summary.js
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');

function decorate(list) {
  return list.map((it) => {
    const balance = it._balance;
    const cls = balance >= 0 ? 'c-income' : 'c-expense';
    const name = it.name || '未命名';
    return Object.assign({}, it, {
      _cls: cls,
      _amountText: (balance > 0 ? '+' : balance < 0 ? '-' : '') + '¥' + fmt.money(Math.abs(balance)),
      _initial: name.slice(0, 1)
    });
  });
}

Page({
  data: {
    period: 'today',
    stat: { incomeText: '0.00', expenseText: '0.00', netText: '0.00', isPositive: true, count: 0 },
    receivable: '0.00',
    payable: '0.00',
    receivableCount: 0,
    payableCount: 0,
    activeTab: 'receivable',
    contactList: [],
    loading: true
  },

  onShow() {
    this.loadData();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 1 });
  },

  async loadData() {
    this.setData({ loading: true });
    const [summary, contacts] = await Promise.all([
      api.getContactSummary(),
      api.getContactList()
    ]);

    this.setData({
      receivable: fmt.money(summary.receivable),
      payable: fmt.money(summary.payable),
      receivableCount: contacts.filter((c) => c._balance > 0).length,
      payableCount: contacts.filter((c) => c._balance < 0).length
    });

    await this.loadStat();
    await this.loadContactList();
    this.setData({ loading: false });
  },

  async loadStat() {
    if (this.data.period === 'today') {
      const d = await api.getDailySummary(fmt.ymd());
      this.setData({
        stat: {
          incomeText: d.incomeText,
          expenseText: d.expenseText,
          netText: d.netText,
          isPositive: d.isPositive,
          count: d.count
        }
      });
    } else {
      const m = await api.getMonthSummary(fmt.ym());
      const net = m.income - m.expense;
      this.setData({
        stat: {
          incomeText: fmt.money(m.income),
          expenseText: fmt.money(m.expense),
          netText: fmt.money(Math.abs(net)),
          isPositive: net >= 0,
          count: m.count || 0
        }
      });
    }
  },

  pickPeriod(e) {
    const period = e.currentTarget.dataset.p;
    if (period === this.data.period) return;
    this.setData({ period });
    this.loadStat();
  },

  async loadContactList() {
    const type = this.data.activeTab === 'receivable' ? 1 : 2;
    const list = await api.getContactList(type);
    // 应收按余额从大到小；应付按欠得多的排前面
    const sorted = list
      .filter((it) => (this.data.activeTab === 'receivable' ? it._balance > 0 : it._balance < 0))
      .sort((a, b) => Math.abs(b._balance) - Math.abs(a._balance));
    this.setData({ contactList: decorate(sorted) });
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab, contactList: [] });
    this.loadContactList();
  },

  goToDetail(e) {
    wx.navigateTo({ url: '/pages/contact-detail/contact-detail?id=' + e.currentTarget.dataset.id });
  },

  goRecord() {
    wx.switchTab({ url: '/pages/record/record' });
  },

  shareSummary() {
    const { stat, period } = this.data;
    const label = period === 'today' ? fmt.ymd() : fmt.ym() + ' 整月';
    const text =
      `📊 易帮账本 · ${label}\n\n` +
      `💰 收入：¥${stat.incomeText}\n` +
      `💸 支出：¥${stat.expenseText}\n` +
      `📈 结余：${stat.isPositive ? '+' : '-'}¥${stat.netText}（${stat.count} 笔）\n\n` +
      `智能记账，越记越明白`;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，可发微信', icon: 'none' })
    });
  },

  shareReconciliation() {
    const { contactList, receivable, payable } = this.data;
    let text = `📋 易帮账本 · ${fmt.ymd()} 往来对账\n\n`;
    text += `【别人欠我】共 ¥${receivable}\n`;
    if (contactList.length === 0) text += '暂无\n';
    contactList.slice(0, 8).forEach((it, i) => {
      text += `${i + 1}. ${it.name}：¥${fmt.money(Math.abs(it._balance))}\n`;
    });
    text += `\n【我欠别人】共 ¥${payable}\n\n智能记账，越记越明白`;

    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '对账单已复制', icon: 'none' })
    });
  }
});
