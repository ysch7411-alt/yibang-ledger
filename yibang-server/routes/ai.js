const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const { resolveUpload, detectKind, toDataUri, callModel, extractJson } = require('../lib/ledger');
const { aiLimit, bumpCount } = require('../lib/rate-limit');
const cache = require('../lib/cache');
const decide = require('../lib/decide');
const skills = require('../lib/skills');
const skillParams = require('../lib/skills/params');
const log = require('../lib/log');

/**
 * 直接构造一张卡片（不走大模型）。
 * 用于"这句话我不用想就知道怎么答"的场景：跟账无关的闲聊、请求记账、记账结果。
 * 形状必须和 toCard() 产出的一致，前端才能用同一条渲染分支。
 * @param {object} [extra] 额外字段。目前用于 `undo: [id...]` —— 写了库就必须给撤销入口。
 */
function cardPayload(summary, points, numbers, extra) {
  const obj = Object.assign(
    { summary: summary, numbers: numbers || [], points: points || [] },
    extra || {}
  );
  return { answer: JSON.stringify(obj), card: obj };
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.json({ code: 401, msg: '未登录' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.json({ code: 401, msg: 'token无效' });
  }
}

// 实测：这两个模型在专属 MaaS 网关上可用；qwen-audio-3.0-asr-flash / fun-asr-flash 返回空。
const ASR_MODEL = 'qwen3-asr-flash-2026-02-10';

/**
 * 语音转文字。
 * 上传目录不对外暴露，所以直接读本地文件转 data URI —— 必须带 data: 前缀，
 * 纯 base64 会被网关判为「URL 不合法」。
 */
router.post('/asr', auth, aiLimit('voice'), async (req, res) => {
  const { fileUrl } = req.body;
  const filePath = resolveUpload(fileUrl);
  if (!filePath) return res.json({ code: 400, msg: '文件不存在或路径不合法' });

  const { kind, format } = detectKind(filePath);
  if (kind !== 'audio') return res.json({ code: 400, msg: '不是音频文件' });

  try {
    const dataUri = await toDataUri(filePath, format, 'audio');
    const text = await callModel({
      model: ASR_MODEL,
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: dataUri, format } }]
      }]
    }, 120000);

    bumpCount(req);
    res.json({ code: 0, data: { text: String(text || '').trim() } });
  } catch (err) {
    log.error('ASR 错误:', err.response?.data || err.message);
    res.json({ code: 500, msg: '语音识别失败' });
  }
});

/* POST /ai/ocr-parse 已删除（2026-09-19 审计）。
   它是「图片取文 → 再结构化」的两步老路，早被 /purchase/parse-doc 的
   「视觉模型一次出结构化结果」取代（实测后者更准：OCR 系列把 2.5 读成 2.6）。
   没人调用它，但它连着 AI 网关 —— 留着等于开了一个能被误调、要花钱的口子。
   顺带说明：purchase.js 里也有一个 OCR_MODEL，那个**还在用**（快路失败时的兜底），别一起删。 */

/**
 * 图片内容读出 —— 给「AI 生意参谋」用（2026-09-20 新增）。
 *
 * 为什么不复用 /purchase/parse-doc：那个是**采购专用**的，视觉模型直接出
 * 结构化单据（品名/数量/单价），prompt 写死了"这是一张采购/送货单据"。
 * 而老板拍给参谋看的可能是手写账本、微信收款截图、货架照片、合同片段，
 * 硬套采购 prompt 会得到一堆没意义的字段。
 *
 * 所以这里只做一件事：**把图里的内容尽量读出来**，交给 /ai/chat 去结合账目回答。
 * 模型选 qwen3.5-ocr：实测的结论是「专用 OCR 逐字读还行」
 * （做结构化才不如通用视觉模型，但这里不需要结构化）。
 */
router.post('/vision', auth, aiLimit('vision'), async (req, res) => {
  const { fileUrl } = req.body || {};
  const filePath = resolveUpload(fileUrl);
  if (!filePath) return res.json({ code: 400, msg: '文件不存在或路径不合法' });

  const { kind, format } = detectKind(filePath);
  if (kind !== 'image') return res.json({ code: 400, msg: '不是图片文件' });

  try {
    const text = await callModel({
      model: 'qwen3.5-ocr',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: await toDataUri(filePath, format, 'image') } },
          {
            type: 'text',
            text: '把这张图里的文字和内容尽量完整地读出来。只说你看到了什么，不要解释、不要编造；' +
              '看不清或图里没有字，就直接说"看不清"。' +
              '**不要用 LaTeX、数学公式或 \\displaylines 之类的标记包裹文字**，原样输出看到的内容。'
          }
        ]
      }]
    }, 120000);

    bumpCount(req);
    res.json({ code: 0, data: { text: String(text || '').trim() } });
  } catch (err) {
    log.error('读图错误:', err.response?.data || err.message);
    res.json({ code: 500, msg: '图片识别失败' });
  }
});

/**
 * AI 生意参谋问答。
 * 先把用户自己的账目数据查出来塞进上下文，再让模型基于真实数据回答，
 * 而不是让它凭空编。
 */
router.post('/chat', auth, aiLimit('chat'), async (req, res) => {
  const { question, history } = req.body || {};
  const q = String(question || '').trim();
  if (!q) return res.json({ code: 400, msg: '缺少问题' });
  // 转发给能力层：记账那一路要回环调 /record/* 复用记账页的逻辑，需要原样的鉴权头
  const token = req.headers.authorization || '';

  try {
    // 先查缓存：相同问题直接返回结果
    const cacheKey = 'ai-chat:' + req.userId + ':' + q;
    const cached = cache.get(cacheKey);
    if (cached) {
      bumpCount(req);
      return res.json({ code: 0, data: cached });
    }

    /* ═══════ 决策层（2026-09-22 加）═══════
       在做任何昂贵的事之前，先做两个便宜的判断：
       ① 这句话跟账有关吗 —— 无关就直接婉拒，**完全不调大模型**（成本闸门）；
       ② 该用哪个能力 —— 命中就让 skill 去查（**数字由代码算**），
          答不上的才退回原来那套"把 ctx 塞给模型"的老路。
       决策模型（Jev）不可用 / 超时 / 置信度不够时**全部静默降级**，功能不中断。 */
    const it = await decide.intent(q);

    if (it.value === 'other') {
      // 闲聊不值钱，不值得花大模型的调用费 —— 这是最直接的一道成本闸门
      bumpCount(req);
      const data = cardPayload('这个我答不了', [
        '我只看得懂你店里的账，别的我不懂',
        '可以问：本月结余多少 / 谁欠我钱 / 哪项支出最大'
      ]);
      cache.set(cacheKey, data, 3600);
      return res.json({ code: 0, data });
    }

    if (it.value === 'record') {
      /* 记账（**写操作**）。三道保险缺一不可：
         ① 只在 intent 明确判成"在报账"时才走这里 —— 写操作**不参与**"该用哪个能力"的竞猜，
            不让模型在"答问题"和"改账本"之间做选择（选错代价不对称：答错只是不准，写错是数据脏了）；
         ② act_record 内部走的是和记账页**完全相同**的接口（含商家词表归一、金额兜底验算、
            最近记录去重），不是重写一套；
         ③ 卡片里带上新记录的 id → 前端给「记错了，撤销」。
            **自动入账是最需要撤销兜底的场景**，这是产品既定原则。 */
      const r = await skills.run('act_record', req.userId, { text: q }, { token });
      bumpCount(req);

      if (r.ok && r.usable) {
        const ids = r.data.created.map((x) => x.id);
        const numbers = r.data.created.map((x) => ({ label: x.type, value: '¥' + Number(x.amount).toFixed(2) }));
        const data = cardPayload('已经记好了', [r.text], numbers, { undo: ids });
        // ⚠️ 写操作的结果**不进缓存**：撤销之后再问一次，必须反映的是现状而不是刚才那次
        return res.json({ code: 0, data });
      }

      // 没算出一笔账 → 如实说，并给条能走通的路（**不假装记上了**）
      const data = cardPayload('这句我没能算出一笔账', [
        '多半是没听清金额 —— 补一句「多少钱」就行',
        '也可以到「记账」页说，那边可以边说边改'
      ]);
      cache.set(cacheKey, data, 3600);
      return res.json({ code: 0, data });
    }

    // 是问账 → 先看有没有现成的能力能查
    let skillText = '';
    let skillUsed = '';
    const pick = await decide.pickSkill(q);
    if (pick.name) {
      const bag = {};
      if (pick.name === 'q_contact') {
        // 📍客户名单**只在本地匹配**，绝不发给任何外部模型（数据出境红线）
        const [cs] = await pool.query('SELECT name FROM contacts WHERE user_id = ?', [req.userId]);
        bag.contactNames = cs.map((x) => x.name);
      }
      const params = skillParams.extract(q, pick.name, bag);
      const r = await skills.run(pick.name, req.userId, params, { token });
      // usable=false 表示"能力跑了、但这次的数据不足以回答"（如 q_contact 没听出是谁）——
      // 这种情况**退回原来的老路**，别拿它当答案把问题答丢
      if (r.ok && r.usable !== false) {
        skillText = r.text;          // ← 已经算好的一句话，模型只负责说圆
        skillUsed = r.name;
        log.info('[ai] 用能力回答:', r.name, JSON.stringify(params), 'decide=' + pick.source);
      }
    }

    const [monthRows] = await pool.query(
      'SELECT COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) AS income, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) AS expense ' +
      'FROM transactions WHERE user_id = ? AND status = 1 AND DATE_FORMAT(record_date, "%Y-%m") = DATE_FORMAT(NOW(), "%Y-%m")',
      [req.userId]
    );
    const [debtRows] = await pool.query(
      'SELECT name, balance FROM contacts WHERE user_id = ? AND balance > 0 ORDER BY balance DESC LIMIT 5',
      [req.userId]
    );
    const [oweRows] = await pool.query(
      'SELECT name, balance FROM contacts WHERE user_id = ? AND balance < 0 ORDER BY balance ASC LIMIT 5',
      [req.userId]
    );
    // 上月汇总：老板问"那上月呢"时手边就得有答案。
    // 2026-09-20 补 —— 第一次只加了会话上下文，AI 知道"上月"指的是什么了，
    // 却只能回"没提供上月数据"：上下文解决的是"代词有着落"，数据才是答案本身。
    const [lastMonthRows] = await pool.query(
      'SELECT COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) AS income, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) AS expense ' +
      'FROM transactions WHERE user_id = ? AND status = 1 AND record_date >= DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH), \'%Y-%m-01\') AND record_date < DATE_FORMAT(NOW(), \'%Y-%m-01\')',
      [req.userId]
    );

    const [lastRows] = await pool.query(
      'SELECT t.type, t.amount, t.content, t.record_date, c.name AS contact_name ' +
      'FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id ' +
      'WHERE t.user_id = ? AND t.status = 1 ORDER BY t.record_date DESC, t.id DESC LIMIT 20',
      [req.userId]
    );

    const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };
    const income = Number(monthRows[0].income);
    const expense = Number(monthRows[0].expense);
    const lastIncome = Number(lastMonthRows[0].income);
    const lastExpense = Number(lastMonthRows[0].expense);

    const ctx = [
      '【本月】收入 ' + income.toFixed(2) + ' 元，支出 ' + expense.toFixed(2) + ' 元，结余 ' + (income - expense).toFixed(2) + ' 元。',
      '【上月】收入 ' + lastIncome.toFixed(2) + ' 元，支出 ' + lastExpense.toFixed(2) + ' 元，结余 ' + (lastIncome - lastExpense).toFixed(2) + ' 元。',
      '【别人欠我】' + (debtRows.length ? debtRows.map((r) => r.name + ' ' + Number(r.balance).toFixed(2) + ' 元').join('；') : '暂无'),
      '【我欠别人】' + (oweRows.length ? oweRows.map((r) => r.name + ' ' + Math.abs(Number(r.balance)).toFixed(2) + ' 元').join('；') : '暂无'),
      '【最近 20 笔】' + (lastRows.length
        ? lastRows.map((r) => r.record_date + ' ' + (TYPE_TEXT[r.type] || '支出') + ' ' + Number(r.amount).toFixed(2) + ' 元' + (r.contact_name ? '（' + r.contact_name + '）' : '') + (r.content ? ' ' + r.content : '')).join('；')
        : '暂无记录')
    ].join('\n');

    /**
     * 会话上下文（2026-09-20 补）
     *
     * 之前每次问都是「system + 当前这一句」，AI 完全不记得上一句 ——
     * 老板问完「这个月赚了多少」，接着问「**那上月呢**」，它不知道"那"指什么，
     * 只会再答一遍本月。这是"AI 不懂我"最直接的一种来源。
     *
     * 只带最近 3 轮（6 条）：真正需要的事实（本月汇总、欠款、最近 20 笔）
     * 已经在上面的 ctx 里给全了，历史对话只是让代词有着落。
     * 带太多反而会挤占上下文、也让模型更容易顺着旧话跑偏。
     */
    const prior = Array.isArray(history) ? history.slice(-6) : [];
    // 2026-09-20：从"一段话"改成"结构化卡片"。
    // 用户原话：「解析的文字和回复的文字没有排版，乱七八糟」——
    // 七八行密集文字挤在一个灰气泡里，老板找不到数字在哪。
    // 所以让模型直接给结构（结论 / 关键数字 / 要点），前端渲染成卡片。
    // 模型不按格式返回时下面会降级成纯文本，不影响能用。
    /**
     * 系统提示词（2026-09-22 加"边界与婉拒"）。
     *
     * 原来只有一句"只根据下面提供的账目数据回答，不要编造数据"——
     * 太弱了：模型遇到"今天天气怎么样""帮我写首诗"依然会硬答，
     * 老板看到一堆跟账无关的话，会直接怀疑"这个 AI 到底懂不懂我的账"。
     *
     * 所以把**能答什么 / 答不了什么 / 答不了怎么说**三件事写清楚。
     * 判"无关"只能靠模型自己的语义理解，前端用关键词拦（黑名单）既拦不全又会误伤
     * （"这个月有哪些支出"里也可能出现奇怪的字），所以这里不做正则拦截。
     *
     * 婉拒也要求按同一套 JSON 结构返回，前端才不用为"拒答"单开一条渲染分支。
     */
    const SCOPE =
      '你是「易帮账本」小程序里、中小门店老板的生意参谋。\n' +
      '\n【你只做四件事】超出这四件的一律婉拒 —— 不要硬答、不要延伸、不要聊别的：\n' +
      '① 查账：本月/上月的收入支出结余、谁欠我钱、我欠谁钱、某个客户的往来情况、' +
      '钱花在哪（按品类）、最近记了哪些账；\n' +
      '② 报账：今天有没有值得提醒老板的事（经营早报）；\n' +
      '③ 记账：老板报了一笔账，**系统已经帮他记进去了**，你只需确认并提示可撤销；\n' +
      '④ 比账：自己的成本占比跟同行比是高还是低。\n' +
      '　 ⚠️ **没有基准就没有高低**：已查好的数据里说"暂时比不了"时，就照实说比不了，\n' +
      '　   **不要顺口评价"你的成本控制得很好 / 很低"** —— 那是你自己编了一个同行标准。\n' +
      '\n【这四件之外的一律婉拒】\n' +
      '· 跟账目无关的：天气、新闻、闲聊、写代码、翻译、算术题、通用知识、情感咨询；\n' +
      '· 属于账目但**这次没给你数据**的：某一天／某一周／某一季度／去年的汇总、\n' +
      '  采购单据、库存、员工工资、报税。\n' +
      '（⚠️ 但如果下面的【本次已经查好的数据】里正好有，就**直接用那个回答**，不要说答不了。\n' +
      '  「比账」在样本不够时，已查好的数据里会写明"暂时比不了" —— 照实转述，不要自己编一个同行数字。）\n' +
      '\n【注意区分】数据查出来是空的，也是**正常答案**，不属于"答不了"。\n' +
      '比如问「谁欠我钱」而结果为空，就直说"目前没人欠你钱"，\n' +
      '**不要套用下面的婉拒模板** —— 更不能建议老板去问一个他刚问过的问题。\n' +
      '\n【答不了怎么说】不要硬答、不要猜、**绝对不要编数据**，也不要长篇解释自己为什么答不了。\n' +
      '用 summary 给一句干脆的婉拒（如"这个我答不了"），\n' +
      'points 第一条说明你只看得到店里的账，第二条给一个**你能答**的替代问法。\n' +
      '\n只根据下面提供的账目数据回答，数字必须来自这里。\n\n';

    const messages = [{
      role: 'system',
      content: SCOPE +
        /* 能力查到的东西放最前面，并明确标成"唯一数据源"。
           为什么强调"不要重算"：这一块里的数字是 SQL 算好的，
           模型只要照抄就永远对；一旦它自己动手加总，就有算错的可能 ——
           而老板分不清"AI 算错"和"账记错"。 */
        (skillText
          ? '\n【本次已经查好的数据 —— 这就是答案的数据源，直接用】\n' + skillText +
            '\n（以上数字由系统用代码从账本算出，**直接引用，不要重算、不要改数、不要自己加总**。）\n\n'
          : '') +
        ctx +
        '\n\n【回答格式】严格按这个 JSON 输出，不要 markdown 代码块、不要任何解释：\n' +
        '{"summary":"一句话结论，20字以内，口语","numbers":[{"label":"指标名","value":"¥1,234.00"}],"points":["要点，每条不超过30字"]}\n' +
        '约束：numbers 最多 3 个，只放最关键的（婉拒时可以给空数组 []）；points 最多 3 条，' +
        '说清"所以呢"而不是复述数字；没有的数据不要编，宁可不填。\n' +
        '· 如果问题**在范围内、但结果确实没什么可说**（本月还没记账、某笔往来是 0），\n' +
        '  points 就给一条**向前看**的建议（如"记几笔账我就能看出结构了"），\n' +
        '  **不要在这里复述"我只看得到店里的账"这类职责说明** —— 那是婉拒时才说的话，\n' +
        '  在正常回答里出现会显得答非所问。'
    }];

    for (const m of prior) {
      if (!m || typeof m.content !== 'string') continue;
      const text = m.content.trim().slice(0, 500);   // 截断：别让一轮长对话把上下文吃光
      if (!text) continue;
      // 前端存的是 'ai'，大模型要的是 'assistant'，在这里归一
      messages.push({ role: (m.role === 'ai' || m.role === 'assistant') ? 'assistant' : 'user', content: text });
    }
    messages.push({ role: 'user', content: q });

    const answer = await callModel({
      model: 'qwen-plus',
      messages,
      temperature: 0.3
    }, 45000);

    const raw = String(answer || '').trim();
    const payload = { answer: raw };

    // 能解析出结构就一起返回，前端按卡片渲染；解析不了就只给文本（前端按段落渲染）
    const card = toCard(raw);
    if (card) payload.card = card;

    bumpCount(req);

    // 存缓存：1小时过期
    cache.set(cacheKey, payload, 3600);

    res.json({ code: 0, data: payload });
  } catch (err) {
    log.error('AI问答错误:', err.response?.data || err.message);
    res.json({ code: 500, msg: 'AI回答失败' });
  }
});

/**
 * 把模型的回答整理成卡片要的结构。
 * 返回 null 表示"这次没结构化成功"，调用方照旧显示纯文本 ——
 * 不强求：偶尔格式不对也答得上话，比每次都要重试强。
 */
function toCard(raw) {
  const j = extractJson(raw);
  if (!j || typeof j !== 'object') return null;

  const summary = typeof j.summary === 'string' ? j.summary.trim() : '';
  const numbers = Array.isArray(j.numbers) ? j.numbers : [];
  const points = Array.isArray(j.points) ? j.points : [];

  const cleanNumbers = numbers
    .filter((n) => n && typeof n.label === 'string' && typeof n.value === 'string')
    .slice(0, 3)
    .map((n) => ({ label: n.label.trim().slice(0, 12), value: n.value.trim().slice(0, 18) }));

  const cleanPoints = points
    .filter((p) => typeof p === 'string' && p.trim())
    .slice(0, 3)
    .map((p) => p.trim().slice(0, 60));

  // 三项全空就当没结构化 —— 那也是模型的空回答，交给纯文本显示
  if (!summary && !cleanNumbers.length && !cleanPoints.length) return null;
  return { summary: summary.slice(0, 40), numbers: cleanNumbers, points: cleanPoints };
}

module.exports = router;
