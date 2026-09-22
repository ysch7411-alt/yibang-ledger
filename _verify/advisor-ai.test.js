// AI 问答从查询页搬到参谋页（2026-09-20）的回归断言。
//
// 为什么值得写成测试：这次搬的不只是代码，还有几个**容易被人改回去的判断**——
//   ① 入口位置（结论之后，不是页面顶部）
//   ② 快捷问题不能问页面上已经答过的（hero 已经给了"赚了多少"）
//   ③ hero 的圆角改成上圆下平了，**必须**有 .ask-entry 接着，否则它就是个半截圆角
//   ④ 入口、弹层、样式、快捷问题是一整套，不能只搬一半
// 这些都不是语法错误，编译不会报，只有肉眼看页面才能发现 —— 所以钉在这里。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'yibang-miniprogram');
const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let pass = 0, fail = 0;
function say(ok, label, extra) {
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (extra ? '  → ' + extra : ''));
}

/* ---------------- 打桩加载 advisor 页 ---------------- */
let captured = null;
global.getApp = () => ({ globalData: { userId: 2, userInfo: {} }, beacon() {}, request() { return Promise.resolve({ code: 0 }); } });
global.Page = (o) => { captured = o; };
global.wx = { navigateTo() {}, switchTab() {}, setData() {} };
require(path.join(SRC, 'pages/advisor/advisor.js'));
const adv = captured;

const advWxml = rd('pages/advisor/advisor.wxml');
const advWxss = rd('pages/advisor/advisor.wxss');
const appWxss = rd('app.wxss');
const seaWxml = rd('pages/search/search.wxml');
const seaWxss = rd('pages/search/search.wxss');

console.log('=== ① 参谋页拿到了完整的一套 ===');
say(!!adv, 'advisor.js 能加载');
['openAi', 'closeAi', 'onAiInput', 'askQuick', 'scrollToBottom', 'sendAi'].forEach((m) => {
  say(typeof adv[m] === 'function', '方法 ' + m + ' 在');
});
['showAi', 'aiInput', 'aiHistory', 'aiThinking', 'scrollTo', 'quickAsks'].forEach((k) => {
  say(Object.prototype.hasOwnProperty.call(adv.data, k), 'state ' + k + ' 在');
});
say(/bindtap="openAi"/.test(advWxml), '入口卡绑了 openAi');
say(/bindinput="onAiInput"/.test(advWxml) && /bindconfirm="sendAi"/.test(advWxml), '输入框两个事件都在');
say(/class="sheet chat-sheet"/.test(advWxml), '对话弹层在');
// 2026-09-20 输入条样式抽成全站公共（app.wxss 的 .ibar-*），advisor 不再自带这段
say(/\.ibar-input/.test(appWxss) && /\.chat-bubble/.test(advWxss), '输入条样式已抽到 app.wxss（.ibar-*）');

console.log('\n=== ② 别把已经答过的问题再问一遍 ===');
// 参谋页 hero 显示「本月结余/本月收入/本月支出」，下面的卡显示「欠得最多的客户」
const answered = ['这个月赚了多少钱', '谁欠我最多'];
const asks = adv.data.quickAsks || [];
say(Array.isArray(asks) && asks.length >= 3, '快捷问题有 3 条以上', JSON.stringify(asks));
answered.forEach((a) => {
  const dup = asks.some((q) => q.indexOf(a) >= 0);
  say(!dup, '快捷问题里没有「' + a + '」（本页 hero/客户卡已答）', dup ? '出现了！' : '');
});
// 入口卡的副标题是第二展示位，同样不能浪费在已有答案上
const subM = /class="ask-d">([^<]*)</.exec(advWxml);
const sub = subM ? subM[1] : '';
say(!answered.some((a) => sub.indexOf(a) >= 0), '入口副标题也没重复已有答案', sub);
say(sub.length > 0, '入口副标题有内容');

console.log('\n=== ③ hero 和追问条必须同时存在 ===');
// .hero 现在是 border-radius: var(--r-lg) var(--r-lg) 0 0（上圆下平），
// 下面那张条负责补下半个圆角。两者是拼合关系，少一个就露馅。
say(/\.hero\s*\{[\s\S]*?border-radius:\s*var\(--r-lg\)\s+var\(--r-lg\)\s+0\s+0/.test(advWxss),
  'hero 是上圆下平（拼合形态）');
say(/\.ask-entry\s*\{[\s\S]*?border-radius:\s*0\s+0\s+var\(--r-lg\)\s+var\(--r-lg\)/.test(advWxss),
  'ask-entry 是下圆（补上另外两个角）');
say(/class="hero"/.test(advWxml) && /class="ask-entry"/.test(advWxml), '两个都在 wxml 里');
// 拼合后外阴影只能有一处，否则拼缝会叠出脏边
say(/\.hero\s*\{[\s\S]*?box-shadow:\s*none/.test(advWxss), 'hero 不再自己投影（避免拼缝脏边）');
say(/\.ask-entry\s*\{[\s\S]*?box-shadow:/.test(advWxss), '外阴影由 ask-entry 统一提供');

console.log('\n=== ④ 图标不能隐形 ===');
// sparkle 原图是灰描边 #98A2B3，放在深橙圆底上等于看不见
say(/ic-sparkle-w\.svg/.test(advWxml), '入口用的是白色版 sparkle');
say(fs.existsSync(path.join(SRC, 'images/ic-sparkle-w.svg')), 'ic-sparkle-w.svg 文件在');
say(/stroke="#FFFFFF"/.test(rd('images/ic-sparkle-w.svg')), '它确实是白色描边');
// 深色圆的底上必须是白图标；浅色底上才用灰图标
const askIcoBlock = /class="ask-ico"[\s\S]*?<\/view>/.exec(advWxml);
say(!/\.\.\/images\/ic-sparkle\.svg|"\/images\/ic-sparkle\.svg"/.test(askIcoBlock ? askIcoBlock[0] : ''),
  '深色圆底里没用灰色 sparkle');

console.log('\n=== ⑤ 查询页不许留一半 ===');
say(!/class="ai-entry"/.test(seaWxml), '查询页入口卡已移除');
say(!/chat-sheet/.test(seaWxml), '查询页弹层已移除');
say(!/\.ai-entry\s*\{/.test(seaWxss), '查询页入口样式已移除');
say(!/\.chat-bubble\s*\{/.test(seaWxss), '查询页对话样式已移除');
const seaJs = rd('pages/search/search.js');
// 只允许注释里提到，不允许真的留下实现
const realCode = seaJs.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
['openAi', 'sendAi', 'aiHistory', 'quickAsks'].forEach((k) => {
  say(realCode.indexOf(k) < 0, '查询页没有残留实现：' + k);
});

console.log('\n=== ⑥ 兜底文案要跟着页面走 ===');
// 原来写的是「先用上面的搜索查具体的账」—— 在参谋页没有"上面的搜索"。
// 只查**字符串字面量**：注释里会出现这个词（说明为什么要改），那不算。
const advJs = rd('pages/advisor/advisor.js');
const literals = [...advJs.matchAll(/content:\s*'([^']*)'/g)].map((m) => m[1]);
say(literals.length > 0, '取到了 AI 回复的文案', literals.length + ' 条');
say(!literals.some((t) => t.indexOf('上面的搜索') >= 0),
  '回复文案里没有「上面的搜索」这种位置错误',
  literals.filter((t) => t.indexOf('上面的搜索') >= 0).join(' / '));
say(literals.some((t) => t.indexOf('经营提示') >= 0), '兜底时指向了本页真实存在的「经营提示」');

console.log('\n' + (fail ? '✗ ' + fail + ' 项不合格' : '✓ 全部通过') + '（通过 ' + pass + '，失败 ' + fail + '）');
process.exit(fail ? 1 : 0);
