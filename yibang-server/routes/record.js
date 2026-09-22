const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
// 2026-09-22 审查补上：/ai-parse 是全站调用最频繁的 AI 接口，原来**既没限流也没计数**
const { aiLimit, bumpCount } = require('../lib/rate-limit');
const {
  callModel, extractJson, recalcBalance, resolveAccount, ensureContact, isDay, dayOr, isMonth,
  // 2026-09-20 归一化/校验下沉到 ledger：create 和 update 必须用同一套，
  // 之前各写一遍，update 就漏了金额验算、两处都不校验 type
  normType, normAmount, num, round2, reconcileAmount,
  // 2026-09-22 品类（「钱花在哪」）：自由文本而非封闭枚举，所以只做清洗不做白名单
  normCategory,
  TYPE_CODE, VALID_TYPES, AMOUNT_MAX
} = require('../lib/ledger');
const { loadTerms, normalizeText, canonicalizeName, learnFromParse, learnFromCorrection, upsertTerm } = require('../lib/memory');
const log = require('../lib/log');

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
// TYPE_CODE / num / round2 / reconcileAmount 已下沉到 lib/ledger.js（见顶部 import）

/**
 * 记账去重（2026-09-20 端到端测试后补）
 *
 * 实测：5 次并发调 /record/create，5 次全部入库 —— 接口层没有任何幂等保护。
 * 前端已经给按钮加了 busy 锁，但挡不住"网络重试 / 多设备同时记 / 连点两下同一条话"，
 * 而重复记账是钱的事：用户发现时往往已经过去好几天，对账对不上。
 *
 * 做法：内存里记一张 3 秒有效的表，key 是「用户 + 类型 + 金额 + 内容 + 日期」。
 * 为什么不是永久去重：老板**可能真的要连记两笔一样的**（一早就收了两笔同样的货款），
 * 那又不是错误。3 秒刚好覆盖"手快点重了"，又不影响正常连续记账。
 * 为什么用内存而不是 redis：这是一个几十行的兜底，不值得为它多加一次网络往返
 * （redis 那一次往返比 INSERT 本身还贵）。进程重启后表清空，最坏情况是重启后
 * 3 秒内的重复没能拦住 —— 可接受。
 */
const CREATE_DEDUPE_MS = 3000;
const createSeen = new Map();

function recallCreate(key) {
  const hit = createSeen.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CREATE_DEDUPE_MS) {
    createSeen.delete(key);
    return null;
  }
  return hit.id;
}

function rememberCreate(key, id) {
  const now = Date.now();
  // 兜底清理：长期跑的服务不能让这张表无限涨。超过 500 条就顺手扫掉过期的
  if (createSeen.size > 500) {
    for (const [k, v] of createSeen) if (now - v.at > CREATE_DEDUPE_MS) createSeen.delete(k);
  }
  createSeen.set(key, { id, at: now });
}

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
  '- category: 品类，2~5 个字的**简短**词，用来回答「钱花在哪了」。要具体到"这一类东西叫什么"：',
  '  · 支出类如：买菜 / 五金 / 电料 / 包装 / 房租 / 运费 / 工资 / 烟酒 / 维修',
  '  · 收入类如：货款 / 零售 / 利息 / 废品',
  '  确实归纳不出就留空字符串，**不要硬编** —— 硬编出来的品类会让统计里多出一堆没用的类，比空着更糟',
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
  '{"records":[{"amount":金额,"qty":数量,"unit":"单位","unit_price":单价,"method":"方式","type":"类型","contact":"对象","content":"事由","category":"品类","date":"日期"}]}',
  '',
  '下面三条是**格式示例**，绝不要把示例里的数字或文字当作用户说的内容：',
  '{"records":[{"amount":15,"qty":3,"unit":"斤","unit_price":5,"method":"","type":"支出","contact":"","content":"辣椒","category":"买菜","date":"__TODAY__"}]}',
  '{"records":[{"amount":600,"qty":3,"unit":"趟","unit_price":200,"method":"","type":"支出","contact":"","content":"拉货","category":"运费","date":"__TODAY__"}]}',
  '{"records":[{"amount":300,"qty":0,"unit":"","unit_price":0,"method":"","type":"收入","contact":"","content":"废铁款","category":"废品","date":"__TODAY__"}]}',
  '注意示例里 method 全是空的 —— 那是因为这三个例子本来就没提收付方式。',
  '用户提到方式时必须照实填，比如「今天收现金1265元」→ method 填「现金」、content 留空。',
  '注意三条示例的 category 各不相同（买菜 / 运费 / 废品），因为它们是各自那句话归纳出来的。',
  '**你必须根据当前这句话重新判断 category，绝对不要照抄示例里的品类** ——',
  '比如用户说「买螺丝 15 块」，category 应该是「五金」而不是示例里的任何一个。',
  '',
  '只有这句话里确实一个钱数都没有时，才返回 {"records":[]}'
].join('\n');

/**
 * 组装解析提示词，并把「这家店已经用过的品类」喂进去（2026-09-22）。
 *
 * 不做这步的话，同一类东西会被叫成「钢材 / 钢铁 / 钢」，统计里就变成三样，
 * 老板看到的"钱花在哪"就会被拆得七零八落。采购线早就这么做了
 * （见 purchase.js 的 buildDocPrompt）—— 这里复用**同一张** merchant_terms(kind='category')
 * 词表，所以采购和日常收支的品类会收敛到同一套说法。
 *
 * ⚠️ 复用调用方**已经查好的 terms**，不额外查一次库：
 * /ai-parse 已经是录入链路上最慢的一段（模型 500ms 起），能省一次查询就省一次。
 */
function buildParsePrompt(terms, today) {
  let hint = '';
  try {
    const cats = [...new Set(
      (terms || [])
        .filter((t) => t.kind === 'category' && t.canonical)
        .map((t) => String(t.canonical).trim())
        .filter(Boolean)
    )].slice(0, 40);
    if (cats.length) hint = '\n这家店已经用过的品类（**优先从中选，尽量别造新的**）：' + cats.join('、');
  } catch (e) { /* 词表读不到就算了，不影响识别本身 */ }
  return PARSE_PROMPT.replace('__TODAY__', today) + hint;
}

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

// AI识别记账（支持一句话多笔）
router.post('/ai-parse', auth, aiLimit('parse'), async (req, res) => {
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
          { role: 'system', content: buildParsePrompt(terms, today) },
          { role: 'user', content: norm.text }
        ],
        temperature: 0.1
      }, 45000);

      /* ⚠️ 这行不能省：aiLimit 读的就是 bumpCount 累出来的计数。
         只挂 aiLimit 而不计数 = **限额永远是 0/80，形同虚设**（一个"看起来修好了"的假修复）。
         位置和 /ai/asr 一致：模型调用成功之后再计，失败不扣额度。 */
      bumpCount(req);

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
          // 品类（2026-09-22）：模型归纳出来的「钱花在哪」，归一后带出去
          category: normCategory(o.category),
          date: dayOr(o.date, today)
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
    log.error('AI解析错误:', err.message);
    res.json({ code: 500, msg: 'AI解析失败' });
  }
});

// 创建记账记录
router.post('/create', auth, async (req, res) => {
  const { contact_id, contact_name, type, amount, content, record_date, qty, unit, unit_price, pay_method, category } = req.body;

  // 2026-09-20：类型和金额都改成"该拒就拒"。之前 type 只转数字不校验，
  // 实测 type=99 / type=-1 都能入库 —— 那种记录汇总时归不到任何一类、
  // recalcBalance 算余额时也不算它，报表数字就这么错了，而页面上看不出来。
  const typeCode = normType(type);
  if (!typeCode) {
    return res.json({ code: 400, msg: '账目类型不正确（收入/支出/应收/应付/回款/付款）' });
  }

  // 金额走 normAmount：里面已含"单价当总额"的兜底验算 + 上下限校验
  const amt = normAmount(amount, qty, unit_price);
  if (!amt.ok) return res.json({ code: 400, msg: amt.why });

  // 品类（2026-09-22）：**只清洗、不拒绝**。
  // 与 type 的纪律不同 —— type 非法必须拒（否则报表数字会错而页面看不出来），
  // 但品类是自由文本，老板说得出「五金」「电料」就该存下来；归纳不出就给 null。
  const cat = normCategory(category);

  const q = num(qty);
  const up = num(unit_price);
  // 营业日：如果用户没指定日期，根据营业日截止时间自动算
  let day = dayOr(record_date, null);
  if (!day) {
    try {
      const [userRows] = await pool.query("SELECT business_day_end FROM users WHERE id = ?", [req.userId]);
      const endTime = userRows[0]?.business_day_end || "00:00";
      day = getBusinessDate(new Date(), endTime);
    } catch (e) { day = todayStr(); }
  }

  const dkey = [req.userId, typeCode, amt.amount, String(content || '').trim(), day].join('|');
  const dupId = recallCreate(dkey);
  if (dupId) {
    // 命中去重：不重复写库，但照常回成功 —— 用户那一侧已经在等"记上了"，
    // 此时报错反而更让人慌。deduped 标记给前端留了个口子（以后想提示"已经记过"）
    return res.json({ code: 0, msg: '记账成功', data: { id: dupId, deduped: true } });
  }

  try {
    /* 「员工录的账要等老板审」（2026-09-23 用户定的口径）。
       员工（users.boss_id 指向老板）录的账：落**老板账下** + status=0 待审 + created_by 记员工。
       老板本人：落自己账下 + status=1 直接入账（= 原来行为，零变化）。
       ⚠️ 必须在 ensureContact 之前解析 —— 往来对象也要建在老板账下，
          否则员工的"张老板"会在他自己账里，老板那边看不到。 */
    const acct = await resolveAccount(pool, req.userId);

    // 前端可能只拿得到人名（AI 识别的就是名字），建档交给后端
    let cid = contact_id || null;
    if (!cid && contact_name) {
      cid = await ensureContact(pool, acct.ownerId, contact_name, typeCode);
    }

    const [result] = await pool.query(
      'INSERT INTO transactions (user_id, contact_id, type, amount, qty, unit, unit_price, pay_method, category, content, record_date, status, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        acct.ownerId, cid, typeCode, amt.amount,
        q && q > 0 ? q : null,
        String(unit || '').trim().slice(0, 16) || null,
        up && up > 0 ? up : null,
        String(pay_method || '').trim().slice(0, 16) || null,
        cat,
        String(content || '').slice(0, 255),
        // 日期不合法就落到今天，而不是把脏日期塞进 DATE 列让 MySQL 报错
        day,
        acct.status,
        req.userId
      ]
    );

    rememberCreate(dkey, result.insertId);

    // 把这次用到的品类沉淀进商家词表（kind='category'）：下次解析会被喂回模型，
    // 同一类东西的叫法越用越统一（采购线用的是同一张词表）。
    // 学不会不能影响记账本身，所以单独 try —— 记账已经成功了。
    if (cat) {
      try { await upsertTerm(pool, req.userId, 'category', cat, cat, null, 'auto'); }
      catch (e) { /* 忽略：词表是锦上添花，不是记账的必要条件 */ }
    }

    const balance = await recalcBalance(pool, req.userId, cid);

    res.json({
      code: 0, msg: '记账成功',
      data: { id: result.insertId, contact_id: cid, balance, amountFixed: !!(amt.fixed && amt.fixed.fixed) }
    });
  } catch (err) {
    log.error('记账错误:', err);
    res.json({ code: 500, msg: '记账失败' });
  }
});

// 修改一笔（零表单录入的「改一下」）
router.post('/update', auth, async (req, res) => {
  const { id, type, amount, content, record_date, contact_id, contact_name, sourceText, aiResult,
    qty, unit, unit_price, pay_method, category } = req.body;
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
        ? await ensureContact(pool, req.userId, contact_name, normType(type) || 2)
        : null;
    }

    const oldContactId = rows[0].contact_id;
    const fields = [];
    const params = [];

    // 改一笔同样要过校验。update 之前比 create 松：type 不校验、
    // 也没有"单价当总额"的兜底验算 —— 老板在「改一下」里填 3 斤 × 5 元
    // 却要自己按计算器算 15，跟要求用户填表单是同一个毛病。
    if (type !== undefined) {
      const t = normType(type);
      if (!t) return res.json({ code: 400, msg: '账目类型不正确（收入/支出/应收/应付/回款/付款）' });
      fields.push('type = ?');
      params.push(t);
    }
    if (amount !== undefined) {
      // qty/unit_price 也可能一起被改，所以验算时带上这两项
      const a = normAmount(amount, qty, unit_price);
      if (!a.ok) return res.json({ code: 400, msg: a.why });
      fields.push('amount = ?');
      params.push(a.amount);
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
    // 品类（2026-09-22）：「改一下」面板里 AI 归错类时唯一的修正口。
    // 注意这里**允许清空**（传空串 → null）——「未分类」是合法状态，
    // 老板可以把乱归的品类去掉，而不是被迫留一个错的。
    const nextCat = category === undefined ? undefined : normCategory(category);
    if (nextCat !== undefined) {
      fields.push('category = ?');
      params.push(nextCat);
    }
    // 只有"改了数量或单价、但没同时改金额"时才代算；老板明确给了 amount 就以他的为准
    if (amount === undefined && q > 0 && up > 0) {
      const calc = round2(q * up);
      if (calc > AMOUNT_MAX) return res.json({ code: 400, msg: '按数量和单价算出来的金额过大（最多 ' + AMOUNT_MAX.toFixed(2) + ' 元）' });
      fields.push('amount = ?');
      params.push(calc);
    }
    if (record_date !== undefined) {
      // 改日期时**不能**像新建那样默默兜底成今天 —— 老板明明要改成某天，
      // 悄悄改成今天比报错更糟（他会以为改成了）。直接告诉他不合法。
      if (!isDay(record_date)) return res.json({ code: 400, msg: '日期格式不对，应为 YYYY-MM-DD' });
      fields.push('record_date = ?');
      params.push(String(record_date).trim());
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

    /* 品类纠正回流（2026-09-22）：老板把 AI 归的品类改成对的，是最值钱的一次学习。
       ⚠️ 只沉淀 canonical 本身（alias === canonical），**绝不建 alias→canonical 映射**：
       normalizeText 会拿所有"别名 ≠ 标准名"的词条去改写用户原话，
       要是把「螺丝 → 五金」建成映射，下一句「买螺丝15块」会被改写成「买五金15块」
       —— 等于把老板说的话改掉。alias === canonical 的词条会被 normalizeText 主动跳过（安全）。
       这样做的效果是：新品类进入"这家店用过的品类"清单，下一句解析时被喂回模型。 */
    if (nextCat) {
      try { await upsertTerm(pool, req.userId, 'category', nextCat, nextCat, null, 'user'); }
      catch (e) { /* 忽略：不影响这笔修改本身 */ }
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
        // 用 normType 而不是 Number：老板在这个面板里选的是中文「应收」，
        // Number('应收') 是 NaN，会把一条脏数据记进词表，下次照样错
        { type: type !== undefined ? normType(type) : undefined, contactName: contact_name, content },
        id
      );
    }

    res.json({ code: 0, msg: '修改成功', data: { learned } });
  } catch (err) {
    log.error('修改错误:', err);
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
    log.error('删除错误:', err);
    res.json({ code: 500, msg: '撤销失败' });
  }
});

/**
 * 分组汇总：按 日 / 月 / 年 把区间内的收支各归一堆。
 *
 * 一个接口覆盖三种粒度，而不是开三个 —— 老板要的是"换个角度看同一批账"，
 * 三种口径的收支定义必须完全一致，写三份 SQL 迟早出现"按日加起来不等于按月"。
 *
 * 口径跟日报保持一致：type IN (1,5) 记收入、(2,6) 记支出；应收应付(3,4)不计入收支
 *（那是"还没给钱"，计进来会让结余对不上现金）。
 */
const GROUP_BY = {
  day: "DATE_FORMAT(record_date, '%Y-%m-%d')",
  month: "DATE_FORMAT(record_date, '%Y-%m')",
  year: "DATE_FORMAT(record_date, '%Y')"
};

router.get('/group', auth, async (req, res) => {
  const { by = 'day', from, to } = req.query;

  // 白名单取表达式：绝不能把参数拼进 SQL
  const key = Object.prototype.hasOwnProperty.call(GROUP_BY, by) ? by : 'day';
  const expr = GROUP_BY[key];

  /* 员工读侧收口（2026-09-23）：员工只该看到**自己提交的**账，
     而不是老板的全账 —— 产品口径是"员工只能记账"。
     口径与 /daily-summary 保持一致（都用 created_by = 自己 + status = 1）：
     ⚠️ 不能一边让人看到待审明细、一边汇总里又不算它 —— 那会造成"明细和汇总对不上"，
        正是这个项目早先修过的一类 bug。 */
  const acct = await resolveAccount(pool, req.userId);
  const where = ['user_id = ?', 'status = 1'];
  const params = [acct.ownerId];
  if (acct.isStaff) {
    where.push('created_by = ?');
    params.push(req.userId);
  }
  if (isDay(from)) {
    where.push('record_date >= ?');
    params.push(from);
  }
  if (isDay(to)) {
    where.push('record_date <= ?');
    params.push(to);
  }

  try {
    const [rows] = await pool.query(
      'SELECT ' + expr + ' AS k, ' +
      'COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END), 0) AS income, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END), 0) AS expense, ' +
      'COUNT(*) AS cnt, ' +
      'COALESCE(SUM(CASE WHEN type IN (1,5) THEN 1 ELSE 0 END), 0) AS income_cnt, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN 1 ELSE 0 END), 0) AS expense_cnt ' +
      'FROM transactions WHERE ' + where.join(' AND ') +
      ' GROUP BY k ORDER BY k DESC',
      params
    );

    const list = rows.map((r) => ({
      key: r.k,
      income: Number(r.income),
      expense: Number(r.expense),
      // 结余在服务端算好：前端两处各算一次，迟早出现表格和日历对不上
      net: Math.round((Number(r.income) - Number(r.expense)) * 100) / 100,
      count: Number(r.cnt),
      incomeCount: Number(r.income_cnt),
      expenseCount: Number(r.expense_cnt)
    }));

    // 总计也一起给：两张汇总表的合计行要用，前端再加一遍容易跟列表漂移
    const total = list.reduce(
      (a, x) => ({
        income: Math.round((a.income + x.income) * 100) / 100,
        expense: Math.round((a.expense + x.expense) * 100) / 100,
        count: a.count + x.count
      }),
      { income: 0, expense: 0, count: 0 }
    );
    total.net = Math.round((total.income - total.expense) * 100) / 100;

    res.json({ code: 0, data: { by: key, from: from || null, to: to || null, list, total } });
  } catch (err) {
    log.error('分组汇总失败:', err.message);
    res.json({ code: 500, msg: '获取汇总失败' });
  }
});

/**
 * 按维度聚合日常收支（2026-09-22）：回答「钱花在哪了 / 钱从哪来」。
 *
 * 为什么要这个接口：在它之前，报表只能给"这个月花了多少"这一个总数，
 * 老板真正想知道的是"花在哪了"。采购线早就有 /purchase/stats（按供应商/品类），
 * 但那只覆盖采购单据；日常收支（买菜、房租、运费、工资…）完全没有维度。
 *
 * 与前缀口径完全对齐（这是硬不变量，改动前先看 /group 的注释）：
 *   · 只算已入账 status = 1；应收应付 (3,4) 不计入收支
 *   · dir=out → type IN (2,6)；dir=in → type IN (1,5)
 *   · 区间由**服务端**算法，不信客户端时钟
 *
 * 参数：from / to（YYYY-MM-DD，可选）、groupBy（category|method）、dir（in|out）
 * 返回：按金额倒序 [{ key, amount, count, share }] + total
 *   · share 在服务端算好 —— 前端各算一次迟早出现"饼图加起来不是 100%"
 *   · 空值归到「未分类」/「未填写」，**不能悄悄丢掉**：丢掉的话各项之和就对不上总数了
 */
const STAT_DIM = {
  category: { col: 'category', blank: '未分类' },
  method: { col: 'pay_method', blank: '未填写' }
};

router.get('/stats', auth, async (req, res) => {
  const { from, to, groupBy = 'category', dir = 'out' } = req.query;

  // 白名单取列名与方向：绝不把参数拼进 SQL
  const dimKey = Object.prototype.hasOwnProperty.call(STAT_DIM, groupBy) ? groupBy : 'category';
  const dim = STAT_DIM[dimKey];
  const isIn = dir === 'in';
  const typeCond = isIn ? 'type IN (1,5)' : 'type IN (2,6)';

  const where = ['user_id = ?', 'status = 1', typeCond];
  const params = [req.userId];
  if (isDay(from)) { where.push('record_date >= ?'); params.push(from); }
  if (isDay(to)) { where.push('record_date <= ?'); params.push(to); }

  try {
    const [rows] = await pool.query(
      'SELECT ' + dim.col + ' AS k, COALESCE(SUM(amount), 0) AS amt, COUNT(*) AS cnt ' +
      'FROM transactions WHERE ' + where.join(' AND ') +
      ' GROUP BY ' + dim.col + ' ORDER BY amt DESC LIMIT 50',
      params
    );

    const list = rows.map((r) => ({
      key: String(r.k == null ? '' : r.k).trim() || dim.blank,
      amount: Math.round(Number(r.amt || 0) * 100) / 100,
      count: Number(r.cnt) || 0
    }));

    const total = Math.round(list.reduce((s, x) => s + x.amount, 0) * 100) / 100;
    // 占比在服务端算：前端两处各算一次，迟早在饼图和列表之间对不上
    list.forEach((x) => {
      x.share = total > 0 ? Math.round((x.amount / total) * 1000) / 10 : 0;
    });

    res.json({
      code: 0,
      data: { groupBy: dimKey, dir: isIn ? 'in' : 'out', from: from || null, to: to || null, total, list }
    });
  } catch (err) {
    log.error('收支维度统计失败:', err.message);
    res.json({ code: 500, msg: '获取统计失败' });
  }
});

/**
 * 记录列表（查询页与报表明细都用它）。
 *
 * 筛选**全部放服务端**：以前查询页是把最新 200 条拉到本地再筛，
 * 所以"搜一个三个月前的人名"会静默返回空 —— 用户以为没这笔账，
 * 其实是没加载到。数据量越大越明显，而且它不会报错、只会给错答案。
 *
 * 参数：
 *   page / size(≤500)            分页
 *   from / to                    日期闭区间（record_date）
 *   type = in | out              收支口径，跟前端 fmt.isIncomeType 保持一致（in = 1,5）
 *   keyword                      匹配 事由 / 往来对象名 / 金额
 *   withTotal = 1                额外返回总条数与分页信息（不传就还是老的数组形状，避免动到既有调用方）
 */
router.get('/list', auth, async (req, res) => {
  const { page = 1, size = 20, from, to, type, keyword, withTotal } = req.query;

  // size 必须有上限：原来直接把 parseInt(size) 塞进 LIMIT，
  // 一个 ?size=999999 就能把整张表拉出来（也就能被拿来做廉价的批量导出）。
  const lim = Math.min(Math.max(parseInt(size) || 20, 1), 500);
  const offset = (Math.max(1, parseInt(page)) - 1) * lim;

  // 用 record_date（DATE 类型）做闭区间比较，跟日报的口径一致。
  // isDay 用 lib/ledger 里的那份：它还会挡住 '2026-13-99' 这类"格式合法但日子不存在"的输入，
  // 否则脏日期会一路传到 MySQL 报错，接口变成 500。
  /* 员工读侧收口（2026-09-23）—— 同 /group，见那里的说明 */
  const acct = await resolveAccount(pool, req.userId);
  const where = ['t.user_id = ?'];
  const params = [acct.ownerId];
  if (acct.isStaff) {
    where.push('t.created_by = ?');
    params.push(req.userId);
  }
  if (isDay(from)) {
    where.push('t.record_date >= ?');
    params.push(from);
  }
  if (isDay(to)) {
    where.push('t.record_date <= ?');
    params.push(to);
  }

  // 收支口径：跟 utils/format.js 的 isIncomeType 完全一致（只有 1 收入 / 5 回款算"进"）
  if (type === 'in') where.push('t.type IN (1,5)');
  else if (type === 'out') where.push('t.type NOT IN (1,5)');

  // 关键词：事由 / 往来对象名 / 金额。
  // 金额比的是 CAST 出来的数字串（'5000.00'），所以搜「5000」能中，搜「5,000」中不了 ——
  // 前端本来还额外比对了带千分位的格式，但那必须跟服务端口径一致，
  // 否则会出现"本地能搜到、换个区间就搜不到"这种最让人困惑的差异。
  const kw = String(keyword == null ? '' : keyword).trim().slice(0, 50);
  if (kw) {
    const like = '%' + kw.replace(/[%_\\]/g, '\\$&') + '%';
    where.push('(t.content LIKE ? OR c.name LIKE ? OR CAST(t.amount AS CHAR) LIKE ?)');
    params.push(like, like, like);
  }

  const whereSql = where.join(' AND ');

  try {
    const [rows] = await pool.query(
      // 末尾的 t.id DESC 是必须的：record_date 和 created_at 都只到秒，
      // 同一秒里连着记的几笔会并列，MySQL 对并列行的顺序不作保证 ——
      // 实测出现过「刚记的那笔排在刚记的另一笔后面」，老板会以为没记上。
      // 分页时它还有第二个作用：顺序不稳会让翻页出现重复或漏行。
      'SELECT t.*, c.name as contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id ' +
      'WHERE ' + whereSql + ' ORDER BY t.record_date DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?',
      params.concat([lim, offset])
    );

    if (withTotal === '1') {
      // 分页要能告诉用户"一共有多少、还有没有更多"，所以额外数一次总数。
      // 只有主动要的时候才算，免得给老调用方多跑一条 COUNT。
      const [cnt] = await pool.query(
        'SELECT COUNT(*) AS n FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE ' + whereSql,
        params
      );
      const n = Number(cnt[0].n);
      return res.json({
        code: 0,
        data: { list: rows, total: n, page: Math.max(1, parseInt(page)), size: lim, hasMore: offset + rows.length < n }
      });
    }

    res.json({ code: 0, data: rows });
  } catch (err) {
    log.error('获取记录失败:', err.message);
    res.json({ code: 500, msg: '获取记录失败' });
  }
});

// 每日汇总
router.get('/daily-summary', auth, async (req, res) => {
  const { date } = req.query;

  try {
    /* 员工读侧收口（2026-09-23）：员工只看**自己提交的**账（口径同 /group、/list ✓），
       否则他会看到老板当天的全部进账与支出 —— 而"员工只能记账"。
       ⚠️ 三处查询必须**同时**加，漏一处就会出现"汇总对了、明细多了"这种自相矛盾。 */
    const acct = await resolveAccount(pool, req.userId);
    const staffCond = acct.isStaff ? ' AND created_by = ?' : '';
    const staffParam = acct.isStaff ? [req.userId] : [];

    const [income] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (1,5) AND record_date = ? AND status = 1' + staffCond,
      [acct.ownerId, date].concat(staffParam)
    );

    const [expense] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (2,6) AND record_date = ? AND status = 1' + staffCond,
      [acct.ownerId, date].concat(staffParam)
    );

    const [details] = await pool.query(
      // 同上：补 id DESC，让同秒记的几笔有稳定顺序
      'SELECT t.*, c.name as contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = ? AND t.record_date = ? AND t.status = 1' + (acct.isStaff ? ' AND t.created_by = ?' : '') + ' ORDER BY t.created_at DESC, t.id DESC',
      [acct.ownerId, date].concat(staffParam)
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
  if (!isMonth(month)) {
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
    log.error('本月汇总错误:', err);
    res.json({ code: 500, msg: '获取本月汇总失败' });
  }
});


// 按日期范围汇总（用于年报、自选日期范围等）
router.get('/range-summary', auth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.json({ code: 400, msg: '缺少 from 或 to 参数（格式 YYYY-MM-DD）' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT ' +
      'COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END), 0) AS income, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END), 0) AS expense, ' +
      'COUNT(*) AS cnt ' +
      'FROM transactions WHERE user_id = ? AND status = 1 AND record_date >= ? AND record_date <= ?',
      [req.userId, from, to]
    );
    const income = Number(rows[0].income);
    const expense = Number(rows[0].expense);
    res.json({
      code: 0,
      data: { from, to, income, expense, net: income - expense, count: Number(rows[0].cnt) }
    });
  } catch (err) {
    log.error('范围汇总错误:', err);
    res.json({ code: 500, msg: '获取汇总失败' });
  }
});

module.exports = router;
