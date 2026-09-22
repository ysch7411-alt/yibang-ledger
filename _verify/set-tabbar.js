/**
 * _verify/set-tabbar.js —— 改后端配置里的 tabBar 列表与快捷问题
 *
 * 背景（和标题那次一模一样的坑）：**tabBar 列表不是 app.json 说了算**，
 * 而是 `utils/config.js` 的 `tabBarList()` 从后端 `layout.tabBar` 组装的，
 * 并且还会用前端白名单 `TAB_ICONS` **过滤掉**没登记图标的页面。
 * 所以加一个 tab 要同时改三处：
 *   ① app.json 的 tabBar.list（框架层注册）
 *   ② utils/config.js 的 TAB_ICONS（图标白名单，不过它就被丢掉）
 *   ③ 后端 layout.tabBar（真正的顺序与文案来源）← 本脚本负责这处
 * 少改任何一处，表现都是"tab 没出来"，而且**不报错**。
 *
 * 幂等：已存在就更新文案与位置，不会重复插入。
 * 用法（服务器上跑）：
 *   node __set-tab.js                 # 只打印现状
 *   node __set-tab.js --go            # 实际写入 + version 递增
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const pool = require('/www/wwwroot/yibang-server/db/config');

const ADVISOR = { text: 'AI 参谋', visible: true, pagePath: '/pages/advisor/advisor' };
// 三个问题分别对着 报账 / 查账 / 比账 各一件（记账不是问句，由空状态的清单承载）
const QUICK = ['今天有什么要注意的？', '谁欠我最多？', '我的支出占比算高吗？'];

(async () => {
  const GO = process.argv.includes('--go');
  const [rows] = await pool.query("SELECT id, payload, version FROM app_configs WHERE cfg_key = 'global'");
  if (!rows.length) { console.log('✗ 找不到 global 配置'); process.exit(1); }
  const row = rows[0];
  const cfg = row.payload || {};

  console.log('现状 version=' + row.version);
  console.log('  tabBar =', JSON.stringify((cfg.layout || {}).tabBar));
  console.log('  快捷问题 =', JSON.stringify((cfg.layout || {}).quickQuestions));

  if (!GO) { console.log('\n（只读模式，加 --go 才写）'); process.exit(0); }

  cfg.layout = cfg.layout || {};
  const list = Array.isArray(cfg.layout.tabBar) ? cfg.layout.tabBar.slice() : [];

  // 幂等：先删掉可能已存在的同 path 项，再按位置插入
  const cleaned = list.filter((x) => x && x.pagePath !== ADVISOR.pagePath);
  const idxOfMine = cleaned.findIndex((x) => x.pagePath === '/pages/profile/profile');
  if (idxOfMine >= 0) cleaned.splice(idxOfMine, 0, ADVISOR);   // 插在「我的」前面
  else cleaned.push(ADVISOR);                                   // 兜底：放最后
  cfg.layout.tabBar = cleaned;
  cfg.layout.quickQuestions = QUICK;

  const nextVer = Number(row.version) + 1;
  await pool.query('UPDATE app_configs SET payload = ?, version = ? WHERE id = ?', [
    JSON.stringify(cfg), nextVer, row.id
  ]);

  const [after] = await pool.query("SELECT payload, version FROM app_configs WHERE cfg_key = 'global'");
  const l = after[0].payload.layout || {};
  console.log('\n已写入 version ' + row.version + ' → ' + after[0].version);
  console.log('  tabBar =', JSON.stringify(l.tabBar));
  console.log('  快捷问题 =', JSON.stringify(l.quickQuestions));
  const ok = (l.tabBar || []).filter((x) => x.pagePath === ADVISOR.pagePath).length === 1
    && (l.tabBar || []).length === cleaned.length;
  console.log(ok ? '✅ 回读一致（参谋 tab 恰好一条）' : '❌ 回读不一致，请检查');
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
