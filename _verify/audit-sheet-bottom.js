/**
 * _verify/audit-sheet-bottom.js —— 检查"用了底部弹层但没补 bottom:0"的二级页
 *
 * 背景（项目里已知的坑）：公共 .sheet 的定位是
 *     bottom: max(calc(var(--tabbar-h) + env(safe-area-inset-bottom)), var(--kb-lift))
 * 也就是**默认停在 tabBar 之上**。但 tabBar 页只有三个（记账/报表/我的），
 * 其余都是 navigateTo 打开的二级页 —— 二级页**没有 tabBar**，那一截空间没人占，
 * 弹层底下就会漏出一条约 120rpx 的缝（露出版面背景色）。
 *
 * 公共层的注释里写了"非 TabBar 页若要用，覆盖成 bottom: 0 即可"，
 * 但靠人记着写是不可靠的 —— 2026-09-22 就发现成员管理一直漏着这条缝。
 * 所以做成检查：凡是非 tabBar 页、wxml 里用了 .sheet、wxss 里又没覆盖 bottom:0，
 * 一律报出来。
 *
 * 用法： node _verify/audit-sheet-bottom.js <小程序目录>
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'yibang-miniprogram';
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const tabs = new Set(((appJson.tabBar || {}).list || []).map((x) => x.pagePath));

const pagesDir = path.join(ROOT, 'pages');
let need = 0, checked = 0;

for (const p of fs.readdirSync(pagesDir)) {
  const wxml = path.join(pagesDir, p, p + '.wxml');
  const wxss = path.join(pagesDir, p, p + '.wxss');
  if (!fs.existsSync(wxml)) continue;

  // 用了 .sheet（含 class="sheet xxx" 这种复合写法）
  const w = fs.readFileSync(wxml, 'utf8');
  if (!/class="sheet[\s"]/.test(w)) continue;

  checked++;
  const isTab = tabs.has('pages/' + p + '/' + p);
  const css = fs.existsSync(wxss) ? fs.readFileSync(wxss, 'utf8') : '';
  /* 两种正确的覆盖写法都要认：
       bottom: 0;                      —— 弹层里没有输入框（不需要键盘抬升）
       bottom: var(--kb-lift, 0px);    —— 弹层里有输入框，收起时等价贴底、弹起时抬升 ← 更好
     ⚠️ 第一版只认 `bottom: 0`，于是我刚用 var(--kb-lift) 修完的 6 个页面
        在审计里仍然全报"未覆盖" —— 假阳性比漏报更浪费人：会让人把正确的改坏。 */
  let covered = false;
  const re = /\.sheet\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    if (/bottom:\s*0\s*;/.test(body) || /bottom:\s*var\(\s*--kb-lift/.test(body)) covered = true;
  }

  const bad = !isTab && !covered;
  if (bad) need++;
  console.log(
    (bad ? '❌ 要修' : '✅     ') + '  ' + p.padEnd(16) +
    ' tab页:' + (isTab ? '是' : '否') + '  覆盖bottom:0:' + (covered ? '是' : '否')
  );
}

console.log('\n用了弹层的页面 ' + checked + ' 个；其中非 tab 页漏补 bottom:0 的 ' + need + ' 个');
process.exit(need ? 1 : 0);
