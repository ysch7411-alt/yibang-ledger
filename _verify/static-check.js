// 编译前静态自检：事件处理器 / class 定义 / 本地图片路径 是否齐备
// 外加 wxss 语法自查（2026-09-20 补：`*` 通配符让模拟器编译失败过）
// 用法: node static-check.js <小程序根目录>
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2];
if (!ROOT) {
  console.log('用法: node static-check.js <小程序根目录>');
  process.exit(1);
}

function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

const files = walk(ROOT);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

/* ---------------- class 定义：**按作用域**收集 ----------------
   WXSS 是页面级作用域！`pages/a/a.wxss` 里定义的 `.foo` 在 `pages/b/b.wxml` 上**不生效**。
   原来这里把所有 wxss 揉成一个集合，于是"在别的页面定义过"也会被判成有样式 ——
   实测就漏掉过：summary 页用了 `.list-hd`，而它只在采购页/记账页的页面样式里，
   那个区块头一直是没样式的裸文字，自检却是绿的。
   现在分三层：全局（app.wxss） / 页面自己（同目录 wxss） / 组件自己。 */
function classesOf(wxssFile) {
  const out = new Set();
  const seen = new Set();
  const read = (f) => {
    if (seen.has(f) || !fs.existsSync(f)) return;
    seen.add(f);
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    (src.match(/\.[A-Za-z_][\w-]*/g) || []).forEach((c) => out.add(c.slice(1)));
    // 跟着 @import 走一层：被引的样式对引入者同样生效，
    // 不跟的话会把"通过 @import 拿到的类"误报成缺样式
    (src.match(/@import\s+['"]([^'"]+)['"]/g) || []).forEach((line) => {
      const p = line.replace(/@import\s+['"]|['"]/g, '');
      if (/^https?:/.test(p)) return;
      read(path.resolve(path.dirname(f), p));
    });
  };
  read(wxssFile);
  return out;
}

const GLOBAL_WXSS = path.join(ROOT, 'app.wxss');
const globalClasses = classesOf(GLOBAL_WXSS);

/** 某个 wxml 能用到的类 = 全局 + 同目录下所有 wxss */
const scopeCache = {};
function allowedFor(wxmlFile) {
  const dir = path.dirname(wxmlFile);
  if (scopeCache[dir]) return scopeCache[dir];
  const set = new Set(globalClasses);
  files.filter((f) => f.endsWith('.wxss') && path.dirname(f) === dir).forEach((f) => {
    classesOf(f).forEach((c) => set.add(c));
  });
  scopeCache[dir] = set;
  return set;
}

/**
 * 页面可以从 mixin 借方法（如 `Page(Object.assign({...}, kb.methods))`），
 * 这些方法名不在页面 js 的**文本**里 —— 纯文本分析会把它们误报成「缺处理器」。
 * 这里把项目内 utils 模块导出的 `methods` 方法名也算作已定义。
 * 只 require `utils/` 下的模块（它们是纯函数/常量，不依赖 wx，加载安全），
 * 并且整段包在 try 里：读不了就当没有 mixin，不让自检本身崩掉。
 */
const mixinCache = {};
function mixinHandlers(jsFile, js) {
  if (mixinCache[jsFile]) return mixinCache[jsFile];
  const out = new Set();
  const reR = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = reR.exec(js))) {
    if (m[1].indexOf('utils/') < 0) continue;
    try {
      const mod = require(path.resolve(path.dirname(jsFile), m[1]));
      if (mod && mod.methods) Object.keys(mod.methods).forEach((k) => out.add(k));
    } catch (e) { /* 加载失败＝没有 mixin，交给后面的文本判定 */ }
  }
  mixinCache[jsFile] = out;
  return out;
}

const problems = [];

/* ---------------- 0) wxss 语法：wxss 不支持的写法会直接编译失败 ----------------
   2026-09-20 真机事故：为了"一次罩住所有弹层后代"，在 app.wxss 写了
   `.sheet * { box-sizing: border-box }` —— 微信小程序的 wxss **不支持 `*` 通配符**，
   也不支持 `>` 直接子选择器。模拟器整页白屏，只提示「编译 .wxss 文件错误」，
   不告诉你是哪一行、哪个字符。所以在这里提前拦。 */
const wxssFiles = files.filter((f) => f.endsWith('.wxss'));
wxssFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  src.split('\n').forEach((line, i) => {
    const noComment = line.replace(/\/\*.*$/,'');
    // `.a *` / `.a > b` / `* {}`：这三类 wxss 都不认
    if (/(^|[\s,>])\*\s*(,|\{|$|\.|#)/.test(noComment) || /^\s*\*/.test(noComment)) {
      problems.push('[wxss] ' + rel(f) + ':' + (i + 1) + ' 用了 `*` 通配符，wxss 不支持（编译直接失败）');
    }
    if (/>/.test(noComment) && /[^=!]>[^=]/.test(noComment) && /[.#a-zA-Z]\s*>\s*[.#a-zA-Z\[]/.test(noComment)) {
      problems.push('[wxss] ' + rel(f) + ':' + (i + 1) + ' 用了 `>` 直接子选择器，wxss 不支持');
    }
  });
  // 大括号配平：少一个 `}` 会让后面所有规则失效，而且报错信息指不到这里
  const open = (clean.match(/\{/g) || []).length;
  const close = (clean.match(/\}/g) || []).length;
  if (open !== close) {
    problems.push('[wxss] ' + rel(f) + ' 大括号不配平：{ ' + open + ' 个 / } ' + close + ' 个');
  }
});

// 1) WXML：事件处理器 + class + 图片路径
const wxmls = files.filter((f) => f.endsWith('.wxml'));
wxmls.forEach((wf) => {
  const src = fs.readFileSync(wf, 'utf8');
  const dir = path.dirname(wf);
  const defined = allowedFor(wf);

  // 对应 js：页面取同名 js；组件取同目录 index.js
  let jsFile = wf.replace(/\.wxml$/, '.js');
  if (!fs.existsSync(jsFile)) jsFile = path.join(dir, 'index.js');
  const js = fs.existsSync(jsFile) ? fs.readFileSync(jsFile, 'utf8') : '';

  // 1a 事件处理器
  const handlers = new Set();
  const reH = /\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g;
  let m;
  while ((m = reH.exec(src))) handlers.add(m[2]);
  const mixin = mixinHandlers(jsFile, js);
  handlers.forEach((h) => {
    const ok = mixin.has(h) || new RegExp('(^|[\\s,{])' + h + '\\s*[(:]').test(js);
    if (!ok) problems.push('[缺处理器] ' + rel(wf) + ' → ' + h + '() 未在 ' + rel(jsFile) + ' 中定义');
  });

  // 1b class 是否定义
  // 取 class 属性里的字面量 + {{三元}} 里作为「结果」的字符串。
  // 三元里的比较值（=== 'receivable'）和 is-{{x}} 这类前后缀碎片要排除，否则全是误报。
  const classAttrs = src.match(/class\s*=\s*"([^"]*)"/g) || [];
  const tokens = new Set();
  classAttrs.forEach((attr) => {
    const body = attr.replace(/^class\s*=\s*"/, '').replace(/"$/, '');
    (body.match(/\{\{[\s\S]*?\}\}/g) || []).forEach((expr) => {
      if (expr.indexOf('?') < 0) return;
      const resultPart = expr.slice(expr.indexOf('?'));
      (resultPart.match(/'[^']*'/g) || []).forEach((q) => {
        // 排除比较值：嵌套三元里 `calBy === 'month'` 的 'month' 不是类名。
        // 先把前面的空白去掉再判，否则 `=== ` 尾巴上有个空格就对不上了
        // （第一版就是漏了 trim，害我以为是别的原因）。
        const at = resultPart.indexOf(q);
        const before = resultPart.slice(Math.max(0, at - 8), at).trim();
        if (/[=!]==?$/.test(before)) return;
        q.slice(1, -1)
          .split(/\s+/)
          .forEach((t) => t && tokens.add(t));
      });
    });
    // 去掉插值后的静态部分
    body
      .replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .split(/\s+/)
      .forEach((t) => t && tokens.add(t));
  });
  tokens.forEach((t) => {
    if (!t || /^[\{\}]/.test(t)) return;
    if (/[-_]$/.test(t) || /^[-_]/.test(t)) return; // is-{{x}} 这类碎片
    if (!defined.has(t)) problems.push('[缺样式] ' + rel(wf) + ' → .' + t + ' 没有任何 wxss 定义');
  });

  // 1c 本地图片
  const reImg = /src\s*=\s*"(\/images\/[^"{}]+)"/g;
  let mi;
  while ((mi = reImg.exec(src))) {
    const target = path.join(ROOT, mi[1].replace(/^\//, ''));
    if (!fs.existsSync(target)) problems.push('[缺图片] ' + rel(wf) + ' → ' + mi[1]);
  }
});

// 3) 页面/组件 JS：用到的工具模块必须已经 require
//    只查 pages/ 与 custom-tab-bar/；先剥掉字符串字面量，避免 api.dtzai.cn 这类 URL 误报
files.filter((f) => f.endsWith('.js')).forEach((f) => {
  const r = rel(f);
  if (!/^(pages|custom-tab-bar)\//.test(r)) return;

  const raw = fs
    .readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // 判「是否使用」要剥掉字符串，避免 api.dtzai.cn 这类 URL 误报；
  // 判「是否 require」必须用带字符串的原文，否则路径被一起剥掉了。
  const code = raw
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  [['fmt', /\bfmt\s*\./, 'format'], ['api', /\bapi\s*\./, 'api']].forEach(([name, re, mod]) => {
    if (!re.test(code)) return;
    const required = new RegExp("require\\(\\s*['\"][^'\"]*" + mod + "['\"]\\s*\\)");
    if (!required.test(raw)) {
      problems.push('[缺 require] ' + r + ' → 用了 ' + name + '. 但没引入 utils/' + mod);
    }
  });
});

// 4) app.json 里声明的页面 / tabBar 页面 文件是否齐全
const appJsonPath = path.join(ROOT, 'app.json');
if (fs.existsSync(appJsonPath)) {
  const cfg = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  (cfg.pages || []).forEach((p) => {
    ['.wxml', '.js', '.wxss'].forEach((ext) => {
      const f = path.join(ROOT, p + ext);
      if (!fs.existsSync(f)) problems.push('[缺页面文件] ' + p + ext);
    });
  });
  const tabs = (cfg.tabBar && cfg.tabBar.list) || [];
  tabs.forEach((t) => {
    if (!(cfg.pages || []).includes(t.pagePath)) {
      problems.push('[tabBar 未注册] ' + t.pagePath + ' 不在 pages 列表中');
    }
  });
  if (cfg.tabBar && cfg.tabBar.custom) {
    ['index.wxml', 'index.js', 'index.json'].forEach((f) => {
      const p = path.join(ROOT, 'custom-tab-bar', f);
      if (!fs.existsSync(p)) problems.push('[缺自定义 tabBar] custom-tab-bar/' + f);
    });
  }
}

if (problems.length) {
  console.log('发现 ' + problems.length + ' 个问题：\n');
  problems.forEach((p) => console.log('  ' + p));
  process.exit(1);
}
console.log('静态自检通过：' + wxmls.length + ' 个 wxml，class / 处理器 / 图片 / 页面注册 全部就位');
