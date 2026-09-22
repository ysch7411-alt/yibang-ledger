// pages/advisor/advisor.js
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');

Page({
  data: {
    loading: true,
    stat: { incomeText: '0.00', expenseText: '0.00', netText: '0.00', isPositive: true },
    verdict: '',
    topCustomers: [],
    tips: []
  },

  onShow() {
    this.loadData();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 3 });
  },

  async loadData() {
    this.setData({ loading: true });

    const [month, contacts] = await Promise.all([
      api.getMonthSummary(fmt.ym()),
      api.getContactList(1)
    ]);

    const net = month.income - month.expense;
    const isPositive = net >= 0;

    const debtors = contacts
      .filter((c) => c._balance > 0)
      .sort((a, b) => b._balance - a._balance)
      .slice(0, 5);

    const totalDebt = debtors.reduce((s, c) => s + c._balance, 0) || 1;
    const maxDebt = debtors.length ? debtors[0]._balance : 1;

    const topCustomers = debtors.map((c) => ({
      id: c.id,
      name: c.name,
      amountText: fmt.money(c._balance),
      percent: Math.max(6, Math.round((c._balance / maxDebt) * 100)),
      share: Math.round((c._balance / totalDebt) * 100)
    }));

    this.setData({
      stat: {
        incomeText: fmt.money(month.income),
        expenseText: fmt.money(month.expense),
        netText: fmt.money(Math.abs(net)),
        isPositive
      },
      verdict: this.buildVerdict(net, month, topCustomers),
      topCustomers,
      tips: this.buildTips(net, month, topCustomers)
    });

    this.setData({ loading: false });
  },

  buildVerdict(net, month, top) {
    if (month.income === 0 && month.expense === 0) return '本月还没有记账，先记两笔我就能分析了';
    if (net > 0) return `本月进账比出账多 ¥${fmt.money(net)}，经营是正的`;
    if (net < 0) return `本月出账比进账多 ¥${fmt.money(-net)}，留意一下大额支出`;
    return '本月收支刚好持平';
  },

  /**
   * 经营提示 —— 完全由本地规则生成（不发大模型请求）。
   * 原来标题写成「💡 AI 经营建议」属于过度承诺，这里如实标注为「经营提示」。
   */
  buildTips(net, month, top) {
    const tips = [];

    if (top.length > 0) {
      tips.push({
        title: `优先催收：${top[0].name}`,
        desc: `欠款 ¥${top[0].amountText}，占应收总额的 ${top[0].share}%。先跟这一家沟通，回款效率最高。`
      });
    }

    if (month.income > 0 || month.expense > 0) {
      tips.push(
        net >= 0
          ? { title: '本月盈利', desc: `收入 ¥${fmt.money(month.income)} 覆盖了支出 ¥${fmt.money(month.expense)}，可以按现在的路子继续做。` }
          : { title: '本月超支', desc: `支出 ¥${fmt.money(month.expense)} 高于收入 ¥${fmt.money(month.income)}，建议先翻一遍大额支出项。` }
      );
    }

    if (month.income > 0) {
      const rate = Math.round((month.expense / month.income) * 100);
      tips.push({
        title: `支出占收入 ${rate}%`,
        desc: rate > 80 ? '这个比例偏高，利润空间被压得很薄。' : '这个比例还算健康，留出了利润空间。'
      });
    }

    if (tips.length === 0) {
      tips.push({
        title: '先攒数据',
        desc: '坚持记 1 个月，就能看到收支结构、客户欠款和利润趋势了。'
      });
    }

    return tips.slice(0, 4);
  },

  goSummary() {
    wx.switchTab({ url: '/pages/summary/summary' });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/contact-detail/contact-detail?id=' + id });
  }
});
