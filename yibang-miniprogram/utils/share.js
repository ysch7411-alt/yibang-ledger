/**
 * utils/share.js —— 分享链接的公共状态机
 *
 * 为什么收成一个（2026-09-22 代码审查，第 6 条）：
 * 这段「防重复点击 → 查本地缓存 → 建分享链接 → 失败落回可重试」的状态机，
 * 在**报表页 / 记账页 / 往来详情**三处各抄了一份。
 * 而三份的失败处理**曾经不一致**：其中两份漏了"兜住 reject"，
 * 于是 `sharePreparing` 卡在 true，那句 `if (sharePreparing) return` 把之后每一次重试都挡死，
 * 界面永远停在「正在准备分享链接…」✗（2026-09-22 用户报"一直生不成链接"）
 *
 * **抄代码时最容易漏的就是失败路径** —— 只抄成功路径等于把坑一起搬过去。
 * 所以这段收进公共层，调用方只描述"分享什么"，不重复实现"怎么防坑"。
 *
 * 🔴 下面两条保护必须**同时**套上，缺一会在真机上卡死：
 *   ① `api.safe`      —— 兜住 reject（app.request 在网络失败/超时时是 reject 的）
 *   ② `api.withTimeout` —— 兜底时钟（防"wx.request 既不 success 也不 fail"把 await 挂住）
 */

const api = require('./api');
const app = () => getApp();

/** 缓存键统一加前缀：三处原来分别是 share_token / share_token_today / share_token_contact_<id>，
 *  报表页那份用的是**通用键** ✗ —— 今天不冲突，但再加第四个分享入口就会互相串。
 *  统一前缀 + 各自命名空间，避免这类"看起来没事"的隐患。 */
const PREFIX = 'yibang_share_';
/** 缓存里留给过期的时间余量：别贴边过期（网络往返 + 用户点开的时间） */
const SAFETY_MS = 60000;
const TIMEOUT_MS = 12000;

function readCache(key) {
  try { return wx.getStorageSync(key) || null; } catch (e) { return null; }
}
function writeCache(key, val) {
  // 存不下（超额/隐私模式）不影响本次分享 —— 只是下次要重建
  try { wx.setStorageSync(key, val); } catch (e) { /* 忽略 */ }
}

/**
 * 备好分享链接。调用方只需描述"分享什么"。
 *
 * @param {object} page 页面实例（本函数会用 page.setData / page.data）
 * @param {object} spec
 * @param {string} spec.key   缓存命名空间 —— **同一份分享用同一个 key**。
 *                            例：`'3-today'`、`'2-contact-' + cid`。
 *                            把"分享的身份"放进 key，缓存校验就只剩"过期没过期"一件事，
 *                            不必再逐字段比对（报表页原来就是在比 period/from/to）。
 * @param {object} spec.data  `/share/create` 的入参
 * @param {function} [spec.map] 页面专属的附加字段：`(响应) => ({ asOfText: '...' })`，
 *                              会一起被缓存、并在缓存命中时原样回填
 * @returns {Promise<void>}
 */
async function ensure(page, spec) {
  if (!page || !spec || !spec.key || !spec.data) return;
  // 已经在备了就别重复发请求（用户会连点）
  if (page.data.sharePreparing) return;

  const storageKey = PREFIX + spec.key;
  const cached = readCache(storageKey);
  const extraOf = (v) => (v && v.extra) || {};

  if (cached && cached.token && Number(cached.expireAt || 0) > Date.now() + SAFETY_MS) {
    page.setData(Object.assign(
      { shareToken: cached.token, shareReady: true, sharePreparing: false },
      extraOf(cached)
    ));
    return;
  }

  page.setData({ sharePreparing: true, shareReady: false });

  /* 两道一起套，缺一不可：
     ① safe：异常穿透后，上面那句 `if (sharePreparing) return` 会把之后每一次重试都挡死
        （sharePreparing 永远停在 true，界面永远"正在准备分享链接…"，怎么点都没反应）
     ② withTimeout：项目里栽过"wx.request 在部分基础库/工具下既不 success 也不 fail"，
        光有 safe 救不了"永远不回调"，必须再加一道计时器把 await 叫醒 */
  const d = await api.safe(
    api.withTimeout(
      app().request('/share/create', { method: 'POST', data: spec.data, silent: true }),
      TIMEOUT_MS,
      '准备分享链接超时'
    ),
    null
  );

  if (!d || !d.token) {
    // 失败要落回"可重试"那一态：既不留在忙碌态假装还在忙，也不给别人一个坏链接
    page.setData({ sharePreparing: false, shareReady: false, shareToken: '' });
    app().beacon('share-token-fail', String(spec.key));
    return;
  }

  const extra = spec.map ? (spec.map(d) || {}) : {};
  writeCache(storageKey, {
    token: d.token,
    expireAt: new Date(d.expire_at).getTime(),
    extra
  });
  page.setData(Object.assign(
    { shareToken: d.token, shareReady: true, sharePreparing: false },
    extra
  ));
}

/** 手动清掉某份分享的缓存（目前没人用，留作"数据变了要重开一份快照"的口子） */
function clear(key) {
  try { wx.removeStorageSync(PREFIX + key); } catch (e) { /* 忽略 */ }
}

module.exports = { ensure, clear };
