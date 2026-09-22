// lib/memory.js —— 商家记忆层
// 「越用越懂商家」的载体不是向量库，而是这张词表 + 纠正回流：
//   ① 老板怎么称呼客户（张哥 / 老张 / 张老板）→ 归一到同一个往来对象
//   ② 老板的纠正（AI 认错了，他改成什么）→ 立刻变成下次的知识
// 账本的数据是结构化的，走 SQL；只有"人怎么说话"这件事需要单独记。
const { ensureContact } = require('./ledger');

/* ---------------- 词表读写 ---------------- */

/** 取该用户的词表（按 kind 分组返回，便于按需用） */
async function loadTerms(pool, userId, kind) {
  const sql = kind
    ? 'SELECT id, kind, alias, canonical, ref_id FROM merchant_terms WHERE user_id = ? AND kind = ?'
    : 'SELECT id, kind, alias, canonical, ref_id FROM merchant_terms WHERE user_id = ?';
  const params = kind ? [userId, kind] : [userId];
  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * 把用户原话里的别名替换成标准名。
 * 长别名优先，避免「张」把「张老板」截断；单字别名一律不用（误伤太大）。
 */
function normalizeText(text, terms) {
  let out = String(text || '');
  const hits = [];
  terms
    .filter((t) => t.alias && t.canonical && t.alias !== t.canonical && String(t.alias).length >= 2)
    .sort((a, b) => String(b.alias).length - String(a.alias).length)
    .forEach((t) => {
      if (out.indexOf(t.alias) < 0) return;
      out = out.split(t.alias).join(t.canonical);
      hits.push(t.alias + '→' + t.canonical);
    });
  return { text: out, hits };
}

/** 把 AI 给出的名字也对回标准名（AI 可能输出的是老板口中的叫法） */
function canonicalizeName(name, terms) {
  const n = String(name || '').trim();
  if (!n) return '';
  const hit = terms.find((t) => t.alias === n && t.canonical);
  return hit ? hit.canonical : n;
}

/**
 * 写一条词条。
 * source='user' 表示来自老板纠正，优先级高于自动积累 —— 只有它能覆盖 canonical。
 */
async function upsertTerm(pool, userId, kind, alias, canonical, refId, source) {
  const a = String(alias || '').trim().slice(0, 64);
  const c = String(canonical || '').trim().slice(0, 64);
  if (!a || !c) return false;

  const [rows] = await pool.query(
    'SELECT id, source FROM merchant_terms WHERE user_id = ? AND kind = ? AND alias = ? LIMIT 1',
    [userId, kind, a]
  );

  if (rows.length) {
    const row = rows[0];
    const canOverride = source === 'user' && row.source !== 'user';
    await pool.query(
      'UPDATE merchant_terms SET hits = hits + 1, canonical = ?, source = ?, ref_id = COALESCE(?, ref_id) WHERE id = ?',
      [canOverride || row.source !== 'user' ? c : row.canonical, canOverride ? 'user' : row.source, refId || null, row.id]
    );
    return false;
  }

  await pool.query(
    'INSERT INTO merchant_terms (user_id, kind, alias, canonical, ref_id, source) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, kind, a, c, refId || null, source || 'auto']
  );
  return true;
}

/* ---------------- 自动积累 ---------------- */

/** AI 解析出来的新名字/新事由，直接沉淀进词表（下次不用再靠模型猜） */
async function learnFromParse(pool, userId, records) {
  const learned = [];
  for (const r of records) {
    if (r.contactName) {
      const refId = await ensureContact(pool, userId, r.contactName, r.type);
      const isNew = await upsertTerm(pool, userId, 'contact', r.contactName, r.contactName, refId, 'auto');
      if (isNew) learned.push('往来对象「' + r.contactName + '」');
    }
    if (r.content) {
      await upsertTerm(pool, userId, 'reason', r.content, r.content, null, 'auto');
    }
  }
  return learned;
}

/* ---------------- 纠正回流（"越用越懂"的引擎） ---------------- */

/**
 * 老板点了「改一下」并保存 —— 这是最有价值的一次学习：
 * 他把 AI 的错答案改成了对的，这个映射必须留下来。
 */
async function learnFromCorrection(pool, userId, sourceText, aiResult, userResult, transactionId) {
  const learned = [];

  const aiName = String((aiResult && aiResult.contactName) || '').trim();
  const userName = String((userResult && userResult.contactName) || '').trim();
  const said = String(sourceText || '');

  // 改对了往来对象，且原话里确实出现了 AI 那个叫法 → 学一条「别名→标准名」
  if (userName && aiName && userName !== aiName && said && said.indexOf(aiName) >= 0) {
    const refId = await ensureContact(pool, userId, userName, userResult.type);
    await upsertTerm(pool, userId, 'contact', aiName, userName, refId, 'user');
    learned.push(aiName + ' → ' + userName);
  }

  // 事由被改写，也记一份，用于以后推荐
  const aiContent = String((aiResult && aiResult.content) || '').trim();
  const userContent = String((userResult && userResult.content) || '').trim();
  if (userContent && userContent !== aiContent) {
    await upsertTerm(pool, userId, 'reason', userContent, userContent, null, 'user');
    learned.push('事由「' + userContent + '」');
  }
  // 类型被改正，同样值得记（虽然不属于词表，但进纠正流水）
  if (Number(userResult.type) && Number(userResult.type) !== Number(aiResult.type)) {
    learned.push('类型 ' + (aiResult.type || '?') + ' → ' + userResult.type);
  }

  await pool.query(
    'INSERT INTO ai_corrections (user_id, transaction_id, source_text, ai_result, user_result, learned) VALUES (?, ?, ?, ?, ?, ?)',
    [
      userId,
      transactionId || null,
      said.slice(0, 500),
      JSON.stringify(aiResult || {}),
      JSON.stringify(userResult || {}),
      learned.join('；') || null
    ]
  );

  return learned;
}

/** 该用户的常用事由（给"事由为空时补一个"用） */
async function topReasons(pool, userId, limit) {
  const [rows] = await pool.query(
    'SELECT canonical, hits FROM merchant_terms WHERE user_id = ? AND kind = ? ORDER BY hits DESC LIMIT ?',
    [userId, 'reason', limit || 8]
  );
  return rows.map((r) => r.canonical);
}

module.exports = {
  loadTerms,
  normalizeText,
  canonicalizeName,
  upsertTerm,
  learnFromParse,
  learnFromCorrection,
  topReasons
};
