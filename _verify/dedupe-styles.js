// 把已经提升到 app.wxss 的类，从各页面 wxss 里删掉（2026-09-20）
//
// 为什么用脚本而不是手改 14 处：
//   同样是"删一段 CSS"，手改 14 次就有 14 次剪错的可能，而且每次都要重新定位。
//   这里加了四道校验，任何一道不过就**一个字节都不写**（沿用 fix-purchase-wxss.js 的做法）：
//     ① app.wxss 里确实有这个类（否则删了页面副本 = 样式凭空消失）
//     ② 目标文件里确实有它（防止清单写错、误报"已删"）
//     ③ 删完之后目标文件里**不能**再有它
//     ④ 删前删后的**类名集合**对比：只允许少掉清单里的那几个
//        —— 这条是防正则"吃多了"的关键，光看行数对不上不够
//
// 用法: node dedupe-styles.js          # 演练（只报计划，不写）
//       node dedupe-styles.js --apply  # 真删（先自动备份）
const fs = require('fs');
const path = require('path');

const FRONT = path.join(__dirname, '..', 'yibang-miniprogram');
const APPLY = process.argv.includes('--apply');

/** 只提升过「两个页面里逐字相同」的类，见 dup-classes.js 的 A 组 */
const TARGETS = {
  'pages/bind-phone/bind-phone.wxss': ['.mk'],
  'pages/record/record.wxss': ['.mk', '.f-block', '.f-label', '.debt-s', '.day-sum'],
  'pages/profile/profile.wxss': ['.f-block', '.f-label'],
  'pages/purchase/purchase.wxss': ['.po-name', '.po-tail'],
  'pages/purchase-list/purchase-list.wxss': ['.po-name', '.po-tail'],
  'pages/summary/summary.wxss': ['.debt-s'],
  'pages/search/search.wxss': ['.day-sum']
};

const read = (p) => fs.readFileSync(p, 'utf8');

/** 一个文件里出现的所有类名（剥注释，含 ::after 这类伪元素变体归到主类） */
function classSet(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const set = new Set();
  const re = /(^|\n)([ \t]*)([^{}\n][^{}]*?)\{/g;
  let m;
  while ((m = re.exec(clean))) {
    const sels = m[3].trim();
    if (!sels || sels.startsWith('@')) continue;
    sels.split(',').forEach((sel) => {
      const c = /^\.([a-zA-Z][\w-]*)/.exec(sel.trim().split(/\s+/)[0]);
      if (c) set.add(c[1]);
    });
  }
  return set;
}

/**
 * 删掉以 `.cls {` / `.cls::after {` / `.cls.other {` 开头的规则块。
 * 逐行扫描 + 大括号配平，不用正则去啃嵌套 —— CSS 里出现嵌套（@media）时正则必错。
 */
function removeRule(src, cls) {
  const lines = src.split('\n');
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // 选择器首段是不是这个类
    const isHead = new RegExp('^\\.' + cls + '(?![\\w-])').test(line) && line.indexOf('{') >= 0;
    if (!isHead) { out.push(lines[i]); continue; }

    // 从这里开始吃掉整个块（含可能的多行选择器）：先找到 '{'
    let depth = 0;
    let j = i;
    let sawBrace = false;
    for (; j < lines.length; j++) {
      const l = lines[j];
      depth += (l.match(/\{/g) || []).length;
      depth -= (l.match(/\}/g) || []).length;
      if (l.indexOf('{') >= 0) sawBrace = true;
      if (sawBrace && depth <= 0) break;
    }
    if (!sawBrace || depth > 0) { out.push(lines[i]); continue; }   // 没配平就放弃这块，不动
    removed++;
    i = j;   // 跳过整块
  }
  // 连续 3 个以上空行压成 2 个（删块会留下空洞）
  return { src: out.join('\n').replace(/\n{4,}/g, '\n\n\n'), removed };
}

const appWxss = read(path.join(FRONT, 'app.wxss'));
const appClasses = classSet(appWxss);

const plan = [];
const errors = [];

Object.keys(TARGETS).forEach((rel) => {
  const file = path.join(FRONT, rel);
  const before = read(file);
  const beforeSet = classSet(before);

  TARGETS[rel].forEach((cls) => {
    // ① app.wxss 里得有
    if (!appClasses.has(cls.slice(1))) {
      errors.push('① app.wxss 里没有 ' + cls + ' —— 删掉页面副本会让它彻底消失');
      return;
    }
    // ② 目标文件里得有
    if (!beforeSet.has(cls.slice(1))) {
      errors.push('② ' + rel + ' 里找不到 ' + cls + '（清单写错了？）');
      return;
    }
    plan.push({ rel, cls });
  });
});

if (errors.length) {
  console.log('✗ 前置校验没通过，未做任何改动：');
  errors.forEach((e) => console.log('   ' + e));
  process.exit(1);
}

console.log('待删除 ' + plan.length + ' 处规则块，涉及 ' + Object.keys(TARGETS).length + ' 个文件：');
Object.keys(TARGETS).forEach((rel) => {
  console.log('  ' + rel + '  →  ' + TARGETS[rel].join(' '));
});

// ③④ 逐个文件试删（内容先不落盘），校验类名集合只少掉目标那几个
const results = [];
Object.keys(TARGETS).forEach((rel) => {
  const file = path.join(FRONT, rel);
  let src = read(file);
  const beforeSet = classSet(src);
  let removed = 0;
  TARGETS[rel].forEach((cls) => {
    const r = removeRule(src, cls.slice(1));
    src = r.src;
    removed += r.removed;
  });
  const afterSet = classSet(src);
  const lost = [...beforeSet].filter((c) => !afterSet.has(c));
  const lostNotWanted = lost.filter((c) => !TARGETS[rel].includes('.' + c));
  const keptWanted = TARGETS[rel].filter((c) => afterSet.has(c.slice(1)));

  // 块数 ≥ 类数：有的类带 ::after（如 .mk），那是**独立的一块**，
  // 一起删掉才是对的 —— 只看"类名集合少掉了什么"（下面两道校验）才是真判据。
  const okCount = removed >= TARGETS[rel].length;
  const okLost = lostNotWanted.length === 0;
  const okKept = keptWanted.length === 0;

  console.log('\n' + rel);
  console.log('   删掉 ' + removed + ' 块 / ' + TARGETS[rel].length + ' 个类（带 ::after 的会多出来）' + (okCount ? ' ✓' : ' ✗'));
  console.log('   少掉的类：' + (lost.length ? lost.map((c) => '.' + c).join(' ') : '（无）'));
  if (!okLost) console.log('   ✗ 误删了不该动的类：' + lostNotWanted.map((c) => '.' + c).join(' '));
  if (!okKept) console.log('   ✗ 这些没删掉：' + keptWanted.join(' '));

  if (okCount && okLost && okKept) results.push({ file, rel, src });
  else errors.push('③④ ' + rel + ' 校验没过，跳过');
});

if (errors.length) {
  console.log('\n✗ 有以下问题，一个文件都没写：');
  errors.forEach((e) => console.log('   ' + e));
  process.exit(1);
}

if (!APPLY) {
  console.log('\n（演练模式）加 --apply 才会真的写回');
  process.exit(0);
}

// 备份后再写
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = path.join(__dirname, 'backup-dedupe-' + stamp);
fs.mkdirSync(backup, { recursive: true });
results.forEach((r) => {
  const flat = r.rel.replace(/\//g, '__');
  fs.copyFileSync(r.file, path.join(backup, flat));
});
console.log('\n已备份到 ' + backup);

results.forEach((r) => fs.writeFileSync(r.file, r.src, 'utf8'));
console.log('✓ 已写回 ' + results.length + ' 个文件');
console.log('  下一步跑：node static-check.js ../yibang-miniprogram');
