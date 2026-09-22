/**
 * _verify/probe-parse-category.js —— 验「模型到底会不会归品类」（在服务器上跑）
 *
 * 为什么要单独测：管道通（字段存得进、统计算得出）不等于提示词管用。
 * 项目在 prompt 上栽过两次（骨架被当结果、示例值泄漏），所以这里专门测：
 *   ⭐ 必含**反例** —— 既测"该归对"，也测"不该照抄示例"。
 *
 * 用法： cd /www/wwwroot/yibang-server && node probe-parse-category.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const jwt = require('jsonwebtoken');

const BASE = 'http://127.0.0.1:3000/api';
const TEST_UID = 1;

// 注意：这些句子**不是**示例里那三句，用来验"有没有照抄示例"
const CASES = [
  { said: '买螺丝花了15块',        want: '五金/建材类',  mustNotBe: '买菜' },
  { said: '今天买菜花了30',        want: '买菜' },
  { said: '雇车拉货200块',         want: '运费' },
  { said: '交了这个月房租3000',    want: '房租' },
  { said: '给员工发工资5000',      want: '工资' },
  { said: '卖废铁收款300元',       want: '废品/货款',    isIncome: true },
  { said: '买了2吨水泥，一吨380',  want: '建材/五金' },
  { said: '今天天气不错',          want: '空（无金额）', noRecords: true }
];

(async () => {
  const token = jwt.sign({ userId: TEST_UID, id: TEST_UID }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let hit = 0;

  for (const c of CASES) {
    const t0 = Date.now();
    let r;
    try {
      const res = await fetch(BASE + '/record/ai-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ text: c.said })
      });
      r = await res.json();
    } catch (e) { r = { code: -1, msg: e.message }; }
    const ms = Date.now() - t0;

    if (r.code !== 0) { console.log('  ❌', c.said, '→ 接口失败', r.msg); continue; }
    const recs = (r.data && r.data.records) || [];

    if (c.noRecords) {
      const good = recs.length === 0;
      if (good) hit++;
      console.log(good ? '  ✅' : '  ❌', '「' + c.said + '」→ 返回 ' + recs.length + ' 笔（期望 0 笔）');
      continue;
    }

    if (!recs.length) { console.log('  ❌', c.said, '→ 一笔都没解析出来'); continue; }
    const rec = recs[0];
    const cat = rec.category;
    const amountOk = rec.amount > 0;
    const leak = c.mustNotBe && cat === c.mustNotBe;
    const typeOk = c.isIncome ? rec.type === '收入' : true;
    const good = !!cat && amountOk && !leak && typeOk;
    if (good) hit++;

    console.log(
      good ? '  ✅' : '  ⚠️ ',
      '「' + c.said + '」',
      '→ 品类=' + JSON.stringify(cat),
      '| 金额=' + rec.amount,
      '| 类型=' + rec.type,
      '| 期望≈' + c.want,
      leak ? '  ⚠️ 疑似照抄示例！' : '',
      '(' + ms + 'ms)'
    );
  }

  console.log('\n归对 ' + hit + ' / ' + CASES.length);
  process.exit(0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
