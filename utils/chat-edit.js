/* utils/chat-edit.js —— OCR 确认卡行内人工修改（page methods）
 *
 * 2026-10-17 从 chat.js 113KB 拆出，行为完全一致。
 * module.exports 导出方法对象；chat.js 启动时 Object.assign(this, mod) 挂回 page 实例。
 * this 链不变（仍是 page 实例），setData / this.data.* / 其他 page methods 仍可用。
 *
 * 🔴 17:10 老易真机发现 onTapConfirm 一直转圈 —— api 没 require（同 16:57 intake 同一错）。
 */
const api = require('./api');

module.exports = {
  // ===== onTapConfirm =====
  /** 确认入账 */
  onTapConfirm: function(e) {
      const id = e.currentTarget.dataset.id;
      const m = this.data.msgs.find((x) => x.id === id);
      if (!m || !m.confirm || m.confirm.done) return;

      const c = m.confirm;
      if (!c.canConfirm) {
        wx.showToast({ title: '没有可入账的行', icon: 'none' });
        return;
      }

      wx.showLoading({ title: '入账中…', mask: true });
      /* 🔴 17:10 防 ReferenceError 卡 loading：hideLoading 包 try/catch，任何路径都触发 */
      const _hideAndAlert = (msg) => { try { wx.hideLoading(); } catch (_) {} wx.showModal({ title: '没能入账', content: msg, showCancel: false, confirmText: '知道了' }); };
      api
        .saveBatch(c.rows.map((r) => ({ t: r.t, txt: r.txt, amt: r.amt, who: r.who })))
        .then((r) => {
          wx.hideLoading();
          const nc = {};
          for (const k in c) nc[k] = c[k];
          nc.done = true;
          this._replaceMsg(id, { confirm: nc });
          this._loadTodayStat();
          wx.showToast({ title: '已入账 ' + c.count + ' 笔', icon: 'none' });
          this._maybeTone(id, { kind: 'record', hour: new Date().getHours(), todayCount: this.data.todayCount + c.count, todayNet: this.data.todayStat.net });
          return r;
        })
        .catch((e) => {
          const hint = (e && e.hint) || (e && e.message) || '云端暂时没连上';
          _hideAndAlert('云端没存上：' + hint + '\n\n稍后网络好了再点一次「确认入账」。');
        });
    },
  // ===== onTapDrop =====
  /** 忽略这次识别结果 */
  onTapDrop: function(e) {
      const id = e.currentTarget.dataset.id;
      const m = this.data.msgs.find((x) => x.id === id);
      if (!m || !m.confirm) return;
      const nc = {};
      for (const k in m.confirm) nc[k] = m.confirm[k];
      nc.done = true;
      nc.dropped = true;
      this._replaceMsg(id, { confirm: nc });
      wx.showToast({ title: '已忽略，未入账', icon: 'none' });
  },
  // ===== onTapEditConfirmRow =====
  /* ═══════════════ OCR 确认卡 · 单行人工修改（2026-10-17 老易反馈）═══
   * 设计：
   *  - 整行可点 → 弹三栏 modal（方向/金额/摘要/对方）
   *  - 改完仅本地更新行；后端不入账（等点"确认入账"统一提交）
   *  - 改过的行右侧 "已改" 角标提示老板
   *  - 弹窗支持"删除这行" —— 长按行的 X 单独做太隐蔽
   *  - 弹窗空行不能再"保存"：必须给方向 + 金额 > 0
   *  - 关弹窗/点遮罩：放弃当前编辑
   */
  onTapEditConfirmRow: function(e) {
      const { mid, idx } = e.currentTarget.dataset;
      const m = this.data.msgs.find((x) => x.id === mid);
      if (!m || !m.confirm || m.confirm.done) return;
      const r = (m.confirm.rows || [])[Number(idx)];
      if (!r) return;
      /* 拷贝一份深：避免 input 双向绑定直接污染源数据 */
      this.setData({
        editRowOpen: true,
        editRowMid: mid,
        editRowIdx: Number(idx),
        editRow: {
          t: r.t || 'out',
          amt: String(r.amt || ''),
          txt: r.txt || '',
          who: r.who || ''
        }
      });
  },
  // ===== onTapEditToggle =====
  onTapEditToggle: function(e) {
      const t = e.currentTarget.dataset.t;
      this.setData({ 'editRow.t': t });
  },
  // ===== onTapEditSave =====
  onTapEditSave: function() {
      const { editRow, editRowMid, editRowIdx } = this.data;
      if (!editRowMid) { this.setData({ editRowOpen: false }); return; }
      const amt = Number(editRow.amt);
      if (!amt || amt <= 0) { wx.showToast({ title: '金额要大于 0', icon: 'none' }); return; }
      if (!editRow.txt || !editRow.txt.trim()) { wx.showToast({ title: '摘要不能空', icon: 'none' }); return; }
      const m = this.data.msgs.find((x) => x.id === editRowMid);
      if (!m || !m.confirm) { this.setData({ editRowOpen: false }); return; }
      /* 重建 rows：amText 跟着方向/金额变 */
      const rows = (m.confirm.rows || []).slice();
      const r = rows[editRowIdx];
      if (!r) { this.setData({ editRowOpen: false }); return; }
      rows[editRowIdx] = Object.assign({}, r, {
        t: editRow.t,
        amt: amt,
        amtText: (editRow.t === 'in' ? '+' : '-') + amt.toFixed(2),
        txt: String(editRow.txt).trim(),
        who: String(editRow.who || '').trim(),
        _edited: true
      });
      /* 重新算合计（用于 hint 校对） */
      let inSum = 0, outSum = 0, count = 0;
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i];
        if (!x.amt || x.amt <= 0) continue;
        count++;
        if (x.t === 'in') inSum += x.amt; else outSum += x.amt;
      }
      const nc = Object.assign({}, m.confirm, { rows, count });
      /* 算页面合计 vs 识别行合计（对账） */
      const total = inSum + outSum;
      const origTotal = Number(m.confirm.origTotal || 0);
      if (origTotal > 0 && Math.abs(total - origTotal) > 0.01) {
        const diff = origTotal - total;
        nc.hint = '本页识别合计 ¥' + origTotal.toFixed(2) + '，你改后合计 ¥' + total.toFixed(2) +
                  (Math.abs(diff) > 0.01 ? '（差 ¥' + diff.toFixed(2) + '）' : '，一致 ✓');
      }
      this._replaceMsg(editRowMid, { confirm: nc });
      this.setData({ editRowOpen: false });
      wx.showToast({ title: '已改，确认入账时一并提交', icon: 'none', duration: 1500 });
  },
  // ===== onTapEditDel =====
  onTapEditDel: function() {
      const { editRowMid, editRowIdx } = this.data;
      if (!editRowMid) { this.setData({ editRowOpen: false }); return; }
      const m = this.data.msgs.find((x) => x.id === editRowMid);
      if (!m || !m.confirm) { this.setData({ editRowOpen: false }); return; }
      const rows = (m.confirm.rows || []).slice();
      if (rows.length <= 1) { wx.showToast({ title: '至少保留 1 行', icon: 'none' }); return; }
      rows.splice(editRowIdx, 1);
      let inSum = 0, outSum = 0, count = 0;
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i];
        if (!x.amt || x.amt <= 0) continue;
        count++;
        if (x.t === 'in') inSum += x.amt; else outSum += x.amt;
      }
      const nc = Object.assign({}, m.confirm, { rows, count });
      this._replaceMsg(editRowMid, { confirm: nc });
      this.setData({ editRowOpen: false });
      wx.showToast({ title: '已删这行', icon: 'none', duration: 1200 });
  },
};
