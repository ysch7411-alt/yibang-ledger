/**
 * _verify/set-config.js —— 通用：改后端 app_configs 的任意一个键（按点号路径）
 *
 * 为什么做通用的：这个项目里"改了不生效"的坑已经踩过三次
 * （页面标题在 copy.nav、tabBar 在 layout.tabBar、订阅模板在 push.daily），
 * 每来一个就写一个一次性脚本太碎。所以收成一个：
 *
 *   node __cfg.js                                  # 打印顶层有哪些键
 *   node __cfg.js push                             # 打印 push 这一段
 *   node __cfg.js push.daily '{"tmplId":"abc"}'    # 写入（JSON 值）
 *   node __cfg.js push.daily.tmplId abc123         # 写入（字符串值）
 *
 * 约定：
 *  · 值是合法 JSON 就按 JSON 存（对象/数组/数字/布尔），否则当字符串。
 *  · 不传值 = 读。传了 = 写（并自动 version+1，让客户端能拉到）。
 *  · 写前自动备份整份 payload 到 /root/app_configs-backup-<时间>.json。
 *  · 写完回读校验，不一致就报错 —— **不确认一遍不算改成功**。
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const fs = require('fs');
const pool = require('/www/wwwroot/yibang-server/db/config');

function getPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}
function setPath(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * 规范化：递归按键名排序后再序列化。
 *
 * ⚠️ 为什么不能直接比 JSON 字符串：`app_configs.payload` 是 **MySQL 的 JSON 列**，
 * 存进去会被**重排键顺序**（我写 {tmplId,fields,page}，读回来变成 {page,fields,tmplId}）。
 * 直接比字符串会永远报"回读不一致" —— 而值其实是对的。
 * **这类"假失败"比漏报更坏：会让人以为自己没改成功，然后去乱改一通。**
 */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach((k) => { out[k] = canon(v[k]); });
    return out;
  }
  return v;
}

(async () => {
  const rawPath = process.argv[2] || '';
  const rawVal = process.argv[3];
  const parts = rawPath.split('.').filter(Boolean);

  const [rows] = await pool.query("SELECT id, payload, version FROM app_configs WHERE cfg_key = 'global'");
  if (!rows.length) { console.log('✗ 找不到 global 配置'); process.exit(1); }
  const row = rows[0];
  const cfg = row.payload || {};

  if (!parts.length) {
    console.log('version=' + row.version);
    console.log('顶层键:', Object.keys(cfg).join(', '));
    process.exit(0);
  }

  if (rawVal === undefined) {
    console.log('当前值 ' + rawPath + ' =', JSON.stringify(getPath(cfg, parts)));
    process.exit(0);
  }

  let value = rawVal;
  try { value = JSON.parse(rawVal); } catch (e) { /* 不是 JSON 就当字符串 */ }

  const before = JSON.stringify(getPath(cfg, parts));
  const backup = '/root/app_configs-backup-' + Date.now() + '.json';
  fs.writeFileSync(backup, JSON.stringify(cfg));
  console.log('已备份旧配置 → ' + backup);

  setPath(cfg, parts, value);
  const nextVer = Number(row.version) + 1;
  await pool.query('UPDATE app_configs SET payload = ?, version = ? WHERE id = ?', [
    JSON.stringify(cfg), nextVer, row.id
  ]);

  const [after] = await pool.query("SELECT payload, version FROM app_configs WHERE cfg_key = 'global'");
  const nowVal = JSON.stringify(getPath(after[0].payload, parts));
  console.log(rawPath + ': ' + before + ' → ' + nowVal + '   version ' + row.version + ' → ' + after[0].version);
  const same = JSON.stringify(canon(getPath(after[0].payload, parts))) === JSON.stringify(canon(value));
  console.log(same ? '✅ 回读一致' : '❌ 回读不一致，请检查');
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
