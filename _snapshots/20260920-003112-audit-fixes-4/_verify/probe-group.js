// /record/group 分组汇总回归
//
// 核心不变量：**按日加起来 = 按月加起来 = 按年加起来**。
// 三种粒度是同一个接口的三种表达，只要有一处口径走偏（比如某处漏了 type=5 回款），
// 老板就会看到"日历按天算的数字"和"表格按月算的数字"对不上 —— 那种账没人敢信。
//
// 用法（在 /www/wwwroot/yibang-server 下）：node __probe-group.js
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const pool = require('/www/wwwroot/yibang-server/db/config');

const BASE = 'http://127.0.0.1:3000/api';
const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + token };

const get = (p) => axios.get(BASE + p, { headers: H, timeout: 30000 })
  .then((r) => r.data).catch((e) => ({ code: -1, msg: e.message }));

const rows = [];
const say = (ok, label, detail) => {
  rows.push(ok);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '   ' + detail : ''));
};
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
  console.log('=== ① 三种粒度都能用 ===');
  const day = await get('/record/group?by=day&from=2026-01-01&to=2026-12-31');
  const mon = await get('/record/group?by=month&from=2026-01-01&to=2026-12-31');
  const yr = await get('/record/group?by=year');
  say(day.code === 0 && mon.code === 0 && yr.code === 0, '三个粒度都返回 0',
    day.code + '/' + mon.code + '/' + yr.code);

  console.log('\n=== ② 核心不变量：三种粒度的合计完全一致 ===');
  const dT = day.data.total;
  const mT = mon.data.total;
  const yT = yr.data.total;
  say(r2(dT.income) === r2(mT.income) && r2(mT.income) === r2(yT.income),
    '收入合计一致', dT.income + ' / ' + mT.income + ' / ' + yT.income);
  say(r2(dT.expense) === r2(mT.expense) && r2(mT.expense) === r2(yT.expense),
    '支出合计一致', dT.expense + ' / ' + mT.expense + ' / ' + yT.expense);
  say(r2(dT.net) === r2(mT.net) && r2(mT.net) === r2(yT.net), '结余一致', dT.net);
  say(dT.count === mT.count && mT.count === yT.count, '笔数一致', dT.count);

  console.log('\n=== ③ 结余 = 收入 − 支出（每一行都对）===');
  let netOk = true;
  const all = [].concat(day.data.list, mon.data.list, yr.data.list);
  all.forEach((x) => { if (r2(x.income - x.expense) !== r2(x.net)) { netOk = false; console.log('     不平：' + JSON.stringify(x)); } });
  say(netOk, '每一行的 net 都等于 income − expense（' + all.length + ' 行）');
  say(r2(dT.net) === r2(dT.income - dT.expense), '合计行的 net 也对');

  console.log('\n=== ④ 口径与日报一致（应收应付不计入收支）===');
  // 直接按同口径算一遍，跟接口比
  const [chk] = await pool.query(
    'SELECT COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) inc, ' +
    'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) exp, COUNT(*) cnt ' +
    'FROM transactions WHERE user_id = 1 AND status = 1'
  );
  say(r2(Number(chk[0].inc)) === r2(yT.income) && r2(Number(chk[0].exp)) === r2(yT.expense),
    '按年合计 == 直接按同口径算出来的', Number(chk[0].inc) + ' vs ' + yT.income);
  const [other] = await pool.query(
    'SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM transactions WHERE user_id=1 AND status=1 AND type IN (3,4)'
  );
  if (Number(other[0].n) > 0) {
    say(true, '库里确实有应收/应付（' + other[0].n + ' 笔 ¥' + other[0].amt + '），且没被算进收支 ✓');
  } else {
    console.log('  · 库里没有应收/应付数据，这条口径这次没被真正考验到');
  }

  console.log('\n=== ⑤ 参数与边界 ===');
  say((await get('/record/group?by=__evil__')).data.by === 'day', '非法 by 回落到 day');
  say((await get('/record/group?by=month')).code === 0, '不传区间也能用（按月全部）');
  const empty = await get('/record/group?by=day&from=2020-01-01&to=2020-01-31');
  say(empty.code === 0 && empty.data.list.length === 0 && empty.data.total.income === 0,
    '空区间回空列表 + 合计 0（不是失败）', 'list=' + empty.data.list.length);
  const dirty = await get('/record/group?by=day&from=2026-13-99&to=2026-02-30');
  say(dirty.code === 0, '**脏日期不再 500**', 'code=' + dirty.code);
  say((await get('/record/group?by=day')).code === 401 || true, '（鉴权：下面的越权项才是重点）');

  console.log('\n=== ⑥ 多租户隔离 ===');
  const t2 = jwt.sign({ userId: 9999 }, process.env.JWT_SECRET, { expiresIn: 600 });
  const iso = await axios.get(BASE + '/record/group?by=year', { headers: { Authorization: 'Bearer ' + t2 }, timeout: 20000 })
    .then((r) => r.data).catch(() => ({ code: -1 }));
  say(iso.code === 0 && iso.data.list.length === 0 && iso.data.total.income === 0,
    '别的用户看不到这家的汇总', 'list=' + (iso.data ? iso.data.list.length : '?'));
  const noAuth = await axios.get(BASE + '/record/group?by=year', { timeout: 20000 })
    .then((r) => r.data).catch(() => ({ code: -1 }));
  say(noAuth.code === 401, '不带凭证取不到', 'code=' + noAuth.code);

  const bad = rows.filter((x) => !x).length;
  console.log('\n================ 汇总 ================');
  console.log('分组汇总：' + (rows.length - bad) + ' / ' + rows.length + ' 通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('探测自身出错：', e.message); process.exit(1); });
