// pages/report-view/report-view.js
//
// 「别人分享给我的报表」——老板把报表页面分享出去，对方用微信打开就能看。
//
// 三条设计约束，每条都有理由：
//
// ① **不依赖登录态。** 对方可能压根没注册过。凭证是 URL 上的 token，不是登录态，
//    所以这里直接 wx.request 打公开接口，不走 app.request（那层会挂 Authorization、
//    还可能因为登录失败把人挡在外面）。老板自己打开同一页也照样能看。
//
// ② **四种状态必须分开**：没带 token / 链接失效 / 网络没通 / 正常。
//    都糊成一句「加载失败」的话，对方不知道该找老板要新链接、还是该重试。
//
// ③ **它是给人看的门面。** 收到的人可能从不认识这个产品，所以：
//    干净、有品牌、写清「只能看不能改」和有效期。这是产品被看见的一刻。
const fmt = require('../../utils/format');

const API_BASE = 'https://api.dtzai.cn/api';

/** 公开接口，直连 —— 不带登录态，也不做登录失败的处理（本来就不需要登录） */
function publicGet(path) {
  return new Promise((resolve) => {
    wx.request({
      url: API_BASE + path,
      method: 'GET',
      timeout: 20000,
      success: (res) => {
        const d = res.data;
        if (d && typeof d === 'object') resolve({ reached: true, code: d.code, msg: d.msg || '', data: d.data || null });
        else resolve({ reached: true, code: -1, msg: '返回格式异常', data: null });
      },
      fail: (err) => resolve({ reached: false, code: -1, msg: (err && err.errMsg) || '网络请求失败', data: null })
    });
  });
}

Page({
  data: {
    loading: true,
    // '' | 'no-token' | 'not-found' | 'failed'
    state: '',

    // 'report' 报表 / 'contact' 客户对账单 —— 两种负载共用下面这条明细管线
    kind: 'report',

    shop: '',
    label: '',
    rangeText: '',
    incomeText: '0.00',
    expenseText: '0.00',
    netText: '0.00',
    isPositive: true,

    // 对账单专用（kind='contact'）
    asOf: '',
    contactName: '',
    contactKind: '',
    balText: '0.00',
    balLabel: '',        // 对方欠我 / 我欠对方 / 已结清
    balTone: 'is-even',  // is-recv / is-pay / is-even —— 决定余额的颜色
    recvText: '0.00',    // 累计应收
    backText: '0.00',    // 累计已回款
    payText: '0.00',     // 累计应付
    doneText: '0.00',    // 累计已付款

    count: 0,
    rows: [],
    truncated: 0,
    expireDay: '',
    viewCount: 0
  },

  onLoad(options) {
    const token = String((options && options.token) || '').trim();
    this._token = token;

    if (!token) {
      // 链接被截断（比如有人手打了半个链接）要单独说，别跟"过期"混在一起
      this.setData({ loading: false, state: 'no-token' });
      return;
    }
    this.load(token);
  },

  async load(token) {
    this.setData({ loading: true, state: '' });
    const r = await publicGet('/share/view/' + token);

    if (!r.reached) {
      this.setData({ loading: false, state: 'failed' });
      return;
    }
    // 后端的 404 = 链接不在了（过期 / 被关掉 / token 不存在）。
    // 这是"找老板要个新的"能解决的事，跟网络问题不是一回事。
    if (r.code === 404) {
      this.setData({ loading: false, state: 'not-found' });
      return;
    }
    if (r.code !== 0 || !r.data) {
      this.setData({ loading: false, state: 'failed' });
      return;
    }

    const d = r.data;
    /* 两种负载：kind='report'（报表，字段 details）与 kind='contact'（客户对账单，字段 transactions）。
       字段结构完全一样（type/amount/content/qty/unit/unit_price/pay_method/record_date），
       所以下面这条展示管线**两边共用** —— 对方看到的样式和老板自己小程序里看到的一致。 */
    const isContact = d.kind === 'contact';
    const rawList = isContact ? d.transactions : d.details;
    const details = Array.isArray(rawList) ? rawList : [];

    // 报表是固定区间：跨天才逐行显示日期（单日表每行都写「09-19」是噪声）。
    // 对账单必然是跨天的（它是全部往来），所以一律带日期 —— 对账就是要看"哪天发生了什么"。
    // 两种都**绝对不能用「今天」这种相对说法**：分享出去的是快照，对方明天打开，
    // 「今天」指的就不是这一天了。
    const multiDay = isContact ? true : d.from !== d.to;

    /* 全站同一条展示管线（标题兜底链、算式、时间）。
       但**对账单有两处必须改**，否则这份账单会自相矛盾： */
    const decorated = details.map(fmt.decorateRecord);
    // 这笔对余额的影响方向，与余额算式 3−5−4+6 一一对应
    const BAL_SIGN = { 1: 1, 2: -1, 3: 1, 4: -1, 5: -1, 6: 1 };

    const rows = decorated.map((x) => {
      const t = x._type;
      const sign = BAL_SIGN[t] < 0 ? '-' : '+';
      return {
        id: x.id,
        /* ① 标题：对账单里**不能**用往来对象当标题 —— 整份账单都是同一个对象，
           每行都写「张老板」等于每行都没说这是什么。事由优先，没有事由才退回类型名。 */
        title: isContact ? (x.content || x._typeText || '往来') : x._title,
        /* ② 金额符号：报表沿用全站的"收钱+ / 付钱−"（读流水时顺）；
           对账单改成**对余额的影响方向** —— 否则「应收 +8000」「回款 +5000」两项都是正的，
           客户怎么加都加不出余额里那个 3000，会直接怀疑这份账单是算错的。
           颜色仍按全站"哪一侧"上色（应收/回款=绿，应付/付款=红），由标签说明方向。 */
        amount: isContact
          ? sign + '¥' + fmt.money(Math.abs(fmt.toNum(x.amount)))
          : x._amount,
        cls: x._cls,
        // 对账单每行都要有类型标签（应收/回款/应付/付款）：凭金额符号猜方向对客户太难
        tag: isContact ? x._typeText : '',
        tagCls: isContact ? x._tagCls : '',
      /* 对账单只显示**日期**，不带时刻。
         decorateRecord 的 _time 取的是 created_at（记账那一刻），
         不是这笔账发生的时刻 —— 对账单上写「09-13 20:46」会让客户以为
         09-13 的 20:46 发生了这笔交易，其实那只是老板事后记账的时间。
         记账时刻对老板自己有用（日报里看得见"刚记的"），对账单里是噪声。 */
        time: isContact ? '' : x._time,
        calc: x._calc,
        /* 对账单用**完整日期**（2026-09-13）：它是全部往来、可能跨年，
           只写 MM-DD 在跨年时会有歧义，而对账凭证不能有歧义。
           报表是固定短区间，MM-DD 足够，也更清爽。 */
        date: multiDay ? (isContact ? fmt.dayKey(x.record_date) : fmt.dayKey(x.record_date).slice(5)) : ''
      };
    });

    // 明细按时间**正序**排：对方是从早读到晚看一份账，不是翻消息流
    rows.reverse();

    const base = {
      loading: false,
      state: '',
      shop: d.shop || '',
      count: Number(d.count) || 0,
      rows,
      truncated: Number(d.truncated) || 0,
      expireDay: d.expireDay || '',
      viewCount: Number(d.viewCount) || 0,
      kind: isContact ? 'contact' : 'report'
    };

    if (isContact) {
      /* 对账单：最重要的是**余额的方向**和**截至日**。
         「对方欠我 8000」比一个光秃秃的「余额 -8000」有用得多 ——
         收到链接的人第一眼要能确认"我到底还欠不欠、欠多少"。
         四个分项也列出来，让对方能自己加一遍核对，这是对账单存在的意义。 */
      const c = d.contact || {};
      const amt = d.amount || {};
      const bal = fmt.toNum(amt.balance);
      this.setData(Object.assign({}, base, {
        label: c.name ? c.name + ' 对账单' : '对账单',
        rangeText: '截至 ' + (d.asOf || ''),
        asOf: d.asOf || '',
        contactName: c.name || '',
        contactKind: Number(c.type) === 1 ? '客户' : '供应商',
        balText: fmt.money(Math.abs(bal)),
        balLabel: bal > 0 ? '对方欠我' : (bal < 0 ? '我欠对方' : '已结清'),
        balTone: bal > 0 ? 'is-recv' : (bal < 0 ? 'is-pay' : 'is-even'),
        recvText: fmt.money(amt.recvAmt),
        backText: fmt.money(amt.backAmt),
        payText: fmt.money(amt.payAmt),
        doneText: fmt.money(amt.doneAmt)
      }));
      return;
    }

    const net = fmt.toNum(d.net);
    this.setData(Object.assign({}, base, {
      label: d.label || '报表',
      rangeText: d.from === d.to ? d.from : d.from + ' 至 ' + d.to,
      incomeText: fmt.money(d.income),
      expenseText: fmt.money(d.expense),
      netText: fmt.money(Math.abs(net)),
      isPositive: net >= 0
    }));
  },

  retry() {
    if (!this._token) return;
    this.load(this._token);
  },

  /** 收到的人也能再转给别人 —— 同一份报表，同一个 token */
  onShareAppMessage() {
    // 卡片标题是**收件人**看到的第一句话，要说清"这是谁发来的什么"。
    // 对账单尤其如此：对方可能同时在跟好几家店对账，标题里得有店名。
    const isContact = this.data.kind === 'contact';
    return {
      title: isContact
        ? (this.data.shop || '对方') + ' 发来的对账单'
        : (this.data.shop || '易帮账本') + ' 的' + this.data.label,
      path: '/pages/report-view/report-view?token=' + (this._token || '')
    };
  },

  /** 看完想给自己也弄一个 —— 这是产品被看见的一刻，给个不打扰的入口 */
  goTry() {
    wx.reLaunch({ url: '/pages/record/record' });
  }
});
