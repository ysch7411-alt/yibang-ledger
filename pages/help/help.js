// pages/help/help.js
const FAQS = [
  { q: '说话 AI 怎么听懂？', a: '老板说"买菜 30 块"AI 自动识别金额/分类/对象；说"上次那笔"AI 会查最近记账。说人话就行。' },
  { q: '记错了怎么办？', a: '点卡片上的"↶ 撤销"，30 秒内还可以"撤回撤销"恢复。' },
  { q: '记账扣不扣手续费？', a: '完全免费。易帮AI是工具，不碰钱。' },
  { q: '数据存在哪里？安全吗？', a: '存在云开发 PG 数据库（腾讯云托管），与阿里云那套完全独立。店与店之间严格隔离。' },
  { q: 'AI 记的账能导出吗？', a: '能。点卡片"💾 导出"，目前支持 Excel。' },
  { q: '能不能多人一起记？', a: '目前是单店主模式。成员管理功能开发中。' }
];

Page({
  data: {
    faqs: FAQS.map((f) => { const o = {}; for (const k in f) o[k] = f[k]; o.open = false; return o; })
  },
  onTapFaq(e) {
    const idx = e.currentTarget.dataset.idx;
    const faqs = this.data.faqs;
    faqs[idx].open = !faqs[idx].open;
    this.setData({ faqs });
  },
  onTapCS() {
    wx.showModal({
      title: '联系人工',
      content: '客服系统对接中。\n\n当前可直接在对话里说"找客服"，AI 会自动转接。\n\n紧急问题：email to dev@buddy.local',
      showCancel: false,
      confirmText: '知道了'
    });
  },
  onTapFeedback() {
    wx.showModal({
      title: '反馈 Bug / 建议',
      content: '微信开放社区搜索"易帮AI"反馈。\n\n或直接在对账里说"我想要 XX 功能"，AI 会记录到产品需求池。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
