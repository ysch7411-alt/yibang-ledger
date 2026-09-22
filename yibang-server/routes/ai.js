const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const { resolveUpload, detectKind, toDataUri, callModel, extractJson } = require('../lib/ledger');
const { aiLimit, bumpCount } = require('../lib/rate-limit');
const cache = require('../lib/cache');

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
    console.error('ASR 错误:', err.response?.data || err.message);
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
    console.error('读图错误:', err.response?.data || err.message);
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

  try {
    // 先查缓存：相同问题直接返回结果
    const cacheKey = 'ai-chat:' + req.userId + ':' + q;
    const cached = cache.get(cacheKey);
    if (cached) {
      bumpCount(req);
      return res.json({ code: 0, data: cached });
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
    const messages = [{
      role: 'system',
      content: '你是中小门店老板的生意参谋。只根据下面提供的账目数据回答，不要编造数据。\n\n' + ctx +
        '\n\n【回答格式】严格按这个 JSON 输出，不要 markdown 代码块、不要任何解释：\n' +
        '{"summary":"一句话结论，20字以内，口语","numbers":[{"label":"指标名","value":"¥1,234.00"}],"points":["要点，每条不超过30字"]}\n' +
        '约束：numbers 最多 3 个，只放最关键的；points 最多 3 条，说清"所以呢"；' +
        '数字必须来自上面给的账目；没有的数据不要编，宁可不填。'
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
    console.error('AI问答错误:', err.response?.data || err.message);
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
