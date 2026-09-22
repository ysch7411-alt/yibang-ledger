const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const t = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 900 });
const H = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
const ask = (q, history) => axios.post('http://127.0.0.1:3000/api/ai/chat', { question: q, history }, { headers: H, timeout: 50000 })
  .then((r) => r.data).catch((e) => ({ code: -1, msg: String(e.message) }));

const show = (label, r) => {
  console.log('\n' + label);
  console.log('  code=' + r.code + (r.msg ? '  msg=' + r.msg : ''));
  const d = r.data || {};
  console.log('  answer(原文)：' + String(d.answer || '').slice(0, 160));
  if (d.card) {
    console.log('  ── 结构化卡片 ──');
    console.log('    结论：' + (d.card.summary || '(空)'));
    (d.card.numbers || []).forEach((n) => console.log('    数字：' + n.label + ' = ' + n.value));
    (d.card.points || []).forEach((p, i) => console.log('    要点' + (i + 1) + '：' + p));
    if (!d.card.numbers.length && !d.card.points.length) console.log('    （只有结论，没有数字和要点）');
  } else {
    console.log('  ── 没有结构化（前端会按段落渲染纯文本）');
  }
};

(async () => {
  const qs = [
    '这个月赚了多少？',
    '谁欠我最多？',
    '这个月哪项支出最大？',
    '帮我看看最近的账'
  ];
  for (const q of qs) {
    show('问：' + q, await ask(q));
    await new Promise((r) => setTimeout(r, 800));
  }

  // 刻意问一个没有数据的问题，看它会不会编
  show('问：去年十月我进了多少货？（库里没有）', await ask('去年十月我进了多少货？'));

  // 多轮：带上历史
  const a1 = await ask('这个月赚了多少？');
  show('问：那上月呢？（带上下文）', await ask('那上月呢？', [
    { role: 'user', content: '这个月赚了多少？' },
    { role: 'ai', content: String((a1.data && a1.data.answer) || '') }
  ]));
})();
