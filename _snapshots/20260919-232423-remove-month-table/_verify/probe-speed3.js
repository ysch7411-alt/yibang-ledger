// A/B：把「归类」这一步从 qwen-plus 换成更快的模型，准确率会不会掉
const fs = require('fs');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const { callModel, extractJson } = require('/www/wwwroot/yibang-server/lib/ledger');

// 直接复用线上真实的 PARSE_PROMPT，保证测的是真东西
const src = fs.readFileSync('/www/wwwroot/yibang-server/routes/record.js', 'utf8');
const m = src.match(/const PARSE_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/);
const PARSE_PROMPT = eval('[' + m[1] + "].join('\\n')");

const TODAY = '2026-09-19';
const YESTERDAY = '2026-09-18';
const PROMPT = PARSE_PROMPT.replace('__TODAY__', TODAY);

// 每条都写清「期望」，先人工定好标准答案，再比模型
const CASES = [
  {
    said: '今天收了张老板5000块货款',
    want: [{ amount: 5000, type: '收入', contact: '张老板', content: '货款', date: TODAY }]
  },
  {
    said: '昨天买了三斤猪肉花了38块，今天又买了两斤洋葱3块钱',
    want: [
      { amount: 38, type: '支出', contact: '', content: '猪肉', date: YESTERDAY },
      { amount: 3, type: '支出', contact: '', content: '洋葱', date: TODAY }
    ]
  },
  {
    said: '把上次欠李四的2000块钱货款给他了',
    want: [{ amount: 2000, type: '付款', contact: '李四', content: '货款', date: TODAY }]
  },
  {
    said: '王五还欠我3000块货款，还没给',
    want: [{ amount: 3000, type: '应收', contact: '王五', content: '货款', date: TODAY }]
  },
  {
    said: '这个月的房租8000已经付出去了',
    want: [{ amount: 8000, type: '支出', contact: '', content: '房租', date: TODAY }]
  },
  {
    said: '今天天气不错，没做生意',
    want: []
  },
  {
    said: '前天进了2.5吨螺纹钢，3800一吨，钱已经付了',
    want: [{ amount: 9500, type: '支出', contact: '', content: '螺纹钢', date: '2026-09-17' }]
  }
];

const norm = (v) => String(v == null ? '' : v).replace(/\s/g, '');
const num = (v) => (v == null ? '' : String(Number(v)));

function judge(got, want) {
  if (!Array.isArray(got)) return { ok: false, why: '不是数组' };
  if (got.length !== want.length) return { ok: false, why: '笔数 ' + got.length + '≠' + want.length };
  for (let i = 0; i < want.length; i++) {
    const g = got[i], w = want[i];
    if (num(g.amount) !== num(w.amount)) return { ok: false, why: '第' + (i + 1) + '笔金额 ' + g.amount + '≠' + w.amount };
    if (norm(g.type) !== w.type) return { ok: false, why: '第' + (i + 1) + '笔类型 ' + g.type + '≠' + w.type };
    if (w.contact && norm(g.contact) !== w.contact) return { ok: false, why: '第' + (i + 1) + '笔对象 ' + g.contact + '≠' + w.contact };
    if (norm(g.date) !== w.date) return { ok: false, why: '第' + (i + 1) + '笔日期 ' + g.date + '≠' + w.date };
  }
  return { ok: true };
}

(async () => {
  const MODELS = ['qwen-plus', 'qwen-flash', 'qwen-turbo'];
  const tally = {};
  MODELS.forEach((m) => { tally[m] = { pass: 0, ms: [] }; });

  for (const c of CASES) {
    console.log('──────────────────────────────────────────────');
    console.log('原话: ' + c.said);
    console.log('期望: ' + JSON.stringify(c.want.map((w) => [w.amount, w.type, w.contact, w.date])));
    for (const model of MODELS) {
      const t0 = Date.now();
      let raw = '', err = '';
      try {
        raw = await callModel({
          model,
          messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: c.said }],
          temperature: 0.1
        }, 60000);
      } catch (e) {
        err = e.response ? JSON.stringify(e.response.data).slice(0, 80) : e.message;
      }
      const took = Date.now() - t0;
      tally[model].ms.push(took);
      const j = err ? null : extractJson(raw);
      const got = j && Array.isArray(j.records) ? j.records : null;
      const r = err ? { ok: false, why: '调用失败 ' + err } : judge(got, c.want);
      if (r.ok) tally[model].pass++;
      console.log('  ' + (model + '        ').slice(0, 13) + String(took).padStart(6) + 'ms  ' +
        (r.ok ? '✓ 对' : '✗ ' + r.why) +
        (r.ok ? '' : '   实际=' + (got ? JSON.stringify(got.map((g) => [g.amount, g.type, g.contact, g.date])) : String(raw).slice(0, 80))));
    }
  }

  console.log('\n================ 汇总（' + CASES.length + ' 个用例）================');
  for (const model of MODELS) {
    const ms = tally[model].ms.sort((a, b) => a - b);
    const mid = ms[Math.floor(ms.length / 2)];
    const avg = Math.round(ms.reduce((s, v) => s + v, 0) / ms.length);
    console.log((model + '              ').slice(0, 14) +
      '正确 ' + tally[model].pass + '/' + CASES.length +
      '   中位 ' + mid + 'ms   平均 ' + avg + 'ms');
  }
})();
