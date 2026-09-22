// 更新tabBar配置为4个：记账、报表、往来、我的
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'yibang',
    password: 'Yibang@2026DB',
    database: 'yibang'
  });

  // 先读取当前配置
  const [rows] = await conn.query("SELECT payload, version FROM app_configs WHERE cfg_key = 'global'");
  const config = JSON.parse(rows[0].payload);
  
  console.log('更新前 tabBar:', JSON.stringify(config.layout.tabBar));
  
  // 更新tabBar为4个
  config.layout.tabBar = [
    { text: '记账', visible: true, pagePath: '/pages/record/record' },
    { text: '报表', visible: true, pagePath: '/pages/summary/summary' },
    { text: '往来', visible: true, pagePath: '/pages/contacts/contacts' },
    { text: '我的', visible: true, pagePath: '/pages/profile/profile' }
  ];
  
  // 同时更新导航栏标题，加上往来
  if (!config.copy.nav) config.copy.nav = {};
  config.copy.nav.contacts = '往来';
  
  // 更新数据库
  await conn.query(
    "UPDATE app_configs SET payload = ?, version = version + 1 WHERE cfg_key = 'global'",
    [JSON.stringify(config)]
  );
  
  // 验证
  const [rows2] = await conn.query("SELECT payload, version FROM app_configs WHERE cfg_key = 'global'");
  const config2 = JSON.parse(rows2[0].payload);
  console.log('更新后 tabBar:', JSON.stringify(config2.layout.tabBar));
  console.log('version:', rows2[0].version);
  
  await conn.end();
  console.log('✅ 更新完成！');
}

main().catch(err => {
  console.error('❌ 更新失败:', err);
  process.exit(1);
});
