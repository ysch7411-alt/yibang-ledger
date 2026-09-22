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
  '- amount: 金额数字（元，总额），不要带货币符号',
  '- qty: 数量或重量（纯数字）。「3 斤」「20 包」「3 趟」里的 3 就是数量',
  '- unit: 数量的单位（斤 / 包 / 件 / 吨 / 趟 / 米 / 箱 …）。量词听不准也照原样填，但数字必须填出来',
  '- unit_price: 单价（纯数字）。「5 块钱一斤」「一斤 5 块」「一块 5 块」里的 5 都是单价',
  '- method: 收付方式。只可能是：现金 / 微信 / 支付宝 / 银行 / 转账 / 赊账 之一；没提到就填空字符串',
  '- type: 只能是「收入」「支出」「应收」「应付」「回款」「付款」之一。判定规则：',
  '  · 只有在句子里明确表达「在还以前的欠款」时才用 回款 / 付款，比如出现「还」「还欠」「结清」「把上次的款给了」；',
  '  · 其余情况「收到钱」一律算 收入、「付出去钱」一律算 支出 —— 不要因为提到了「货款」「房租」这类词就判成回款/付款；',
  '  · 对方欠我但还没给钱 → 应收；我欠对方但还没给钱 → 应付',
  '- contact: 往来对象姓名；没提到就填空字符串',
  '- content: 事由，短一点，比如「货款」「房租」「买菜」。**没说事由就留空，不要硬编**',
  '- date: YYYY-MM-DD。用户说「昨天」「前天」「上周五」等相对时间要换算成具体日期；没说就用 __TODAY__',
  '',
  '【算钱规则 · 最重要】',
  '一句话里同时出现数量和单价时，amount 必须是 **数量 × 单价** 的结果。',
  '绝对不能把单价当成总额。看到「…一斤 / 每斤 / 一块 / 一个」这类词，后面跟的钱数是**单价**，不是总额。',
  '只有数量和单价都给全了才相乘；只给了单价、没给数量的，amount 填 0（让用户补），不要瞎猜。',
  '',
  '【别把收付方式当成人名】',
  '「现金 / 微信 / 支付宝 / 银行 / 银行卡 / 转账 / 扫码 / 赊账」是**收付方式**，填进 method。',
  '**绝对不能填进 contact** —— 账本里没有叫「现金」的客户，填进去会凭空建出一个假客户。',
  '只说了方式、没说事由时，content 留空字符串即可。',
  '',
  '【量词听不准也要填】',
  '语音转文字经常把量词听错（「3 斤」听成「3 白」），或者量词和单价的单位对不上',
  '（「3 包」却「5 块钱一斤」）。这些都不要紧，也不要去纠正用户 —— 照原话填进 unit 就行：',
  '数字是数量 → qty，紧跟的数字后面的那两个字是单位 → unit，钱的数字是单价 → unit_price，',
  '金额自己乘出来。**宁可填了再交，也绝对不要返回一条字段全是 0 / 空 的记录。**',
  '',
  '输出格式（只输出 JSON，不要任何解释）：',
  '{"records":[{"amount":金额,"qty":数量,"unit":"单位","unit_price":单价,"method":"方式","type":"类型","contact":"对象","content":"事由","date":"日期"}]}',
  '',
  '下面三条是**格式示例**，绝不要把示例里的数字或文字当作用户说的内容：',
  '{"records":[{"amount":15,"qty":3,"unit":"斤","unit_price":5,"method":"","type":"支出","contact":"","content":"辣椒","date":"__TODAY__"}]}',
  '{"records":[{"amount":600,"qty":3,"unit":"趟","unit_price":200,"method":"","type":"支出","contact":"","content":"拉货","date":"__TODAY__"}]}',
  '{"records":[{"amount":300,"qty":0,"unit":"","unit_price":0,"method":"","type":"收入","contact":"","content":"废铁款","date":"__TODAY__"}]}',
  '注意示例里 method 全是空的 —— 那是因为这三个例子本来就没提收付方式。',
  '用户提到方式时必须照实填，比如「今天收现金1265元」→ method 填「现金」、content 留空。',
  '',
  '只有这句话里确实一个钱数都没有时，才返回 {"records":[]}'
].join('\n');

/**
 * 收付方式：模型没给时的确定性兜底。
 *
 * 为什么不只靠模型：这是老板每天都要说的一类话（「收现金 1265」），
 * 而「现金/微信/支付宝」这几个词是封闭集合，写死在代码里比指望模型稳定得多。
 * 注意「银行卡」要排在「银行」前面，否则 "银行卡" 会先命中 "银行"（结果一样，但语义上更准）。
 */
const METHOD_WORDS = ['现金', '现钱', '微信', '支付宝', '银行卡', '银行', '转账', '扫码', '赊账', '赊'];
const METHOD_ALIAS = {
  现金: '现金', 现钱: '现金',
  微信: '微信',
  支付宝: '支付宝',
  银行卡: '银行', 银行: '银行',
  转账: '转账', 扫码: '转账',
  赊账: '赊账', 赊: '赊账'
};

function detectMethod(text) {
  const s = String(text || '');
  for (const w of METHOD_WORDS) {
    if (s.indexOf(w) >= 0) return METHOD_ALIAS[w] || '';
  }
  return '';
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 数字清洗：'3,800.00元' → 3800；拿不到就 null（不是 0，0 会让"没给"和"给了0"分不清） */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 服务端兜底验算：模型把**单价当成了总额**时改回来。
 *
 * 实测案例（2026-09-19，用户报障原话）：
 *   「辣椒3白，5块钱一斤」→ 模型给 amount=5、qty=3、unit_price=5
 *   5 是单价，正确的总额是 15。模型算漏了这一次乘法，账就少记 10 元。
 *   而「辣椒300斤，5块钱一斤」它又能算对 —— 说明它不是不会，是不稳定。
 *   钱的事不能指望"大多数时候对"，所以这里加一道确定性验算。
 *
 * **只在有把握时改，其它一律尊重模型的答案**：
 *   · amount 缺失/为 0              → 算
 *   · amount 正好等于单价 qty>1 时  → 算（这就是"忘了乘数量"的形状）
 *   · amount 正好等于数量            → 算（把数量当金额写反了）
 * 刻意**不**做 "amount 与 qty×price 差得远就覆盖" —— 老板可能给了折后总价
 * （「3 斤 5 块一斤，一共给了 14」），那样改就是把对的改错。
 */
function reconcileAmount(amount, qty, unitPrice) {
  if (!(qty > 0) || !(unitPrice > 0)) return { amount, fixed: false };
  const calc = round2(qty * unitPrice);
  const a = amount || 0;
  const forgotMultiply = Math.abs(a - unitPrice) < 0.005 && qty !== 1;
  const swapped = Math.abs(a - qty) < 0.005 && Math.abs(qty - unitPrice) > 0.005;
  if (!a || forgotMultiply || swapped) return { amount: calc, fixed: true };
  return { amount: a, fixed: false };
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
      .map((o) => {
        const qty = num(o.qty);
        const unitPrice = num(o.unit_price !== undefined ? o.unit_price : o.price);
        const fixed = reconcileAmount(num(o.amount), qty, unitPrice);
        // 收付方式：模型没给就用确定性词表兜底（「现金/微信/支付宝」是封闭集合）
        const method = String(o.method || o.pay_method || '').trim() || detectMethod(norm.text);
        return {
          amount: Math.abs(fixed.amount || 0),
          qty: qty && qty > 0 ? qty : null,
          unit: String(o.unit || '').trim().slice(0, 16) || null,
          unitPrice: unitPrice && unitPrice > 0 ? unitPrice : null,
          method: method.slice(0, 16),
          amountFixed: fixed.fixed,     // 让前端能提示"金额是算出来的"，也方便日志取证
          type: TYPE_TEXT[TYPE_CODE[String(o.type || '').trim()]] || '支出',
          contact: canonicalizeName(String(o.contact || '').trim(), terms),
          content: String(o.content || '').trim(),
          date: /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || '')) ? o.date : today
        };
      })
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
  const { contact_id, contact_name, type, amount, content, record_date, qty, unit, unit_price, pay_method } = req.body;

  const typeCode = Number(type) || TYPE_CODE[String(type)] || 2;
  const q = num(qty);
  const up = num(unit_price);

  // 兜底验算也放在这里：前端版本可能比后端旧，不能假设它一定算对了
  const fixed = reconcileAmount(num(amount), q, up);
  const amt = Math.abs(fixed.amount || 0);
  if (!amt) return res.json({ code: 400, msg: '金额不能为 0' });

  try {
    // 前端可能只拿得到人名（AI 识别的就是名字），建档交给后端
    let cid = contact_id || null;
    if (!cid && contact_name) {
      cid = await ensureContact(pool, req.userId, contact_name, typeCode);
    }

    const [result] = await pool.query(
      'INSERT INTO transactions (user_id, contact_id, type, amount, qty, unit, unit_price, pay_method, content, record_date, status, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [
        req.userId, cid, typeCode, amt,
        q && q > 0 ? q : null,
        String(unit || '').trim().slice(0, 16) || null,
        up && up > 0 ? up : null,
        String(pay_method || '').trim().slice(0, 16) || null,
        String(content || '').slice(0, 255),
        record_date || todayStr(),
        req.userId
      ]
    );

    const balance = await recalcBalance(pool, req.userId, cid);

    res.json({ code: 0, msg: '记账成功', data: { id: result.insertId, contact_id: cid, balance, amountFixed: fixed.fixed } });
  } catch (err) {
    console.error('记账错误:', err);
    res.json({ code: 500, msg: '记账失败' });
  }
});

// 修改一笔（零表单录入的「改一下」）
router.post('/update', auth, async (req, res) => {
  const { id, type, amount, content, record_date, contact_id, contact_name, sourceText, aiResult,
    qty, unit, unit_price, pay_method } = req.body;
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
    // 「改一下」面板里老板可以自己填数量和单价，这两项改了就顺手把金额重算一遍——
    // 他填 3 斤 × 5 元却要自己去算 15，跟录入口要用户填总额是同一个毛病。
    const q = num(qty);
    const up = num(unit_price);
    if (qty !== undefined) {
      fields.push('qty = ?');
      params.push(q && q > 0 ? q : null);
    }
    if (unit !== undefined) {
      fields.push('unit = ?');
      params.push(String(unit || '').trim().slice(0, 16) || null);
    }
    if (unit_price !== undefined) {
      fields.push('unit_price = ?');
      params.push(up && up > 0 ? up : null);
    }
    if (pay_method !== undefined) {
      fields.push('pay_method = ?');
      params.push(String(pay_method || '').trim().slice(0, 16) || null);
    }
    // 只有"改了数量或单价、但没同时改金额"时才代算；老板明确给了 amount 就以他的为准
    if (amount === undefined && q > 0 && up > 0) {
      fields.push('amount = ?');
      params.push(round2(q * up));
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
      // 末尾的 t.id DESC 是必须的：record_date 和 created_at 都只到秒，
      // 同一秒里连着记的几笔会并列，MySQL 对并列行的顺序不作保证 ——
      // 实测出现过「刚记的那笔排在刚记的另一笔后面」，老板会以为没记上。
      'SELECT t.*, c.name as contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = ? ORDER BY t.record_date DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?',
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
      // 同上：补 id DESC，让同秒记的几笔有稳定顺序
      'SELECT t.*, c.name as contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = ? AND t.record_date = ? AND t.status = 1 ORDER BY t.created_at DESC, t.id DESC',
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
