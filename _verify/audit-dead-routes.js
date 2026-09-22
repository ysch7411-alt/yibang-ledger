// 死接口扫描（本地跑）
//
// 后端路由和前端代码分别在两边：路由在本机有副本、小程序也本机。
// 所以这个检查放在本地最顺 —— 服务器上跑的 audit-extras.js 看不到本机代码，会跳过这一步。
//
// 判定很保守：只看"路由的最后一段静态路径"在不在前端代码里出现。
// 会漏报（比如接口名恰好是某个变量名的一部分），但不会误报 —— 对"有没有人用"这个判断够用，
// 真正要删之前还是会人工再核一遍。
//
// 用法: node audit-dead-routes.js [小程序目录] [服务端目录]
const fs = require('fs');
const path = require('path');

const MINI = process.argv[2] || path.join(__dirname, '..', 'yibang-miniprogram');
const SERVER = process.argv[3] || path.join(__dirname, '..', 'yibang-server');

function walkFiles(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  });
  return out;
}

const routesDir = path.join(SERVER, 'routes');
if (!fs.existsSync(routesDir)) {
  console.error('找不到 ' + routesDir + '（第一个参数给小程序目录、第二个给服务端目录）');
  process.exit(1);
}

const routes = [];
fs.readdirSync(routesDir).forEach((f) => {
  if (!f.endsWith('.js')) return;
  const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
  (src.match(/router\.(get|post)\('([^']+)'/g) || []).forEach((m) => {
    const g = m.match(/router\.(get|post)\('([^']+)'/);
    routes.push({ file: f, method: g[1].toUpperCase(), path: '/' + f.replace('.js', '') + g[2] });
  });
});

// 前端代码（含页面 js 与 wxml）拼成一个大字符串
let feCode = '';
walkFiles(MINI, ['.js', '.wxml']).forEach((f) => { feCode += fs.readFileSync(f, 'utf8'); });

const dead = routes.filter((r) => {
  const tail = r.path.replace(/^\/[^/]+/, '');
  if (!tail || tail === '/') return false;
  const key = tail.split('/').filter((x) => x && x[0] !== ':')[0];
  return key ? feCode.indexOf('/' + key) < 0 : false;
});

console.log('后端路由 ' + routes.length + ' 个；前端代码里搜不到调用的 ' + dead.length + ' 个：');
dead.forEach((d) => console.log('  ' + d.method.padEnd(5) + d.path + '   （' + d.file + '）'));
if (!dead.length) console.log('  （没有死接口）');
console.log('\n提示：删之前人工再确认一次（脚本只看静态路径段，可能漏报）。');
