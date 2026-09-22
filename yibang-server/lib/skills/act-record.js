/**
 * 能力：对话即入账 —— 老板说一句，直接记进账本
 *
 * 🔴 这是**写操作**，纪律和只读能力完全不同，三条都要守住：
 *
 * ① **走和记账页完全相同的接口**，不把逻辑复制过来。
 *    `/record/ai-parse` 里有一整套：商家词表归一（「张哥」→「张老板」）、
 *    金额"单价当总额"的兜底验算、品类清洗、以及 `/record/create` 的**最近记录去重**。
 *    重写一套必然漂移 —— 这个项目已经因为"一个东西抄几份"栽过好几次
 *    （`.f-input` 抄了 4 份、漂移后漏写 height 把文字裁掉；分享的 api.safe 包法抄漏两处）。
 *    所以这里用**内部回环调用**复用，多一次本机 HTTP（约 1ms），换"永不漂移"。
 *
 * ② **必须可撤销**。产品既定原则是"先入账 + 结果条 + 可改/可撤销"，
 *    而**自动入账正是最需要撤销兜底的场景** —— 所以返回里带上新记录的 id，
 *    前端在卡片上给一个「记错了，撤销」按钮。
 *    （`/record/delete` 就是撤销接口，注释里写着"零表单录入的撤销"。）
 *
 * ③ **一笔都没记成时如实回报**（usable=false 让调用方退回老路），不许假装成功。
 */
const PORT = process.env.PORT || 3000;
const BASE = 'http://127.0.0.1:' + PORT + '/api';

async function post(path, body, token) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token || '' },
    body: JSON.stringify(body || {})
    // ⚠️ 不设 timeout：这是**本机回环**，不是外部服务。
    //    但它内部会去调大模型（ai-parse 走 qwen），所以要等它 ——
    //    调用方（routes/ai.js）那一层已经有 45 秒的模型超时兜着。
  });
  return await res.json();
}

module.exports = {
  name: 'act_record',
  when: '老板在报一笔账 —— 说某笔收入、支出、收款、付款、进货、花销，' +
    '要把它记进账本。**不是**在问账上的数。',
  params: {
    text: { type: 'string', desc: '老板的原话，照抄，不要改写' }
  },
  risk: 'write',

  async run(userId, p, ctx = {}) {
    const text = String(p.text || '').trim();
    if (!text) return { created: [], reason: 'empty' };

    // 复用记账页那套解析（含词表归一 + 金额兜底 + 品类清洗）
    const parsed = await post('/record/ai-parse', { text }, ctx.token);
    if (!parsed || parsed.code !== 0) {
      return { created: [], reason: 'parse_failed', msg: (parsed && parsed.msg) || '' };
    }
    const recs = (parsed.data && parsed.data.records) || [];
    if (!recs.length) return { created: [], reason: 'no_amount' };

    const created = [];
    for (const r of recs) {
      const res = await post('/record/create', {
        type: r.type,
        amount: r.amount,
        content: r.content,
        contact_name: r.contact,
        record_date: r.date,
        qty: r.qty,
        unit: r.unit,
        unit_price: r.unitPrice,
        pay_method: r.method,
        category: r.category
      }, ctx.token);
      if (res && res.code === 0 && res.data && res.data.id) {
        created.push({ id: res.data.id, type: r.type, amount: r.amount, contact: r.contact, content: r.content, date: r.date });
      }
    }
    return { created, tried: recs.length };
  },

  /** 一笔都没记成 → 调用方退回老路（通常老路会给出"这句我算不出金额"之类的解释） */
  usable(r) {
    return !!(r.created && r.created.length);
  },

  summarize(r) {
    if (!r.created || !r.created.length) return '这句我没能算出一笔账来。';
    const one = r.created.length === 1;
    const lines = r.created.map((x) =>
      x.date + ' ' + x.type + ' ¥' + Number(x.amount).toFixed(2) +
      (x.contact ? '（' + x.contact + '）' : '') + (x.content ? ' ' + x.content : '')
    );
    return '已经' + (one ? '记好了 1 笔' : '记好了 ' + r.created.length + ' 笔') + '：' + lines.join('；') + '。';
  }
};
