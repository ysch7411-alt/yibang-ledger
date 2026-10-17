/**
 * utils/tone.js —— 情绪价值评语
 *
 * 2026-10-15。
 *
 * ── 为什么单独一条 ──
 *   记账工具满地都是，小老板真正缺的不是"再一个表格"，是**被看见**。
 *   一天忙到晚、被欠钱、月底一算白干 —— 这时候一句"这么早就开张，好兆头"
 *   比多一张报表有用。
 *
 * ── 写作规矩（很重要，写歪了就成了油腻的鸡汤）──
 *   1. 不说教、不打鸡血、不喊口号（"加油！""你是最棒的！"一律不用）
 *   2. 只**承认事实 + 承认辛苦**，不评判对错
 *   3. 短。一句话，最多两句。超过 30 字就删
 *   4. 称呼用"你"，不用"您"（老板之间说话没那么客气）
 *   5. 🔴 **该沉默就沉默** —— 认不出场景就返回 null，不硬凑
 *      每次都说话的工具，用户三天就把它静音了
 *
 * ── 纯函数，可在 Node 里单测 ──
 *   见 cloudrun/yibang-api/test/tone.test.js
 *   时间/金额都从参数进来（不读 Date.now），所以测试可复现。
 */

/** 安全取数 */
function num(v, dft) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dft;
}

/**
 * 从候选里稳定挑一条。
 * ⚠️ 不用 Math.random —— 同一场景同一 seed 必须挑同一条，
 *    否则测试没法断言，用户也会觉得"怎么每次都不一样"。
 */
function pick(list, seed) {
  if (!list || !list.length) return null;
  const s = Math.abs(Math.trunc(num(seed, 0)));
  return list[s % list.length];
}

/* ═══════════════ 语料 ═══════════════
 * 每条都过一遍"油腻检测"：像不像人话？会不会让人起鸡皮疙瘩？
 */

const PHRASES = {
  /* 深夜还在记账 —— 先照顾人，再谈账 */
  night: [
    '这个点还在对账，辛苦了。早点睡，明天我帮你盯着。',
    '夜里还在记账的，多半是白天忙得脚不沾地。先歇会儿。'
  ],

  /* 一大早开张 */
  earlyBird: [
    '这么早就开张，好兆头。',
    '早起的这笔，往往是今天最顺的一笔。'
  ],

  /* 连续记账 —— 这是真本事，值得点出来 */
  streak: [
    '连续记了这么多天，你自己可能没感觉 —— 账清的人，心里是有底的。',
    '这份账你一直没断过。年底一翻，全是证据。'
  ],

  /* 大额进账 */
  bigIncome: [
    '这一单顶平时好几单，漂亮。',
    '这种单子不多，记下来，回头看看是从哪儿来的。'
  ],

  /* 今天倒挂 / 亏 */
  loss: [
    '今天支出比进项多。生意有起伏，不用急着解释给自己听。',
    '这天是倒挂的。别慌，我先把能砍的列出来。'
  ],

  /* 挂太久的欠款 */
  oldDebt: [
    '这笔挂得有点久了。钱不难要，难的是开口 —— 我帮你想了句不伤面子的话。',
    '欠着的钱也是你的钱。要不要我拟个催款的话？'
  ],

  /* 今天记了很多笔 */
  busyDay: [
    '今天第好几笔了，节奏稳。',
    '这么密的账，说明今天有生意。挺好。'
  ],

  /* 今天第一笔（且是进项） */
  firstIncome: [
    '今天第一笔就是进项，开门红。',
    '开张了。记下来，这笔算今天的定心丸。'
  ],

  /* 月末 */
  monthEnd: [
    '这个月的账今天收口。翻一翻，比想象中好。',
    '月底了。数字是死的，你这个月扛下来的活是活的。'
  ],

  /* 撤销 / 记错了 —— 别让人有挫败感 */
  undo: [
    '改了过来。账本不是法院，错了就改。',
    '记错了很正常，能改就行。'
  ]
};

/**
 * 挑一条情绪价值评语。
 *
 * @param {object} ctx
 *   kind       'record' | 'query' | 'undo' | 'greeting'  必填
 *   hour       0-23（本地时）
 *   todayCount 今天已记笔数（含刚这笔）
 *   todayNet   今天净额（收入 − 支出）
 *   monthNet   本月净额
 *   amount     刚这笔金额（正数）
 *   type       1/5=进项，2/6=出项
 *   streakDays 连续记账天数
 *   debtDays   最长欠款天数
 *   dayOfMonth 几号
 *   daysInMonth 这个月几天
 *   seed       挑语料的种子（不传就用 todayCount）
 * @returns {{key:string, text:string}|null} 无合适场景返回 null（该沉默就沉默）
 */
function pickTone(ctx) {
  const c = ctx || {};
  const kind = c.kind;
  if (!kind) return null;

  const hour = num(c.hour, -1);
  const todayCount = num(c.todayCount, 0);
  const todayNet = num(c.todayNet, 0);
  const amount = num(c.amount, 0);
  const type = num(c.type, 0);
  const streak = num(c.streakDays, 0);
  const debtDays = num(c.debtDays, 0);
  const day = num(c.dayOfMonth, 0);
  const daysInMonth = num(c.daysInMonth, 0);
  const seed = num(c.seed, todayCount + amount);

  const isIncome = type === 1 || type === 5;

  /* ① 深夜：优先照顾人（不管什么 kind） */
  if (hour >= 0 && hour < 5) {
    return hit('night', seed);
  }

  /* ② 撤销：不要让人有挫败感 */
  if (kind === 'undo') {
    return hit('undo', seed);
  }

  /* ③ 只在"刚记了一笔"和"问候"时说，纯查询不打扰 */
  if (kind !== 'record' && kind !== 'greeting') return null;

  /* ④ 欠款挂太久（record / greeting 都值得提一句） */
  if (debtDays >= 30) {
    return hit('oldDebt', seed);
  }

  /* ⑤ 连续记账 —— 这是真本事 */
  if (streak >= 7) {
    return hit('streak', seed);
  }

  /* ⑥ 月末收口 */
  if (daysInMonth > 0 && day >= daysInMonth) {
    return hit('monthEnd', seed);
  }

  /* ⑦ 早开张（且是进项） */
  if (hour >= 5 && hour < 8 && isIncome) {
    return hit('earlyBird', seed);
  }

  /* ⑧ 倒挂 */
  if (kind === 'record' && todayCount >= 2 && todayNet < 0) {
    return hit('loss', seed);
  }

  /* ⑨ 大额进项 */
  if (isIncome && amount >= 500) {
    return hit('bigIncome', seed);
  }

  /* ⑩ 今天很忙 */
  if (todayCount >= 5) {
    return hit('busyDay', seed);
  }

  /* ⑪ 今天第一笔进项 */
  if (todayCount === 1 && isIncome) {
    return hit('firstIncome', seed);
  }

  /* ⑫ 认不出场景 → **沉默**。不硬凑。 */
  return null;
}

function hit(key, seed) {
  const text = pick(PHRASES[key], seed);
  return text ? { key: key, text: text } : null;
}

/**
 * 要不要真的显示 —— 节流。
 *
 * 情绪价值是"偶尔一句"，不是"每句都来"。
 * 说了就记时间，间隔不够就闭嘴 —— 否则用户三天就把它静音了。
 *
 * @param {object} o
 *   lastAt     上次说的时间戳（ms）；没说过传 0
 *   now        当前时间戳（ms）
 *   minGapMs   最小间隔，默认 3 分钟
 * @returns {boolean}
 */
function shouldSpeak(o) {
  const x = o || {};
  const lastAt = num(x.lastAt, 0);
  const now = num(x.now, 0);
  const gap = num(x.minGapMs, 3 * 60 * 1000);
  if (!lastAt) return true;
  return (now - lastAt) >= gap;
}

module.exports = { pickTone, shouldSpeak, PHRASES };
