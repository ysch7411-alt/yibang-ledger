const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const { callModel, extractJson, recalcBalance, ensureContact } = require('../lib/ledger');
const { loadTerms, normalizeText, canonicalizeName, learnFromParse, learnFromCorrection } = require('../lib/memory');

// 中间件：验证token
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.json({ code: 401, msg: '未登录' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.json({ code: 401, msg: 'token无效' });
  }
}

const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };
const TYPE_CODE = { 收入: 1, 支出: 2, 应收: 3, 应付: 4, 回款: 5, 付款: 6 };

/**
 * 文本结构化用哪个模型：qwen-flash。
 * 2026-09-19 用真实 PARSE_PROMPT + 7 个用例做过 A/B（见 _verify/probe-speed3.js）：
 *   qwen-plus   7/7 正确   中位 1042ms
 *   qwen-flash  7/7 正确   中位  513ms   ← 选它，快 2 倍且准确率一样
 *   qwen-turbo  6/7 正确   中位  526ms   ← 会算错（2.5 吨 ×3800 算成 7600），不能用
 * 归类是语音链路上的第二段，它快一倍，用户少等一倍。
 */
const MODEL_TEXT = 'qwen-flash';

const PARSE_PROMPT = [
  '你是一个记账助手。从用户的一句话里提取【全部】账目，可能只有一笔，也可能有好几笔。',
  '每个字段的含义：',
  '- amount: 金额数字（元），不要带货币符号',
  '- type: 只能是「收入」「支出」「应收」「应付」「回款」「付款」之一。判定规则：',
  '  · 只有在句子里明确表达「在还以前的欠款」时才用 回款 / 付款，比如出现「还」「还欠」「结清」「把上次的款给了」；',
  '  · 其余情况「收到钱」一律算 收入、「付出去钱」一律算 支出 —— 不要因为提到了「货款」「房租」这类词就判成回款/付款；',
  '  · 对方欠我但还没给钱 → 应收；我欠对方但还没给钱 → 应付',
  '- contact: 往来对象姓名；没提到就填空字符串',
  '- content: 事由，短一点，比如「货款」「房租」「买菜」',
  '- date: YYYY-MM-DD。用户说「昨天」「前天」「上周五」等相对时间要换算成具体日期；没说就用 __TODAY__',
  '只输出 JSON，不要任何解释，格式：',
  '{"records":[{"amount":0,"type":"支出","contact":"","content":"","date":"YYYY-MM-DD"}]}',
  '如果这句话里确实没有任何金额，返回 {"records":[]}'
].join('\n');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// AI识别记账（支持一句话多笔）
router.post('/ai-parse', auth, async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.json({ code: 400, msg: '缺少文本内容' });
  }

  const today = todayStr();

  try {
    // ① 先用商家词表把原话归一 —— 老板平时说的「张哥」直接翻成他账本里的「张老板」，
    //    这样不用每次都指望模型猜对同一个人。
    const terms = await loadTerms(pool, req.userId);
    const norm = normalizeText(text, terms);

    const raw = await callModel({
      model: MODEL_TEXT,
      messages: [
        { role: 'system', content: PARSE_PROMPT.replace('__TODAY__', today) },
        { role: 'user', content: norm.text }
      ],
      temperature: 0.1
    }, 45000);

    const parsed = extractJson(raw) || {};
    let list = [];
    if (Array.isArray(parsed)) list = parsed;
    else if (Array.isArray(parsed.records)) list = parsed.records;
    else if (parsed.amount !== undefined) list = [parsed];

    const records = list
      .map((o) => ({
        amount: Math.abs(Number(o.amount) || 0),
        type: TYPE_TEXT[TYPE_CODE[String(o.type || '').trim()]] || '支出',
        contact: canonicalizeName(String(o.contact || '').trim(), terms),
        content: String(o.content || '').trim(),
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || '')) ? o.date : today
      }))
      .filter((r) => r.amount > 0);

    // ② 把这次出现的名字 / 事由沉淀进词表，下次解析更准（这就是"越用越懂"的自动半边）
    const learned = await learnFromParse(pool, req.userId, records);

    const payload = { records, matched: norm.hits, learned };
    // 兼容旧前端：单笔时同时给出平铺字段
    if (records.length === 1) Object.assign(payload, records[0]);
    else if (records.length === 0) Object.assign(payload, { amount: 0, type: '支出', contact: '', content: text });

    res.json({ code: 0, data: payload });
  } catch (err) {
    console.error('AI解析错误:', err.message);
    res.json({ code: 500, msg: 'AI解析失败' });
  }
});

// 创建记账记录
router.post('/create', auth, async (req, res) => {
  const { contact_id, contact_name, type, amount, content, record_date } = req.body;

  const typeCode = Number(type) || TYPE_CODE[String(type)] || 2;
  const amt = Math.abs(Number(amount) || 0);
  if (!amt) return res.json({ code: 400, msg: '金额不能为 0' });

  try {
    // 前端可能只拿得到人名（AI 识别的就是名字），建档交给后端
    let cid = contact_id || null;
    if (!cid && contact_name) {
      cid = await ensureContact(pool, req.userId, contact_name, typeCode);
    }

    const [result] = await pool.query(
      'INSERT INTO transactions (user_id, contact_id, type, amount, content, record_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      [req.userId, cid, typeCode, amt, String(content || '').slice(0, 255), record_date || todayStr(), req.userId]
    );

    const balance = await recalcBalance(pool, req.userId, cid);

    res.json({ code: 0, msg: '记账成功', data: { id: result.insertId, contact_id: cid, balance } });
  } catch (err) {
    console.error('记账错误:', err);
    res.json({ code: 500, msg: '记账失败' });
  }
});

// 修改一笔（零表单录入的「改一下」）
router.post('/update', auth, async (req, res) => {
  const { id, type, amount, content, record_date, contact_id, contact_name, sourceText, aiResult } = req.body;
  if (!id) return res.json({ code: 400, msg: '缺少记录 id' });

  try {
    const [rows] = await pool.query(
      'SELECT id, contact_id FROM transactions WHERE id = ? AND user_id = ?',
      [id, req.userId]
    );
    if (!rows.length) return res.json({ code: 404, msg: '记录不存在或不属于你' });

    // 允许直接改往来对象：老板给的往往是名字，建档交给后端
    let nextContactId = contact_id;
    if (nextContactId === undefined && contact_name !== undefined) {
      nextContactId = contact_name
        ? await ensureContact(pool, req.userId, contact_name, type)
        : null;
    }

    const oldContactId = rows[0].contact_id;
    const fields = [];
    const params = [];
    if (type !== undefined) {
      fields.push('type = ?');
      params.push(Number(type) || TYPE_CODE[String(type)] || 2);
    }
    if (amount !== undefined) {
      fields.push('amount = ?');
      params.push(Math.abs(Number(amount) || 0));
    }
    if (content !== undefined) {
      fields.push('content = ?');
      params.push(String(content).slice(0, 255));
    }
    if (record_date !== undefined) {
      fields.push('record_date = ?');
      params.push(record_date || null);
    }
    if (nextContactId !== undefined) {
      fields.push('contact_id = ?');
      params.push(nextContactId || null);
    }
    if (!fields.length) return res.json({ code: 400, msg: '没有要修改的字段' });

    params.push(id, req.userId);
    await pool.query('UPDATE transactions SET ' + fields.join(', ') + ' WHERE id = ? AND user_id = ?', params);

    await recalcBalance(pool, req.userId, oldContactId);
    if (nextContactId !== undefined && String(nextContactId) !== String(oldContactId)) {
      await recalcBalance(pool, req.userId, nextContactId);
    }

    // 「改一下」是"越用越懂"里最值钱的一次学习：老板把 AI 的错答案改成对的，
    // 这个映射必须留下来，否则下次同一个说法还会错。
    let learned = [];
    if (sourceText) {
      learned = await learnFromCorrection(
        pool,
        req.userId,
        sourceText,
        aiResult || {},
        { type: type !== undefined ? Number(type) : undefined, contactName: contact_name, content },
        id
      );
    }

    res.json({ code: 0, msg: '修改成功', data: { learned } });
  } catch (err) {
    console.error('修改错误:', err);
    res.json({ code: 500, msg: '修改失败' });
  }
});

// 删除一笔（零表单录入的「撤销」）
router.post('/delete', auth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ code: 400, msg: '缺少记录 id' });

  try {
    const [rows] = await pool.query(
      'SELECT id, contact_id FROM transactions WHERE id = ? AND user_id = ?',
      [id, req.userId]
    );
    if (!rows.length) return res.json({ code: 404, msg: '记录不存在或不属于你' });

    await pool.query('DELETE FROM transactions WHERE id = ? AND user_id = ?', [id, req.userId]);
    await recalcBalance(pool, req.userId, rows[0].contact_id);

    res.json({ code: 0, msg: '已撤销' });
  } catch (err) {
    console.error('删除错误:', err);
    res.json({ code: 500, msg: '撤销失败' });
  }
});

// 获取记录列表
router.get('/list', auth, async (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(size);

  try {
    const [rows] = await pool.query(
      'SELECT t.*, c.name as contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = ? ORDER BY t.record_date DESC, t.created_at DESC LIMIT ? OFFSET ?',
      [req.userId, parseInt(size), parseInt(offset)]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: '获取记录失败' });
  }
});

// 每日汇总
router.get('/daily-summary', auth, async (req, res) => {
  const { date } = req.query;

  try {
    const [income] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (1,5) AND record_date = ? AND status = 1',
      [req.userId, date]
    );

    const [expense] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (2,6) AND record_date = ? AND status = 1',
      [req.userId, date]
    );

    const [details] = await pool.query(
      'SELECT t.*, c.name as contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = ? AND t.record_date = ? AND t.status = 1 ORDER BY t.created_at DESC',
      [req.userId, date]
    );

    const inc = Number(income[0].total);
    const exp = Number(expense[0].total);
    res.json({
      code: 0,
      data: { income: inc, expense: exp, net: inc - exp, count: details.length, details }
    });
  } catch (err) {
    res.json({ code: 500, msg: '获取汇总失败' });
  }
});

// 本月汇总
router.get('/month-summary', auth, async (req, res) => {
  const { month } = req.query;
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    return res.json({ code: 400, msg: 'month 格式应为 YYYY-MM' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT ' +
      'COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END), 0) AS income, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END), 0) AS expense, ' +
      'COUNT(*) AS cnt ' +
      'FROM transactions WHERE user_id = ? AND status = 1 AND DATE_FORMAT(record_date, "%Y-%m") = ?',
      [req.userId, month]
    );
    const income = Number(rows[0].income);
    const expense = Number(rows[0].expense);
    res.json({
      code: 0,
      data: { month, income, expense, net: income - expense, count: Number(rows[0].cnt) }
    });
  } catch (err) {
    console.error('本月汇总错误:', err);
    res.json({ code: 500, msg: '获取本月汇总失败' });
  }
});

module.exports = router;
