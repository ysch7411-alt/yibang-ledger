/**
 * 能力注册表
 *
 * 一个能力一个文件，声明「叫什么、什么时候用它、要什么参数、读还是写」。
 * 加新能力 = 加一个文件 —— **不用改提示词、不用改路由**。
 * 能力集从此是可积累的资产，而不是提示词里越堆越乱的浆糊。
 *
 * 🔴 整个 skills 层遵守同一条铁律：
 *    数字一律由代码（SQL）算，summarize() 交出去的是**已经算好的一句话**。
 *    下游的大模型只负责把它说圆，**没有机会自己算**。
 *    因为老板分不清"AI 算错"和"账记错" —— 一次算错，他会连整个账本都不信。
 */
/**
 * 能力注册表 —— 对用户就是「账房四件事」：
 *   查账（q_month / q_debt / q_contact / q_category / q_recent）
 *   报账（nudge_daily）
 *   记账（act_record）
 *   比账（peer_bench）
 * 内部按"问题形状"拆得更细，但**对外只讲这四件** —— 老板记不住、也不需要知道
 * 五种查询的区别，只会觉得"它答得挺全"。
 *
 * 一个能力一个文件，声明「叫什么、什么时候用它、要什么参数、读还是写」。
 * 加新能力 = 加一个文件 —— **不用改提示词、不用改路由**。
 *
 * 🔴 整个 skills 层遵守同一条铁律：
 *    数字一律由代码（SQL）算，summarize() 交出去的是**已经算好的一句话**。
 *    下游的大模型只负责把它说圆，**没有机会自己算**。
 *    因为老板分不清"AI 算错"和"账记错" —— 一次算错，他会连整个账本都不信。
 */
const log = require('../log');
const SKILLS = [
  // —— 查账 ——
  require('./q-month'),      // 某月收支汇总（含环比）
  require('./q-debt'),       // 谁欠我最多 / 我欠谁（往来排行）
  require('./q-contact'),    // 某一个对象的欠款与往来
  require('./q-category'),   // 某月钱花在哪（按品类）
  require('./q-recent'),     // 最近记了哪些账
  // —— 报账 ——
  require('./nudge-daily'),  // 每日经营早报（主动说一件事）
  // —— 记账 ——
  require('./act-record'),   // 对话即入账（**写操作**，可撤销）
  // —— 比账 ——
  require('./peer-bench')    // 跟同行比（样本不足时诚实说比不了）
];

/**
 * 给决策层用：只有"叫什么、什么时候用、要什么参数、读还是写"。
 * 故意**不暴露实现** —— 决策层不需要也不应该知道 SQL 长什么样。
 * ⚠️ 这里的内容会发给决策模型（Jev 在美国），所以**只能放聚合描述、不能放客户姓名**。
 *
 * @param {string} [excludeRisk] 排除某一类能力。路由时传 'write' 把写操作挡在外面 ——
 *   写操作**不参与"该用哪个能力"的竞猜**，它只由 intent 判断（"这是在报账吗"）触发。
 *   理由：让模型在"回答问题"和"改动账本"之间做选择，选错的代价不对称 ——
 *   答错一句只是不准，写错一笔是数据脏了。**别把它交给概率。**
 */
function schema(excludeRisk) {
  return SKILLS
    .filter((s) => !excludeRisk || s.risk !== excludeRisk)
    .map((s) => ({
      name: s.name,
      when: s.when,
      params: Object.keys(s.params || {}),
      risk: s.risk
    }));
}

function byName(name) {
  return SKILLS.find((s) => s.name === name) || null;
}

/**
 * 执行一个能力。
 * 返回的 text 是**已经算好的一句话**，调用方只能拿它去说人话，不要再做计算。
 *
 * usable=false 表示"能力跑了、但这次的数据不足以回答这个问题"，
 * 调用方应该**退回原来的路子**而不是拿它当答案。
 * 例：q_contact 没听出老板要查谁 —— 这时候回答"没听出要查谁"是把问题答丢了；
 * 而「谁欠我最多」那种问法本来就该命中 q_debt（见 q-debt.js 的说明）。
 */
async function run(name, userId, params, ctx) {
  const s = byName(name);
  if (!s) return { ok: false, reason: 'no_such_skill', name };
  try {
    const raw = await s.run(userId, params || {}, ctx || {});
    const usable = typeof s.usable === 'function' ? !!s.usable(raw) : true;
    return { ok: true, name: s.name, risk: s.risk, usable, data: raw, text: s.summarize(raw) };
  } catch (err) {
    // 能力执行失败要如实回报，**不许假装成功**（项目铁律）：
    // 失败返回一个假的空数据，页面上看不出区别，但数字是错的
    log.error('[skill] ' + name + ' 执行失败:', err.message);
    return { ok: false, reason: 'run_failed', name, msg: err.message };
  }
}

module.exports = { SKILLS, schema, byName, run };
