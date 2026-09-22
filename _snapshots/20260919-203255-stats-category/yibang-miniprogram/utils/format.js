// utils/format.js —— 数据格式化与账目语义（全站唯一口径，避免 10 个页面各写一套）

/** 交易类型编码 → 展示文案 */
const TYPE_TEXT = {
  1: '收入',
  2: '支出',
  3: '应收',
  4: '应付',
  5: '回款',
  6: '付款'
};

/** 类型编码 → 视觉语义（颜色 / 标签样式 / 正负号） */
/**
 * 视觉规则：金额正负看颜色（绿=钱进来，红=钱出去），
 * 标签颜色只用来区分「概念类别」，两者不互相干扰。
 */
const TYPE_STYLE = {
  1: { cls: 'c-income', tag: 'tag-income', sign: '+' },
  2: { cls: 'c-expense', tag: 'tag-expense', sign: '-' },
  3: { cls: 'c-income', tag: 'tag-info', sign: '+' },
  4: { cls: 'c-expense', tag: 'tag-warn', sign: '-' },
  5: { cls: 'c-income', tag: 'tag-income', sign: '+' },
  6: { cls: 'c-expense', tag: 'tag-expense', sign: '-' }
};

/** 后端 DECIMAL 字段经由 mysql2 返回的是字符串，"0" 调 .toFixed 会直接抛错 —— 统一在这里兜住 */
function toNum(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/** 金额：千分位 + 两位小数 */
function money(v) {
  const n = toNum(v);
  const abs = Math.abs(n).toFixed(2);
  const [int, dec] = abs.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
}

/** 带符号金额（用于流水展示） */
function signedMoney(v, type) {
  const sign = (TYPE_STYLE[type] || TYPE_STYLE[2]).sign;
  return sign + '¥' + money(Math.abs(toNum(v)));
}

/**
 * 本地日期 YYYY-MM-DD
 * 注意：不能用 toISOString()，它按 UTC 计算 —— 北京时间 0:00~8:00 会返回「昨天」，
 * 导致每日汇总查错日期、记账落到前一天。这是原实现里真实存在的缺陷。
 */
function ymd(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 本地月份 YYYY-MM */
function ym(date) {
  return ymd(date).slice(0, 7);
}

/**
 * 把后端返回的日期还原成本地 Date。
 * mysql2 会把 DATE / DATETIME 返回成 JS Date，JSON 序列化后是 UTC 的 ISO 串
 * （如 2026-09-18T16:00:00.000Z 其实是北京时间 9-19 00:00）。
 * 直接 String().slice(0,10) 会让北京时间 0:00~8:00 的记录整体差一天、时间差 8 小时。
 */
function toLocalDate(v) {
  if (v instanceof Date) return v;
  if (v == null) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/** 归一成本地 YYYY-MM-DD */
function dayKey(v) {
  const d = toLocalDate(v);
  if (d) return ymd(d);
  return String(v == null ? '' : v).slice(0, 10);
}

/** 归一成本地 YYYY-MM */
function monthKey(v) {
  const d = toLocalDate(v);
  if (d) return ymd(d).slice(0, 7);
  return String(v == null ? '' : v).slice(0, 7);
}

/** 取记录时间 HH:mm（本地时区） */
function hhmm(v) {
  if (!v) return '';
  const p = (n) => String(n).padStart(2, '0');
  const d = toLocalDate(v);
  if (d) return p(d.getHours()) + ':' + p(d.getMinutes());
  const s = String(v).replace('T', ' ');
  const m = s.match(/(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : '';
}

/** 相对日期标签：今天 / 昨天 / 9月18日 / 2025年9月18日 */
function dayLabel(dateStr) {
  const s = dayKey(dateStr);
  if (!s) return '未标注日期';
  const today = ymd();
  if (s === today) return '今天';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (s === ymd(y)) return '昨天';
  const parts = s.split('-');
  if (parts.length < 3) return s;
  return Number(parts[0]) === new Date().getFullYear()
    ? Number(parts[1]) + '月' + Number(parts[2]) + '日'
    : parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日';
}

/**
 * 统计区间：近 7 天 / 近 30 天 / 本月 / 上月。
 *
 * 为什么放在这里而不是写在页面里：区间边界是「口径」，不是「样式」。
 * 各页各写一套日期加减，迟早出现「采购页说本月、报表页说上月」这种对不上的账。
 * 用本地时间构造，不用 toISOString 切片（那会把 GMT+8 的月初算成上月末一天）。
 */
function rangeOf(kind) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (kind === 'lastMonth') {
    // new Date(y, m, 0) = 上个月最后一天，不用记大小月
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: ymd(start), to: ymd(end), label: '上月' };
  }
  if (kind === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: ymd(start), to: ymd(today), label: '本月' };
  }
  const n = kind === 'd7' ? 7 : 30;
  const start = new Date(today.getTime() - (n - 1) * 86400000);
  return { from: ymd(start), to: ymd(today), label: '近 ' + n + ' 天' };
}

/** 日期时间 → 时间戳（按本地时区） */
function toTime(v) {
  if (!v) return 0;
  const d = toLocalDate(v);
  if (d) return d.getTime();
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
}

/**
 * 给一条流水补上展示所需的派生字段
 * 说明：列表渲染前一次性算好，WXML 里只做取值 —— 复杂表达式写在模板中会拖慢渲染
 */
function decorateRecord(item) {
  const type = Number(item.type) || 2;
  const style = TYPE_STYLE[type] || TYPE_STYLE[2];
  const time = hhmm(item.created_at) || String(item.record_date || '').slice(5);
  const hasContact = !!item.contact_name;
  return Object.assign({}, item, {
    _type: type,
    _typeText: TYPE_TEXT[type] || '支出',
    _cls: style.cls,
    _tagCls: style.tag,
    _amount: signedMoney(item.amount, type),
    _dateLabel: dayLabel(item.record_date),
    _time: time,
    // 标题优先取往来对象：老板是「按人记人」的，人名比事由更好认
    _title: item.contact_name || item.content || '未填写事由',
    _subText: (hasContact && item.content ? item.content + ' · ' : '') + time
  });
}

/** 按日期分组（今天 / 昨天 / 具体日期），并统计每组收支 */
function groupByDay(list) {
  const order = [];
  const map = {};
  list.forEach((raw) => {
    const item = decorateRecord(raw);
    const key = dayKey(item.record_date);
    if (!map[key]) {
      map[key] = { key, label: dayLabel(key), income: 0, expense: 0, items: [] };
      order.push(key);
    }
    const g = map[key];
    g.items.push(item);
    const amt = toNum(item.amount);
    if (item._type === 1 || item._type === 5) g.income += amt;
    else if (item._type === 2 || item._type === 6) g.expense += amt;
  });
  return order
    .sort((a, b) => (a < b ? 1 : -1))
    .map((k) => {
      const g = map[k];
      return Object.assign(g, {
        incomeText: money(g.income),
        expenseText: money(g.expense),
        hasExpense: g.expense > 0,
        // 只标了应收/应付、没有实际收付款的分组，不显示「收 ¥0.00 支 ¥0.00」这种噪声
        hasSummary: g.income > 0 || g.expense > 0
      });
    });
}

/** 关键字高亮：把文本切成 [{t, hl}] 片段，比 rich-text 轻且可控 */
function highlight(text, keyword) {
  const src = String(text == null ? '' : text);
  const kw = String(keyword || '').trim();
  if (!kw) return [{ t: src, hl: false }];
  const nodes = [];
  let rest = src;
  let i = rest.toLowerCase().indexOf(kw.toLowerCase());
  while (i >= 0) {
    if (i > 0) nodes.push({ t: rest.slice(0, i), hl: false });
    nodes.push({ t: rest.slice(i, i + kw.length), hl: true });
    rest = rest.slice(i + kw.length);
    i = rest.toLowerCase().indexOf(kw.toLowerCase());
  }
  if (rest) nodes.push({ t: rest, hl: false });
  return nodes.length ? nodes : [{ t: src, hl: false }];
}

/** 收 / 支 归类（供前端本地聚合兜底使用） */
function isIncomeType(type) {
  const t = Number(type);
  return t === 1 || t === 5;
}

module.exports = {
  TYPE_TEXT,
  TYPE_STYLE,
  toNum,
  money,
  signedMoney,
  ymd,
  ym,
  dayKey,
  monthKey,
  hhmm,
  dayLabel,
  rangeOf,
  toTime,
  decorateRecord,
  groupByDay,
  highlight,
  isIncomeType
};
