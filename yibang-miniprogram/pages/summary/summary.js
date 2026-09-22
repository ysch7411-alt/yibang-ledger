// pages/summary/summary.js
//
// 「分享报表」这一块的设计口径（2026-09-19 用户明确要求「分享带明细的报表」）：
//
// 原来两个分享按钮其实都是**把汇总数字复制到剪贴板**，一条明细都没有 ——
// 老板发出去的东西自己都没法核，对方更看不出这钱花在哪。
//
// 两条路，各有各的用处，都要有：
//   · 发图片：微信里最顺的动作（不用点链接），一屏能看完，适合发给老婆/合伙人/员工
//   · 复制文字：明细**全量**不截断，适合要粘进表格或逐条核的场景（图片给不了全量）
//
// 为什么不做 H5 分享链接：用户明确说过「H5 先不做，现在只做 A 套」。
// 后端虽然有 /share/create，但这一版不启用（别让它在没渲染页的情况下露出去）。
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const cal = require('../../utils/calendar');
const cv = require('../../utils/canvas');

/* ---------------- 报表图的版式常量 ----------------
   图和算高两处必须用同一套数字，所以全部提上来做常量。
   画完会断言「实际用掉的高度 == 事先算的高度」，drift 会当场报出来。

   FONT / roundRect / fitText / dpr / 导出 / 发图 这些通用零件在 utils/canvas.js ——
   分销海报（pages/promote）用的是同一套，别再在页面里各写一份。 */
const W = 750;            // 逻辑宽度（就是 rpx 1:1，便于跟设计稿对照）
const PAD = 44;           // 左右留白
const ROW_H = 92;         // 明细行高
const MAX_ROWS = 20;      // 图上最多画几行明细

const { C, FONT, roundRect, fitText } = cv;

/** 往来列表的展示字段（头像首字 + 带符号余额） */
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
    periodLabel: '今日',
    customDate: '',
    stat: { incomeText: '0.00', expenseText: '0.00', netText: '0.00', isPositive: true, count: 0 },
    receivable: '0.00',
    payable: '0.00',
    receivableCount: 0,
    payableCount: 0,
    activeTab: 'receivable',
    contactList: [],
    loading: true,

    // 分享
    shareSheet: false,
    sharing: false,
    rowCount: 0,      // 本期明细笔数，按钮上要显示「带 N 笔明细」
    // 分享给他人看的访问凭证。小程序不能代码触发转发、onShareAppMessage 又必须**同步**返回 path，
    // 所以 token 必须提前备好 —— 没备好时按钮就不给点，绝不能分享出一个打不开的链接。
    shareToken: '',
    shareReady: false,
    sharePreparing: false,
    // 离屏画布的实际尺寸，draw 之前回填
    canvasW: W,
    canvasH: 600,

    /* ---------- 报表日历 ---------- */
    // 默认**收起**：日历很占屏，而老板进报表页十次有九次只是想看今天的数。
    // 想看每天的账时点一下再展开，顺手关掉也不用记着"上次开着"。
    calOpen: false,
    calBy: 'day',                       // day | month | year
    calWeek: ['日', '一', '二', '三', '四', '五', '六'],
    calTitle: '',
    calCells: [],
    calSelKey: '',
    calSel: null,                       // 选中格子的汇总；没选中就没有这张卡
    calLoading: false,
    calFailed: false,
    calHasNext: false,                  // 能不能往后翻（不能翻到未来）

    /* ---------- 每日汇总表 ---------- */
    // null = 还没加载 / 取不到；取不到时用 dayTableFailed 区分，别画成一张 0 表
    dayTable: null,
    dayTableOpen: false,  // 每日汇总表默认收起，首屏只留核心数据
    dayTotal: null,
    dayTableTitle: '',
    dayTableFailed: false,

    // 点开某一天看明细（默认收起，汇总表里只有数字）
    dayOpenKey: '',
    dayDetails: [],
    dayLoading: false,
    dayFail: false,
    // 角色与报表确认
    myRole: null,
    canConfirmReport: false,
    reportStatus: null,
    currentMonth: '',
    confirming: false,
    // 申请解锁弹层
    showUnlock: false,
    unlockReason: '',
    unlocking: false
  },

  onShow() {
    this.loadData();
    this.loadRoleAndReport();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 1 });
  },

  /**
   * 加载角色信息和本月报表状态
   */
  async loadRoleAndReport() {
    try {
      // 获取当前月份
      const now = new Date();
      const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      this.setData({ currentMonth: month });

      // 并行加载角色信息和报表状态
      const [roleRes, reportRes] = await Promise.all([
        app.request('/roles/my-role'),
        app.request('/reports/status?month=' + month)
      ]);

      if (roleRes.code === 0) {
        this.setData({
          myRole: roleRes.data.role,
          canConfirmReport: roleRes.data.can_confirm_report
        });
      }

      if (reportRes.code === 0) {
        this.setData({ reportStatus: reportRes.data });
      }
    } catch (err) {
      console.error('加载角色和报表状态失败:', err);
    }
  },

  /**
   * 确认本月报表（经理/店主操作）
   */
  async confirmReport() {
    if (this.data.confirming) return;

    wx.showModal({
      title: '确认报表',
      content: '确认后本月报表将同步给所有老板查看，确认后不可修改（如需修改请联系店主）。',
      confirmText: '确认',
      success: async (res) => {
        if (res.confirm) {
          this.setData({ confirming: true });
          try {
            const result = await app.request('/reports/confirm', {
              method: 'POST',
              data: { month: this.data.currentMonth }
            });
            if (result.code === 0) {
              wx.showToast({ title: '报表已确认', icon: 'success' });
              this.loadRoleAndReport();
            } else {
              wx.showToast({ title: result.msg || '确认失败', icon: 'none' });
            }
          } catch (err) {
            console.error('确认报表失败:', err);
            wx.showToast({ title: '确认失败', icon: 'none' });
          } finally {
            this.setData({ confirming: false });
          }
        }
      }
    });
  },

  /**
   * 打开申请解锁弹层
   */
  openUnlock() {
    this.setData({ showUnlock: true, unlockReason: '' });
  },

  /**
   * 关闭申请解锁弹层
   */
  closeUnlock() {
    this.setData({ showUnlock: false });
  },

  /**
   * 输入解锁原因
   */
  onUnlockReason(e) {
    this.setData({ unlockReason: e.detail.value });
  },

  /**
   * 提交解锁申请
   */
  async submitUnlock() {
    if (this.data.unlocking) return;
    
    this.setData({ unlocking: true });
    try {
      const res = await app.request('/reports/request-unlock', {
        method: 'POST',
        data: {
          month: this.data.currentMonth,
          reason: this.data.unlockReason
        }
      });

      if (res.code === 0) {
        wx.showToast({ title: '申请已提交', icon: 'success' });
        this.setData({ showUnlock: false });
        this.loadRoleAndReport();
      } else {
        wx.showToast({ title: res.msg || '提交失败', icon: 'none' });
      }
    } catch (err) {
      console.error('申请解锁失败:', err);
      wx.showToast({ title: '提交失败', icon: 'none' });
    } finally {
      this.setData({ unlocking: false });
    }
  },

  /**
   * 取消确认报表（店主操作）
   */
  unconfirmReport() {
    wx.showModal({
      title: '取消确认',
      content: '取消确认后，报表将恢复为草稿状态，老板端将不再显示"已确认"。确定要取消吗？',
      confirmText: '取消确认',
      confirmColor: '#F04438',
      success: async (res) => {
        if (res.confirm) {
          try {
            const result = await app.request('/reports/unconfirm', {
              method: 'POST',
              data: { month: this.data.currentMonth }
            });
            if (result.code === 0) {
              wx.showToast({ title: '已取消确认', icon: 'success' });
              this.loadRoleAndReport();
            } else {
              wx.showToast({ title: result.msg || '操作失败', icon: 'none' });
            }
          } catch (err) {
            console.error('取消确认失败:', err);
            wx.showToast({ title: '操作失败', icon: 'none' });
          }
        }
      }
    });
  },

  onUnload() {
    this._rows = null;
  },

  async loadData() {
    // 已经有数据就不闪骨架屏。
    // 老板在 tab 之间来回切是最常见的操作，而每次 onShow 都会回到这里 ——
    // 无脑 setData({loading:true}) 会让内容先变成一片灰条再变回来，数据其实没变，
    // 纯粹是视觉抖动，还让人以为"卡了一下"。首次进来（_loaded 还没置）才需要它。
    if (!this._loaded) this.setData({ loading: true });

    // 游标只初始化一次：从别的 tab 切回来不该把老板翻到的月份弹回今天
    if (!this._cursor) {
      const t = cal.todayParts();
      this._cursor = { y: t.y, m: t.m };
      this._todayKey = cal.dayKey(t.y, t.m, t.d);
    }

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

    // 三件事互不依赖，一起发出去，别串行等。
    // 日历收起时**不请求** —— 收起状态下去拉一份没人看的数据是白花老板的流量。
    const jobs = [this.loadStat(), this.loadContactList(), this.loadDayTable()];
    if (this.data.calOpen) jobs.push(this.loadCalendar());
    await Promise.all(jobs);
    this.setData({ loading: false });
    this._loaded = true;
  },

  /** 展开 / 收起日历。展开时才去拉数据，且每次都重新拉（数据新的） */
  toggleCal() {
    const open = !this.data.calOpen;
    this.setData({ calOpen: open });
    if (open) this.loadCalendar();
  },

  /** 展开 / 收起每日汇总表。首屏默认收起，只留核心数据，减少视觉噪音 */
  toggleDayTable() {
    this.setData({ dayTableOpen: !this.data.dayTableOpen });
  },

  /* ================= 报表日历 ================= */

  /**
   * 按当前粒度拉数据并铺成格子。
   * 三种粒度的查询范围：
   *   day   → 游标所在的那一个月
   *   month → 游标所在的那一年
   *   year  → 全部（不传区间）
   */
  async loadCalendar() {
    const by = this.data.calBy;
    const c = this._cursor;
    this.setData({ calLoading: true, calFailed: false });

    let from = '';
    let to = '';
    let title = '';

    if (by === 'day') {
      const r = cal.monthRange(c.y, c.m);
      from = r.from;
      to = r.to;
      title = c.y + ' 年 ' + c.m + ' 月';
    } else if (by === 'month') {
      const r = cal.yearRange(c.y);
      from = r.from;
      to = r.to;
      title = c.y + ' 年';
    } else {
      title = '全部年份';
    }

    const d = await api.getGroupSummary(by, from, to);

    if (!d) {
      this.setData({ calLoading: false, calFailed: true, calCells: [] });
      return;
    }

    // key → 汇总，铺格子和点选都查这张表。
    // 挂在实例上而不是 data 里：它是渲染用的中间产物，塞进 data 会让每次 setData 都拖着它。
    const map = {};
    d.list.forEach((x) => { map[x.key] = x; });
    this._calMap = map;

    const cells = this.buildCells(by, c, map);

    // 选中的那一格如果还在这一屏里，就跟着更新数据；不在就清掉选中
    const sel = map[this.data.calSelKey] || null;

    // 「能不能往后翻」判的是**下一格**是不是未来，不是当前格 ——
    // 判当前格的话，9 月里"下一格是 10 月"会被判成可以，翻过去只看到一片空白。
    const nextM = cal.addMonths(c.y, c.m, 1);
    const hasNext = by === 'day'
      ? !cal.isFutureMonth(nextM.y, nextM.m)
      : by === 'month'
        ? !cal.isFutureYear(c.y + 1)
        : false;

    this.setData({
      calLoading: false,
      calTitle: title,
      calCells: cells,
      calSel: sel ? this.decorateSel(sel, by) : null,
      calHasNext: hasNext
    });
  },

  buildCells(by, c, map) {
    const cells = [];

    if (by === 'day') {
      const g = cal.monthGrid(c.y, c.m);
      // 表头从「日」开始，所以 1 号之前空几格就是 getDay()
      for (let i = 0; i < g.lead; i++) cells.push({ k: '', n: '', blank: true });
      for (let d = 1; d <= g.days; d++) {
        const k = cal.dayKey(c.y, c.m, d);
        const hit = map[k];
        cells.push({
          k,
          n: d,
          has: !!hit,
          // 格子里只放"有没有进账/出账"的色条，不放金额：
          // 7 列格子一列才 96rpx，金额塞进去只能是小字，而小字这个项目的老板看不清
          income: !!(hit && hit.income > 0),
          expense: !!(hit && hit.expense > 0),
          isToday: k === this._todayKey
        });
      }
      // 补到 7 的整数倍，行尾不缺角
      while (cells.length < g.total) cells.push({ k: '', n: '', blank: true });
      return cells;
    }

    if (by === 'month') {
      for (let m = 1; m <= 12; m++) {
        const k = cal.monthKey(c.y, m);
        cells.push(this.mkBigCell(k, m + ' 月', map[k]));
      }
      return cells;
    }

    // 年视图：把查到的年份铺成格子（近的在前）。没数据就给个空数组，
    // 页面显示"还没有记账"，而不是硬凑几个空年份出来。
    return (map ? Object.keys(map) : [])
      .sort((a, b) => (a < b ? 1 : -1))
      .map((k) => this.mkBigCell(k, k + ' 年', map[k]));
  },

  /** 月/年视图的格子大得下数字，就直接给收支，省得再点一下 */
  mkBigCell(k, label, hit) {
    return {
      k,
      n: label,
      has: !!hit,
      income: !!(hit && hit.income > 0),
      expense: !!(hit && hit.expense > 0),
      _income: hit ? fmt.money(hit.income) : '',
      _expense: hit ? fmt.money(hit.expense) : '',
      tappable: true
    };
  },

  decorateSel(x, by) {
    const label = by === 'day' ? x.key.slice(5).replace('-', ' 月 ') + ' 日'
      : by === 'month' ? x.key.slice(0, 4) + ' 年 ' + Number(x.key.slice(5)) + ' 月'
        : x.key + ' 年';
    return {
      key: x.key,
      label,
      _income: x._income,
      _expense: x._expense,
      _net: (x._isPositive ? '+' : '-') + '¥' + x._netAbs,
      _isPositive: x._isPositive,
      count: x.count
    };
  },

  pickCalBy(e) {
    const by = e.currentTarget.dataset.by;
    if (!by || by === this.data.calBy) return;
    // 换粒度时清掉选中：'2026-09-19' 这个 key 在月视图里没有对应格子，
    // 留着会让下面那张卡一直显示一个跟当前视图无关的日子
    this.setData({ calBy: by, calSelKey: '', calSel: null });
    this.loadCalendar();
  },

  calPrev() {
    const c = this._cursor;
    if (this.data.calBy === 'day') {
      const n = cal.addMonths(c.y, c.m, -1);
      this._cursor = { y: n.y, m: n.m };
    } else if (this.data.calBy === 'month') {
      this._cursor = { y: c.y - 1, m: c.m };
    } else {
      return;
    }
    this.setData({ calSelKey: '', calSel: null });
    this.loadCalendar();
  },

  calNext() {
    if (!this.data.calHasNext) return;   // 不让翻到未来
    const c = this._cursor;
    if (this.data.calBy === 'day') {
      const n = cal.addMonths(c.y, c.m, 1);
      this._cursor = { y: n.y, m: n.m };
    } else {
      this._cursor = { y: c.y + 1, m: c.m };
    }
    this.setData({ calSelKey: '', calSel: null });
    this.loadCalendar();
  },

  calToday() {
    const t = cal.todayParts();
    this._cursor = { y: t.y, m: t.m };
    this.setData({ calSelKey: '', calSel: null });
    this.loadCalendar();
  },

  /** 点格子 → 在日历下面给出这一格的汇总。**只给汇总，不列每笔** */
  pickCell(e) {
    const k = e.currentTarget.dataset.k;
    if (!k) return;
    // 再点一次同一个格子就收起来（省钱不占地方）
    if (this.data.calSelKey === k) {
      this.setData({ calSelKey: '', calSel: null });
      return;
    }
    const x = (this._calMap || {})[k];
    this.setData({
      calSelKey: k,
      calSel: x ? this.decorateSel(x, this.data.calBy) : {
        key: k,
        label: this.calLabelOf(k),
        _income: '0.00',
        _expense: '0.00',
        _net: '+¥0.00',
        _isPositive: true,
        count: 0
      }
    });
  },

  calLabelOf(k) {
    const by = this.data.calBy;
    if (by === 'day') return k.slice(5).replace('-', ' 月 ') + ' 日';
    if (by === 'month') return k.slice(0, 4) + ' 年 ' + Number(k.slice(5)) + ' 月';
    return k + ' 年';
  },

  /* ================= 两张汇总表 ================= */

  /**
   * 每日汇总表 → 本月。
   *
   * 原来还有一张「近 12 个月 · 每月汇总」，2026-09-19 按用户要求删掉了：
   * 月度是低频数据，摆在报表页只占地方；要看某个月的账，去「查询」页按范围筛
   * （那边有「本月」，而且会按天分组给出每天的收支）。
   *
   * 表格固定「本月」、不跟日历翻页联动：表格是用来**对比**的（这个月哪天多哪天少），
   * 日历是用来**查**的。两个东西绑在一起，翻个月表格就变，反而不好比。
   * **表格里不列每笔** —— 点某一行才展开那天的明细。
   */
  async loadDayTable() {
    const t = cal.todayParts();
    const mr = cal.monthRange(t.y, t.m);
    const day = await api.getGroupSummary('day', mr.from, mr.to);

    // 表格里的日期只用「09-19」，整张表都在同一个月里，年份是噪声
    const rows = day ? day.list.map((x) => Object.assign({}, x, { _label: x.key.slice(5) })) : null;

    this.setData({
      dayTable: rows,
      dayTotal: day ? day.total : null,
      dayTableFailed: !day,
      dayTableTitle: t.y + ' 年 ' + t.m + ' 月 · 每日汇总'
    });
  },

  retryDayTable() {
    this.loadDayTable();
  },

  /**
   * 点每日汇总表的某一行 → 展开那一天的逐笔明细。
   *
   * 为什么明细不跟表格一起加载：本月可能有几十天、几百笔，一股脑全拉下来
   * 既慢又白花流量 —— 老板多数时候只想看"哪天多哪天少"。
   * 汇总先给，明细按需点开。
   */
  async toggleDayRow(e) {
    const k = e.currentTarget.dataset.k;
    if (!k) return;

    // 再点同一行就收起来
    if (this.data.dayOpenKey === k) {
      this.setData({ dayOpenKey: '', dayDetails: [], dayFail: false });
      return;
    }

    this.setData({ dayOpenKey: k, dayDetails: [], dayLoading: true, dayFail: false });

    // 用 call 而不是 getRecords：要能分清"这天真没账"和"请求没到"。
    // getRecords 内部是 safe()，失败也返回空数组，两种情况就糊在一起了。
    const r = await api.call(
      app.request(`/record/list?page=1&size=200&from=${k}&to=${k}`, { silent: true })
    );

    // 竞态保护：手快连点两行时，晚到的旧响应不能盖掉现在选中的那行
    if (this.data.dayOpenKey !== k) return;

    if (!r.reached || r.code !== 0) {
      this.setData({ dayLoading: false, dayFail: true });
      return;
    }

    const raw = Array.isArray(r.data) ? r.data : ((r.data && r.data.list) || []);
    const list = raw
      .map(fmt.decorateRecord)
      .map((x) => ({ id: x.id, time: x._time, title: x._title, amount: x._amount, cls: x._cls, calc: x._calc }))
      // 明细按时间**正序**：看一天的账是从早读到晚，不是倒着翻
      .reverse();

    this.setData({ dayLoading: false, dayDetails: list });
  },

  retryDay() {
    const k = this.data.dayOpenKey;
    if (!k) return;
    this.setData({ dayOpenKey: '' });
    this.toggleDayRow({ currentTarget: { dataset: { k } } });
  },

  retryCalendar() {
    this.loadCalendar();
  },

  async loadStat() {
    const period = this.data.period;
    const now = new Date();

    // 计算周期标签
    let label = '今日';
    let queryDate = fmt.ymd();

    if (period === 'yesterday') {
      const y = new Date(now.getTime() - 86400000);
      queryDate = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
      label = '昨日';
    } else if (period === 'today') {
      label = '今日';
    } else if (period === 'month') {
      label = '本月';
    } else if (period === 'year') {
      label = now.getFullYear() + '年';
    }

    this.setData({ periodLabel: label });

    // 日汇总（昨日/今日/自选日期）
    if (period === 'today' || period === 'yesterday' || period === 'custom') {
      const date = period === 'custom' ? (this.data.customDate || queryDate) : queryDate;
      const d = await api.getDailySummary(date);
      this._rows = d.details || [];
      if (period === 'custom') {
        this.setData({ periodLabel: date.slice(5) + '日' });
      }
      this.setData({
        stat: {
          incomeText: d.incomeText,
          expenseText: d.expenseText,
          netText: d.netText,
          isPositive: d.isPositive,
          count: d.count
        },
        rowCount: d.count || this._rows.length
      });
      return;
    }

    // 本年汇总
    if (period === 'year') {
      const yearStart = now.getFullYear() + '-01-01';
      const yearEnd = now.getFullYear() + '-12-31';
      const y = await api.getRangeSummary(yearStart, yearEnd);
      const net = y.income - y.expense;
      this.setData({
        stat: {
          incomeText: fmt.money(y.income),
          expenseText: fmt.money(y.expense),
          netText: fmt.money(Math.abs(net)),
          isPositive: net >= 0,
          count: y.count || 0
        }
      });
      // 本年明细
      const rows = await api.getRecords(1, 500, { from: yearStart, to: yearEnd });
      this._rows = rows.map(fmt.decorateRecord);
      this.setData({ rowCount: y.count || this._rows.length });
      return;
    }

    // 本月汇总
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

    // 本月明细要按区间单独拉。取到 500 条是接口上限，真到 500 说明这老板一个月记了
    // 五百多笔，图上和文字里都会写明「未列全」，不会假装完整。
    const r = fmt.rangeOf('month');
    const rows = await api.getRecords(1, 500, { from: r.from, to: r.to });
    this._rows = rows.map(fmt.decorateRecord);
    // ⚠️ rowCount 是这个按钮上写的「带 N 笔明细」，必须是**真实笔数**（m.count），
    // 不能用 this._rows.length：满 500 之后它永远停在 500，
    // 而同一页的汇总卡写着真实总数 —— 两个数字打架，老板会以为账少记了。
    this.setData({ rowCount: m.count || this._rows.length });
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

  /* ================= 分享报表 ================= */

  openShare() {
    if (!this._rows) this._rows = [];
    this.setData({ shareSheet: true });
    // 打开面板就开始备 token（用户已经表达了要分享的意图，不算白建记录）
    this.ensureShareToken();
  },

  closeShare() {
    this.setData({ shareSheet: false });
  },

  noop() {},

  /**
   * 备好「分享给他人看」的 token。
   *
   * 缓存在本地：同期别 + 同区间 + 未过期就直接复用，不然每次进报表页都建一条分享记录。
   * 区间要参与比对，因为**分享出去的是一份快照** —— 老板今天分享的今日报表，
   * 对方明天打开应该还是那一天的，不能悄悄变成明天的。
   */
  async ensureShareToken() {
    if (this.data.sharePreparing) return;

    const period = this.data.period === 'month' ? 'month' : 'today';
    const r = fmt.rangeOf(period);
    const now = Date.now();

    let cache = null;
    try {
      cache = wx.getStorageSync('share_token') || null;
    } catch (e) {
      /* 读不到就当没有 */
    }
    if (
      cache && cache.token && cache.period === period &&
      cache.from === r.from && cache.to === r.to &&
      Number(cache.expireAt || 0) > now + 60000          // 留 1 分钟余量，别贴边过期
    ) {
      this.setData({ shareToken: cache.token, shareReady: true, sharePreparing: false });
      return;
    }

    this.setData({ sharePreparing: true, shareReady: false });
    const res = await api.safe(
      app.request('/share/create', { method: 'POST', data: { type: 3, period, expire_days: 7 }, silent: true }),
      null
    );

    if (!res || !res.token) {
      // 没备好就保持"不可点"，面板上会显示「点一下重试」，不糊过去
      this.setData({ sharePreparing: false, shareReady: false, shareToken: '' });
      app.beacon('share-token-fail', period);
      return;
    }

    try {
      wx.setStorageSync('share_token', {
        token: res.token,
        period,
        from: r.from,
        to: r.to,
        expireAt: new Date(res.expire_at).getTime()
      });
    } catch (e) {
      /* 存不下也不影响这次分享 */
    }
    this.setData({ shareToken: res.token, shareReady: true, sharePreparing: false });
  },

  /**
   * 走微信转发卡片：对方点开直接进小程序，看到的是只读报表页。
   * path 必须在这里**同步**给出，所以 token 是提前备好的（见 ensureShareToken）。
   */
  onShareAppMessage() {
    this.setData({ shareSheet: false });
    const t = this.data.shareToken;
    if (!t) {
      // 兜底：宁可分享主页，也不要分享一个打不开的链接
      return { title: '易帮账本 · 说一句话就记账', path: '/pages/record/record' };
    }
    return {
      title: '易帮账本 · ' + this.data.periodLabel + '报表',
      path: '/pages/report-view/report-view?token=' + t
    };
  },

  /**
   * 把当前期别整理成一份「报表」对象，图片和文字两条路共用同一份数据 ——
   * 两边各算各的，迟早出现"图里 7 笔、文字里 6 笔"这种对不上的账。
   */
  buildReport() {
    const { stat, period } = this.data;
    let rangePeriod = 'month';
    if (period === 'today' || period === 'yesterday' || period === 'custom') rangePeriod = 'today';
    else if (period === 'year') rangePeriod = 'year';
    const r = fmt.rangeOf(rangePeriod);
    const all = this._rows || [];

    // 图里最多画 MAX_ROWS 行。**保留最新的那几笔**（老板最关心刚记的），
    // 但按时间正序排出来 —— 报表是从早读到晚才顺。
    const capped = all.slice(0, MAX_ROWS).reverse();

    return {
      label: this.data.periodLabel + '报表',
      rangeText: r.from === r.to ? r.from : r.from + ' 至 ' + r.to,
      incomeText: stat.incomeText,
      expenseText: stat.expenseText,
      netText: stat.netText,
      isPositive: stat.isPositive,
      count: stat.count,
      rows: capped.map((x) => ({
        time: x._time || '',
        title: x._title || '一笔账',
        amount: x._amount || '',
        isIncome: x._type === 1 || x._type === 5 || x._type === 3
      })),
      // 全量明细（文字版用），按时间正序
      allRows: all.slice().reverse().map((x) => ({
        time: x._time || '',
        title: x._title || '一笔账',
        amount: x._amount || ''
      })),
      // 「还有多少笔没列出来」要用**真实总数**算，不能用"我取回来了几条"。
      // 明细接口一次最多 500 条：一个月记了 520 笔时 all.length 只有 500，
      // 照 all.length 算会说「另有 480 笔未列出」，而真实答案是 500 笔 ——
      // 少报的这个数会让人拿图去对账时对不上，比不显示更糟。
      hidden: Math.max(0, stat.count - capped.length),
      generatedAt: fmt.ymd() + ' ' + fmt.hhmm(new Date())
    };
  },

  /** 图片需要的高度。draw 用的是同一套常量，末尾会断言两者一致 */
  planHeight(rows, hidden) {
    let h = 8;                 // 顶部品牌细条
    h += 62;                   // 到标题基线
    h += 38;                   // 副标题
    h += 26;                   // 间距
    h += 210;                  // 汇总卡
    h += 30;                   // 间距
    h += 46;                   // 「明细」小标题
    // 空报表也占一行 —— drawReport 在没明细时会画「这一期还没有记账」，
    // 那一行同样吃掉 ROW_H。少算 92px 的后果是图底部多一块白（2026-09-19 版式自检抓到的）。
    h += Math.max(rows, 1) * ROW_H;
    if (hidden) h += 56;       // 截断提示
    h += 36;                   // 间距
    h += 40;                   // 页脚横线 → 页脚文字
    h += 36;                   // 页脚文字下方留白
    return h;
  },

  drawReport(ctx, rep, H) {
    let y = 0;
    ctx.textBaseline = 'alphabetic';

    // 顶部品牌细条：一眼认出这是易帮账本出的，不抢内容
    ctx.fillStyle = C.brand;
    ctx.fillRect(0, 0, W, 8);
    y = 8;

    // 标题
    y += 62;
    ctx.fillStyle = C.ink;
    ctx.font = FONT('bold', 44);
    ctx.textAlign = 'left';
    ctx.fillText(rep.label, PAD, y);

    y += 38;
    ctx.fillStyle = C.ink3;
    ctx.font = FONT('', 25);
    ctx.fillText(rep.rangeText + ' · 共 ' + rep.count + ' 笔', PAD, y);

    // 汇总卡
    y += 26;
    const cardH = 210;
    ctx.fillStyle = C.fill;
    roundRect(ctx, PAD, y, W - PAD * 2, cardH, 26);
    ctx.fill();

    ctx.fillStyle = C.ink3;
    ctx.font = FONT('', 25);
    ctx.fillText('结余', PAD + 36, y + 56);

    const netColor = rep.isPositive ? C.income : C.expense;
    ctx.fillStyle = netColor;
    ctx.font = FONT('bold', 58);
    ctx.fillText((rep.isPositive ? '+' : '-') + '¥' + rep.netText, PAD + 36, y + 126);

    // 收入 / 支出 并排
    const colW = (W - PAD * 2 - 72) / 2;
    const by = y + 178;
    ctx.font = FONT('', 25);
    ctx.fillStyle = C.ink3;
    ctx.fillText('收入', PAD + 36, by);
    ctx.fillText('支出', PAD + 36 + colW + 20, by);

    ctx.font = FONT('bold', 30);
    ctx.fillStyle = C.income;
    ctx.fillText('¥' + rep.incomeText, PAD + 36 + 62, by);
    ctx.fillStyle = C.expense;
    ctx.fillText('¥' + rep.expenseText, PAD + 36 + colW + 20 + 62, by);

    y += cardH + 30;

    // 明细小标题
    y += 46;
    ctx.fillStyle = C.ink;
    ctx.font = FONT('bold', 30);
    ctx.fillText('明细', PAD, y);

    ctx.fillStyle = C.ink3;
    ctx.font = FONT('', 24);
    ctx.textAlign = 'right';
    // 没截断时说「共 N 笔」，被截断了才摆出「列前 N / 共 M」——
    // 「7 / 7 笔」这种写法在没截断时反而让人以为是漏了什么
    ctx.fillText(
      rep.hidden ? '列前 ' + rep.rows.length + ' / 共 ' + rep.count + ' 笔' : '共 ' + rep.count + ' 笔',
      W - PAD, y
    );
    ctx.textAlign = 'left';

    // 明细行
    if (!rep.rows.length) {
      y += ROW_H;
      ctx.fillStyle = C.ink3;
      ctx.font = FONT('', 27);
      ctx.fillText('这一期还没有记账', PAD, y - 30);
    } else {
      rep.rows.forEach((r) => {
        const top = y;
        const mid = top + ROW_H / 2;

        // 事由（左）与金额（右）。金额先画，才能知道留给事由多少宽度
        ctx.font = FONT('bold', 29);
        ctx.textAlign = 'right';
        ctx.fillStyle = r.isIncome ? C.income : C.expense;
        const amtW = ctx.measureText(r.amount).width;
        ctx.fillText(r.amount, W - PAD, mid + 4);
        ctx.textAlign = 'left';

        ctx.fillStyle = C.ink;
        ctx.font = FONT('', 29);
        const maxTitle = W - PAD * 2 - amtW - 32;
        ctx.fillText(fitText(ctx, r.title, maxTitle), PAD, mid - 6);

        ctx.fillStyle = C.ink3;
        ctx.font = FONT('', 23);
        ctx.fillText(r.time, PAD, mid + 24);

        // 行分隔线（最后一行不画，省得跟下面的截断提示挤在一起）
        if (r !== rep.rows[rep.rows.length - 1]) {
          ctx.fillStyle = C.line;
          ctx.fillRect(PAD, top + ROW_H, W - PAD * 2, 1);
        }
        y += ROW_H;
      });
    }

    // 截断提示：如实说没列全，给出去多少笔、还剩多少
    if (rep.hidden) {
      y += 56;
      ctx.fillStyle = C.fill;
      roundRect(ctx, PAD, y - 38, W - PAD * 2, 48, 12);
      ctx.fill();
      ctx.fillStyle = C.ink3;
      ctx.font = FONT('', 24);
      ctx.textAlign = 'center';
      ctx.fillText('另有 ' + rep.hidden + ' 笔未列出，合计见上方汇总', W / 2, y - 8);
      ctx.textAlign = 'left';
    }

    y += 36;

    // 页脚
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, y, W - PAD * 2, 1);
    y += 40;
    ctx.fillStyle = C.ink2;
    ctx.font = FONT('bold', 26);
    ctx.fillText('易帮账本', PAD, y);
    ctx.fillStyle = C.ink3;
    ctx.font = FONT('', 22);
    ctx.fillText('说一句话就记账', PAD + 132, y);
    ctx.textAlign = 'right';
    ctx.font = FONT('', 22);
    ctx.fillText(rep.generatedAt, W - PAD, y);
    ctx.textAlign = 'left';

    y += 36;

    // 自检：画出来的高度必须跟事先算的一致，否则底边会缺一块或多一块白
    if (Math.abs(y - H) > 2) {
      console.warn('[report] 版式高度不一致：实际 ' + y + '，预算 ' + H);
    }
    return y;
  },

  async shareAsImage() {
    if (this.data.sharing) return;
    this.setData({ sharing: true, shareSheet: false });
    wx.showLoading({ title: '正在生成报表…', mask: true });

    const rep = this.buildReport();
    const H = this.planHeight(rep.rows.length, rep.hidden);
    const dpr = cv.pickDpr(H);

    try {
      const node = await cv.getNode('#reportCanvas');
      if (!node) throw new Error('画布没准备好');

      this.setData({ canvasW: W, canvasH: H });
      const canvas = node;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // 白底：不铺的话 jpg 透明区会变黑
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, W, H);
      const used = this.drawReport(ctx, rep, H);
      // 版式高度对不上时不只是 console 警告：图会多一块空白或少一截内容，
      // 而这是"发出去给人看"的东西，得能在线上被发现。
      if (Math.abs(used - H) > 2) app.beacon('report-layout-drift', 'used=' + used + ' plan=' + H);

      const path = await cv.exportTempFile(canvas);
      wx.hideLoading();
      this.setData({ sharing: false });
      app.beacon('report-image', 'rows=' + rep.rows.length + ' h=' + H + ' dpr=' + dpr);
      cv.deliverImage(path);
    } catch (err) {
      wx.hideLoading();
      this.setData({ sharing: false });
      app.beacon('report-image-fail', (err && err.message) || String(err));
      wx.showToast({ title: '报表没生成出来，再试一次', icon: 'none' });
    }
  },

  /**
   * 文字版报表正文。
   * 抽成独立方法是为了能单独验内容 —— 复制到剪贴板的东西看不见，
   * 混在 setClipboardData 里就只能靠"点一下没报错"当验证了。
   */
  reportText(rep) {
    const lines = [];
    lines.push('📊 易帮账本 · ' + rep.label);
    lines.push(rep.rangeText);
    lines.push('');
    lines.push('💰 收入  ¥' + rep.incomeText);
    lines.push('💸 支出  ¥' + rep.expenseText);
    lines.push('📈 结余  ' + (rep.isPositive ? '+' : '-') + '¥' + rep.netText + '（' + rep.count + ' 笔）');
    lines.push('');

    if (rep.allRows.length) {
      lines.push('—— 明细 ——');
      rep.allRows.forEach((r) => {
        lines.push(r.time + '  ' + r.title + '  ' + r.amount);
      });
    } else {
      lines.push('这一期还没有记账');
    }

    lines.push('');
    lines.push('易帮账本 · 说一句话就记账');
    return lines.join('\n');
  },

  /**
   * 跳转到生意参谋（AI分析）
   */
  goAdvisor() {
    wx.navigateTo({ url: '/pages/advisor/advisor' });
  },

  /**
   * 导出Excel（报表页右上角按钮，看完报表直接导出）
   */
  async exportExcel() {
    wx.showLoading({ title: '正在导出...' });
    try {
      const app = getApp();
      const res = await app.request('/user/export-excel');
      if (res.code !== 0) {
        wx.showToast({ title: res.msg || '导出失败', icon: 'none' });
        return;
      }

      const { fileUrl, fileName, count, sheets } = res.data;

      wx.showLoading({ title: '正在下载...' });
      const downloadRes = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: fileUrl,
          success: (res) => resolve(res),
          fail: (err) => reject(err)
        });
      });

      if (downloadRes.statusCode !== 200) {
        throw new Error('下载失败，状态码：' + downloadRes.statusCode);
      }

      wx.hideLoading();
      wx.openDocument({
        filePath: downloadRes.tempFilePath,
        fileType: 'xlsx',
        showMenu: true,
        success: () => {
          wx.showToast({ title: '导出成功', icon: 'success' });
        },
        fail: () => {
          wx.showModal({
            title: '导出成功',
            content: '已导出 ' + count + ' 条账目，包含 ' + (sheets || []).length + ' 个工作表。\n\n文件已生成，你可以点击右上角分享保存。',
            showCancel: false
          });
        }
      });
    } catch (err) {
      wx.hideLoading();
      console.error('导出失败:', err);
      wx.showToast({ title: '导出失败，稍后再试', icon: 'none' });
    }
  },

  /** 文字版：明细**全量**，不截断 —— 图片塞不下的部分靠它兜 */
  shareAsText() {
    wx.setClipboardData({
      data: this.reportText(this.buildReport()),
      success: () => {
        this.setData({ shareSheet: false });
        wx.showToast({ title: '已复制，去微信粘贴', icon: 'none' });
      }
    });
  },

  /** 往来对账（原样保留：那是另一个场景，逐人金额本身就是明细） */
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
