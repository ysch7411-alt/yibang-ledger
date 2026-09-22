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

    shop: '',
    label: '',
    rangeText: '',
    incomeText: '0.00',
    expenseText: '0.00',
    netText: '0.00',
    isPositive: true,
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
    const details = Array.isArray(d.details) ? d.details : [];
    // 跨天区间才逐行显示日期。今日报表里每行都写「09-19」是噪声；
    // 而**绝对不能用「今天」这种相对说法** —— 分享出去的是固定区间的快照，
    // 对方明天打开，「今天」指的就不是这一天了。
    const multiDay = d.from !== d.to;

    // 复用全站同一套展示逻辑（标题兜底链、金额正负、算式），
    // 对方看到的和老板在自己小程序里看到的是同一个样子
    const rows = details.map(fmt.decorateRecord).map((x) => ({
      id: x.id,
      title: x._title,
      time: x._time,
      calc: x._calc,
      amount: x._amount,
      cls: x._cls,
      date: multiDay ? fmt.dayKey(x.record_date).slice(5) : ''
    }));

    // 明细按时间**正序**排：对方是从早读到晚看一份账，不是翻消息流
    rows.reverse();

    const net = fmt.toNum(d.net);
    this.setData({
      loading: false,
      state: '',
      shop: d.shop || '',
      label: d.label || '报表',
      rangeText: d.from === d.to ? d.from : d.from + ' 至 ' + d.to,
      incomeText: fmt.money(d.income),
      expenseText: fmt.money(d.expense),
      netText: fmt.money(Math.abs(net)),
      isPositive: net >= 0,
      count: Number(d.count) || 0,
      rows,
      truncated: Number(d.truncated) || 0,
      expireDay: d.expireDay || '',
      viewCount: Number(d.viewCount) || 0
    });
  },

  retry() {
    if (!this._token) return;
    this.load(this._token);
  },

  /** 收到的人也能再转给别人 —— 同一份报表，同一个 token */
  onShareAppMessage() {
    return {
      title: (this.data.shop || '易帮账本') + ' 的' + this.data.label,
      path: '/pages/report-view/report-view?token=' + (this._token || '')
    };
  },

  /** 看完想给自己也弄一个 —— 这是产品被看见的一刻，给个不打扰的入口 */
  goTry() {
    wx.reLaunch({ url: '/pages/record/record' });
  }
});
