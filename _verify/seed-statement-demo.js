/**
 * _verify/seed-statement-demo.js —— 造一份可看的对账单（在服务器上跑），并打印访问 token
 *
 * 用途：截图验证「对账单只读页」的真实渲染。
 * 项目纪律：造数据要**造够**（多笔、跨天、含应付/付款），否则排版分支跑不到。
 *
 * ⚠️ 只写 user_id = 1，标记 `对账演示·`；用完 node __seed-stmt.js --clean 清理。
 */
const path = require('path');
require('dotenv').config({ path: path.join('/www/wwwroot/yibang-server', '.env') });
const jwt = require('jsonwebtoken');
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const UID = 1;
const MARK = '对账演示·';

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return await res.json();
}

(async () => {
  if (process.argv.includes('--clean')) {
    const [c] = await pool.query('SELECT id FROM contacts WHERE user_id = ? AND name LIKE ?', [UID, MARK + '%']);
    const ids = c.map((x) => x.id);
    let tx = 0, sh = 0;
    if (ids.length) {
      const [a] = await pool.query('DELETE FROM transactions WHERE user_id = ? AND contact_id IN (?)', [UID, ids]);
      const [b] = await pool.query('DELETE FROM shares WHERE user_id = ? AND contact_id IN (?)', [UID, ids]);
      tx = a.affectedRows; sh = b.affectedRows;
    }
    const [d] = await pool.query('DELETE FROM contacts WHERE user_id = ? AND name LIKE ?', [UID, MARK + '%']);
    console.log('清理：账目 ' + tx + ' / 分享 ' + sh + ' / 客户 ' + d.affectedRows);
    process.exit(0);
  }

  const token = jwt.sign({ userId: UID, id: UID }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const p2 = (n) => String(n).padStart(2, '0');
  const dayStr = (back) => {
    const d = new Date(Date.now() - back * 86400000);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  };

  const cRes = await api('POST', '/contact/create', { name: MARK + '宏发建材', type: 1, phone: '13800001234' }, token);
  const cid = cRes.data && (cRes.data.id || cRes.data.contact_id);
  console.log('客户 id =', cid);

  // 跨天、四种类型都有，让对方看到时能验到每种标签
  const tx = [
    [3, 12800, '8月货款', dayStr(21)],
    [5, 6000, '银行转账', dayStr(17)],
    [3, 4300, '9月上旬补货', dayStr(9)],
    [6, 1500, '退回破损件', dayStr(6)],
    [5, 5000, '微信回款', dayStr(2)],
    [3, 2600, '9月新增', dayStr(1)]
  ];
  for (const [t, a, c, day] of tx) {
    const r = await api('POST', '/record/create', { type: t, amount: a, content: MARK + c, contact_id: cid, record_date: day }, token);
    if (r.code !== 0) console.log('  建账失败:', c, r);
  }

  const sRes = await api('POST', '/share/create', { type: 2, contact_id: cid, expire_days: 7 }, token);
  if (sRes.code !== 0) { console.log('创建分享失败:', sRes); process.exit(1); }
  console.log('token =', sRes.data.token);
  console.log('asOf  =', sRes.data.to);
  console.log('\n打开方式：');
  console.log('  --page pages/report-view/report-view --query "token=' + sRes.data.token + '"');
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
