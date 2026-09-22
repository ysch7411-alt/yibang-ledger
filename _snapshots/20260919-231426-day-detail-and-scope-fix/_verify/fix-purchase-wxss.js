// 修复 pages/purchase/purchase.wxss —— 抢救被 `cat >>` 误覆盖的文件头
//
// 事故（2026-09-19，本日第三次同类事故）：
//   用 `cat >> file << 'EOF'` 追加样式块时，这个沙箱并没有真正追加，
//   而是从文件第 1 字节开始覆写。追加块正好 62 行，于是原文件前 62 行被吃掉，
//   第 63 行还被啃掉了开头 3 个字节（`  font-weight` → `ont-weight`）。
//   丢掉的是：文件头注释、.line1、.po-head、.po-head-top、.po-supplier、
//   .po-total、.po-meta（单据头那行）、.po-row / :last-child、.po-no 的属性头。
//
// 这个脚本做三件事，每件都可自检：
//   1. 校验伤口形状 —— 形状不对就立刻中止，一个字节都不写
//   2. 剥掉错位在第 1~62 行的追加块，补回丢失的规则，接上被啃掉半截的那一行
//   3. 把误撞名的 .po-meta（我新加的 flex 行）改名成 .po-catline ——
//      原来的 .po-meta 是「单号 · 日期 · 共 N 项」那行文字，两者不能共用一个类名
//
// 用法：node fix-purchase-wxss.js [--dry]
const fs = require('fs');
const path = require('path');

const FILE = path.join(
  __dirname,
  '..',
  'yibang-miniprogram',
  'pages',
  'purchase',
  'purchase.wxss'
);
const DRY = process.argv.includes('--dry');
const BOM = '\uFEFF';

const src = fs.readFileSync(FILE, 'utf8');
if (src.charCodeAt(0) === 0xfeff) throw new Error('文件带 BOM，先处理编码再跑本脚本');

const lines = src.split('\n');

/* ---------- 1. 校验伤口形状 ---------- */
const problems = [];
if (lines.length !== 390) problems.push('总行数应为 390，实际 ' + lines.length);
if (lines[1].indexOf('品类选择弹层') < 0) problems.push('第 2 行不是错位的追加块标记');
if (lines[61] !== '}') problems.push('第 62 行应为追加块结尾的 }，实际 ' + JSON.stringify(lines[61]));
if (lines[62] !== 'ont-weight: 700;') problems.push('第 63 行不是被啃掉半截的 font-weight');
if (lines[63].trim() !== 'text-align: center;') problems.push('第 64 行不是 .po-no 的 text-align');

if (problems.length) {
  console.error('伤口形状与预期不符，未做任何修改：');
  problems.forEach((p) => console.error('  · ' + p));
  process.exit(1);
}

/* ---------- 2. 被吃掉的 62 行：按设计稿原样重建 ----------
   参照 _verify/preview/purchase-check.html 的 px 设计稿（×2 得 rpx），
   与幸存部分的口径一致：.po-name 31rpx = 15.5px、.po-amt 32rpx = 16px、.po-row padding 26rpx = 13px。
   刻意保留原来的注释语气，让后来的人看得出这段是重建的。 */
const HEAD = [
  '/* pages/purchase/purchase.wxss —— 采购单核对页 */',
  '/* 口径：AI 在后端把单据拆成结构化明细，这一页只负责「看一眼 + 确认入库」。',
  '   默认不出现任何输入框；只有老板主动点「识别有误？改一下」才进编辑态。 */',
  '',
  '.line1 {',
  '  overflow: hidden;',
  '  text-overflow: ellipsis;',
  '  white-space: nowrap;',
  '}',
  '',
  '/* ---------- 单据头 ---------- */',
  '.po-head {',
  '  padding: 30rpx 32rpx 26rpx;',
  '}',
  '.po-head-top {',
  '  display: flex;',
  '  align-items: baseline;',
  '  justify-content: space-between;',
  '}',
  '.po-supplier {',
  '  flex: 1;',
  '  min-width: 0;',
  '  margin-right: 20rpx;',
  '  font-size: 34rpx;',
  '  font-weight: 700;',
  '  color: var(--t1);',
  '  overflow: hidden;',
  '  text-overflow: ellipsis;',
  '  white-space: nowrap;',
  '}',
  '.po-total {',
  '  flex: none;',
  '  font-size: 44rpx;',
  '  font-weight: 700;',
  '  color: var(--expense);',
  '  letter-spacing: -.5rpx;',
  '}',
  '/* 单号 · 日期 · 共 N 项。是一行文字，不是容器 ——',
  '   别把布局类的东西往里塞，WXML 那边给它单开了一行 .po-catline */',
  '.po-meta {',
  '  margin-top: 10rpx;',
  '  font-size: 24rpx;',
  '  color: var(--t3);',
  '  overflow: hidden;',
  '  text-overflow: ellipsis;',
  '  white-space: nowrap;',
  '}',
  '',
  '/* ---------- 只读明细行 ---------- */',
  '.po-row {',
  '  display: flex;',
  '  align-items: flex-start;',
  '  padding: 26rpx 0;',
  '  border-bottom: 1rpx solid var(--line);',
  '}',
  '.po-row:last-child {',
  '  border-bottom: none;',
  '}',
  '.po-no {',
  '  width: 40rpx;',
  '  height: 40rpx;',
  '  flex: none;',
  '  margin: 2rpx 18rpx 0 0;',
  '  border-radius: 50%;',
  '  background: var(--brand-weak);',
  '  color: var(--brand-ink);',
  '  font-size: 23rpx;'
];

// 第 63 行起是幸存内容；首行被啃掉了 `  f`，补回去
const TAIL = lines.slice(62);
TAIL[0] = '  f' + TAIL[0];

/* ---------- 3. 撞名的 .po-meta 改名 ----------
   只在幸存段里改：HEAD 里刚重建的 .po-meta 就是要保留的那个「单据头信息行」,
   误撞名的是我新加的 flex 容器（在幸存段里）。改错方向等于把事故又演一遍。 */
let renamed = 0;
const FIXED = TAIL.map((ln) => {
  if (/^\.po-meta \{/.test(ln)) {
    renamed++;
    return '.po-catline {';
  }
  if (/^\.po-meta \.po-calc \{/.test(ln)) {
    renamed++;
    return '.po-catline .po-calc {';
  }
  return ln;
});
if (renamed !== 2) {
  console.error('幸存段里 .po-meta 改名命中 ' + renamed + ' 处，预期 2 处 —— 中止，未写盘');
  process.exit(1);
}

let out = HEAD.concat(FIXED);

/* ---------- 4. 补回品类弹层样式（这次是真正追加在文件末尾）----------
   错位的那个块被整块丢弃了，所以样式要重新放到文件最后：
   wxss 后出现的规则优先级更高，放在末尾正好能覆盖 app.wxss 里的 .sheet 定位。 */
const CAT_SHEET = [
  '',
  '/* ---------- 品类选择弹层 ---------- */',
  '/* app.wxss 里的 .sheet 默认停在 tabBar 上方；核对页是 navigateTo 的二级页、没有 tabBar，',
  '   必须覆盖成 bottom: 0，否则弹层会悬在半空。 */',
  '.cat-sheet {',
  '  bottom: 0;',
  '  bottom: env(safe-area-inset-bottom, 0px);',
  '}',
  '.cat-tip {',
  '  padding: 4rpx 0 20rpx;',
  '  font-size: 25rpx;',
  '  line-height: 1.6;',
  '  color: var(--t3);',
  '}',
  '.cat-grid {',
  '  display: flex;',
  '  flex-wrap: wrap;',
  '  margin: 0 -8rpx;',
  '}',
  '.cat-chip {',
  '  height: 76rpx;',
  '  padding: 0 30rpx;',
  '  margin: 0 8rpx 16rpx;',
  '  border-radius: var(--r-full);',
  '  background: var(--fill);',
  '  border: 1rpx solid var(--line);',
  '  color: var(--t1);',
  '  font-size: 28rpx;',
  '  line-height: 74rpx;',
  '}',
  '.cat-chip:active {',
  '  background: var(--brand-weak);',
  '  border-color: var(--brand-line);',
  '  color: var(--brand-ink);',
  '}',
  '/* 「未分类」是一个合法选择（宁可空着也别乱归），但视觉上不该跟有意义的品类一样重 */',
  '.cat-chip-none {',
  '  color: var(--t3);',
  '  background: transparent;',
  '  border-style: dashed;',
  '}',
  '.cat-custom {',
  '  display: flex;',
  '  align-items: center;',
  '  margin-top: 12rpx;',
  '  padding-top: 24rpx;',
  '  border-top: 1rpx solid var(--line);',
  '}',
  '.cat-input {',
  '  flex: 1;',
  '  min-width: 0;',
  '  height: 80rpx;',
  '  padding: 0 24rpx;',
  '  margin-right: 16rpx;',
  '  border-radius: var(--r-sm);',
  '  background: var(--fill);',
  '  font-size: 28rpx;',
  '  color: var(--t1);',
  '}',
  '.cat-sheet .sheet-ft {',
  '  padding-top: 12rpx;',
  '}',
  ''
];

out = out.concat(CAT_SHEET);

const text = out.join('\n');

/* ---------- 自检 ---------- */
const must = [
  '.line1 {',
  '.po-head {',
  '.po-head-top {',
  '.po-supplier {',
  '.po-total {',
  '.po-meta {',
  '.po-row {',
  '.po-row:last-child {',
  '.po-no {',
  '.po-catline {',
  '.po-catline .po-calc {',
  '.po-cat {',
  '.cat-sheet {',
  '.cat-chip {'
];
const missing = must.filter((k) => text.indexOf(k) < 0);
if (missing.length) {
  console.error('自检失败，缺：' + missing.join('、') + ' —— 中止，未写盘');
  process.exit(1);
}
// 括号配平
const open = (text.match(/\{/g) || []).length;
const close = (text.match(/\}/g) || []).length;
if (open !== close) {
  console.error('自检失败：花括号不配平 { ' + open + ' vs } ' + close + ' —— 中止，未写盘');
  process.exit(1);
}
// 追加块必须只出现一次，且必须在文件末尾
if (text.indexOf('品类选择弹层') !== text.lastIndexOf('品类选择弹层')) {
  console.error('自检失败：追加块重复 —— 中止，未写盘');
  process.exit(1);
}
if (text.indexOf('.cat-sheet .sheet-ft') > text.length - 200) {
  // 正常：追加块在末尾
} else {
  console.error('自检失败：追加块不在文件末尾 —— 中止，未写盘');
  process.exit(1);
}
// 被啃掉的那一行必须已经补成完整属性
if (!/\n  font-weight: 700;/.test(text)) {
  console.error('自检失败：font-weight 未补回 —— 中止，未写盘');
  process.exit(1);
}

if (DRY) {
  console.log('演练通过，未写盘。行数 ' + out.length + '（原 390）');
  process.exit(0);
}

fs.writeFileSync(FILE, text, 'utf8');
console.log('修复完成：' + out.length + ' 行，'.concat('改名 ' + renamed + ' 处'));
