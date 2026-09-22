/**
 * _verify/jev-probe2.js —— 验证第一轮暴露的两个问题，并检验修法
 *
 * 第一轮（jev-probe.js）的实测结论：
 *   · intent（意图识别）7/7 全对 —— 包括把「今天天气不错」判成 other
 *   · 但 **`noul` 概率不能直接当"够明确"的阈值用**：
 *     「老王还了三千」ready 只有 0.280，最明确的「帮我记一下昨天进货 3500 给张老板」也只有 0.770
 *     —— 按 TypeSafe 建议的 0.9 阈值，**一句都触发不了**。
 *   · 富数据巡检时 `urge` 的 confidence 只有 **0.24**（<0.5 = 官方说不能单独采信）
 *
 * 两个假设，这一轮分别验：
 *   【假设 1】`noul` 问"够不够明确"太主观 → 改问 `choice`"最缺哪一样（含 none）"，
 *             靠选项而不是概率来表达"可以入账"。
 *   【假设 2】它判断不了"47 天算不算久"，是因为**我们没给基准** →
 *             给它该商户自己的平均回款周期，看它会不会改判 overdue。
 *
 * 密钥只从环境变量读，不落盘、不回显。
 * 用法：TYPESAFE_API_KEY=xxx node _verify/jev-probe2.js
 */
const KEY = process.env.TYPESAFE_API_KEY || '';
const URL = 'https://api.typesafe.ai/v1/systemone';
if (!KEY) { console.log('缺少 TYPESAFE_API_KEY'); process.exit(1); }
console.log('密钥核对：尾 4 位 = ' + KEY.slice(-4) + '\n');

async function jev(state, questions) {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions })
  });
  return { ms: Date.now() - t0, status: res.status, body: await res.json() };
}

const CONTACTS = '张老板、李四、王五、青岛华博商贸有限公司';

/* 复测样本：前两句是"应该能直接入账"的，后两句是"确实缺东西"的 */
const CASES = [
  { q: '老王还了三千', wantNone: true },
  { q: '帮我记一下昨天进货 3500 给张老板', wantNone: true },
  { q: '今天买菜花了一百二', wantNone: true },
  { q: '老王那笔钱到了', wantNone: false, miss: 'amount' },
  { q: '还了三千', wantNone: false, miss: 'who' }
];

(async () => {
  console.log('═══════ 假设 1：把"够不够明确"从 noul 改成 choice（带 none 选项）═══════');
  let ok = 0;
  for (const c of CASES) {
    const state = '老板刚说的一句话：「' + c.q + '」。他账本里的往来对象有：' + CONTACTS + '。今天是 2026-09-22。';
    const { ms, status, body } = await jev(state, {
      // 关键改法：不用概率表达"够不够"，而是让它**指认最缺的那一样**，有 "none" 兜底
      // （TypeSafe 官方建议：选项列表可能覆盖不全时，一定要加一个兜底项）
      missing: {
        type: 'choice',
        instructions: '这句话要记成一笔账，还缺哪一样信息？缺什么都不缺就直接选 none',
        criteria: {
          none: '什么都不缺，信息齐全，可以直接记账',
          amount: '缺金额',
          who: '缺往来对象（不知道跟谁）',
          type: '缺类型（不知道是收还是付、收入还是支出）'
        }
      },
      intent: {
        type: 'choice',
        instructions: '这句话想干什么',
        criteria: { record: '在报一笔账', query: '在问账上的事', other: '都不是' }
      }
    });
    if (status !== 200) { console.log('  ✗ HTTP ' + status); continue; }
    const m = body.answers.missing;
    const got = m.choice;
    const pass = c.wantNone ? (got === 'none') : (got === c.miss);
    if (pass) ok++;
    console.log((pass ? '  ✅ ' : '  ❌ ') + '「' + c.q + '」 ' + ms + 'ms → missing=' + got +
      ' (conf ' + m.confidence.toFixed(3) + ', 概率 ' + JSON.stringify(m.probabilities) + ')' +
      '  期望 ' + (c.wantNone ? 'none' : c.miss));
  }
  console.log('\n  假设 1 命中：' + ok + '/' + CASES.length);

  console.log('\n═══════ 假设 2：给它"该店自己的平均回款周期"后，它会改判 overdue 吗 ═══════');
  const Q = {
    what: {
      type: 'choice',
      instructions: '最值得今天提醒老板的是哪件事',
      criteria: {
        overdue: '有欠款拖得明显比这家店平时的回款周期久',
        cost: '某项支出比平时高得异常',
        none: '没有值得打扰老板的'
      }
    }
  };
  const base =
    '未收欠款 4 笔共 18600 元，其中张老板 9000 元已挂 47 天、李四 6000 元挂了 12 天、王五 3600 元挂了 5 天；' +
    '本月食材支出 26000 元，上月 16000 元；';

  for (const [tag, extra] of [
    ['不给基准（不知道平时多久回款）', ''],
    ['给基准（这家店平时回款约 20 天）', '这家店平时的回款周期大约是 20 天；'],
    ['给基准 + 只有一笔异常', '这家店平时的回款周期大约是 20 天。另外本月食材支出和上月基本持平；']
  ]) {
    const { ms, body, status } = await jev(base + extra, Q);
    if (status !== 200) { console.log('  ✗ HTTP ' + status); continue; }
    const w = body.answers.what;
    console.log('  【' + tag + '】 ' + ms + 'ms → what=' + w.choice +
      ' (conf ' + w.confidence.toFixed(3) + ')' +
      '  概率 ' + JSON.stringify(w.probabilities));
  }
})();
