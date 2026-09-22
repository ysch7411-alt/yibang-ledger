const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({host:'localhost',user:'yibang',password:'Yibang@2026DB',database:'yibang'});
  const [rows] = await conn.query("SELECT payload, version FROM app_configs WHERE cfg_key='global'");
  console.log('version:', rows[0].version);
  console.log('payload type:', typeof rows[0].payload);
  console.log('payload is Buffer:', Buffer.isBuffer(rows[0].payload));
  
  let cfg;
  if (typeof rows[0].payload === 'string') {
    cfg = JSON.parse(rows[0].payload);
  } else if (Buffer.isBuffer(rows[0].payload)) {
    cfg = JSON.parse(rows[0].payload.toString('utf8'));
  } else {
    cfg = rows[0].payload;
  }
  
  console.log('tabBar count:', cfg.layout.tabBar.length);
  console.log('tabBar:', JSON.stringify(cfg.layout.tabBar));
  console.log('nav.contacts:', cfg.copy.nav.contacts);
  await conn.end();
})();
