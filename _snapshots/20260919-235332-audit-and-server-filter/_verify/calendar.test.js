// utils/calendar.js 的单测
//
// 日历里最烦的从来不是渲染，是"这个月 1 号是周几""上个月是几月""能不能往后翻"这类算术。
// 它们全是纯函数，不需要小程序环境就能跑 —— 所以没有理由不测。
//
// 用法: node calendar.test.js
const cal = require('../yibang-miniprogram/utils/calendar.js');

const rows = [];
const say = (ok, label, detail) => {
  rows.push(ok);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : ''));
};

/* ---------- 今天 ---------- */
console.log('=== ① todayParts ===');
const t = cal.todayParts();
say(t.y > 2000 && t.m >= 1 && t.m <= 12 && t.d >= 1 && t.d <= 31, '返回合法的年月日', JSON.stringify(t));

/* ---------- 月份加减（含跨年） ---------- */
console.log('\n=== ② addMonths ===');
say(JSON.stringify(cal.addMonths(2026, 9, -1)) === '{"y":2026,"m":8}', '往前一个月');
say(JSON.stringify(cal.addMonths(2026, 9, 1)) === '{"y":2026,"m":10}', '往后一个月');
say(JSON.stringify(cal.addMonths(2026, 1, -1)) === '{"y":2025,"m":12}', '1 月往前跨年 → 上一年 12 月');
say(JSON.stringify(cal.addMonths(2026, 12, 1)) === '{"y":2027,"m":1}', '12 月往后跨年 → 次年 1 月');
say(JSON.stringify(cal.addMonths(2026, 1, -12)) === '{"y":2025,"m":1}', '往前 12 个月 = 上一年同月');
// 往返一致性：往前 N 再往后 N 必须回到原点
let ok = true;
for (let n = 1; n <= 36; n++) {
  const back = cal.addMonths(2026, 9, -n);
  const fwd = cal.addMonths(back.y, back.m, n);
  if (fwd.y !== 2026 || fwd.m !== 9) { ok = false; console.log('     往返不一致 n=' + n + ' → ' + JSON.stringify(fwd)); }
}
say(ok, '往前 N 个月再往后 N 个月回到原点（N=1..36）');

/* ---------- 网格 ---------- */
console.log('\n=== ③ monthGrid ===');
const g1 = cal.monthGrid(2026, 9);
say(g1.lead === 2 && g1.days === 30 && g1.total === 35, '2026-09：前导 2 格 / 30 天 / 共 35 格', JSON.stringify(g1));
const g2 = cal.monthGrid(2026, 2);
say(g2.days === 28, '2026-02 是平年 28 天', String(g2.days));
const g3 = cal.monthGrid(2024, 2);
say(g3.days === 29, '2024-02 是闰年 29 天（2024 能被 4 整除）', String(g3.days));
const g4 = cal.monthGrid(1900, 2);
say(g4.days === 28, '1900-02 是平年 28 天（百年不闰）', String(g4.days));
const g5 = cal.monthGrid(2000, 2);
say(g5.days === 29, '2000-02 是闰年 29 天（四百年又闰）', String(g5.days));
// 格子总数必须是 7 的整数倍，否则日历最后一行会缺角
let allMul7 = true;
for (let y = 2024; y <= 2027; y++) {
  for (let m = 1; m <= 12; m++) {
    const g = cal.monthGrid(y, m);
    if (g.total % 7 !== 0 || g.lead + g.days > g.total) allMul7 = false;
  }
}
say(allMul7, '任意年月的格子总数都是 7 的整数倍且装得下（2024~2027 全扫）');
say(cal.monthGrid(2026, 9).lead === new Date(2026, 8, 1).getDay(), '前导格数 = 1 号的星期', String(cal.monthGrid(2026, 9).lead));

/* ---------- 区间 ---------- */
console.log('\n=== ④ monthRange / yearRange ===');
say(JSON.stringify(cal.monthRange(2026, 9)) === '{"from":"2026-09-01","to":"2026-09-30"}', '9 月区间');
say(JSON.stringify(cal.monthRange(2026, 2)) === '{"from":"2026-02-01","to":"2026-02-28"}', '2 月区间按真实天数收尾');
say(JSON.stringify(cal.yearRange(2026)) === '{"from":"2026-01-01","to":"2026-12-31"}', '年区间');

/* ---------- 未来的边界 ---------- */
console.log('\n=== ⑤ 不能翻到未来 ===');
say(cal.isFutureMonth(t.y, t.m) === false, '本月不是未来');
say(cal.isFutureMonth(t.y + 1, t.m) === true, '明年同月是未来');
const nm = cal.addMonths(t.y, t.m, 1);
say(cal.isFutureMonth(nm.y, nm.m) === true, '下个月也是未来 → 「下一月」按钮应该置灰');
const pm = cal.addMonths(t.y, t.m, -1);
say(cal.isFutureMonth(pm.y, pm.m) === false, '上个月不是未来 → 可以往前翻');
say(cal.isFutureYear(t.y) === false && cal.isFutureYear(t.y + 1) === true, '年份边界');

/* ---------- key 的格式 ---------- */
console.log('\n=== ⑥ 补零 ===');
say(cal.dayKey(2026, 1, 5) === '2026-01-05', 'dayKey 个位月/日补零', cal.dayKey(2026, 1, 5));
say(cal.monthKey(2026, 1) === '2026-01', 'monthKey 个位月补零', cal.monthKey(2026, 1));
say(cal.pad(7) === '07', 'pad');

const bad = rows.filter((x) => !x).length;
console.log('\n================ 汇总 ================');
console.log('日历纯函数：' + (rows.length - bad) + ' / ' + rows.length + ' 通过');
process.exit(bad ? 1 : 0);
