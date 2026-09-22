// 时区口径回归：后端返回 ISO(UTC) 时必须还原成本地日期，否则整体差一天/差 8 小时
const f = require('F:/2026-09-19/new-chat-1/yibang-miniprogram/utils/format.js');

const isoDate = '2026-09-18T16:00:00.000Z'; // = 北京时间 2026-09-19 00:00
const isoTime = '2026-09-19T06:09:00.000Z'; // = 北京时间 2026-09-19 14:09

const rows = [
  ['ISO DATE  dayKey   ', f.dayKey(isoDate), '2026-09-19'],
  ['ISO DATE  dayLabel ', f.dayLabel(isoDate), '今天'],
  ['ISO DATE  monthKey ', f.monthKey(isoDate), '2026-09'],
  ['ISO TIME  hhmm     ', f.hhmm(isoTime), '14:09'],
  ['纯字符串  dayKey   ', f.dayKey('2026-09-18'), '2026-09-18'],
  ['Date 实例 dayKey   ', f.dayKey(new Date(2026, 8, 19)), '2026-09-19'],
  ['本地 ymd           ', f.ymd(), '今天日期']
];

let bad = 0;
rows.forEach(([name, got, want]) => {
  const pass = name.indexOf('本地 ymd') >= 0 ? got.length === 10 : got === want;
  if (!pass) bad++;
  console.log((pass ? 'PASS ' : 'FAIL ') + name + ' → ' + got + (pass ? '' : '（期望 ' + want + '）'));
});

const g = f.groupByDay([
  { id: 1, type: 1, amount: '5000', contact_name: '张老板', content: '货款', record_date: isoDate, created_at: isoTime }
]);
const ok = g[0].label === '今天' && g[0].items[0]._time === '14:09';
if (!ok) bad++;
console.log((ok ? 'PASS ' : 'FAIL ') + '分组标签/时间 → ' + g[0].label + ' / ' + g[0].items[0]._time);

console.log(bad ? '\n' + bad + ' 项失败' : '\n时区口径全部正确');
process.exit(bad ? 1 : 0);
