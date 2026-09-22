const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const { callModel, extractJson, resolveUpload, detectKind, toDataUri, ensureContact, cleanOcrText, dayOr } = require('../lib/ledger');
const { upsertTerm, loadTerms } = require('../lib/memory');

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

const OCR_MODEL = 'qwen3.5-ocr';

/**
 * 模型选择（2026-09-19 实测，脚本见 _verify/probe-ocr.js / probe-ocr2.js）
 *
 * 测试方法：同一张真值已知的标准送货单（3 行明细/合计 17700），用 ffmpeg 生成 5 档难度
 * （干净 / 手机翻拍 / 弱光 / 拍远 800px / 综合最难），逐字段判对错，每格跑 2 轮。
 *
 * 结构化任务（模型直接出 JSON，这是产品实际用的）：10 格通过数
 *   快路 qwen3-vl-flash             8/10   平均 3667ms   ← 选它
 *   快路 qwen3-vl-flash-2026-01-22  8/10   平均 3638ms   （完全打平，见下面选型说明）
 *   慢路 qwen3.5-ocr + qwen-flash   6/10   平均 2732ms   （拍远那档把小字 2.5 读成 2.6）
 *   单轮另测：qwen-vl-ocr-latest 2/5、qwen-vl-ocr-2025-11-20 1/5、qwen3.5-ocr 单独出 JSON 0/5
 *
 * 结论：「专用 OCR 模型」逐字读还行，但让它一边认字一边理解表格（输出结构化）时明显不如通用视觉模型 ——
 * 小字会被读错（800px 那张把 2.5 读成 2.6）。所以**不要用 qwen-vl-ocr 系列做结构化**。
 *
 * 选 qwen3-vl-flash（无日期别名）而不是带日期的快照：两者 10 格完全打平、耗时也几乎一样，
 * 取滚动别名以保证长期可用；如果哪天需要完全可复现的行为，再换成 qwen3-vl-flash-2026-01-22。
 */
const MODEL_TEXT = 'qwen-flash';
const VISION_MODEL = 'qwen3-vl-flash';

const DOC_PROMPT = [
  '你是采购单据识别助手。从下面提供的单据里（可能是一段文字，也可能是一张单据图片）提取结构化信息。',
  '严格按单据上写的填，看不清或没有的字段一律填空字符串或 null，**不要编造**。',
  '字段说明：',
  '- supplier: 供应商/发货单位名称',
  '- orderNo: 单据号',
  '- date: YYYY-MM-DD，用单据上的日期；没有就用 __TODAY__',
  '- items: 明细数组，每行一项：',
  '  · name 品名（这一行买的是什么）',
  '  · category 品类：把这一行归到一个**简短**的品类里（2~5 个字，如「钢材」「五金」「电料」「包装」「办公」「劳保」「食品」）',
  '  · spec 规格型号（如材质、尺寸、型号）',
  '  · unit 单位（吨/件/米/公斤）',
  '  · qty 数量或重量（纯数字，不要带单位）',
  '  · price 单价（纯数字）',
  '  · amount 金额（纯数字；单据没写但 qty 和 price 都有，就用 qty×price 算出来）',
  '- total: 单据合计金额（纯数字；没有就用各行 amount 相加）',
  '只输出 JSON，不要任何解释：',
  '{"supplier":"","orderNo":"","date":"","total":0,"items":[{"name":"","category":"","spec":"","unit":"","qty":0,"price":0,"amount":0}]}',
  '注意：不要漏行，哪怕只有一行明细也照实输出。',
  '**如果这张单据上没有任何货物明细行（比如只是一份证明、一张只有总额的收据），items 必须是空数组 []，绝对不要用上面格式示例里的字段名去凑一行出来。**'
].join('\n');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 数字清洗：'3,800.00元' → 3800 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function str(v, max) {
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 100);
}

/* ---------------- 明细归一（快 / 慢两条路共用） ---------------- */

/**
 * 把模型给的 items 洗成统一形状。
 * 过滤规则：品名/数量/单价/金额 全都没有的行丢掉。
 * 2026-09-19 实测踩到过：偶发的模型会把 prompt 里的字段示例当成正文照抄，
 * 对一张没有明细的单据编出「螺纹钢 / 空规格 / 吨 / 0 / 0 / 0」这种全零行 ——
 * 老板在核对页看到会莫名其妙。所以只留「有品名且有数字」或「有金额」的行。
 */
function normalizeItems(rawItems) {
  return (Array.isArray(rawItems) ? rawItems : [])
    .map((it) => {
      const qty = num(it.qty);
      const price = num(it.price);
      let amount = num(it.amount);
      if (amount === null && qty !== null && price !== null) amount = Math.round(qty * price * 100) / 100;
      return {
        name: str(it.name, 100),
        category: str(it.category, 32),      // 品类：用于分类统计
        supplierName: str(it.supplierName || it.supplier_name, 100),  // 行级供应商（多张汇总时各行可能不同）
        sourceFileId: Number(it.sourceFileId || it.source_file_id) || null,
        spec: str(it.spec, 100),
        unit: str(it.unit, 16),
        qty,
        price,
        amount
      };
    })
    .filter((it) => {
      const hasMoney = it.amount !== null && it.amount !== 0;
      const hasQty = it.qty !== null && it.qty !== 0;
      const hasPrice = it.price !== null && it.price !== 0;
      if (hasMoney || hasQty || hasPrice) return true;
      return false;   // 全零行：既没有钱也没有数量，只可能是噪声或示例照抄
    })
    .map((it, i) => Object.assign({}, it, { seq: i + 1 }));
}

/** 组装对外返回的单据结构 */
function packDoc(parsed, items, content, today) {
  let total = num(parsed.total);
  if (total === null) total = Math.round(items.reduce((s, it) => s + (it.amount || 0), 0) * 100) / 100;
  return {
    supplier: str(parsed.supplier, 100),
    orderNo: str(parsed.orderNo, 64),
    date: dayOr(parsed.date, today),
    total,
    items,
    text: String(content || '').slice(0, 2000)   // 回显原文，方便老板核对
  };
}

/**
 * 快路：视觉模型一次调用直接把图变成结构化单据。
 *
 * 2026-09-19 实测（见文件顶部说明）：10 格通过数 8/10，而「OCR 取文 + 文本结构化」
 * 这条两次串行的慢路只有 6/10，且平均要多花 0.9 秒。所以快路是主路，慢路只在
 * 「模型压根没给出可解析的 JSON」时才兜底。
 *
 * 返回值刻意分成两态，因为这两种失败要区别对待：
 *   { status:'ok', doc }        → JSON 能解析，doc.items 可能就是空的（单据本来没明细）
 *   { status:'no-json' }        → 模型没给出可解析的 JSON，值得退回 OCR 再试一次
 * 「模型没认出来」和「这张单子本来就没明细」是两件事；后者再跑一遍 OCR 也还是空，
 * 白等 1.5~3.8 秒，不如直接如实告诉老板换个拍法。
 */
/**
 * 组装识别提示词，并把「这家店已经用过的品类」塞进去。
 * 不做这步的话，同一类东西会被叫成「钢材 / 钢铁 / 钢」，统计里就变成三样 ——
 * 复用 merchant_terms 的 kind='category' 做词表，越用越收敛。
 */
async function buildDocPrompt(userId, today) {
  let hint = '';
  try {
    const terms = await loadTerms(pool, userId, 'category');
    const cats = terms.map((t) => t.canonical).filter(Boolean).slice(0, 40);
    if (cats.length) hint = '\n这家店已经用过的品类（**优先从中选，尽量别造新的**）：' + cats.join('、');
  } catch (e) { /* 词表读不到就算了，不影响识别 */ }
  return DOC_PROMPT.replace('__TODAY__', today) + hint;
}

async function tryVisionDoc(filePath, format, prompt, today) {
  try {
    const raw = await callModel({
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: toDataUri(filePath, format, 'image') } },
          { type: 'text', text: prompt }
        ]
      }],
      temperature: 0.1
    }, 90000);
    const parsed = extractJson(raw);
    if (!parsed) return { status: 'no-json' };
    return { status: 'ok', doc: packDoc(parsed, normalizeItems(parsed.items), '', today) };
  } catch (err) {
    console.error('视觉单次解析未成功，准备退回 OCR 路:', err.response?.data || err.message);
    return { status: 'no-json' };
  }
}

/**
 * 单据 → 结构化采购单。三种入口：
 *   ① 图片 → 快路（视觉一次调用）；拿不到明细再退回 OCR + 文本结构化
 *   ② 纯文字 → 直接文本结构化
 */
router.post('/parse-doc', auth, async (req, res) => {
  const { fileUrl, text } = req.body;
  const today = todayStr();

  try {
    let content = str(text, 8000);
    // 提示词要在外层组装：图片走快路、文字走结构化，两条路都要用它。
    // （第一版把它声明在 if 块里，结果文字入口直接 ReferenceError 报 500 —— 探测抓到的。）
    const prompt = await buildDocPrompt(req.userId, today);

    if (!content && fileUrl) {
      const filePath = resolveUpload(fileUrl);
      if (!filePath) return res.json({ code: 400, msg: '文件不存在或路径不合法' });
      const { kind, format } = detectKind(filePath);
      if (kind !== 'image') return res.json({ code: 400, msg: '不是图片文件' });

      // ① 快路：一次调用出结果。JSON 能解析就交卷 —— 哪怕明细是空的，
      //    那是「这张单子本来就没明细」，再跑 OCR 也是空，白等几秒。
      const v = await tryVisionDoc(filePath, format, prompt, today);
      if (v.status === 'ok') return res.json({ code: 0, data: v.doc });

      // ② 兜底：模型没给出可解析的 JSON（偶发），退回「OCR 取文 → 文本结构化」两次串行
      content = cleanOcrText(await callModel({
        model: OCR_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: toDataUri(filePath, format, 'image') } },
            {
              type: 'text',
              text: '这是一张采购/送货单据。把上面所有文字和表格原样读出来，保留每一行的品名、规格、数量、单价、金额，以及单据号和日期。只输出文字，不要解释，不要用 LaTeX 公式包裹。'
            }
          ]
        }]
      }, 120000));
    }

    if (!content) return res.json({ code: 400, msg: '没有可识别的内容' });

    const raw = await callModel({
      model: MODEL_TEXT,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: content }
      ],
      temperature: 0.1
    }, 60000);

    const parsed = extractJson(raw) || {};
    res.json({ code: 0, data: packDoc(parsed, normalizeItems(parsed.items), content, today) });
  } catch (err) {
    console.error('单据解析错误:', err.response?.data || err.message);
    res.json({ code: 500, msg: '单据识别失败' });
  }
});

/** 保存采购单（表头 + 明细） */
router.post('/save', auth, async (req, res) => {
  const { supplier, orderNo, date, items, fileId, fileIds, remark } = req.body;
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return res.json({ code: 400, msg: '没有明细，无法保存' });

  // 多张单据汇总时前端会带 fileIds 数组；单张时只有 fileId。
  // 统一成逗号分隔存在 source_file_ids，第一张同时写入 source_file_id（保持老字段可用）。
  const idList = (Array.isArray(fileIds) ? fileIds : [fileId])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
    .slice(0, 20);
  const sourceFileId = idList.length ? idList[0] : (Number(fileId) || null);
  const sourceFileIds = idList.length ? idList.join(',') : null;

  const clean = rows
    .map((it, i) => {
      const qty = num(it.qty);
      const price = num(it.price);
      let amount = num(it.amount);
      if (amount === null && qty !== null && price !== null) amount = Math.round(qty * price * 100) / 100;
      return {
        seq: i + 1,
        name: str(it.name, 100) || '未填写品名',
        // 行级维度：多张单据汇总时，各行可能来自不同供应商，必须逐行记下来
        supplierName: str(it.supplierName || it.supplier_name, 100) || supplierName,
        category: str(it.category, 32),
        sourceFileId: Number(it.sourceFileId || it.source_file_id) || null,
        spec: str(it.spec, 100),
        unit: str(it.unit, 16),
        qty,
        price,
        amount: amount || 0,
        remark: str(it.remark, 255)
      };
    })
    .filter((it) => it.name || it.amount);

  if (!clean.length) return res.json({ code: 400, msg: '没有有效明细' });

  const total = Math.round(clean.reduce((s, it) => s + (it.amount || 0), 0) * 100) / 100;
  const supplierName = str(supplier, 100);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const contactId = supplierName
      ? await ensureContact(conn, req.userId, supplierName, 2) // 供应商
      : null;

    const [r] = await conn.query(
      'INSERT INTO purchase_orders (user_id, supplier_name, contact_id, order_no, order_date, total_amount, item_count, source_file_id, source_file_ids, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.userId, supplierName || null, contactId, str(orderNo, 64) || null, date || todayStr(), total, clean.length, sourceFileId, sourceFileIds, str(remark, 255) || null]
    );
    const orderId = r.insertId;

    for (const it of clean) {
      await conn.query(
        'INSERT INTO purchase_items (order_id, user_id, seq, item_name, supplier_name, category, source_file_id, spec, unit, qty, unit_price, amount, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [orderId, req.userId, it.seq, it.name, it.supplierName || null, it.category || null, it.sourceFileId, it.spec || null, it.unit || null, it.qty, it.price, it.amount, it.remark || null]
      );
    }

    // 把这次见到的品类沉淀进商家词表（kind='category'）——
    // 下次解析时把它作为「优先使用的品类」喂给模型，避免「钢材/钢铁/钢」把统计拆成三类。
    for (const cat of [...new Set(clean.map((x) => x.category).filter(Boolean))]) {
      try {
        await upsertTerm(conn, req.userId, 'category', cat, cat, null, 'auto');
      } catch (e) {
        /* 词表积累失败不能影响入库 */
      }
    }

    // 同时落一笔支出流水，这样日报/报表能直接看到这笔采购
    await conn.query(
      'INSERT INTO transactions (user_id, contact_id, type, amount, content, record_date, status, created_by) VALUES (?, ?, 2, ?, ?, ?, 1, ?)',
      [req.userId, contactId, total, '采购：' + clean[0].name + (clean.length > 1 ? ' 等 ' + clean.length + ' 项' : ''), date || todayStr(), req.userId]
    );

    await conn.commit();
    res.json({ code: 0, msg: '采购单已保存', data: { orderId, total, itemCount: clean.length } });
  } catch (err) {
    await conn.rollback();
    console.error('采购单保存错误:', err.message);
    res.json({ code: 500, msg: '保存失败' });
  } finally {
    conn.release();
  }
});

/** 采购单列表 */
router.get('/list', auth, async (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(size);
  try {
    const [rows] = await pool.query(
      // DATE_FORMAT 直接取字符串：mysql2 会把 DATE 转成 JS Date，JSON 序列化后变 UTC，
      // 在 +8 时区就会显示成前一天。format.js 的 dayKey 也能救，但源头取字符串更省事。
      "SELECT id, supplier_name, order_no, DATE_FORMAT(order_date, '%Y-%m-%d') AS order_date, total_amount, item_count, created_at FROM purchase_orders WHERE user_id = ? ORDER BY order_date DESC, id DESC LIMIT ? OFFSET ?",
      [req.userId, parseInt(size), parseInt(offset)]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: '获取采购单列表失败' });
  }
});

/** 采购单详情（含明细） */
router.get('/detail', auth, async (req, res) => {
  const { id } = req.query;
  if (!id) return res.json({ code: 400, msg: '缺少 id' });
  try {
    const [orders] = await pool.query(
      // 显式列清单的代价：加了新字段必须同步加到这里，否则写进去了也读不出来
      // （2026-09-19 就是漏了 source_file_ids，探测才发现）
      "SELECT id, user_id, supplier_name, contact_id, order_no, DATE_FORMAT(order_date, '%Y-%m-%d') AS order_date, total_amount, item_count, source_file_id, source_file_ids, remark, created_at FROM purchase_orders WHERE id = ? AND user_id = ?",
      [id, req.userId]
    );
    if (!orders.length) return res.json({ code: 404, msg: '单据不存在' });
    const [items] = await pool.query(
      'SELECT id, order_id, seq, item_name, supplier_name, category, source_file_id, spec, unit, qty, unit_price, amount, remark FROM purchase_items WHERE order_id = ? ORDER BY seq',
      [id]
    );
    res.json({ code: 0, data: { order: orders[0], items } });
  } catch (err) {
    res.json({ code: 500, msg: '获取单据详情失败' });
  }
});

/**
 * 分类统计。
 *
 * 为什么要这个接口：老板要求「记录时合并成一张，但可按供应商统计、按品类统计」。
 * 合并成一张采购单是对的（一笔账），但那样明细里就丢掉了来源维度 ——
 * 所以明细行上单独存了 `supplier_name` 和 `category`，统计走明细行而不是表头。
 *
 * 参数：from / to（YYYY-MM-DD，可选，默认近 30 天）、groupBy（supplier|category）
 * 返回：按金额倒序的分组 [{ key, amount, count, orders }]
 *   · orders = 涉及多少张采购单（按供应商统计时，同一个供应商可能散在好几张单子里）
 */
router.get('/stats', auth, async (req, res) => {
  const groupBy = req.query.groupBy === 'category' ? 'category' : 'supplier';
  const col = groupBy === 'category' ? 'i.category' : 'i.supplier_name';

  const today = todayStr();
  const defFrom = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  })();
  const from = dayOr(req.query.from, defFrom);
  const to = dayOr(req.query.to, today);

  try {
    const [rows] = await pool.query(
      'SELECT ' + col + ' AS k, SUM(i.amount) AS amt, COUNT(*) AS cnt, COUNT(DISTINCT i.order_id) AS orders ' +
      'FROM purchase_items i JOIN purchase_orders o ON o.id = i.order_id ' +
      'WHERE i.user_id = ? AND o.order_date BETWEEN ? AND ? ' +
      'GROUP BY ' + col + ' ORDER BY amt DESC LIMIT 50',
      [req.userId, from, to]
    );

    const list = rows.map((r) => ({
      // 供应商或品类为空的归到「未分类」，不要悄悄丢掉 —— 数字必须能对上总数
      key: String(r.k || '').trim() || '未分类',
      amount: Math.round(Number(r.amt || 0) * 100) / 100,
      count: Number(r.cnt) || 0,
      orders: Number(r.orders) || 0
    }));
    const total = Math.round(list.reduce((s, x) => s + x.amount, 0) * 100) / 100;

    res.json({ code: 0, data: { groupBy, from, to, total, list } });
  } catch (err) {
    console.error('采购统计错误:', err && err.message);
    res.json({ code: 500, msg: '获取统计失败' });
  }
});

module.exports = router;
