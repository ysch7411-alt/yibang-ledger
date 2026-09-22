/**
 * AI 接口用户级限流（2026-09-21 新增）
 *
 * 为什么用内存而不是 redis：和记账去重一样的道理 —— 这是一个几十行的兜底，
 * 不值得为它多加一次网络往返（redis 那一次往返比 INSERT 本身还贵）。
 * 进程重启后计数清零，最坏情况是重启后某用户当天的额度重置一次 —— 可接受。
 *
 * 限流维度：每个用户每天每个接口类型限 N 次。
 * 免费版额度：
 *   - 语音记账（asr + parse）：50 次/天
 *   - 图片识别（vision + parse-doc）：20 次/天
 *   - AI 问答（chat）：30 次/天
 *
 * 后续要做付费版时，把 plan_type 传进来，不同套餐给不同额度就行。
 */

// 接口类型 → 每天限多少次
const QUOTAS = {
  voice: 50,       // 语音识别（/ai/asr）
  vision: 20,      // 图片识别（/ai/vision、/purchase/parse-doc）
  chat: 30,        // AI 问答（/ai/chat）
  /* 2026-09-22 审查补上：`/record/ai-parse` 是**调用最频繁**的 AI 接口
     （每次语音或打字记账都走它），但原来既没有 aiLimit 也没有 bumpCount —— **完全没有限流**。
     配额给到 80：正常老板一天记 20~30 笔，离 80 还远；
     而一个恶意账号最多也只能刷 80 次，模型预算烧不穿。 */
  parse: 80        // 记账文本结构化（/record/ai-parse）
};

// key: `${userId}:${type}:${dateStr}` → count
const counters = new Map();

/**
 * 清理过期计数（每天凌晨自然过期，这里做个兜底清理）
 * 超过 1000 条就顺手扫掉过期的，防止内存无限涨
 */
function gc() {
  if (counters.size < 1000) return;
  const today = todayStr();
  for (const [key] of counters) {
    const date = key.split(':')[2];
    if (date !== today) counters.delete(key);
  }
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/**
 * 限流中间件工厂。
 * @param {string} type - 接口类型：voice / vision / chat
 * @returns {function} Express 中间件
 *
 * 用法：router.post('/asr', auth, aiLimit('voice'), async (req, res) => { ... })
 */
function aiLimit(type) {
  const quota = QUOTAS[type] || 30;

  return function (req, res, next) {
    const userId = req.userId;
    if (!userId) return next(); // 没登录的交给 auth 处理

    gc();

    const today = todayStr();
    const key = userId + ':' + type + ':' + today;
    const used = counters.get(key) || 0;

    if (used >= quota) {
      return res.json({
        code: 429,
        msg: '今天的免费额度用完了，明天再来吧',
        data: { used, quota, type }
      });
    }

    // 预占名额（实际调用成功后才真正计数，失败了扣回来）
    req._aiLimit = { key, type, quota };
    next();
  };
}

/**
 * 调用成功后计数+1。在路由处理器里调用。
 */
function bumpCount(req) {
  if (!req._aiLimit) return;
  const { key } = req._aiLimit;
  counters.set(key, (counters.get(key) || 0) + 1);
}

/**
 * 调用失败，把预占的名额扣回来。
 */
function rollbackCount(req) {
  // 预占的时候还没加，所以这里不用扣
}

/**
 * 查询用户当前额度（给前端展示用）。
 */
function getUsage(userId, type) {
  const quota = QUOTAS[type] || 30;
  const today = todayStr();
  const key = userId + ':' + type + ':' + today;
  const used = counters.get(key) || 0;
  return { used, quota, remaining: Math.max(0, quota - used) };
}

module.exports = { aiLimit, bumpCount, getUsage, QUOTAS };
