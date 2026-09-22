// 服务端审计：数据库结构 / 进程 / 磁盘 / 日志 / nginx / AI 配置
const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const sh = (c) => { try { return execSync(c, { encoding: 'utf8', timeout: 20000 }).trim(); } catch (e) { return '(失败) ' + String(e.message).split('\n')[0]; } };

const EXPECT_TABLES = ['users', 'contacts', 'transactions', 'files', 'shares', 'promotions', 'merchant_terms', 'ai_corrections', 'purchase_orders', 'purchase_items'];
const EXPECT_COLS = {
  users: ['id', 'openid', 'phone', 'phone_bound_at', 'nickname', 'shop_name', 'role', 'plan_type'],
  transactions: ['id', 'user_id', 'contact_id', 'type', 'amount', 'content', 'record_date', 'status'],
  purchase_orders: ['id', 'user_id', 'supplier_name', 'order_no', 'order_date', 'total_amount', 'item_count', 'source_file_id'],
  purchase_items: ['id', 'order_id', 'seq', 'item_name', 'spec', 'unit', 'qty', 'unit_price', 'amount'],
  merchant_terms: ['id', 'user_id', 'kind', 'alias', 'canonical', 'hits', 'source'],
  contacts: ['id', 'user_id', 'name', 'type', 'balance']
};

(async () => {
  console.log('=== ① 数据库表结构 ===');
  const [tabs] = await pool.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  const have = tabs.map((t) => t.TABLE_NAME);
  const miss = EXPECT_TABLES.filter((t) => !have.includes(t));
  miss.length ? console.log('  ✗ 缺表：' + miss.join(', ')) : console.log('  ✓ ' + EXPECT_TABLES.length + ' 张业务表齐全');

  for (const t of Object.keys(EXPECT_COLS)) {
    const [cols] = await pool.query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]);
    const names = cols.map((c) => c.COLUMN_NAME);
    const lost = EXPECT_COLS[t].filter((c) => !names.includes(c));
    console.log('  ' + (lost.length ? '✗' : '✓') + ' ' + t.padEnd(18) + names.length + ' 列' + (lost.length ? '   缺：' + lost.join(', ') : ''));
  }

  console.log('\n=== ② 数据现状（确认没有测试残留）===');
  for (const t of EXPECT_TABLES) {
    const [r] = await pool.query('SELECT COUNT(*) c FROM ' + t);
    console.log('  ' + t.padEnd(18) + r[0].c + ' 行');
  }
  const [orphan] = await pool.query('SELECT COUNT(*) c FROM shares WHERE type IS NULL');
  console.log('  ' + (orphan[0].c ? '✗ 有 type 为空的脏分享记录 ' + orphan[0].c + ' 条' : '✓ 没有脏分享记录'));

  console.log('\n=== ③ 进程与资源 ===');
  console.log(sh("pm2 jlist | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s).forEach(p=>console.log('  '+(p.name+'            ').slice(0,18)+p.pm2_env.status+'  重启 '+p.pm2_env.restart_time+' 次  内存 '+Math.round(p.monit.memory/1048576)+'MB  CPU '+p.monit.cpu+'%'))})\""));
  console.log('  磁盘 ' + sh("df -h / | tail -1 | awk '{print $3\" / \"$2\" 已用 \"$5}'"));
  console.log('  负载 ' + sh('cat /proc/loadavg | cut -d" " -f1-3'));
  console.log('  内存 ' + sh("free -m | awk 'NR==2{print $3\"MB / \"$2\"MB\"}'"));
  console.log('  Node ' + sh('node -v'));

  console.log('\n=== ④ 日志健康 ===');
  console.log('  近 24h 后端错误日志行数：' + sh("find /root/.pm2/logs/yibang-server-error.log -mmin -1440 -exec wc -l {} \\; 2>/dev/null | awk '{print $1}'"));
  console.log('  错误日志最后 3 条（去堆栈）：');
  console.log(sh("grep -vE '^\\s+at ' /root/.pm2/logs/yibang-server-error.log | tail -3 | sed 's/^/    /'") || '    （空）');
  console.log('  logrotate 是否已配 su 指令：' + (/^\s*su /m.test(sh('cat /etc/logrotate.d/rsyslog 2>/dev/null') ) ? '✓ 已配' : '✗ 未配'));

  console.log('\n=== ⑤ nginx ===');
  console.log('  api.dtzai.cn 代理：' + sh("grep -rh 'proxy_pass' /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | grep 3000 | head -1 | sed 's/^ *//'"));
  console.log('  client_max_body_size：' + sh("grep -rh 'client_max_body_size' /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | head -1 | sed 's/^ *//'"));
  console.log('  h5.dtzai.cn 根目录：' + sh("grep -rh -A3 'server_name h5.dtzai.cn' /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | grep root | head -1 | sed 's/^ *//'"));
  console.log('  h5 首页文件是否存在：' + sh('test -f /opt/saas/web/h5/index.html && echo 存在 || echo "✗ 不存在（访问会 404）"'));

  console.log('\n=== ⑥ AI 配置（代码里实际用的模型）===');
  const files = ['/www/wwwroot/yibang-server/routes/ai.js', '/www/wwwroot/yibang-server/routes/record.js', '/www/wwwroot/yibang-server/routes/purchase.js'];
  files.forEach((f) => {
    const s = fs.readFileSync(f, 'utf8');
    const models = [...new Set([...s.matchAll(/model:\s*(?:'([^']+)'|([A-Z_]+))/g)].map((m) => m[1] || m[2]))];
    const consts = [...s.matchAll(/const\s+([A-Z_]+)\s*=\s*'([^']+)'/g)].map((m) => m[1] + '=' + m[2]);
    console.log('  ' + f.split('/').pop().padEnd(13) + '直接写死: ' + (models.join(', ') || '无'));
    if (consts.length) console.log('  ' + ' '.repeat(13) + '常量: ' + consts.join('  '));
  });

  console.log('\n=== ⑦ 环境变量（只打键名，不打值）===');
  const env = fs.readFileSync('/www/wwwroot/yibang-server/.env', 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  env.forEach((l) => {
    const k = l.split('=')[0];
    console.log('  ' + k + (/(KEY|SECRET|TOKEN|PASS)/.test(k) ? ' = ***（长度 ' + (l.split('=')[1] || '').length + '）' : ' = ' + (l.split('=').slice(1).join('=') || '').slice(0, 60)));
  });

  process.exit(0);
})();
