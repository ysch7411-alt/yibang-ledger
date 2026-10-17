// pages/experts/experts.js
/**
 * 专家广场
 *
 * 2026-10-07 云开发版。
 *
 * 🔴 这一页存在的意义不是"好看"，而是回答老板一个很具体的疑问：
 *    **我花的钱买到了什么**。
 *   所以每张卡都必须写清「能干什么」和「不能干什么」——
 *   只写"更聪明"是营销，写清边界才是产品。
 *
 * ⚠️ 云开发版还没有付费闭环（付费要接 purchase那套），
 *   所以这一版把价格显示出来，但**不能真买**。
 *   点「开通」会明说还没接支付，而不是假装开通成功——
 *   假成功比"还没做"更伤信任。
 */
const api = require('../../utils/api');

Page({
  data: { loading: true, err: '', list: [] },

  onShow() { this.load(); },

  onPullDownRefresh() { this.load(() => wx.stopPullDownRefresh()); },

  load(cb) {
    this.setData({ loading: true, err: '' });
    api.getExperts().then((d) => {
      this.setData({ loading: false, list: (d && d.list) || [] });
      if (cb) cb();
    }).catch((e) => {
      this.setData({ loading: false, err: e.message || '读取失败' });
      if (cb) cb();
    });
  },

  /** 点卡片 → 进对应专家的对话 */
  onTap(e) {
    const code = e.currentTarget.dataset.code;
    const ex = this.data.list.find((x) => x.code === code);
    if (!ex) return;

    if (ex.priceCents > 0 && !ex.entitled) {
      /* ⚠️ 云开发版没有付费能力，所以**明确说还没做**，
         而不是"开通成功"后假装能用。
         试一次发现不能用，比一开始就用不了更伤。 */
      wx.showModal({
        title: ex.name + '（付费）',
        content: '这个专家要付费才能用。\n云开发版还没接支付，先用免费的能力体验。',
        confirmText: '先体验',
        success: (r) => {
          if (r.confirm) {
            wx.navigateTo({ url: '/pages/chat/chat?expert=' + code });
          }
        }
      });
      return;
    }
    wx.navigateTo({ url: '/pages/chat/chat?expert=' + code });
  },

  retry() { this.load(); }
});