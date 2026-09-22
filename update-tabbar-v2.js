const mysql = require('mysql2/promise');

async function main() {
  console.log('开始连接数据库...');
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'yibang',
    password: 'Yibang@2026DB',
    database: 'yibang'
  });
  console.log('数据库连接成功');

  // 读取当前配置
  const [rows] = await conn.query("SELECT payload, version FROM app_configs WHERE cfg_key = 'global'");
  console.log('读取到配置，version:', rows[0].version);
  
  let cfg;
  if (typeof rows[0].payload === 'string') {
    cfg = JSON.parse(rows[0].payload);
  } else if (Buffer.isBuffer(rows[0].payload)) {
    cfg = JSON.parse(rows[0].payload.toString('utf8'));
  } else {
    cfg = rows[0].payload;
  }
  
  console.log('更新前 tabBar 数量:', cfg.layout.tabBar.length);
  console.log('更新前 tabBar:', JSON.stringify(cfg.layout.tabBar));

  // 更新tabBar为4个
  cfg.layout.tabBar = [
    { text: '记账', visible: true, pagePath: '/pages/record/record' },
    { text: '报表', visible: true, pagePath: '/pages/summary/summary' },
    { text: '往来', visible: true, pagePath: '/pages/contacts/contacts' },
    { text: '我的', visible: true, pagePath: '/pages/profile/profile' }
  ];
  
  // 更新导航栏标题
  if (!cfg.copy.nav) cfg.copy.nav = {};
  cfg.copy.nav.contacts = '往来';
  
  console.log('更新后 tabBar 数量:', cfg.layout.tabBar.length);
  console.log('更新后 tabBar:', JSON.stringify(cfg.layout.tabBar));

  // 更新数据库
  const newPayload = JSON.stringify(cfg);
  console.log('准备更新数据库，payload长度:', newPayload.length);
  
  const [result] = await conn.query(
    "UPDATE app_configs SET payload = ?, version = version + 1 WHERE cfg_key = 'global'",
    [newPayload]
  );
  console.log('更新结果，影响行数:', result.affectedRows);

  // 验证
  const [rows2] = await conn.query("SELECT payload, version FROM app_configs WHERE cfg_key = 'global'");
  let cfg2;
  if (typeof rows2[0].payload === 'string') {
    cfg2 = JSON.parse(rows2[0].payload);
  } else if (Buffer.isBuffer(rows2[0].payload)) {
    cfg2 = JSON.parse(rows2[0].payload.toString('utf8'));
  } else {
    cfg2 = rows2[0].payload;
  }
  
  console.log('验证 - version:', rows2[0].version);
  console.log('验证 - tabBar 数量:', cfg2.layout.tabBar.length);
  console.log('验证 - tabBar:', JSON.stringify(cfg2.layout.tabBar));
  console.log('验证 - nav.contacts:', cfg2.copy.nav.contacts);

  await conn.end();
  console.log('✅ 全部完成！');
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
