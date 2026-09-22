// pages/contact-detail/contact-detail.js
const app = getApp();

Page({
  data: {
    contactId: null,
    contact: {},
    records: [],
    balanceText: '0.00'
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
        const formattedRecords = records.map(item => ({
          ...item,
          amountText: this.formatMoney(item.amount)
        }));

        this.setData({
          contact,
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
  }
});