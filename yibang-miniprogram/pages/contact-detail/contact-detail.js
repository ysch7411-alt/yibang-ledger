// pages/contact-detail/contact-detail.js
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const share = require('../../utils/share');

Page({
  data: {
    contactId: null,
    contact: {},
    records: [],
    balanceText: '0.00',

    /* 「分享对账单」弹层（2026-09-22）。
       shareReady 之前**按钮不给点** —— 没拿到 token 就分享，
       对方打开会是一个打不开的链接，那比不分享更伤。 */
    shareSheet: false,
    shareReady: false,
    sharePreparing: false,
    shareToken: '',
    // 分享记录的「截至日」，来自创建接口的返回（服务端时间），
    // 供"复制文字"用 —— 文案里的截至日必须和快照口径一致
    asOfText: ''
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ contactId: options.id });
      this.loadDetail();
    }
  },

  onShow() {
    if (this.data.contactId) {
      this.loadDetail();
    }
  },

  /**
   * 加载详情
   */
  async loadDetail() {
    try {
      wx.showLoading({ title: '加载中...' });
      const res = await app.request('/contact/detail', {
        data: { id: this.data.contactId }
      });

      if (res.code === 0) {
        const { contact, records } = res.data;

        // 格式化金额
        const balanceText = this.formatMoney(Math.abs(contact.balance || 0));
        /* 明细行的类型展示统一走全站的 TYPE_STYLE。
           原来模板里是 `type === 1 ? '+' : '-'` —— 只区分了"收入"和"其它"，
           于是应收(3)/回款(5)/应付(4)/付款(6) **全被画成红色减号**，
           而往来对象的记录几乎全是这四种类型，等于这一页的类型展示基本是错的。
           更要紧的是：客户收到的对账单用的是全站正确映射，两边对不上，
           客户会以为账单算错了。 */
        const formattedRecords = records.map((item) => {
          const t = Number(item.type) || 2;
          const st = fmt.TYPE_STYLE[t] || fmt.TYPE_STYLE[2];
          return Object.assign({}, item, {
            amountText: this.formatMoney(item.amount),
            typeText: fmt.TYPE_TEXT[t] || '支出',
            typeCls: st.cls,
            typeTag: st.tag,
            sign: st.sign,
            // 日期用 fmt.dayKey 归一：后端即使回了 ISO 串也不会显示出
            // 「2026-09-20T16:00:00.000Z」这种东西（后端已改成 DATE_FORMAT，
            // 这里再兜一层，免得以后哪个接口又漏掉）
            dateText: fmt.dayKey(item.record_date) || ''
          });
        });

        this.setData({
          /* 头像首字在 JS 里算好：WXML 的数据绑定**不支持方法调用**，
             模板里原来写的 {{contact.name.charAt(0)}} 不报错但渲染为空白，
             所以这个头像一直是个空橙圆圈。 */
          contact: Object.assign({}, contact, { initial: (contact.name || '?').slice(0, 1) }),
          records: formattedRecords,
          balanceText
        });

        // 设置导航栏标题
        wx.setNavigationBarTitle({ title: contact.name });
      }
    } catch (err) {
      console.error('加载详情失败:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  /**
   * 格式化金额
   */
  formatMoney(num) {
    const n = Number(num) || 0;
    return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  /* ================= 分享对账单 =================
     为什么走"分享页面"而不是生成长图：
     对账单是给对方**核对**用的，他要从头看到尾、可能还得回头再翻，
     页面能全量、能滚动、还能点；图片一生成内容就冻结了，
     而且长图在微信里预览很差。图片只在"对方只想瞄一眼"时才合适。

     流程（和小程序转发机制有关，顺序不能换）：
       点「分享对账单」→ 先建 share 记录拿 token →
       按钮换成 <button open-type="share">（只有它能拉起微信转发面板）→
       onShareAppMessage 同步返回带 token 的 path。
     拿不到 token 时按钮**不给点** —— 绝不分享出一个打不开的链接。 */
  openShare() {
    this.setData({ shareSheet: true });
    this.ensureShareToken();
  },

  closeShare() {
    this.setData({ shareSheet: false });
  },

  noop() {},

  /**
   * 备好这份对账单的分享链接。
   * 状态机（防重复点击 / 本地缓存 / 失败可重试）统一在 utils/share.js ——
   * 本页只说明「分享什么」：type=2 带 contact_id，并把服务端钉下的「截至日」一起缓存。
   */
  ensureShareToken() {
    const cid = this.data.contactId;
    if (!cid) return;
    share.ensure(this, {
      key: '2-contact-' + cid,
      data: { type: 2, contact_id: cid, expire_days: 7 },
      map: (d) => ({ asOfText: d.to || '' })
    });
  },

  /** 复制成文字：对方要粘进表格逐条核的时候用 */
  copyStatement() {
    const c = this.data.contact || {};
    const bal = Number(c.balance) || 0;
    const lines = [];
    lines.push(c.name + ' 对账单');
    // 截至日必须写清、且**不能是"今天"**这种相对说法 —— 这段文字会被复制走，
    // 对方明天再看「今天」指的就不是同一天了。asOfText 来自创建分享时的服务端日期。
    if (this.data.asOfText) lines.push('截至 ' + this.data.asOfText);
    lines.push('余额：' + (bal > 0 ? '应收余额' : (bal < 0 ? '应付余额' : '已结清')) + ' ¥' + this.data.balanceText);
    lines.push('');
    (this.data.records || []).forEach((r) => {
      lines.push([r.dateText, r.typeText, r.content, r.sign + '¥' + r.amountText].filter(Boolean).join(' '));
    });
    lines.push('');
    lines.push('由 易帮账本 生成，只能看不能改');

    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => {
        this.closeShare();
        wx.showToast({ title: '已复制，去粘给对方', icon: 'none' });
      }
    });
  },

  onShareAppMessage() {
    this.setData({ shareSheet: false });
    const name = (this.data.contact && this.data.contact.name) || '往来对象';
    const t = this.data.shareToken;
    if (!t) {
      // 兜底：token 没备好时**不**把 report-view 的路径分享出去（那会是个读不到东西的页），
      // 退回首页 —— 至少对方打开是能用的
      return { title: '易帮账本 · 说一声话就记账', path: '/pages/record/record' };
    }
    return {
      title: (this.data.shop || '对方') + ' 发来的对账单（' + name + '）',
      path: '/pages/report-view/report-view?token=' + t
    };
  }
});