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
    loading: true,
    stat: { incomeText: '0.00', expenseText: '0.00', netText: '0.00', isPositive: true },
    verdict: '',
    topCustomers: [],
    tips: [],

    /* 键盘避让：AI 弹层的输入条也在底部，同样会被键盘切（见 utils/keyboard.js） */
    kbLift: 0,

    /* AI 问答（2026-09-20 从查询页整块搬来） */
    showAi: false,
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
    /**
     * 快捷问题**必须跟着页面走**。
     * 查询页原来那三个里，「这个月赚了多少钱」「谁欠我最多」在本页的 hero 和
     * 「欠得最多的客户」卡里已经有答案了 —— 摆在这儿等于让用户把刚看过的数字再问一遍，
     * 还占了三个最显眼的位置。换成 hero 答不了的那两类：支出结构、环比。
     */
    quickAsks: ['这个月哪项支出最大？', '上个月比这个月怎么样？', '这个月花得最多的是哪几天？']
  },

  onShow() {
    this.syncQuickAsks();
    this.loadData();
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 3 });
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

  async loadData() {
    // 有数据就不闪骨架屏（切 tab 回来的数据其实没变，闪一下只是晃眼）——详见 summary.js 同处注释
    if (!this._loaded) this.setData({ loading: true });

    const [month, contacts] = await Promise.all([
      api.getMonthSummary(fmt.ym()),
      api.getContactList(1)
    ]);

    const net = month.income - month.expense;
    const isPositive = net >= 0;

    const debtors = contacts
      .filter((c) => c._balance > 0)
      .sort((a, b) => b._balance - a._balance)
      .slice(0, 5);

    const totalDebt = debtors.reduce((s, c) => s + c._balance, 0) || 1;
    const maxDebt = debtors.length ? debtors[0]._balance : 1;

    const topCustomers = debtors.map((c) => ({
      id: c.id,
      name: c.name,
      amountText: fmt.money(c._balance),
      percent: Math.max(6, Math.round((c._balance / maxDebt) * 100)),
      share: Math.round((c._balance / totalDebt) * 100)
    }));

    this.setData({
      stat: {
        incomeText: fmt.money(month.income),
        expenseText: fmt.money(month.expense),
        netText: fmt.money(Math.abs(net)),
        isPositive
      },
      verdict: this.buildVerdict(net, month, topCustomers),
      // topCustomers 仍然算、仍然存 —— buildTips 的第一条「优先催收」要用它。
      // 2026-09-20 按老板要求把「欠得最多的客户」那张卡删了（和报表页重复），
      // 但**数据链路没删**：经营提示里还在用。别顺手把这里也清掉。
      topCustomers,
      tips: this.buildTips(net, month, topCustomers)
    });

    this.setData({ loading: false });
    this._loaded = true;   // 之后切回来就不再闪骨架屏
  },

  buildVerdict(net, month, top) {
    if (month.income === 0 && month.expense === 0) return '本月还没有记账，先记两笔我就能分析了';
    if (net > 0) return `本月进账比出账多 ¥${fmt.money(net)}，经营是正的`;
    if (net < 0) return `本月出账比进账多 ¥${fmt.money(-net)}，留意一下大额支出`;
    return '本月收支刚好持平';
  },

  /**
   * 经营提示 —— 完全由本地规则生成（不发大模型请求）。
   * 原来标题写成「💡 AI 经营建议」属于过度承诺，这里如实标注为「经营提示」。
   */
  buildTips(net, month, top) {
    const tips = [];

    if (top.length > 0) {
      tips.push({
        title: `优先催收：${top[0].name}`,
        desc: `欠款 ¥${top[0].amountText}，占应收总额的 ${top[0].share}%。先跟这一家沟通，回款效率最高。`
      });
    }

    if (month.income > 0 || month.expense > 0) {
      tips.push(
        net >= 0
          ? { title: '本月盈利', desc: `收入 ¥${fmt.money(month.income)} 覆盖了支出 ¥${fmt.money(month.expense)}，可以按现在的路子继续做。` }
          : { title: '本月超支', desc: `支出 ¥${fmt.money(month.expense)} 高于收入 ¥${fmt.money(month.income)}，建议先翻一遍大额支出项。` }
      );
    }

    if (month.income > 0) {
      const rate = Math.round((month.expense / month.income) * 100);
      tips.push({
        title: `支出占收入 ${rate}%`,
        desc: rate > 80 ? '这个比例偏高，利润空间被压得很薄。' : '这个比例还算健康，留出了利润空间。'
      });
    }

    if (tips.length === 0) {
      tips.push({
        title: '先攒数据',
        desc: '坚持记 1 个月，就能看到收支结构、客户欠款和利润趋势了。'
      });
    }

    return tips.slice(0, 4);
  },

  goSummary() {
    wx.switchTab({ url: '/pages/summary/summary' });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/contact-detail/contact-detail?id=' + id });
  },

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
    if (!this._rm) this._initRecorder();
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
      if (cancelled || !res || !res.tempFilePath) return;
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

  openAi() {
    this.setData({ showAi: true, scrollTo: '' });
  },

  closeAi() {
    this.setData({ showAi: false, aiThinking: false });
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
    const history = this.data.aiHistory.concat([{ role: 'user', content: shown, image: imagePath || '' }]);
    this.setData({ aiHistory: history, aiInput: '', aiThinking: true }, () => this.scrollToBottom());

    try {
      const prior = this.data.aiHistory.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      const res = await app.request('/ai/chat', { method: 'POST', data: { question: q, history: prior }, silent: true });
      if (res && res.code === 0 && res.data && res.data.answer) {
        this.setData({
          aiHistory: history.concat([{
            role: 'ai', content: res.data.answer,
            card: res.data.card || null, lines: splitLines(res.data.answer)
          }]),
          aiThinking: false
        });
      } else {
        this.setData({
          aiHistory: history.concat([{
            role: 'ai',
            content: '这类问题我暂时答不了。\n本页的「经营提示」是照账目直接算的，可以先看那个；想看某一笔具体的账，去「查询」页翻。',
            lines: ['这类问题我暂时答不了。', '本页的「经营提示」是照账目直接算的，可以先看那个；想看某一笔具体的账，去「查询」页翻。']
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

    const history = this.data.aiHistory.concat([{ role: 'user', content: q }]);
    this.setData({ aiHistory: history, aiInput: '', aiThinking: true }, () => this.scrollToBottom());

    try {
      // 把最近的对话带上去，AI 才知道"那上月呢"里的"那"指的是什么。
      // 这里不截断也行，后端只取最后 3 轮 —— 多传几条不花钱，少传就真的丢了。
      const prior = this.data.aiHistory.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      const res = await app.request('/ai/chat', { method: 'POST', data: { question: q, history: prior }, silent: true });
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
        // 接口没通时**说清楚它能答什么**，别让用户对着一个对话框反复试。
        // 兜底文案要跟着页面走：这里已经是参谋页，不能再写「去上面的搜索查」。
        this.setData({
          aiHistory: history.concat([{
            role: 'ai',
            content: '这类问题我暂时答不了。\n本页的「经营提示」是照账目直接算的，可以先看那个；想看某一笔具体的账，去「查询」页翻。'
          }]),
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
