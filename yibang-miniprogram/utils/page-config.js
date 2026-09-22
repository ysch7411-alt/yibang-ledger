/**
 * 全局 Page 注入：让每个页面自动拿到配置（主题变量 / 本页文案 / 功能开关）。
 *
 * 为什么用全局包裹而不是每个页面 import mixin（项目里 keyboard.js 就是 mixin 路线）：
 * 配置是**所有页面**都要用的横切能力，16 个页面逐个 import + 逐个改 onLoad/onShow，
 * 漏一个就出现「这一页不吃配置」的隐形不一致；集中裹一次，新页面也自动获得。
 * （keyboard 只服务 4 个页面，mixin 更合适；场景不同，不矛盾。）
 *
 * 注入到 page data 的三个键：
 *   _cv —— CSS 变量串，由页面 WXML 根节点绑 style="{{_cv}}" 生效（一次性机械改动）
 *   _t  —— 本页文案，WXML 里直接 {{_t.emptyTitle}}；键名与后台 copy 分区一致
 *   _f  —— 功能开关，WXML 里 {{_f.voiceEntry}} 控制入口显隐
 *
 * 刷新时机：onShow 时比对配置 version，变了才 setData —— 切 tab 不抖，后台改完下一次
 * onShow 必然带上（这就是「实时生效」在小程序侧的落地方式，没有 websocket 也能做到秒级）。
 */
const config = require('./config');

/** 页面路由 → copy 分区的键。表里没有的页面 _t 为空，用页面原有硬编码（向后兼容） */
const PAGE_KEY = {
  'pages/record/record': 'record',
  'pages/summary/summary': 'summary',
  'pages/search/search': 'search',
  'pages/advisor/advisor': 'advisor',
  'pages/profile/profile': 'profile'
};

/** 兜底文案：只在「首次启动且服务端配置没拉到」时出现。与后端 defaults 同值，改要同步 */
const FALLBACK_TEXT = {
  record: {
    emptyTitle: '今天还没有记录',
    placeholder: '说一句，自动记账',
    plus: { camera: '拍照', album: '相册', file: '传文件', text: '打字' }
  },
  summary: { calendarEntry: '按日查询 ›', shareBtn: '分享报表' },
  search: { placeholder: '搜人名、事由、金额' },
  advisor: { placeholder: '问一句，或拍一张' }
};

function applyNavBar(theme) {
  if (!theme) return;
  const bg = String(theme.navBar || '');
  const style = theme.navBarStyle === 'black' ? 'black' : 'white';
  // ⚠️ 不能用模块级变量做「已经设过了」的去重：wx.setNavigationBarColor 是**每个页面
  // 各自生效**的。A 页设成绿色后 appliedNav 记着绿，切到 B 页时 B 的 onShow 被守卫挡下，
  // B 的导航栏就一直停在旧色（2026-09-20 实测踩到，表现为「改了配置只有当时那一页变色」）。
  // 这个接口本身幂等又便宜，onShow 频率也不高，每次都设最稳。
  try {
    wx.setNavigationBarColor({
      frontColor: style,
      backgroundColor: bg,
      animation: { duration: 200, timingFunc: 'linear' }
    });
  } catch (e) { /* 老基础库没有这个接口，忽略 */ }
}

const originPage = Page;

Page = function (options) {
  const opts = options || {};
  const ownOnLoad = opts.onLoad;
  const ownOnShow = opts.onShow;
  const ownOnUnload = opts.onUnload;

  opts.data = Object.assign({}, opts.data, {
    _cv: '',
    _t: {},
    _f: {},
    _notice: '',
    _cfgVer: -1,
    _navTitle: ''
  });

  opts.onLoad = function (query) {
    this._applyConfig();
    if (ownOnLoad) ownOnLoad.call(this, query);
  };

  opts.onShow = function () {
    // 已经加载过也要周期性重拉：后台刚保存的配置靠这个窗口送达页面。
    // load() 内部有 30s 节流，不会把切 tab 变成请求风暴；拉到新 version 才会重渲染。
    // （第一版只在「从未加载」时拉，之后永远吃缓存 —— 后台改了当前会话再也收不到，
    //  「实时生效」成了空话。这个调用就是那句话的落点。）
    if (config.current().loaded) {
      config.load().then(() => this._applyConfig()).catch(() => {});
    }
    this._applyConfig();
    this._syncTabBar();
    if (ownOnShow) ownOnShow.call(this);
  };

  /**
   * tabBar 是自定义组件、和页面数据不互通，把配置推进去。
   * 为什么在这里推而不是让组件自己 require utils/config：自定义组件的模块解析基准
   * 和页面不同，页面里好的 `../../utils/config` 在组件里报 can not find module
   * （2026-09-20 实测）。页面推数据也是微信官方 custom-tabBar 的推荐模式。
   */
  opts._syncTabBar = function () {
    const cur = config.current();
    if (!cur.loaded) return;
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (!tb) return; // 非 tab 页没有自定义 tabBar
    if (tb.data._cfgTabVer === cur.version) return;
    tb.setData({
      list: config.tabBarList(),
      _cv: config.cssVars((cur.config || {}).theme),
      _cfgTabVer: cur.version
    });
  };

  opts.onUnload = function () {
    if (ownOnUnload) ownOnUnload.call(this);
  };

  /** 把当前配置灌进页面。version 没变就什么都不做（tab 来回切不重渲染） */
  opts._applyConfig = function () {
    const cur = config.current();

    // 还没加载过：拉一次，拉到之后本方法会被再次调用完成渲染。
    // 不 await —— 启动链路不能被配置接口拖住，首屏先用兜底值，拉到即刷新。
    if (!cur.loaded) {
      config.load().then(() => this._applyConfig()).catch(() => {});
      return;
    }

    const cfg = cur.config || {};
    const theme = cfg.theme || {};
    applyNavBar(theme);

    const key = PAGE_KEY[this.route] || '';
    const pageCopy = Object.assign(
      {},
      config.FALLBACK[key] || {},
      (cfg.copy && cfg.copy[key]) || {}
    );

    // 导航栏标题：五个 tab 页跟配置走，其余页保持各自 json 里的标题
    const navTitle = key ? (cfg.copy && cfg.copy.nav && cfg.copy.nav[key]) || '' : '';
    const wantTitle = navTitle || '';
    if (wantTitle && wantTitle !== this.data._navTitle) {
      this.setData({ _navTitle: wantTitle });
      try { wx.setNavigationBarTitle({ title: wantTitle }); } catch (e) { /* 忽略 */ }
    }

    if (cur.version === this.data._cfgVer) return;
    this.setData({
      _cv: config.cssVars(theme),
      _t: pageCopy,
      _f: cfg.features || {},
      // 自定义公告：后台「自定义参数」里加的 notice，所有页面都能用 {{_notice}} 渲染
      _notice: config.getCustom('notice', ''),
      _cfgVer: cur.version
    });
  };

  originPage(opts);
};
