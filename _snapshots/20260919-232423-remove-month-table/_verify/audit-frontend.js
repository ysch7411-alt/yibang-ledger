// 前端全量审计：结构完整性 / 注册一致性 / 资源存在性 / 语法 / JSON
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || 'F:/2026-09-19/new-chat-1/yibang-miniprogram';

const out = [];
const ok = (s) => out.push('  ✓ ' + s);
const bad = (s) => out.push('  ✗ ' + s);

function walk(d, o = []) {
  fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, o); else o.push(p);
  });
  return o;
}
const files = walk(ROOT);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

console.log('=== ① 页面四件套完整性 ===');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pageDirs = fs.readdirSync(path.join(ROOT, 'pages'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const missingParts = [];
pageDirs.forEach((d) => {
  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    const p = path.join(ROOT, 'pages', d, d + '.' + ext);
    if (!fs.existsSync(p)) missingParts.push('pages/' + d + '/' + d + '.' + ext);
  });
});
missingParts.length ? bad('缺文件：' + missingParts.join(', ')) : ok(pageDirs.length + ' 个页面各有 js/json/wxml/wxss 四件套');

console.log('\n=== ② 页面注册一致性（app.json ↔ 磁盘）===');
const declared = appJson.pages || [];
const onDisk = pageDirs.map((d) => 'pages/' + d + '/' + d);
const notRegistered = onDisk.filter((p) => !declared.includes(p));
const notExist = declared.filter((p) => !onDisk.includes(p));
notRegistered.length ? bad('磁盘上有但没注册：' + notRegistered.join(', ')) : ok('磁盘上 ' + onDisk.length + ' 个页面全部已注册');
notExist.length ? bad('注册了但磁盘上没有：' + notExist.join(', ')) : ok('注册的 ' + declared.length + ' 个页面全部存在');
appJson.pages[0] === 'pages/record/record' ? ok('启动页是记账页（注册页靠门槛跳转，不做启动页）') : bad('启动页不是记账页：' + appJson.pages[0]);

console.log('\n=== ③ tabBar 与自定义组件一致性 ===');
const tabs = (appJson.tabBar && appJson.tabBar.list || []).map((t) => t.pagePath);
console.log('  tabBar: ' + tabs.join('  '));
const tabOk = tabs.every((t) => declared.includes(t));
tabOk ? ok('tabBar 的 ' + tabs.length + ' 个页面都在 pages 里') : bad('有 tabBar 页面不在 pages 里');
const ctb = ['index.js', 'index.json', 'index.wxml', 'index.wxss'].filter((f) => !fs.existsSync(path.join(ROOT, 'custom-tab-bar', f)));
ctb.length ? bad('custom-tab-bar 缺：' + ctb.join(', ')) : ok('自定义 tabBar 四件套齐全');

console.log('\n=== ④ 本地图片引用 ===');
const used = new Set();
files.filter((f) => /\.(wxml|js|wxss|json)$/.test(f)).forEach((f) => {
  const s = fs.readFileSync(f, 'utf8');
  (s.match(/\/images\/[\w.-]+\.(svg|png|jpg|jpeg|gif)/g) || []).forEach((m) => used.add(m));
});
const imgMissing = [...used].filter((m) => !fs.existsSync(path.join(ROOT, m.replace(/^\//, ''))));
imgMissing.length ? bad('引用了不存在的图片：' + imgMissing.join(', ')) : ok('引用到的 ' + used.size + ' 个图片全部存在');
const unused = fs.readdirSync(path.join(ROOT, 'images')).filter((f) => !used.has('/images/' + f));
unused.length ? out.push('  · 未被引用（不算错，可清理）：' + unused.join(', ')) : ok('没有闲置图片');

console.log('\n=== ⑤ JS 语法 / JSON 解析 ===');
let jsBad = [];
files.filter((f) => f.endsWith('.js')).forEach((f) => {
  try { new Function(fs.readFileSync(f, 'utf8')); } catch (e) { jsBad.push(rel(f) + ' → ' + e.message); }
});
jsBad.length ? jsBad.forEach(bad) : ok(files.filter((f) => f.endsWith('.js')).length + ' 个 js 语法正常');
let jsonBad = [];
files.filter((f) => f.endsWith('.json')).forEach((f) => {
  try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { jsonBad.push(rel(f) + ' → ' + e.message); }
});
jsonBad.length ? jsonBad.forEach(bad) : ok(files.filter((f) => f.endsWith('.json')).length + ' 个 json 可解析');

console.log('\n=== ⑥ require 路径可解析 ===');
let reqBad = [];
files.filter((f) => f.endsWith('.js')).forEach((f) => {
  const s = fs.readFileSync(f, 'utf8');
  [...s.matchAll(/require\('([^']+)'\)/g)].forEach((m) => {
    const p = m[1];
    if (!p.startsWith('.')) return;
    const target = path.resolve(path.dirname(f), p);
    if (!fs.existsSync(target) && !fs.existsSync(target + '.js')) reqBad.push(rel(f) + ' → ' + p);
  });
});
reqBad.length ? reqBad.forEach(bad) : ok('所有相对 require 都能解析');

console.log('\n=== ⑦ 页面统计 ===');
const lines = (ext) => files.filter((f) => f.endsWith(ext)).reduce((s, f) => s + fs.readFileSync(f, 'utf8').split('\n').length, 0);
console.log('  页面 ' + pageDirs.length + ' 个 | wxml ' + files.filter((f) => f.endsWith('.wxml')).length +
  ' | wxss ' + files.filter((f) => f.endsWith('.wxss')).length +
  ' | js ' + files.filter((f) => f.endsWith('.js')).length +
  ' | 本地图片 ' + fs.readdirSync(path.join(ROOT, 'images')).length);
console.log('  代码行数：wxml ' + lines('.wxml') + ' | wxss ' + lines('.wxss') + ' | js ' + lines('.js'));

const fails = out.filter((l) => l.includes('✗')).length;
console.log('\n================ 汇总 ================');
console.log(fails ? '前端审计：' + fails + ' 项不合格' : '前端审计：全部通过');
console.log(out.join('\n'));
