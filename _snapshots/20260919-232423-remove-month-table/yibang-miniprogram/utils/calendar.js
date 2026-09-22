// utils/calendar.js —— 日历的日期算术（纯函数，好单测）
//
// 为什么单独放一个文件：日历里最烦的从来不是渲染，是"这个月第一天是周几""上个月是几月"
// 这类算术。它们跟 UI 无关、全是纯函数，混在页面里既难测又容易被后人改错。
// 全部用本地时间构造 Date，不用 toISOString（那会按 UTC 算，北京时间 0-8 点会差一天）。

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' */
function dayKey(y, m, d) {
  return y + '-' + pad(m) + '-' + pad(d);
}

/** 'YYYY-MM' */
function monthKey(y, m) {
  return y + '-' + pad(m);
}

/** 某年某月有多少天。new Date(y, m, 0) = 上个月最后一天，自动处理大小月和闰年 */
function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

/**
 * 月历网格。
 * 返回 { lead, days, total }：
 *   lead  — 1 号之前要空几格（表头从「日」开始，所以直接用 getDay()）
 *   days  — 这个月有多少天
 *   total — 补齐到 7 的整数倍之后一共几格（渲染时按它循环，行尾不会缺角）
 */
function monthGrid(y, m) {
  const lead = new Date(y, m - 1, 1).getDay();   // 0=周日
  const days = daysInMonth(y, m);
  return { lead, days, total: Math.ceil((lead + days) / 7) * 7 };
}

/** 月份加减，自动跨年。delta 可为负 */
function addMonths(y, m, delta) {
  const t = y * 12 + (m - 1) + delta;
  return { y: Math.floor(t / 12), m: (t % 12 + 12) % 12 + 1 };
}

/** 某月整月的查询区间（含首尾） */
function monthRange(y, m) {
  return { from: dayKey(y, m, 1), to: dayKey(y, m, daysInMonth(y, m)) };
}

/** 某年整年的查询区间 */
function yearRange(y) {
  return { from: dayKey(y, 1, 1), to: dayKey(y, 12, 31) };
}

/** 今天的 Y/M/D 三件套 */
function todayParts() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

/**
 * 这个"月"是不是已经超出今天了。
 * 日历不能翻到未来 —— 未来的账还没发生，让老板翻过去只会看到一片空白，
 * 然后怀疑是不是数据丢了。
 */
function isFutureMonth(y, m) {
  const t = todayParts();
  return y * 12 + m > t.y * 12 + t.m;
}

/** 同理，年份不能超过今年 */
function isFutureYear(y) {
  return y > todayParts().y;
}

module.exports = {
  pad,
  dayKey,
  monthKey,
  daysInMonth,
  monthGrid,
  addMonths,
  monthRange,
  yearRange,
  todayParts,
  isFutureMonth,
  isFutureYear
};
