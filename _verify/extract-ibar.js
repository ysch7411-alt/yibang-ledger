// 把「语音输入条」从 advisor 页面抽成全站公共组件（2026-09-20）
// 背景：老板要求记账页也用同一套输入条。与其复制一份，不如抽到 app.wxss 共用。
//
// 类名映射（chat-* → ibar-*，ibar = input bar）：
const MAP = [
  ['chat-upload-cell', 'ibar-up-cell'],
  ['chat-upload', 'ibar-upload'],
  ['chat-plus-hover', 'ibar-plus-hover'],
  ['chat-plus-ico', 'ibar-plus-ico'],
  ['chat-plus', 'ibar-plus'],
  ['chat-field-ico', 'ibar-field-ico'],
  ['chat-field', 'ibar-field'],
  ['chat-input-bar', 'ibar'],
  ['chat-input', 'ibar-input'],
  ['chat-send', 'ibar-send'],
  ['chat-up-hover', 'ibar-up-hover'],
  ['chat-up-ico', 'ibar-up-ico'],
  ['chat-up-img', 'ibar-up-img'],
  ['chat-up-t', 'ibar-up-t'],
  ['chat-up-close', 'ibar-up-close']
];

const fs = require('fs');
const path = require('path');
const FRONT = path.join(__dirname, '..', 'yibang-miniprogram');
const rd = (p) => fs.readFileSync(p, 'utf8');
const wr = (p, s) => fs.writeFileSync(p, s, 'utf8');

const advCss = path.join(FRONT, 'pages/advisor/advisor.wxss');
const advWxml = path.join(FRONT, 'pages/advisor/advisor.wxml');
const appCss = path.join(FRONT, 'app.wxss');

/* ---------- ① 从 advisor.wxss 抽出整段 ---------- */
const lines = rd(advCss).split('\n');
const start = lines.findIndex((l) => /^\.chat-input-bar \{/.test(l));
if (start < 0) { console.error('✗ 找不到 .chat-input-bar'); process.exit(1); }
// 段的末尾：第一个"顶格的 .xxx {" 且不是 chat-*/ibar-* 的行，往前退一行
let end = -1;
for (let i = start + 1; i < lines.length; i++) {
  if (/^\.(?!chat-|ibar-)/.test(lines[i]) || /^\/\* -{3,}/.test(lines[i])) { end = i; break; }
}
if (end < 0) end = lines.length;
console.log('  抽取范围：advisor.wxss 第 ' + (start + 1) + '–' + end + ' 行（' + (end - start) + ' 行）');

const block = lines.slice(start, end).join('\n');
// 校验：这段里必须出现全部关键类，否则说明边界切错了
const must = ['chat-input-bar', 'chat-plus', 'chat-field', 'chat-send', 'chat-upload'];
const miss = must.filter((m) => !new RegExp('\\.' + m + '[ {:]').test(block));
if (miss.length) { console.error('✗ 抽出的段缺少类：' + miss.join(', ')); process.exit(1); }

/* ---------- ② 改名（先长后短，避免前缀被吃） ---------- */
let css = block;
MAP.forEach(([a, b]) => {
  css = css.split('.' + a).join('.' + b);
});
// 抽完之后不应该再残留 chat- 开头
if (/\.chat-/.test(css)) { console.error('✗ 改名后仍残留 .chat-*：' + (css.match(/\.chat-[\w-]+/g) || []).join(',')); process.exit(1); }

/* ---------- ③ 写进 app.wxss ---------- */
const app = rd(appCss);
if (/\.ibar \{/.test(app)) { console.error('✗ app.wxss 里已经有 .ibar，疑似重复执行'); process.exit(1); }
const section = [
  '',
  '/* ══════════ 语音输入条（全站公共组件）══════════',
  '   2026-09-20 从 pages/advisor 抽出来 —— 老板要求记账页和参谋页用同一套。',
  '   结构固定为三件：[+] [🎤 输入框] [发送]',
  '     · 点「+」弹上传面板（拍照 / 相册 / 传文件），浮层用 .ibar-upload',
  '     · 话筒在输入框内；**按住输入框说话、松手提交，单击仍是聚焦打字**',
  '       （两页的"提交"含义不同：记账页=入账，参谋页=提问，由页面自己决定）',
  '   ⚠️ .ibar-upload 是 absolute，靠 .ibar 的 position:relative 定位 —— 两者必须成对出现。',
  '   ⚠️ 类名以 ibar- 开头，别和其他页面的 class 撞。 */',
  css.trim(),
  ''
].join('\n');
wr(appCss, app + section);
console.log('  app.wxss 追加 ' + section.split('\n').length + ' 行');

/* ---------- ④ advisor 删掉旧段 + 改名 wxml ---------- */
const rest = lines.slice(0, start).concat(lines.slice(end)).join('\n');
wr(advCss, rest);
console.log('  advisor.wxss 删掉 ' + (end - start) + ' 行');

let w = rd(advWxml);
MAP.forEach(([a, b]) => { w = w.split(a).join(b); });
wr(advWxml, w);
console.log('  advisor.wxml 类名已替换');

console.log('\n✓ 抽取完成。下一步改 record 页。');
