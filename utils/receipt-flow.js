/**
 * utils/receipt-flow.js —— 票据解析流程：进度 → 待确认 → 入账
 *
 * 2026-10-15。
 *
 * ── 为什么必须有"待确认"这一步 ──
 *   OCR / 表格解析**一定会错**（手写小票、糊照片、合并单元格）。
 *   直接入账的话，老板月底对不上账，而且不知道该信哪一笔 —— 比不识别还糟。
 *   所以流程钉死为：
 *       上传 → 分步进度 → **待您确认（可改可忽略）** → 确认才入账
 *
 * ── 为什么单独一个文件 ──
 *   纯函数、不碰 wx —— 能在 Node 里直接单测。
 *   这里有两条**必须测对**的逻辑：
 *     ① 进度状态机不能跳步/回退
 *     ② 入账前的校验必须挡住脏数据（金额 ≤ 0、方向不合法）
 *   第 ② 条是"数字铁律"在入口处的第一道闸。
 */

/* 解析进度的固定三步（图标名必须在 tools/gen-icons.js 的 ICONS 里存在——
 * 写错不会报错，只会渲染出一个空方块，所以有一道 icon-usage 体检查这个） */
const STEP_ICONS = ['check', 'pen', 'crop'];

/**
 * 建初始进度步骤。
 * @param {string} step0Text 第一步文案（如"正在识别图片文字（OCR）"）
 * @returns {Array<{icon:string, text:string, state:string}>} state: wait|run|done
 */
function buildSteps(step0Text) {
  return [
    { icon: STEP_ICONS[0], text: String(step0Text == null ? '' : step0Text), state: 'run' },
    { icon: STEP_ICONS[1], text: '提取金额与对象', state: 'wait' },
    { icon: STEP_ICONS[2], text: '词法纠错归类', state: 'wait' }
  ];
}

/**
 * 推进一步（纯函数，返回新数组，不改原数组）。
 *
 * 规则：
 *   · 当前 run 的变 done
 *   · 下一个 wait 的变 run
 *   · 已经是最后一步 → 全部 done，返回 allDone=true
 *
 * @param {Array} steps
 * @returns {{steps:Array, allDone:boolean}}
 */
function advance(steps) {
  const list = (steps || []).map(function (s) {
    return { icon: s.icon, text: s.text, state: s.state };
  });

  let idx = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].state === 'run') { idx = i; break; }
  }

  /* 没有 run 的 → 找第一个 wait 起跑（容错：调用方可能给了个半成品） */
  if (idx < 0) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].state === 'wait') { list[i].state = 'run'; return { steps: list, allDone: false }; }
    }
    /* 全 done 了 */
    return { steps: list, allDone: true };
  }

  list[idx].state = 'done';
  if (idx + 1 < list.length) {
    list[idx + 1].state = 'run';
    return { steps: list, allDone: false };
  }
  return { steps: list, allDone: true };
}

/**
 * 入账前校验一条记录。**不合格就剔除，不进账。**
 *
 * @param {{t?:string, txt?:string, amt?:any, who?:string}} r
 * @returns {{ok:boolean, reason?:string, fixed?:object}}
 */
function validateRow(r) {
  const x = r || {};

  /* 方向必须是 in / out */
  let t = String(x.t == null ? '' : x.t).trim();
  if (t === '收入' || t === 'in' || t === '1') t = 'in';
  else if (t === '支出' || t === 'out' || t === '2') t = 'out';
  else return { ok: false, reason: '方向不合法' };

  /* 金额必须是 > 0 的有限数 */
  const amt = Number(String(x.amt == null ? '' : x.amt).replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: '金额不是正数' };
  if (amt > 1e9) return { ok: false, reason: '金额大得离谱' };

  /* 摘要不能空 */
  const txt = String(x.txt == null ? '' : x.txt).trim();
  if (!txt) return { ok: false, reason: '没有摘要' };

  return {
    ok: true,
    fixed: {
      t: t,
      txt: txt.slice(0, 30),
      amt: Math.round(amt * 100) / 100,
      who: String(x.who == null ? '' : x.who).trim().slice(0, 20)
    }
  };
}

/**
 * 批量校验。返回干净的行 + 被剔除的原因（**不静默丢数据**）。
 * @param {Array} rows
 * @returns {{clean:Array, rejected:Array<{row:any, reason:string}>}}
 */
function validateRows(rows) {
  const clean = [];
  const rejected = [];
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const v = validateRow(list[i]);
    if (v.ok) clean.push(v.fixed);
    else rejected.push({ row: list[i], reason: v.reason });
  }
  return { clean: clean, rejected: rejected };
}

/**
 * 汇总（金额用整数分累加，避免浮点误差 —— 这是"数字铁律"的具体做法）。
 * @param {Array} rows
 * @returns {{count:number, inSum:number, outSum:number, net:number}}
 */
function summarize(rows) {
  const list = rows || [];
  let inC = 0;
  let outC = 0;
  for (let i = 0; i < list.length; i++) {
    const cents = Math.round(Number(list[i].amt) * 100);
    if (!Number.isFinite(cents)) continue;
    if (list[i].t === 'in') inC += cents;
    else outC += cents;
  }
  return {
    count: list.length,
    inSum: inC / 100,
    outSum: outC / 100,
    net: (inC - outC) / 100
  };
}

/** 金额 → ¥1,234.00 */
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '¥0.00';
  const neg = v < 0;
  const a = Math.abs(v);
  const int = Math.floor(a);
  const dec = Math.round((a - int) * 100);
  let s = String(int);
  let out = '';
  while (s.length > 3) {
    out = ',' + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  out = s + out;
  return (neg ? '-¥' : '¥') + out + '.' + (dec < 10 ? '0' + dec : String(dec));
}

/**
 * 构造"待您确认"卡片的数据。
 *
 * @param {Array} rows 解析出来的原始行
 * @param {string} note 一句话说明（如"小票 1 张，识别到 2 笔"）
 * @returns {{note:string, rows:Array, count:number, inSum:number, outSum:number, net:number,
 *            money:Function, rejected:Array, canConfirm:boolean, hint:string|null}}
 */
function buildConfirm(rows, note) {
  const v = validateRows(rows);
  const sum = summarize(v.clean);

  /* 一句人话的提示：有被剔除的要明说，不能让老板以为都收进去了 */
  let hint = null;
  if (v.rejected.length) {
    hint = '有 ' + v.rejected.length + ' 行没认出来（' + v.rejected[0].reason + '），已跳过';
  }

  return {
    note: String(note == null ? '' : note),
    rows: v.clean,
    count: sum.count,
    inSum: sum.inSum,
    outSum: sum.outSum,
    net: sum.net,
    money: money,
    rejected: v.rejected,
    canConfirm: sum.count > 0,
    hint: hint
  };
}

/** 确认入账后的一句话（给老板看的，不是给系统看的） */
function confirmText(sum) {
  const s = sum || {};
  const parts = ['已入账 ' + (s.count || 0) + ' 笔'];
  if (s.inSum) parts.push('进 ' + money(s.inSum));
  if (s.outSum) parts.push('出 ' + money(s.outSum));
  return parts.join('，');
}

module.exports = {
  STEP_ICONS: STEP_ICONS,
  buildSteps: buildSteps,
  advance: advance,
  validateRow: validateRow,
  validateRows: validateRows,
  summarize: summarize,
  money: money,
  buildConfirm: buildConfirm,
  confirmText: confirmText
};
