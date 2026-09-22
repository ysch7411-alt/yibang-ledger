// 验证「越用越懂」闭环：纠正一次 → 下次同一个叫法自动对上
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '30m' });
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const call = (p, d) => axios.post(BASE + p, d, { headers: H, timeout: 60000 }).then((r) => r.data);

(async () => {
  console.log('=== 起点：清掉这个词的旧记录，模拟全新商家 ===');
  await pool.query("DELETE FROM merchant_terms WHERE user_id=1 AND alias IN ('张哥','李哥')");
  await pool.query("DELETE FROM ai_corrections WHERE user_id=1");

  console.log('\n=== ① 老板第一次说「今天收张哥3000块货款」 ===');
  const p1 = await call('/record/ai-parse', { text: '今天收张哥3000块货款' });
  const r1 = p1.data.records[0];
  console.log('  AI 识别 → 往来对象「' + r1.contact + '」 金额 ' + r1.amount + ' 类型 ' + r1.type);
  console.log('  自动学到 → ' + JSON.stringify(p1.data.learned));

  const saved = await call('/record/create', {
    type: r1.type, amount: r1.amount, content: r1.content, contact_name: r1.contact, record_date: r1.date
  });
  const txId = saved.data.id;
  console.log('  已入账 id=' + txId + '（contact_id=' + saved.data.contact_id + '）');

  console.log('\n=== ② 老板点了「改一下」，把「' + r1.contact + '」改成「张老板」 ===');
  const upd = await call('/record/update', {
    id: txId,
    contact_name: '张老板',
    sourceText: '今天收张哥3000块货款',
    aiResult: { type: r1.type, contactName: r1.contact, content: r1.content }
  });
  console.log('  后端学到 → ' + JSON.stringify(upd.data.learned));

  console.log('\n=== ③ 词表现状 ===');
  const [terms] = await pool.query(
    'SELECT kind, alias, canonical, hits, source FROM merchant_terms WHERE user_id=1 ORDER BY kind, alias'
  );
  terms.forEach((t) => console.log('  ' + t.kind + '  ' + t.alias + ' → ' + t.canonical + '  hits=' + t.hits + '  source=' + t.source));
  const [fixes] = await pool.query('SELECT source_text, learned FROM ai_corrections WHERE user_id=1 ORDER BY id DESC LIMIT 1');
  if (fixes.length) console.log('  纠正流水: 「' + fixes[0].source_text + '」 学到: ' + fixes[0].learned);

  console.log('\n=== ④ 关键验证：老板下次还说「张哥」，AI 还认不认得是张老板？ ===');
  const p2 = await call('/record/ai-parse', { text: '今天张哥又给了500块' });
  const r2 = p2.data.records[0];
  console.log('  归一命中 → ' + JSON.stringify(p2.data.matched));
  console.log('  AI 识别 → 往来对象「' + r2.contact + '」 金额 ' + r2.amount);
  console.log(r2.contact === '张老板'
    ? '  ✅ 闭环成立：同一个叫法这次自动对上了「张老板」，不用老板再纠正一次'
    : '  ❌ 闭环没成立：期望「张老板」，实际「' + r2.contact + '」');

  console.log('\n=== 清理测试数据 ===');
  await call('/record/delete', { id: txId });
  await pool.query("DELETE FROM merchant_terms WHERE user_id=1 AND alias IN ('张哥','张老板')");
  await pool.query("DELETE FROM ai_corrections WHERE user_id=1");
  await pool.query("DELETE FROM transactions WHERE user_id=1 AND content='货款' AND contact_id IN (SELECT id FROM contacts WHERE name='张老板' AND user_id=1) AND id>0 AND amount=3000");
  console.log('  已清理');
  process.exit(0);
})().catch(async (e) => {
  console.error('失败:', (e.response && JSON.stringify(e.response.data)) || e.message);
  process.exit(1);
});
