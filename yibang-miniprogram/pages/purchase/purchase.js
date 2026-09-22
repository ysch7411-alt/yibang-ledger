// pages/purchase/purchase.js
// 采购单核对页（默认只读）
// 设计口径：AI 在后端把单据拆成结构化明细，前端只负责「给老板看一眼 + 确认入库」。
// 默认不出现任何输入框；只有老板主动点「识别有误？改一下」才进入编辑态。
const app = getApp();
const fmt = require('../../utils/format');
const kb = require('../../utils/keyboard');

const DOC_KEY = 'pending_doc';

/**
 * 品类候选。
 * 只放「中小门店进货真的会出现的」几类，不放一长串标准行业分类 ——
 * 老板扫一眼就得认出来，选项太多等于没有选项。
 * AI 归的类 + 本单已有品类会排在这些前面，所以这里只是兜底。
 */
const COMMON_CATS = ['钢材', '五金', '电料', '水暖', '包装', '办公', '劳保', '机械配件', '运费'];

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

/** 2.500 → 2.5；null → '—' */
function trimNum(v) {
  const n = toNum(v);
  if (n === null) return '—';
  return String(parseFloat(n.toFixed(4)));
}

Page(Object.assign({
  data: {
    /* 键盘避让：只给「品类弹层」用。明细行那几个输入框在页面流里，
       它们要的恰恰是 adjust-position 的自动上推，所以**没**给它们关掉。见 utils/keyboard.js */
    kbLift: 0,
    supplier: '',
    orderNo: '',
    date: '',
    rawText: '',
    items: [],
    totalText: '0.00',
    editing: false,
    saving: false,

    // 多张单据相关的展示字段
    photoCount: 0,        // 这次一共拍了几张
    groups: [],           // 多张时按来源分好的组（只读态用它）
    sources: [],          // 每张的供应商/小计/项数
    issues: [],           // 没认出内容、或没认出明细的那几张
    multi: false,         // 是不是多张汇总
    supplierMixed: false,

    // 品类纠正（AI 归类不准时，老板点一下就能改）
    catSheet: false,
    catEditing: null,
    catCurrent: '',        // 当前这一行的品类，用来把选项里的它标出来
    catOptions: [],
    catInput: ''
  },

  onLoad() {
    const doc = wx.getStorageSync(DOC_KEY);
    if (!doc) {
      wx.showToast({ title: '没有待核对的单据', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    wx.removeStorageSync(DOC_KEY);

    // 留一张「这张单子从哪来的」凭据，出了问题能回溯到原始照片
    this._fileId = doc.fileId || null;
    this._fileIds = Array.isArray(doc.fileIds) ? doc.fileIds : [];

    const raw = doc.items || [];
    const items = raw.map((it, i) => this.decorate(it, i + 1));
    const photoCount = Number(doc.photoCount) || 1;

    this.setData({
      supplier: doc.supplier || '',
      orderNo: doc.orderNo || '',
      date: doc.date || fmt.ymd(),
      rawText: doc.text || '',
      items: items.length ? items : [this.decorate({}, 1)],
      // 一行都没拆出来时，只读态只会显示一排「未填写品名 · —」，没有意义，
      // 直接进编辑态让老板自己补一行
      editing: items.length === 0,
      photoCount,
      sources: doc.sources || [],
      issues: doc.issues || [],
      multi: photoCount > 1,
      supplierMixed: !!doc.supplierMixed
    });
    this.recalc();
    this.buildGroups();
  },

  /**
   * 多张汇总时，按「来自第几张」分组 —— 老板是对着手上那叠纸单一张张核的，
   * 按来源分组他才能对得上；平铺成一长串反而更难查。
   * 只读态用它；编辑态仍然是平铺（改的时候不关心原来第几张）。
   */
  buildGroups() {
    if (!this.data.multi) {
      this.setData({ groups: [] });
      return;
    }
    const byFrom = {};
    this.data.items.forEach((it) => {
      const k = Number(it.from) || 1;
      (byFrom[k] = byFrom[k] || []).push(it);
    });
    const groups = Object.keys(byFrom)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => {
        const src = (this.data.sources || []).find((s) => Number(s.index) === k) || {};
        const sum = byFrom[k].reduce((s, it) => s + (Number(it.amount) || 0), 0);
        return {
          no: k,
          label: '第 ' + k + ' 张',
          supplier: src.supplier || '',
          count: byFrom[k].length,
          totalText: fmt.money(sum),
          items: byFrom[k]
        };
      });
    this.setData({ groups });
  },

  /** 补上展示字段：金额、数量/单价的友好显示 */
  decorate(it, no) {
    const qty = toNum(it.qty);
    const price = toNum(it.price);
    let amount = toNum(it.amount);
    if (amount === null && qty !== null && price !== null) amount = Math.round(qty * price * 100) / 100;
    const category = it.category || '';
    return {
      no: no || 1,
      from: Number(it.from) || 1,
      name: it.name || '',
      spec: it.spec || '',
      unit: it.unit || '',
      // 行级维度原样带过去，入库时后端要按行写 supplier_name / category / source_file_id
      category,
      catText: category || '未分类',
      supplierName: it.supplierName || it.supplier_name || '',
      sourceFileId: it.sourceFileId || it.source_file_id || null,
      qty: qty === null ? '' : String(qty),
      price: price === null ? '' : String(price),
      amount: amount === null ? 0 : amount,
      qtyText: trimNum(qty),
      priceText: trimNum(price),
      amountText: fmt.money(amount === null ? 0 : amount)
    };
  },

  /* ---------------- 品类纠正 ---------------- */

  /**
   * 候选品类：当前项排最前（方便一眼确认），再是本单已出现的，
   * 最后兜底放几个常见类。去重后截断 —— 底部弹层一屏放得下才好点。
   */
  buildCatOptions(cur) {
    const out = [];
    const push = (v) => {
      const s = String(v == null ? '' : v).trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    };
    push(cur);
    (this.data.items || []).forEach((it) => push(it.category));
    COMMON_CATS.forEach(push);
    return out.slice(0, 12);
  },

  openCat(e) {
    const no = Number(e.currentTarget.dataset.no);
    const it = (this.data.items || []).find((x) => x.no === no);
    if (!it) return;
    this.setData({
      catSheet: true,
      catEditing: no,
      // 把当前品类标出来：老板点开是想确认/改，得先看见现在算的是哪一类
      catCurrent: it.category || '',
      catInput: '',
      catOptions: this.buildCatOptions(it.category)
    });
  },

  closeCat() {
    if (this.data.catEditing === null && !this.data.catSheet) return;
    this.setData({ catSheet: false, catEditing: null, catCurrent: '', catInput: '' });
  },

  pickCat(e) {
    this.setCat(e.currentTarget.dataset.v || '');
  },

  onCatInput(e) {
    this.setData({ catInput: e.detail.value });
  },

  /** 自定义品类：空输入直接忽略，不要建出一个「空白品类」的统计桶 */
  applyCatInput() {
    const v = String(this.data.catInput || '').trim().slice(0, 16);
    if (!v) {
      wx.showToast({ title: '写个品类名', icon: 'none' });
      return;
    }
    this.setCat(v);
  },

  setCat(v) {
    const no = this.data.catEditing;
    const items = this.data.items;
    const it = (items || []).find((x) => x.no === no);
    if (it) {
      it.category = v;
      it.catText = v || '未分类';
    }
    this.setData({ items, catSheet: false, catEditing: null, catCurrent: '', catInput: '' });
    // 分组卡片里也显示品类，改完要一起刷新
    this.buildGroups();
  },

  /** 弹层遮罩点击：吞掉事件，别让点击穿透到底下的明细行 */
  noop() {},

  recalc() {
    let total = 0;
    this.data.items.forEach((it) => {
      if (it.amount) total += it.amount;
    });
    this.setData({ totalText: fmt.money(total) });
  },

  /* ---------------- 编辑态（默认不出现） ---------------- */

  startEdit() {
    this.setData({ editing: true });
  },

  /** 增删之后重排序号，保证只读态的分组编号连续 */
  renumber(list) {
    return list.map((it, i) => Object.assign({}, it, { no: i + 1 }));
  },

  doneEdit() {
    // 顺手把空行清掉，别让老板面对一堆空输入框
    const kept = this.data.items.filter((it) => it.name || it.amount);
    this.setData({ items: kept.length ? this.renumber(kept) : this.data.items, editing: false });
    this.recalc();
    this.buildGroups();
  },

  onItemField(e) {
    const idx = Number(e.currentTarget.dataset.i);
    const field = e.currentTarget.dataset.f;
    const items = this.data.items;
    items[idx][field] = e.detail.value;

    const qty = toNum(items[idx].qty);
    const price = toNum(items[idx].price);
    if (qty !== null && price !== null) {
      items[idx].amount = Math.round(qty * price * 100) / 100;
    }
    items[idx].qtyText = trimNum(items[idx].qty);
    items[idx].priceText = trimNum(items[idx].price);
    items[idx].amountText = fmt.money(items[idx].amount || 0);

    this.setData({ items });
    this.recalc();
  },

  delItem(e) {
    const items = this.data.items.slice();
    items.splice(Number(e.currentTarget.dataset.i), 1);
    this.setData({ items: this.renumber(items) });
    this.recalc();
    this.buildGroups();
  },

  addItem() {
    const items = this.data.items.concat([this.decorate({}, this.data.items.length + 1)]);
    this.setData({ items: this.renumber(items) });
  },

  /* ---------------- 入库 ---------------- */

  async save() {
    if (this.data.saving) return;
    const items = this.data.items
      .filter((it) => it.name || it.amount)
      .map((it) => ({
        name: it.name,
        spec: it.spec,
        unit: it.unit,
        qty: toNum(it.qty),
        price: toNum(it.price),
        amount: it.amount,
        // 行级维度：合并成一张之后，「按供应商 / 按品类统计」全靠这三个字段
        category: it.category || '',
        supplierName: it.supplierName || '',
        sourceFileId: it.sourceFileId || null
      }));

    if (!items.length) {
      wx.showToast({ title: '没有可入库的明细', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '入库中…', mask: true });
    try {
      const res = await app.request('/purchase/save', {
        method: 'POST',
        data: {
          supplier: this.data.supplier,
          orderNo: this.data.orderNo,
          date: this.data.date,
          fileId: this._fileId || null,
          // 多张汇总时把所有来源照片都记下来，以后能回溯到原始几张单子
          fileIds: this._fileIds,
          items
        }
      });
      wx.hideLoading();
      if (res && res.code === 0) {
        const d = res.data || {};
        // 结果留给记账页播报：返回后老板要立刻看到「刚才那一下成了」，
        // 只弹一个 1.5 秒的 toast 会随页面切换一起消失，等于没说。
        wx.setStorageSync('flash_receipt', {
          at: Date.now(),
          tone: 'ok',
          title: '采购单已入库',
          detail: [
            this.data.supplier || '',
            (d.itemCount || items.length) + ' 项',
            '¥' + fmt.money(d.total)
          ].filter(Boolean).join(' · ')
        });
        setTimeout(() => wx.navigateBack(), 260);
      } else {
        wx.showToast({ title: (res && res.msg) || '入库失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '入库失败，请重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  }
}, kb.methods));   // 键盘避让：onKbFocus / onKbBlur / onKbHeight / setKb
