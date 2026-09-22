const f = require('../yibang-miniprogram/utils/format.js');
console.log('ymd      ', f.ymd());
console.log('ym       ', f.ym());
console.log('money s  ', f.money('1234567.891'), '  <- 字符串输入（mysql2 DECIMAL）不再崩');
console.log('money n  ', f.money(0));
console.log('money neg', f.money(-1234.5));
console.log('dayLabel ', f.dayLabel(f.ymd()), '/', f.dayLabel('2026-09-18'), '/', f.dayLabel('2025-01-05'));
const rows = [
  { id: 1, type: 1, amount: '5000.00', content: '货款', contact_name: '张老板', record_date: f.ymd(), created_at: '2026-09-19 09:12:00' },
  { id: 2, type: 2, amount: '320.5', content: '买菜', contact_name: null, record_date: f.ymd(), created_at: '2026-09-19 10:02:00' },
  { id: 3, type: 3, amount: '800', content: '欠款', contact_name: '李四', record_date: '2026-09-18', created_at: '2026-09-18 15:00:00' }
];
const g = f.groupByDay(rows);
console.log('分组数   ', g.length);
g.forEach((s) => console.log('   ', s.label, '| 收', s.incomeText, '| 支', s.expenseText, '| 条数', s.items.length, '| 首条', s.items[0]._title, s.items[0]._amount, s.items[0]._tagCls));
console.log('高亮     ', JSON.stringify(f.highlight('张老板货款5000', '张')));
console.log('高亮无KW ', JSON.stringify(f.highlight('abc', '')));
console.log('isIncome ', f.isIncomeType(1), f.isIncomeType(5), f.isIncomeType(2), f.isIncomeType(6));
const own = g.reduce((n, s) => n + s.items.length, 0);
console.log('无损校验 ', own === rows.length ? 'OK 全部记录都进入了分组' : 'FAIL');
