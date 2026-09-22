// pages/profile/profile.js
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const kb = require('../../utils/keyboard');

/** 手机号掩码：列表里没必要展示完整号码 */
const maskPhone = (p) => (p && String(p).length >= 7 ? String(p).slice(0, 3) + '****' + String(p).slice(-4) : '');

Page(Object.assign({
  data: {
    /* 键盘避让（改店名弹层里的两个输入框），见 utils/keyboard.js */
    kbLift: 0,
    userInfo: {},
    initial: '',
    isPro: false,
    pendingCount: 0,
    unreadCount: 0,
    phone: '',
    // 先给一个空结构，避免 wxml 在 loadData 返回前取 memo.xxx 报错
    memo: { termCount: 0, nameCount: 0, learnedFromUser: 0, correctionCount: 0, nameMap: [], reasons: [] },
    stat: { records: 0, contacts: 0, days: 0 },

    // 改昵称 / 店名
    showProfile: false,
    form: { nickname: '', shop_name: '' },
    savingProfile: false
  },

  onShow() {
    this.loadData();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 2 });
  },

  async loadData() {
    const [user, records, contacts, staff, memo] = await Promise.all([
      api.safe(app.request('/user/info', { silent: true }), {}),
      api.getRecords(1, 200),
      api.getContactList(),
      api.getStaffList(),
      api.getMemoryInfo()
    ]);

    const days = new Set(records.map((r) => fmt.dayKey(r.record_date)));
    const info = user || {};

    this.setData({
      userInfo: info,
      // 头像用昵称首字，替代原来的 👤 emoji —— emoji 在各端字形不一致
      initial: (info.nickname || info.shop_name || '易').slice(0, 1),
      // plan_type: 0 免费 / 1 终身 —— 原实现读的是不存在的 plan 字段，付费用户永远显示「免费版」
      isPro: Number(info.plan_type) > 0,
      pendingCount: staff.pendingCount,
      phone: maskPhone(info.phone),
      memo,
      stat: {
        records: records.length,
        contacts: contacts.length,
        days: days.size
      }
    });
  },

  goToStaff() {
    wx.navigateTo({ url: '/pages/staff/staff' });
  },

  /* ---------------- 改昵称 / 店名 ---------------- */

  openProfile() {
    this.setData({
      showProfile: true,
      form: {
        nickname: this.data.userInfo.nickname || '',
        shop_name: this.data.userInfo.shop_name || ''
      }
    });
  },

  closeProfile() {
    this.setData({ showProfile: false });
  },

  onFormShop(e) {
    this.setData({ 'form.shop_name': e.detail.value });
  },

  onFormNick(e) {
    this.setData({ 'form.nickname': e.detail.value });
  },

  async saveProfile() {
    if (this.data.savingProfile) return;
    this.setData({ savingProfile: true });

    const d = await api.safe(
      app.request('/user/profile', { method: 'POST', data: this.data.form, silent: true }),
      null
    );
    this.setData({ savingProfile: false });

    if (!d || !d.user) {
      wx.showToast({ title: '没保存上，再试一次', icon: 'none' });
      return;
    }

    // 同步到全局与本地缓存：首页问候、分享出去的店名都读这里
    app.globalData.userInfo = d.user;
    try {
      wx.setStorageSync('userInfo', d.user);
    } catch (e) {
      /* 存不下不影响本次显示 */
    }

    this.setData({
      showProfile: false,
      userInfo: d.user,
      initial: (d.user.nickname || d.user.shop_name || '易').slice(0, 1)
    });
    wx.showToast({ title: '已保存', icon: 'success' });
  },
  goToPlan() {
    wx.navigateTo({ url: '/pages/plan/plan' });
  },
  goToPromote() {
    wx.navigateTo({ url: '/pages/promote/promote' });
  },
  goRoleManage() {
    wx.navigateTo({ url: '/pages/role-manage/role-manage' });
  },
  goNotifications() {
    wx.navigateTo({ url: '/pages/notifications/notifications' });
  },
  async loadUnreadCount() {
    try {
      const res = await app.request('/notifications/unread-count');
      if (res.code === 0) {
        this.setData({ unreadCount: res.data.count || 0 });
      }
    } catch (err) {
      console.error('加载未读数失败:', err);
    }
  },
  goPurchase() {
    wx.navigateTo({ url: '/pages/purchase-list/purchase-list' });
  },
  goAdvisor() {
    wx.navigateTo({ url: '/pages/advisor/advisor' });
  },
  openDataManage() {
    wx.showActionSheet({
      itemList: ['导出Excel对账', '导出全部数据备份', '从备份文件恢复'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.exportExcel();
        } else if (res.tapIndex === 1) {
          this.exportBackup();
        } else if (res.tapIndex === 2) {
          this.importBackup();
        }
      }
    });
  },
  goToAccount() {
    wx.navigateTo({ url: '/pages/account/account' });
  },

  showAbout() {
    wx.showModal({
      title: '易帮账本',
      content: '说句话、拍张照就能记账，账目永不丢。\n\n出品：重庆大头针人工智能有限责任公司\n版本：v1.0.0',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 导出全部账目为 Excel 文件（多Sheet）
   * 后端生成 Excel 文件上传到 OSS，前端下载后用微信打开。
   * 包含：交易记录、往来对象、员工管理、统计汇总
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

      // 下载文件（wx.downloadFile 是回调风格，用 Promise 包装）
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

      // 打开文件（wx.openDocument 也是回调风格，不用 await）
      wx.hideLoading();
      wx.openDocument({
        filePath: downloadRes.tempFilePath,
        fileType: 'xlsx',
        showMenu: true,
        success: () => {
          wx.showToast({ title: '导出成功', icon: 'success' });
        },
        fail: () => {
          // 如果打不开Excel，就提示用户分享保存
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

  /**
   * 数据备份与恢复
   * 弹出操作菜单，用户可以选择导出备份或导入恢复
   */
  backupData() {
    wx.showActionSheet({
      itemList: ['导出全部数据备份', '从备份文件恢复'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.exportBackup();
        } else if (res.tapIndex === 1) {
          this.importBackup();
        }
      }
    });
  },

  /**
   * 导出全部数据备份
   * 后端生成JSON备份文件上传到OSS，前端下载后分享保存
   */
  async exportBackup() {
    wx.showLoading({ title: '正在备份...' });
    try {
      const app = getApp();
      const res = await app.request('/user/backup');
      if (res.code !== 0) {
        wx.showToast({ title: res.msg || '备份失败', icon: 'none' });
        return;
      }

      const { fileUrl, fileName, summary } = res.data;

      // 下载文件
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

      // 打开文件（JSON文件可能打不开，直接提示分享保存）
      wx.hideLoading();
      wx.openDocument({
        filePath: downloadRes.tempFilePath,
        fileType: 'json',
        showMenu: true,
        success: () => {
          wx.showToast({ title: '备份成功', icon: 'success' });
        },
        fail: () => {
          const summaryText = [
            '交易记录：' + (summary.transactions || 0) + ' 条',
            '往来对象：' + (summary.contacts || 0) + ' 个',
            'AI记忆：' + (summary.merchantTerms || 0) + ' 条'
          ].join('\n');
          
          wx.showModal({
            title: '备份成功',
            content: '已生成完整数据备份文件。\n\n' + summaryText + '\n\n请点击右上角「...」选择「发送给朋友」或「保存到手机」，妥善保管备份文件。',
            showCancel: false
          });
        }
      });
    } catch (err) {
      wx.hideLoading();
      console.error('备份失败:', err);
      wx.showToast({ title: '备份失败，稍后再试', icon: 'none' });
    }
  },

  /**
   * 从备份文件恢复数据
   * 选择本地JSON文件，上传到后端恢复
   */
  importBackup() {
    wx.showModal({
      title: '数据恢复',
      content: '恢复数据将覆盖当前所有数据，此操作不可撤销。\n\n建议先导出当前数据备份，再进行恢复。\n\n确定要继续吗？',
      confirmText: '继续恢复',
      confirmColor: '#E4551D',
      success: (res) => {
        if (res.confirm) {
          wx.chooseMessageFile({
            count: 1,
            type: 'file',
            extension: ['json'],
            success: (res) => {
              const file = res.tempFiles[0];
              this.uploadBackupFile(file.path);
            },
            fail: () => {
              wx.showToast({ title: '已取消选择', icon: 'none' });
            }
          });
        }
      }
    });
  },

  /**
   * 上传备份文件并恢复
   */
  async uploadBackupFile(filePath) {
    wx.showLoading({ title: '正在恢复...' });
    try {
      const app = getApp();
      
      // 上传文件
      const uploadRes = await new Promise((resolve, reject) => {
        wx.uploadFile({
          url: app.globalData.apiBase + '/user/restore',
          filePath: filePath,
          name: 'file',
          header: {
            Authorization: 'Bearer ' + (app.globalData.token || '')
          },
          success: (res) => {
            try {
              resolve(JSON.parse(res.data));
            } catch (e) {
              reject(new Error('返回格式错误'));
            }
          },
          fail: (err) => reject(err)
        });
      });

      wx.hideLoading();

      if (uploadRes.code === 0) {
        wx.showModal({
          title: '恢复成功',
          content: '数据已成功恢复！\n\n交易记录：' + (uploadRes.data.summary.transactions || 0) + ' 条\n往来对象：' + (uploadRes.data.summary.contacts || 0) + ' 个\n\n点击确定后自动刷新页面。',
          showCancel: false,
          success: () => {
            this.loadData();
          }
        });
      } else {
        wx.showToast({ title: uploadRes.msg || '恢复失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('恢复失败:', err);
      wx.showToast({ title: '恢复失败，稍后再试', icon: 'none' });
    }
  }
}, kb.methods));   // 键盘避让：onKbFocus / onKbBlur / onKbHeight / setKb
