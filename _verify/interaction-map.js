// 交互点清单（2026-09-20 上线前功能验证）
//
// 目的：把"用户能点的每一个东西"穷举出来，作为逐个验证的清单。
// 之前所有验证都停在接口层，**没验过用户操作路径** —— 而"用起来不顺畅"的 bug
// 恰恰出在操作路径上（点了没反应、返回不刷新、并发点两次）。
//
// 同时抓两类硬问题：
//   ① 绑了事件但处理器不存在 / 是空实现（点了没反应）
//   ② 页面里调了接口，但没有任何 catch/兜底（失败时页面会卡在 loading）
//
// 用法: node interaction-map.js [页面名]    不带参数则输出全部
const fs = require('fs');
const path = require('path');

const FRONT = path.join(__dirname, '..', 'yibang-miniprogram');
const only = process.argv[2];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(wxml|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(FRONT);
const pages = {};
files.forEach((f) => {
  const m = /pages[\\/]([\w-]+)[\\/]/.exec(f);
  if (!m) return;
  const name = m[1];
  if (!pages[name]) pages[name] = { wxml: null, js: null };
  if (f.endsWith('.wxml')) pages[name].wxml = f;
  else pages[name].js = f;
});

const read = (p) => (p ? fs.readFileSync(p, 'utf8') : '');

let problems = [];
const names = Object.keys(pages).sort();
names.forEach((name) => {
  if (only && name !== only) return;
  const wxml = read(pages[name].wxml);
  const js = read(pages[name].js);

  // ① 交互点：事件 → 处理器
  const evs = [];
  const re = /\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g;
  let m;
  while ((m = re.exec(wxml))) {
    const ev = m[1].replace(/^tap$/, 'tap');
    // 抓这个标签上有哪些 data-* 参数（决定它操作的是哪一条数据）
    const line = wxml.slice(0, m.index).split('\n').pop();
    const start = wxml.lastIndexOf('<', m.index);
    const tag = wxml.slice(start, m.index + m[0].length);
    const dataKeys = [...tag.matchAll(/data-([\w-]+)=/g)].map((x) => x[1]);
    evs.push({ ev, fn: m[2], dataKeys });
  }

  // ② 处理器是否存在、是否空实现
  // 三个坑，都栽过：① `async foo()` 的 async 前缀 ② CRLF 行尾
  // ③ 通过 Object.assign({...}, kb.methods) 从 mixin 借来的方法（键盘避让就是）
  const mixinFns = new Set(['onKbFocus', 'onKbBlur', 'onKbHeight', 'setKb']);
  const emptyFns = [];
  evs.forEach((e) => {
    if (mixinFns.has(e.fn)) return;                     // 来自 utils/keyboard.js
    const re2 = new RegExp('\\n\\s{2}(?:async\\s+)?' + e.fn + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s{2}\\}');
    const body = re2.exec(js);
    if (!body) {
      emptyFns.push(e.fn + '（找不到定义）');
    } else {
      const cleaned = body[1].replace(/^[ \t]*\/\/.*$/gm, '').replace(/\s/g, '');
      if (!cleaned) emptyFns.push(e.fn + '（是空实现）');
    }
  });

  // ③ 页面调的接口，有没有兜底
  const apiCalls = [...js.matchAll(/\bapi\.([a-zA-Z_$][\w$]*)\s*\(/g)].map((x) => x[1]);
  const rawReqs = [...js.matchAll(/app\(\)\.request\(|app\.request\(/g)].length;
  const hasTry = (js.match(/\btry\s*\{/g) || []).length;

  // ④ 生命周期钩子
  const hooks = ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onReachBottom', 'onPullDownRefresh', 'onShareAppMessage', 'onPageScroll']
    .filter((h) => new RegExp('\\n  ' + h + '\\s*\\(').test(js));

  console.log('\n━━━━━━ ' + name + ' ━━━━━━');
  console.log('  交互点 ' + evs.length + ' 个 · 接口调用 ' + (apiCalls.length + rawReqs) + ' 处 · try 块 ' + hasTry + ' 个');
  console.log('  生命周期：' + (hooks.join(', ') || '(无)'));
  if (apiCalls.length) console.log('  用到的接口：' + [...new Set(apiCalls)].join(', '));

  const byFn = {};
  evs.forEach((e) => { byFn[e.fn] = (byFn[e.fn] || 0) + 1; });
  console.log('  处理器：' + Object.entries(byFn).map(([f, n]) => f + (n > 1 ? '×' + n : '')).join('  '));

  if (emptyFns.length) {
    problems.push('[P1] ' + name + '：处理器有问题 → ' + emptyFns.join('、'));
    console.log('  ✗ ' + emptyFns.join('、'));
  }
  // 有裸 request 但没有 try：失败会冒到顶层
  if (rawReqs > 0 && hasTry === 0) {
    problems.push('[P2] ' + name + '：有 ' + rawReqs + ' 处裸 request 但整个页面一个 try 都没有');
  }
});

console.log('\n================ 汇总 ================');
if (problems.length) problems.forEach((p) => console.log('  ' + p));
else console.log('  ✓ 没有"绑了事件但处理器缺失/为空"的情况');
