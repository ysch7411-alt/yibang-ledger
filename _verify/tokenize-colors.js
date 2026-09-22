// _verify/tokenize-colors.js —— 把页面里硬编码的色值换成设计令牌
//
// 为什么需要它：页面 wxss 里散落着 200+ 处硬编码色值（#667085 / #F2F4F7 / #1A1D21 …），
// 这些灰其实都该走 app.wxss 的令牌。手改 120 处既慢又容易漏，所以脚本化。
//
// 安全设计（这是关键，几个坑都防了）：
//   1. 先剥掉块注释再替换 —— 否则解释性注释里提到的色值也会被改掉（本项目栽过三次）；
//   2. 跳过含 gradient / rgba / box-shadow 的声明 —— 渐变和半透明叠色要单独判断，不能机械替换；
//   3. 区分 color 属性和其它属性 —— 文字色和底色该映射到不同的令牌
//      （如 #E4551D 当文字只有 3.7:1，必须换成更深的 --brand-ink）；
//   4. 支持 --dry 只打印、不写文件。
//
// 用法： node _verify/tokenize-colors.js <小程序目录> [--dry]

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'yibang-miniprogram';
const DRY = process.argv.includes('--dry');

// 文字色：→ 文字令牌
const TEXT_MAP = {
  '#101828': 'var(--t1)', '#1a1d21': 'var(--t1)', '#111827': 'var(--t1)',
  '#344054': 'var(--t2)', '#5a6472': 'var(--t2)', '#475467': 'var(--t2)',
  '#667085': 'var(--t3)', '#8a94a6': 'var(--t3)',
  '#98a2b3': 'var(--t4)', '#a0a8b4': 'var(--t4)',
  '#c9451a': 'var(--brand-ink)', '#e4551d': 'var(--brand-ink)', '#b93f14': 'var(--brand-ink)',
  '#0b7a43': 'var(--income)', '#d92d20': 'var(--expense)', '#f04438': 'var(--expense)',
  '#b54708': 'var(--warn)', '#175cd3': 'var(--info)'
};

// 底色 / 描边：→ 表面令牌
const SURFACE_MAP = {
  '#ffffff': 'var(--card)', '#fff': 'var(--card)',
  '#f5f7fa': 'var(--bg)', '#f8f9fb': 'var(--bg)', '#f9fafb': 'var(--bg)',
  '#f2f4f7': 'var(--fill)', '#f0f2f5': 'var(--fill)',
  '#edf0f3': 'var(--line)', '#e4e8ec': 'var(--line)', '#e5e8ec': 'var(--line)',
  '#eaecf0': 'var(--line)', '#d0d5dd': 'var(--line)',
  '#c9451a': 'var(--brand-btn)', '#e4551d': 'var(--brand-btn)', '#b93f14': 'var(--brand-ink)',
  '#fff4ee': 'var(--brand-weak)', '#ffd9c6': 'var(--brand-line)',
  '#fffbeb': 'var(--warn-weak)', '#fff6e5': 'var(--warn-weak)',
  // 注意：#FDE68A（warn 的描边色）**故意不映射** —— app.wxss 里没有对应的 --warn-line 令牌。
  // 映射到不存在的 var() 不会报错，只会让 border-color 静默失效（退回 currentColor）。
  // 要收口它得先在 app.wxss 里补一个令牌。
  '#0b7a43': 'var(--income)', '#d92d20': 'var(--expense)', '#f04438': 'var(--expense)',
  '#b54708': 'var(--warn)', '#175cd3': 'var(--info)'
};

const files = [
  'pages/contacts/contacts.wxss',
  'pages/role-manage/role-manage.wxss',
  'pages/notifications/notifications.wxss',
  'pages/contact-detail/contact-detail.wxss',
  'pages/operation-logs/operation-logs.wxss'
];

let grand = 0;
const report = [];

for (const rel of files) {
  const p = path.join(ROOT, rel);
  const src = fs.readFileSync(p, 'utf8');
  const lines = src.split('\n');
  let inComment = false;
  let count = 0;
  const samples = [];

  const out = lines.map((line) => {
    // 块注释状态跟踪（跨行）
    const opens = (line.match(/\/\*/g) || []).length;
    const closes = (line.match(/\*\//g) || []).length;
    const wasIn = inComment;
    if (opens > closes) inComment = true;
    else if (closes > 0) inComment = false;

    // 注释行、含 gradient / rgba / box-shadow 的行一律不动
    if (wasIn || line.trim().startsWith('*') || /\/\*|\*\//.test(line)) return line;
    if (/gradient|rgba|box-shadow/i.test(line)) return line;

    // 解析 "prop: value" —— 只替换值里的 hex
    const m = line.match(/^(\s*)([a-z-]+)\s*:\s*(.+?)(;?)\s*$/i);
    if (!m) return line;
    const [, indent, prop, value, semi] = m;
    const map = prop.toLowerCase() === 'color' ? TEXT_MAP : SURFACE_MAP;

    let newValue = value;
    for (const hex of Object.keys(map)) {
      const re = new RegExp(hex.replace('#', '#') + '\\b', 'gi');
      if (re.test(newValue)) {
        newValue = newValue.replace(re, map[hex]);
        count++;
        if (samples.length < 6) samples.push(`${prop}: ${value} → ${newValue}`);
      }
    }
    if (newValue === value) return line;
    return `${indent}${prop}: ${newValue}${semi}`;
  });

  const result = out.join('\n');
  if (!DRY && result !== src) fs.writeFileSync(p, result, 'utf8');
  grand += count;
  report.push({ rel, count, samples, changed: result !== src });
}

console.log(DRY ? '── 试运行（未写文件）──' : '── 已写入 ──');
for (const r of report) {
  console.log(`${r.count ? '✅' : '  '} ${r.rel}  替换 ${r.count} 处`);
  r.samples.forEach((s) => console.log(`      ${s}`));
}
console.log(`\n合计替换 ${grand} 处`);
