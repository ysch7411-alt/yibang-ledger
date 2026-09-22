// 代码审查第一批修复的回归断言（2026-09-20）
//
// 修的是两件事，都是"编译不报错、只有用起来才发现"的：
//   ④ 说错数：一个月超过 500 笔时，按钮写"带 500 笔明细"、汇总卡写"共 520 笔"，
//      图上还说"另有 480 笔未列出"（真实是 500）—— 拿图对账会对不上。
//   ② 闪骨架屏：切 tab 回来时数据其实没变，列表却先变灰条再长回来。
//
// ④ 这条用**行为断言**验：真跑 buildReport()，给 count=520 / 明细 500 条，
// 看它算出来的数字对不对。文本断言只能证明"写了 count"，行为断言能证明"结果对"。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'yibang-miniprogram');
const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

/** 剥注释 —— 用文本正则查代码时，自己写的解释性注释里往往正好有那串字，本项目已栽过四次 */
const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

let pass = 0, fail = 0;
function say(ok, label, extra) {
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (extra ? '  → ' + extra : ''));
}

/* ---------------- 打桩加载 summary 页，真跑 buildReport ---------------- */
let page = null;
global.getApp = () => ({
  globalData: { userId: 2, userInfo: {} }, beacon() {},
  request() { return Promise.resolve({ code: 0 }); }
});
global.Page = (o) => { page = o; };
global.Component = () => {};
global.wx = {
  getWindowInfo: () => ({ pixelRatio: 2 }),
  getSystemInfoSync: () => ({ pixelRatio: 2 }),
  env: { USER_DATA_PATH: '/tmp' },
  createSelectorQuery() { return { select() { return this; }, fields() { return this; }, exec(cb) { cb([]); } }; }
};
require(path.join(SRC, 'pages/summary/summary.js'));

const sumJs = rd('pages/summary/summary.js');
const sumWxml = rd('pages/summary/summary.wxml');
const advJs = rd('pages/advisor/advisor.js');
const seaJs = rd('pages/search/search.js');
const recJs = rd('pages/record/record.js');

console.log('=== ④ 说错数：一个月超过 500 笔时，三个数字必须一致 ===');
{
  say(!!page, 'summary 页能加载');
  say(typeof page.buildReport === 'function', 'buildReport 存在');

  // 造一个月 520 笔、但接口最多只能取回 500 条的真实场景
  const TOTAL = 520;
  const FETCHED = 500;
  page.data = {
    period: 'month',
    stat: {
      incomeText: '12,650.00', expenseText: '3,400.00', netText: '9,250.00',
      isPositive: true, count: TOTAL
    }
  };
  page._rows = Array.from({ length: FETCHED }, (_, i) => ({
    _time: '09-01 10:00', _title: '一笔账' + i, _amount: '+¥10.00', _type: 1
  }));

  const rep = page.buildReport();

  say(rep.count === TOTAL, '图上「共 N 笔」用真实总数', 'count=' + rep.count);
  // MAX_ROWS = 20：图上画 20 行，其余的都该算进"未列出"
  say(rep.hidden === TOTAL - rep.rows.length,
    '图上「另有 N 笔未列出」用真实总数算', 'hidden=' + rep.hidden + '（应为 ' + (TOTAL - rep.rows.length) + '）');
  say(rep.hidden !== FETCHED - rep.rows.length,
    '不再是"取回来的条数 - 画出来的行数"那种少报法',
    '旧算法会得到 ' + (FETCHED - rep.rows.length));
}

console.log('\n=== ④ rowCount（按钮上的「带 N 笔明细」）也用真实总数 ===');
{
  const todayBlock = /if \(period === 'today'\)[\s\S]*?rowCount:([^\n]+)/.exec(sumJs);
  say(!!todayBlock && /d\.count/.test(todayBlock[1]), '今日分支用 d.count',
    todayBlock ? todayBlock[1].trim() : '没找到');
  const monthBlock = /rowCount:\s*(m\.count[^\n]*)/.exec(sumJs);
  say(!!monthBlock, '本月分支用 m.count', monthBlock ? monthBlock[1].trim() : '没找到');
  say(!/rowCount:\s*this\._rows\.length\s*\}\);/.test(sumJs), '不再有裸用 this._rows.length 当 rowCount 的地方');
}

console.log('\n=== ④ 超过 500 时不能承诺"给全量" ===');
{
  say(/rowCount > 500/.test(sumWxml), 'wxml 里有"超过 500"这一档说明');
  say(/文字版列最近 500 笔/.test(sumWxml), '明确说了文字版只带到 500 笔');
  say(/其余两条给全量/.test(sumWxml), '500 以内仍保留原来的"给全量"说法');
}

console.log('\n=== ② 切 tab 不再闪骨架屏 ===');
[['summary', sumJs], ['advisor', advJs]].forEach(([name, js]) => {
  say(/if \(!this\._loaded\) this\.setData\(\{ loading: true \}\)/.test(js),
    name + '：骨架屏改成"只有首次才显示"');
  say(/this\._loaded = true/.test(js), name + '：加载完置 _loaded');
});

console.log('\n=== ② 查询页：静默刷新 + 防止翻页串数据 ===');
{
  say(/async reload\(silent\)/.test(seaJs), 'reload 接受 silent 参数');
  say(/if \(!silent \|\| !this\._loaded\)/.test(seaJs), 'silent 且有数据时不显示骨架屏');
  const onShow = /onShow\(\)\s*\{([\s\S]*?)\n  \},/.exec(seaJs);
  say(/reload\(true\)/.test(onShow ? onShow[1] : ''), 'onShow 走静默刷新');
  const pull = /onPullDownRefresh\(\)\s*\{([\s\S]*?)\n  \},/.exec(seaJs);
  say(/reload\(true\)/.test(pull ? pull[1] : ''), '下拉刷新也静默（下拉本身已是反馈）');
  // 换筛选条件必须保留加载态 —— 结果本来就要变
  const pickType = /pickType\(e\)\s*\{([\s\S]*?)\n  \},/.exec(seaJs);
  say(/this\.reload\(\)/.test(pickType ? pickType[1] : ''), '换筛选条件仍然显示加载态（不能一起静默）',
    pickType ? '' : '没找到 pickType');
  say(/_reloading/.test(seaJs) && /this\._reloading \|\|/.test(seaJs),
    '静默刷新期间挡住上拉加载（否则会把旧条件的结果混进来）');
}

console.log('\n=== ② 反向：记账页本来就是对的，别被"统一改"改坏 ===');
{
  const loadData = /async loadData\(\)\s*\{([\s\S]*?)\n  \},/.exec(recJs);
  const body = strip(loadData ? loadData[1] : '');
  say(!/setData\(\{\s*loading: true/.test(body),
    'record.loadData 开头**没有** setData({loading:true})（它只在结束时收尾，所以切回来本来就不闪）');
  say(/loading: false/.test(body), 'record 仍然会在结束时收起 loading');
}

console.log('\n=== ① 更正：报表页的"重复请求"是我报错了，记在这里防止以后再被误报 ===');
{
  // calOpen 默认 false，loadCalendar 根本不在 onShow 时执行 —— 不存在"每次切 tab 重复请求"
  say(/calOpen: false/.test(sumJs), '日历默认收起（calOpen: false）');
  const jobs = /const jobs = \[[^\]]*\];[\s\S]{0,200}?Promise\.all\(jobs\)/.exec(sumJs);
  const jobStr = jobs ? jobs[0] : '';
  say(/if \(this\.data\.calOpen\) jobs\.push\(this\.loadCalendar\(\)\)/.test(jobStr),
    'loadCalendar 只在展开日历时才跑 —— 所以 onShow 不存在重复请求');
}

console.log('\n' + (fail ? '✗ ' + fail + ' 项不合格' : '✓ 全部通过') + '（通过 ' + pass + '，失败 ' + fail + '）');
process.exit(fail ? 1 : 0);
