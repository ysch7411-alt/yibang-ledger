// /record/ai-parse 回归测试 —— 语音记账最容易错的两件事
//
// 用户报障原话（2026-09-19）：
//   ①「辣椒3白，5块钱一斤」→ AI 不算总额，要用户自己填才肯入账
//   ②「今天收现金1265元」  → 归到「未填写事由」，应该归到「现金」
//
// 这两类都是**钱的正确性**问题，所以每一项都写死期望值，不靠肉眼看。
// 用法（在 /www/wwwroot/yibang-server 下）：node __probe-parse.js
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

// [原话, 期望]
//   amount / type / content / method / qty 给出则必须相等，null 表示必须为空
//   empty:true 表示必须返回 0 笔（用于验"示例没有被照抄"）
const CASES = [
  // —— 数量 × 单价：必须自己算出来 ——
  ['辣椒3白，5块钱一斤',        { amount: 15,  type: '支出', qty: 3,  content: '辣椒' }],
  ['辣椒3包，5块钱一斤',        { amount: 15,  type: '支出', qty: 3,  content: '辣椒' }],
  ['辣椒3件，5块钱一斤',        { amount: 15,  type: '支出', qty: 3 }],
  ['辣椒300斤，5块钱一斤',      { amount: 1500, type: '支出', qty: 300 }],
  ['买了20斤辣椒，一斤5块',      { amount: 100, type: '支出', qty: 20 }],
  ['辣椒2袋5块一袋',            { amount: 10,  type: '支出', qty: 2 }],
  ['拉货3趟，一趟200',          { amount: 600, type: '支出', qty: 3 }],
  ['水泥10吨，一吨420',         { amount: 4200, type: '支出', qty: 10 }],

  // —— 收付方式：不能丢，也不能被当成客户 ——
  ['今天收现金1265元',          { amount: 1265, type: '收入', method: '现金', contact: null, content: null }],
  ['今天收现金1265',            { amount: 1265, type: '收入', method: '现金', contact: null }],
  ['微信收款800',               { amount: 800,  type: '收入', method: '微信', contact: null }],
  ['支付宝收了320',             { amount: 320,  type: '收入', method: '支付宝', contact: null }],
  ['卖废铁收款300元',           { amount: 300,  type: '收入', content: '废铁', method: null }],

  // —— 不能瞎编：示例里的数字绝不能被抄出来 ——
  ['今天天气不错',              { empty: true }],
  ['张老板人挺好的',            { empty: true }],
  ['把货送到了',                { empty: true }],

  // —— 别把正常的人和事由弄丢 ——
  ['张老板欠我2000',            { amount: 2000, type: '应收' }],
  ['付了房租3500',              { amount: 3500, type: '支出' }]
];

const rows = [];
const say = (ok, label, detail) => {
  rows.push(ok);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : ''));
};

(async () => {
  for (const [text, want] of CASES) {
    let data;
    try {
      const r = await axios.post(BASE + '/record/ai-parse', { text }, { headers: H, timeout: 60000 });
      data = r.data.data || {};
    } catch (e) {
      console.log('\n  ' + text + '  → 请求失败 ' + e.message);
      rows.push(false);
      continue;
    }
    const rs = data.records || [];
    const head = '\n  ' + text;
    const got = rs.length
      ? 'amount=' + rs[0].amount + ' type=' + rs[0].type +
        ' qty=' + rs[0].qty + ' unit=' + JSON.stringify(rs[0].unit) +
        ' method=' + JSON.stringify(rs[0].method) +
        ' contact=' + JSON.stringify(rs[0].contact) +
        ' content=' + JSON.stringify(rs[0].content)
      : '（0 笔）';
    console.log(head + '  → ' + got);

    if (want.empty) {
      say(rs.length === 0, '   必须返回 0 笔（示例没被照抄）', rs.length ? '实际 ' + rs.length + ' 笔' : '');
      continue;
    }

    const r0 = rs[0] || {};
    if (rs.length === 0) { say(false, '   不该是空的'); continue; }

    if (want.amount !== undefined) {
      say(r0.amount === want.amount, '   amount = ' + want.amount, '实际 ' + r0.amount);
    }
    if (want.type !== undefined) {
      say(r0.type === want.type, '   type = ' + want.type, '实际 ' + r0.type);
    }
    if (want.qty !== undefined) {
      say(Number(r0.qty) === want.qty, '   qty = ' + want.qty, '实际 ' + r0.qty);
    }
    if (want.method !== undefined) {
      if (want.method === null) say(!r0.method, '   method 必须为空', '实际 ' + JSON.stringify(r0.method));
      else say(r0.method === want.method, '   method = ' + want.method, '实际 ' + JSON.stringify(r0.method));
    }
    if (want.contact !== undefined) {
      if (want.contact === null) say(!r0.contact, '   contact 必须为空（不能把方式当客户）', '实际 ' + JSON.stringify(r0.contact));
      else say(r0.contact === want.contact, '   contact = ' + want.contact, '实际 ' + JSON.stringify(r0.contact));
    }
    if (want.content !== undefined) {
      if (want.content === null) say(!r0.content, '   content 必须为空（不要硬编事由）', '实际 ' + JSON.stringify(r0.content));
      else say(String(r0.content).indexOf(want.content) >= 0, '   content 含「' + want.content + '」', '实际 ' + JSON.stringify(r0.content));
    }
  }

  const bad = rows.filter((x) => !x).length;
  console.log('\n================ 汇总 ================');
  console.log('语音归类：' + (rows.length - bad) + ' / ' + rows.length + ' 通过');
  process.exit(bad ? 1 : 0);
})();
