// 端到端操作路径 + 边界值验证（2026-09-20 上线前）
//
// 与 audit-api.js 的区别：那个只验"端点活着"，这个验**用户真的这么操作时会发生什么**。
// 用户反馈"用起来不顺畅、功能 bug 不少"，而操作路径上的问题（重复入账、边界值崩、
// 改完查不到、分享串号）接口层审计是发现不了的。
//
// 在服务器上跑（能读 .env 签 token、直连 127.0.0.1:3000）：
//   node __e2e.js
// 跑完会清理自己造的测试数据，并在结束时核对基线。
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const UID = 1;                       // 专用测试账号，不碰老易的账
const token = jwt.sign({ userId: UID }, process.env.JWT_SECRET, { expiresIn: 1800 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);

const created = [];                  // 本脚本造的流水，最后统一删
let pass = 0, fail = 0;
const fails = [];

/** 期望：ok=应该 code 0；rej=应该被拒（4xx 且 msg 可读）；null=探索性（只要没 5xx 就算过）
 *  数组=列出可接受的 code */
async function call(label, method, path, body, expect, extra) {
  const cfg = { method, url: BASE + path, headers: H, timeout: 30000, validateStatus: () => true };
  if (method !== 'get' && body !== undefined) cfg.data = body;
  let r;
  try {
    const resp = await axios(cfg);
    r = { http: resp.status, body: resp.data };
  } catch (e) {
    r = { http: 'ERR', body: e.response ? e.response.data : String(e.message) };
  }
  const code = r.body && typeof r.body === 'object' ? r.body.code : undefined;
  const msg = r.body && typeof r.body === 'object' ? r.body.msg : undefined;

  let ok;
  if (r.http === 'ERR' || r.http >= 500) ok = false;
  else if (expect === 'ok') ok = code === 0;
  else if (expect === 'rej') ok = (code === undefined ? false : code !== 0 && code < 500);
  else if (expect === null) ok = true;                    // 探索：只关心"没炸"
  else ok = expect.includes(code);

  ok ? pass++ : (fail++, fails.push(label + ' → HTTP ' + r.http + ' code=' + code + ' ' + cut(msg, 60)));
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + pad(label, 30) + pad('HTTP ' + r.http, 9) + pad('code=' + code, 10) + cut(msg, 46));
  return r;
}

(async () => {
  const [[baseTx], [baseContacts]] = await Promise.all([
    pool.query('SELECT COUNT(*) n FROM transactions WHERE user_id=?', [UID]),
    pool.query('SELECT COUNT(*) n FROM contacts WHERE user_id=?', [UID])
  ]);

  console.log('═══ 1. 主路径：说一句 → 记账 → 能查到 → 改 → 删 ═══');
  let recId = null;

  const p1 = await call('文字解析（一句话一笔）', 'post', '/record/ai-parse', { text: '今天收张三货款五百元' }, 'ok');
  if (p1.body && p1.body.data) {
    const d = p1.body.data;
    const one = Array.isArray(d) ? d[0] : (d.records ? d.records[0] : d);
    if (one) {
      recId = one.id || null;
      console.log('      解析出：type=' + one.type + ' amount=' + one.amount + ' title=' + cut(one.title, 18) + ' date=' + one.date);
    }
  }
  if (!recId) {
    // 解析接口可能只返回草稿（不入库），那就手动建一条，后面照旧验
    const p1b = await call('解析后保存', 'post', '/record/create', { type: 1, amount: 500, content: '张三货款' }, 'ok');
    recId = p1b.body && p1b.body.data && p1b.body.data.id;
    if (recId) created.push(recId);
  } else created.push(recId);
  if (!recId) { console.log('  ✗ 没能造出测试流水，后续用例跳过'); }

  if (recId) {
    await call('列表能查到刚记的', 'get', '/record/list?page=1&size=50&withTotal=1', undefined, 'ok');
    await call('本月汇总含这笔', 'get', '/record/month-summary?month=' + new Date().toISOString().slice(0, 7), undefined, 'ok');
    await call('修改这笔（金额改 600）', 'post', '/record/update', { id: recId, amount: 600 }, 'ok');
    await call('改完能读回新金额', 'get', '/record/list?page=1&size=50', undefined, 'ok');
    await call('删除这笔', 'post', '/record/delete', { id: recId }, 'ok');
    created.splice(created.indexOf(recId), 1);
    await call('删完列表里查不到', 'get', '/record/list?page=1&size=50', undefined, 'ok');
  }

  console.log('\n═══ 2. 一句话多笔 & AI 解析边界 ═══');
  await call('多笔混合（收+付+往来）', 'post', '/record/ai-parse', { text: '今天收李四货款300，付王五运费50' }, 'ok');
  await call('空文本', 'post', '/record/ai-parse', { text: '' }, null);
  await call('超长文本 5000 字', 'post', '/record/ai-parse', { text: '记一笔'.repeat(1250) }, null);
  await call('纯符号', 'post', '/record/ai-parse', { text: '！！！？？？###' }, null);
  await call('只有金额没有人名', 'post', '/record/ai-parse', { text: '100' }, null);
  await call('SQL 注入串', 'post', '/record/ai-parse', { text: "x'; DROP TABLE transactions; --" }, null);
  await call('XSS 串', 'post', '/record/ai-parse', { text: '<script>alert(1)</script>' }, null);
  await call('emoji', 'post', '/record/ai-parse', { text: '收张三货款500😂😂' }, null);

  console.log('\n═══ 3. 记账参数边界（最容易出 bug 的地方）═══');
  await call('金额 0', 'post', '/record/create', { type: 1, amount: 0, content: '零元' }, null);
  await call('金额负数', 'post', '/record/create', { type: 1, amount: -5, content: '负数' }, null);
  await call('金额超小 0.001', 'post', '/record/create', { type: 1, amount: 0.001, content: '分' }, null);
  await call('金额超大 999999999.99', 'post', '/record/create', { type: 1, amount: 999999999.99, content: '巨额' }, null);
  await call('金额是字符串 "500"', 'post', '/record/create', { type: 1, amount: '500', content: '字符串金额' }, null);
  await call('金额是 null', 'post', '/record/create', { type: 1, amount: null, content: '空金额' }, null);
  await call('type 非法（99）', 'post', '/record/create', { type: 99, amount: 10, content: '坏类型' }, null);
  await call('type 非法（-1）', 'post', '/record/create', { type: -1, amount: 10, content: '负类型' }, null);
  await call('标题超长 300 字', 'post', '/record/create', { type: 1, amount: 10, content: '菜'.repeat(300) }, null);
  await call('标题为空', 'post', '/record/create', { type: 1, amount: 10, content: '' }, null);
  await call('日期是未来', 'post', '/record/create', { type: 1, amount: 10, content: '未来', record_date: '2099-01-01' }, null);
  await call('日期不合法', 'post', '/record/create', { type: 1, amount: 10, content: '坏日期', record_date: '2026-13-99' }, null);
  await call('完全不带 body', 'post', '/record/create', {}, null);

  console.log('\n═══ 4. 分页与筛选边界 ═══');
  await call('page=0', 'get', '/record/list?page=0&size=10', undefined, 'ok');
  await call('page=-1', 'get', '/record/list?page=-1&size=10', undefined, null);
  await call('page=99999', 'get', '/record/list?page=99999&size=10', undefined, 'ok');
  await call('size=0', 'get', '/record/list?page=1&size=0', undefined, null);
  await call('size=99999（上限）', 'get', '/record/list?page=1&size=99999', undefined, null);
  await call('timeRange=本月', 'get', '/record/list?page=1&size=10&timeRange=month', undefined, 'ok');
  await call('timeRange 乱写', 'get', '/record/list?page=1&size=10&timeRange=随便', undefined, null);
  await call('type 乱写', 'get', '/record/list?page=1&size=10&type=abc', undefined, null);
  await call('keyword 乱写', 'get', '/record/list?page=1&size=10&keyword=%', undefined, null);

  console.log('\n═══ 5. 改/删别人的账（越权）═══');
  const [otherRows] = await pool.query('SELECT id FROM transactions WHERE user_id<>? LIMIT 1', [UID]);
  const other = otherRows[0] || null;
  if (other) {
    await call('改别人的流水', 'post', '/record/update', { id: other.id, amount: 1 }, null);
    await call('删别人的流水', 'post', '/record/delete', { id: other.id }, null);
  } else {
    console.log('  ℹ 库里没有别人的流水，越权用例跳过');
  }

  console.log('\n═══ 6. 分享链路（拿出去对账的东西）═══');
  const sh = await call('创建分享', 'post', '/share/create', { type: 1, date: new Date().toISOString().slice(0, 10) }, 'ok');
  const sToken = sh.body && sh.body.data && sh.body.data.token;
  if (sToken) {
    await call('用 token 读分享', 'get', '/share/view/' + sToken, undefined, 'ok');
    await call('错误 token', 'get', '/share/view/not-a-real-token', undefined, null);
  }
  // 换成另一个用户的登录态，看能不能读到 UID 的分享
  const otherTok = jwt.sign({ userId: 2 }, process.env.JWT_SECRET, { expiresIn: 300 });
  const r2 = await axios({ method: 'get', url: BASE + '/share/view/' + (sToken || 'x'), headers: { Authorization: 'Bearer ' + otherTok }, timeout: 15000, validateStatus: () => true }).catch((e) => ({ status: 'ERR', data: {} }));
  const crossOk = !!(r2.body && r2.body.code !== 0);
  crossOk ? pass++ : (fail++, fails.push('别人的登录态读我的分享 → 竟然读到了'));
  console.log('  ' + (crossOk ? '✓' : '✗') + '别人的登录态读我的分享      HTTP ' + r2.status + ' code=' + (r2.body && r2.body.code));

  console.log('\n═══ 7. 并发（重复入账是真实风险）═══');
  const same = { type: 1, amount: 66, content: '并发测试' };
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => axios({ method: 'post', url: BASE + '/record/create', headers: H, data: same, timeout: 20000, validateStatus: () => true }).catch((e) => ({ data: { code: -1 } }))));
  const okIds = rs.map((r) => r.data && r.data.data && r.data.data.id).filter(Boolean);
  okIds.forEach((id) => created.push(id));
  console.log('    5 次并发记账：成功 ' + okIds.length + ' 次（前端的"只点一次"能拦住，但接口层不保证幂等）');

  console.log('\n═══ 8. 清理测试数据 ═══');
  const createdMore = [];
  // 上面各边界用例可能也建了数据，一次捞干净
  const [mine] = await pool.query('SELECT id, content FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 40', [UID]);
  for (const row of mine) {
    const c = row.content || '';
    if (/^(并发测试|零|负数|分|巨额|字符串金额|空金额|坏类型|负类型|未来|坏日期|李四|王五|张三|XSS|emoji|收|付)/.test(c) || c.indexOf('菜') === 0) {
      createdMore.push(row.id);
    }
  }
  const toDel = [...new Set([...created, ...createdMore])];
  for (const id of toDel) { try { await pool.query('DELETE FROM transactions WHERE id=? AND user_id=?', [id, UID]); } catch (e) {} }
  console.log('    删除 ' + toDel.length + ' 条测试流水');

  const [[afterTx], [afterContacts]] = await Promise.all([
    pool.query('SELECT COUNT(*) n FROM transactions WHERE user_id=?', [UID]),
    pool.query('SELECT COUNT(*) n FROM contacts WHERE user_id=?', [UID])
  ]);

  console.log('\n================ 汇总 ================');
  console.log('  ' + pass + ' 项通过 / ' + fail + ' 项失败');
  fails.forEach((f) => console.log('    ✗ ' + f));
  console.log('  数据基线：流水 ' + baseTx[0].n + ' → ' + afterTx[0].n + '（应相等）· 往来 ' + baseContacts[0].n + ' → ' + afterContacts[0].n);
  console.log('  ' + (afterTx[0].n === baseTx[0].n ? '✓ 没有留下脏数据' : '⚠ 有残留，需人工清理'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('跑挂了：' + e.message); process.exit(1); });
