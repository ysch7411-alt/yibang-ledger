/**
 * 能力参数抽取 —— 从老板那句中文里，抽出每个能力需要的参数
 *
 * 为什么要在**本地**做这件事，而不是再调一次模型：
 *   🔴 出境红线。把"客户名单 + 老板的问题"发给在美国的决策模型，
 *      等于把第三方姓名送出境；而这一步用本地匹配完全能做。
 *      （顺带也省一次调用 —— 本地匹配是 0 延迟、0 成本。）
 *
 * 这里只做**确定性**的解析：能抽到就抽到，抽不到就返回 undefined，
 * 让能力自己按"参数缺失"处理。**绝不猜** —— 猜错一个客户名比不答更糟。
 */

/** 「YYYY-MM」直接用；「这个月/本月」→ 当前月；「上个月/上月」→ 上个月；「X月」→ 今年 X 月 */
function pickMonth(q, now = new Date()) {
  const p2 = (x) => String(x).padStart(2, '0');
  const ym = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1);

  const explicit = /(\d{4})-(\d{1,2})/.exec(q);
  if (explicit) {
    const m = Number(explicit[2]);
    if (m >= 1 && m <= 12) return explicit[1] + '-' + p2(m);
  }
  if (/(上上个月|前个月)/.test(q)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return ym(d);
  }
  if (/(上个月|上月)/.test(q)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return ym(d);
  }
  const m = /(\d{1,2})\s*月/.exec(q);
  if (m) {
    const n = Number(m[1]);
    // 「几月」这种占位说法不算；1~12 之外不算
    if (n >= 1 && n <= 12) {
      // 只给月份时**默认今年**。跨年（现在是 1 月却问 12 月）属于少数，
      // 真遇到时让模型在回答里说明"按今年 X 月算的"，比这里瞎猜强。
      return now.getFullYear() + '-' + p2(n);
    }
  }
  if (/(这个月|本月|当月)/.test(q)) return ym(now);
  return undefined;   // 没提时间 → 交给能力自己按默认（本月）处理
}

/**
 * 从问题里找出他指的是哪个往来对象。
 * 做法：拿**他账本里真实存在的名字**去问题里找，命中取**最长的那个**
 * （"青岛华博" 和 "华博" 同时命中时要选长的，否则会错配到另一个客户）。
 */
function pickContactName(q, names = []) {
  let hit = '';
  for (const n of names) {
    if (!n) continue;
    if (q.indexOf(n) >= 0 && n.length > hit.length) hit = n;
  }
  return hit || undefined;
}

/** 「最近 5 笔」「3笔」→ 5 / 3；没提就 undefined */
function pickLimit(q) {
  const m = /(\d{1,2})\s*笔/.exec(q);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) return n;
  }
  return undefined;
}

/** "我欠谁/我该付谁" → owe；默认 owed（谁欠我） */
function pickDebtDirection(q) {
  return /(我欠|我还欠|欠别人|该付|应付给|我要付)/.test(q) ? 'owe' : 'owed';
}

/**
 * 按能力名抽参数。
 * @param {string} q      老板的问题
 * @param {string} skill  能力名
 * @param {object} bag    { contactNames: [...] } 调用方查好传进来
 */
function extract(q, skill, bag = {}) {
  const s = String(q || '');
  if (skill === 'q_month' || skill === 'q_category') {
    return { month: pickMonth(s) };
  }
  if (skill === 'q_contact') {
    return { name: pickContactName(s, bag.contactNames || []) };
  }
  if (skill === 'q_recent') {
    return { limit: pickLimit(s) };
  }
  if (skill === 'q_debt') {
    return { direction: pickDebtDirection(s) };
  }
  return {};
}

module.exports = { extract, pickMonth, pickContactName, pickLimit, pickDebtDirection };
