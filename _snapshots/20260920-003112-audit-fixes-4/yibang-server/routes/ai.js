const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const { resolveUpload, detectKind, toDataUri, callModel } = require('../lib/ledger');

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
router.post('/asr', auth, async (req, res) => {
  const { fileUrl } = req.body;
  const filePath = resolveUpload(fileUrl);
  if (!filePath) return res.json({ code: 400, msg: '文件不存在或路径不合法' });

  const { kind, format } = detectKind(filePath);
  if (kind !== 'audio') return res.json({ code: 400, msg: '不是音频文件' });

  try {
    const dataUri = toDataUri(filePath, format, 'audio');
    const text = await callModel({
      model: ASR_MODEL,
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: dataUri, format } }]
      }]
    }, 120000);

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
 * AI 生意参谋问答。
 * 先把用户自己的账目数据查出来塞进上下文，再让模型基于真实数据回答，
 * 而不是让它凭空编。
 */
router.post('/chat', auth, async (req, res) => {
  const question = String(req.body.question || '').trim();
  if (!question) return res.json({ code: 400, msg: '缺少问题' });

  try {
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
    const [lastRows] = await pool.query(
      'SELECT t.type, t.amount, t.content, t.record_date, c.name AS contact_name ' +
      'FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id ' +
      'WHERE t.user_id = ? AND t.status = 1 ORDER BY t.record_date DESC, t.id DESC LIMIT 20',
      [req.userId]
    );

    const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };
    const income = Number(monthRows[0].income);
    const expense = Number(monthRows[0].expense);

    const ctx = [
      '【本月】收入 ' + income.toFixed(2) + ' 元，支出 ' + expense.toFixed(2) + ' 元，结余 ' + (income - expense).toFixed(2) + ' 元。',
      '【别人欠我】' + (debtRows.length ? debtRows.map((r) => r.name + ' ' + Number(r.balance).toFixed(2) + ' 元').join('；') : '暂无'),
      '【我欠别人】' + (oweRows.length ? oweRows.map((r) => r.name + ' ' + Math.abs(Number(r.balance)).toFixed(2) + ' 元').join('；') : '暂无'),
      '【最近 20 笔】' + (lastRows.length
        ? lastRows.map((r) => r.record_date + ' ' + (TYPE_TEXT[r.type] || '支出') + ' ' + Number(r.amount).toFixed(2) + ' 元' + (r.contact_name ? '（' + r.contact_name + '）' : '') + (r.content ? ' ' + r.content : '')).join('；')
        : '暂无记录')
    ].join('\n');

    const answer = await callModel({
      model: 'qwen-plus',
      messages: [
        {
          role: 'system',
          content: '你是中小门店老板的生意参谋。只根据下面提供的账目数据回答，不要编造数据。' +
            '回答用中文口语，直接给结论和数字，控制在 120 字以内，不要用 markdown。\n\n' + ctx
        },
        { role: 'user', content: question }
      ],
      temperature: 0.3
    }, 45000);

    res.json({ code: 0, data: { answer: String(answer || '').trim() } });
  } catch (err) {
    console.error('AI问答错误:', err.response?.data || err.message);
    res.json({ code: 500, msg: 'AI回答失败' });
  }
});

module.exports = router;
