const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const { resolveUpload, detectKind, toDataUri, callModel, cleanOcrText } = require('../lib/ledger');

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
const OCR_MODEL = 'qwen3.5-ocr';

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

/**
 * 图片取文（票据 / 小票 / 手写单）。
 * 只负责把图变成文字，结构化交给 /record/ai-parse —— 两条入口（说 / 拍）复用同一套归类逻辑。
 */
router.post('/ocr-parse', auth, async (req, res) => {
  const { fileUrl } = req.body;
  const filePath = resolveUpload(fileUrl);
  if (!filePath) return res.json({ code: 400, msg: '文件不存在或路径不合法' });

  const { kind, format } = detectKind(filePath);
  if (kind !== 'image') return res.json({ code: 400, msg: '不是图片文件' });

  try {
    const dataUri = toDataUri(filePath, format, 'image');
    const text = await callModel({
      model: OCR_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUri } },
          { type: 'text', text: '把这张单据里的所有文字原样读出来，保留金额、日期、对方名称。不要解释，不要补充，只输出文字。' }
        ]
      }]
    }, 120000);

    res.json({ code: 0, data: { text: cleanOcrText(text) } });
  } catch (err) {
    console.error('OCR 错误:', err.response?.data || err.message);
    res.json({ code: 500, msg: '图片识别失败' });
  }
});

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
