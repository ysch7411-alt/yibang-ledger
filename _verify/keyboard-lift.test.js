// 键盘避让的回归断言（2026-09-20 真机 bug）
//
// 背景：真机上记账页的输入条只露出上半个圆角，其余被输入法切掉。
// 根因：`.dock` / `.receipt` / `.sheet` 都是 `position: fixed`，
// 而 `input` 默认的 `adjust-position` 只能把**页面滚动**往上推，推不动 fixed 元素；
// Android 上键盘是盖在 webview 之上的，贴底的固定条下半截必然被压住。
//
// 修法是三件套，**少任何一件都会静默失效**（不报错、编译也过，只是真机上照旧被遮）：
//   ① input：adjust-position="{{false}}" + 三个键盘事件
//   ② 容器：style="--kb-lift: {{kbLift}}px;"
//   ③ 样式：定位写成 max(原位, var(--kb-lift, 0px))，且页面 js 接上 kb.methods
//
// 反向也要钉住：**页面流里的输入框恰恰需要自动上推**，
// 谁要是"统一批量加上 adjust-position=false"，反而会把它们改坏。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'yibang-miniprogram');
const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let pass = 0, fail = 0;
function say(ok, label, extra) {
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (extra ? '  → ' + extra : ''));
}

/** 文件里所有的 <input ... /> 标签 */
const inputsOf = (p) => rd(p).match(/<input[\s\S]*?\/>/g) || [];
const pick = (tags, cls) => tags.filter((t) => new RegExp('class="[^"]*\\b' + cls + '\\b').test(t));

/**
 * blur 处理器：默认是 mixin 的 onKbBlur；
 * 但页面自己的 blur 处理器（如记账页 dock 的 onDraftBlur，它还要收 focusDraft）
 * 只要内部把高度归零了，效果一样 —— 认它，别逼着页面为了通过检查而拆成两个绑定。
 */
function blurOk(tag, js) {
  const m = /bindblur="([^"]+)"/.exec(tag);
  if (!m) return false;
  if (m[1] === 'onKbBlur') return true;
  const body = new RegExp(m[1] + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s{2}\\}').exec(js);
  return !!body && /setKb\(0\)/.test(body[1]);
}

/** 三件套：关掉自动上推 + 三个键盘事件（focus 兜底 / blur 归零 / 高度变化） */
const COMPLETE = (t, js) =>
  /adjust-position="\{\{false\}\}"/.test(t) &&
  /bindfocus="onKbFocus"/.test(t) &&
  blurOk(t, js) &&
  /bindkeyboardheightchange="onKbHeight"/.test(t);

/* ---------------- ① 贴底容器里的输入框 ---------------- */
console.log('=== ① 贴底 fixed 容器里的输入框：三件套必须齐 ===');
const MUST = {
  'pages/record/record.wxml': ['receipt-input', 'ibar-input', 'f-amount-input', 'f-input'],
  // 2026-09-20 输入条抽成公共组件后，advisor 用的是 .ibar-input
  'pages/advisor/advisor.wxml': ['ibar-input'],
  'pages/profile/profile.wxml': ['f-input'],
  'pages/purchase/purchase.wxml': ['cat-input']
};
Object.keys(MUST).forEach((file) => {
  const tags = inputsOf(file);
  const js = rd(file.replace(/\.wxml$/, '.js'));
  MUST[file].forEach((cls) => {
    const hits = pick(tags, cls);
    say(hits.length > 0, file.split('/')[1] + '：找得到 .' + cls + '（应存在）', hits.length + ' 个');
    hits.forEach((t, i) => {
      const name = '  .' + cls + (hits.length > 1 ? ' #' + (i + 1) : '');
      const missing = [
        !/adjust-position="\{\{false\}\}"/.test(t) && 'adjust-position="{{false}}"',
        !/bindfocus="onKbFocus"/.test(t) && 'bindfocus',
        !blurOk(t, js) && 'bindblur（或自己的 blur 里调 setKb(0)）',
        !/bindkeyboardheightchange="onKbHeight"/.test(t) && 'bindkeyboardheightchange'
      ].filter(Boolean);
      say(missing.length === 0, name + ' 三件套齐全', missing.length ? '缺 ' + missing.join(' / ') : '');
    });
  });
});

/* ---------------- ② 页面流里的输入框，不许被改坏 ---------------- */
console.log('\n=== ② 页面流里的输入框：不许被人"统一批量"关掉自动上推 ===');
const MUST_NOT = {
  'pages/search/search.wxml': ['search-input'],              // 顶部搜索框，自己就在可视区
  'pages/purchase/purchase.wxml': ['pe-name', 'pe-spec', 'pe-in']  // 明细行，靠自动上推才不被遮
};
Object.keys(MUST_NOT).forEach((file) => {
  const tags = inputsOf(file);
  MUST_NOT[file].forEach((cls) => {
    const hits = pick(tags, cls);
    say(hits.length > 0, file.split('/')[1] + '：找得到 .' + cls, hits.length + ' 个');
    hits.forEach((t, i) => {
      const off = /adjust-position="\{\{false\}\}"/.test(t);
      say(!off, '  .' + cls + (hits.length > 1 ? ' #' + (i + 1) : '') + ' 保留了自动上推（页面流元素需要它）',
        off ? '被改成了 false，会更糟！' : '');
    });
  });
});

/* ---------------- ③ 容器带上了变量 ---------------- */
console.log('\n=== ③ 要避让的容器：style 里要有 --kb-lift ===');
const MUST_VAR = {
  'pages/record/record.wxml': ['ibar', 'dock-tip', 'receipt'],
  'pages/advisor/advisor.wxml': ['chat-sheet'],
  'pages/profile/profile.wxml': [],
  'pages/purchase/purchase.wxml': ['cat-sheet']
};
Object.keys(MUST_VAR).forEach((file) => {
  const src = rd(file);
  MUST_VAR[file].forEach((cls) => {
    const re = new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*--kb-lift');
    say(re.test(src), file.split('/')[1] + '：.' + cls + ' 带 --kb-lift');
  });
});
// 这几个页面的 sheet 是同一个 class，逐个点名，别漏
[['pages/record/record.wxml', '改一下弹层'], ['pages/profile/profile.wxml', '改店名弹层']].forEach(([f, who]) => {
  const sheets = rd(f).match(/<view[^>]*class="sheet"[^>]*>/g) || [];
  say(sheets.some((s) => /--kb-lift/.test(s)), f.split('/')[1] + '：' + who + '的 .sheet 带 --kb-lift',
    sheets.length + ' 个 .sheet，带变量的 ' + sheets.filter((s) => /--kb-lift/.test(s)).length + ' 个');
});

/* ---------------- ④ 样式必须参与定位（而不是简单叠加） ---------------- */
console.log('\n=== ④ 样式：用 max(原位, var(--kb-lift)) 参与计算 ===');
const appWxss = rd('app.wxss');
say(/\.sheet\s*\{[\s\S]*?bottom:\s*max\([\s\S]*?var\(--kb-lift/.test(appWxss),
  'app.wxss 的 .sheet 用 max() 参与定位');
say(/\.sheet\s*\{[\s\S]*?max-height:\s*calc\(88vh\s*-\s*var\(--kb-lift/.test(appWxss),
  '.sheet 的高度上限也跟着让出键盘高度');
// 不允许把键盘高度"加"在 tabbar-h 上 —— 键盘弹起时 tabBar 已被压住，那样会悬空出一条缝。
// 正确写法是 max(贴 tabBar, 贴键盘)。
const recWxss = rd('pages/record/record.wxss');
['.receipt', '.dock-tip'].forEach((n) => {
  const block = new RegExp('\\' + n + '\\s*\\{([\\s\\S]*?)\\n\\}').exec(recWxss);
  const css = block ? block[1] : '';
  say(/\bbottom:\s*max\(/.test(css), 'record.wxss 的 ' + n + ' 用 max() 参与定位');
  say(!/\bbottom:\s*calc\([^;]*\+\s*var\(--kb-lift/.test(css),
    n + ' 没有把键盘高度直接加在 tabbar-h 上（那样会在键盘上方悬空一条缝）');
});
say(/\.chat-sheet\s*\{[\s\S]*?height:\s*calc\(80vh\s*-\s*var\(--kb-lift/.test(rd('pages/advisor/advisor.wxss')),
  '.chat-sheet 的高度跟着键盘让出来');

/* ---------------- ⑤ 页面 js 接线 ---------------- */
console.log('\n=== ⑤ 页面 js：接上 kb.methods 且 data 里有 kbLift ===');
['pages/record/record.js', 'pages/advisor/advisor.js', 'pages/profile/profile.js', 'pages/purchase/purchase.js']
  .forEach((f) => {
    const js = rd(f);
    const name = f.split('/')[1];
    say(/require\(['"][^'"]*utils\/keyboard['"]\)/.test(js), name + '：require 了 utils/keyboard');
    say(/Page\(Object\.assign\(/.test(js) && /\},\s*kb\.methods\)\)/.test(js), name + '：用的是 Object.assign(..., kb.methods)');
    say(/kbLift:\s*0/.test(js), name + '：data 里有 kbLift: 0');
  });

/* ---------------- ⑥ mixin 本身 ---------------- */
console.log('\n=== ⑥ utils/keyboard.js 提供的方法 ===');
const kbm = require(path.join(SRC, 'utils/keyboard.js'));
['onKbFocus', 'onKbBlur', 'onKbHeight', 'setKb'].forEach((m) => {
  say(typeof kbm.methods[m] === 'function', 'methods.' + m + ' 在');
});
say(Object.keys(kbm.methods).length === 4, '方法不多不少（多了说明有人往里塞了别的东西）',
  Object.keys(kbm.methods).join(','));

// setKb 的去重：同样的高度不该反复 setData
{
  let sets = 0;
  const fake = { data: { kbLift: 0 }, setData() { sets++; throw new Error('不该被调到'); } };
  kbm.methods.setKb.call(fake, 0);
  say(sets === 0, 'setKb：高度没变时不 setData（避免白刷）');
  const fake2 = { data: { kbLift: 0 }, setData(d) { fake2.data.kbLift = d.kbLift; } };
  kbm.methods.setKb.call(fake2, 300.7);
  say(fake2.data.kbLift === 301, 'setKb：四舍五入取整', String(fake2.data.kbLift));
  kbm.methods.setKb.call(fake2, -5);
  say(fake2.data.kbLift === 0, 'setKb：负数归 0（键盘收起）', String(fake2.data.kbLift));
}

console.log('\n' + (fail ? '✗ ' + fail + ' 项不合格' : '✓ 全部通过') + '（通过 ' + pass + '，失败 ' + fail + '）');
process.exit(fail ? 1 : 0);
