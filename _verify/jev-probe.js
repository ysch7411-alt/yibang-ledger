/**
 * _verify/jev-probe.js —— 用真实判断场景探 Jev 决策模型的底
 *
 * 在决定要不要把 Jev 引进生产之前，先实测三件事：
 *   ① 鉴权与接口形态是否和文档一致（文档是别人的，接口是我们要用的）
 *   ② 从阿里云的真实延迟（官方宣传 70–500ms，跨境必须自己量）
 *   ③ 在**我们自己的判断场景**上准不准 —— 官方只给"自测 68%"，
 *      那个数字不能替我们决定，必须拿自己的 case 跑一遍。
 *
 * 密钥**只从环境变量读，不写进任何文件、不回显**（>安全纪律：
 * 长密钥禁止手工转录，判"能不能用"只认实测输出）。
 *
 * 用法：TYPESAFE_API_KEY=xxx node _verify/jev-probe.js
 */
const KEY = process.env.TYPESAFE_API_KEY || '';
const URL = 'https://api.typesafe.ai/v1/systemone';

if (!KEY) {
  console.log('缺少 TYPESAFE_API_KEY 环境变量');
  process.exit(1);
}
// 只回显尾 4 位用于核对，绝不打印完整密钥
console.log('密钥核对：尾 4 位 = ' + KEY.slice(-4) + '，长度 = ' + KEY.length + '\n');

async function jev(state, questions, tag) {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions })
  });
  const ms = Date.now() - t0;
  const body = await res.json();
  return { ms, status: res.status, body };
}

/* ═══════════════ 场景 A：对话即操作的门控 ═══════════════
   老板说一句话 → 判断：是不是要记账？够不够明确到可以直接入账？不缺就缺什么？
   期望值是我按产品原则手写的（不留给模型解释空间）。 */
const CONTACTS = '张老板、李四、王五、青岛华博商贸有限公司';

const CASES_A = [
  { q: '老王还了三千', intent: 'record', ready: true, missing: 'none', why: '对象+金额+动作齐全' },
  { q: '今天买菜花了一百二', intent: 'record', ready: true, missing: 'none', why: '对象+金额齐全，是支出' },
  { q: '老王那笔钱到了', intent: 'record', ready: false, missing: 'amount', why: '有对象没金额' },
  { q: '还了三千', intent: 'record', ready: false, missing: 'who', why: '有金额没对象' },
  { q: '这个月赚了多少', intent: 'query', ready: false, missing: 'none', why: '是查询不是记账' },
  { q: '帮我记一下昨天进货 3500 给张老板', intent: 'record', ready: true, missing: 'none', why: '对象+金额+类型齐全' },
  { q: '今天天气不错', intent: 'other', ready: false, missing: 'none', why: '跟账无关' }
];

/* ═══════════════ 场景 B：每日经营巡检 ═══════════════
   两个 state：① 线上真实（测试账号，数据很稀）② 一个典型夜宵店的富数据。
   第二个才是真实商户的样子 —— 用稀数据测等于没测。 */
const B_QUESTIONS = {
  worth: { type: 'noul', instructions: '今天有值得主动提醒老板的经营异常' },
  what: {
    type: 'choice',
    instructions: '最值得今天说的是哪件事',
    criteria: {
      overdue: '有欠款拖得明显太久了',
      cost: '某项支出比平时高得异常',
      gap: '连续好几天没记账了',
      none: '没有值得打扰老板的事'
    }
  },
  urge: {
    type: 'score',
    instructions: '这件事有多急',
    criteria: ['放着也没事', '有空看一下', '最好今天就处理']
  }
};

const STATES_B = [
  {
    tag: '真实账号（数据稀）',
    state: '本月收入 7510.00 元，支出 115.94 元，结余 7394.06 元；' +
      '上月收入 0 元，支出 0 元；未收欠款 0 笔；近 7 天记了 4 笔，平时每天约 0.5 笔。',
    expect: 'worth 应偏低（数据太少，不该打扰）'
  },
  {
    tag: '典型夜宵店（富数据）',
    state: '本月收入 48000 元，支出 39000 元，结余 9000 元；上月收入 52000 元，支出 31000 元，结余 21000 元；' +
      '未收欠款 4 笔共 18600 元，其中最长一笔挂了 47 天；' +
      '本月食材支出 26000 元，上月 16000 元；近 7 天记了 21 笔，平时每天约 3 笔。',
    expect: 'worth 应偏高，what 应在 overdue / cost 里'
  }
];

(async () => {
  console.log('═══════ 场景 A：记账门控（期望值我手写，不看模型脸色）═══════');
  let hitIntent = 0, hitReady = 0, hitMissing = 0, totalMs = 0;
  for (const c of CASES_A) {
    const state = '老板刚说的一句话：「' + c.q + '」。他账本里的往来对象有：' + CONTACTS + '。今天是 2026-09-22。';
    const { ms, status, body } = await jev(state, {
      intent: {
        type: 'choice',
        instructions: '这句话想干什么',
        criteria: {
          record: '在报一笔账（收入/支出/收付款）',
          query: '在问账上的事',
          other: '都不是'
        }
      },
      ready: { type: 'noul', instructions: '金额、类型、往来对象都明确，可以直接入账，不需要再问老板' },
      missing: {
        type: 'choice',
        instructions: '如果还不能直接入账，最缺的是什么',
        criteria: { none: '不缺，可以入账', amount: '没听出金额', who: '不知道是谁', type: '不知道是收还是付' }
      }
    });
    totalMs += ms;
    if (status !== 200) { console.log('  ✗ HTTP ' + status + ' ' + JSON.stringify(body).slice(0, 200)); continue; }
    const a = body.answers;
    const gotIntent = a.intent.choice;
    const gotReady = a.ready.noul >= 0.9;            // 按 TypeSafe 建议的自动执行阈值
    const gotMiss = a.missing.choice;
    const okI = gotIntent === c.intent, okR = gotReady === c.ready;
    const okM = c.missing === 'none' ? true : gotMiss === c.missing;
    if (okI) hitIntent++;
    if (okR) hitReady++;
    if (okM) hitMissing++;
    console.log(
      (okI && okR && okM ? '  ✅ ' : '  ❌ ') + '「' + c.q + '」  ' + ms + 'ms\n' +
      '       intent ' + (okI ? '✓' : '✗') + ' ' + gotIntent + '（期望 ' + c.intent + '）' +
      ' | ready ' + a.ready.noul.toFixed(3) + '（期望 ' + (c.ready ? '≥0.9' : '<0.9') + '）' +
      ' | missing ' + (okM ? '✓' : '✗') + ' ' + gotMiss + '（期望 ' + c.missing + '）'
    );
  }
  console.log('\n  A 命中：intent ' + hitIntent + '/' + CASES_A.length +
    '，ready ' + hitReady + '/' + CASES_A.length +
    '，missing ' + hitMissing + '/' + CASES_A.length +
    '，平均 ' + Math.round(totalMs / CASES_A.length) + 'ms');

  console.log('\n═══════ 场景 B：经营巡检 ═══════');
  for (const s of STATES_B) {
    const { ms, status, body } = await jev(s.state, B_QUESTIONS);
    if (status !== 200) { console.log('  ✗ HTTP ' + status + ' ' + JSON.stringify(body).slice(0, 200)); continue; }
    const a = body.answers;
    console.log('  【' + s.tag + '】 ' + ms + 'ms   期望：' + s.expect);
    console.log('       worth=' + a.worth.noul.toFixed(3) +
      ' | what=' + a.what.choice + ' (conf ' + a.what.confidence.toFixed(3) + ')' +
      ' | urge=' + a.urge.score.toFixed(2) + ' (conf ' + a.urge.confidence.toFixed(3) + ')');
  }

  console.log('\n═══════ token 用量（算成本用）═══════');
  console.log('  （见每次响应的 usage；下面单独打一次完整响应看结构）');
  const probe = await jev('本月收入 48000 元，支出 39000 元。', { worth: { type: 'noul', instructions: '有值得提醒的异常' } });
  console.log('  ' + JSON.stringify(probe.body).slice(0, 400));
})();
