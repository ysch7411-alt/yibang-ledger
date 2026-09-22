#!/usr/bin/env node
/**
 * 备份异地：把最新一份数据库备份传到 OSS（2026-09-23 审查 🅲8）
 *
 * 为什么需要它：`/opt/ops/backup.sh` 每天 02:00 做一份备份 ✓，
 * **但备份和数据库躺在同一台机器上** ✗ —— 机器坏了、磁盘挂了、
 * 或者误删了 `/opt/ops/backups/`，备份跟着一起没 ✓ 等于没备份。
 * 异地那份才是"最后一道"。
 *
 * 复用 `yibang-server/lib/oss.js`（同一套 OSS 凭证，不新配一套 ✗）。
 *
 * ⚠️ **不做远端删除**：一份备份只有几 KB（现在整个库 6.9KB），
 *    一天几 KB、一年 2~3MB，留着远比"删错了/删漏了"便宜。
 *    等它涨到需要管理时再说 —— 现在的取舍是**宁多留不误删**。
 *
 * 跑法（cron 在 backup.sh 之后）：
 *   node /opt/ops/backup-offsite.js
 * 退出码：0 = 传完并复验通过；1 = 复验失败；2 = 本地没备份文件
 */
const fs = require('fs');
const path = require('path');

const APP = '/www/wwwroot/yibang-server';
const DIR = '/opt/ops/backups';

require(path.join(APP, 'node_modules/dotenv')).config({ path: path.join(APP, '.env') });
const oss = require(path.join(APP, 'lib/oss.js'));

(async () => {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => /\.sql\.gz$/.test(f)).sort();
  } catch (e) {
    console.error('[异地备份] 读备份目录失败:', e.message);
    process.exit(2);
  }
  if (!files.length) {
    console.error('[异地备份] 本地没有备份文件 —— 先把 backup.sh 跑起来');
    process.exit(2);
  }

  // 文件名带时间戳 → 字典序就是时间序，不用 stat
  const newest = files[files.length - 1];
  const localPath = path.join(DIR, newest);
  const buf = fs.readFileSync(localPath);
  console.log('[异地备份] 本地最新: ' + newest + '  ' + buf.length + ' 字节');

  const key = 'backups/' + newest;
  await oss.putBuffer(key, buf, 'application/gzip');
  console.log('[异地备份] 已上传 OSS: ' + key);

  /* 🔴 **复验**：传完必须下回来比一次字节数。
     "上传没报错"不等于"东西在上面" ✗ —— 路径写错、权限不对、
     传了个 0 字节，都可能不报错。不确认就不算完成。 */
  const back = await oss.getBuffer(key);
  const size = back ? back.length : -1;
  if (size === buf.length) {
    console.log('  ✅ 复验通过：远端读回 ' + size + ' 字节，与本地一致');
    process.exit(0);
  }
  console.error('  ❌ 复验失败：本地 ' + buf.length + ' 字节，远端 ' + size + ' 字节');
  process.exit(1);
})().catch((e) => {
  console.error('[异地备份] 异常:', e && e.message);
  process.exit(1);
});
