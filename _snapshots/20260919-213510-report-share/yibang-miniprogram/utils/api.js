// utils/api.js —— 接口适配层
// 作用：把「后端实际返回的数据形状」规整成「页面期望的数据形状」。
// 页面因此不再关心 res.data 是数组还是 {list}、字段叫 contact_name 还是 creator_name，
// 也不会再因为某个接口还没上线而整页空白。
const app = () => getApp();
const fmt = require('./format');

/** AI 返回的中文类型 → 后端类型编码 */
const TYPE_CODE = { 收入: 1, 支出: 2, 应收: 3, 应付: 4, 回款: 5, 付款: 6 };

/**
 * AI 类接口的超时时长。
 * 这些接口在服务端要串起「上传 → OCR/语音 → 大模型」，实测偶发 15 秒以上。
 * 用默认的 15 秒会直接掐断 —— 2026-09-19 真机就是这么失败的：
 * 信标显示 `doc-fail request:fail timeout`，用户只看到「没成功」，服务端却一切正常。
 * 宁可多等，也不要假装失败。
 */
const AI_TIMEOUT = 60000;

/** 静默降级：接口未上线 / 报错时返回默认值，页面展示「空状态」而不是白屏 */
async function safe(promise, fallback) {
  try {
    const res = await promise;
    if (res && res.code === 0) return res.data;
    return fallback;
  } catch (err) {
    console.warn('[api] 请求失败，已降级：', err && err.message);
    return fallback;
  }
}

/**
 * 带原因的调用：把「请求根本没发出去」和「后端明确拒绝」分开返回。
 *
 * 为什么不能只用 safe()：safe 把两种情况都压成一个 fallback，
 * 页面只能回一句模糊的「暂时不可用」——真机上报「语音转写没成功」时，
 * 光看这句话完全不知道是网络、域名、还是后端在报错。这里保留原因。
 *
 * 返回 { reached, code, msg, data }
 *   reached=false → 请求没到服务器（网络/域名/超时），msg 已经是翻好的中文
 *   reached=true  → 到了，看 code：0 成功，其余 msg 是后端原话
 */
async function call(promise) {
  try {
    const res = await promise;
    if (!res || typeof res !== 'object') {
      return { reached: true, code: -1, msg: '返回格式异常', data: null };
    }
    return {
      reached: true,
      code: typeof res.code === 'number' ? res.code : 0,
      msg: res.msg || '',
      data: res.data === undefined ? null : res.data
    };
  } catch (err) {
    // 优先用翻译好的 message；errMsg 是微信原文，留给信标做取证，不直接展示给用户
    return {
      reached: false,
      code: -1,
      msg: (err && err.message) || '请求失败',
      raw: (err && err.errMsg) || '',
      data: null
    };
  }
}

/** 往来汇总：{ receivable, payable } —— 数值统一转数字，避免字符串调 .toFixed 抛错 */
async function getContactSummary() {
  const d = await safe(app().request('/contact/summary', { silent: true }), {});
  return {
    receivable: fmt.toNum((d || {}).receivable),
    payable: fmt.toNum((d || {}).payable)
  };
}

/** 往来对象列表。兼容返回数组或 {list} 两种形状 */
async function getContactList(type) {
  const url = type ? '/contact/list?type=' + type : '/contact/list';
  const d = await safe(app().request(url, { silent: true }), []);
  const list = Array.isArray(d) ? d : (d.list || []);
  return list.map((it) => Object.assign({}, it, { _balance: fmt.toNum(it.balance) }));
}

/**
 * 流水列表。
 * opts.from / opts.to 传 YYYY-MM-DD 就按日期闭区间取 —— 报表要「按区间带明细」，
 * 只给一页是不够的（本月可能几百笔）。opts 省略时行为跟以前完全一样。
 */
async function getRecords(page = 1, size = 20, opts) {
  const o = opts || {};
  let url = `/record/list?page=${page}&size=${size}`;
  if (o.from) url += '&from=' + o.from;
  if (o.to) url += '&to=' + o.to;
  const d = await safe(app().request(url, { silent: true }), []);
  return Array.isArray(d) ? d : (d.list || []);
}

/** 每日汇总：{ income, expense, net, details } */
async function getDailySummary(date) {
  const d = await safe(app().request('/record/daily-summary?date=' + date, { silent: true }), {});
  const income = fmt.toNum(d.income);
  const expense = fmt.toNum(d.expense);
  // details 是原始行，必须补上展示字段，否则模板里取不到 _amount
  const details = (Array.isArray(d.details) ? d.details : []).map(fmt.decorateRecord);
  return {
    income,
    expense,
    net: d.net === undefined || d.net === null ? income - expense : fmt.toNum(d.net),
    count: details.length,
    details,
    incomeText: fmt.money(income),
    expenseText: fmt.money(expense),
    netText: fmt.money(Math.abs(income - expense)),
    isPositive: income - expense >= 0
  };
}

/**
 * 本月汇总。
 * 后端暂无 /record/month-summary，先用「尝试接口 → 失败则本地聚合」的方式兜底，
 * 保证页面可用；后端补齐后去掉 fallback 分支即可。
 */
async function getMonthSummary(month) {
  const viaApi = await safe(app().request('/record/month-summary?month=' + month, { silent: true }), null);
  if (viaApi) {
    return { income: fmt.toNum(viaApi.income), expense: fmt.toNum(viaApi.expense) };
  }
  const rows = await getRecords(1, 200);
  let income = 0;
  let expense = 0;
  rows.forEach((r) => {
    if (fmt.monthKey(r.record_date) !== month) return;
    if (fmt.isIncomeType(r.type)) income += fmt.toNum(r.amount);
    else expense += fmt.toNum(r.amount);
  });
  return { income, expense, fallback: true };
}

/** 待审核列表：后端在 /staff/pending，字段名也不一致，这里做一次翻译 */
async function getPendingList() {
  const d = await safe(app().request('/staff/pending', { silent: true }), []);
  const list = Array.isArray(d) ? d : (d.list || []);
  return list.map((it) => Object.assign({}, it, {
    _amount: fmt.money(it.amount),
    _typeText: fmt.TYPE_TEXT[Number(it.type)] || '支出',
    _staffName: it.creator_name || it.nickname || it.staff_name || '店员',
    _dateText: fmt.dayKey(it.created_at) + ' ' + fmt.hhmm(it.created_at)
  }));
}

/** 店员列表：后端返回纯数组，原前端按 {list, pendingCount} 读取 → 永远读不到 */
async function getStaffList() {
  const d = await safe(app().request('/staff/list', { silent: true }), []);
  const list = Array.isArray(d) ? d : (d.list || []);
  const pendingCount = (d && d.pendingCount) || 0;
  return {
    list: list.map((it) => Object.assign({}, it, {
      _title: it.nickname || it.shop_name || '未命名店员',
      _roleText: Number(it.role) === 2 ? '店员' : '老板'
    })),
    pendingCount
  };
}

/** 客户详情：后端暂无 /contact/detail，用列表数据本地拼装兜底 */
async function getContactDetail(id) {
  const viaApi = await safe(app().request('/contact/detail?id=' + id, { silent: true }), null);
  if (viaApi && viaApi.contact) {
    return {
      contact: viaApi.contact,
      records: (viaApi.records || []).map(fmt.decorateRecord)
    };
  }
  const list = await getContactList();
  const contact = list.find((it) => String(it.id) === String(id)) || {};
  const all = await getRecords(1, 100);
  const records = all
    .filter((r) => String(r.contact_id) === String(id))
    .map(fmt.decorateRecord);
  return { contact, records, fallback: true };
}

/**
 * 记一笔。
 * 后端只接受 contact_id，而 AI 识别出来的是联系人「名字」——原实现直接丢弃了该字段，
 * 导致往来对象永远不入库、应收应付永远为 0。这里补上「按名字找 → 找不到就建」的逻辑。
 *
 * 另外把「数量 / 单位 / 单价 / 收付方式」一起送上去：
 * 老板说的是「辣椒3斤，5块钱一斤」，金额是 AI 算出来的。只存一个金额，
 * 事后没人知道这钱怎么来的；数量和单价留下来才能核对，也才答得出「现金收了多少」。
 */
async function saveRecord(payload) {
  let contactId = payload.contactId || null;
  const name = (payload.contactName || '').trim();

  if (!contactId && name) {
    const list = await getContactList();
    const hit = list.find((c) => c.name === name);
    if (hit) {
      contactId = hit.id;
    } else {
      // 收/回款 → 客户(1)；支出/付款 → 供应商(2)
      const ctype = [1, 3, 5].includes(Number(payload.type)) ? 1 : 2;
      const created = await safe(
        app().request('/contact/create', {
          method: 'POST',
          data: { name, type: ctype },
          silent: true
        }),
        null
      );
      if (created && created.id) contactId = created.id;
    }
  }

  return app().request('/record/create', {
    method: 'POST',
    data: {
      contact_id: contactId,
      type: Number(payload.type) || 2,
      amount: fmt.toNum(payload.amount),
      qty: payload.qty === undefined ? null : payload.qty,
      unit: payload.unit || '',
      unit_price: payload.unitPrice === undefined ? null : payload.unitPrice,
      pay_method: payload.method || '',
      content: payload.content || '',
      record_date: payload.recordDate || fmt.ymd()
    }
  });
}

/**
 * 自然语言 → 结构化账目。
 * 兼容三种返回形状：单对象 / {records:[]} / 数组（后端 prompt 升级为多笔后无需改前端）。
 * 返回 records 为空时说明 AI 没读出金额，调用方需要向用户追问，而不是硬存一笔 0 元。
 * ok=false 时 msg 一定带上原因（请求没到 / 后端消息），页面照原样显示，不要自己编。
 */
async function parseText(text) {
  const r = await call(
    app().request('/record/ai-parse', { method: 'POST', data: { text }, silent: true, timeout: AI_TIMEOUT })
  );
  if (!r.reached) return { ok: false, records: [], said: text, msg: r.msg || '网络不可用' };
  if (r.code !== 0) return { ok: false, records: [], said: text, msg: r.msg || ('接口返回 ' + r.code) };

  const res = r.data;
  let raw = [];
  if (Array.isArray(res)) raw = res;
  else if (res && Array.isArray(res.records)) raw = res.records;
  else if (res && Array.isArray(res.list)) raw = res.list;
  else if (res) raw = [res];
  else return { ok: false, records: [], said: text, msg: '后端没返回内容' };

  const records = raw
    .map((o) => ({
      amount: fmt.toNum(o.amount),
      qty: o.qty === undefined || o.qty === null ? null : fmt.toNum(o.qty),
      unit: String(o.unit || '').trim(),
      // 后端字段叫 unitPrice，页面上一直叫 price；这里统一成 qty/unit/price 三件套
      unitPrice: fmt.toNum(o.unitPrice !== undefined ? o.unitPrice : o.unit_price),
      method: String(o.method || o.pay_method || '').trim(),
      amountFixed: !!o.amountFixed,
      type: TYPE_CODE[o.type] || Number(o.type_code) || 2,
      contactName: String(o.contact || o.contact_name || '').trim(),
      content: String(o.content || o.remark || o.summary || '').trim(),
      recordDate: o.record_date || o.date || fmt.ymd()
    }))
    .filter((r2) => r2.amount > 0);

  return { ok: true, records, said: text };
}

/**
 * 单据（照片 / 文件 / 文字）→ 结构化采购单。
 * 后端把「OCR + 拆行」一次做完，前端不做任何表单：拿到结果直接给老板确认。
 * 刻意不抛异常，把两种失败分开返回：
 *   · offline —— 接口不可达 / 超时（页面提示「暂时不可用」，让用户换条路）
 *   · failed  —— 后端明确拒绝（如「不是图片文件」），msg 原样透传给用户
 */
async function parseDoc(payload) {
  const r = await call(
    app().request('/purchase/parse-doc', { method: 'POST', data: payload, silent: true, timeout: AI_TIMEOUT })
  );
  if (!r.reached) return { ok: false, reason: 'offline', msg: r.msg, raw: r.raw };
  if (r.code !== 0) return { ok: false, reason: 'failed', msg: r.msg || '识别失败' };

  const d = r.data || {};
  return {
    ok: true,
    doc: {
      supplier: d.supplier || '',
      orderNo: d.orderNo || '',
      date: d.date || fmt.ymd(),
      total: fmt.toNum(d.total),
      items: Array.isArray(d.items) ? d.items : [],
      text: d.text || ''
    }
  };
}

/**
 * 「越用越懂」的可见账本。
 * 后端一直在默默积累词表与纠正，但用户看不见 —— 招牌卖点等于白做。
 * 这里把"它到底学会了什么"取回来给「我的」页展示。
 * 拿不到就回全 0，页面显示引导语，不要报错。
 */
async function getMemoryInfo() {
  const d = await safe(app().request('/memory/info', { silent: true }), null);
  const x = d || {};
  return {
    termCount: Number(x.termCount) || 0,
    nameCount: Number(x.nameCount) || 0,
    learnedFromUser: Number(x.learnedFromUser) || 0,
    correctionCount: Number(x.correctionCount) || 0,
    nameMap: Array.isArray(x.nameMap) ? x.nameMap : [],
    reasons: Array.isArray(x.reasons) ? x.reasons : []
  };
}

/** 采购单历史列表。
 * 兼容数组与 {list} 两种形状 —— 后端目前返回数组，但别让页面依赖这一点。
 */
async function getPurchaseList(page = 1, size = 20) {
  const d = await safe(
    app().request(`/purchase/list?page=${page}&size=${size}`, { silent: true }),
    []
  );
  return Array.isArray(d) ? d : (d.list || []);
}

/** 采购单明细（含表头）。拿不到就回空，页面显示「明细没读到」而不是整页崩 */
async function getPurchaseDetail(id) {
  const d = await safe(app().request('/purchase/detail?id=' + id, { silent: true }), null);
  if (!d) return { order: null, items: [] };
  return { order: d.order || null, items: Array.isArray(d.items) ? d.items : [] };
}

/**
 * 采购分类统计：按供应商 / 按品类。
 *
 * 关键点：统计走的是**明细行**（purchase_items），不是采购单表头。
 * 因为老板要的是「多张单据合并成一张、但还能按供应商/品类拆开看」——
 * 合并之后表头只有一个供应商名，逐行的 supplier_name / category 才是真维度。
 *
 * groupBy 只认 supplier | category，其它值后端会回落到 supplier；这里也做一次白名单，
 * 免得前端某个页面手滑传个 'category2' 进去，拿到一份按供应商的报表还以为是对的。
 *
 * 拿不到数据返回 null —— 让页面显示「暂时取不到」，绝不返回一个全 0 的假报表。
 */
async function getPurchaseStats(opts) {
  const o = opts || {};
  const groupBy = o.groupBy === 'category' ? 'category' : 'supplier';
  const range = fmt.rangeOf(o.range || 'd30');
  const from = o.from || range.from;
  const to = o.to || range.to;

  const d = await safe(
    app().request(`/purchase/stats?from=${from}&to=${to}&groupBy=${groupBy}`, { silent: true }),
    null
  );
  if (!d) return null;

  const raw = Array.isArray(d.list) ? d.list : [];
  const total = fmt.toNum(d.total);
  // 条形长度以榜首为基准，不是以总额 —— 否则一家独大时其它全是一条看不见的线
  const max = raw.reduce((m, x) => Math.max(m, fmt.toNum(x.amount)), 0);

  return {
    groupBy,
    from: d.from || from,
    to: d.to || to,
    total,
    totalText: fmt.money(total),
    count: raw.length,
    list: raw.map((x, i) => {
      const amount = fmt.toNum(x.amount);
      return {
        rank: i + 1,
        key: x.key || '未分类',
        amount,
        amountText: fmt.money(amount),
        count: Number(x.count) || 0,
        orders: Number(x.orders) || 0,
        // 最小 6%：排在尾巴上的那两三家也得看得见，不然用户会以为漏了
        pct: max ? Math.max(6, Math.round((amount / max) * 100)) : 0,
        share: total ? Math.round((amount / total) * 100) : 0
      };
    })
  };
}

/** 批量入库：AI 一句话里读出几笔就存几笔 */
async function saveRecords(records) {
  const saved = [];
  for (const r of records) {
    const res = await saveRecord(r);
    if (res && res.code === 0) saved.push(Object.assign({}, r, { id: res.data && res.data.id }));
  }
  return saved;
}

/**
 * 改一笔 / 撤销一笔。
 * 两者都用 silent，由调用方读 code 决定提示文案——纠错失败的提示要能区分
 * 「接口不通」和「这笔数据有问题」，不能都糊成一句「改不了」。
 */
function updateRecord(id, payload) {
  return app().request('/record/update', {
    method: 'POST',
    data: Object.assign({ id }, payload),
    silent: true
  });
}

function deleteRecord(id) {
  return app().request('/record/delete', { method: 'POST', data: { id }, silent: true });
}

module.exports = {
  safe,
  call,
  AI_TIMEOUT,
  getContactSummary,
  getContactList,
  getRecords,
  getDailySummary,
  getMonthSummary,
  getPendingList,
  getStaffList,
  getContactDetail,
  parseText,
  parseDoc,
  getMemoryInfo,
  getPurchaseList,
  getPurchaseDetail,
  getPurchaseStats,
  saveRecord,
  saveRecords,
  updateRecord,
  deleteRecord
};
