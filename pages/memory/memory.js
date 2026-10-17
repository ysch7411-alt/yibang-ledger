/**
 * pages/memory/memory.js —— AI 记住了什么
 *
 * 2026-10-09。阶段四接入。
 *
 * ── 为什么做这个页 ──
 *   用户决策：「可查看 + 可一键清空」。这里提供：
 *     ① 列表（按 type 分组：profile / preference / fact / task / interest）
 *     ② 单条删除（GDPR-like "被遗忘权"）
 *     ③ 一键清空
 *
 * ── 隐私边界 ──
 *   - 每条记忆带 tags=['shop:<id>']，后端强制隔离（详见 lib/memory.js）
 *   - 跨店记忆绝不可见
 *   - 账目金额 / 欠款 / 进货价不进记忆（详见 _redact）
 */
const api = require('../../utils/api');

/* 🔴 5 种记忆类型的友好标签 + emoji —— 让老板一眼看懂 */
const TYPE_LABEL = {
  profile:    { label: '关于你',     icon: '👤' },
  preference: { label: '你的习惯',   icon: '⚙️' },
  fact:       { label: '你提过',     icon: '💡' },
  task:       { label: '接下来要做', icon: '📌' },
  interest:   { label: '你关心的',   icon: '🎯' }
};

const TYPE_ORDER = ['profile', 'preference', 'fact', 'task', 'interest'];

Page({
  data: {
    loading: true,
    err: '',
    info: null,            // 「越用越懂」摘要（nameMap + reasons + learnedFromUser + correctionCount）
    grouped: [],          // [{type, label, icon, items: [...]}]
    total: 0,
    empty: false
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true, err: '' });
    // 并行拉：列表 + 摘要
    Promise.all([
      api.listMemory().catch(() => ({ list: [] })),
      api.getMemoryInfo().catch(() => null)
    ]).then(([listRes, infoRes]) => {
      const items = (listRes && listRes.list) || [];
      const grouped = _groupByType(items);
      this.setData({
        loading: false,
        info: infoRes || null,
        grouped,
        total: items.length,
        empty: items.length === 0
      });
    }).catch((e) => {
      this.setData({
        loading: false,
        err: e.message || '读取失败',
        empty: false
      });
    });
  },

  /**
   * 单条删除 —— 弹确认 modal，避免误删
   */
  onTapDelete(e) {
    const id = e.currentTarget.dataset.id;
    const content = e.currentTarget.dataset.content || '这条记忆';
    if (!id) return;
    wx.showModal({
      title: '删掉这条？',
      content: '「' + _truncate(content, 30) + '」会从 AI 记忆中消失。',
      confirmText: '删掉',
      cancelText: '不删',
      confirmColor: '#C9451A',
      success: (r) => {
        if (!r.confirm) return;
        api.deleteMemory(id).then((d) => {
          if (d && d.ok) {
            wx.showToast({ title: '已删', icon: 'success' });
            this.load();
          } else {
            wx.showToast({ title: '删除失败：' + ((d && d.msg) || '未知'), icon: 'none' });
          }
        }).catch((e) => {
          wx.showToast({ title: '删除失败：' + (e.message || '网络'), icon: 'none' });
        });
      }
    });
  },

  /**
   * 一键清空 —— 红色确认 + 文字警告（这是不可逆操作）
   */
  onTapClearAll() {
    wx.showModal({
      title: '一键清空所有记忆？',
      content: 'AI 记住的店铺、习惯、人名等都会消失。\n\n操作不可撤销 —— 之后 AI 会重新开始记。',
      confirmText: '全部清空',
      cancelText: '不删了',
      confirmColor: '#C9451A',
      success: (r) => {
        if (!r.confirm) return;
        api.clearMemory().then((d) => {
          if (d && d.ok) {
            wx.showToast({ title: '已清空', icon: 'success' });
            this.load();
          } else {
            wx.showToast({ title: '清空失败：' + ((d && d.msg) || '未知'), icon: 'none' });
          }
        }).catch((e) => {
          wx.showToast({ title: '清空失败：' + (e.message || '网络'), icon: 'none' });
        });
      }
    });
  },

  retry() { this.load(); }
});

/* ── 内部工具 ── */

function _truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function _groupByType(items) {
  const groups = {};
  for (const m of items) {
    const t = m.type || 'fact';
    if (!groups[t]) groups[t] = [];
    groups[t].push(m);
  }
  const out = [];
  for (const t of TYPE_ORDER) {
    if (!groups[t] || !groups[t].length) continue;
    const meta = TYPE_LABEL[t] || { label: t, icon: '·' };
    out.push({
      type: t,
      label: meta.label,
      icon: meta.icon,
      items: groups[t].map((m) => ({
        id: m.id,
        content: m.content || m.text || '',
        createdAt: m.created_at || m.createdAt || ''
      }))
    });
  }
  return out;
}
