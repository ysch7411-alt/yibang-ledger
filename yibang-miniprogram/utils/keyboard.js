// utils/keyboard.js —— 让贴在底部的元素躲开输入法
//
// 为什么需要它（2026-09-20 真机实测）：
//   记账页底部输入条只露出上半个圆角，其余被键盘切掉。
//   根因：`.dock` / `.receipt` / `.sheet` 都是 `position: fixed`，
//   而 `input` 默认的 `adjust-position` 只能把**页面滚动**往上推，推不动 fixed 元素。
//   Android 上键盘是盖在 webview 之上的（并不缩小 webview），
//   所以贴底的固定条下半截必然被压住 —— 跟在页面上怎么写 bottom 无关。
//
// 三处一起才生效：
//   ① 页面配置：`Page(Object.assign({ data: { kbLift: 0 } }, kb.methods))`
//   ② 每个 input：
//        adjust-position="{{false}}"          ← 关掉那个推不动的自动上推
//        bindfocus="onKbFocus"
//        bindblur="onKbBlur"
//        bindkeyboardheightchange="onKbHeight"
//   ③ 要避让的固定元素：`style="--kb-lift: {{kbLift}}px;"`
//      且它的定位要在 wxss 里用 `max(原位置, var(--kb-lift, 0px))` 参与计算
//
// 为什么用「变量 + max()」而不是让 JS 直接算好 bottom 写进 style：
//   键盘弹起时 **tabBar 也被键盘压住了**，所以不能把键盘高度"加"在 tabbar-h 上 ——
//   那样输入条会浮在键盘上方 54px 的位置，中间露出一条缝。
//   max() 让元素在"贴 tabBar"和"贴键盘"之间取更高者：键盘收起时 kb-lift 是 0，
//   max 自然选回 tabbar-h，行为跟改动前完全一致（不支持 max() 的老内核退到上一行，
//   等于不避让，也不会比修复前更糟）。
//
// 为什么不用全局的 wx.onKeyboardHeightChange：
//   它需要在每个页面的 onLoad/onUnload 里成对注册注销，漏掉一个就是"页面销毁后
//   还在 setData"。事件挂在组件上则随组件一起消失，不用管生命周期。

const methods = {
  /**
   * 键盘高度变化（收起时 height 为 0）。
   * 比 focus/blur 配对更准：在几个输入框之间切换、或用户换了输入法把键盘调高调矮，
   * 这里都能跟上，不会出现"blur 先把条子放下去、focus 又抬起来"的闪动。
   */
  onKbHeight(e) {
    this.setKb((e.detail && e.detail.height) || 0);
  },

  /** 兜底：个别基础库/机型不派发 keyboardheightchange，就从 focus 事件里取一次 */
  onKbFocus(e) {
    const h = (e.detail && e.detail.height) || 0;
    if (h) this.setKb(h);
  },

  onKbBlur() {
    this.setKb(0);
  },

  /** 取整：小数会让 setData 白刷，而 1px 以内的差异肉眼看不出来 */
  setKb(h) {
    const v = Math.max(0, Math.round(h || 0));
    if (!this.data || v === this.data.kbLift) return;
    this.setData({ kbLift: v });
  }
};

module.exports = { methods };
