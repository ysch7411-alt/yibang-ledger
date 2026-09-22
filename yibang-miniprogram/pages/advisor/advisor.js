// pages/advisor/advisor.js
const app = getApp();
const api = require('../../utils/api');
const fmt = require('../../utils/format');
const kb = require('../../utils/keyboard');
const cfgStore = require('../../utils/config');

/** 纯文本按行拆开，前端逐段渲染。没结构的回答也至少别挤成一团 */
function splitLines(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

Page(Object.assign({
  data: {
    /* 键盘避让：输入条在页面最底部，键盘弹起时要整页上挪（见 utils/keyboard.js） */
    kbLift: 0,

    /* AI 问答（2026-09-20 从查询页整块搬来；2026-09-22 从底部弹层升为页面主体） */
    aiInput: '',
    aiHistory: [],
    aiThinking: false,
    scrollTo: '',
    /* 语音 / 图片的中间态：working 表示"正在上传、正在听写、正在看图"，
       和 aiThinking（等模型回答）是两个阶段，分开显示才看得出卡在哪一步 */
    recording: false,
    showUpload: false,
    working: false,
    workingText: '',
    /* 订阅消息（真推送）：要不要在落地页问一句、以及用哪个模板。
       模板 id 由后端配置下发（前端只是拿去调 wx.requestSubscribeMessage），
       **不在这里硬编码** —— 换模板不该要发版。 */
    pushAsk: false,
    pushTmplId: '',

    /**
     * 空状态里展示的「四件事」。
     * 名字两字一组：老板记不住"五种查询能力的区别"，但 查账/报账/记账/比账 能背下来 ——
     * 背下来之后"问什么、不问什么"他心里就有数了。
     * ⚠️ 和 lib/skills 里的能力清单必须对得上：改一边就要改另一边，
     *    否则空状态承诺的东西后端答不了（比不承诺更糟）。
     */
    skills: [
      { k: '查账', d: '本月赚了多少、谁欠我最多' },
      { k: '报账', d: '今天有没有要注意的' },
      { k: '记账', d: '说一句就帮你记进去' },
      { k: '比账', d: '我的成本跟同行比高不高' }
    ],

    /**
     * 快捷问题**必须跟着页面走**。
     * 这一页原来有「概览 hero + 欠得最多的客户卡」，于是「这个月赚了多少钱」「谁欠我最多」
     * 在页面上已经有答案了 —— 摆进快捷问题等于让用户把刚看过的数字再问一遍。
     * 现在按**四件事**各配一个（报账 / 查账 / 比账；记账不是问句，靠上面的清单承载），
     * 这样用户点任意一个都能碰到一件真实能力。
     * ⚠️ 线上以后台配置 layout.quickQuestions 为准，这里是拉不到配置时的兜底。
     */
    quickAsks: ['今天有什么要注意的？', '谁欠我最多？', '我的支出占比算高吗？']
  },

  /* 2026-09-22 删掉了 onLoad(ask=1) 的自动开弹层逻辑：
     本页现在整页就是对话，不再需要"进来就帮他把弹层打开"。
     summary.goAdvisor 那边也同步去掉了 ?ask=1 参数。 */

  onShow() {
    this.syncQuickAsks();
    // 本页 2026-09-22 提成了独立 tab（tabBar 第 3 项：0=记账 1=报表 2=参谋 3=我的）
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 2 });
    this.loadPushState();
  },

  /* ═══════════ 订阅消息（真推送）═══════════
     微信允许的"每天早上推一条"只有一条路：**一次性订阅**。
     用户授权一次 → 后端能发一条。所以要做的不是"授权一次永久推送"，
     而是**每次他愿意点，就攒一次额度**。
     攒够（≥3 次）就不再问 —— 一次性订阅本来就该省着用，
     天天弹窗要授权会把人烦走，那比推不出去更糟。 */
  async loadPushState() {
    const r = await api.call(app.request('/notifications/subscribe', { silent: true }));
    if (!r || r.code !== 0 || !r.data || !r.data.configured) {
      // 没配模板就当这功能没开（后端也会这么返回），**不弹任何东西**
      if (this.data.pushAsk) this.setData({ pushAsk: false });
      return;
    }
    this.setData({
      pushTmplId: r.data.tmplId,
      pushAsk: Number(r.data.remain || 0) < 3
    });
  },

  /** 用户点「好」→ 拉起微信的订阅授权弹窗。**必须由点击触发**，微信的硬要求 */
  askPush() {
    const tmplId = this.data.pushTmplId;
    if (!tmplId) return;
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => {
        if (res[tmplId] !== 'accept') {
          // 用户点了拒绝：这次不问了，下次打开再说（不追问、不解释，尊重他的选择）
          this.setData({ pushAsk: false });
          return;
        }
        // 授权成功才去后端记额度 —— 这一步失败也不打扰用户，
        // 只是这次额度没攒上，下次打开会再问一遍
        api.call(app.request('/notifications/subscribe', { method: 'POST', silent: true }))
          .then((r) => {
            this.setData({ pushAsk: false });
            wx.showToast({ title: (r && r.code === 0) ? '好了，有事我叫你' : '稍后再试', icon: 'none' });
          });
      },
      /* ⚠️ fail 必写：这个接口在部分基础库/场景下会失败，
         不写的话用户点了毫无反应（这个项目已经栽过好几次"失败静默"）。 */
      fail: () => {
        wx.showToast({ title: '没能打开订阅，稍后再试', icon: 'none' });
      }
    });
  },

  /** 快捷问题跟随远程配置；后台改了下一次 onShow 就换（不等发版） */
  syncQuickAsks() {
    // 与 page-config 同一机制：经 30s 节流重拉，不是只在首次加载时拉一次
    cfgStore.load().then(() => {
      const cur = cfgStore.current();
      if (!cur.loaded) return;
      const q = (cur.config && cur.config.layout && cur.config.layout.quickQuestions) || [];
      if (Array.isArray(q) && q.length && q.join('|') !== this.data.quickAsks.join('|')) {
        this.setData({ quickAsks: q.slice(0, 3) });
      }
    }).catch(() => {});
  },

  /* 2026-09-22 这一块（loadData / buildVerdict / buildTips / goSummary / goDetail）整段删除。
     它们只服务于「概览 hero + 经营提示 + 欠得最多的客户」——那三块按老板要求拿掉了：
     本页还原成一个**纯粹的对话窗口**，点进来就能问，不再先给一份概览。
     连带的好处：打开这一页不再拉"本月汇总 + 往来列表"两个接口，进页面更快。

     ⚠️ 删掉的是**展示**，不是能力。「优先催收 / 本月超支 / 支出占比」这套本地规则
     （原来在 buildTips 里）现在没有任何入口调用了 —— 如果以后要把它接回来，
     `_snapshots/` 里有改动前的源码快照，`_verify/snapshot.sh --list` 可以查。
     当时就该这么处理：留着不调用的函数等于埋一个"有人接回去却不知道它已过时"的坑。 */

  /* ---------------- AI 问答 ---------------- */

  /**
   * 按住输入条说话（2026-09-20 重构：话筒从独立按钮挪进输入框）。
   *
   * ⚠️ 同一个区域要兼容两种操作，靠"按住时长"区分：
   *   · 单击（<250ms 松开）→ 聚焦输入框，让老板打字
   *   · 按住（≥250ms）→ 开始录音，松手结束并直接问
   * 250ms 是按"人手最快的一次明确点击"定的，再短就会把想打字的人误判成要说话。
   * `_longPress` 这个标记还要在 tap 里用一次 —— 微信会先派发 touchend、再派发 tap，
   * 不挡一下就会"按住说完话之后又聚焦一次输入框"。
   */
  onFieldStart() {
    if (this.data.working || this.data.aiThinking) return;
    this._longPress = false;
    if (this._pressTimer) clearTimeout(this._pressTimer);
    this._pressTimer = setTimeout(() => {
      this._longPress = true;
      this._startRecord();
    }, 250);
  },

  onFieldEnd() {
    if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
    // 按住过 → 录音结束；没按住过 → 交给 tap 去聚焦输入框
    if (this._longPress) this._stopRecord();
  },

  onFieldCancel() {
    if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
    if (this._longPress) this._abortRecord();
  },

  onFieldTap() {
    if (this._longPress) return;      // 刚才是按住说话，别再聚焦输入框
    if (this.data.recording) return;
    if (!this._inputFocused) {
      this._inputFocused = true;
      // 聚焦由按钮触发不可靠（部分基础库上点击容器不会把焦点给 input），
      // 这里直接操作组件实例
      const q = this.createSelectorQuery && this.createSelectorQuery();
      if (q) {
        q.select('.chat-input').context((res) => { if (res && res.context) res.context.focus(); }).exec();
        return;
      }
    }
    this._inputFocused = false;
  },

  _startRecord() {
    /* 🔴 每次录音前都重新注册监听（2026-09-22 修，和记账页同一个根因）：
       `wx.getRecorderManager()` 是**全局单例**，`onStop`/`onError` **后注册的会覆盖先注册的**。
       只在第一次 `_initRecorder()` 的话，另一页后进来就会把本站的监听顶掉 ——
       表现是"松手了界面还在'正在听'"，而实际处理录音的变成了另一页。 */
    this._initRecorder();
    this._cancelled = false;
    this._pendingStop = false;
    try {
      this._rm.start({
        duration: 60000,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'mp3'
      });
      this.setData({ recording: true });
      // 一点点触觉反馈：老板眼睛可能盯着货，靠震一下知道"开始听了"
      wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    } catch (e) {
      this.setData({ recording: false });
    }
  },

  _stopRecord() {
    try { if (this._rm) this._rm.stop(); } catch (e) { /* 没在录音时 stop 会抛 */ }
  },

  /** 手指划出区域取消：不识别、也不发出去 */
  _abortRecord() {
    this._cancelled = true;
    this._stopRecord();
    this.setData({ recording: false });
    wx.showToast({ title: '已取消', icon: 'none', duration: 900 });
  },

  _initRecorder() {
    const rm = wx.getRecorderManager();
    rm.onStop(async (res) => {
      const cancelled = this._cancelled;
      this._cancelled = false;
      this.setData({ recording: false });
      // 静默 return 要留痕（和记账页一致）：否则"按了没反应"永远查不出卡在哪
      if (cancelled) { app.beacon('adv-rec-abort', ''); return; }
      if (!res || !res.tempFilePath) {
        app.beacon('adv-rec-nofile', JSON.stringify(res || null).slice(0, 80));
        return;
      }
      await this.askByVoice(res.tempFilePath);
    });
    rm.onError((err) => {
      this.setData({ recording: false });
      if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
      const msg = (err && err.errMsg) || '';
      if (/auth|deny|permission/i.test(msg)) {
        wx.showModal({
          title: '需要麦克风权限',
          content: '开启后才能用语音提问：点「去开启」→ 打开麦克风开关',
          confirmText: '去开启',
          success: (r) => { if (r.confirm) wx.openSetting({}); }
        });
      }
    });
    rm.onStart(() => this.setData({ recording: true }));
    this._rm = rm;
  },

  /** 录音 → 上传 → 听写 → 直接问 */
  async askByVoice(filePath) {
    this.setData({ working: true, workingText: '正在上传录音…' });
    app.beacon('ai-voice-start', '');
    try {
      const up = await app.upload(filePath, { fileName: 'voice.mp3' });
      if (!up || up.code !== 0) throw new Error((up && up.msg) || '上传失败');

      this.setData({ workingText: '正在听写…' });
      // 兜底超时：和记账页同一条原因，wx.request 的 timeout 不是每次都生效
      const r = await api.withTimeout(
        api.transcribe(up.data && up.data.url),
        api.AI_TIMEOUT + 15000,
        '听写等太久了，再说一次'
      );
      if (!r.reached) throw new Error(r.msg || '网络不可用');
      if (r.code !== 0) throw new Error(r.msg || ('接口返回 ' + r.code));

      const text = String((r.data && r.data.text) || '').trim();
      if (!text) {
        this.setData({ working: false, workingText: '' });
        wx.showToast({ title: '没听出内容，再说一次', icon: 'none' });
        return;
      }

      app.beacon('ai-voice-ok', text.slice(0, 40));
      // 听写结果直接作为问题发出去；输入框里也留一份，方便用户看到 AI 听到的是什么
      this.setData({ aiInput: text, working: false, workingText: '' });
      await this.sendAi();
    } catch (err) {
      app.beacon('ai-voice-fail', (err && err.message) || String(err));
      this.setData({ working: false, workingText: '' });
      wx.showToast({ title: (err && err.message) || '语音没成功', icon: 'none' });
    }
  },

  /* ---------------- 「+」上传面板 ---------------- */

  openPlus() {
    if (this.data.working || this.data.aiThinking) return;
    this.setData({ showUpload: true });
  },

  closePlus() {
    this.setData({ showUpload: false });
  },

  /** 拍照 */
  pickCamera() {
    this.setData({ showUpload: false });
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['camera'],
      success: (res) => { const p = res.tempFilePaths && res.tempFilePaths[0]; if (p) this.askByImage(p); },
      fail: (err) => this.sayNoPermission('相机', err)
    });
  },

  /** 从相册选 */
  pickAlbum() {
    this.setData({ showUpload: false });
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album'],
      success: (res) => { const p = res.tempFilePaths && res.tempFilePaths[0]; if (p) this.askByImage(p); },
      fail: (err) => this.sayNoPermission('相册', err)
    });
  },

  /**
   * 选微信里的文件。可能选到图片（那走读图），
   * 也可能选到 PDF/Word —— 那种先告诉用户目前只看图，别说"上传失败"骗人。
   */
  pickFile() {
    this.setData({ showUpload: false });
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        if (/\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name || '')) { this.askByImage(f.path); return; }
        wx.showModal({
          title: '这个文件我看不了',
          content: '目前只认图片（小票、送货单、截图都行）。\n\n你可以：长按这个文件 →「保存到相册」，再用上面的「相册」选它。',
          showCancel: false,
          confirmText: '知道了'
        });
      },
      fail: (err) => this.sayNoPermission('文件', err)
    });
  },

  /**
   * 权限/取图失败的提示。
   * 取消（fail return）不算失败 —— 用户就是不想选，别弹窗烦他。
   */
  sayNoPermission(what, err) {
    const raw = (err && err.errMsg) || '';
    if (/cancel/i.test(raw)) return;                  // 用户主动取消
    app.beacon('ai-upload-noperm', what + ' ' + raw.slice(0, 60));
    wx.showModal({
      title: '拿不到' + what,
      content: '需要在微信里给「易帮账本」开' + what + '权限：\n点「去开启」→ 打开对应的开关',
      confirmText: '去开启',
      success: (r) => { if (r.confirm) wx.openSetting({}); }
    });
  },

  async askByImage(filePath) {
    this.setData({ working: true, workingText: '正在上传图片…' });
    app.beacon('ai-image-start', '');
    try {
      const up = await app.upload(filePath, { fileName: 'photo.jpg' });
      if (!up || up.code !== 0) throw new Error((up && up.msg) || '上传失败');

      this.setData({ workingText: '正在看图…' });
      const r = await api.readImage(up.data && up.data.url);
      if (!r.reached) throw new Error(r.msg || '网络不可用');
      if (r.code !== 0) throw new Error(r.msg || ('接口返回 ' + r.code));

      const text = String((r.data && r.data.text) || '').trim();
      if (!text || text === '看不清') {
        this.setData({ working: false, workingText: '' });
        wx.showToast({ title: '这张图看不清，换一张试试', icon: 'none' });
        return;
      }

      app.beacon('ai-image-ok', text.slice(0, 40));
      // 把读到的内容当成"我刚拍的东西"交给 AI，让它结合账目回答。
      // 不要求用户再打字 —— 他拍这张图就是想让 AI 看。
      this.setData({ working: false, workingText: '' });
      await this.askImage(
        '我刚拍了一张图，上面写的是：\n' + text + '\n请用两三句话告诉我这是什么、涉及多少钱、哪一天的；' +
        '如果能和我账上的记录对上，也一并说。',
        filePath
      );
    } catch (err) {
      app.beacon('ai-image-fail', (err && err.message) || String(err));
      this.setData({ working: false, workingText: '' });
      wx.showToast({ title: (err && err.message) || '图片没识别成功', icon: 'none' });
    }
  },

  /* 2026-09-22 删掉 openAi() / closeAi()（原来是开关底部对话弹层用的）。
     对话升为页面主体后没有"开/关"这回事了 —— 退出就是导航栏返回。 */

  /**
   * 撤销刚记的那一笔（2026-09-22）。
   *
   * 「对话即入账」是**写操作**，而写操作必须有回头路 —— 自动入账尤其如此：
   * 识别错一个字（"还了"听成"还欠"）就会把老板的账本弄脏，而他未必当场发现。
   *
   * 两点刻意的做法：
   *  ① 用 api.call 而不是 api.safe：safe 在成功但无 data 时会返回 undefined，
   *     我没法区分"撤销成功"和"没成功"；call 会明确给出 code。
   *  ② 撤销成功后**不删掉这条消息**，只标记成「已撤销」——
   *     直接让消息消失，老板反而会怀疑"到底撤了没有"。
   */
  async undoRecord(e) {
    const i = e.currentTarget.dataset.i;
    const item = this.data.aiHistory[i];
    const ids = (item && item.card && item.card.undo) || [];
    if (!ids.length) return;

    wx.showLoading({ title: '撤销中…', mask: true });
    let ok = 0;
    for (const id of ids) {
      const r = await api.call(app.request('/record/delete', { method: 'POST', data: { id }, silent: true }));
      if (r && r.code === 0) ok++;
    }
    wx.hideLoading();

    if (ok === ids.length) {
      // 全部撤掉了才标记已撤销；部分失败要留着按钮让老板再点一次
      this.setData({ ['aiHistory[' + i + '].undone']: true });
      wx.showToast({ title: '已撤销', icon: 'none' });
    } else {
      wx.showToast({ title: '没撤销成功，再试一次', icon: 'none' });
    }
  },

  /**
   * 返回主界面（清掉当前这轮对话）。
   *
   * 为什么必须有：本页是 **tab 页**，而 tab 页的导航栏**不会有返回箭头**
   * （微信框架规则：tab 页是顶层页面）。用户聊完想回到"四件事"那个起始界面时，
   * 会发现没有任何路可走 —— 这不是体验瑕疵，是**真的走不回去**。
   *
   * 清掉的是页面内存里的对话，**不动账本**：
   * 已经入的账留在库里（要撤得用那张卡片上的「记错了，撤销」）。
   * 这两件事必须分清楚 —— 否则用户会以为"返回"把账也退了。
   */
  newChat() {
    this.setData({ aiHistory: [], aiInput: '', aiThinking: false, scrollTo: '' });
  },

  onAiInput(e) {
    this.setData({ aiInput: e.detail.value });
  },

  askQuick(e) {
    this.setData({ aiInput: e.currentTarget.dataset.q });
    this.sendAi();
  },

  scrollToBottom() {
    this.setData({ scrollTo: 'chatBottom' });
  },

  /**
   * 直接问一个问题（不经过输入框）—— 语音听写完、图片读完后用它。
   * 之所以不直接调 sendAi：sendAi 读的是 this.data.aiInput，
   * 而 setData 是异步的，立刻读有可能拿到旧值。
   */
  async ask(q) {
    if (!q || this.data.aiThinking || this.data.working) return;
    this.setData({ aiInput: q });
    await this.sendAi();
  },

  /** 带图片的提问：把刚拍的那张也存进对话记录，气泡里显示缩略图，看着知道 AI 看的是哪张 */
  async askImage(q, imagePath) {
    if (!q || this.data.aiThinking || this.data.working) return;
    this.setData({ aiInput: q });

    // 显示给用户的话要短。OCR 读出来的原文可能有几百字，
    // 全塞进自己的气泡里就是"乱七八糟"——那是给 AI 的上下文，不是给人看的。
    const shown = '我拍了一张图，帮我看看';
    /* ⚠️ 用户消息必须带 lines（2026-09-22 修，用户报"只能看到 AI 的回复、看不到自己的问题"）。
       模板渲染消息体时走的是 `wx:if="{{item.card}}" ... wx:else → item.lines` 这条链，
       **`content` 从头到尾没有任何地方在读**。用户消息原来只推了 { role, content }，
       于是 lines 是 undefined、循环渲染出 0 行 —— 气泡是个**空的橙色小条**，
       看着就像自己的话没发出去。AI 那边因为带了 lines 所以正常，症状才这么不对称。 */
    const history = this.data.aiHistory.concat([{ role: 'user', content: shown, image: imagePath || '', lines: [shown] }]);
    this.setData({ aiHistory: history, aiInput: '', aiThinking: true }, () => this.scrollToBottom());

    try {
      const prior = this.data.aiHistory.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      // 同上：拍照问这一路也必须给足 60 秒，否则真机上同样会 15 秒超时
      const res = await app.request('/ai/chat', {
        method: 'POST',
        data: { question: q, history: prior },
        silent: true,
        timeout: api.AI_TIMEOUT
      });
      if (res && res.code === 0 && res.data && res.data.answer) {
        this.setData({
          aiHistory: history.concat([{
            role: 'ai', content: res.data.answer,
            card: res.data.card || null, lines: splitLines(res.data.answer)
          }]),
          aiThinking: false
        });
      } else {
        /* 兜底文案必须跟着页面走（2026-09-22）。
           ⚠️ 这里原来写着「本页的『经营提示』是照账目直接算的，可以先看那个」——
           而经营提示板块在同一次改造里已经从本页删掉了，这句话等于让用户去找一个不存在的东西。
           **删页面元素时，要连着搜一遍"提到这个元素的文案"**，否则残留的指引比没有更糟。 */
        const sorry = '这张图我没看明白。\n换个清楚点的照片，或者直接打字问我，比如「这个月花了多少」。';
        this.setData({
          aiHistory: history.concat([{
            role: 'ai',
            content: sorry,
            lines: ['这张图我没看明白。', '换个清楚点的照片，或者直接打字问我，比如「这个月花了多少」。']
          }]),
          aiThinking: false
        });
      }
    } catch (err) {
      this.setData({
        aiHistory: history.concat([{ role: 'ai', content: '网络不太顺畅，稍后再问我一次。', lines: ['网络不太顺畅，稍后再问我一次。'] }]),
        aiThinking: false
      });
    }
    this.scrollToBottom();
  },

  async sendAi() {
    const q = (this.data.aiInput || '').trim();
    if (!q || this.data.aiThinking || this.data.working) return;

    const history = this.data.aiHistory.concat([{ role: 'user', content: q, lines: splitLines(q) }]);
    this.setData({ aiHistory: history, aiInput: '', aiThinking: true }, () => this.scrollToBottom());

    try {
      // 把最近的对话带上去，AI 才知道"那上月呢"里的"那"指的是什么。
      // 这里不截断也行，后端只取最后 3 轮 —— 多传几条不花钱，少传就真的丢了。
      const prior = this.data.aiHistory.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      /* ⚠️ 必须显式传 AI_TIMEOUT（2026-09-22 修）—— 这是典型的"真机不通、模拟器却通"。
         app.request 默认只等 **15 秒**，而 app.js 的注释里早就写着"AI 类接口必须显式传更长"
         （2026-09-19 真机就因此报过 `request:fail timeout`）。
         全站其它 AI 调用（/record/ai-parse、/ai/vision、/ai/asr、/purchase/parse-doc）
         都传了 60 秒，**只有两处 /ai/chat 漏了**。
         后端调 qwen-plus 允许 45 秒，前端却只等 15 秒 —— 模型一慢，后端还在算，
         前端已经放弃，用户看到的就是"没反应 / 答不了"。
         模拟器网络是本机、几乎无抖动所以看不出，手机上就露馅。 */
      const res = await app.request('/ai/chat', {
        method: 'POST',
        data: { question: q, history: prior },
        silent: true,
        timeout: api.AI_TIMEOUT
      });
      if (res && res.code === 0 && res.data && res.data.answer) {
        this.setData({
          aiHistory: history.concat([{
            role: 'ai',
            content: res.data.answer,
            // 模型给了结构就渲染成卡片，没给就按段落排纯文本 —— 两条路都要能看
            card: res.data.card || null,
            lines: splitLines(res.data.answer)
          }]),
          aiThinking: false
        });
      } else {
        // 兜底文案同样要跟着页面走：经营提示板块已从本页删除，不能再让用户去看它
        const sorry = '这类问题我暂时答不了。\n换个问法试试，比如「这个月花了多少」「谁欠我最多」；想看某一笔具体的账，去「查询」页翻。';
        this.setData({
          aiHistory: history.concat([{ role: 'ai', content: sorry, lines: sorry.split('\n') }]),
          aiThinking: false
        });
      }
    } catch (err) {
      this.setData({
        aiHistory: history.concat([{ role: 'ai', content: '网络不太顺畅，稍后再问我一次。' }]),
        aiThinking: false
      });
    }
    this.scrollToBottom();
  }
}, kb.methods));   // 键盘避让：onKbFocus / onKbBlur / onKbHeight / setKb
