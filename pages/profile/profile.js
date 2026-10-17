// pages/profile/profile.js
/**
 * 我的
 *
 * 2026-10-07 云开发版。
 *
 * 这一页承担三件事，按重要性排序：
 *   ① **后端状态** —— 云开发版最常见的问题是"服务还没部署好/连不上"，
 *      所以把健康检查放在最上面，让人一眼能看出是"服务挂了"还是"我自己的问题"。
 *      这在旧版不存在（旧版有域名兜底），但云开发版第一次用很可能失败。
 *   ② 店铺信息
 *   ③ 自动化 / 连接器入口
 */
const api = require('../../utils/api');

Page({
  data: {
    shop: null,
    /* 健康检查结果。⚠️ 要区分三种状态而不是两种：
         ok=服务正常 / degraded=服务正常但没配模型（AI 走关键词降级）
         / err=连不上。三种给用户的说法完全不同。 */
    health: { state: 'checking', text: '正在检查后端…' },
    automationCount: 0,
    connectorOpened: 0,
    unreadCount: 0
  },

  onShow() { this.load(); },

  onPullDownRefresh() { this.load(() => wx.stopPullDownRefresh()); },

  load(cb) {
    api.getShop()
      .then((shop) => {
        this.setData({ shop });
        return this.checkHealth();
      })
      .then(() => this.loadCounts())
      .catch((e) => {
        this.setData({
          health: {
            state: 'err',
            text: '连不上后端：' + (e.message || '未知错误')
          }
        });
        if (cb) cb();
      });
    if (cb) setTimeout(cb, 1500);
  },

  checkHealth() {
    return api.health().then((h) => {
      /* 🔴 2026-10-17：/api/health 现在逐项回 llm / tts / weknora / db 的就绪状态，
         这里照实翻译成老板看得懂的话。
         之前只判断 llm，会出现"AI 没配、语音也没配、数据库还挂着，页面却说后端正常"的假绿灯 ——
         而这是**账本**，"看起来正常"比"明确报错"危险得多。 */
      h = h || {};

      /* 数据库不通 = 记账一定失败。这是唯一能一票否决的状态，优先报它 */
      if (h.db && h.db !== 'ok') {
        this.setData({
          health: { state: 'err', text: '后端数据库连不上 —— 现在记账和查询都会失败，请稍后重试' }
        });
        return;
      }

      const missing = [];
      if (h.llm === 'not_configured') missing.push('AI 模型');
      if (h.tts === 'not_configured') missing.push('语音播报');
      if (h.weknora === 'not_configured') missing.push('长期记忆');

      if (missing.length) {
        this.setData({
          health: {
            state: 'degraded',
            text: '后端正常，但还没配' + missing.join(' / ') + ' —— 相关功能会自动降级'
          }
        });
        return;
      }

      /* ⚠️ h.db 缺失 = 上游还是旧版 /api/health（灰度期间会遇到），不当成故障 */
      this.setData({ health: { state: 'ok', text: '后端正常 · ' + (h.model || '全部就绪') } });
    }).catch((e) => {
      this.setData({ health: { state: 'err', text: '连不上：' + (e.message || '') } });
    });
  },

  loadCounts() {
    /* 两个都是"锦上添花"的数字，失败就留 0，不影响本页显示。
       ⚠️ 不用 allSettled 是因为小程序基础库支持有限，
           这里串行 + 各���自带 catch 就够了。 */
    api.getAutomations()
      .then((d) => this.setData({ automationCount: ((d && d.list) || []).length }))
      .catch(() => {});
    api.getConnectors()
      .then((d) => this.setData({ connectorOpened: (d && d.summary && d.summary.opened) || 0 }))
      .catch(() => {});
    api.unreadCount()
      .then((d) => this.setData({ unreadCount: (d && d.count) || 0 }))
      .catch(() => {});
  },

  goExperts() { wx.navigateTo({ url: '/pages/experts/experts' }); },
  /** 「我的 → AI 记住了什么」入口（阶段四） */
  goMemory() { wx.navigateTo({ url: '/pages/memory/memory' }); },
  /** 自动化：列表 + 手动跑一次 */
  goAutomations() { wx.navigateTo({ url: '/pages/automations/automations' }); },
  /** 连接器：列表 + 开通/关闭 */
  goConnectors() { wx.navigateTo({ url: '/pages/connectors/connectors' }); },
  /** 通知：列表 + 标记已读 */
  goNotifications() { wx.navigateTo({ url: '/pages/notifications/notifications' }); },
  retry() { this.load(); }
});