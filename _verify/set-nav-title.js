/**
 * _verify/set-nav-title.js —— 改后端配置里的页面标题（copy.nav.<页>）
 *
 * 背景：页面标题**不一定**来自 pages/xxx/xxx.json ——
 * utils/page-config.js 会用后端 app_configs 里的 copy.nav[key] 覆盖导航栏标题。
 * 2026-09-22 改「经营小参谋 → AI 参谋」时就栽在这：
 * 改了 advisor.json 却毫无变化，因为线上配置里 copy.nav.advisor = "经营小参谋"。
 * **判据：改任何页面标题，既要改 json，也要看这个配置里有没有对应键。**
 *
 * 用法（在服务器上跑，因为要连库）：
 *   node __set-nav.js                 # 只打印现状
 *   node __set-nav.js advisor "AI 参谋"  # 改 + version 递增
 *
 * 只改指定键，其余原样保留；改完 version+1，前端下次 onShow 就会拉到新标题。
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const pool = require('/www/wwwroot/yibang-server/db/config');

(async () => {
  const [rows] = await pool.query("SELECT id, payload, version FROM app_configs WHERE cfg_key = 'global'");
  if (!rows.length) { console.log('✗ 找不到 global 配置'); process.exit(1); }
  const row = rows[0];
  const cfg = row.payload || {};

  console.log('现状  version=' + row.version);
  console.log('  copy.nav =', JSON.stringify((cfg.copy || {}).nav));

  const key = process.argv[2];
  const val = process.argv[3];
  if (!key || val === undefined) { console.log('\n（只读模式。给 <键> <新值> 才写）'); process.exit(0); }

  cfg.copy = cfg.copy || {};
  cfg.copy.nav = cfg.copy.nav || {};
  const old = cfg.copy.nav[key];
  if (old === val) { console.log('\n已经是「' + val + '」，不用改'); process.exit(0); }

  cfg.copy.nav[key] = val;
  const nextVer = Number(row.version) + 1;

  await pool.query('UPDATE app_configs SET payload = ?, version = ? WHERE id = ?', [
    JSON.stringify(cfg), nextVer, row.id
  ]);

  // 回读校验：不确认一遍不算改成功
  const [after] = await pool.query("SELECT payload, version FROM app_configs WHERE cfg_key = 'global'");
  const nav = (after[0].payload.copy || {}).nav;
  console.log('\n已改  ' + key + ': 「' + old + '」→「' + nav[key] + '」  version ' + row.version + ' → ' + after[0].version);
  console.log('  copy.nav =', JSON.stringify(nav));
  console.log(nav[key] === val ? '✅ 回读一致' : '❌ 回读不一致，请检查');
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
