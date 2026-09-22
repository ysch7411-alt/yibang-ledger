/**
 * 远程配置：主题 / 文案 / 布局 / 功能开关，全部由 Web 后台（/admin）实时维护。
 *
 * 三条设计纪律：
 * 1. **加载失败必须静默**。配置拉不到就用缓存、再不行就用内置兜底 —— 它只是「长什么样」，
 *    不能因为它把记账主业搞挂（和登录一样，配置接口永远不该弹错误Toast）。
 * 2. **公开接口，不带 token**。小程序启动时（登录可能还没完成）就要用配置，
 *    挂 Authorization 只会平添 401 重试。
 * 3. **节流 30 秒**。页面 onShow 会频繁调 load()，不节流就等于每次切 tab 都打一次接口。
 *    真正的「实时」靠 version：后台保存后 version+1，任何页面 onShow 发现版本变了就重渲染。
 */
const CACHE_KEY = 'app_config_cache';
const REFRESH_MS = 30000;

let mem = { version: 0, config: null, loaded: false };
let lastFetch = 0;
let inflight = null;

/** 首次启动 + 断网时的兜底文案。只放最关键的几个，其余缺省由页面原有硬编码承担 */
const FALLBACK = {
  nav: { record: '易帮账本', summary: '报表', search: '查询', advisor: '参谋', profile: '我的' },
  record: { emptyTitle: '今天还没有记录', placeholder: '说一句，自动记账' }
};

function readCache() {
  try {
    const v = wx.getStorageSync(CACHE_KEY);
    if (v && v.config) return v;
  } catch (e) { /* 缓存读写失败不影响主流程 */ }
  return null;
}

function writeCache(v) {
  try { wx.setStorageSync(CACHE_KEY, v); } catch (e) { /* 存不下就算了 */ }
}

/** 当前生效配置（同步读）。还没加载过时返回 version=0 的空壳 */
function current() {
  if (!mem.loaded) {
    const c = readCache();
    if (c) {
      mem = { version: Number(c.version) || 0, config: c.config, loaded: true };
    }
  }
  return mem;
}

/** 点号路径取值：get('record.emptyTitle', '兜底') */
function get(path, fallback) {
  const cfg = current().config || {};
  const parts = String(path).split('.');
  let v = cfg;
  for (const p of parts) {
    if (v == null || typeof v !== 'object') return fallback;
    v = v[p];
  }
  return v === undefined || v === null || v === '' ? fallback : v;
}

/**
 * 读自定义参数的值（后台「自定义参数」区加的）。
 * 存的结构是 { type, value, label }，这里只取 value；没加过就返回兜底。
 * 例：后台加了 notice（文字）→ getCustom('notice', '') 拿到那段文字。
 */
function getCustom(key, fallback) {
  const item = get('custom.' + key, null);
  if (!item || typeof item !== 'object') return fallback;
  const v = item.value;
  return v === undefined || v === null || v === '' ? fallback : v;
}

/**
 * 拉取配置。force=true 忽略节流（目前只有 app.onLaunch 用）。
 * 返回 Promise，但调用方不需要 await 也能工作 —— 失败时 current() 一直是旧值。
 */
function load(force) {
  if (inflight) return inflight;
  if (!force && mem.loaded && Date.now() - lastFetch < REFRESH_MS) {
    return Promise.resolve(mem);
  }
  lastFetch = Date.now();
  inflight = new Promise((resolve) => {
    wx.request({
      url: 'https://api.dtzai.cn/api/config',
      method: 'GET',
      timeout: 8000,
      success: (res) => {
        const body = (res && res.data) || {};
        if (body.code === 0 && body.data && body.data.config) {
          mem = {
            version: Number(body.data.version) || 0,
            config: body.data.config,
            loaded: true
          };
          writeCache({ version: mem.version, config: mem.config });
        }
        // 拿不到就保持现状：缓存或兜底，绝不让界面空掉
        resolve(mem);
      },
      fail: () => resolve(mem)
    });
  }).finally(() => { inflight = null; });
  return inflight;
}

/**
 * 把 theme 配置转成 CSS 变量串，绑到页面根节点的 style 上。
 * key 是 camelCase，CSS 变量是 kebab-case（brandBtn → --brand-btn），机械转换。
 * navBar 两个不是 CSS 变量，走微信运行时接口，这里不产出，在 page-config 里单独处理。
 */
const THEME_KEYS = [
  'brand', 'brandBtn', 'brandBtnPress', 'brandInk', 'brandWeak', 'brandLine',
  'income', 'incomeWeak', 'expense', 'expenseWeak', 'warn', 'warnWeak',
  'info', 'infoWeak',
  't1', 't2', 't3', 't4', 'bg', 'card', 'line', 'fill',
  'rSm', 'rMd', 'rLg'
];

function cssVars(theme) {
  if (!theme) return '';
  const parts = [];
  for (const k of THEME_KEYS) {
    const v = theme[k];
    if (typeof v === 'string' && v) {
      parts.push('--' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + v);
    }
  }
  return parts.join(';');
}

/** tab 页 → 图标。图标不放进后台配置：路径写错就是破图，白名单锁死最稳 */
const TAB_ICONS = {
  '/pages/record/record': { icon: '/images/tab-record.svg', iconOn: '/images/tab-record-on.svg' },
  '/pages/summary/summary': { icon: '/images/tab-chart.svg', iconOn: '/images/tab-chart-on.svg' },
  // AI 参谋（2026-09-22 从"报表页底部的一个入口"提成独立 tab）。
  // 图标是它早期当 tab 时留下的那两张，一直没删 —— 这次正好用上。
  '/pages/advisor/advisor': { icon: '/images/tab-advisor.svg', iconOn: '/images/tab-advisor-on.svg' },
  '/pages/contacts/contacts': { icon: '/images/tab-contacts.svg', iconOn: '/images/tab-contacts-on.svg' },
  '/pages/profile/profile': { icon: '/images/tab-mine.svg', iconOn: '/images/tab-mine-on.svg' }
};

/** 组装最终要渲染的 tabBar：按后台配置的顺序/显隐，图标从白名单取 */
function tabBarList() {
  const cfg = current().config || {};
  const items = (cfg.layout && cfg.layout.tabBar) || [];
  const feat = cfg.features || {};
  const out = [];
  for (const it of items) {
    if (!it || it.visible === false) continue;

    const ic = TAB_ICONS[it.pagePath];
    if (!ic) continue;
    out.push({
      pagePath: it.pagePath,
      text: String(it.text || ''),
      icon: ic.icon,
      iconOn: ic.iconOn
    });
  }
  // 全被关掉时退回全部显示 —— 一个都没有的 tabBar 会让小程序没有主导航
  return out.length ? out : Object.keys(TAB_ICONS).map((p) => ({
    pagePath: p,
    text: { '/pages/record/record': '记账', '/pages/summary/summary': '报表', '/pages/contacts/contacts': '往来', '/pages/profile/profile': '我的' }[p],
    icon: TAB_ICONS[p].icon,
    iconOn: TAB_ICONS[p].iconOn
  }));
}

/** 加号面板四宫格：按后台配置的顺序/显隐 */
function plusPanelList() {
  const cfg = current().config || {};
  const items = (cfg.layout && cfg.layout.plusPanel) || [];
  const names = { camera: '拍照', album: '相册', file: '传文件', text: '打字' };
  const out = [];
  for (const it of items) {
    if (!it || it.visible === false) continue;
    if (!names[it.key]) continue;
    out.push({ key: it.key, text: String(it.text || names[it.key]) });
  }
  return out;
}

module.exports = { current, load, get, getCustom, cssVars, tabBarList, plusPanelList, FALLBACK };
