/**
 * 决策层 —— 把"该不该做 / 做哪一件 / 该用哪个能力"从提示词里的软约束，
 * 变成代码里一个**可测、可调、可回滚**的判断。
 *
 * 为什么要单独一层：现在 AI 参谋的边界是靠提示词"劝"模型别乱答（软的）。
 * 有了这一层，"这句话是不是在问账""该用哪个能力""要不要打扰老板"
 * 都变成有依据的分支，而不是靠模型自觉。
 *
 * 实现可换：Jev（决策模型）/ 纯规则。**上层不感知** ——
 * Jev 的供应商才成立一年、模型发布一周，**不能把关键路径绑上去**。
 * 所以：没配 key、超时、报错、置信度不够，一律**静默降级到规则**，功能不中断。
 *
 * 🔴 出境红线：Jev 在美国。**state 里只放聚合数字与能力名，绝不放客户姓名。**
 *    巧的是 TypeSafe 自己的建议也是"过滤 state、无关内容会掉准确率"——两个理由同向。
 *
 * 实测结论（2026-09-22，脚本见 _verify/jev-probe*.js）：
 *   · 意图识别 7/7 稳；延迟稳态 250~300ms；约 $0.0000125/次
 *   · 🔴 **noul 的概率不能当"够不够明确"的阈值**：「老王还了三千」只有 0.28、
 *     最明确的一句也只 0.77 —— 按官方建议的 0.9，**一句都触发不了**。
 *     所以这里**一律用 choice + 明确选项**，不拿 noul 当开关。
 *   · 🔴 criteria 的措辞会直接改变答案（同一份数据换个说法就从"不选"变成"高置信选中"）
 *     → 每个选项都要写"什么情况算这一项"的具体情形。
 *   · confidence < 0.5 不采信（TypeSafe 官方建议）。
 */
/* 路由时**排除写操作**：写操作不参与"该用哪个能力"的竞猜，
   只由 intent 判断（"这是在报账吗"）触发。
   理由：让模型在"回答问题"和"改动账本"之间做选择，选错的代价不对称 ——
   答错一句只是不准，写错一笔是数据脏了。别把它交给概率。 */
const SKILL_NAMES = require('./skills').schema('write');
const log = require('./log');

const KEY = process.env.TYPESAFE_API_KEY || '';
const URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_TIMEOUT = 8000;      // 跨境，给宽一点但仍要有界（永不回调是项目栽过的坑）
const MIN_CONF = 0.5;          // 低于它就不采信，转规则
const MIN_CONF_SKILL = 0.6;    // 选能力要求更高：选错能力 = 给出一个错维度的答案

/** 有没有配决策模型。没配也能跑（走规则），只是判断粗一些 */
function available() {
  return !!KEY;
}

/**
 * 调 Jev。**必须带超时** —— 项目里栽过"等一个永不回调的 Promise"的坑
 * （wx/网络层在异常时既不成功也不失败），任何 await 都要有兜底时钟。
 */
async function callJev(state, questions) {
  if (!KEY) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), JEV_TIMEOUT);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
      signal: ac.signal
    });
    if (!res.ok) {
      log.warn('[decide] Jev HTTP ' + res.status + '，降级到规则');
      return null;
    }
    const body = await res.json();
    return body && body.answers ? body.answers : null;
  } catch (err) {
    // 超时/断网/格式异常都算"决策模型不可用"，不是业务错误 —— 静默降级
    log.warn('[decide] Jev 不可用（' + (err.name === 'AbortError' ? '超时' : err.message) + '），降级到规则');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════ 意图：这句话想干什么 ═══════════════ */

const RECORD_KW = /(花了|花了多少|买了|买了多少|付了|收了|收到|还了|进货|收了多少|赚了|支出|收入|记账|记一下|报销)/;
const QUERY_KW = /(多少|几笔|哪项|哪几天|谁欠|欠我|欠他|总共|一共|合计|结余|剩多少|怎么样|对比|上个月|这个月)/;
// 问"判断/提醒"的问法：对应 报账 与 比账 两件事（同 lib/decide.js 里 advice 的说明）
const ADVICE_KW = /(要注意|注意什么|有没有异常|正常吗|算高|算不算高|高不高|偏高|比同行|跟同行|别人家|我的成本|该担心|有问题吗)/;

function intentByRule(q) {
  // 先判"是不是在报账"：报账的话里往往也有"多少"（"买菜花了多少"其实是问句）
  if (/[?？]|多少|几笔|谁欠|怎么样|对比/.test(q) && !/(记一下|帮我记|记一笔)/.test(q)) {
    if (ADVICE_KW.test(q)) return 'advice';
    return QUERY_KW.test(q) ? 'query' : 'other';
  }
  if (RECORD_KW.test(q)) return 'record';
  if (ADVICE_KW.test(q)) return 'advice';
  if (QUERY_KW.test(q)) return 'query';
  return 'other';
}

/**
 * 判断这句话的意图。
 * ⚠️ 实测这一项 Jev 7/7 全对（含把「今天天气不错」判成 other），所以优先用它；
 *    拿不准就退回规则。**永不抛异常** —— 决策层坏掉不该让整个问答挂掉。
 *
 * ⚠️ 2026-09-22 加了第 4 类 `advice`：「今天有什么要注意的吗」原来被判成 other
 *    然后直接婉拒 —— **不是模型笨，是我的选项里没有这一类**。
 *    老板有两类问法形状不同：一类问**具体数字**（多少、几次、谁欠我），
 *    一类问**判断**（有没有要注意的、我这算不算高）。后者对应"报账 / 比账"两件事，
 *    必须单独给一个选项，否则它只会被归到"跟账无关"里去。
 */
async function intent(question) {
  const q = String(question || '').trim();
  const fallback = { value: intentByRule(q), confidence: 0, source: 'rule' };
  if (!q || !KEY) return fallback;

  const answers = await callJev(
    '老板刚说的一句话：「' + q.slice(0, 120) + '」',
    {
      intent: {
        type: 'choice',
        instructions: '这句话想干什么',
        criteria: {
          record: '在报一笔账（说某笔收入/支出/收付款，要记进账本）',
          query: '在问账上的具体数字（多少钱、几次、谁欠我、某段时间怎么样）',
          advice: '在问经营上的判断或提醒 —— 有没有要注意的事、最近有没有异常、我这算不算高',
          other: '既不是记账也不是问账（闲聊、跟账目无关的事、问别的领域）'
        }
      }
    }
  );
  if (!answers || !answers.intent) return fallback;
  const a = answers.intent;
  if ((a.confidence || 0) < MIN_CONF) return fallback;
  return { value: a.choice, confidence: a.confidence, source: 'jev' };
}

/* ═══════════════ 选能力：该用哪个 skill ═══════════════ */

/**
 * 规则兜底版的能力选择（仅在决策模型不可用时使用）。
 * ⚠️ 这是**降级路径**，故意写得保守：判不出来就返回 null，让后面那条老路接管，
 *    宁可少答一句，也不要选错能力给出一个错维度的答案。
 */
function skillByRule(q) {
  // "问判断"的两件事先判：它们问的不是某个数字
  if (/(比同行|跟同行|别人家|算高|算不算高|高不高|偏高|我的成本)/.test(q)) return 'peer_bench';
  if (/(要注意|注意什么|有没有异常|正常吗|该担心|最近怎么样)/.test(q)) return 'nudge_daily';
  // 排行类问法必须**先判**：它问的是"有哪些人"，不是某一个对象。
  // 被 q_contact 先接走的话，会得到一句"没听出要查谁"，把一个能答的问题答丢。
  if (/(谁欠我|谁欠钱|欠我最多|都欠我|有哪些人欠|欠款排行|我欠谁|我欠别人的)/.test(q)) return 'q_debt';
  if (/(花在哪|哪项支出|哪一项|开销最大|支出结构|成本结构)/.test(q)) return 'q_category';
  if (/(最近记|最近几笔|昨天记|今天记|记了哪些|记了啥)/.test(q)) return 'q_recent';
  // 只有出现"具体某个对象"的语感时才走 q_contact（名字由 params 在本地匹配补上）
  if (/(还欠|总共给了|一共给了|给了我多少|欠了多久)/.test(q)) return 'q_contact';
  if (/(赚了|结余|收入|支出|这个月|上个月|花了多少|收了多少)/.test(q)) return 'q_month';
  return null;
}

/**
 * 从问题里挑一个能力。
 * state 里只有老板这句话 + 能力清单 —— **不放任何客户姓名**（出境红线）。
 */
async function pickSkill(question) {
  const q = String(question || '').trim();
  const fallback = { name: skillByRule(q), confidence: 0, source: 'rule' };
  if (!q || !KEY) return fallback;

  // 选项用能力的 when 描述（都是聚合描述，不含具体客户名）
  const criteria = { none: '这些能力都不合适，回答不了这个问题' };
  SKILL_NAMES.forEach((s, i) => { criteria['s' + i] = s.when; });

  const answers = await callJev(
    '老板问账本上的一句话：「' + q.slice(0, 120) + '」',
    {
      skill: { type: 'choice', instructions: '该用下面哪个能力来查，才能回答他', criteria }
    }
  );
  if (!answers || !answers.skill) return fallback;
  const a = answers.skill;
  if ((a.confidence || 0) < MIN_CONF_SKILL) return fallback;

  if (a.choice === 'none') return { name: null, confidence: a.confidence, source: 'jev' };
  const idx = Number(String(a.choice).slice(1));
  const hit = SKILL_NAMES[idx];
  if (!hit) return fallback;
  return { name: hit.name, confidence: a.confidence, source: 'jev' };
}

/* ═══════════════ 巡检：今天要不要打扰老板 ═══════════════ */

/**
 * 判断"有没有值得主动提醒老板的事"。
 * state **只放聚合数字，不放客户姓名** —— 出境红线；也正好符合"过滤 state"的建议。
 * 单列出来的 overdueDays 是"最长的欠款挂了几天"，用它和该店平时的回款周期比。
 */
async function shouldNudge(state) {
  if (!KEY) return { push: false, source: 'rule', reason: 'no-key' };
  const answers = await callJev(state, {
    worth: {
      type: 'choice',
      instructions: '今天有没有值得主动提醒老板的事',
      criteria: {
        overdue: '有欠款拖得明显比这家店平时的回款周期久',
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
  });
  if (!answers || !answers.worth) return { push: false, source: 'rule', reason: 'jev-unavailable' };
  const w = answers.worth;
  const u = answers.urge || {};
  // 两个条件都要：有话说 + 有把握。置信度不够就宁可不说（对老板来说"没事"是更好的答案）
  const push = w.choice !== 'none' && (w.confidence || 0) >= 0.6;
  return {
    push,
    what: w.choice,
    whatConf: w.confidence,
    urge: typeof u.score === 'number' ? u.score : null,
    urgeConf: u.confidence,
    source: 'jev'
  };
}

module.exports = { available, intent, pickSkill, shouldNudge, MIN_CONF, MIN_CONF_SKILL };
