// pages/contact-detail/contact-detail.js
const api = require('../../utils/api');
const fmt = require('../../utils/format');

Page({
  data: {
    loading: true,
    contact: {},
    initial: '往',
    isReceivable: true,
    balanceText: '0.00',
    recordList: [],
    sections: []
  },

  onLoad(options) {
    this.contactId = options.id;
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    const { contact, records } = await api.getContactDetail(this.contactId);

    const balance = fmt.toNum(contact.balance);
    const name = contact.name || '往来对象';

    // 二级页用导航栏标题承载对象名，省掉一行重复的大标题
    wx.setNavigationBarTitle({ title: name });

    this.setData({
      contact,
      initial: name.slice(0, 1),
      isReceivable: balance >= 0,
      balanceText: fmt.money(Math.abs(balance)),
      recordList: records,
      sections: fmt.groupByDay(records),
      loading: false
    });
  },

  shareReconciliation() {
    const { contact, balanceText, isReceivable, recordList } = this.data;
    let text = `📋 易帮账本 · ${contact.name || ''} 对账单\n\n`;
    text += `${isReceivable ? '还欠我' : '我还欠'}：¥${balanceText}\n`;
    text += `往来 ${recordList.length} 笔\n\n`;

    recordList.slice(0, 10).forEach((r) => {
      text += `${r.record_date} ${r._typeText} ${r._amount}${r.content ? '（' + r.content + '）' : ''}\n`;
    });
    text += `\n有出入请随时联系我核对`;

    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '对账单已复制', icon: 'none' })
    });
  }
});
