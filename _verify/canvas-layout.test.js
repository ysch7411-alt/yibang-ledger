// 版式自检：用**假的 canvas 上下文**把 drawReport / drawPoster 真跑一遍，
// 看它最后停在的高度是否等于 plan*() 事先算的高度。
//
// 为什么要这么做：这类图最大的坑不是画错颜色，而是「算高和画高对不上」——
// 结果就是图片底部多一块白、或者内容被切掉一截，而这两个毛病在真机上
// 都得靠肉眼发现，模拟器截图也未必看得出来。
// 用假 ctx 跑，可以在没有微信开发者工具的情况下把这件事变成断言。
//
// 假 ctx 只需要实现被调用到的方法；measureText 按字号粗估宽度（宽一点，
// 逼 fitText 真的走截断分支，顺便覆盖那条路径）。
const path = require('path');

/* ---------------- 运行环境打桩 ---------------- */
const SRC = path.join(__dirname, '..', 'yibang-miniprogram');

let captured = null;
global.getApp = () => ({
  globalData: { userId: 2, userInfo: { shop_name: '老易的店', nickname: '老易' } },
  beacon() {},
  request() { return Promise.resolve({ code: 0 }); }
});
global.Page = (o) => { captured = o; };
global.Component = (o) => { captured = o; };
global.wx = {
  getWindowInfo: () => ({ pixelRatio: 3, windowWidth: 375 }),
  getSystemInfoSync: () => ({ pixelRatio: 3 }),
  env: { USER_DATA_PATH: '/tmp' },
  showShareMenu() {}, showToast() {}, showLoading() {}, hideLoading() {}
};

function mockCtx() {
  const ctx = {
    textBaseline: '',
    fillStyle: '',
    font: '',
    textAlign: '',
    texts: [],
    fillRect() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    closePath() {},
    arc() {},
    fill() {},
    stroke() {},
    fillText(t, x, y) { ctx.texts.push({ t: String(t), x, y, font: ctx.font, align: ctx.textAlign }); },
    drawImage() { ctx.texts.push({ t: '[image]' }); },
    measureText(s) {
      const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font || '');
      const size = m ? parseFloat(m[1]) : 12;
      let w = 0;
      // 中文按满宽、英文数字按 .58 倍估；故意估宽一点，让 fitText 真的去截
      for (const ch of String(s)) w += /[\u4e00-\u9fff]/.test(ch) ? size : size * 0.58;
      return { width: w };
    }
  };
  return ctx;
}

let pass = 0, fail = 0;
function say(ok, label, extra) {
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (extra ? '  → ' + extra : ''));
}

/* ---------------- ① 分销海报（pages/promote） ---------------- */
console.log('=== ① 分销海报版式（pages/promote）===');
require(path.join(SRC, 'pages/promote/promote.js'));
const promote = captured;
say(!!promote, '页面定义能加载出来');
say(typeof promote.planPosterHeight === 'function', 'planPosterHeight 存在');
say(typeof promote.drawPoster === 'function', 'drawPoster 存在');

const PH = promote.planPosterHeight();
say(PH > 900 && PH < 1600, '海报高度落在合理区间', PH + 'px（宽 750）');
// 像素高上限 4000：dpr 2 时 2×PH 必须留有余量，否则老机型出白图
say(PH * 2 <= 4000, 'dpr=2 时像素高不超过 4000 上限', (PH * 2) + 'px');

const ctxA = mockCtx();
const usedA = promote.drawPoster(ctxA, PH, { id: 'img' }, '老易的店');
say(Math.abs(usedA - PH) <= 2, '有码时：画出来 == 算出来', 'used=' + usedA + ' plan=' + PH);

const ctxB = mockCtx();
const usedB = promote.drawPoster(ctxB, PH, null, '老易的店');
say(Math.abs(usedB - PH) <= 2, '无码占位时高度不变（不会因缺图撑歪版式）', 'used=' + usedB);

// 无码时必须**明说**没码，不能留白让人以为图坏了
const saidNoCode = ctxB.texts.some((t) => /小程序码没加载出来/.test(t.t));
say(saidNoCode, '无码时画了明确占位文案');

const saidCode = ctxA.texts.some((t) => /微信扫一扫/.test(t.t));
say(saidCode, '有码时画了扫码提示');

const saidInvite = ctxA.texts.some((t) => /老易的店 .*邀请你一起用/.test(t.t));
say(saidInvite, '邀请语带上了店名', (ctxA.texts.find((t) => /邀请/.test(t.t)) || {}).t);

// 署名兜底：没店名没昵称也不能出现「undefined 邀请你一起用」
const ctxC = mockCtx();
promote.drawPoster(ctxC, PH, null, '你的朋友');
const inviteC = (ctxC.texts.find((t) => /邀请/.test(t.t)) || {}).t || '';
say(!/undefined|null|NaN/.test(inviteC), '署名兜底无 undefined', inviteC);

// 三句卖点都要画上（漏了就白瞎了海报的位置）
const sellsAll = ['说句话就记上', '买了几斤', '这个月赚了多少'].every((k) =>
  ctxA.texts.some((t) => t.t.indexOf(k) >= 0));
say(sellsAll, '三条价值点都画上了');

/* ---------------- ② 报表图（pages/summary） ---------------- */
console.log('\n=== ② 报表图版式（pages/summary）===');
captured = null;
require(path.join(SRC, 'pages/summary/summary.js'));
const summary = captured;
say(!!summary, '页面定义能加载出来');

function reportWith(n, hidden) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      time: '09-' + String((i % 28) + 1).padStart(2, '0') + ' 14:0' + (i % 10),
      title: i % 3 === 0 ? '辣椒 3 斤 × 5 元/斤' : '卖废铁收款',
      amount: (i % 2 ? '-' : '+') + '¥' + (100 + i) + '.00',
      isIncome: i % 2 === 0
    });
  }
  return {
    label: '今日报表',
    rangeText: '2026-09-19',
    incomeText: '1265.00',
    expenseText: '340.00',
    netText: '925.00',
    isPositive: true,
    count: n + (hidden || 0),
    rows,
    allRows: rows.slice(),
    hidden: hidden || 0,
    generatedAt: '2026-09-19 20:15'
  };
}

[[0, 0], [1, 0], [5, 0], [20, 0], [20, 13]].forEach(([n, hid]) => {
  const rep = reportWith(n, hid);
  const H = summary.planHeight(rep.rows.length, rep.hidden);
  const used = summary.drawReport(mockCtx(), rep, H);
  say(Math.abs(used - H) <= 2,
    '明细 ' + n + ' 行' + (hid ? ' + 截断提示' : '') + '：画出来 == 算出来',
    'used=' + used + ' plan=' + H);
});

// 空报表也要走通（不画明细表头以外的东西）
const emptyRep = reportWith(0, 0);
const HE = summary.planHeight(0, 0);
say(Math.abs(summary.drawReport(mockCtx(), emptyRep, HE) - HE) <= 2, '空报表：画出来 == 算出来');

/* ---------------- ③ dpr 反算 ---------------- */
console.log('\n=== ③ 出图缩放反算（utils/canvas）===');
const cv = require(path.join(SRC, 'utils/canvas.js'));
const d1 = cv.pickDpr(1201);
say(d1 === 2, '海报高度下 dpr 取 2（手机是 3，但按宽也按高都压到 2）', 'dpr=' + d1);
const d2 = cv.pickDpr(2000);
say(d2 === 2, '高 2000 时 dpr 仍为 2', (2000 * d2) + 'px');
const d3 = cv.pickDpr(4000);
say(d3 <= 1, '高 4000 时把 dpr 压到 1（否则触顶出白图）', 'dpr=' + d3);
say(cv.pickDpr(1201) * 1201 <= 4000, '输出像素高不越界');

/* ---------------- ④ 文字截断 ---------------- */
console.log('\n=== ④ fitText 截断 ===');
const c = mockCtx();
c.font = ' 30px sans-serif';
const long = '辣椒三斤五块钱一斤一共十五块钱老板你算一下对不对啊';
const fitted = cv.fitText(c, long, 300);
say(fitted.length < long.length && /…$/.test(fitted), '超宽会截断并加省略号', fitted);
const short = cv.fitText(c, '卖废铁', 3000);
say(short === '卖废铁', '不超宽时原样返回', short);
say(cv.fitText(c, null, 300) === '', 'null 文本不炸', JSON.stringify(cv.fitText(c, null, 300)));

console.log('\n' + (fail ? '✗ ' + fail + ' 项不合格' : '✓ 全部通过') + '（通过 ' + pass + '，失败 ' + fail + '）');
process.exit(fail ? 1 : 0);
