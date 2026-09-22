// pages/contacts/contacts.js
const app = getApp();

Page({
  data: {
    summary: {
      receivable: 0,
      payable: 0,
      receivableText: '0.00',
      payableText: '0.00'
    },
    list: [],
    filteredList: [],
    receivableCount: 0,
    payableCount: 0,
    filterType: 'all', // all / receivable / payable
    showAdd: false,
    saving: false,
    kbLift: 0,
    addForm: {
      name: '',
      type: 1,
      phone: '',
      remark: ''
    }
  },

  onLoad() {
    this.loadData();
  },

  onShow() {
    // 设置自定义 tabBar 的选中项（往来是第3个，索引2）
    const tb = this.getTabBar();
    if (tb) tb.setData({ selected: 2 });
    this.loadData();
  },

  /**
   * 加载数据：汇总 + 列表
   */
  async loadData() {
    try {
      wx.showLoading({ title: '加载中...' });

      // 并行加载汇总和列表
      const [sumRes, listRes] = await Promise.all([
        app.request('/contact/summary'),
        app.request('/contact/list')
      ]);

      if (sumRes.code === 0 && listRes.code === 0) {
        const summary = sumRes.data;
        const list = listRes.data;

        // 格式化金额
        summary.receivableText = this.formatMoney(summary.receivable);
        summary.payableText = this.formatMoney(summary.payable);

        // 格式化列表金额
        const formattedList = list.map(item => ({
          ...item,
          balanceText: this.formatMoney(Math.abs(item.balance))
        }));

        // 统计数量
        const receivableCount = list.filter(i => i.balance > 0).length;
        const payableCount = list.filter(i => i.balance < 0).length;

        this.setData({
          summary,
          list: formattedList,
          receivableCount,
          payableCount
        });

        this.applyFilter();
      }
    } catch (err) {
      console.error('加载往来数据失败:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  /**
   * 应用筛选
   */
  applyFilter() {
    const { list, filterType } = this.data;
    let filteredList = list;

    if (filterType === 'receivable') {
      filteredList = list.filter(i => i.balance > 0);
    } else if (filterType === 'payable') {
      filteredList = list.filter(i => i.balance < 0);
    }

    this.setData({ filteredList });
  },

  /**
   * 设置筛选
   */
  setFilter(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ filterType: type });
    this.applyFilter();
  },

  /**
   * 点击汇总卡片筛选
   */
  filterType(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ filterType: type });
    this.applyFilter();
  },

  /**
   * 跳转到详情
   */
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: '/pages/contact-detail/contact-detail?id=' + id
    });
  },

  /**
   * 打开添加弹层
   */
  openAdd() {
    this.setData({
      showAdd: true,
      addForm: { name: '', type: 1, phone: '', remark: '' }
    });
  },

  /**
   * 关闭添加弹层
   */
  closeAdd() {
    this.setData({ showAdd: false });
  },

  /**
   * 表单输入
   */
  onAddName(e) {
    this.setData({ 'addForm.name': e.detail.value });
  },
  onAddPhone(e) {
    this.setData({ 'addForm.phone': e.detail.value });
  },
  onAddRemark(e) {
    this.setData({ 'addForm.remark': e.detail.value });
  },

  /**
   * 设置类型
   */
  setAddType(e) {
    const type = parseInt(e.currentTarget.dataset.type);
    this.setData({ 'addForm.type': type });
  },

  /**
   * 键盘高度变化
   */
  onKbFocus(e) {
    this.setData({ kbLift: e.detail.height || 0 });
  },
  onKbBlur() {
    this.setData({ kbLift: 0 });
  },
  onKbHeight(e) {
    this.setData({ kbLift: e.detail.height || 0 });
  },

  /**
   * 保存新增
   */
  async saveAdd() {
    const { addForm, saving } = this.data;
    if (saving) return;

    if (!addForm.name.trim()) {
      wx.showToast({ title: '请输入名称', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    try {
      const res = await app.request('/contact/create', {
        method: 'POST',
        data: {
          name: addForm.name.trim(),
          type: addForm.type,
          phone: addForm.phone.trim() || null,
          remark: addForm.remark.trim() || null
        }
      });

      if (res.code === 0) {
        wx.showToast({ title: '添加成功', icon: 'success' });
        this.setData({ showAdd: false });
        this.loadData();
      } else {
        wx.showToast({ title: res.msg || '添加失败', icon: 'none' });
      }
    } catch (err) {
      console.error('添加失败:', err);
      wx.showToast({ title: '添加失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
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
