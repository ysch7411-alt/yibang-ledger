// 跨页面重复样式类的**逐字比对**（2026-09-20）
//
// 为什么不能"发现重复就合并"：本项目有过先例 —— `.debt-card` 在记账页是横排、
// 在报表页要竖排，**同一个类名两个含义**。那种情况合并进去，两边至少坏一边。
// 所以先把每个类的定义体原样打出来，按"完全相同 / 只差一点 / 明显不同"分三档，
// 只对前两档动手，第三档单独处理（改名或留在页面里）。
//
// 用法: node dup-classes.js
const fs = require('fs');
const path = require('path');

const FRONT = path.join(__dirname, '..', 'yibang-miniprogram');
const skip = ['node_modules', '.git', '_snapshots'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.wxss')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(FRONT, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(p, 'utf8');
/** 剥注释：注释里举例的类名不算定义 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** 提取一个文件里所有「以 .xxx 开头的规则块」的声明体（不含选择器） */
function rulesOf(src) {
  const out = new Map();   // class → [声明体, ...]
  const clean = strip(src);
  const re = /(^|\n)([ \t]*)([^{}\n][^{}]*?)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sels = m[3].trim();
    if (!sels || sels.startsWith('@')) continue;
    // 选择器里所有 .class 都算用到了；但只把**首个子选择器**当成"定义这个类"
    // （`.a .b` 定义的是 .b 的上下文，不算定义 .a）
    const firsts = sels.split(',').map((s) => s.trim().split(/\s+/)[0]);
    firsts.forEach((sel) => {
      const cls = /^\.([a-zA-Z][\w-]*)/.exec(sel);
      if (!cls) return;
      const body = m[4].replace(/\s+/g, ' ').trim();
      if (!out.has(cls[1])) out.set(cls[1], []);
      out.get(cls[1]).push(body);
    });
  }
  return out;
}

const files = walk(path.join(FRONT, 'pages')).concat(walk(path.join(FRONT, 'custom-tab-bar')));
const perFile = new Map();
files.forEach((f) => {
  const rules = rulesOf(read(f));
  rules.forEach((body, cls) => {
    if (!perFile.has(cls)) perFile.set(cls, []);
    perFile.get(cls).push({ file: rel(f), body: body.join(' | ') });
  });
});

const shared = [...perFile.entries()].filter(([, v]) => v.length >= 2);

/** 归一化：属性排序后比较，避免"同样的属性不同顺序"被当成有差异 */
const norm = (b) => b.split('|').map((s) => s.trim())
  .join(';').split(';').map((s) => s.trim()).filter(Boolean).sort().join(';');

const same = [], near = [], diff = [];
shared.forEach(([cls, defs]) => {
  const bodies = defs.map((d) => d.body);
  const ns = bodies.map(norm);
  if (new Set(ns).size === 1) same.push([cls, defs]);
  else {
    // 相似度：属性集合重合比例
    const setA = new Set(ns[0].split(';'));
    const setB = new Set(ns[1].split(';'));
    const inter = [...setA].filter((x) => setB.has(x)).length;
    const ratio = inter / Math.max(setA.size, setB.size);
    (ratio >= 0.6 ? near : diff).push([cls, defs, Math.round(ratio * 100)]);
  }
});

console.log('跨页面重复的样式类：' + shared.length + ' 个');
console.log('  ├─ 定义**完全相同** → 可安全提升：' + same.length + ' 个');
console.log('  ├─ 只差一点（重合 ≥60%）→ 需判断：' + near.length + ' 个');
console.log('  └─ 明显不同 → **同名不同义，不能合并**：' + diff.length + ' 个');

console.log('\n========== A. 完全相同（可安全提升到 app.wxss）==========');
same.forEach(([cls, defs]) => {
  console.log('\n.' + cls + '  ← ' + defs.map((d) => d.file).join('  +  '));
  console.log('   ' + defs[0].body);
});

console.log('\n\n========== B. 只差一点（要人工定夺）==========');
near.forEach(([cls, defs, r]) => {
  console.log('\n.' + cls + '   重合度 ' + r + '%');
  defs.forEach((d) => console.log('   [' + d.file + '] ' + d.body));
});

console.log('\n\n========== C. 明显不同（⚠️ 同名不同义，合并会坏）==========');
diff.forEach(([cls, defs, r]) => {
  console.log('\n.' + cls + '   重合度 ' + r + '%');
  defs.forEach((d) => console.log('   [' + d.file + '] ' + d.body));
});
