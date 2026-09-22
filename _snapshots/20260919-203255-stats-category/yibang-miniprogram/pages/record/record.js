// pages/record/record.js
// 设计原则：录入路径上不放任何选择、不放任何表单。
// 用户只做一个动作 —— 按住说 / 拍一张 / 打一句，AI 负责归类编排，结果直接入账。
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');

const RECEIPT_HOLD = 8000; // 结果条停留时长（留出「撤销」的操作窗口）

Page({
  data: {
    todayLabel: '',
    loading: true,

    daily: { incomeText: '0.00', expenseText: '0.00', netText: '0.00', count: 0, isPositive: true, details: [] },
    receivable: '0.00',
    payable: '0.00',
    receivableCount: 0,
    payableCount: 0,
    sections: [],

    // 空账本时第一眼看到的东西：讲清"这是什么、替我干什么"。
    // 原来这段在注册页，但注册页已经不再是门槛，新用户其实落在这里。
    firstTips: [
      { icon: '/images/ic-say.svg', text: '不用打字、不用选类别，按住说一句就自动归类入账' },
      { icon: '/images/ic-scan.svg', text: '不用月底翻箱倒柜找单据，拍一张就把明细拆好' },
      { icon: '/images/ic-learn.svg', text: '不用每次都重教一遍，你怎么叫客户它就怎么记' }
    ],

    draft: '',
    focusDraft: false,
    recording: false,
    recSec: 0,
    recTime: '0:00',
    working: false,
    workingText: 'AI 正在整理…',

    // 结果条：{ tone:'ok'|'ask'|'error', title, detail, said, first }
    receipt: null,
    askAmount: '',

    showFix: false,
    fix: { id: null, amount: '', type: 2, contactName: '', content: '', recordDate: '', sourceText: '', aiType: null },
    showDaily: false,

    // 待识别的照片：拍照/多选先攒在这里，用户点「识别这几张」才逐张认
    // （拍照一次只能一张，要支持"连续拍多张"就必须有个暂存的地方）
    shots: []
  },

  onLoad() {
    const d = new Date();
    this.setData({
      todayLabel: d.getMonth() + 1 + '月' + d.getDate() + '日 星期' + '日一二三四五六'[d.getDay()]
    });
    this.initRecorder();
  },

  onShow() {
    this.loadData();
    this.consumeFlash();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 0 });
  },

  /**
   * 二级页（采购单核对）带回的结果播报。
   * 用「跨页暂存」而不是 toast：toast 会随页面切换消失，老板等于什么都没看到。
   * 超过 30 秒的旧消息直接丢弃，避免下次进页面莫名弹一条。
   */
  consumeFlash() {
    const f = wx.getStorageSync('flash_receipt');
    if (!f) return;
    wx.removeStorageSync('flash_receipt');
    if (Date.now() - (f.at || 0) > 30000) return;
    this.say({ tone: f.tone || 'ok', title: f.title, detail: f.detail });
  },

  onHide() {
    if (this.data.recording) this.abortRecord();
  },

  onUnload() {
    this.abortRecord();
  },

  /* ---------------- 数据 ---------------- */

  async loadData() {
    try {
      const [summary, daily, contacts] = await Promise.all([
        api.getContactSummary(),
        api.getDailySummary(fmt.ymd()),
        api.getContactList()
      ]);

      this.setData({
        receivable: fmt.money(summary.receivable),
        payable: fmt.money(summary.payable),
        receivableCount: contacts.filter((c) => c._balance > 0).length,
        payableCount: contacts.filter((c) => c._balance < 0).length,
        daily
      });

      const rows = await api.getRecords(1, 12);
      this.setData({ sections: fmt.groupByDay(rows), loading: false });
    } catch (err) {
      // 真机实测：这一步只在开发者工具里正常，真机上会停在半路（首页停在骨架屏）。
      // 没有这段，服务端只看到 3 个 GET 就没了，完全不知道是哪儿抛的。
      app.beacon('load-throw', (err && err.message) || String(err));
      this.setData({ loading: false });
    }
  },

  /* ---------------- ① 按住说话，松手入账 ---------------- */

  initRecorder() {
    const rm = wx.getRecorderManager();

    rm.onStart(() => {
      this._recStartAt = Date.now();
      this.setData({ recording: true, recSec: 0, recTime: '0:00' });
      this._timer = setInterval(() => {
        const sec = Math.floor((Date.now() - this._recStartAt) / 1000);
        this.setData({
          recSec: sec,
          recTime: Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0')
        });
        if (sec >= 58) this.stopRecord();
      }, 300);
      // 手指松得比录音启动还快时，在这里补一次停止
      if (this._pendingStop) {
        this._pendingStop = false;
        this.stopRecord();
      }
    });

    rm.onStop((res) => {
      this.clearTimer();
      const cancelled = this._cancelled;
      const sec = this.data.recSec;
      this._cancelled = false;
      this.setData({ recording: false });
      if (cancelled || sec < 1) return; // 上滑取消 / 误触
      this.transcribe(res.tempFilePath);
    });

    rm.onError((err) => {
      this.clearTimer();
      this.setData({ recording: false });
      const msg = (err && err.errMsg) || '';
      if (/auth|deny|permission/i.test(msg)) {
        wx.showModal({
          title: '需要麦克风权限',
          content: '开启后才能用语音记账：点「去开启」→ 打开麦克风开关',
          confirmText: '去开启',
          success: (r) => {
            if (r.confirm) wx.openSetting({});
          }
        });
      } else {
        this.say({ tone: 'error', title: '录音失败，再试一次' });
      }
    });

    this._rm = rm;
  },

  clearTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  onMicStart() {
    this._cancelled = false;
    this._pendingStop = false;
    this._rm.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    });
  },

  onMicEnd() {
    if (this.data.recording) this.stopRecord();
    else this._pendingStop = true;
  },

  onMicCancel() {
    this._cancelled = true;
    if (this.data.recording) this.stopRecord();
    else this.setData({ recording: false });
  },

  stopRecord() {
    this._rm.stop();
  },

  abortRecord() {
    this._cancelled = true;
    this.clearTimer();
    try {
      this._rm.stop();
    } catch (e) {
      /* 未在录音时调用 stop 会抛错，忽略 */
    }
    this.setData({ recording: false });
  },

  async transcribe(filePath) {
    this.setData({ working: true, workingText: '正在上传录音…' });
    try {
      const up = await app.upload(filePath, { fileName: 'voice.mp3' });
      if (!up || up.code !== 0) {
        app.beacon('upload-fail', 'voice ' + ((up && up.msg) || 'no-body'));
        throw new Error((up && up.msg) || '上传失败');
      }
      app.beacon('upload-ok', 'voice ' + (up.data && up.data.url));

      this.setData({ workingText: '正在听写…' });
      const r = await api.call(
        app.request('/ai/asr', {
          method: 'POST',
          data: { fileUrl: up.data.url },
          silent: true,
          timeout: api.AI_TIMEOUT
        })
      );

      // 三种失败要分开说，不能都糊成「暂时不可用」：
      //   请求没到服务器 / 后端明确报错 / 到了但确实没听出内容
      if (!r.reached) {
        app.beacon('asr-unreached', r.msg);
        this.setData({ working: false });
        this.say({ tone: 'ask', title: '语音转写连不上服务器', detail: r.msg || '检查网络后重试' });
        return;
      }
      if (r.code !== 0) {
        app.beacon('asr-code' + r.code, r.msg);
        this.setData({ working: false });
        this.say({ tone: 'error', title: '语音转写失败', detail: r.msg || '服务端没有返回原因' });
        return;
      }
      const asrText = String((r.data && r.data.text) || '').trim();
      if (!asrText) {
        app.beacon('asr-empty', 'code0 but no text');
        this.setData({ working: false });
        this.say({ tone: 'ask', title: '没听清，再说一次', detail: '离手机近一点，或者直接打一句' });
        return;
      }
      app.beacon('asr-text', asrText);
      // 先把「听到的是什么」摆出来，再去归类。
      // 归类那一下有字可看，就不是干等一个转圈 —— 这是最省钱的感知提速。
      this.setData({
        working: true,
        workingText: '听到「' + asrText.slice(0, 14) + (asrText.length > 14 ? '…' : '') + '」'
      });
      await this.ingest(asrText, true);
    } catch (err) {
      app.beacon('asr-throw', (err && err.message) || String(err));
      this.setData({ working: false });
      this.say({ tone: 'error', title: (err && err.message) || '语音识别失败，再试一次' });
    }
  },

  /* ---------------- ② 打一句 ---------------- */

  onDraft(e) {
    this.setData({ draft: e.detail.value });
  },

  submitDraft() {
    const text = (this.data.draft || '').trim();
    if (!text) return;
    this.setData({ draft: '' });
    this.ingest(text);
  },

  /* ---------------- ③ 加号面板：四个图标直达 ---------------- */

  openPlus() {
    this.setData({ showPlus: true });
  },

  closePlus() {
    this.setData({ showPlus: false });
  },

  /**
   * 拍照：一次只能拍一张，所以拍完先进「暂存条」，用户接着拍第二张、第三张。
   * 全部拍完再点「识别这几张」，AI 逐张认、最后合并成一张待核对单据。
   */
  takePhoto() {
    this.setData({ showPlus: false });
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      sizeType: ['compressed'],
      success: (r) => this.addShots([r.tempFiles[0].tempFilePath]),
      fail: () => {}
    });
  },

  /**
   * 相册：**一次可以选多张**（最多 9 张），这就是「一次性上传多张照片」那条路。
   * 只选 1 张时直接开始识别（保持原来"拍一张就完事"的流畅路径，不额外加一次点击）。
   */
  chooseImage() {
    this.setData({ showPlus: false });
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['compressed'],
      success: (r) => {
        const paths = (r.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean);
        if (!paths.length) return;
        if (paths.length === 1) this.recognizeShots(paths);
        else this.addShots(paths);
      },
      fail: () => {}
    });
  },

  /** 从聊天里选文件：同样支持多选 */
  chooseFile() {
    this.setData({ showPlus: false });
    wx.chooseMessageFile({
      count: 9,
      type: 'file',
      success: (r) => {
        const paths = (r.tempFiles || []).map((f) => f.path).filter(Boolean);
        if (!paths.length) return;
        if (paths.length === 1) this.recognizeShots(paths);
        else this.addShots(paths);
      },
      fail: () => {}
    });
  },

  /* ---------------- 暂存条：先攒着，再一起认 ---------------- */

  addShots(paths) {
    const shots = this.data.shots.concat(paths.map((p) => ({ path: p })));
    this.setData({ shots });
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  /** 点缩略图移除（拍糊了想重拍时用） */
  removeShot(e) {
    const i = Number(e.currentTarget.dataset.i);
    const shots = this.data.shots.slice();
    shots.splice(i, 1);
    this.setData({ shots });
    wx.showToast({ title: '已移除', icon: 'none', duration: 900 });
  },

  clearShots() {
    wx.showModal({
      title: '清空这几张',
      content: '已拍的 ' + this.data.shots.length + ' 张都会丢掉，重新拍。',
      confirmText: '清空',
      success: (r) => {
        if (r.confirm) this.setData({ shots: [] });
      }
    });
  },

  /** 暂存条上的「识别这几张」 */
  startRecognize() {
    this.recognizeShots(this.data.shots.map((s) => s.path));
  },

  /** 暂存条上的「继续拍」 */
  shootMore() {
    this.takePhoto();
  },

  /**
   * 逐张识别 → 合并成一张待核对单据。
   *
   * 为什么串行而不是并发：AI 网关单张就要 2~4 秒，并发几张容易触发限流，
   * 而且老板看不到"认到第几张了"。串行还能精确知道哪一张失败。
   * **单张失败不拖垮整批**：认出来的照常汇总，失败的那几张在核对页如实标出来让老板重拍。
   */
  async recognizeShots(paths) {
    if (this.data.working) return;
    const list = (paths && paths.length) ? paths : this.data.shots.map((s) => s.path);
    if (!list.length) return;

    const docs = [];        // 拆出明细的
    const issues = [];      // 这张没进汇总 + 为什么
    const textOnly = [];    // 没拆出明细、但拿到了原文的（用来兜底）
    this.setData({ working: true });
    app.beacon('batch-start', 'count=' + list.length);

    try {
      for (let i = 0; i < list.length; i++) {
        this.setData({ workingText: list.length > 1 ? '正在认第 ' + (i + 1) + ' / ' + list.length + ' 张…' : '正在认这张单子…' });
        try {
          const small = await this.compressBeforeUpload(list[i]);
          const up = await app.upload(small, { fileName: 'receipt.jpg' });
          if (!up || up.code !== 0) throw new Error((up && up.msg) || '上传失败');
          const r = await api.parseDoc({ fileUrl: up.data.url });
          if (!r.ok) throw new Error(r.msg || '识别失败');

          if ((r.doc.items || []).length) {
            docs.push(Object.assign({}, r.doc, { fileId: up.data.id || null }));
          } else if (r.doc.text) {
            // 有原文但没明细行（比如一张只有总额的收据）——单独留着，见下面的兜底
            textOnly.push({ index: i + 1, text: r.doc.text });
            issues.push({ index: i + 1, reason: '这张没认出明细' });
          } else {
            issues.push({ index: i + 1, reason: '这张没认出内容' });
          }
        } catch (err) {
          const reason = (err && err.message) || '识别失败';
          issues.push({ index: i + 1, reason });
          app.beacon('batch-item-fail', (i + 1) + '/' + list.length + ' ' + reason);
        }
      }

      // 一张明细都没拆出来
      if (!docs.length) {
        this.setData({ working: false });
        // 但拿到了原文 → 退回自然语言记账那条路，别让老板白拍
        if (textOnly.length) {
          app.beacon('batch-fallback-text', 'n=' + textOnly.length);
          this.setData({ shots: [] });
          await this.ingest(textOnly.map((t) => t.text).join('\n'));
          return;
        }
        app.beacon('batch-all-fail', 'count=' + list.length);
        this.say({
          tone: 'ask',
          title: list.length > 1 ? '这几张都没认出来' : '这张单子没认出来',
          detail: '把单据拍正、拍清楚，光线亮一点再试'
        });
        return;
      }

      const merged = this.mergeDocs(docs, issues, list.length);
      this.setData({ working: false, shots: [] });
      app.beacon('batch-ok', docs.length + '/' + list.length + ' items=' + merged.items.length);

      wx.setStorageSync('pending_doc', merged);
      wx.navigateTo({ url: '/pages/purchase/purchase' });
    } catch (err) {
      this.setData({ working: false });
      app.beacon('batch-throw', (err && err.message) || String(err));
      this.say({ tone: 'error', title: '识别出错，再试一次' });
    }
  },

  /**
   * 把多张单据合并成**一张**待核对单据（老板说"统一汇总出来让用户确认"）。
   *
   * 合并规则，每条都有理由：
   * · 明细全部合并，每项记住来自第几张 → 核对页能按来源分组，老板对着手上的纸单一张张核
   * · 每项还要**逐行记下自己那张单子的供应商**（supplierName）→ 这是「合并成一张，但可按供应商统计」
   *   能成立的前提：合成一张之后表头只剩一个供应商名，如果行上不单独带来源，
   *   多供应商的单子一旦合并，统计就全落到「未写供应商」里，白合并了。
   * · 供应商：所有单据一致才用；不一致就留空（硬填一个会记错账）
   * · 单据号：多张时没有意义，留空
   * · 日期：一致就用，不一致用今天
   * · 合计：**按各行金额重新求和**，不用各单据自己的合计相加 —— 单据上的合计可能是税前/含税，
   *   两个口径相加会出错，行金额是我们唯一能核对的依据
   */
  mergeDocs(docs, issues, photoCount) {
    const items = [];
    const suppliers = [];
    const dates = [];

    docs.forEach((d, i) => {
      const from = i + 1;
      if (d.supplier && suppliers.indexOf(d.supplier) < 0) suppliers.push(d.supplier);
      if (d.date && dates.indexOf(d.date) < 0) dates.push(d.date);
      (d.items || []).forEach((it) => items.push(Object.assign({}, it, {
        from,
        // AI 已逐行给出供应商时用它；没给就用这张单子的表头供应商兜底
        supplierName: it.supplierName || it.supplier_name || d.supplier || '',
        sourceFileId: it.sourceFileId || it.source_file_id || d.fileId || null
      })));
    });

    let sum = 0;
    items.forEach((it) => { sum += Number(it.amount) || 0; });

    const single = docs.length === 1 && !issues.length;

    return {
      supplier: suppliers.length === 1 ? suppliers[0] : '',
      suppliers,
      supplierMixed: suppliers.length > 1,
      orderNo: single ? (docs[0].orderNo || '') : '',
      date: dates.length === 1 ? dates[0] : fmt.ymd(),
      total: Math.round(sum * 100) / 100,
      items,
      sources: docs.map((d, i) => ({
        index: i + 1,
        supplier: d.supplier || '',
        total: Number(d.total) || 0,
        count: (d.items || []).length
      })),
      issues: issues || [],
      photoCount,
      fileIds: docs.map((d) => d.fileId).filter(Boolean)
    };
  },

  /** 打字：收起面板并直接聚焦下面的输入框 */
  typeInstead() {
    this.setData({ showPlus: false, focusDraft: true });
  },

  onDraftBlur() {
    this.setData({ focusDraft: false });
  },

  /**
   * 拍照 / 传文件 → 单据核对。
   * 这里不再问用户「这是采购还是销售」——单据长什么样，AI 自己判断；
   * 拆得出明细就直接跳到核对页给老板过一眼，前端一个输入框都不出现。
   */
  /**
   * 上传前处理图片：先缩尺寸、再降画质。
   *
   * 2026-09-19 实测（服务器上用 ffmpeg 复现）：
   *   真机 544KB 照片 → 缩到 1600px：168KB（**省 69%**）
   *                   只降画质 q75：412KB（只省 24%）
   * 所以缩尺寸才是大头。上传省 2/3，真机上传那一秒多的等待直接砍掉。
   *
   * 安全边界：识别准确率对分辨率不敏感 —— 实测把标准单据缩到 800px 仍能全对拆出明细。
   * 这里保守取长边 1600px（A4 约 120dpi），远在安全线以内。
   * **必须同时给 compressedWidth 和 compressedHeight**：只给一个的话另一个默认取原图尺寸，
   * 会把图压变形。按原比例算好两个值再传。
   *
   * 任何一步失败都回退用原图 —— 不能因为一个优化把整条录入路径堵死。
   */
  compressBeforeUpload(src) {
    const MAX_EDGE = 1600;
    return new Promise((resolve) => {
      if (!wx.compressImage || !wx.getImageInfo) return resolve(src);

      const shrink = (w, h) => {
        const opt = { src, quality: 80 };
        const long = Math.max(w, h);
        if (long > MAX_EDGE) {
          const scale = MAX_EDGE / long;
          opt.compressedWidth = Math.max(1, Math.round(w * scale));
          opt.compressedHeight = Math.max(1, Math.round(h * scale));
        }
        wx.compressImage({
          ...opt,
          success: (r) => resolve((r && r.tempFilePath) || src),
          fail: () => resolve(src)
        });
      };

      wx.getImageInfo({
        src,
        success: (info) => {
          const w = Number(info.width) || 0;
          const h = Number(info.height) || 0;
          if (!w || !h) return resolve(src);
          shrink(w, h);
        },
        fail: () => resolve(src)
      });
    });
  },


  /* ---------------- 核心：一段自然语言 → 自动入账 ---------------- */

  /**
   * @param {string} text 要归类的话
   * @param {boolean} keepTip 调用方已经在提示里显示了「听到的内容」，就别用「正在归类」覆盖它
   */
  async ingest(text, keepTip) {
    this.setData({ working: true, workingText: keepTip ? this.data.workingText : 'AI 正在归类…' });
    app.beacon('ingest-start', text);
    try {
      const parsed = await api.parseText(text);

      if (!parsed.ok) {
        app.beacon('parse-unreached', parsed.msg || '');
        this.setData({ working: false });
        this.say({ tone: 'ask', title: 'AI 暂时连不上', detail: parsed.msg || '稍后再试一次' });
        return;
      }

      if (parsed.records.length === 0) {
        // 全程只在一件事上打断用户：没读出金额。而且只问这一个数，不给表单。
        app.beacon('parse-no-amount', text);
        this.setData({ working: false, askAmount: '' });
        this.say({ tone: 'ask', title: '这句话里没听出金额', detail: text, needAmount: true });
        return;
      }

      const saved = await api.saveRecords(parsed.records);
      this.setData({ working: false });

      if (saved.length === 0) {
        app.beacon('save-empty', 'records=' + parsed.records.length);
        this.say({ tone: 'error', title: '没存上，再试一次' });
        return;
      }

      app.beacon('saved', saved.length + ' 笔');
      await this.loadData();
      this.say(this.buildReceipt(saved, text));
    } catch (err) {
      app.beacon('ingest-throw', (err && err.message) || String(err));
      this.setData({ working: false });
      this.say({ tone: 'error', title: '处理失败，再试一次' });
    }
  },

  buildReceipt(saved, said) {
    const ids = saved.map((x) => x.id).filter(Boolean);

    if (saved.length === 1) {
      const r = saved[0];
      const label = fmt.isIncomeType(r.type) ? '收入' : fmt.TYPE_TEXT[r.type] || '支出';
      const detail = [label + ' ¥' + fmt.money(r.amount), r.contactName, r.content]
        .filter(Boolean)
        .join(' · ');
      return { tone: 'ok', title: '已记好', detail, said, ids, first: Object.assign({}, r, { id: ids[0] }) };
    }

    const income = saved.filter((r) => fmt.isIncomeType(r.type)).reduce((s, r) => s + r.amount, 0);
    const expense = saved.filter((r) => !fmt.isIncomeType(r.type)).reduce((s, r) => s + r.amount, 0);
    const parts = [];
    if (income) parts.push('收入 ¥' + fmt.money(income));
    if (expense) parts.push('支出 ¥' + fmt.money(expense));
    return {
      tone: 'ok',
      title: '已记好 ' + saved.length + ' 笔',
      detail: parts.join(' · '),
      said,
      ids,
      first: Object.assign({}, saved[0], { id: ids[0] })
    };
  },

  /* ---------------- 结果条 ---------------- */

  say(receipt) {
    if (this._receiptTimer) clearTimeout(this._receiptTimer);
    this.setData({ receipt });
    // 只有「已记好」会自动消失；要用户补信息的条留着不动
    if (receipt.tone === 'ok') {
      this._receiptTimer = setTimeout(() => this.setData({ receipt: null }), RECEIPT_HOLD);
    }
  },

  dismissReceipt() {
    if (this._receiptTimer) clearTimeout(this._receiptTimer);
    this.setData({ receipt: null });
  },

  onAskAmount(e) {
    this.setData({ askAmount: e.detail.value });
  },

  /** 只补一个金额，原话拼回去重新归类——用户不需要重新说一遍 */
  async submitAsk() {
    const amount = fmt.toNum(this.data.askAmount);
    if (amount <= 0) {
      wx.showToast({ title: '先填个金额', icon: 'none' });
      return;
    }
    const said = (this.data.receipt && this.data.receipt.detail) || '';
    this.setData({ receipt: null, askAmount: '' });
    await this.ingest(said + ' ' + amount + '元');
  },

  /* ---------------- 纠错面板（唯一保留的表单，且默认不出现） ---------------- */

  openFix() {
    const r = this.data.receipt && this.data.receipt.first;
    if (!r) return;
    this.setData({
      showFix: true,
      fix: {
        id: r.id || null,
        sourceText: (this.data.receipt && this.data.receipt.said) || '',
        aiType: r.type,
        amount: String(r.amount || ''),
        type: r.type || 2,
        contactName: r.contactName || '',
        content: r.content || '',
        recordDate: r.recordDate || fmt.ymd()
      }
    });
  },

  closeFix() {
    this.setData({ showFix: false });
  },

  /** 撤销刚记的这笔（多笔时全部撤掉）。这是「不弹确认直接入账」的安全网。 */
  async undoRecord() {
    const r = this.data.receipt;
    const ids = (r && r.ids) || [];
    if (!ids.length) {
      this.say({ tone: 'error', title: '这笔没拿到记录号，撤不了' });
      return;
    }
    if (this._undoing) return;
    this._undoing = true;

    wx.showLoading({ title: '撤销中…', mask: true });
    try {
      let undone = 0;
      for (const id of ids) {
        const res = await api.deleteRecord(id);
        if (res && res.code === 0) undone++;
      }
      wx.hideLoading();
      if (this._receiptTimer) clearTimeout(this._receiptTimer);
      this.setData({ receipt: null });

      if (undone === ids.length) {
        wx.showToast({ title: ids.length > 1 ? '已撤销 ' + undone + ' 笔' : '已撤销', icon: 'success' });
        this.loadData();
      } else {
        this.say({ tone: 'error', title: '只撤掉了 ' + undone + ' / ' + ids.length + ' 笔', detail: '请到列表里核对' });
        this.loadData();
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ receipt: null });
      this.say({ tone: 'error', title: '撤销失败，请重试' });
    } finally {
      this._undoing = false;
    }
  },

  pickFixType(e) {
    this.setData({ 'fix.type': Number(e.currentTarget.dataset.code) });
  },
  onFixAmount(e) {
    this.setData({ 'fix.amount': e.detail.value });
  },
  onFixContact(e) {
    this.setData({ 'fix.contactName': e.detail.value });
  },
  onFixContent(e) {
    this.setData({ 'fix.content': e.detail.value });
  },

  async saveFix() {
    const { fix } = this.data;
    if (fmt.toNum(fix.amount) <= 0) {
      wx.showToast({ title: '金额要大于 0', icon: 'none' });
      return;
    }
    if (!fix.id) {
      this.setData({ showFix: false });
      this.say({ tone: 'error', title: '这笔没拿到记录号，改不了' });
      return;
    }

    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const res = await api.updateRecord(fix.id, {
        type: fix.type,
        amount: fmt.toNum(fix.amount),
        content: fix.content,
        record_date: fix.recordDate,
        contact_name: fix.contactName,
        // 这两项是「越用越懂」的原料：老板原话 + AI 当时给的答案，
        // 后端据此学出「这个叫法 = 那个人」，下次同一个说法就不会再错
        sourceText: fix.sourceText || '',
        aiResult: { type: fix.aiType, contactName: (this.data.receipt && this.data.receipt.first && this.data.receipt.first.contactName) || '', content: (this.data.receipt && this.data.receipt.first && this.data.receipt.first.content) || '' }
      });
      wx.hideLoading();
      if (res && res.code === 0) {
        this.setData({ showFix: false });
        const learned = (res.data && res.data.learned) || [];
        if (learned.length) {
          // 让老板看见"它记住了"，这是"越用越懂"体感最强的一刻
          this.say({ tone: 'ok', title: '已改好，也记住了', detail: learned.join('、') });
          this.loadData();
        } else {
          this.setData({ receipt: null });
          wx.showToast({ title: '改好了', icon: 'success' });
          this.loadData();
        }
      } else {
        this.setData({ showFix: false });
        this.say({ tone: 'error', title: (res && res.msg) || '这笔没改成功，稍后再试' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ showFix: false });
      this.say({ tone: 'error', title: '改不了，稍后再试' });
    }
  },

  /* ---------------- 其它 ---------------- */

  // 录音浮层用 catchtouchmove 挡住背景滚动，需要一个空处理器
  noop() {},

  openDaily() {
    this.setData({ showDaily: true });
  },

  closeDaily() {
    this.setData({ showDaily: false });
  },

  shareDaily() {
    const { daily, todayLabel } = this.data;
    const text =
      '📊 易帮账本 · ' + todayLabel + ' 收支汇总\n\n' +
      '💰 收入：¥' + daily.incomeText + '\n' +
      '💸 支出：¥' + daily.expenseText + '\n' +
      '📈 结余：' + (daily.isPositive ? '+' : '-') + '¥' + daily.netText + '（' + daily.count + ' 笔）\n\n' +
      '智能记账，越记越明白';
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，粘贴发客户', icon: 'none' })
    });
  },

  goSummary() {
    wx.switchTab({ url: '/pages/summary/summary' });
  },

  goSearch() {
    wx.switchTab({ url: '/pages/search/search' });
  },

  goContact(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/contact-detail/contact-detail?id=' + id });
  },

  onShareAppMessage() {
    return { title: '易帮账本 · 说一句话就把账记了', path: '/pages/record/record' };
  }
});
