/**
 * 第一批单元测试（2026-09-23）
 *
 * 为什么从这几个函数开始：这个库 1.5 万行、管钱，而它最贵的一类 bug 是
 * **"数字算错但页面上看不出来"** —— 不会报错、不会崩溃，只是账不对。
 * 所以第一批只测"守门员"和"口径"：
 *   · 金额换算与校验（reconcileAmount / normAmount）—— 决定钱数对不对
 *   · 类型归一（normType）—— 原来写成 `Number(x) || 2`，99 会原样放行
 *   · 日期口径（isDay / dayOr / ymd / getBusinessDate）—— 决定账落在哪一天
 *   · 品类清洗（normCategory）
 *
 * 跑法（零依赖，用 Node 自带的测试器）：
 *   cd yibang-server && node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/ledger');

/* ==================== 金额换算：单价×数量 ====================
   reconcileAmount 存在的唯一理由：老板会说「三斤，五块一斤」，
   模型有时只抓住"5"当总额。这个函数负责把它纠正成 15。 */
test('reconcileAmount：数量×单价已算对 → 不动它', () => {
  const r = L.reconcileAmount(15, 3, 5);
  assert.strictEqual(r.amount, 15);
  assert.strictEqual(r.fixed, false);
});

test('reconcileAmount：把单价当成了总额 → 纠正为 15（这是它存在的理由）', () => {
  const r = L.reconcileAmount(5, 3, 5);
  assert.strictEqual(r.amount, 15);
  assert.strictEqual(r.fixed, true, '这种情况必须标记 fixed，前端会提示"金额是算出来的"');
});

test('reconcileAmount：把数量当成了总额（张冠李戴）→ 纠正为 15', () => {
  const r = L.reconcileAmount(3, 3, 5);
  assert.strictEqual(r.amount, 15);
  assert.strictEqual(r.fixed, true);
});

test('reconcileAmount：数量为 1 时不算"漏乘" → 保持原值', () => {
  // 1 斤 5 块，总额就是 5 —— 不能因为"等于单价"就误判成漏乘
  const r = L.reconcileAmount(5, 1, 5);
  assert.strictEqual(r.amount, 5);
  assert.strictEqual(r.fixed, false);
});

test('reconcileAmount：没给数量或单价 → 不猜，原样返回', () => {
  assert.strictEqual(L.reconcileAmount(5, 0, 5).fixed, false);
  assert.strictEqual(L.reconcileAmount(5, 3, 0).fixed, false);
});

test('reconcileAmount：金额为空但有数量单价 → 用算出来的顶上', () => {
  const r = L.reconcileAmount(0, 3, 5);
  assert.strictEqual(r.amount, 15);
  assert.strictEqual(r.fixed, true);
});

/* ==================== 金额守门 ==================== */
test('normAmount：带货币符号的字符串要能认（Number() 会得到 NaN）', () => {
  const r = L.normAmount('¥500');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.amount, 500);
});

test('normAmount：负数取绝对值（方向由 type 决定，不由符号决定）', () => {
  const r = L.normAmount(-50);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.amount, 50);
});

test('normAmount：0 元必须拒绝', () => {
  const r = L.normAmount(0);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /不能为 0/);
});

test('normAmount：低于一分的要拒绝（分以下存不进 DECIMAL）', () => {
  const r = L.normAmount(0.005);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /0\.01/);
});

test('normAmount：超上限要拒绝', () => {
  const r = L.normAmount(L.AMOUNT_MAX + 1);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /过大/);
});

test('normAmount：边界值恰好通过', () => {
  assert.strictEqual(L.normAmount(L.AMOUNT_MIN).ok, true);
  assert.strictEqual(L.normAmount(L.AMOUNT_MAX).ok, true);
});

/* ==================== 类型归一 ====================
   这里是全项目最危险的一处：原来写成 `Number(type) || 2` ——
   99 和 -1 会被原样放行，报表数字就错了，而页面看不出来。 */
test('normType：1~6 的数字原样通过', () => {
  [1, 2, 3, 4, 5, 6].forEach((n) => assert.strictEqual(L.normType(n), n));
});

test('normType：中文名能转成码', () => {
  assert.strictEqual(L.normType('收入'), 1);
  assert.strictEqual(L.normType('支出'), 2);
  assert.strictEqual(L.normType('应收'), 3);
  assert.strictEqual(L.normType('付款'), 6);
});

test('normType：带空白的字符串要去空白后再认', () => {
  assert.strictEqual(L.normType('  收入  '), 1);
});

test('normType：非法值必须返回 null（不能兜底成某个默认类型）', () => {
  assert.strictEqual(L.normType(99), null, '99 放行会让报表静默算错');
  assert.strictEqual(L.normType(-1), null);
  assert.strictEqual(L.normType(0), null);
  assert.strictEqual(L.normType(''), null);
  assert.strictEqual(L.normType(null), null);
  assert.strictEqual(L.normType(undefined), null);
  assert.strictEqual(L.normType('随便什么'), null);
});

/* ==================== 日期校验 ==================== */
test('isDay：合法日期通过', () => {
  assert.strictEqual(L.isDay('2026-09-23'), true);
  assert.strictEqual(L.isDay('2024-02-29'), true, '闰年 2 月 29 日应合法');
});

test('isDay：正则能过但实际不存在的日期必须挡住（回读比对）', () => {
  // 这是"只用正则校验"会漏掉的一类：^\d{4}-\d{2}-\d{2}$ 会放行它们，
  // 丢给 MySQL 直接 500
  assert.strictEqual(L.isDay('2026-13-99'), false);
  assert.strictEqual(L.isDay('2026-02-30'), false);
  assert.strictEqual(L.isDay('2026-04-31'), false);
  assert.strictEqual(L.isDay('2025-02-29'), false, '平年没有 2 月 29');
});

test('isDay：格式不对要被挡住', () => {
  assert.strictEqual(L.isDay('2026-9-23'), false, '必须是两位月份');
  assert.strictEqual(L.isDay('2026/09/23'), false);
  assert.strictEqual(L.isDay(''), false);
  assert.strictEqual(L.isDay(null), false);
});

test('dayOr：合法用自己的，非法用兜底值', () => {
  assert.strictEqual(L.dayOr('2026-09-23', 'FALLBACK'), '2026-09-23');
  assert.strictEqual(L.dayOr('乱写的', 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(L.dayOr(null, 'FALLBACK'), 'FALLBACK');
});

/* ==================== 时区：全项目最贵的一个坑 ====================
   绝不能用 date.toISOString().slice(0,10) —— 服务器是 UTC+8，
   它会先转 UTC，把本地 00:00 变成前一天的 16:00Z，切出来少一天。 */
test('ymd：本地时间必须按本地算，不能走 toISOString（否则少一天）', () => {
  assert.strictEqual(L.ymd(new Date(2026, 8, 19)), '2026-09-19');
  assert.strictEqual(L.ymd(new Date(2026, 0, 1)), '2026-01-01');
});

test('ymd：凌晨 00:30 仍然算当天（用 toISOString 会变成前一天）', () => {
  const d = new Date(2026, 8, 19, 0, 30, 0);
  assert.strictEqual(L.ymd(d), '2026-09-19');
  // 对照组：证明这个断言确实能抓到 toISOString 的错误
  assert.notStrictEqual(L.ymd(d), '2026-09-18');
});

/* ==================== 营业日：早餐店那个线上 bug ==================== */
test('getBusinessDate：截止时间 02:00 时，凌晨 01:00 的账算前一天', () => {
  // 这条就是线上真实故障：早餐店老板早上记账，账落到了昨天
  const d = new Date(2026, 8, 23, 1, 0, 0);
  assert.strictEqual(L.getBusinessDate(d, '02:00'), '2026-09-22');
});

test('getBusinessDate：过了截止时间就归当天', () => {
  const d = new Date(2026, 8, 23, 10, 0, 0);
  assert.strictEqual(L.getBusinessDate(d, '02:00'), '2026-09-23');
});

test('getBusinessDate：截止时间恰好那一刻算新的一天', () => {
  const d = new Date(2026, 8, 23, 2, 0, 0);
  assert.strictEqual(L.getBusinessDate(d, '02:00'), '2026-09-23');
});

test('getBusinessDate：截止时间 00:00 = 按自然日', () => {
  const d = new Date(2026, 8, 23, 0, 30, 0);
  assert.strictEqual(L.getBusinessDate(d, '00:00'), '2026-09-23');
  assert.strictEqual(L.getBusinessDate(d, ''), '2026-09-23');
});

/* ==================== 品类清洗 ==================== */
test('normCategory：去首尾空白', () => {
  assert.strictEqual(L.normCategory('  买菜  '), '买菜');
});

test('normCategory：连续空白压成一个', () => {
  assert.strictEqual(L.normCategory('买   菜'), '买 菜');
});

test('normCategory：空值返回 null（"未分类"是合法状态）', () => {
  assert.strictEqual(L.normCategory(''), null);
  assert.strictEqual(L.normCategory('   '), null);
  assert.strictEqual(L.normCategory(null), null);
});

test('normCategory：超长要截断（不能把 500 字塞进类别列）', () => {
  const r = L.normCategory('菜'.repeat(100));
  assert.ok(r.length <= 32, '实际长度 ' + r.length);
});

/* ==================== 数字解析 ==================== */
test('num：能认带符号/带千分位的字符串', () => {
  assert.strictEqual(L.num('¥500'), 500);
  assert.strictEqual(L.num('1,280'), 1280);
  assert.strictEqual(L.num('36.50'), 36.5);
  assert.strictEqual(L.num(42), 42);
});

test('num：认不出来时返回 null（不是 0 —— 0 是合法金额，null 才表示"没解析出来"）', () => {
  /* ⚠️ 我第一版这里断言的是 0，跑出来是 null —— **测试纠正了我的假设** ✓
     实现更聪明：`null` 能区分"用户没给这个数"和"用户给了 0"，而调用处都是
     `num(x) || 0` 的写法，两条路都安全。若改成返回 0，
     0.01 元这种真实小额就和"没给"混在一起了 —— **这里是故意返回 null 的，别改。** */
  assert.strictEqual(L.num('abc'), null);
  assert.strictEqual(L.num(''), null);
  assert.strictEqual(L.num(null), null);
  assert.strictEqual(L.num(undefined), null);
});

test('round2：常规金额四舍五入到分', () => {
  assert.strictEqual(L.round2(1.004), 1);
  assert.strictEqual(L.round2(36.504), 36.5);
  assert.strictEqual(L.round2(2.675), 2.68);
});

test('round2：⚠️ 已知边界 —— 恰好"半分"时结果取决于浮点表示（误差 ≤1 分）', () => {
  /* 这是跑测试时发现的真实行为，写成用例把它**钉住**，而不是假装不存在：
       1.005 * 100       → 100.49999999999999 → 舍成 1.00
       0.1 * 10.05       → 1.0050000000000001 → 进成 1.01
     同一个数学值 1.005，两条路径结果不同 ✗ —— 误差上限 1 分。 */
  assert.strictEqual(L.round2(1.005), 1);
  assert.strictEqual(L.round2(0.1 * 10.05), 1.01);
  /* 🔴 **故意没改**：改成 `Math.round((v + Number.EPSILON) * 100) / 100`
     或内部改用整数分，会动到**所有新算出的金额** ——
     为了 1 分的边界去承担"改动金额计算"的风险，不划算。
     哪天真要治，正确做法是内部统一用整数分（大改，要单独排期）。
     **这条是"已知限制"，不是"待修 bug"，别顺手改。** */
});
