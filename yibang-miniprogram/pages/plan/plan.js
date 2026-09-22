// pages/plan/plan.js
Page({
  data: {
    proFeatures: ['无限记账条数', 'AI 语音 / 图片识别记账', '员工管理与审核', '一键对账、账单分享', '生意参谋经营分析', '永久免费升级'],
    freeFeatures: [
      { text: '每月 100 条记账', ok: true },
      { text: '基础收支与往来台账', ok: true },
      { text: 'AI 识别记账', ok: false },
      { text: '员工管理与审核', ok: false },
      { text: '生意参谋经营分析', ok: false }
    ]
  },

  buyLifetime() {
    wx.showModal({
      title: '开通终身版',
      content: '支付 ¥19.9，终身使用全部功能，不再续费',
      confirmText: '立即支付',
      success: (res) => {
        if (!res.confirm) return;
        // 微信支付尚未接入，如实告知，不做「假装成功」
        wx.showToast({ title: '支付通道接入中', icon: 'none' });
      }
    });
  }
});
