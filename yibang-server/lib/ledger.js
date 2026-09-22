// lib/ledger.js —— 共享工具：文件解析、多模态调用、往来余额维护
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const log = require('./log');

/* ---------------- 上传文件解析 ---------------- */

const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'pcm', 'amr', 'silk'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];

/**
 * 把客户端传来的 fileUrl 解析成可读取的文件标识。
 * 2026-09-21 改造：文件已迁到 OSS，返回 oss:// 开头的虚拟路径；
 * 兼容旧的本地文件（如果还存在）。
 */
function resolveUpload(fileUrl) {
  if (!fileUrl) return null;
  const url = String(fileUrl).split('?')[0].split('#')[0];

  // 新的 OSS URL：https://yibang-ledger.oss-cn-beijing.aliyuncs.com/uploads/xxx.mp3
  if (url.startsWith('http')) {
    try {
      const u = new URL(url);
      const objectName = u.pathname.slice(1); // 去掉开头的 /
      if (objectName.startsWith('uploads/')) {
        return 'oss://' + objectName;
      }
    } catch (e) {
      return null;
    }
  }

  // 旧的本地路径：/uploads/xxx.mp3
  const name = path.basename(url);
  if (!name || name === '.' || name === '..') return null;
  const dir = path.resolve(process.env.UPLOAD_DIR || './uploads');
  const full = path.join(dir, name);
  if (path.dirname(full) !== dir) return null;
  if (fs.existsSync(full)) return full; // 旧文件还在本地

  // 本地文件不存在，试试 OSS
  return 'oss://uploads/' + name;
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
 * 2026-09-21 改造：支持从 OSS 读取文件（oss:// 开头），兼容本地文件。
 */
async function toDataUri(filePath, format, kind) {
  let buffer;

  if (filePath.startsWith('oss://')) {
    // 从 OSS 下载
    const oss = require('./oss');
    const objectName = filePath.slice(6); // 去掉 oss://
    buffer = await oss.getBuffer(objectName);
  } else {
    // 本地文件
    buffer = fs.readFileSync(filePath);
  }

  const b64 = buffer.toString('base64');
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
/**
 * 记账账号解析 —— 「员工录的账要等老板审」（2026-09-23 用户定的产品口径）。
 *
 * 背景：`users.boss_id` 指向老板。路由 `/staff/pending` 查的是
 * `user_id = 老板id AND status = 0`，所以员工录的账**本来就该落在老板账下**：
 *   ① `user_id` = 老板的 id（否则老板的报表算不进去，员工记的账等于没记）
 *   ② `status` = 0 待审（老板审过才入账）
 *   ③ `created_by` = 员工自己的 id（老板知道是谁录的）
 * `boss_id` 为空 = 本人就是老板 → 照旧：落自己账下、status=1 直接入账。
 *
 * ⚠️ **失败时"放行"而不是"拦住"**：这条查询要是撞上瞬时故障，
 *    宁可退回"本人记账、直接入账"（= 现在的行为），也不能让**记账整个失败** ——
 *    这个产品的第一原则是"说一声就记上"，为此牺牲一次归属准确性是可以接受的
 *    （事后能从 created_by 和 pm2 日志看出来）。反过来拦住的话，
 *    老板会发现"记不上了"，那是比归属错更严重的问题。
 *
 * @returns {Promise<{ownerId:number, isStaff:boolean, status:number}>}
 */
async function resolveAccount(pool, userId) {
  try {
    const [rows] = await pool.query('SELECT boss_id FROM users WHERE id = ? LIMIT 1', [userId]);
    const bossId = rows && rows.length ? rows[0].boss_id : null;
    if (bossId) return { ownerId: Number(bossId), isStaff: true, status: 0 };
  } catch (e) {
    log.error('[resolveAccount] 查 boss_id 失败，按本人账号放行:', e && e.message);
  }
  return { ownerId: userId, isStaff: false, status: 1 };
}

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

/**
 * YYYY-MM-DD 校验。
 *
 * 只测格式是不够的：'2026-13-99' 和 '2026-02-30' 都能过 `^\d{4}-\d{2}-\d{2}$`，
 * 但直接丢给 MySQL 的 DATE 比较或写入会报错，接口就返回 500 ——
 * 一个参数写错，整条请求被打死，用户看到的是"服务出错"，跟他的操作毫无关系。
 *
 * 所以回读比对一次：`new Date('2026-02-30')` 会被悄悄滚到 3 月 2 日，回读就不相等了。
 */
function isDay(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return false;
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) === s;
}

/** 合法就返回它，否则返回兜底值 —— 让调用处一行写完，别每处都写三目 */
function dayOr(v, fallback) {
  return isDay(v) ? String(v).trim() : fallback;
}

/** 月份同理：'2026-13' 过得了正则，过不了 MySQL */
function isMonth(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5));
  return m >= 1 && m <= 12;
}

/* ------------------------------------------------------------------ *
 * 记账参数的归一化与校验（2026-09-20 端到端测试后补）
 *
 * 为什么单独抽出来：`/record/create` 和 `/record/update` 原本各写一遍
 * `Number(type) || TYPE_CODE[...] || 2`，这个写法对 99 / -1 会**原样放行**
 * （Number(99) 是 99，truthy，直接用了）。实测确认 type=99、type=-1 都能入库，
 * 后果是：汇总时归不到任何一类、recalcBalance 算余额时也不算它、前端显示成未知类型
 * —— 报表数字错了，而用户完全看不出原因。
 *
 * 原则：**归一化负责"变干净"，校验负责"该拒就拒"**，两件事分开，
 * 调用处一眼能看出哪里是拒绝。
 * ------------------------------------------------------------------ */

/** 用户/AI 传来的数字：'¥500'、'500元'、500 都要能认，认不出返回 null */
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
 *
 * 2026-09-20 从 routes/record.js 挪到这里：normAmount 要用它，而它是纯函数。
 * 留在路由里的后果是 update 漏了这道验算（之前只有 create 有）。
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

const VALID_TYPES = [1, 2, 3, 4, 5, 6];
const TYPE_CODE = { 收入: 1, 支出: 2, 应收: 3, 应付: 4, 回款: 5, 付款: 6 };

/** 账目类型归一。返回 null 表示不合法，调用方应拒绝 */
function normType(v) {
  const n = Number(v);
  if (VALID_TYPES.indexOf(n) >= 0) return n;
  return TYPE_CODE[String(v == null ? '' : v).trim()] || null;
}

/**
 * 品类归一（2026-09-22）。
 *
 * 与 normType 的关键差别：**品类是自由文本，不是封闭枚举**。
 * type 只有 6 个合法值，非法就拒；但老板说得出「五金」「电料」「买菜」，
 * 也可能说出我们没见过的词 —— 用白名单校验会把他的真实业务挡在门外。
 * 所以这里只做"把脏东西收拾干净"：去首尾空白、把连续空白压成一个、限长 32。
 *
 * 返回 null 表示"这条账没有品类"，是合法状态（老数据、或确实归纳不出）。
 * 注意：不返回空字符串 —— 空串进 MySQL 会变成 ''，统计里就会多出一个叫 "" 的分组，
 * 与"未分类"看起来像两回事，实际上是一回事。
 */
function normCategory(v) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > 32 ? s.slice(0, 32) : s;
}

// DECIMAL(10,2)：最多 8 位整数 + 2 位小数。超出会被 MySQL 悄悄截断，
// 用户存 999999999.99 拿回去变成 99999999.99 —— 数字对不上。
const AMOUNT_MIN = 0.01;
const AMOUNT_MAX = 99999999.99;

/** 金额归一到 [0.01, 99999999.99]。返回 { ok, amount, fixed, why } */
function normAmount(raw, qty, unitPrice) {
  // 用 num() 而不是 Number()：'¥500' 这种带符号的字符串 Number 出来是 NaN
  const fixed = reconcileAmount(num(raw), num(qty), num(unitPrice));
  const amt = Math.abs(Number(fixed.amount) || 0);
  if (!amt) return { ok: false, amount: 0, why: '金额不能为 0' };
  if (amt < AMOUNT_MIN) return { ok: false, amount: amt, why: '金额不能少于 0.01 元（分以下存不进去）' };
  if (amt > AMOUNT_MAX) return { ok: false, amount: amt, why: '金额过大（最多 ' + AMOUNT_MAX.toFixed(2) + ' 元）' };
  return { ok: true, amount: amt, fixed: fixed };
}

/* ---------------- 营业日计算 ---------------- */

/**
 * 本地日期 → 'YYYY-MM-DD'
 *
 * 🔴 **绝不能用 `date.toISOString().slice(0,10)` 代替它。**
 * 服务器时区是 UTC+8，而 `toISOString()` 会先转成 UTC：
 * 本地 2026-09-19 00:00 → `2026-09-18T16:00:00Z` → 切出来是 **09-18，少一天**。
 * 实测后果：`getBusinessDate` 在**早上 8 点前**返回前一天 ——
 * 早餐店/早市老板早上记账，账会落到昨天（2026-09-22 修）。
 *
 * 同理，从 MySQL 拿到的 DATE 是**本地时间的 Date 对象**，
 * `String(它).slice(0,10)` 得到的是 `"Sat Sep 19"` 这种串，不是日期。
 * **数据库侧一律用 `DATE_FORMAT(col,'%Y-%m-%d')` 取字符串**，不要拿 Date 对象自己拼。
 */
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 本地时间 → 'YYYY-MM-DD HH:mm:ss'（导出、日志用）
 * 和 ymd 是同一个理由：**不要用 toISOString()** ——
 * 它会把本地时间减 8 小时，导出表里的"记录时间"会集体早 8 小时。
 */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return ymd(d) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 根据营业日截止时间，计算当前时间属于哪个营业日
 * @param {Date} now - 当前时间
 * @param {string} endTime - 营业日截止时间，格式 "HH:mm"，如 "02:00"
 * @returns {string} 营业日日期，格式 "YYYY-MM-DD"
 */
function getBusinessDate(now, endTime) {
  if (!endTime || endTime === '00:00') {
    return ymd(now);
  }
  const parts = String(endTime).split(':');
  const endHour = parseInt(parts[0], 10) || 0;
  const endMin = parseInt(parts[1], 10) || 0;
  
  const nowHour = now.getHours();
  const nowMin = now.getMinutes();
  
  // 如果当前时间在截止时间之前（比如凌晨1点，截止时间是凌晨2点），算前一天
  if (nowHour < endHour || (nowHour === endHour && nowMin < endMin)) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return ymd(yesterday);
  }
  return ymd(now);
}

/**
 * 获取某个营业日的时间范围（用于报表查询）
 * @param {string} date - 营业日日期，格式 "YYYY-MM-DD"
 * @param {string} endTime - 营业日截止时间，格式 "HH:mm"
 * @returns {Object} { from: "YYYY-MM-DD HH:mm:ss", to: "YYYY-MM-DD HH:mm:ss" }
 */
function getBusinessDateRange(date, endTime) {
  if (!endTime || endTime === '00:00') {
    return { from: date + ' 00:00:00', to: date + ' 23:59:59' };
  }
  // 营业日 = 当天截止时间之后 到 第二天截止时间之前
  // 比如截止时间02:00，营业日9月22日 = 9月22日02:00:00 到 9月23日01:59:59
  const from = date + ' ' + endTime + ':00';
  const nextDay = new Date(date + 'T00:00:00');
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = ymd(nextDay);     // ⚠️ 不能用 toISOString：会少一天（见 ymd 的注释）
  const parts = String(endTime).split(':');
  const endHour = parseInt(parts[0], 10) || 0;
  const endMin = parseInt(parts[1], 10) || 0;
  // 截止时间前1秒
  let toMin = endMin - 1;
  let toHour = endHour;
  if (toMin < 0) { toMin = 59; toHour -= 1; }
  const toHourStr = String(toHour).padStart(2, '0');
  const toMinStr = String(toMin).padStart(2, '0');
  const to = nextDayStr + ' ' + toHourStr + ':' + toMinStr + ':59';
  return { from, to };
}

module.exports = {
  resolveUpload,
  detectKind,
  toDataUri,
  callModel,
  extractJson,
  cleanOcrText,
  recalcBalance,
  resolveAccount,
  ensureContact,
  isDay,
  dayOr,
  isMonth,
  ymd,
  stamp,
  // 2026-09-23 补导出：这个函数出过真实的线上 bug（早 8 点前记账落到前一天），
  // 而它原来没导出 → 测不到 ✗。**出过事的函数必须能被测。**
  getBusinessDate,
  normType,
  normCategory,
  normAmount,
  num,
  round2,
  reconcileAmount,
  VALID_TYPES,
  TYPE_CODE,
  AMOUNT_MIN,
  AMOUNT_MAX
};
