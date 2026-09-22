// lib/ledger.js —— 共享工具：文件解析、多模态调用、往来余额维护
const fs = require('fs');
const path = require('path');
const axios = require('axios');

/* ---------------- 上传文件解析 ---------------- */

const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'pcm', 'amr', 'silk'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];

/**
 * 把客户端传来的 fileUrl（形如 /uploads/xxx.mp3）安全解析成本地绝对路径。
 * 上传目录没有对外暴露静态服务，所以只能本地读；这也意味着必须防目录穿越。
 */
function resolveUpload(fileUrl) {
  if (!fileUrl) return null;
  const name = path.basename(String(fileUrl).split('?')[0].split('#')[0]);
  if (!name || name === '.' || name === '..') return null;
  const dir = path.resolve(process.env.UPLOAD_DIR || './uploads');
  const full = path.join(dir, name);
  if (path.dirname(full) !== dir) return null;
  return fs.existsSync(full) ? full : null;
}

/** 识别文件类别 + 扩展名 */
function detectKind(filePath) {
  const ext = String(filePath).split('.').pop().toLowerCase();
  if (AUDIO_EXT.includes(ext)) return { kind: 'audio', format: ext };
  if (IMAGE_EXT.includes(ext)) return { kind: 'image', format: ext };
  return { kind: 'unknown', format: ext };
}

/**
 * 读文件转 data URI。
 * 专属 MaaS 网关要求必须带 data: 前缀（实测纯 base64 会报 "URL does not appear to be valid"），
 * 同时这样也避免把用户票据暴露成公网可访问的 URL。
 */
function toDataUri(filePath, format, kind) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  const audioMime = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', pcm: 'audio/L16', amr: 'audio/amr', silk: 'audio/silk' };
  const imageMime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp' };
  const mime = (kind === 'audio' ? audioMime : imageMime)[format] || 'application/octet-stream';
  return 'data:' + mime + ';base64,' + b64;
}

/* ---------------- 大模型调用 ---------------- */

function aiHeaders() {
  return {
    Authorization: 'Bearer ' + process.env.DASHSCOPE_API_KEY,
    'Content-Type': 'application/json'
  };
}

/** OpenAI 兼容接口的统一调用；多模态与纯文本共用 */
async function callModel(body, timeout = 90000) {
  const res = await axios.post(
    process.env.DASHSCOPE_BASE_URL + '/chat/completions',
    body,
    { headers: aiHeaders(), timeout }
  );
  const msg = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message;
  const content = msg && msg.content;
  if (typeof content === 'string') return content;
  // 部分多模态模型返回分段数组
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  return '';
}

/** 从模型回复里抠出 JSON（容忍 ```json 包裹和前后废话） */
function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    /* 继续尝试截取 */
  }
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(cleaned.slice(s, e + 1));
    } catch (err) {
      return null;
    }
  }
  return null;
}

/* ---------------- 往来余额维护 ----------------
 * 账本语义（与 contacts.balance 的既有约定一致）：
 *   balance > 0 → 别人欠我；balance < 0 → 我欠别人
 *   应收(3) +、回款(5) -、应付(4) -、付款(6) +
 *   收入(1)/支出(2) 是现金流水，不影响往来余额
 * 原来这张表从来没人维护，所以应收应付永远显示 0。
 */
async function recalcBalance(pool, userId, contactId) {
  if (!contactId) return null;
  const [rows] = await pool.query(
    `SELECT
        COALESCE(SUM(CASE WHEN type = 3 THEN amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN type = 5 THEN amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN type = 4 THEN amount ELSE 0 END), 0)
      + COALESCE(SUM(CASE WHEN type = 6 THEN amount ELSE 0 END), 0) AS bal
     FROM transactions
     WHERE user_id = ? AND contact_id = ? AND status = 1`,
    [userId, contactId]
  );
  const bal = Number((rows[0] && rows[0].bal) || 0);
  await pool.query('UPDATE contacts SET balance = ? WHERE id = ? AND user_id = ?', [bal, contactId, userId]);
  return bal;
}

/** 按名字找往来对象，找不到就建一个（AI 只给名字，后端只认 id） */
async function ensureContact(pool, userId, name, typeHint) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const [found] = await pool.query(
    'SELECT id FROM contacts WHERE user_id = ? AND name = ? LIMIT 1',
    [userId, clean]
  );
  if (found.length) return found[0].id;
  const type = [1, 3, 5].includes(Number(typeHint)) ? 1 : 2; // 收/回款类 → 客户；付/支类 → 供应商
  const [ins] = await pool.query(
    'INSERT INTO contacts (user_id, name, type, balance) VALUES (?, ?, ?, 0)',
    [userId, clean.slice(0, 100), type]
  );
  return ins.insertId;
}

/* ---------------- OCR 文本清洗 ---------------- */

/**
 * 清洗 OCR 模型的原始输出。
 * 实测 qwen3.5-ocr 有时会把整段用 LaTeX 包起来，例如真机那张单子出来的是
 *   `\displaylines{上海华博商贸有限公司\\ 兹收到贵公司提供的货物，\`
 * 这些控制符如果原样喂给结构化模型，会被当成正文，直接污染 supplier / 品名，
 * 也会原样回显给老板看（前端「没认出明细」时会带着原文）。所以统一在出口清一遍。
 */
function cleanOcrText(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/\\displaylines\s*\{/g, '');
  s = s.replace(/\\(?:begin|end)\s*\{[^}]*\}/g, '');
  s = s.replace(/\\\[|\\\]|\$\$/g, '');
  s = s.replace(/\\\\/g, '\n');            // LaTeX 里的换行是 \\
  s = s.replace(/\\[a-zA-Z]+\s*/g, ' ');   // 其余控制序列（\text 之类）
  s = s.replace(/\\/g, '');                // 清掉没有配对控制序列的孤立反斜杠
  s = s.replace(/[{}]/g, '');              // 清掉包裹用的花括号
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

module.exports = {
  resolveUpload,
  detectKind,
  toDataUri,
  callModel,
  extractJson,
  cleanOcrText,
  recalcBalance,
  ensureContact
};
