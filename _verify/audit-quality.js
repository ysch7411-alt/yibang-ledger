// 代码质量审查 —— 量化脚本（2026-09-20）
//
// 为什么要写脚本而不是"读几个文件凭感觉写报告"：
//   主观描述没法验证、也没法回归。凡是能数出来的，就数出来；
//   数不出来的（比如"这个设计好不好"）才交给人工判断，并且要说清判断依据。
//
// 用法: node audit-quality.js
const fs = require('fs');
const path = require('path');

const FRONT = path.join(__dirname, '..', 'yibang-miniprogram');
const BACK = path.join(__dirname, '..', 'yibang-server');
const SKIP = ['node_modules', '.git', '_snapshots', 'uploads', 'dist', '.workbuddy'];

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (SKIP.includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/');
const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').length; } catch (e) { return 0; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };

const frontFiles = walk(FRONT);
const backFiles = walk(BACK);
const byExt = (arr, ext) => arr.filter((f) => f.endsWith(ext));

const findings = [];
const add = (level, area, title, detail, evidence) => findings.push({ level, area, title, detail, evidence });

/* ================= A. 规模盘点 ================= */
console.log('================ A. 规模盘点 ================');
const SIZES = {};
[['前端 js', byExt(frontFiles, '.js')], ['前端 wxml', byExt(frontFiles, '.wxml')],
 ['前端 wxss', byExt(frontFiles, '.wxss')], ['前端 json', byExt(frontFiles, '.json')],
 ['后端 js', byExt(backFiles, '.js')]].forEach(([label, arr]) => {
  const total = arr.reduce((s, f) => s + lines(f), 0);
  SIZES[label] = { n: arr.length, l: total };
  console.log('  ' + label.padEnd(12) + arr.length + ' 个文件 / ' + total + ' 行');
});

const allCode = byExt(frontFiles.concat(backFiles), '.js')
  .concat(byExt(frontFiles, '.wxml'), byExt(frontFiles, '.wxss'))
  .map((f) => ({ f, l: lines(f) }))
  .sort((a, b) => b.l - a.l);

console.log('\n  最大的 12 个文件：');
allCode.slice(0, 12).forEach((x) => console.log('    ' + String(x.l).padStart(5) + '  ' + rel(x.f)));

const BIG = allCode.filter((x) => x.l > 700);
if (BIG.length) {
  add('P2', '可维护性', '有 ' + BIG.length + ' 个文件超过 700 行',
    '单文件越长，改一处要通读的上下文越多、冲突面越大。这些是拆分候选。',
    BIG.map((x) => rel(x.f) + '(' + x.l + ')').join(', '));
}

/* ================= B. 前端：硬编码与令牌 ================= */
console.log('\n================ B. 前端：设计令牌遵守度 ================');
const wxssFiles = byExt(frontFiles, '.wxss');
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
let hexTotal = 0;
const hexByFile = [];
wxssFiles.forEach((f) => {
  const src = read(f);
  // 去掉注释再数，否则注释里举例的颜色也会被算进来
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = clean.match(HEX) || [];
  // 白/黑/透明这类不算"没走令牌"
  const real = hits.filter((h) => !/^#(fff|ffffff|000|000000)$/i.test(h));
  if (real.length) {
    hexTotal += real.length;
    hexByFile.push({ f, n: real.length, sample: [...new Set(real)].slice(0, 5) });
  }
});
hexByFile.sort((a, b) => b.n - a.n);
console.log('  非纯黑白的硬编码颜色：' + hexTotal + ' 处，分布在 ' + hexByFile.length + ' 个 wxss');
hexByFile.slice(0, 8).forEach((x) => console.log('    ' + String(x.n).padStart(3) + '  ' + rel(x.f) + '  ' + x.sample.join(' ')));

// 全局令牌里已经定义的颜色，出现在页面里就是"没走令牌"
const appWxss = read(path.join(FRONT, 'app.wxss'));
const tokenValues = new Set((appWxss.match(HEX) || []).map((h) => h.toLowerCase()));
const duplicated = [];
wxssFiles.filter((f) => !f.endsWith('app.wxss')).forEach((f) => {
  const clean = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
  const dups = [...new Set((clean.match(HEX) || []).map((h) => h.toLowerCase()))]
    .filter((h) => tokenValues.has(h));
  if (dups.length) duplicated.push({ f, dups });
});
const dupTotal = duplicated.reduce((s, x) => s + x.dups.length, 0);
console.log('  其中「令牌里已经有、页面却又手写一遍」的颜色：' + dupTotal + ' 处 / ' + duplicated.length + ' 个文件');
if (dupTotal) {
  add('P2', '规范', '页面里手写了全局令牌已有的颜色（' + dupTotal + ' 处）',
    '改主题色时需要同时改 N 个地方，漏一处就是两个页面颜色不一致。应当直接用 var(--xx)。',
    duplicated.slice(0, 6).map((x) => rel(x.f) + '→' + x.dups.join(',')).join(' | '));
}

/* ================= C. 前端：可读性下限 ================= */
console.log('\n================ C. 前端：字号 / 触控 / 调试残留 ================');
const smallFont = [];
wxssFiles.forEach((f) => {
  const clean = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = [...clean.matchAll(/font-size:\s*(\d+)rpx/g)].filter((m) => Number(m[1]) < 24);
  if (hits.length) smallFont.push({ f, n: hits.length, vals: hits.map((m) => m[1] + 'rpx') });
});
console.log('  字号小于 24rpx 的声明：' + smallFont.reduce((s, x) => s + x.n, 0) + ' 处');
smallFont.forEach((x) => console.log('    ' + rel(x.f) + ' → ' + x.vals.join(' ')));
if (smallFont.length) {
  add('P2', '可读性', '有 ' + smallFont.length + ' 个样式文件出现 <24rpx 字号',
    '项目自己定的下限是 24rpx（12px），目标用户是 40-60 岁的门店老板。',
    smallFont.map((x) => rel(x.f) + '(' + x.n + ')').join(', '));
}

const jsFiles = byExt(frontFiles, '.js');
const debugLeft = [];
jsFiles.concat(byExt(backFiles, '.js')).forEach((f) => {
  const src = read(f);
  const hits = [...src.matchAll(/^\s*console\.(log|info|debug)\(/gm)];
  if (hits.length) debugLeft.push({ f, n: hits.length });
});
console.log('  console.log/info/debug 残留：' + debugLeft.reduce((s, x) => s + x.n, 0) + ' 处 / ' + debugLeft.length + ' 个文件');
debugLeft.sort((a, b) => b.n - a.n).slice(0, 6).forEach((x) => console.log('    ' + String(x.n).padStart(3) + '  ' + rel(x.f)));
if (debugLeft.length) {
  add('P2', '规范', '调试日志残留 ' + debugLeft.reduce((s, x) => s + x.n, 0) + ' 处',
    'console.error/warn 保留是对的（线上排查要用），但 log/info/debug 属于开发遗留。',
    debugLeft.slice(0, 6).map((x) => rel(x.f) + '(' + x.n + ')').join(', '));
}

/* ================= D. 前端：异步健壮性 ================= */
console.log('\n================ D. 前端：异步与生命周期 ================');
/**
 * 只会"数出 await 没被 try 包住"是不够的 —— 绝大多数是**假阳性**：
 * 页面普遍用 `api.safe(...)` / `api.call(...)`，这两个内部已经把异常吃掉并返回默认值。
 * 真正会抛的是裸调 `app.request(...)` 和 wx API 的 Promise 包装。
 * 所以这里把 await 的**目标表达式**一并打出来，人一眼就能分辨。
 */
const noCatch = [];
jsFiles.forEach((f) => {
  const src = read(f);
  const methods = src.match(/\n  (?:async\s+)?[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/g) || [];
  methods.forEach((m) => {
    if (!/\bawait\b/.test(m) || /\btry\s*\{/.test(m) || /\.catch\(/.test(m)) return;
    const name = (/\n  (?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/.exec(m) || [])[1] || '?';
    const targets = [...m.matchAll(/\bawait\s+([^\n;]+)/g)].map((x) => x[1].trim().slice(0, 46));
    noCatch.push({ f, name, targets, body: m });
  });
});
/**
 * 三层判定，别靠猜：
 *   ① `await api.safe(...)` / `api.call(...)` —— 当面包着，安全
 *   ② `await api.xxx(...)` —— 要看 utils/api.js 里那个函数**内部**有没有用 safe/call
 *   ③ 其余（this.xxx / 自定义封装 / Promise.all 展开）—— 才需要人工看
 * 第一版只看"参数里有没有 app.request"，把 3 个安全调用误标成风险；
 * 第二版只看最外层，又把 18 个 api.xxx 误标。**判据不精确就会浪费别人的时间。**
 */
const apiSrc = read(path.join(FRONT, 'utils', 'api.js'));
function apiFnSafe(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([\\s\\S]*?\\n\\}').exec(apiSrc);
  return !!m && /\b(?:safe|call)\s*\(/.test(m[1]);
}
function isSafeTarget(t) {
  const s = String(t).trim();
  if (/^api\.(safe|call)\s*\(/.test(s)) return true;
  const m = /^api\.([a-zA-Z_$][\w$]*)\s*\(/.exec(s);
  return !!(m && apiFnSafe(m[1]));
}
function risksIn(body) {
  const out = [];
  [...body.matchAll(/\bawait\s+([^\n;]+)/g)].forEach((x) => {
    const t = x[1].trim();
    if (/^Promise\.all\s*\(/.test(t)) {
      // Promise.all 里的每个 api.xxx 都要单独判
      [...body.matchAll(/\bapi\.([a-zA-Z_$][\w$]*)\s*\(/g)].forEach((y) => {
        if (!apiFnSafe(y[1])) out.push('api.' + y[1] + '()（Promise.all 内）');
      });
    } else if (!isSafeTarget(t)) {
      out.push(t.slice(0, 44));
    }
  });
  return out;
}
noCatch.forEach((x) => { x.risks = risksIn(x.body); });
const risky = noCatch.filter((x) => x.risks.length);
console.log('  方法内有 await、但既没 try 也没 .catch 的：' + noCatch.length + ' 处');
console.log('    ├─ 已被 api.safe/call（或其包装）兜住 → 安全 ' + (noCatch.length - risky.length) + ' 处');
console.log('    └─ 需要人工确认 → ' + risky.length + ' 处');
risky.forEach((x) => console.log('       ' + rel(x.f) + ' → ' + x.name + '()  ' + x.risks.join(' / ')));
// 这一项实测没有问题就不进 findings ——
// 审查报告宁可少一条，也不能把假阳性写成"待修问题"让人白改。
if (risky.length) {
  add('P2', '健壮性', risky.length + ' 处 await 没被兜底',
    '需逐个确认失败时页面是否有合理落点（不能卡在 loading）。', risky.map((x) => rel(x.f) + ':' + x.name + '()').join(', '));
}

const timers = [];
jsFiles.forEach((f) => {
  const src = read(f);
  const set = (src.match(/\bsetTimeout\(/g) || []).length + (src.match(/\bsetInterval\(/g) || []).length;
  const clr = (src.match(/\bclearTimeout\(/g) || []).length + (src.match(/\bclearInterval\(/g) || []).length;
  if (set > clr) timers.push({ f, set, clr });
});
console.log('  setTimeout/Interval 多于 clear 的文件：' + timers.length + ' 个');
timers.forEach((x) => console.log('    ' + rel(x.f) + '  set=' + x.set + ' clear=' + x.clr));

/* ================= E. 后端：接口与错误处理 ================= */
console.log('\n================ E. 后端：接口 / 校验 / SQL ================');
const routeFiles = byExt(backFiles, '.js').filter((f) => /routes[\\/]/.test(f));
let epTotal = 0, resJson = 0, resStatus = 0, rawSql = 0, noValidate = [];
routeFiles.forEach((f) => {
  const src = read(f);
  epTotal += (src.match(/router\.(get|post|put|delete|patch)\s*\(/g) || []).length;
  resJson += (src.match(/res\.json\(/g) || []).length;
  resStatus += (src.match(/res\.status\(/g) || []).length;
  rawSql += (src.match(/pool\.query\(\s*[`'"][^`'"]*\$\{/g) || []).length;
});
console.log('  路由文件 ' + routeFiles.length + ' 个 / 端点 ' + epTotal + ' 个');
console.log('  res.json 用法 ' + resJson + ' 次，res.status 用法 ' + resStatus + ' 次');
console.log('  SQL 模板串拼接（潜在注入）' + rawSql + ' 处');
if (rawSql > 0) {
  add('P0', '安全', 'SQL 里出现模板串拼接 ' + rawSql + ' 处', '只要拼接的是用户输入就是注入；必须一律参数化。', '见 routes/*.js');
}

/* ================= F. 重复与死代码 ================= */
console.log('\n================ F. 重复代码 / 未用导出 ================');
// 跨页面 wxss 重复的类名
const classMap = {};
wxssFiles.filter((f) => !f.endsWith('app.wxss')).forEach((f) => {
  const clean = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
  (clean.match(/^\.[a-zA-Z][\w-]*/gm) || []).forEach((c) => {
    classMap[c] = classMap[c] || [];
    if (!classMap[c].includes(f)) classMap[c].push(f);
  });
});
const shared = Object.keys(classMap).filter((c) => classMap[c].length >= 2);
console.log('  在 ≥2 个页面 wxss 里各自定义的类：' + shared.length + ' 个');
shared.forEach((c) => console.log('    ' + c + '  →  ' + classMap[c].map((f) => rel(f).replace('yibang-miniprogram/pages/', '')).join(', ')));
if (shared.length) {
  add('P1', '可维护性', '有 ' + shared.length + ' 个样式类在多个页面各写一遍',
    '项目自己定的规则是"被 ≥2 个页面用到就住 app.wxss"。这些是漏网的：改一处忘一处就会视觉不一致。',
    shared.map((c) => c + '(' + classMap[c].length + ')').join(', '));
}

// 导出了但全项目没人调用的 utils 函数
const utilsFiles = byExt(frontFiles, '.js').filter((f) => /utils[\\/]/.test(f));
const allFrontSrc = frontFiles.filter((f) => /\.(js|wxml)$/.test(f)).map(read).join('\n');
const unusedExports = [];
utilsFiles.forEach((f) => {
  const src = read(f);
  const m = /module\.exports\s*=\s*\{([\s\S]*?)\}/.exec(src);
  if (!m) return;
  const names = m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter((s) => /^[a-zA-Z_$][\w$]*$/.test(s));
  names.forEach((n) => {
    // 在别处（除本文件外）出现过就当作被使用
    const others = allFrontSrc.split(src).join('\n');
    const used = new RegExp('\\b' + n + '\\s*[(.:]|\\b' + n + '\\b').test(others);
    if (!used) unusedExports.push({ f, n });
  });
});
console.log('  utils 里导出但全项目没用到的：' + unusedExports.length + ' 个');
unusedExports.forEach((x) => console.log('    ' + rel(x.f) + ' → ' + x.n));
if (unusedExports.length) {
  add('P2', '死代码', unusedExports.length + ' 个 utils 导出没有任何调用方',
    '留着会被误以为是可用的能力（或被复制进新代码）。确认无用就删。',
    unusedExports.map((x) => rel(x.f) + ':' + x.n).join(', '));
}

/* ================= 汇总 ================= */
console.log('\n================ 汇总 ================');
const byLevel = { P0: [], P1: [], P2: [] };
findings.forEach((f) => byLevel[f.level].push(f));
['P0', 'P1', 'P2'].forEach((lv) => {
  console.log('  ' + lv + '：' + byLevel[lv].length + ' 条');
  byLevel[lv].forEach((f) => console.log('     · [' + f.area + '] ' + f.title));
});
console.log('\n  待人工判断（脚本数不出来的）：见报告里的"设计层面"一节');
