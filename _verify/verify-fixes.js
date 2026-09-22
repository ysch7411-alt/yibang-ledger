// 验证今天三项修复的实际效果（在服务器上跑）
//   ① 参数校验：type=99 / 超额 / 过小 应被拒
//   ② 去重：3 秒内同一笔账只入库一次；内容不同的照常入库
//   ③ 会话上下文：带 history 问"那上月呢"，回答应该谈上月
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const UID = 1;
const token = jwt.sign({ userId: UID }, process.env.JWT_SECRET, { expiresIn: 900 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const hit = (m, p, b) => axios({ method: m, url: BASE + p, headers: H, data: b, timeout: 40000, validateStatus: () => true })
  .then((r) => r.data).catch((e) => ({ code: -1, msg: String(e.message) }));

let pass = 0, fail = 0;
const say = (ok, label, extra) => { ok ? pass++ : fail++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (extra ? '  → ' + extra : '')); };

(async () => {
  console.log('═══ ① 参数校验 ═══');
  const bad1 = await hit('post', '/record/create', { type: 99, amount: 100, content: '坏类型验证' });
  say(bad1.code === 400, 'type=99 被拒绝', bad1.msg);
  const bad2 = await hit('post', '/record/create', { type: 1, amount: 999999999.99, content: '超额验证' });
  say(bad2.code === 400, '金额超额被拒绝', bad2.msg);
  const bad3 = await hit('post', '/record/create', { type: 1, amount: 0.001, content: '过小验证' });
  say(bad3.code === 400, '金额过小被拒绝', bad3.msg);
  const good = await hit('post', '/record/create', { type: 2, amount: 66.5, content: '验证·正常一笔' });
  say(good.code === 0, '正常金额照常入库', 'id=' + (good.data && good.data.id));

  console.log('\n═══ ② 去重（3 秒内同一笔只入库一次）═══');
  const body = { type: 2, amount: 88.88, content: '验证·去重测试' };
  const a = await hit('post', '/record/create', body);
  const b = await hit('post', '/record/create', body);
  say(a.code === 0 && !!a.data.id, '第一次入账', 'id=' + (a.data && a.data.id));
  say(b.code === 0 && b.data && b.data.deduped === true, '第二次判定为重复（不重复写库）', JSON.stringify(b.data));
  say(a.data && b.data && a.data.id === b.data.id, '两次返回同一个 id');

  const [dupCount] = await pool.query('SELECT COUNT(*) n FROM transactions WHERE user_id=? AND content=? AND amount=88.88', [UID, '验证·去重测试']);
  say(dupCount[0].n === 1, '库里确实只有 1 条', '实际 ' + dupCount[0].n + ' 条');

  const c1 = await hit('post', '/record/create', { type: 2, amount: 88.88, content: '验证·去重测试A' });
  const c2 = await hit('post', '/record/create', { type: 2, amount: 88.88, content: '验证·去重测试B' });
  say(c1.code === 0 && !!c1.data.id && c2.code === 0 && !!c2.data.id && !c2.data.deduped,
    '内容不同的两笔**不**会被误去重（老板可能要连记两笔一样的）');

  console.log('\n═══ ③ 会话上下文 ═══');
  const r1 = await hit('post', '/ai/chat', { question: '这个月赚了多少？' });
  say(r1.code === 0 && !!r1.data, '第一轮能答', String(r1.data && r1.data.answer).slice(0, 40));

  // 第二轮带上第一轮的对话，问"那上月呢"—— 没有上下文时它只会再复述本月
  const r2 = await hit('post', '/ai/chat', {
    question: '那上月呢？',
    history: [{ role: 'user', content: '这个月赚了多少？' }, { role: 'ai', content: String(r1.data && r1.data.answer || '') }]
  });
  const ans2 = String(r2.data && r2.data.answer || '');
  say(r2.code === 0, '第二轮能答', ans2.slice(0, 60));
  const talksLast = /上月|上个月|上一个|8月|八月/.test(ans2);
  say(talksLast, '第二轮真的在谈"上月"（而不是又复述本月）', ans2.slice(0, 70));

  console.log('\n═══ 清理 ═══');
  const [del] = await pool.query("DELETE FROM transactions WHERE user_id=? AND content LIKE '验证·%'", [UID]);
  console.log('  删掉 ' + del.affectedRows + ' 条验证数据');

  console.log('\n' + (fail ? '✗ ' + fail + ' 项没过' : '✓ 三项全部生效') + '（通过 ' + pass + ' / 失败 ' + fail + '）');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('跑挂：' + e.message); process.exit(1); });
