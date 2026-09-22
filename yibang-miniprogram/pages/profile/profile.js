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
    savingProfile: false,
    businessDayEnd: '00:00',
    businessDayEndLabel: '按自然日',
    /* 营业日截止时间：**不能用 wx.showActionSheet**（2026-09-22 修）。
       官方文档：itemList「数组长度最大为 6」，而这里有 7 个选项 ——
       超限会直接失败，又因为没写 fail 回调，失败是**完全静默**的：
       用户点了没反应、控制台也没有任何日志，看着就像"这一行坏了"。
       改用底部弹层，顺带能给每项配一句说明（showActionSheet 塞不下）。 */
    dayEndSheet: false,
    dayEndOptions: [
      { v: '00:00', t: '按自然日', d: '半夜 0 点换天，大多数店用这个' },
      { v: '01:00', t: '凌晨 1 点前', d: '1 点前记的账算前一天' },
      { v: '02:00', t: '凌晨 2 点前', d: '适合夜宵店、烧烤摊' },
      { v: '03:00', t: '凌晨 3 点前', d: '收摊特别晚的店' },
      { v: '04:00', t: '凌晨 4 点前', d: '通宵营业的店' },
      { v: '05:00', t: '凌晨 5 点前', d: '天快亮才收摊' },
      { v: '06:00', t: '凌晨 6 点前', d: '早市、早餐店' }
    ]
  },

  onShow() {
    this.loadData();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    // 2026-09-22 加了 AI 参谋 tab，「我的」从第 3 项挪到第 4 项（索引 2 → 3）
    if (tb) tb.setData({ selected: 3 });
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
      businessDayEnd: info.business_day_end || '00:00',
      businessDayEndLabel: (info.business_day_end && info.business_day_end !== '00:00') ? '凌晨' + info.business_day_end + '前' : '按自然日',
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

    /**
     * 待审核记录：点「我的」页那个「N 条待审」标签进来。
     *
     * ⚠️ 2026-09-23 修：**这个入口原来根本不存在** ✗
     * 本页会显示「3 条待审」的红标签（见 wxml），但那一整行绑的是 `goRoleManage` ——
     * 点进去是「成员与角色」，**里面没有审核入口** ✗
     * 而待审核页 `/pages/pending/pending` 全站唯一的入口在 `staff` 页里，
     * 偏偏 `staff` 页自己没有任何 wxml 绑定它（是个不可达页面）✗
     * → 结果：老板看到"有账要审"，却**找不到地方审**。
     *   一个只喊人、不给人路的提示，比没有提示更伤。
     */
    goPending() {
      wx.navigateTo({ url: '/pages/pending/pending' });
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
  /* 2026-09-22 删除 goAdvisor()：本页 wxml 里从来没有绑定过它（全站只有报表页
     末尾那个 AI 参谋入口在用），属于历史遗留的死方法 —— 和 account 页那两段
     营业日方法同一个来路。真要在这里也放一个 AI 参谋入口，应该正经加一行并绑定它，
     而不是把一个没人调的方法留在代码里。 */
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
      },
      /* 必须写 fail。wx.showActionSheet 失败时**界面上没有任何反馈**，
         不写这一行就是"点了没反应、日志里也查不到"。
         （营业日那个入口就是这么静默失效了很久，见本文件 chooseBusinessDay 的注释。） */
      fail: (err) => {
        // 用户自己点取消/点蒙层不算失败，别弹提示去打扰他
        if (/cancel/i.test((err && err.errMsg) || '')) return;
        wx.showToast({ title: '菜单没打开，再试一次', icon: 'none' });
      }
    });
  },
  chooseBusinessDay() {
    // 打开底部弹层（原来是 wx.showActionSheet，7 项超限导致点了彻底没反应）
    this.setData({ dayEndSheet: true });
  },

  closeDayEnd() {
    this.setData({ dayEndSheet: false });
  },

  /** 空处理：给 .sheet 的 catchtap 用，防止点弹层内部穿透到遮罩把层关掉 */
  noop() {},

  pickDayEnd(e) {
    const v = e.currentTarget.dataset.v;
    if (!v) return;
    this.setData({ dayEndSheet: false });
    // 选了跟当前一样的就不用白跑一趟保存
    if (v !== this.data.businessDayEnd) this.saveBusinessDayEnd(v);
  },

  // 保存营业日截止时间
  async saveBusinessDayEnd(value) {
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const res = await app.request('/user/profile', {
        method: 'POST',
        data: { business_day_end: value },
        silent: true
      });
      wx.hideLoading();
      if (res && res.code === 0) {
        if (app.globalData.userInfo) {
          app.globalData.userInfo.business_day_end = value;
        }
        this.setData({
          businessDayEnd: value,
          businessDayEndLabel: value === '00:00' ? '按自然日' : '凌晨' + value + '前'
        });
        wx.showToast({ title: '已保存', icon: 'success' });
      } else {
        wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
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
      },
      // 同上：失败要有反馈，否则"点了没反应"
      fail: (err) => {
        if (/cancel/i.test((err && err.errMsg) || '')) return;
        wx.showToast({ title: '菜单没打开，再试一次', icon: 'none' });
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
