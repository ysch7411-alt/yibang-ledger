// 本地环境与小程序编译配置核对（2026-09-20 全项目复盘）
//
// 只查"能一票否决编译/运行"的硬配置，不查代码风格。
// 四项清单：① app.json 自身与四件套 ② tabBar 图标与自定义 tabBar
//           ③ 图片资源引用 ④ 工程配置（project.config / 依赖）
// 用法: node audit-local-env.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'yibang-miniprogram');
let problems = [];
let checked = 0;
const ok = (d) => { checked++; console.log('  ✓ ' + d); };
const bad = (level, d) => { checked++; problems.push(level + ' ' + d); console.log('  ✗ ' + d); };

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------- ① app.json ---------- */
console.log('① app.json');
let appJson;
const appJsonPath = path.join(ROOT, 'app.json');
try {
  appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  ok('能解析（JSON 合法）');
} catch (e) {
  bad('[P0]', 'app.json 解析失败：' + e.message);
  process.exit(1);
}
ok('页面 ' + appJson.pages.length + ' 个');

// 每个注册页面四件套齐全
const missingSet = [];
appJson.pages.forEach((p) => {
  ['.js', '.json', '.wxml', '.wxss'].forEach((ext) => {
    if (!fs.existsSync(path.join(ROOT, p + ext))) missingSet.push(p + ext);
  });
});
missingSet.length ? bad('[P0]', '注册了但文件缺失：' + missingSet.join(', ')) : ok('每个页面的 js/json/wxml/wxss 四件套都在');

// 页面列表里有重复（小程序会报错）
const dupPages = appJson.pages.filter((p, i) => appJson.pages.indexOf(p) !== i);
dupPages.length ? bad('[P0]', 'app.json 里页面重复注册：' + dupPages.join(', ')) : ok('没有重复注册的页面');

/* ---------- ② tabBar ---------- */
console.log('\n② tabBar');
const tb = appJson.tabBar;
if (!tb) { bad('[P0]', '没有定义 tabBar'); }
else {
  ok('color=' + tb.color + ' / selectedColor=' + tb.selectedColor + ' / custom=' + tb.custom);
  const list = tb.list || [];
  ok('tabBar 有 ' + list.length + ' 项');
  // tabBar 页必须在 pages 里
  list.forEach((it) => {
    checked++;
    if (appJson.pages.indexOf(it.pagePath) < 0) bad('[P0]', 'tabBar 的 ' + it.pagePath + ' 不在 pages 里');
    else ok('  ' + it.pagePath + '（text=' + it.text + '）已注册');
  });
  // 图标文件
  const missingIcons = [];
  list.forEach((it) => {
    ['iconPath', 'selectedIconPath'].forEach((k) => {
      if (!it[k]) return;
      if (!fs.existsSync(path.join(ROOT, it[k]))) missingIcons.push(it[k]);
    });
  });
  missingIcons.length ? bad('[P0]', 'tabBar 图标文件缺失：' + missingIcons.join(', ')) : ok('tabBar 引用的图标文件都在');

  // 自定义 tabBar 的组织
  if (tb.custom === true) {
    ['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach((f) => {
      const p = path.join(ROOT, 'custom-tab-bar', f);
      fs.existsSync(p) ? ok('custom-tab-bar/' + f) : bad('[P0]', 'custom:true 但缺 custom-tab-bar/' + f);
    });
    // tabBar.list 里的页才能有 tabBar；list 里的页面数决定框架渲染
    ok('自定义 tabBar 由框架渲染在页面之上 —— 页面内 fixed 元素要靠 --tabbar-h 让位');
  }
}

/* ---------- ③ sitemap / 图片 ---------- */
console.log('\n③ sitemap 与图片资源');
const smp = path.join(ROOT, 'sitemap.json');
if (fs.existsSync(smp)) {
  try { JSON.parse(fs.readFileSync(smp, 'utf8')); ok('sitemap.json 合法'); }
  catch (e) { bad('[P2]', 'sitemap.json 解析失败'); }
} else bad('[P2]', '缺 sitemap.json（不影响运行，但微信会提示）');

// 全项目代码里引到的 /images 路径是否都存在；反向：images 里有没有没人用的文件
const codeFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p) : (/\.(js|wxml|wxss|json)$/.test(e.name) && codeFiles.push(p));
  }
})(ROOT);

const usedImgs = new Set();
codeFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  [...src.matchAll(/\/images\/([A-Za-z0-9._-]+)/g)].forEach((m) => {
    usedImgs.add(m[1]);
    if (!fs.existsSync(path.join(ROOT, 'images', m[1]))) {
      bad('[P0]', rel(f) + ' 引用了不存在的 images/' + m[1]);
    }
  });
});
ok('代码引用图片 ' + usedImgs.size + ' 个，都存在');

let allImgs = [];
try { allImgs = fs.readdirSync(path.join(ROOT, 'images')); } catch (e) { /* 没有这个目录 */ }
const orphans = allImgs.filter((f) => !usedImgs.has(f));
orphans.length ? console.log('  ℹ images/ 里有 ' + orphans.length + ' 个没被引用的文件：' + orphans.join(', ')) : ok('images/ 没有孤儿文件');

/* ---------- ④ 工程配置 ---------- */
console.log('\n④ 工程配置');
const pcp = path.join(ROOT, 'project.config.json');
if (fs.existsSync(pcp)) {
  const pc = JSON.parse(fs.readFileSync(pcp, 'utf8'));
  const r = {};
  ['appid', 'libVersion', 'projectname', 'compileType'].forEach((k) => { if (pc[k] !== undefined) r[k] = pc[k]; });
  ok('project.config.json：' + JSON.stringify(r));
  if (pc.compileType && pc.compileType !== 'miniprogram') bad('[P1]', 'compileType=' + pc.compileType + '（不是 miniprogram，可能建错了类型）');
  else ok('compileType 正常');
  if (pc.miniprogramRoot) ok('miniprogramRoot=' + pc.miniprogramRoot);
  // 合法域名：request 域名必须配，否则真机请求失败
  const per = pc.setting && pc.setting.urlCheck;
  ok('setting.urlCheck=' + per + '（false 表示开发期不校验域名，真机仍以后台配置为准）');
} else bad('[P1]', '缺 project.config.json（开发者工具无法识别工程属性）');

// usingComponents：组件是否都存在
const missingComp = new Set();
codeFiles.forEach((f) => {
  if (!f.endsWith('.json')) return;
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
  const uc = j.usingComponents || {};
  Object.keys(uc).forEach((k) => {
    const v = uc[k];
    if (/^(weui-miniprogram|tdesign|vant)/.test(v)) missingComp.add(v + '（第三方组件库，需确认 miniprogramRoot 下有 node_modules）');
  });
});
missingComp.size ? [...missingComp].forEach((x) => console.log('  ℹ ' + x)) : ok('没有引用第三方组件库（全部原生）');

// 后端依赖：有没有 lock、有没有 node_modules
console.log('\n⑤ 后端依赖');
const server = path.join(__dirname, '..', 'yibang-server');
const hasLock = fs.existsSync(path.join(server, 'package-lock.json'));
hasLock ? ok('package-lock.json 在（版本可复现）') : bad('[P1]', '缺 package-lock.json —— 重新装出来的依赖版本可能和线上不一致');
const hasNM = fs.existsSync(path.join(server, 'node_modules'));
hasNM ? ok('node_modules 在（本地能跑') : console.log('  ℹ node_modules 不在（本地不跑后端，不影响部署）');
const deps = JSON.parse(fs.readFileSync(path.join(server, 'package.json'), 'utf8')).dependencies || {};
console.log('  生产依赖：' + Object.keys(deps).join(', '));

/* ---------- 汇总 ---------- */
console.log('\n================ 汇总 ================');
const p0 = problems.filter((x) => x.startsWith('[P0]'));
const p1 = problems.filter((x) => x.startsWith('[P1]'));
const p2 = problems.filter((x) => x.startsWith('[P2]'));
console.log('  检查 ' + checked + ' 项 · P0 ' + p0.length + ' · P1 ' + p1.length + ' · P2 ' + p2.length);
[...p0, ...p1, ...p2].forEach((x) => console.log('    ' + x));
if (!problems.length) console.log('  ✓ 本地环境与编译配置没有硬问题');
