// static-check.js 的回归测试
//
// 为什么要：这一版把"class 定义"从「全项目揉一起」改成「按页面作用域」。
// 判定逻辑一变，**既可能漏报也可能误报** —— 必须拿故意写错的样本两种都验一遍。
// 技能里写过：写完校验脚本要拿故意写错的样本回归一次，确认它真的会报错。
//
// 用法: node static-check.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'static-check.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'staticcheck-'));

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : ''));
  ok ? pass++ : fail++;
};

/** 造一个最小小程序工程：能控制全局样式、页面样式、页面模板 */
function makeProject(name, files) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'pages', 'a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'pages', 'b'), { recursive: true });

  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({
    pages: ['pages/a/a', 'pages/b/b']
  }), 'utf8');
  fs.writeFileSync(path.join(root, 'app.js'), 'App({});', 'utf8');
  fs.writeFileSync(path.join(root, 'app.wxss'), files.appWxss || '', 'utf8');

  fs.writeFileSync(path.join(root, 'pages', 'a', 'a.wxml'), files.aWxml, 'utf8');
  fs.writeFileSync(path.join(root, 'pages', 'a', 'a.js'), files.aJs || 'Page({});', 'utf8');
  fs.writeFileSync(path.join(root, 'pages', 'a', 'a.wxss'), files.aWxss || '', 'utf8');

  fs.writeFileSync(path.join(root, 'pages', 'b', 'b.wxml'), files.bWxml || '<view class="x"></view>', 'utf8');
  fs.writeFileSync(path.join(root, 'pages', 'b', 'b.js'), 'Page({});', 'utf8');
  fs.writeFileSync(path.join(root, 'pages', 'b', 'b.wxss'), files.bWxss || '.x { color: red; }', 'utf8');

  return root;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

console.log('=== ① 全局样式对每个页面都算数 ===');
{
  const root = makeProject('p1', {
    appWxss: '.global-cls { color: blue; }',
    aWxml: '<view class="global-cls"></view>'
  });
  const r = run(root);
  check(r.code === 0, 'app.wxss 里定义的类，页面能用', r.out.trim().split('\n').pop());
}

console.log('\n=== ② 别的页面定义的类，本页面用 → 必须报缺样式 ===');
{
  // b.wxss 里有 .only-b，a.wxml 却用了它 —— 这正是这次漏掉 21 处的那种 bug
  const root = makeProject('p2', {
    aWxml: '<view class="only-b"></view>',
    bWxss: '.only-b { color: red; }'
  });
  const r = run(root);
  check(r.code !== 0, '退出码非 0', 'exit=' + r.code);
  check(/only-b/.test(r.out), '**报出了跨页使用的 .only-b**', (r.out.split('\n')[2] || '').trim());
}
{
  const root = makeProject('p2b', {
    aWxml: '<view class="only-b"></view>',
    aWxss: '.only-b { color: red; }',
    bWxml: '<view class="only-b"></view>',
    bWxss: '.only-b { color: red; }'
  });
  const r = run(root);
  check(r.code === 0, '同页面自己定义了就不报', r.out.trim().split('\n').pop());
}

console.log('\n=== ③ 页面的类不会"泄漏"给别的页面 ===');
{
  // a.wxss 定义了 .only-a，b.wxml 用它是错的；但脚本不能因此把 b 也判成"有样式"
  const root = makeProject('p3', {
    aWxml: '<view class="only-a"></view>',
    aWxss: '.only-a { color: red; }',
    bWxml: '<view class="only-a"></view>',
    bWxss: ''
  });
  const r = run(root);
  check(r.code !== 0, 'b 用 a 的类 → 报错', /pages\/b\/b\.wxml/.test(r.out) ? '命中 b' : r.out.trim());
}

console.log('\n=== ④ 组合选择器（.a.b）里的两份类名都要认 ===');
{
  const root = makeProject('p4', {
    aWxml: '<view class="tbl-r is-open"></view>',
    aWxss: '.tbl-r.is-open { background: red; }'
  });
  const r = run(root);
  check(r.code === 0, '写在组合选择器里也算定义了', r.out.trim().split('\n').pop());
}

console.log('\n=== ⑤ @import 进来的样式算数 ===');
{
  const root = makeProject('p5', {
    aWxml: '<view class="imported"></view>',
    aWxss: "@import './part.wxss';\n",
    bWxss: ''
  });
  fs.writeFileSync(path.join(root, 'pages', 'a', 'part.wxss'), '.imported { color: red; }\n', 'utf8');
  const r = run(root);
  check(r.code === 0, '@import 引到的类不误报', r.out.trim().split('\n').pop());
}

console.log('\n=== ⑥ 事件处理器 / 图片 / 页面注册 仍然照旧能查 ===');
{
  const root = makeProject('p6', {
    aWxml: '<view class="x" bindtap="nope"></view>'
  });
  const r = run(root);
  check(r.code !== 0 && /缺处理器/.test(r.out), '缺事件处理器能报出来');
}
{
  const root = makeProject('p7', {
    aWxml: '<image src="/images/nope.svg" />'
  });
  const r = run(root);
  check(r.code !== 0 && /缺图片/.test(r.out), '缺图片能报出来');
}

console.log('\n=== ⑦ 从 utils mixin 借来的处理器不算「缺」 ===');
{
  // 2026-09-20 加：页面把公共方法挂在 Object.assign 里（键盘避让就是这么接的），
  // 方法名不在页面 js 的文本里，纯文本分析会误报。
  // 但这次放宽必须**只放宽到 mixin 有的那些** —— 拿一个 mixin 里没有的一起验。
  const root = makeProject('p8', {
    aJs: "const kb = require('../../utils/keyboard');\nPage(Object.assign({ open() {} }, kb.methods));\n",
    aWxml: '<input bindfocus="onKbFocus" bindblur="onKbBlur" bindkeyboardchange="notInMixin" />'
  });
  fs.mkdirSync(path.join(root, 'utils'), { recursive: true });
  fs.writeFileSync(path.join(root, 'utils', 'keyboard.js'),
    'module.exports = { methods: { onKbFocus() {}, onKbBlur() {} } };', 'utf8');
  const r = run(root);
  check(!/onKbFocus|onKbBlur/.test(r.out), 'mixin 里有的 → 不误报', r.out.trim().split('\n').filter(Boolean)[0] || '(无输出)');
  check(/notInMixin/.test(r.out), 'mixin 里没有的 → 照样报出来（放宽没过头）');
}
{
  // 没 require utils 的页面，不该因为项目里存在 mixin 就跟着放宽
  const root = makeProject('p9', {
    aJs: 'Page({});',
    aWxml: '<input bindfocus="onKbFocus" />'
  });
  fs.mkdirSync(path.join(root, 'utils'), { recursive: true });
  fs.writeFileSync(path.join(root, 'utils', 'keyboard.js'),
    'module.exports = { methods: { onKbFocus() {} } };', 'utf8');
  const r = run(root);
  check(/onKbFocus/.test(r.out), '没引这个 mixin 的页面 → 依然报缺');
}

console.log('\n================ 汇总 ================');
console.log('static-check：' + pass + ' / ' + (pass + fail) + ' 通过');
console.log('（临时目录 ' + TMP + '）');
process.exit(fail ? 1 : 0);
