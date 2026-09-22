// 登录流程的回归断言（2026-09-20 用户要求：退出后再进来要重新走一遍登录校验）
//
// 改动前的行为：`logout()` 往**本地存储**写 `logged_out`，而 `onLaunch` 里
// `if (!isLoggedOut()) login()` —— 于是"退出过一次 = 以后每次进来都不登录"，
// 用户只能自己摸到「我的 → 账号与安全」去手动点一下。而记账页看起来完全正常，
// 只是所有列表都空 —— 老板会以为是自己没记账，而不是"登录没成功"。
//
// 改动后：退出只在**本次运行**内有效（内存标记），每次启动都重新校验，失败去登录页。
// 这几条都是"不报错、编译也过、只有用起来才发现"的行为，所以钉在测试里。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'yibang-miniprogram');
const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let pass = 0, fail = 0;
function say(ok, label, extra) {
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (extra ? '  → ' + extra : ''));
}

/**
 * 剥掉注释再断言。
 *
 * ⚠️ 这条是拿血换来的：用文本正则检查"代码里不许出现 X"时，
 * 我自己写的解释性注释里往往**正好写着那个 X**（"这里不能再写 xxx"），
 * 于是断言被自己的注释判失败。本项目已经栽过三次
 * （advisor-ai 的「上面的搜索」、keyboard-lift 的 blur 名、这次的 globalData.token）。
 * **凡是"不许出现某串"的断言，一律先剥注释。**
 */
function stripComment(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')     // /* 块注释 */
    .replace(/^[ \t]*\/\/.*$/gm, '');     // 行首 // 注释
}

/* ---------------- 打桩加载 app.js（它只定义 App({...})，可以直接调方法） ---------------- */
const storage = {};
const relaunches = [];
let appObj = null;

global.wx = {
  getStorageSync: (k) => storage[k],
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  login: () => { /* 不回调：relogin 会挂起，本测试只关心标记 */ },
  request: () => {},
  reLaunch: (o) => relaunches.push(o.url),
  getWindowInfo: () => ({ pixelRatio: 2 })
};
global.getCurrentPages = () => [];
global.App = (o) => { appObj = o; };
require(path.join(SRC, 'app.js'));

const appJs = rd('app.js');
const loginJs = rd('pages/login/login.js');
const loginWxml = rd('pages/login/login.wxml');
const accountJs = rd('pages/account/account.js');
const appJson = JSON.parse(rd('app.json'));

/* ---------------- ① 退出标记只在内存里 ---------------- */
console.log('=== ① 「已退出」只在本次运行有效，不落盘 ===');
say(!!appObj, 'app.js 能加载');
{
  storage.logged_out = 1;                       // 模拟老版本留下的遗留键
  say(appObj.isLoggedOut() === false, '存储里的 logged_out 不再影响判断（只读内存）',
    'isLoggedOut=' + appObj.isLoggedOut());
  delete storage.logged_out;
}
{
  appObj.logout();
  say(appObj.isLoggedOut() === true, 'logout() 之后算已退出');
  say(!storage.logged_out, 'logout() 不往存储写 logged_out（这是关键：否则退出一次就永久登不回）',
    'storage.logged_out=' + storage.logged_out);
  say(!storage.token && !storage.userInfo, 'logout() 清掉了本地 token / userInfo');
  say(appObj.globalData.token === '' && appObj.globalData.userId === null, 'logout() 清了内存里的登录态');
}
{
  // 模拟"关掉小程序重新打开"：内存标记没了，存储里的 token 也没了
  appObj._loggedOut = false;
  say(appObj.isLoggedOut() === false, '重新运行后 isLoggedOut() 回到 false（→ onLaunch 会重新校验）');
}

/* ---------------- ② onLaunch 无条件校验登录 ---------------- */
console.log('\n=== ② onLaunch：每次启动都重新走登录校验 ===');
const launch = /\bonLaunch\s*\(options\)\s*\{([\s\S]*?)\n  \},/.exec(appJs);
const launchBody = launch ? launch[1] : '';
say(!!launchBody, '取到了 onLaunch 函数体');
say(/this\.login\(\)/.test(launchBody), 'onLaunch 里调了 login()');
say(!/if\s*\(!\s*this\.isLoggedOut\(\)\s*\)/.test(launchBody),
  '不再用「没退出过才登录」包住 login（那正是"退出后进不来"的原因）');
say(/\.catch\(\s*\(err\)\s*=>\s*this\.gotoLogin\(/.test(launchBody) || /gotoLogin/.test(launchBody),
  '登录失败会去 gotoLogin（不是静默留空）');
say(/removeStorageSync\(\s*'logged_out'\s*\)/.test(launchBody),
  '启动时清掉老版本留下的 logged_out 键（迁移老用户）');

/* ---------------- ③ gotoLogin 的边界 ---------------- */
console.log('\n=== ③ gotoLogin：节流 + 已经在登录页就别再跳 ===');
{
  appObj._lastGotoLogin = 0;
  relaunches.length = 0;
  appObj.gotoLogin(new Error('测试一下'));
  say(relaunches.length === 1 && /pages\/login\/login/.test(relaunches[0]),
    '第一次调用跳到登录页', relaunches[0]);

  appObj.gotoLogin(new Error('紧接着又来一次'));
  say(relaunches.length === 1, '3 秒内第二次不再跳（否则页面栈会闪）', '共 ' + relaunches.length + ' 次');

  appObj._lastGotoLogin = 0;
  global.getCurrentPages = () => [{ route: 'pages/login/login' }];
  appObj.gotoLogin(new Error('已经在登录页'));
  say(relaunches.length === 1, '已经站在登录页上就不再跳一次');
  global.getCurrentPages = () => [];
}
{
  // 失败原因要带过去，用户得知道"我为什么在这"
  appObj._lastGotoLogin = 0;
  relaunches.length = 0;
  appObj.gotoLogin(new Error('等太久了，再试一次'));
  say(/why=/.test(relaunches[0]), '跳转时带上了原因（why）', relaunches[0]);
}

/* ---------------- ④ relogin 清标记 ---------------- */
console.log('\n=== ④ relogin：清掉退出标记再登 ===');
{
  appObj._loggedOut = true;
  appObj.relogin();                              // 不 await：wx.login 被打桩、不会回调
  say(appObj.isLoggedOut() === false, 'relogin() 清掉了内存退出标记');
}

/* ---------------- ⑤ 登录页本身 ---------------- */
console.log('\n=== ⑤ 登录页 ===');
['login.js', 'login.json', 'login.wxml', 'login.wxss'].forEach((f) => {
  say(fs.existsSync(path.join(SRC, 'pages/login', f)), 'pages/login/' + f + ' 存在');
});
say(appJson.pages.indexOf('pages/login/login') >= 0, 'app.json 里注册了登录页');
say(!appJson.tabBar.list.some((x) => x.pagePath === 'pages/login/login'),
  '登录页**不**在 tabBar 里（它是全屏页，不该有底部导航）');

// 合规：退路必须在
say(/bindtap="skip"/.test(loginWxml) && /先进入看看/.test(loginWxml),
  '登录页有「先进入看看」退路（合规命门：不能因为没登录就拒绝提供服务）');
say(/switchTab\(\s*\{\s*url:\s*'\/pages\/record\/record'/.test(loginJs), '退路是去记账页');

// 重试按钮
say(/bindtap="doLogin"/.test(loginWxml), '有「微信一键登录」按钮');
say(/app\.relogin\(\)/.test(loginJs), '重试走的是 app.relogin()');
say(/switchTab/.test(loginJs) && /login-ok/.test(loginJs), '登录成功后进记账页并记一条埋点');

// 不能靠残留 token 判断"已登录"（注释里会提到这件事，所以先剥注释）
const onLoadBody = /\bonLoad\s*\(options\)\s*\{([\s\S]*?)\n  \},/.exec(loginJs);
say(!/globalData\s*\.\s*token/.test(stripComment(onLoadBody ? onLoadBody[1] : '')),
  'onLoad 里没有"有 token 就跳走"的兜底（残留 token 会让页面闪一下又跳回去）');

// 文案要跟着页面走
say(/wx\.login|微信/.test(loginJs), '错误翻译里认得微信登录失败');
say(/时间|久|网/.test(loginJs), '错误翻译里认得超时/网络');

/* ---------------- ⑥ account 页的文案要跟行为一致 ---------------- */
console.log('\n=== ⑥ 退出确认框：文案必须说明"下次会自动登录" ===');
{
  const logoutBody = /\blogout\s*\(\s*\)\s*\{([\s\S]*?)\n  \},/.exec(accountJs);
  const body = logoutBody ? logoutBody[1] : '';
  say(/下次打开小程序/.test(body) && /自动/.test(body),
    '确认框里写了"下次打开小程序会自动用微信再登录一次"',
    /下次打开小程序/.test(body) ? '' : '没写 —— 用户会以为退出永久生效');
}

/* ---------------- ⑦ 页面流里的输入框没被这事牵连 ---------------- */
console.log('\n=== ⑦ 静态检查仍然全绿（新增页面没破坏约定）===');
say(appJson.pages.length >= 16, '页面总数', String(appJson.pages.length));

console.log('\n' + (fail ? '✗ ' + fail + ' 项不合格' : '✓ 全部通过') + '（通过 ' + pass + '，失败 ' + fail + '）');
process.exit(fail ? 1 : 0);
