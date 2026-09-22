// 跨商户越权（多租户隔离）验证：给一个**专用的测试商户**造数据，用 userId=1 的 token 去读/改，
// 必须读不到、改不动。
//
// ⚠️ 这里原本写的是「找一个真实存在的第二用户（id <> 1）」。2026-09-19 线上真的有了第二个账号 ——
// 而且是**老板本人的真实账号** —— 于是这段会往他的账本里插 3 条测试数据，跑完才删。
// 万一中途崩了，他的账里就留下一条 ¥999.99 的假流水，而且他完全不知道从哪来的。
// **审计脚本永远不许挑"任意一个真实用户"下手**，只能用它自己建的测试账号。
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const T1 = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H1 = { Authorization: 'Bearer ' + T1, 'Content-Type': 'application/json' };

const get = (p) => axios.get(BASE + p, { headers: H1, timeout: 20000, validateStatus: () => true }).then((r) => ({ http: r.status, body: r.data })).catch((e) => ({ http: 'ERR', body: {} }));
const post = (p, d) => axios.post(BASE + p, d, { headers: H1, timeout: 20000, validateStatus: () => true }).then((r) => ({ http: r.status, body: r.data })).catch((e) => ({ http: 'ERR', body: {} }));

const TEST_OPENID = '__isolation_test__';
const created = { contactId: null, txId: null, poId: null };

/** 收尾一律走它，保证不管中间出什么错都不留垃圾在线上 */
async function cleanup() {
  try {
    if (created.txId) await pool.query('DELETE FROM transactions WHERE id = ?', [created.txId]);
    if (created.contactId) await pool.query('DELETE FROM contacts WHERE id = ?', [created.contactId]);
    if (created.poId) await pool.query('DELETE FROM purchase_orders WHERE id = ?', [created.poId]);
    await pool.query('DELETE FROM users WHERE openid = ?', [TEST_OPENID]);
    console.log('\n已清理测试数据');
  } catch (e) {
    console.error('清理失败，请手动检查：', e.message);
  }
}

(async () => {
  // 专用测试账号：只认这个 openid，绝不碰真实用户
  const [exist] = await pool.query('SELECT id FROM users WHERE openid = ?', [TEST_OPENID]);
  let uid2;
  if (exist.length) {
    uid2 = exist[0].id;
  } else {
    const [ins] = await pool.query('INSERT INTO users (openid, role) VALUES (?, 1)', [TEST_OPENID]);
    uid2 = ins.insertId;
  }
  console.log('用专用测试商户 userId=' + uid2 + '（openid=' + TEST_OPENID + '）造数据，然后用 userId=1 的 token 去访问\n');

  // 造：一条往来 + 一笔流水 + 一张采购单
  const [c] = await pool.query("INSERT INTO contacts (user_id, name, type, balance) VALUES (?, '__B商户客户__', 1, 0)", [uid2]);
  const [t] = await pool.query("INSERT INTO transactions (user_id, type, amount, content, record_date, status) VALUES (?, 2, 999.99, '__B商户流水__', '2026-09-19', 1)", [uid2]);
  const [po] = await pool.query("INSERT INTO purchase_orders (user_id, supplier_name, order_date, total_amount, item_count) VALUES (?, '__B商户供应商__', '2026-09-19', 8888, 1)", [uid2]);

  const contactId = c.insertId, txId = t.insertId, poId = po.insertId;
  created.contactId = contactId;
  created.txId = txId;
  created.poId = poId;
  console.log('B 商户数据：contact=' + contactId + ' transaction=' + txId + ' purchase_order=' + poId + '\n');

  const rows = [];
  const probe = (label, passed, detail) => {
    rows.push({ label, passed, detail });
    console.log('  ' + (passed ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : ''));
  };

  // ① 读：contact/detail 与 purchase/detail 必须拿不到别人的
  let r = await get('/contact/detail?id=' + contactId);
  const leakedContact = JSON.stringify(r.body).includes('__B商户客户__');
  probe('读别人的往来对象', !leakedContact, leakedContact ? '⚠ 泄露了！' : 'code=' + r.body.code);

  r = await get('/purchase/detail?id=' + poId);
  const leakedPo = JSON.stringify(r.body).includes('__B商户供应商__');
  probe('读别人的采购单', !leakedPo, leakedPo ? '⚠ 泄露了！' : 'code=' + r.body.code);

  // ② 列表里不能出现别人的数据
  r = await get('/contact/list');
  probe('往来列表不含别人数据', !JSON.stringify(r.body).includes('__B商户客户__'));
  r = await get('/record/list?page=1&size=200');
  probe('流水列表不含别人数据', !JSON.stringify(r.body).includes('__B商户流水__'));
  r = await get('/purchase/list');
  probe('采购单列表不含别人数据', !JSON.stringify(r.body).includes('__B商户供应商__'));

  // ③ 改：用别人的 id 改自己的数据，必须改不动
  r = await post('/record/update', { id: txId, amount: 0.01, type: 1, sourceText: '越权改' });
  const [afterUpdate] = await pool.query('SELECT amount, content FROM transactions WHERE id = ?', [txId]);
  probe('改别人的流水', Number(afterUpdate[0].amount) === 999.99, '实际金额 ' + afterUpdate[0].amount);

  r = await post('/staff/approve', { id: txId, status: 2 });
  const [afterApprove] = await pool.query('SELECT status FROM transactions WHERE id = ?', [txId]);
  probe('审核别人的流水', Number(afterApprove[0].status) === 1, '实际 status ' + afterApprove[0].status);

  // ④ 删：删别人的流水必须无效
  r = await post('/record/delete', { id: txId });
  const [afterDel] = await pool.query('SELECT COUNT(*) c FROM transactions WHERE id = ?', [txId]);
  probe('删别人的流水', Number(afterDel[0].c) === 1, '记录还在=' + (Number(afterDel[0].c) === 1));

  // ⑤ 汇总数字不能被别人的数据污染
  r = await get('/contact/summary');
  probe('往来汇总没被污染', !JSON.stringify(r.body).includes('8888'));

  // 清理
  await cleanup();

  const failed = rows.filter((x) => !x.passed);
  console.log('\n================ 汇总 ================');
  console.log('多租户隔离：' + (rows.length - failed.length) + ' / ' + rows.length + ' 通过');
  if (failed.length) failed.forEach((f) => console.log('  ✗ ' + f.label + '  ' + f.detail));
  process.exit(0);
})().catch(async (e) => {
  // 中途崩了也要收尾 —— 否则测试数据会留在线上
  console.error('审计脚本异常：', e && e.message);
  await cleanup();
  process.exit(1);
});
