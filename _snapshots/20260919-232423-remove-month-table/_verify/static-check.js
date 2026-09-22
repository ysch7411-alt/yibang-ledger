// 编译前静态自检：事件处理器 / class 定义 / 本地图片路径 是否齐备
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

const problems = [];

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
  handlers.forEach((h) => {
    const ok = new RegExp('(^|[\\s,{])' + h + '\\s*[(:]').test(js);
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
