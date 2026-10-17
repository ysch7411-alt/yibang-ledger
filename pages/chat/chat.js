/**
 * pages/chat/chat.js —— 问账房（方案 D · 对话驱动）
 *
 * 2026-10-15。v2 stageD。
 *
 * 核心改变：整个 app 就是这一屏。
 * 老板说「分享给老婆」「记住张姐」「上次那笔是多少」 → AI 直接执行。
 * 富交互卡片上的 4 个 mini 按钮 = 自然语言指令的等价载体。
 *
 * 关键设计：
 *   ① 单屏：没有 tabBar，所有事都在 chat 流里发生
 *   ② 长上下文：每次 send 把最近 N 条消息打包给后端，AI 能跨轮理解
 *   ③ 富交互卡片：每条 AI 回复都可能带 card（带 actions）+ suggest（AI 主动建议）
 *   ④ 一句话完成 2 件事：记账 + AI 主动建议记忆（老板只点一个按钮）
 *   ⑤ 顶栏菜单：AI记住了什么 / 今日详情 / 修改名称 / 播报开关 / 成员管理 /
 *      套餐升级 / 联系客服 / 重新开始 / 退出账号（不是 tab）
 *
 * ⚠️ 2026-10-17 更正：这里原来写的是「记忆 / 报表 / 设置 / 团队 / 音色」——
 *    ① 和 ② 都是错的：
 *      · 菜单里从来没有「音色」入口（`tts.VOICES` 那 13 个音色有数据没 UI，
 *        `tts.speak()` 的 voice 参数全仓库没人传 —— 见文件尾部 TTS 那段说明）
 *      · 「报表」其实是 report-view（分享页），不是菜单项；菜单里是「套餐升级」
 *    「今日详情」曾于 2026-10-17 补过入口，同日又删（老易拍板对话驱动，不做点击查看）。
 *
 * 🔴 数字铁律依旧不破：所有数字 SQL 算，LLM 只能说人话。
 */
const api = require('../../utils/api');
const pipe = require('../../utils/voice-pipeline');
const recorder = require('../../utils/recorder');
const tts = require('../../utils/tts');
const poster = require('../../utils/poster');
const entityInfo = require('../../utils/entity-name');
const tone = require('../../utils/tone');
const intake = require('../../utils/upload-intake');
const receipt = require('../../utils/receipt-flow');
const noiseGate = require('../../utils/noise-gate');
const _intakeMod = require('../../utils/chat-intake');
const _editMod = require('../../utils/chat-edit');
const _realtimeMod = require('../../utils/chat-realtime');

Page({
  data: {
    /* ── 会话状态 ── */
    msgs: [],                  // 对话历史
    input: '',                 // 输入框文字
    sending: false,            // 等待 AI 回复中
    sessionId: '',             // 会话 ID（后端维护跨轮上下文）

    /* ── 顶部状态 ── */
    todayStat: { net: 0, income: 0, expense: 0 },  // 今日数字
    todayCount: 0,             // 今日笔数
    todayNetText: '¥0.00',     // 顶部大号那行（带正负号，见 _fmtNet）
    entityName: '',            // 名称（店/公司/团队/项目…都算）。空 = 还没设置 → 进首次引导
    entityIndustry: '',        // 领域（水果 / 餐饮 / 建筑工程…）

    /* ── 首次引导 ── */
    needEntityName: false,     // true = 正在问名称，下一句优先当名称解析

    /* ── 语音 ── */
    recording: false,         // 录音中
    liveText: '',             // 流式字幕
    recSecs: 0,               // 录音已多少秒（显示在字幕条）
    recFallback: false,       // wss 不可用 → 降级提示
    audioPlaying: false,      // TTS 播放中
    ttsOn: wx.getStorageSync('ttsOn') !== false,

    /* ── 菜单 ── */
    menuOpen: false,          // 顶栏菜单弹层

    /* ── 上传（拍照 / 相册 / 文件）── */
    upOpen: false,            // ＋ 面板是否展开

    /* ── 实时对讲 ── */
    rtOpen: false,            // 对讲面板
    rtConnected: false,       // 通道是否连上
    rtState: 'idle',          // idle | listening | speaking
    rtStatus: '未连接',
    rtLines: [],              // 对讲消息流
    rtScrollTo: '',           // 滚动锚点
    /* 🔴 2026-10-17 16:09 OCR 原文展开：点了显示 OCR 抽的 rawText，老易能对账 */
    showRawText: false,       // 展开/收起开关
    rawTextCache: '',         // 当前 OCR 原文缓存（提示用）
    /* 🔴 2026-10-17 OCR 确认卡 · 单行人工修改弹窗状态 */
    editRowOpen: false,
    editRowMid: '',
    editRowIdx: -1,
    editRow: { t: 'out', amt: '', txt: '', who: '' },

    /* ── 滚动 ── */
    scrollTo: 'tail'          // 强制滚到底部
  },

  onLoad(options) {
    /* 🔴 sessionId 必须在跨页打开 / 重新打开时**保持不变**，
     *   否则后端 session.js 永远收到新的 key，30 分钟的"长上下文"是空话。
     *   之前每个 onLoad 都 Date.now() 一个新的 → 跨页即丢，老板感知不到。
     *   现在存 storage（失效 30 天后重置）。 */
    let sid = '';
    try { sid = wx.getStorageSync('chatSessionId') || ''; } catch (e) {}
    if (!sid) {
      sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      try { wx.setStorageSync('chatSessionId', sid); } catch (e) {}
    }
    this._sessionId = sid;
    this.setData({ sessionId: sid });
    this._initBootstrap();
    this._startIdleWatch();          // 闲置主动关怀（产品版，不是自动播演示）
    if (options && options.q) {
      // 从其它页面跳转过来（如 memory / today 直接问）
      this.setData({ input: decodeURIComponent(options.q) });
      setTimeout(() => this._send(), 400);
    }
  },

  /** 一键清屏时调用：清空对话 + 重启问候 + 重新生成 sessionId。 */
  _newSessionId() {
    let sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    try { wx.setStorageSync('chatSessionId', sid); } catch (e) {}
    this._sessionId = sid;
    this.setData({ sessionId: sid });
  },

  onShow() {
    // 每次进入都刷新顶部今日数字（可能别处记了账）
    this._loadTodayStat();
    this._bumpIdle();
    /* 🔴 2026-10-17 P2-13：把 utils/chat-*.js 里的 page methods 挂回 page 实例（this 链完整） */
    Object.assign(this, _intakeMod, _editMod, _realtimeMod);
  },

  onHide() {
    // 页面藏起来时停掉所有定时器 —— 别在后台烧电
    this._stopAllTimers();
  },

  onUnload() {
    this._stopRecording();
    this._stopAllTimers();
    tts.stop();
    if (this._recCtrl) this._recCtrl.off();
    /* 清掉上传队列看门狗（避免页面走了还触发） */
    if (this.__iqWatch) { clearTimeout(this.__iqWatch); this.__iqWatch = null; }
    this.__iqRunning = false; this.__iq = [];
  },

  /** 统一收尾所有 timer（闲置 / 撤销倒计时）—— 页面走了就不该再跑 */
  _stopAllTimers() {
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    const timers = this._undoTimers;
    if (timers) {
      for (const k in timers) { clearInterval(timers[k]); delete timers[k]; }
    }
  },

  /* ═══════════════ 启动 ═══════════════ */

  /**
   * 启动时拉一次今日数字 + 名称 + AI 主动问候/引导
   *
   * 流程：
   *   1. 拉今日数字（顶部），失败静默
   *   2. 拉主体：**名称为空 = 新用户** → 先问名称（首次引导）
   *      名称已有 → 走原来的早安/日报
   */
  async _initBootstrap() {
    await Promise.all([this._loadTodayStat(), this._loadEntity()]);

    /* 🔴 2026-10-17 动态快捷问（老易：提示词要"最近/高频使用记录随机出现"，不要固定）：
       后端按 30 天内问过的 biz/memory 问句聚合随机抽 4 个；没历史/拉失败用默认兜底。 */
    let dynQuicks = null;
    try {
      const qd = await api.quicks();
      if (qd && Array.isArray(qd.items) && qd.items.length) dynQuicks = qd.items;
    } catch (e) { /* 拉不到就用默认组，不挡开场 */ }

    /* ① 首次引导：还不知道怎么称呼 → 先问这个（比"今天还没记账"更重要）
     *    🔴 文案不能写"您开的是什么店" —— 用的人可能是公司 / 团队 / 项目。
     *    跳过 2 次后不再问（entityAskMuted），别烦人 */
    if (!this.data.entityName && !this._entityAskMuted()) {
      this.setData({ needEntityName: true });
      this._appendMsg({
        role: 'ai',
        text: '您好，很高兴遇见您，我是小帮，有什么可以帮您？\n说一声「买菜 30 块」就能记账；也可以把你的表格样表发我（图/Excel/PDF 都行），我学会后按你的格式出报表。',
        card: null,
        suggest: null,
        quicks: dynQuicks || ['今天赚了多少', '最近 3 笔', '发昨天的日报']
      });
      return;
    }

    // ② 老用户：早安 / 日报（顺带给一句情绪价值）
    if (this.data.todayCount === 0) {
      const g = this._appendMsg({
        role: 'ai',
        text: `${this.data.entityName} 老板早上好！今天还没记账。\n说一声"买菜 30 块"我帮你记。\n有自己格式的报表？发张样表给我（图/Excel/PDF），我学会了照着做。`,
        card: null,
        suggest: null,
        quicks: dynQuicks || ['今天赚了多少', '这个月赚了多少', '发昨天的日报']
      });
      this._maybeTone(g.id, this._greetingToneCtx());
    } else {
      /* 🔴 2026-10-17 修：笔数一直在 todayCount，原来却从 todayStat.count 取
         （todayStat 里从来没有 count 字段）→ 会打印「今天已记 undefined 笔」。
         以前没暴露是因为 _loadTodayStat 拆包错误导致 todayCount 恒为 0，
         永远走上面的"还没记账"分支；两个 bug 是连着的，一起修。 */
      const net = this.data.todayStat.net;
      const cnt = this.data.todayCount;

      /* 🔴 2026-10-17 修三处（老易截图「提醒 是 / 不是 怪怪的」）：
         ① 正文里不能塞 <b> / <b style> —— 聊天气泡是**纯文本渲染**，
            标签会原样显示成「<b>1 笔</b>」，比没强调更糟。红涨绿跌交给顶栏着色。
         ② 原文写死「有 1 笔应收 40 天了」是**编出来的账**：后端没有应收接口，
            任何店、任何时候都这么报 —— 违反「账目数字 SQL 实算，LLM 不编数」的铁律，删掉。
         ③ suggest 原来 label='✓ 提醒' 配死写的「是 / 不是」，读起来是「提醒 是 / 提醒 不是」。
            改成「说清要做的事 + 动词按钮」，见下方 wxml。 */
      const g = this._appendMsg({
        role: 'ai',
        text: `今天已记 ${cnt} 笔，净余 ${_fmtNet(net)}。\n想要固定格式的日报月报？发张样表给我，我照着你的格式做。`,
        card: null,
        suggest: null,
        quicks: dynQuicks || ['今天赚了多少', '这个月赚了多少', '最近 3 笔', '发昨天的日报']
      });
      this._maybeTone(g.id, this._greetingToneCtx());
    }
  },

  /**
   * 拉主体信息（名称 / 行业）。
   * 失败静默 —— 网络挂了不该挡着老板用，只是顶部不显示名称。
   */
  async _loadEntity() {
    try {
      const d = await api.getShop();
      if (d) {
        this.setData({
          entityName: d.name || '',
          entityIndustry: d.industry || ''
        });
      }
    } catch (e) {
      // 静默：不把"取主体失败"糊到老板脸上
    }
  },

  /* ═══════════════ 情绪价值 ═══════════════ */

  /**
   * 开屏问候用的 tone 上下文（kind = greeting）。
   * 这个场景下最可能命中的是：深夜 / 月末收口 / 连续记账 / 老欠款。
   */
  _greetingToneCtx() {
    const now = new Date();
    return {
      kind: 'greeting',
      hour: now.getHours(),
      todayCount: this.data.todayCount,
      todayNet: this.data.todayStat.net,
      monthNet: this.data.todayStat.net,
      dayOfMonth: now.getDate(),
      daysInMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
      debtDays: this._maxDebtDays || 0,
      streakDays: this._streakDays || 0,
      seed: now.getDate()
    };
  },

  /**
   * 撤销后给一句（kind = undo）—— 别让老板觉得"记错了很蠢"
   */
  _undoTone(id) {
    const now = new Date();
    this._maybeTone(id, { kind: 'undo', hour: now.getHours(), seed: now.getDate() });
  },

  /**
   * 从 AI 回复里推断"这笔是收入还是支出"以及金额。
   * 后端没给统一的字段，所以从卡片的 summary / numbers 里认 —— 认不出就不给 tone。
   */
  _toneCtxFromReply(d) {
    const card = (d && d.card) || null;
    let type = 0;
    let amount = 0;

    if (card) {
      const s = String(card.summary || '');
      if (/支出|付款|应付|进货|成本/.test(s)) type = 2;
      else if (/收入|回款|应收|卖出|进项/.test(s)) type = 1;

      const nums = card.numbers || [];
      for (let i = 0; i < nums.length; i++) {
        const label = String(nums[i].label || '');
        if (/金额|合计|总计|钱数/.test(label)) {
          const v = parseFloat(String(nums[i].value || '').replace(/[^\d.\-]/g, ''));
          if (Number.isFinite(v)) { amount = Math.abs(v); break; }
        }
      }
    }

    const hour = new Date().getHours();
    const dom = new Date().getDate();
    const dim = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();

    return {
      kind: type ? 'record' : 'query',   // 认不出是记账就别在查询里插话
      hour: hour,
      type: type,
      amount: amount,
      todayCount: this.data.todayCount,
      todayNet: this.data.todayStat.net,
      monthNet: this.data.todayStat.net,
      dayOfMonth: dom,
      daysInMonth: dim,
      debtDays: this._maxDebtDays || 0,
      streakDays: this._streakDays || 0,
      seed: this.data.todayCount + Math.round(amount)
    };
  },

  /**
   * 也许给这条 AI 消息加一句情绪价值评语。
   *
   * ⚠️ 三个约束：
   *   1. 节流 —— 3 分钟内只给一次（说得太勤就成了噪音）
   *   2. 该沉默就沉默 —— pickTone 返回 null 就什么都不加
   *   3. 任何异常都不能影响记账主流程 → 整段 try 包住
   *
   * @param {string} msgId 要挂评语的那条消息 id
   * @param {object} ctx   tone.pickTone 的入参
   */
  _maybeTone(msgId, ctx) {
    try {
      const now = Date.now();
      let lastAt = 0;
      try { lastAt = Number(wx.getStorageSync('toneLastAt')) || 0; } catch (e) {}
      if (!tone.shouldSpeak({ lastAt: lastAt, now: now })) return;

      const r = tone.pickTone(ctx);
      if (!r) return;

      try { wx.setStorageSync('toneLastAt', now); } catch (e) {}
      this._replaceMsg(msgId, { tone: r.text, toneKey: r.key });
    } catch (e) {
      // 情绪价值失败绝不该影响记账
    }
  },

  /**
   * 首次引导：把老板这句话当名称解析并落库。
   *
   * @returns {Promise<boolean>} true = 已消化（调用方**不要**再走 AI）
   *                             false = 不是名称 → 放行给 AI 正常处理
   *
   * 🔴 解析不出来时**必须放行**，不能把老板堵在门口：
   *   老板开屏第一句很可能就是想记账（"买菜 30 块"），
   *   引导问题不该让他输第二次。所以这里只"顺手试着收名称"，
   *   收不到就把话交回给 AI，下次开屏再问。
   *   跳过一次记一笔，跳过 2 次就静音不再问（见 _initBootstrap）。
   */
  async _tryEntityName(q) {
    const r = entityInfo.parse(q);

    /* 不是名称 → 放手，让这句话正常走 AI */
    if (!r) {
      this.setData({ needEntityName: false });
      this._bumpEntityAskSkip();
      return false;
    }

    /* 解析成功 —— 落库。空值不传，避免把已有字段冲掉 */
    try {
      const d = await api.getShop(
        r.name || undefined,
        r.industry || undefined
      );
      this.setData({
        entityName: (d && d.name) || r.name || this.data.entityName,
        entityIndustry: (d && d.industry) || r.industry || '',
        needEntityName: false
      });
      this._clearEntityAskSkip();   // 收到了，以后不用再问
      this._appendMsg({
        role: 'ai',
        text: entityInfo.confirmText(r) + '\n\n现在可以说"买菜 30 块"记账了。',
        card: null,
        suggest: null
      });
    } catch (e) {
      // 🔴 落库失败**不能丢老板的话**：本地先记住，明确告知"稍后存云端"，
      //    而不是假装成功了（那样老板以后发现名称没了，更迷惑）。
      this.setData({
        entityName: r.name || this.data.entityName,
        entityIndustry: r.industry || '',
        needEntityName: false
      });
      this._clearEntityAskSkip();
      this._appendMsg({
        role: 'ai',
        text: entityInfo.confirmText(r) + '\n（云端暂时没连上，回头自动补存）',
        card: null,
        suggest: null
      });
    }
    return true;
  },

  /** 记一次"老板没回答名称"（跳过 2 次就不再问，别烦人） */
  _bumpEntityAskSkip() {
    try {
      const n = (wx.getStorageSync('entityAskSkip') || 0) + 1;
      wx.setStorageSync('entityAskSkip', n);
      if (n >= 2) wx.setStorageSync('entityAskMuted', true);
    } catch (e) { /* 存储失败不影响主流程 */ }
  },

  /** 老板答上了 → 清掉跳过计数，恢复正常问候 */
  _clearEntityAskSkip() {
    try {
      wx.setStorageSync('entityAskSkip', 0);
      wx.removeStorageSync('entityAskMuted');
    } catch (e) { /* 同上 */ }
  },

  /** 是否已静音（跳过 2 次后不再问名称） */
  _entityAskMuted() {
    try {
      return wx.getStorageSync('entityAskMuted') === true;
    } catch (e) {
      return false;
    }
  },

  /**
   * 点顶部名称 → 改名（复用同一条解析链路）
   *
   * 用 editable modal 而不是自己写个页面：改名称是低频动作，
   * 为它单独做一个页面不划算，系统弹窗自带键盘和确定/取消。
   *
   * ⚠️ 走 fromExplicitInput（宽松）而不是 parse（严格）——
   *   老板是在"明确填名称"，填"老李"也该收；
   *   而自由对话里的"老李"可能是人名，必须严格。
   */
  onTapEntityName() {
    const cur = this.data.entityName || '';
    wx.showModal({
      title: cur ? '修改名称' : '设置名称',
      editable: true,
      placeholderText: '比如：老李水果店 / 火星科技 / 春晓项目',
      content: cur,
      confirmText: '保存',
      success: (r) => {
        if (!r.confirm) return;
        this._saveEntityName(r.content);
      }
    });
  },

  /** 落库名称（顶部改名 + 首次引导都用这条路径） */
  async _saveEntityName(text) {
    const r = entityInfo.fromExplicitInput(text);
    if (!r) {
      wx.showToast({ title: '名称要 2-20 个字', icon: 'none' });
      return;
    }

    /* ⚠️ 之前这里 showLoading + mask，被反馈"一直转圈"：
     *   showLoading 在某些设备上 + editable modal 关闭后的瞬间，
     *   会让 mask 残留看起来像转圈。
     *   改成纯 toast：保存是一个 POST，体感上不值得一个全屏遮罩。 */
    try {
      const d = await api.getShop(r.name, r.industry || undefined);
      this.setData({
        entityName: (d && d.name) || r.name,
        entityIndustry: (d && d.industry) || r.industry || '',
        needEntityName: false
      });
      this._clearEntityAskSkip();
      const tail = r.industry ? '（' + r.industry + '）' : '';
      wx.showToast({ title: '已改为「' + r.name + '」' + tail, icon: 'none' });
    } catch (e) {
      // 🔴 不能假装成功：本地不改，明确告诉老板没存上
      wx.showModal({
        title: '没存上',
        content: '云端暂时没连上，名称没保存。\n稍后网络好了再点一次名称就能改。',
        showCancel: false,
        confirmText: '知道了'
      });
    }
  },

  async _loadTodayStat() {
    try {
      const d = await api.getToday();
      /* 🔴 2026-10-17 修：接口（/api/today）返回的是
         { today: { income, expense, net, cnt }, pending, trend }，
         原来这里直接读 d.net / d.income / d.count —— 全是 undefined，
         静默变成 0 → 顶部永远显示 +¥0，账记了也不动。
         （pages/today/today.js 读的才是对的：d.today。
          同一个接口两个页面两种读法，以 today.js 为准。） */
      const t = (d && d.today) || {};
      const net = Number(t.net), income = Number(t.income);
      const expense = Number(t.expense), cnt = Number(t.cnt);
      this.setData({
        todayStat: {
          net: isFinite(net) ? net : 0,
          income: isFinite(income) ? income : 0,
          expense: isFinite(expense) ? expense : 0
        },
        todayCount: isFinite(cnt) ? cnt : 0,
        todayNetText: _fmtNet(isFinite(net) ? net : 0)
      });
    } catch (e) {
      // 静默失败 —— 顶部数字不重要
    }
  },



  /** 拍照 / 相册 —— count:9，一次可多选（相机一次只能拍一张，多选走相册）。 */
  _chooseImage(sourceType) {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: [sourceType],
      sizeType: ['compressed'],
      success: (res) => {
        const items = (res.tempFiles || []).map((f) => intake.buildItem({
          path: f.tempFilePath,
          name: (String(f.tempFilePath || '').split('/').pop()) || '照片',
          size: f.size,
          mime: f.mimeType || '',
          kind: intake.KIND.IMAGE,
          source: 'media'
        })).filter(Boolean);
        if (items.length) this.__enqueue(items);
        else wx.showToast({ title: '没能取到图片', icon: 'none' });
      },
      fail: (err) => {
        /* 用户主动取消不算失败，别弹提示烦人 */
        if (err && /cancel/i.test(String(err.errMsg || ''))) return;
        wx.showToast({ title: '没能取到图片', icon: 'none' });
      }
    });
  },

  /** 从微信聊天里选文件（拿 Excel / CSV / PDF 最自然的路径）—— 同样支持多选。 */
  _chooseMessageFile() {
    wx.chooseMessageFile({
      count: 9,
      type: 'file',
      success: (res) => {
        const items = (res.tempFiles || []).map((f) => intake.buildItem({
          path: f.path, name: f.name, size: f.size, mime: f.type || '', source: 'message'
        })).filter(Boolean);
        if (!items.length) return;
        /* 认不出类型的（docx/zip…）先过滤掉，能认的照常入队 */
        const known = items.filter((it) => intake.routeOf(it.kind) !== 'manual');
        if (known.length < items.length) {
          wx.showModal({
            title: '有看不懂的格式',
            content: '目前能认：图片、Excel/CSV、PDF、txt。\n看不懂的我先跳过，能认的照常处理。',
            showCancel: false, confirmText: '好'
          });
        }
        if (known.length) this.__enqueue(known);
      },
      fail: (err) => {
        if (err && /cancel/i.test(String(err.errMsg || ''))) return;
        wx.showToast({ title: '没能取到文件', icon: 'none' });
      }
    });
  },


  /**
   * 🔴 2026-10-17 多选批量：把一次选中的多张归一化项排成**串行队列**，
   * 一张的确认卡出现后（或失败卡出现后）再跑下一张。
   * 不并发：① 避免多张结果糊在一起；② 减少同时挂起的请求（半开连接下更稳）。
   *
   * 🔴 老易 13:08 死锁修复：
   *   ① 兜底守卫：每张入队时设 _iqLastKick，30s 还没 done 出来 → 自动调用 done 解锁下一张
   *      （避免看门狗/OCR 路径某一环 done() 漏调用导致整个队列僵住）
   *   ② 队列满 5 张提示"处理较慢"——9 张全 OCR 串行约 144s，老板会以为又卡了
   */
  __enqueue(items) {
    this.__iq = (this.__iq || []).concat(items);
    if (this.__iqRunning) return;
    this.__iqRunning = true;
    this.__kickWatchdog();
    this.__pump();
  },
  __kickWatchdog() {
    if (this.__iqWatch) clearTimeout(this.__iqWatch);
    this.__iqWatch = setTimeout(() => {
      /* 30s 还在跑上一张 → 强制解队列；下一张开始 */
      if (this.__iqRunning) {
        this.__iqRunning = false;
        if (this.__iq && this.__iq.length > 0) {
          this.__pump();
        }
      }
    }, 30000);
  },
  __pump() {
    if (this.__iqWatch) { clearTimeout(this.__iqWatch); this.__iqWatch = null; }
    const item = (this.__iq || []).shift();
    if (!item) { this.__iqRunning = false; this.__iq = []; return; }
    /* 队列较长时温和提示老板 */
    if (this.__iq && this.__iq.length >= 3) {
      wx.showToast({ title: '还有 ' + this.__iq.length + ' 张排队', icon: 'none', duration: 1200 });
    }
    this.__kickWatchdog();
    this._intake(item, () => this.__pump());
  },

  /**
   * 🔴 2026-10-16 样表学习：把用户传的样表文件（图/PDF/Excel）发后端解析+学格式。
   * 走这里的前提：用户刚说过「参照这个表格样式做表」类话术（_send 里置的挂起）。
   */
  _learnFromSample(item) {
    const thinking = this._appendMsg({
      role: 'ai',
      text: '收到样表，正在学它的格式…',
      card: null, suggest: null
    });
    const fsm = wx.getFileSystemManager();
    fsm.readFile({
      filePath: item.path,
      encoding: 'base64',
      success: (res) => {
        api.learnReportTemplate({
          mime: item.mime || '',
          filename: item.name || '',
          dataBase64: res.data
        }).then((d) => {
          const answer = (d && (d.answer || d.msg)) || '学会了';
          /* 学习成功 → 展示 AI 回复 + 引导立即用一次 */
          this._replaceMsg(thinking.id, {
            text: '',
            steps: null,
            card: (d && d.card) || { summary: answer, numbers: [], points: ['说「按我的模板出今天的日报」试一下'] }
          });
          this._appendMsg({
            role: 'ai',
            text: answer + '\n\n说「按我的模板出今天的日报」就能按这个格式出表。',
            card: null,
            /* 标签说清「要做什么」，「是/不是」换成动词按钮 —— 避免再读成「出表试试 是/不是」 */
            suggest: { q: '按我的模板出今天的日报', label: '按您的模板出今天的日报', yes: '出表', no: '不用' }
          });
        }).catch((e) => {
          /* 失败如实说（后端 msg 是人话：格式不支持/文件空/OCR 失败等） */
          this._replaceMsg(thinking.id, { text: '', steps: null });
          this._appendMsg({
            role: 'ai',
            text: '这份样表没学成：' + ((e && e.message) || '解析失败') + '\n可以截图后重发，或者直接把列名说给我听。',
            card: null, suggest: null
          });
        });
      },
      fail: () => {
        this._replaceMsg(thinking.id, { text: '', steps: null });
        this._appendMsg({ role: 'ai', text: '文件读取失败，再发一次试试。', card: null, suggest: null });
      }
    });
  },



  /**
   * 用解析出的行渲染「待您确认」卡。
   * 人审是最后一道闸：可改可忽略，确认才入账（数字铁律在入口处的防线）。
   */
  _renderConfirm(msgId, rows, note, opts) {
    let c = receipt.buildConfirm(rows || [], note || '');
    /* 🔴 16:09 把 OCR 原文存到 rawTextCache（点了"展开原文"展示） */
    if (opts && opts.rawText) this.setData({ rawTextCache: opts.rawText });
    const rawText = (opts && opts.rawText) || '';   // 🔴 2026-10-17 14:57 老易反馈用
    const allOrig = (opts && opts.allOrig) || '';   // OCR 抽到的原文（合并原始行文本）

    /* 给每行预格式化金额（WXML 不能调函数，也不能按值查表 —— 会撞重复金额） */
    let out = [];
    for (let i = 0; i < c.rows.length; i++) {
      const r = c.rows[i];
      out.push({
        k: 'r' + i,
        t: r.t,
        txt: r.txt,
        who: r.who,
        amt: r.amt,
        /* 🔴 2026-10-17 G 项：去尾零 —— 99 显示 "99" 而非 "99.00"；27.7 显示 "27.7" 而非 "27.70" */
        amtText: (r.t === 'in' ? '+' : '-') + _fmtAmtTrim(r.amt)
      });
    }
    /* 🔴 2026-10-17 14:57 老易 OCR 反馈：A+B 后处理 */
    /* A. 去掉 amt<=0 的行（"易嘉艺住宿费 0" 这种拆分残余） */
    out = out.filter((r) => Number(r.amt) > 0);
    /* B. 同一 txt 多次出现：保留第一条；如果金额不同则合并到一条，金额累加 */
    {
      const seen = new Map();
      const merged = [];
      for (let i = 0; i < out.length; i++) {
        const k = String(out[i].txt || '').replace(/[\s·:：]/g, '');
        const prev = seen.get(k);
        if (!prev) {
          const cp = Object.assign({}, out[i]);
          cp.amtText = (cp.t === 'in' ? '+' : '-') + _fmtAmtTrim(cp.amt);
          seen.set(k, cp);
          merged.push(cp);
        } else {
          /* 同摘要：金额相加（方向以首条为准 —— 老易手写一般一行一方向）*/
          const newAmt = round2(Number(prev.amt) + Number(out[i].amt));
          prev.amt = newAmt;
          prev.amtText = (prev.t === 'in' ? '+' : '-') + _fmtAmtTrim(newAmt);
          prev._merged = (prev._merged || 1) + 1;
        }
      }
      out = merged;
    }
    c.rows = out;
    /* 🔴 2026-10-17 C 项：note 顶部加"疑似 AI 编"警示（仅 OCR 路径，sample 路径不抽 OCR） */
    const ghostCount = c.rows.filter((r) => r._ghost).length;
    if (ghostCount > 0) {
      c.hint = (c.hint ? c.hint + '；' : '') + '⚠️ 有 ' + ghostCount + ' 行疑似 AI 编的（原图中查不到这些字），请逐行核对';
    }
    if (c.rows.some((r) => r._merged && r._merged > 1)) {
      const mergedCount = c.rows.filter((r) => r._merged > 1).length;
      c.hint = (c.hint ? c.hint + '；' : '') + 'A+B：' + mergedCount + ' 处同摘要行已自动合并（如有金额差异已加总）';
    }
    /* 🔴 2026-10-17 C 项：AI 编内容检测（"车险"真实只写"保险"）
       思路：抽 rawText 里的中文 token（2 字以上），如果某行 txt 在 rawText 里查不到
       任何公共子串 → 标 _ghost=true，UI 上加红警示。 */
    if (rawText) {
      const raw = String(rawText).replace(/\s+/g, '');
      for (let i = 0; i < c.rows.length; i++) {
        const r = c.rows[i];
        const t = String(r.txt || '').replace(/\s+/g, '');
        if (!t) { r._ghost = true; continue; }
        /* 抽 2 字以上连续中文片段，看是否在 raw 里 */
        let hit = false;
        for (let a = 0; a < t.length - 1 && !hit; a++) {
          for (let len = Math.min(4, t.length - a); len >= 2 && !hit; len--) {
            const sub = t.substr(a, len);
            if (/[一-龥]/.test(sub) && raw.indexOf(sub) >= 0) hit = true;
          }
        }
        if (!hit) r._ghost = true;
      }
    }
    /* 🔴 2026-10-17 老易反馈：单条有错可改。改后要和原合计对账 → 记 origTotal */
    const origTotal = Math.round(((c.inSum || 0) + (c.outSum || 0)) * 100) / 100;

    this._replaceMsg(msgId, {
      steps: null,
      text: '识好了 —— ' + c.note + '，您过目确认（点单行可改）：',
      confirm: {
        rows: c.rows,
        count: c.count,
        hint: c.hint,
        note: c.note,
        done: false,
        canConfirm: c.canConfirm,
        origTotal: origTotal
      }
    });
  },


  /**
   * 解析样本（**仅用于非图片**：表格 / PDF / 文本）。
   *
   * 🔴 图片(IMAGE)已走真 OCR（见 _showOcrConfirm），**不经过这里**。
   *   表格/PDF/文本的后端解析端点尚未接，这里仍返回演示样本 ——
   *   后端一上，把这里换成真实返回即可（流程：进度 → 确认 → 入账校验已就绪）。
   */
  _parseSample(item) {
    if (item.kind === intake.KIND.TABLE) {
      return {
        note: '表格 1 份，解析出 3 行',
        rows: [
          { t: 'out', txt: '10-08 进货', amt: 1800, who: '张姐' },
          { t: 'out', txt: '10-09 水电费', amt: 236.8, who: '' },
          { t: 'in', txt: '10-09 现金收款', amt: 960, who: '' }
        ]
      };
    }
    if (item.kind === intake.KIND.PDF) {
      return {
        note: 'PDF 1 份，解析出 1 笔',
        rows: [{ t: 'out', txt: '对账单合计', amt: 1268, who: '' }]
      };
    }
    if (item.kind === intake.KIND.TEXT) {
      return {
        note: '文本 1 份，解析出 1 笔',
        rows: [{ t: 'out', txt: '文本账目', amt: 100, who: '' }]
      };
    }
    /* 图片 → 走 OCR 样本 */
    const OCR = [
      { note: '小票 1 张，识别到 1 笔', rows: [{ t: 'out', txt: '菜市场进货', amt: 168.5, who: '城东菜市场' }] },
      { note: '小票 1 张，识别到 2 笔', rows: [{ t: 'out', txt: '猪肉', amt: 86, who: '张姐' }, { t: 'out', txt: '大米', amt: 120, who: '' }] },
      { note: '账单截图，识别到 1 笔', rows: [{ t: 'out', txt: '加油', amt: 300, who: '中石化' }] }
    ];
    this._ocrIdx = ((this._ocrIdx || 0) + 1) % OCR.length;
    return OCR[this._ocrIdx];
  },



  onEditAmtInput(e) { this.setData({ 'editRow.amt': String(e.detail.value || '').replace(/[^\d.]/g, '').slice(0, 12) }); },
  onEditTxtInput(e) { this.setData({ 'editRow.txt': String(e.detail.value || '').slice(0, 60) }); },
  onEditWhoInput(e) { this.setData({ 'editRow.who': String(e.detail.value || '').slice(0, 30) }); },
  onTapEditClose() { this.setData({ editRowOpen: false }); },
  onTapEditCloseMask() { this.setData({ editRowOpen: false }); },
  /* 🔴 16:09 OCR 原文展开/收起：让老板看到 AI 抽的是哪一段图上的字，对账用 */
  onTapToggleRaw() { this.setData({ showRawText: !this.data.showRawText }); },
  /* 🔴 2026-10-17 15:34 老易反馈：金额框点不动。
     原因：edit-panel 上的 catchtap="" 在某些基础库版本会吞 input 事件。
     改为 catchtap="onTapEditNoop" —— 显式空函数，确保 catchtap 不影响子元素事件。 */
  onTapEditNoop() { /* 占位：防止冒泡到 mask 关弹窗 */ },

  /* ═══════════════ 撤销倒计时 + 撤回撤销 ═══════════════ */

  /**
   * 点撤销后开始 30 秒倒计时（角标显示剩余秒）。
   * 到点自动收尾：清掉 undone，撤掉"撤回这次撤销"。
   */
  _startUndoCountdown(msgId) {
    this._stopUndoCountdown(msgId);

    const timers = this._undoTimers || (this._undoTimers = {});
    let left = 30;

    this._replaceMsg(msgId, { undoLeft: left, canRedo: true });

    timers[msgId] = setInterval(() => {
      left--;
      const m = this.data.msgs.find((x) => x.id === msgId);
      if (!m) return this._stopUndoCountdown(msgId);   // 消息没了
      if (left <= 0) {
        this._stopUndoCountdown(msgId);
        this._replaceMsg(msgId, { undoLeft: 0, canRedo: false, undone: null });
        return;
      }
      this._replaceMsg(msgId, { undoLeft: left });
    }, 1000);
  },

  _stopUndoCountdown(msgId) {
    const timers = this._undoTimers;
    if (timers && timers[msgId]) {
      clearInterval(timers[msgId]);
      delete timers[msgId];
    }
  },

  /** 撤回这次撤销（30 秒内） */
  onTapRedo(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.data.msgs.find((x) => x.id === id);
    if (!m || !m.canRedo) return;

    const undoId = m._undoRecordId;
    if (!undoId) return;

    api.redoRecord(undoId).then((d) => {
      if (d && d.ok) {
        this._stopUndoCountdown(id);
        this._replaceMsg(id, { _undone: false, canRedo: false, undoLeft: 0, undone: null });
        this._loadTodayStat();
        wx.showToast({ title: '账已恢复', icon: 'none' });
      } else {
        wx.showToast({ title: '恢复失败', icon: 'none' });
      }
    }).catch((e) => this._showTip(this._opErrTip(e, '重做失败，稍后再试')));
  },









  /** 改某一行对讲记录（撤销后用） */
  _rtPatchLine(k, patch) {
    this.setData({
      rtLines: this.data.rtLines.map((l) => {
        if (l.k !== k) return l;
        const out = {};
        for (const key in l) out[key] = l[key];
        for (const key in patch) out[key] = patch[key];
        return out;
      })
    });
  },


  /**
   * 麦克风失败原因分类 —— 直接搬 H5 那版的思路（它这里做得很扎实）。
   * 光报"失败了"用户没法自救；说清是哪种才能让他动手解决。
   */
  _micErrTip(err) {
    /* 🔴 2026-10-17 修「永远显示 Error」：
       原来取的是 `errMsg || name || message` —— 而标准 Error 对象的
       **name 恰好就是字符串 "Error"**，于是任何 Error 都显示成
       「语音用不了：Error」，把真正的 message 吞掉了（老易真机截图就是这个）。
       正确顺序：errMsg（微信回调）→ message（Error 的真话）→ name（最后兜底）。 */
    const raw = (err && (err.errMsg || err.message || err.name)) || '';
    const s = String(raw);

    if (/auth deny|authorize|permission|NotAllowed/i.test(s)) {
      return '麦克风权限被拒绝：到 设置 → 小程序 → 允许录音 后重试';
    }
    if (/no device|NotFound|not found/i.test(s) && !/socket/i.test(s)) {
      return '没检测到麦克风设备';
    }
    if (/occupied|busy|NotReadable|占用/i.test(s)) {
      return '麦克风被别的应用占用了（比如正在微信通话），关掉再试';
    }
    /* 真机与工具上最常撞的几种，逐条给出人话版本（原来一律落到"语音用不了"） */
    if (/not in domain list|不合法的域名/i.test(s)) {
      return '语音域名未加白名单：公众平台 → 开发设置 → socket 合法域名，加 wss://api.dtzai.cn（改完重进小程序）';
    }
    if (/closeSocket:fail/i.test(s)) {
      return '连接被对端关了（换个网或重开面板再试）';
    }
    if (/timeout|超时/i.test(s)) {
      return '语音通道连不上：手机上换个网络（Wi-Fi/流量）再试';
    }
    if (/wss|socket|连接|connect|1006|1000/i.test(s)) {
      return '语音通道断了：手机上换个网络再试';
    }
    return '语音用不了：' + (s || '未知原因');
  },

  /**
   * 把接口错误翻译成一句"能照着做"的话。
   *
   * 🔴 2026-10-17：以前撤销/重做/记住失败一律报"网络异常"。
   *   但 api.call 抛出来的 e.message 里本来就带着后端的原话
   *   （"登录已过期，请重新打开小程序" / "记录不存在" / "接口返回 500"）。
   *   把它们统一吞成"网络异常"的后果：401（令牌过期）和真·断网长得一模一样，
   *   老板只能反复点同一个按钮 —— 而正确的做法是退出去重进。
   */
  _opErrTip(e, fallback) {
    const msg = (e && e.message) || '';
    if (!msg) return fallback || '操作没成功';
    if (/登录已过期|未识别到微信身份|令牌|401/.test(msg)) {
      return '登录过期了，退出去重进一次小程序';
    }
    if (/timeout|超时|request:fail|网络|连不上/.test(msg)) {
      return '网络不太好，等一下再试';
    }
    return msg.slice(0, 60);
  },

  /** 短提示用 toast，长提示用 modal（toast 塞不下就变成"看不全"，等于没说） */
  _showTip(tip) {
    const t = String(tip || '').trim();
    if (!t) return;
    if (t.length > 14) {
      wx.showModal({ title: '没成功', content: t, showCancel: false, confirmText: '知道了' });
    } else {
      wx.showToast({ title: t, icon: 'none' });
    }
  },

  /* ═══════════════ 闲置主动关怀 ═══════════════
   *
   * H5 那版是"闲置 25 秒自动播演示" —— 那是对的，因为它是**演示页**。
   * 小程序是**真产品**：用户在用的时候自己弹演示是骚扰。
   * 所以这里改成产品化的版本：闲置够久 → AI 提一句**待办或情绪价值**，
   * 而且半小时最多一次。要的就是"想起来关心你一下"，不是"自播放"。
   */

  _bumpIdle() {
    this._idleAt = Date.now();
  },

  _startIdleWatch() {
    this._bumpIdle();
    if (this._idleTimer) clearInterval(this._idleTimer);
    this._idleTimer = setInterval(() => this._idleTick(), 30000);
  },

  _idleTick() {
    if (!this._idleAt) return;
    /* 正在忙 / 在录音 / 面板开着 —— 都别打扰 */
    if (this.data.sending || this.data.recording || this.data.upOpen || this.data.rtOpen) return;
    if (Date.now() - this._idleAt < 3 * 60 * 1000) return;

    /* 半小时最多一次 */
    const now = Date.now();
    if (this._lastNudgeAt && now - this._lastNudgeAt < 30 * 60 * 1000) return;

    const t = tone.pickTone(this._greetingToneCtx());
    if (!t) return;                       // 认不出场景 → 沉默，别硬凑

    this._lastNudgeAt = now;
    this._bumpIdle();
    this._appendMsg({ role: 'ai', text: '', tone: t.text, card: null, suggest: null });
  },

  /* ═══════════════ 对话管理 ═══════════════ */

  /**
   * 追加一条消息并滚到底部
   * @returns {object} 追加后的消息（含 id / t）—— 调用方拿 id 做后续修改（如挂情绪价值评语）
   */
  /**
   * 去掉文本里混进来的 HTML 标签。
   *
   * 🔴 2026-10-17 为什么要有：聊天气泡 `{{m.text}}` 是**纯文本渲染**，
   *    早先问候语里为了强调金额写了 `<b>1 笔</b>` / `<b style="color:…">`，
   *    结果老板看到的是「今天已记 <b>1 笔</b>」——标签原样露出来（老易截图）。
   *    这里只剥已知的行内标签，不碰普通比较符号（如「5 < 10」）。
   *    没走 rich-text：rich-text 不把 \n 当换行，会毁掉多行排版。
   */
  _plainText(s) {
    if (typeof s !== 'string') return s;
    return s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(?:b|strong|i|em|u|s|span|p|div|font|small|code|mark)[^>]*>/gi, '');
  },

  _appendMsg(m) {
    const merged = {
      id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      t: this._nowText()
    };
    for (const k in m) merged[k] = m[k];
    merged.text = this._plainText(merged.text);          // 防 HTML 标签裸显
    const msgs = this.data.msgs.concat([merged]);
    this.setData({
      msgs,
      scrollTo: 'tail' + Date.now()   // 强制 scroll-into-view 触发滚动
    });
    return merged;
  },

  /**
   * 替换某条消息（撤销后用）
   */
  _replaceMsg(id, patch) {
    this.setData({
      msgs: this.data.msgs.map((m) => {
        if (m.id !== id) return m;
        const out = {};
        for (const k in m) out[k] = m[k];
        for (const k in patch) out[k] = (k === 'text') ? this._plainText(patch[k]) : patch[k];
        return out;
      })
    });
  },

  /**
   * 移除某条消息
   */
  _removeMsg(id) {
    this.setData({ msgs: this.data.msgs.filter((m) => m.id !== id) });
  },

  _nowText() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  },

  /* ═══════════════ 发送 ═══════════════ */

  /**
   * 发送用户输入（语音完成后 / 键盘回车）
   */
  async _send() {
    const q = (this.data.input || '').trim();
    if (!q || this.data.sending) return;
    /* 🔴 2026-10-16 样表学习话术检测：命中就挂起学习模式，
       紧跟着上传的文件走「学样表」通道（10 分钟内有效）。 */
    if (_isLearnIntent(q)) {
      this._pendingLearn = true;
      this._pendingLearnAt = Date.now();
    } else {
      this._pendingLearn = false;
    }
    this._appendMsg({ role: 'user', text: q });
    this.setData({ input: '', sending: true });
    await this._ask(q);
  },

  /**
   * 调后端 AI（外层壳：无论成功、失败还是提前 return，都把「正在算…」收掉）
   *
   * 🔴 历史 bug：这里曾直接是 _ask 本体，全程没有任何位置把 sending 设回 false，
   * 结果第一句发完「正在算…」永久挂在底部，还把所有后续发送堵死。
   */
  async _ask(q) {
    try {
      await this._askImpl(q);
    } finally {
      this.setData({ sending: false });
    }
  },

  /**
   * 调后端 AI
   *
   * 长上下文：把最近 6 条消息打包给后端（不含被撤销的）
   *
   * 🔴 之前这是 `async function _askImpl(self, q) {}` —— 在 Page 字面量里写
   * `function` 声明是非法的（vm.Script 解析直接报 "Unexpected identifier"）。
   * 改成 ES6 方法简写后没问题。
   */
  async _askImpl(q) {
    /* ① 首次引导优先：正在问名称时，先把这句话当名称解析。
     *    解析成功 → 落库 + 确认，**不**走 AI（老板回答名称不需要 AI 算账）。
     *    解析失败 → 再问一次；问满 2 次就放过，别把老板堵在门口。 */
    if (this.data.needEntityName) {
      const done = await this._tryEntityName(q);
      if (done) return;
    }

    let d = null;
    let usedMock = false;
    try {
      const recent = this.data.msgs
        .filter((m) => !m._undone)
        .slice(-6)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text || '' }));

      d = await api.chat(q, 'bookkeeper', {
        withTTS: this.data.ttsOn,
        sessionId: this._sessionId,
        history: recent
      });
    } catch (e) {
      /* 🔴🔴 2026-10-17 16:41 老易真机发现"离线 mock 出假账"——即使有 demo 角标
       *    卡片里"¥1,760 收入 / ¥365 支出"太真了，老板可能当真。
       *    改：不再用本地 mock 生成假数据；后端不可用时**直接告诉老板连不上**。
       *    老易说"宁可断网也不要看假账"——这是账本类产品的底线。 */
      console.warn('[chat] 后端不可用，不返回 mock:', e.message);
      d = {
        answer: '云端连不上，没拿到数据。\n\n请检查网络，或稍后再试。',
        card: { summary: '网络没通', numbers: [], points: ['后端接口暂不可用，本次没记账 / 没查账'] },
        kind: 'free',
        degraded: true,
        netFail: true
      };
      usedMock = false;
    }

    /* 🔴 2026-10-17 修「同一句话出现两次」：kb 兜底会把答案同时塞进 msg.text
       和 card.summary（summary 取 answer 前 60 字），于是气泡里说一遍、
       卡片标题又原样重复一遍 —— 老易截图里那两句「在『报表』页点…」就是这么来的。
       两处内容实质相同时，去掉卡片标题，答案只出现一次。 */
    if (d.card && d.card.summary) {
      const _norm = (s) => String(s || '').replace(/[…\s]/g, '');
      const _a = _norm(d.answer), _b = _norm(d.card.summary);
      if (_a && (_b === _a || _a.indexOf(_b) >= 0 || _b.indexOf(_a) >= 0)) {
        d.card.summary = '';
      }
    }

    // 卡片已带「分享/记住/导出」操作行时，别再挂同义的 AI 建议（两个记住/两个分享都扎眼）
    const _cardHasActions = !!(d.card && (
      (d.card.numbers && d.card.numbers.length) ||
      (d.card.list && d.card.list.length) ||
      (d.card.points && d.card.points.length)
    ));
    let _suggest = d.suggest || null;
    if (_cardHasActions && _suggest &&
        /分享|记住/.test((_suggest.label || '') + (_suggest.q || ''))) {
      _suggest = null;
    }
    // 兜底回复（AI 没听懂 / 没算出来）不该再挂「记住」这类建议 —— 会显得又怪又蠢
    if (_suggest && !_cardHasActions &&
        /没能算出来|没听懂|没明白|听不懂|不知道/.test(d.answer || '')) {
      _suggest = null;
    }

    // 等流式回复（v0.1 不实现流式）
    const aiMsg = this._appendMsg({
      role: 'ai',
      text: d.answer || '...',
      card: d.card || null,
      confirm: d.confirm || null,
      suggest: _suggest,
      undone: d.card && d.card.undo ? d.card.undo[0] : null,
      skill: d.skillUsed || d.kind || null,
      computed: d.computed || false,
      demo: !!d.demo            // 离线演示数据角标（见上面 mock 分支的说明）
    });

    // 情绪价值评语（该沉默就沉默，见 utils/tone.js）
    this._maybeTone(aiMsg.id, this._toneCtxFromReply(d));

    // 卡片能分享就**后台预生成快照** —— 就绪后「分享」按钮自动变成微信原生转发
    this._maybePreshare(aiMsg);

    // 撤销 bookkeeping —— 把上一笔的 undo 记录保留
    if (d.card && d.card.undo && d.card.undo.length) {
      // 30 秒后自动消失（前端模拟）
      setTimeout(() => {
        this._removeUndoBadge(d.card.undo[0]);
      }, 30000);
    }

    // TTS 播报（前端调后端 /api/tts/synthesize，自己播）
    if (this.data.ttsOn && d && !usedMock) {
      const txt = _stripForTts(d.answer || '');
      if (txt) tts.speak(txt).catch(() => { /* TTS 失败就静默 */ });
    }

    this._loadTodayStat();   // 刷新顶部数字
  },

  // 🔴 删掉 _ask 包装（现在 _ask 就是方法了）
  // 旧版：_ask: function (q) { return _askImpl(this, q); },

  _removeUndoBadge(id) {
    // 30 秒后让用户这条「记错了？点这里撤掉」自动隐藏
    const msgs = this.data.msgs;
    const m = msgs.find((x) => x.undone === id);
    if (m) {
      this.setData({
        msgs: msgs.map((x) => {
          if (x.id !== m.id) return x;
          const out = {};
          for (const k in x) out[k] = x[k];
          out.undone = null;
          return out;
        })
      });
    }
  },

  /* ═══════════════ 输入框交互 ═══════════════ */

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onTapSend() {
    this._send();
  },

  onQuickAsk(e) {
    const q = e.currentTarget.dataset.q;
    if (!q) return;
    this.setData({ input: q });
    this._send();
  },

  /**
   * 主话筒 = 实时对讲入口
   *
   * 之前这里走"点按录音 → 转文字 → 发送"的推拉模式，而「实时对讲」却被藏在 ＋ 上传面板里
   * （语音功能和拍照/相册混在一起，位置就不对）；且主话筒还被 sending 永久卡死（已修）。
   * 现在统一：点主话筒 = 直接进实时对讲面板，边聊边说。
   */
  onTapMic() {
    this.onTapRealtime();
  },

  async _startRecording() {
    if (this.data.sending) return;
    this.setData({ recording: true, liveText: '', recSecs: 0, recFallback: false });
    // 关闭任何 TTS
    if (this.data.audioPlaying) {
      tts.stop();
      this.setData({ audioPlaying: false });
    }
    // 录音计时（每秒 +1）
    this._recTimer = setInterval(() => {
      this.setData({ recSecs: this.data.recSecs + 1 });
    }, 1000);

    this._recCtrl = recorder.start({
      /* 同对讲面板：先过底噪门限再喂管道（见 utils/noise-gate.js 里"为什么置零而不跳帧"） */
      onFrame: (frame) => {
        if (this._pipe) this._pipe.feed(noiseGate.apply(frame).buf);
      },
      onStop: () => {
        if (this._pipe) this._pipe.finish();
      },
      onError: (e) => {
        console.warn('[voice] recorder error', e);
        this._stopRecording();
        /* 🔴 之前是统一的"录音失败" —— 老板没法自救。
         *   复用对讲面板那版做好的麦克风错误分类：权限/无设备/被占用/通道未连通。 */
        const tip = this._micErrTip(e) || '录音失败';
        if (tip.length > 24) {
          wx.showModal({ title: '录音没起来', content: tip, showCancel: false, confirmText: '知道了' });
        } else {
          wx.showToast({ title: tip, icon: 'none' });
        }
      }
    });

    const app = getApp();
    const openid = (app && app.globalData && (app.globalData.openId || app.globalData.openid)) || 'anon';
    this._pipe = pipe.open({
      openid,
      dialect: 'mandarin',
      onReady: () => { this.setData({ recFallback: false }); },
      onPartial: (t) => { this.setData({ liveText: t }); },
      onFinal: (t) => { this.setData({ liveText: t }); },
      onError: () => {
        // wss 没接 / ASR 服务挂了 → 标记降级
        this.setData({ recFallback: true });
      }
    });

    // 5 秒内 wss 没握手就降级提示
    setTimeout(() => {
      if (this.data.recording && this.data.recFallback === false && !this.data.liveText) {
        // 还在等握手，不算失败
      }
    }, 5000);
  },

  async _stopRecording() {
    this.setData({ recording: false });
    if (this._recTimer) { clearInterval(this._recTimer); this._recTimer = null; }
    if (this._recCtrl) { this._recCtrl.off(); this._recCtrl = null; }
    if (!this._pipe) { this.setData({ liveText: '', recSecs: 0 }); return; }
    const text = await this._pipe.finish().catch(() => '');
    const q = String(text || '').trim() || this.data.liveText.trim();
    this._pipe = null;
    this.setData({ liveText: '', recSecs: 0 });
    if (q) {
      this.setData({ input: q });
      this._send();
    } else if (this.data.recFallback) {
      // wss 降级：弹提示让用户手打
      wx.showModal({
        title: '语音通道未连接',
        content: '当前没接 yibang-realtime 服务，识别不到语音。\n\n请直接打字，或部署 yibang-realtime 后重试。',
        showCancel: false,
        confirmText: '我知道了'
      });
    }
  },

  /* ═══════════════ 富交互卡片：4 个 mini 按钮 ═══════════════ */

  /**
   * 🔴 2026-10-16 分享重做：不再是"生成链接复制到剪贴板"（那是 H5 思维，
   * 小程序里老板拿到链接还得手动粘贴转发）。
   * 现在：卡片一出来就**在后台预生成快照**，分享按钮变成微信原生转发按钮
   * （open-type=share）—— 点了**直接弹好友选择器**，转出去一张小程序卡片，
   * 对方点开就是只读报表页（token 即凭证，快照 7 天有效）。
   */
  onShareAppMessage(res) {
    /* ① 卡片上的「分享」按钮（open-type=share）：转发只读报表页 */
    if (res && res.from === 'button' && res.target && res.target.dataset && res.target.dataset.token) {
      const d = res.target.dataset;
      return {
        title: (d.title || '报表快照') + ' · 易帮AI智账',
        path: '/pages/report-view/report-view?token=' + d.token
      };
    }
    /* ② 右上角菜单「转发」：转聊天页 */
    return { title: '易帮AI智账 —— 会记账的 AI 小帮', path: '/pages/chat/chat' };
  },


  /**
   * 分享 —— 快照就绪时按钮已是原生转发（不走这）；这里只兜底：
   * 预生成还没回来 / 失败时的手动路径。
   */
  onTapShare(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.data.msgs.find((x) => x.id === id);
    if (!m || !m.card) return;
    if (m.shareToken) return;      // 已就绪的不会走到这（按钮已换原生转发）
    const s = this._inferShare(m);
    if (s.type === 2) {            // 对账单需先选客户
      this._promptContactShare();
      return;
    }
    wx.showToast({ title: '正在准备分享…', icon: 'none' });
    this._createShare(s);
  },

  /**
   * 从卡片内容推断"该分享什么"——让分享按钮是语境化的，而不是固定菜单。
   * card.share 优先（后端可显式指定）；否则按卡片文案猜（月/日/流水/对账单）。
   */
  _inferShare(m) {
    const c = m.card || {};
    if (c.share) return c.share;
    const blob = [
      c.summary || '',
      (c.numbers || []).map((n) => n.label + n.value).join(''),
      (c.list || []).map((r) => r.txt || r.title || '').join(''),
      (c.points || []).join('')
    ].join(' ');
    if (/对账单|客户/.test(blob)) return { type: 2, name: '客户对账单' };
    if (/月/.test(blob)) return { type: 3, period: 'month', name: '本月报表' };
    if (/今日|今天|日/.test(blob)) return { type: 1, name: '今日汇总' };
    if (/流水|明细|笔/.test(blob)) return { type: 3, period: 'range', name: '流水对账单' };
    return { type: 3, period: 'today', name: '这份报表' };
  },

  /**
   * 生成今日小结海报（canvas 2d 画图 → 存相册）
   */
  async _generatePoster() {
    wx.showLoading({ title: '画海报中…', mask: true });
    try {
      await poster.generateAndSave({
        entityName: '我的账本',
        date: new Date().toISOString().slice(0, 10),
        income: this.data.todayStat.income,
        expense: this.data.todayStat.expense,
        net: this.data.todayStat.net,
        count: this.data.todayCount
      });
      wx.hideLoading();
      wx.showToast({ title: '✓ 已保存到相册', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },

  /**
   * 选客户分享 —— 让老板输入客户名
   */
  _promptContactShare() {
    wx.showModal({
      title: '分享给客户',
      content: '请输入客户姓名（会生成只到今日的对账单）',
      editable: true,
      placeholderText: '例如：老李',
      success: (r) => {
        if (!r.confirm) return;
        const name = String(r.content || '').trim();
        if (!name) {
          wx.showToast({ title: '客户名不能为空', icon: 'none' });
          return;
        }
        this._createShare({ type: 2, contact_name: name });
      }
    });
  },

  /**
   * 顶部"分享"按钮 —— 一键分享今日小结（type=3, period='today'）
   * 和 prototype 的 .tb-share 一致
   */
  onTapQuickShare() {
    this._createShare({ type: 3, period: 'today', name: '今日小结' });
  },

  /**
   * 调后端创建分享快照 → 成功后追加一条带「转发给微信好友」按钮的消息
   * （button open-type=share，点了直接弹好友选择器）。
   * 🔴 不再复制剪贴板 —— 老板不该手动粘贴链接。
   */
  _createShare(opts) {
    wx.showLoading({ title: '生成中…', mask: true });
    api.createShare(opts).then((r) => {
      wx.hideLoading();
      if (!r || !r.token) {
        wx.showToast({ title: '生成失败', icon: 'none' });
        return;
      }
      const shareName = opts.name || (opts.type === 2 ? '客户对账' : opts.type === 1 ? '每日汇总' : '区间报表');
      this._appendMsg({
        role: 'ai',
        text: '已生成「' + shareName + '」快照：对方点开看到的就是这份报表 —— 你之后记新账，看到的还是当时这份。有效期 7 天。',
        shareCard: { token: r.token, title: shareName }
      });
    }).catch((e) => {
      wx.hideLoading();
      wx.showToast({ title: '失败：' + (e && e.message || '网络'), icon: 'none' });
    });
  },

  /**
   * 记住 —— 问 AI"记住这个"
   * 但更自然的做法是：直接说"记住 XXX"，AI 立即入长期记忆
   * 所以这个按钮的语义是"快捷：告诉 AI 记住这张卡的内容"
   */
  onTapRemember(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.data.msgs.find((x) => x.id === id);
    if (!m) return;
    const what = m.card ? (m.card.summary || m.text) : m.text;
    // 调 memory 抽取（让 AI 自动判断归类）
    api.extractMemory({
      messages: [
        { role: 'user', content: '记住：' + what },
        { role: 'assistant', content: '好的，已记住' }
      ]
    }).then((r) => {
      if (r && r.count > 0) {
        wx.showToast({ title: '✓ 已记住' });
        // 替换原消息加徽章
        this._replaceMsg(id, { _remembered: true });
      } else {
        wx.showToast({ title: '记忆失败', icon: 'none' });
      }
    }).catch((e) => this._showTip(this._opErrTip(e, '记住失败，稍后再试')));
  },

  /**
   * 撤销一笔
   *
   * 旧版撤销后弹 ActionSheet 问"要不要撤回撤销" —— 那个交互有两个毛病：
   *   1. 弹窗挡着，老板得立刻做决定
   *   2. 30 秒的窗口期看不见还剩多久
   * 改成 H5 那版的做法：撤销后按钮上挂**倒计时角标**，
   * 卡片底下出「撤回这次撤销」，30 秒后自然消失。
   */
  onTapUndo(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.data.msgs.find((x) => x.id === id);
    if (!m || !m.undone) return;
    const undoId = m.undone;

    api.undoRecord(undoId).then((d) => {
      if (d && d.ok) {
        this._replaceMsg(id, {
          _undone: true,
          undone: null,
          _undoRecordId: undoId     // 撤回撤销要用
        });
        this._startUndoCountdown(id);
        // 记错了不用有挫败感 —— 顺手给一句（走节流，可能什么都不给）
        this._undoTone(id);
        this._loadTodayStat();
      } else {
        wx.showToast({ title: '撤销失败', icon: 'none' });
      }
    }).catch((e) => this._showTip(this._opErrTip(e, '撤销失败，稍后再试')));
  },

  /**
   * 导出 —— 两个选项都是真的：
   *   ① 复制为文本（剪贴板，可粘贴进 Excel / 微信）
   *   ② 导出表格：本地生成 CSV 文件（Excel/WPS 直接打开），微信转发出去
   *
   * 🔴 旧版是假的：弹 ActionSheet 选「导出 Excel / 导出 PDF / 复制为文本」，
   *   然后不管选哪个都往聊天里塞一句「已生成 Excel 下载链接 ✓」——
   *   实际上什么都没生成。假成功比不能导出更伤（铁律：失败如实回报）。
   *   PDF 文件要后端生成，云开发版还没接 —— 如实不提供，等接上再回来加。
   */
  onTapExport(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.data.msgs.find((x) => x.id === id);
    if (!m) return;
    const c = m.card || {};
    const hasContent = (c.numbers && c.numbers.length) || (c.list && c.list.length) || (c.points && c.points.length);
    if (!hasContent) {
      wx.showToast({ title: '这张卡没有可导出的内容', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: ['复制为文本', '导出表格（Excel 可打开）'],
      success: (r) => {
        if (r.tapIndex === 0) {
          const text = this._cardText(m);
          if (!text) { wx.showToast({ title: '没有可复制的内容', icon: 'none' }); return; }
          wx.setClipboardData({
            data: text,
            success: () => wx.showToast({ title: '已复制，可粘贴进 Excel 或微信', icon: 'none' })
          });
        } else {
          this._exportCsv(m);
        }
      }
    });
  },

  /** 卡片 → 纯文本（复制导出用） */
  _cardText(m) {
    const c = (m && m.card) || {};
    const lines = [];
    if (c.summary) lines.push('【' + c.summary + '】');
    (c.numbers || []).forEach((n) => lines.push((n.label || '') + '：' + (n.value || '')));
    (c.list || []).forEach((r) => {
      lines.push((r.txt || '') + (r.who ? '·' + r.who : '') + (r.d ? '（' + r.d + '）' : '') + ' ' + (r.amtText || ''));
    });
    (c.points || []).forEach((p) => lines.push('· ' + p));
    return lines.join('\n').trim();
  },

  /**
   * 卡片 → CSV 文件 → 微信转发。
   * CSV 带 \ufeff BOM，Excel 打开中文不乱码；字段全加引号防逗号炸列。
   */
  _exportCsv(m) {
    const c = (m && m.card) || {};
    const rows = [];
    if (c.summary) rows.push(['摘要', c.summary]);
    (c.numbers || []).forEach((n) => rows.push([n.label || '', n.value || '']));
    if (c.list && c.list.length) {
      rows.push([]);
      rows.push(['摘要', '对象', '日期', '收/支', '金额']);
      c.list.forEach((r) => {
        rows.push([
          r.txt || '',
          r.who || '',
          r.d || '',
          r.t === 'in' ? '收入' : '支出',
          String(r.amtText || '').replace(/[^0-9.\-]/g, '')
        ]);
      });
    }
    (c.points || []).forEach((p) => rows.push(['备注', p]));

    const csv = '\ufeff' + rows
      .map((r) => r.map((f) => '"' + String(f == null ? '' : f).replace(/"/g, '""') + '"').join(','))
      .join('\r\n');

    try {
      const path = wx.env.USER_DATA_PATH + '/yibang-export.csv';
      wx.getFileSystemManager().writeFileSync(path, csv, 'utf8');
      wx.shareFileMessage({
        filePath: path,
        fileName: '易帮AI-账目.csv',
        success: () => wx.showToast({ title: '表格已转发，Excel 能打开', icon: 'none' }),
        fail: (err) => {
          const msg = (err && err.errMsg) || '';
          if (!/cancel/i.test(msg)) wx.showToast({ title: '导出没完成：' + msg, icon: 'none' });
        }
      });
    } catch (err) {
      wx.showToast({ title: '生成表格失败', icon: 'none' });
    }
  },

  /**
   * AI 主动建议按钮（suggest.yes / suggest.no）
   */
  onTapSuggestYes(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.data.msgs.find((x) => x.id === id);
    if (!m || !m.suggest) return;
    // 把 suggest 的问题当作用户输入
    const q = m.suggest.q;
    // 置灰而不是直接消失 —— 让老板看得见"这条我答过了"（H5 那版的做法）
    this._replaceMsg(id, { suggestDone: true, suggest: m.suggest });
    if (q) {
      this.setData({ input: q });
      this._send();
    } else {
      this._appendMsg({ role: 'ai', text: '✓ 已记上' });
    }
  },

  onTapSuggestNo(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.data.msgs.find((x) => x.id === id);
    if (!m || !m.suggest) return;
    this._replaceMsg(id, { suggestDone: true, suggest: m.suggest });
    this._appendMsg({ role: 'ai', text: '行，不记。下次提到我再问。' });
  },

  /**
   * 客服（CS）分流 —— intent.kind === 'cs' 走这个
   * 跳微信对话开放平台
   */
  onTapCustomerService() {
    if (wx.openCustomerServiceChat) {
      wx.openCustomerServiceChat({ extInfo: {}, showChatCard: false });
    } else {
      wx.showToast({ title: '客服暂不可用', icon: 'none' });
    }
  },

  /* ═══════════════ 顶栏菜单 ═══════════════ */

  onTapMenu() {
    this.setData({ menuOpen: !this.data.menuOpen });
  },

  /**
   * 一键清屏 —— 回到开屏问候
   *
   * 保留：当前会话 ID（AI 长期记忆不断）
   * 保留：店铺信息、今天的数字
   * 清空：消息列表、撤销倒计时、所有 timer、闲置计时
   * 重新播：开屏问候 / 首次引导
   */
  _restartChat() {
    /* 🔴 confirmText 微信限制**最多 4 个字**：原来写"清空并重新开始"（7 字），
     *    showModal 直接创建失败且无 fail 兜底 —— 弹窗根本不弹，清屏点了个寂寞。 */
    wx.showModal({
      title: '重新开始？',
      content: '把当前对话清空，重新从问候开始。\n账本里的真实账目不会被删，只是聊天的内容从头来。',
      confirmText: '清空重来',
      cancelText: '再想想',
      success: (r) => {
        if (!r.confirm) return;
        /* 停所有 timer（撤销倒计时、闲置关怀） */
        this._stopAllTimers();
        /* 关掉可能开着的东西 */
        this._rtClose();
        /* 重新生成 sessionId —— "清空"应该也把后端长上下文清掉 */
        this._newSessionId();
        this.setData({
          msgs: [],
          input: '',
          sending: false,
          upOpen: false,
          rtOpen: false,
          rtConnected: false,
          rtState: 'idle',
          rtStatus: '未连接',
          rtLines: [],
          undoLeft: 0,
          canRedo: false
        });
        /* 重新播问候（首次引导会从 _initBootstrap 自己判断） */
        this._initBootstrap();
        /* 🔴 闲置关怀的 interval 刚被 _stopAllTimers 清了，得重新装表
         *    （_bumpIdle 只更新时间戳，不装 interval）—— 否则清屏后"闲置主动关怀"悄悄失效 */
        this._startIdleWatch();
        wx.showToast({ title: '已重新开始', icon: 'none' });
      }
    });
  },

  onTapMenuItem(e) {
    const action = e.currentTarget.dataset.action;
    this.setData({ menuOpen: false });
    switch (action) {
      case 'memory': wx.navigateTo({ url: '/pages/memory/memory' }); break;
      /* 🔴 2026-10-17 删「今日详情」入口（老易拍板：产品思路是对话驱动结果、自动交付，
         不做点击按键查看——详情类需求全部对话直出：今天/昨天/任意日期/月报/欠款/样表报表）。
         pages/today 页面文件保留未删，case 死分支一并清掉。 */
      case 'shop': this.onTapEntityName(); break;
      case 'team': wx.navigateTo({ url: '/pages/team/team' }); break;
      case 'plan': wx.navigateTo({ url: '/pages/plan/plan' }); break;
      case 'help': wx.navigateTo({ url: '/pages/help/help' }); break;
      case 'restart': this._restartChat(); break;
      case 'voice':
        const next = !this.data.ttsOn;
        this.setData({ ttsOn: next });
        try { wx.setStorageSync('ttsOn', next); } catch (e) {}
        wx.showToast({ title: next ? '🔊 已开启播报' : '🔇 已关闭播报' });
        break;
      case 'logout':
        wx.showModal({ title: '退出账号？', content: '清除本地缓存和录音。\n\n云端数据保留 30 天后自动清除。', success: (r) => {
          if (r.confirm) {
            try { wx.clearStorageSync(); } catch (e) {}
            wx.showToast({ title: '已退出' });
            setTimeout(() => wx.reLaunch({ url: '/pages/chat/chat' }), 800);
          }
        }});
        break;
    }
  },

  onTapTTS() {
    const next = !this.data.ttsOn;
    this.setData({ ttsOn: next });
    try { wx.setStorageSync('ttsOn', next); } catch (e) {}
    wx.showToast({ title: next ? '🔊 已开启播报' : '🔇 已关闭播报' });
  }

});

/* ── 内部工具 ── */

/**
 * 本地 mock 答复（后端不可用时降级演示）
 *
 * 触发规则（演示 AI 主动建议）：
 *   - "记一笔" / 含数字 → 返回带 suggest "记住这个供应商"
 *   - "欠" / 提到人名 → 返回带 suggest "提醒他还款"
 *   - "开店" / "水果店" / "我开" → 返回带 suggest "记住名称"
 *   - 默认 → 普通回复 + 通用 suggest
 */
/**
 * 把一句话拆成多笔账
 * "买肉125元，现金收入332元" → [{t:'out',txt:'买肉',amt:125}, {t:'in',txt:'现金收入',amt:332}]
 *
 * 规则（mock 级别，真解析在后端）：
 *   · 按标点/空白切段，每段里有「数字+元/块/毛」才算一笔
 *   · 金额：优先「数字+元/块/毛」；裸数字只在段里有收支关键词时才算（"卖水果560"），
 *     且后面不能跟量词/日期（月日年笔个号点岁斤……防"10月""3笔"被当钱）
 *   · 方向按关键词判：收入/收款/收到/进账/入账/卖/赚/收了 → 进；
 *     买/花/付/支/成本/进货/消费/掏 → 出；两边都命中时进优先（"卖了收了500"）；
 *     都不命中按支出（跟旧版口径一致）
 *   · 不抽"对象"——名字和动词分不开（"跟张姐进货"会抓成"张姐进货"），
 *     整段 cleaned 当摘要；真·对象抽取是后端 NLU 的活
 */
const _TX_KW_IN = /收入|收款|收到|进账|入账|卖|赚|收了/;
const _TX_KW_OUT = /买|花|付|支|成本|进货|消费|掏/;
const _TX_KW = /收入|收款|收到|进账|入账|卖|赚|收了|买|花|付|支|成本|进货|消费|掏/;
const _TX_AMT = /([0-9]+(?:\.[0-9]+)?)\s*(块|元|毛)?(?![0-9月日年笔个号点岁斤两瓶箱包件条次名位])/;

function _parseTxs(text) {
  const segs = String(text || '').split(/[，,。；;、！!？?\s]+/).filter(Boolean);
  const txs = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const am = seg.match(_TX_AMT);
    if (!am || !am[1]) continue;
    const amt = Number(am[1]);
    if (!(amt > 0)) continue;
    const isIn = _TX_KW_IN.test(seg);
    const isOut = _TX_KW_OUT.test(seg);
    if (!am[2] && !isIn && !isOut) continue;   // 裸数字又没收支词 → 不是钱（"最近3笔"）
    const t = (isOut && !isIn) ? 'out' : (isIn ? 'in' : 'out');
    let txt = seg.replace(/[0-9.]+/g, '').replace(/块|元|毛/g, '').trim();
    if (!txt) txt = (t === 'in') ? '收入' : '支出';
    txs.push({ t: t, txt: txt.slice(0, 10), amt: amt, who: '' });
  }
  return txs;
}



/* ═══════════════ 已知缺口：音色选择（2026-10-17 核对 H5 时记下来）═══════════════
 *
 * H5 那版菜单里有「音色」，小程序**没有**。现状是"有数据、没入口"：
 *   · utils/tts.js 里 13 个音色的白名单（VOICES）和后端 lib/tts.js 的 TTS_VOICES 是对齐的
 *   · tts.speak(text, voice) 的第二个参数**全仓库没有任何调用方传过**
 *   · 所以实际永远用 DEFAULT_VOICE，那 13 个音色等于死数据
 *
 * 为什么不这次一起做：
 *   缺的不是逻辑而是**一屏 UI**（音色列表 + 试听 + 记住选择）。这属于新增功能面，
 *   不是"修补一个承诺了却没做的事"。而且它不构成假承诺 —— 播报是能用的，只是不能换音色。
 *   做法很清楚：菜单加一项 → 弹出 VOICES 列表 → 存 wx.setStorageSync('ttsVoice')
 *   → speak 时带上它。要做的话按这个来。
 *
 * ⚠️ 同理记一笔：pages/today 曾是"有页面、没入口"，2026-10-17 补过入口，同日又删
 *    （老易拍板对话驱动结果，不做点击按键查看）。教训仍然成立 —— 判断"功能有没有做完"
 *    要看**能不能点到**，不能只看代码在不在；但方向要听产品定位的，不是把悬空页面都挂上入口。
 */

/**
 * TTS 前文本清洗：去掉 emoji、HTML 标签、多余空白。
 * 例 "✓ 已记上！金额 ¥30" → "已记上 金额 30"
 * 后端 150 字截断，所以这里不再限长
 */
/* 🔴 2026-10-16 样表学习话术检测（模块级，_send 用）。
 * 命中 = 用户接下来传的文件是样表（图/PDF/Excel），走学习通道。
 * 故意放得宽：误命中最多多走一次学习引导，漏命中则用户要重说一遍。 */
function _isLearnIntent(s) {
  return /样表|表格样式|报表模板|参照.{0,8}表|照着?.{0,8}表|按.{0,6}表.{0,4}做|学.{0,6}(格式|样表|表格)|做(一)?个?一样的表|一样的(表格|报表)/.test(String(s || ''));
}

function _stripForTts(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')            // HTML 标签
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')  // emoji
    .replace(/[✓✔✗✘]/g, '')              // 标记字符
    .replace(/[¥$€£￥]/g, '')              // 货币符号（朗读 "30 块" 比 "¥30" 自然）
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 今日净余的显示格式：正数 "+¥8.00"、负数 "-¥8.00"、0 "¥0.00"。
 * 🔴 2026-10-17：原来是 wxml 里硬编码 "+¥{{todayStat.net}}" ——
 *    亏钱时会渲染成 "+¥-8"，老板看着像程序错了。符号在这里统一算好。
 */
function _fmtNet(v) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return '¥0.00';
  return (n > 0 ? '+¥' : '-¥') + Math.abs(n).toFixed(2);
}
function round2(n) { const v = Number(n); if (!isFinite(v)) return 0; return Math.round(v * 100) / 100; }

/* 🔴 2026-10-17 G 项：去尾零金额格式化
   99 → "99"      99.9 → "99.9"    27.70 → "27.7"    1234.56 → "1,234.56"
   千分位用半角逗号（与 receipt.money 一致）。不含货币符号（调用方加）。 */
function _fmtAmtTrim(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  const a = Math.abs(v);
  const int = Math.floor(a);
  const dec = Math.round((a - int) * 100);
  /* 千分位 */
  let s = String(int);
  let out = '';
  while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
  s = s + out;
  if (dec === 0) return s;                  /* 整数去小数点 */
  /* 1 位小数（27.70 → 27.7；99.90 → 99.9）；2 位小数（如 27.75） */
  if (dec % 10 === 0) return s + '.' + (dec / 10);
  return s + '.' + (dec < 10 ? '0' + dec : String(dec));
}
function _fmtAmtFull(n) { return _fmtAmtTrim(n) + ' 元'; }
