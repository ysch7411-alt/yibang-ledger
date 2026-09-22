// 时区口径回归：后端返回 ISO(UTC) 时必须还原成本地日期，否则整体差一天 / 差 8 小时。
//
// ⚠️ 这个测试原来把日期写死成 '2026-09-18T16:00:00.000Z' 并断言它的标签是「今天」——
// 那只在 2026-09-19 当天成立。**过了午夜它就自己红了**（实测 09-20 00:33 报 2 项失败）。
//
// 依赖"今天是几号"的断言有两种坏法：① 半夜突然报假警，让人白白排查代码；
// ② 换个日期又悄悄放过一个真问题。所以这里改成**围绕"今天"构造**：
// 断言的是「本地今天 00:00 这个时刻，序列化成 UTC 后必须还能还原成本地今天」——
// 这条在任何一天都成立，而且正是要防的那个坑（北京时间 0:00~8:00 被算成前一天）。
const f = require('F:/2026-09-19/new-chat-1/yibang-miniprogram/utils/format.js');

const now = new Date();
const todayYmd = f.ymd(now);

// 本地今天 00:00 → toISOString() 会给出「前一天 16:00Z」（北京 UTC+8）。
// 这正是 mysql2 把 DATE 返回成 JS Date 后 JSON 序列化出来的形状。
const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const isoDate = localMidnight.toISOString();

// 本地今天 14:09 的 UTC 表示
const localTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 9);
const isoTime = localTime.toISOString();

console.log('今天的本地日期：' + todayYmd + '（对应 ISO：' + isoDate + '）\n');

const rows = [
  ['ISO DATE  dayKey   ', f.dayKey(isoDate), todayYmd],
  ['ISO DATE  dayLabel ', f.dayLabel(isoDate), '今天'],
  ['ISO DATE  monthKey ', f.monthKey(isoDate), todayYmd.slice(0, 7)],
  ['ISO TIME  hhmm     ', f.hhmm(isoTime), '14:09'],
  // 纯字符串（后端用 DATE_FORMAT 取出来的形状）不能被当成 UTC 再减 8 小时
  ['纯字符串  dayKey   ', f.dayKey('2026-09-18'), '2026-09-18'],
  // Date 实例按本地时区解释
  ['Date 实例 dayKey   ', f.dayKey(new Date(2026, 8, 19)), '2026-09-19'],
  ['本地 ymd           ', f.ymd(), todayYmd],
  // 手写 ymd 必须用本地时区：UTC 的月初在 +8 时区要能正确落到本月
  ['本地 ymd(指定日期) ', f.ymd(new Date(2026, 0, 1, 0, 30)), '2026-01-01']
];

let bad = 0;
rows.forEach(([name, got, want]) => {
  const pass = got === want;
  if (!pass) bad++;
  console.log((pass ? 'PASS ' : 'FAIL ') + name + ' → ' + got + (pass ? '' : '（期望 ' + want + '）'));
});

// 分组标签与时间：整条链路（ISO → 本地日期 → 标签 + 时刻）一起验
const g = f.groupByDay([
  { id: 1, type: 1, amount: '5000', contact_name: '张老板', content: '货款', record_date: isoDate, created_at: isoTime }
]);
const okLabel = g[0].key === todayYmd && g[0].label === '今天';
const okTime = g[0].items[0]._time === '14:09';
if (!okLabel || !okTime) bad++;
console.log((okLabel ? 'PASS ' : 'FAIL ') + '分组日期/标签 → ' + g[0].key + ' / ' + g[0].label +
  (okLabel ? '' : '（期望 ' + todayYmd + ' / 今天）'));
console.log((okTime ? 'PASS ' : 'FAIL ') + '分组时刻     → ' + g[0].items[0]._time + (okTime ? '' : '（期望 14:09）'));

// 昨天的记录标签必须是「昨天」—— 这条能抓住"标签永远返回今天"这种退化
const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
const gy = f.groupByDay([{ id: 2, type: 2, amount: '1', record_date: y.toISOString(), created_at: isoTime }]);
const okY = gy[0].label === '昨天';
if (!okY) bad++;
console.log((okY ? 'PASS ' : 'FAIL ') + '昨天          → ' + gy[0].label + (okY ? '' : '（期望 昨天）'));

console.log(bad ? '\n' + bad + ' 项失败' : '\n时区口径全部正确');
process.exit(bad ? 1 : 0);
