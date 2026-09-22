// 审计补充：依赖 / 孤立文件 / 死接口 / 索引 / 重启原因
// 这些是"脚本能查、但原来没查"的地方 —— 也是优化空间最集中的地方。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();
const pool = require('./db/config');

const sh = (c) => { try { return execSync(c, { encoding: 'utf8', timeout: 30000 }).trim(); } catch (e) { return '(失败) ' + (e.message || '').split('\n')[0]; } };
const line = (t) => console.log('\n=== ' + t + ' ===');

(async () => {
  line('① 依赖与安全');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  console.log('  依赖：' + Object.keys(pkg.dependencies || {}).join('、'));
  console.log('  脚本：' + JSON.stringify(pkg.scripts || {}));
  console.log('  npm audit（只看汇总）：');
  console.log('    ' + sh('npm audit --omit=dev 2>&1 | tail -4').split('\n').join('\n    '));
  console.log('  node_modules 体积：' + sh('du -sh node_modules 2>/dev/null | cut -f1'));

  line('② 上传文件：数据库记录 vs 磁盘');
  const [files] = await pool.query('SELECT id, file_url, file_type, file_size, created_at FROM files ORDER BY id');
  const dir = process.env.UPLOAD_DIR || './uploads';
  let onDisk = [];
  try { onDisk = fs.readdirSync(dir); } catch (e) { onDisk = []; }
  console.log('  数据库记录 ' + files.length + ' 条，磁盘上 ' + onDisk.length + ' 个文件');
  const diskSize = sh('du -sh ' + dir + ' 2>/dev/null | cut -f1');
  console.log('  磁盘占用 ' + diskSize);
  const usedInDb = new Set();
  files.forEach((f) => { const n = String(f.file_url || '').split('/').pop(); if (n) usedInDb.add(n); });
  const orphanDisk = onDisk.filter((n) => !usedInDb.has(n));
  console.log('  磁盘上有、库里没记的（孤立文件）：' + orphanDisk.length + ' 个' + (orphanDisk.length ? ' → ' + orphanDisk.slice(0, 5).join(', ') : ''));
  const missingOnDisk = [...usedInDb].filter((n) => onDisk.indexOf(n) < 0);
  console.log('  库里有记录、磁盘上没文件的：' + missingOnDisk.length + ' 个' + (missingOnDisk.length ? ' → ' + missingOnDisk.slice(0, 5).join(', ') : ''));

  line('③ 数据库索引（有没有该加没加的）');
  const [idx] = await pool.query(
    'SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols ' +
    "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME"
  );
  const byTable = {};
  idx.forEach((x) => { (byTable[x.TABLE_NAME] = byTable[x.TABLE_NAME] || []).push(x.INDEX_NAME + '(' + x.cols + ')'); });
  Object.keys(byTable).forEach((t) => console.log('  ' + t + '：' + byTable[t].join('  ')));

  line('④ 表体积 / 行数（看有没有该清理的）');
  // ⚠️ 这里原来用 information_schema.TABLES 的 TABLE_ROWS —— 那是 InnoDB 的**估算值**，
  // 实测它显示 transactions 1 行、实际 12 行。**审计输出骗人比不输出更糟**，
  // 所以行数一律 COUNT(*) 实测；体积仍然用估值（那个只是量级参考，够用）。
  const [sz] = await pool.query(
    'SELECT TABLE_NAME, ROUND((DATA_LENGTH+INDEX_LENGTH)/1024, 1) AS kb ' +
    'FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC'
  );
  const counts = {};
  for (const t of sz) {
    try {
      const [r] = await pool.query('SELECT COUNT(*) c FROM `' + t.TABLE_NAME + '`');
      counts[t.TABLE_NAME] = Number(r[0].c);
    } catch (e) {
      counts[t.TABLE_NAME] = '?';
    }
  }
  sz.forEach((x) => console.log('  ' + String(x.TABLE_NAME).padEnd(20) + String(counts[x.TABLE_NAME]).padStart(7) + ' 行   ' + x.kb + ' KB'));
  const empty = sz.filter((x) => counts[x.TABLE_NAME] === 0).map((x) => x.TABLE_NAME);
  if (empty.length) console.log('  · 空表（可能还没用到）：' + empty.join('、'));

  line('⑤ 进程重启原因');
  console.log('  pm2 重启次数与运行时长：');
  console.log('    ' + sh('pm2 jlist 2>/dev/null | node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>{try{JSON.parse(s).forEach(p=>console.log(p.name+\'  重启\'+p.pm2_env.restart_time+\'次  运行\'+Math.round((Date.now()-p.pm2_env.pm_uptime)/1000)+\'秒  状态\'+p.pm2_env.status))}catch(e){console.log(\'(读不到)\')}})"').split('\n').join('\n    '));
  console.log('  最近一次重启时间：' + sh('pm2 describe yibang-server 2>/dev/null | grep -i "created at\\|uptime" | head -2').split('\n').join(' | '));

  line('⑥ 死接口扫描（后端有路由、前端从没调用）');
  // 这个脚本是 scp 到服务器上跑的，而小程序前端在本机 —— 路径不存在时要**说清楚跳过**，
  // 不能静默出错（原来就是直接 ENOENT 崩在最后一步，前面的结果全白打印了）。
  const feDirs = ['F:/2026-09-19/new-chat-1/yibang-miniprogram'];
  const feRoot = feDirs.find((d) => fs.existsSync(d));
  if (!feRoot) {
    console.log('  · 跳过：本机前端目录不在这里（这个脚本在服务器上跑，看不到本机代码）');
    console.log('    → 在本地跑 `node -e` 版或用 _verify 里的本地扫描片段。');
  } else {
    const routes = [];
    fs.readdirSync('routes').forEach((f) => {
      if (!f.endsWith('.js')) return;
      const src = fs.readFileSync(path.join('routes', f), 'utf8');
      (src.match(/router\.(get|post)\('([^']+)'/g) || []).forEach((m) => {
        const g = m.match(/router\.(get|post)\('([^']+)'/);
        routes.push('/' + f.replace('.js', '') + g[2]);
      });
    });
    let feCode = '';
    const walk = (d) => { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { if (e.name === 'node_modules' || e.name.startsWith('.')) return; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|wxml)$/.test(e.name)) feCode += fs.readFileSync(p, 'utf8'); }); };
    walk(feRoot);
    const dead = routes.filter((r) => {
      const tail = r.replace(/^\/[^/]+/, '');
      if (!tail || tail === '/') return false;
      const key = tail.split('/').filter((x) => x && x[0] !== ':')[0];
      return key ? feCode.indexOf('/' + key) < 0 : false;
    });
    console.log('  后端路由 ' + routes.length + ' 个，前端代码里找不到调用的 ' + dead.length + ' 个：');
    dead.forEach((d) => console.log('    ' + d));
  }

  process.exit(0);
})().catch((e) => { console.error('出错：', e.message); process.exit(1); });
