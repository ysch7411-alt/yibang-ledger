/* utils/chat-realtime.js —— 实时对讲 + TTS 朗读（page methods）
 *
 * 2026-10-17 从 chat.js 113KB 拆出，行为完全一致。
 * module.exports 导出方法对象；chat.js 启动时 Object.assign(this, mod) 挂回 page 实例。
 * this 链不变（仍是 page 实例），setData / this.data.* / 其他 page methods 仍可用。
 *
 * 🔴 16:57 拆出后函数体内用到 tts/recorder/noiseGate —— 必须在文件内 require。
 */
const tts = require('./tts');
const recorder = require('./recorder');
const noiseGate = require('./noise-gate');
const api = require('./api');

module.exports = {
  // ===== onTapRealtime =====
  /* ═══════════════ 实时对讲 ═══════════════
   *
   * ⚠️ 说明白：完整双向语音需要 yibang-realtime 容器在线。
   *   没在线时**不能假装能聊** —— 面板照常打开，但状态栏如实写
   *   "语音通道未连通"，并给出可操作的原因（这正是 H5 那版做得好的地方：
   *   它把麦克风失败原因分成了权限拒绝/无设备/被占用/不支持四类）。
   */

  onTapRealtime: function() {
      this.setData({ upOpen: false, rtOpen: true, rtStatus: '正在连接...', rtLive: '' });
      this._rtTtsWarned = false;   // 每次开面板重置，让"语音没播出来"能再提示一次
      this._rtPush('think', '点一下下方麦克风，就可以一直聊 —— 不用每句都按键，说完我会自动接话');
      this._rtConnect();
  },
  // ===== onTapRtClose =====
  onTapRtClose: function() {
      this._rtClose();
      this._rtMuteUntil = 0;   // 关面板时清掉静音时间戳，避免下次开被残留影响
      this.setData({ rtOpen: false, rtConnected: false, rtState: 'idle', rtStatus: '未连接' });
  },
  // ===== _rtPush =====
  /**
   * 往对讲面板推一行。
   * @param {string} role 'u' | 'a' | 'think'
   * @param {string} text
   * @param {{undoId?:string}} [extra] undoId = 这一行带「撤销这笔」按钮
   */
  _rtPush: function(role, text, extra) {
      const line = { k: 'l' + Date.now() + Math.random().toString(36).slice(2, 5), role: role, text: text };
      if (extra) for (const k in extra) line[k] = extra[k];
      const lines = this.data.rtLines.concat([line]);
      /* 只留最近 40 条，别把页面撑爆 */
      const trimmed = lines.length > 40 ? lines.slice(lines.length - 40) : lines;
      /* 🔴 2026-10-17 老易 15:19：滚到底部 —— 滚到**最后一行**的 id（不是 rt-tail） */
      this.setData({ rtLines: trimmed, rtScrollTo: 'rt-line-' + line.k });
      return line;
  },
  // ===== _rtConnect =====
  _rtConnect: function() {
      try {
        const base = api._realtimeBase && api._realtimeBase();
        if (!base) {
          this.setData({ rtConnected: false, rtStatus: '语音通道未配置' });
          this._rtPush('think', '实时对讲需要先部署 yibang-realtime 容器（见 DEPLOY-RUNBOOK.md）。');
          return;
        }
        /* 复用语音管线：连上就能用，连不上就如实说 */
        const app = getApp();
        const openid = (app && app.globalData && (app.globalData.openId || app.globalData.openid)) || 'anon';
        const pipe = this._rtPipe = require('../../utils/voice-pipeline').open({
          openid: openid,
          dialect: 'mandarin',
          /* 🔴 2026-10-17 加「这是不是当前那条连接」的判断：
             面板重开/再点麦克风会新建一条管线，旧管线随后才回调 onError，
             会把新连接的「已连接」状态冲掉、显示成上一条的报错。
             回调里先确认自己还是当前这条，不是就直接不理。 */
          onReady: () => {
            if (pipe !== this._rtPipe) return;
            this.setData({ rtConnected: true, rtStatus: '已连接，直接说就行' });
          },
          onPartial: (t) => {
            if (pipe !== this._rtPipe) return;
            this.setData({ rtLive: t });   // 实时字幕：边说边上屏
          },
          onFinal: (t) => {
            if (pipe !== this._rtPipe) return;
            /* 🔴 2026-10-17 反自激第三道：TTS 答完后 2 秒内的 final 整段丢，
               只显示一句提示给老板。比对：去掉"我"|"你"等代词长度≤2 也丢（"对" "来"）。 */
            const now = Date.now();
            if ((this._rtMuteUntil || 0) > now) {
              this.setData({ rtLive: '' });
              this._rtPush('think', '我没听清，再说一遍');
              return;
            }
            const cleaned = String(t || '').replace(/[，。、！？.,!?\s]/g, '');
            if (cleaned.length <= 2) {
              this.setData({ rtLive: '' });
              return;
            }
            this.setData({ rtLive: '' });
            this._rtPush('u', t);
            this._rtAsk(t);
          },
          onError: (err) => {
            if (pipe !== this._rtPipe) return;
            this.setData({ rtConnected: false, rtState: 'idle', rtStatus: this._micErrTip(err) });
          }
        });
      } catch (e) {
        this.setData({ rtConnected: false, rtStatus: this._micErrTip(e) });
      }
  },
  // ===== _rtClose =====
  _rtClose: function() {
      /* ⚠️ voice-pipeline 的返回值是 { feed, finish, cancel } —— **没有 close()**。
       *   关面板属于"不要这句话了"，所以用 cancel()（不 commit、不留痕），
       *   而不是 finish()（那会提交给后端识别）。 */
      if (this._rtPipe) {
        try { this._rtPipe.cancel(); } catch (e) { /* 忽略 */ }
        this._rtPipe = null;
      }
      /* ⚠️ recorder 模块只导出 start()，stop/off 在**返回的控制器**上 —— 
       *   `recorder.stop()` 会 TypeError。 */
      if (this._rtRecCtrl) {
        try { this._rtRecCtrl.stop(); } catch (e) { /* 已停就别管 */ }
        try { this._rtRecCtrl.off(); } catch (e) { /* 回调摘掉 */ }
        this._rtRecCtrl = null;
      }
      /* 对讲时关面板，AI 可能还在读上一句 —— 不停的话声音会在聊天页继续播 */
      try { tts.stop(); } catch (e) { /* 没在播就别管 */ }
      if (this._rtFrameWatch) { clearTimeout(this._rtFrameWatch); this._rtFrameWatch = null; }
      this._rtRecording = false;
      this._rtBusy = false;
      this._rtQueue = [];
      this.setData({ rtLive: '' });
  },
  // ===== onTapRtMic =====
  /** 对讲里的麦克风键 —— 🔴 2026-10-16 升级为「实时对讲」：
   *  点一次 = 开麦一直听；每句话服务端自动断句（final），说完 AI 自动接话；
   *  再点一下 = 收工。上句没答完又说了下句会自动排队，不会插播/叠音。 */
  onTapRtMic: function() {
      if (this._rtRecording) {
        /* 收工：先让管线 commit（把最后半句吐完），再停录音。
         * 🔴 2026-10-17 修顺序 bug：原来先把 this._rtPipe 置 null 再 stop()，
         *   而 recorder 的 onStop 回调是**异步**来的，等它跑时
         *   `if (this._rtPipe) this._rtPipe.finish()` 已经是空的了 ——
         *   commit 永远发不出去、socket 也没人关（泄漏一条连接，
         *   再开麦又新建一条，工具里那个 closeSocket:fail task not found 就来自这种脏状态）。 */
        const pipeRef = this._rtPipe;
        this._rtPipe = null;
        if (pipeRef) { try { pipeRef.finish(); } catch (e) { /* 已经断了就别管 */ } }
        if (this._rtFrameWatch) { clearTimeout(this._rtFrameWatch); this._rtFrameWatch = null; }
        this._rtRecording = false;
        this.setData({ rtState: 'idle', rtStatus: '点麦克风继续聊' });
        if (this._rtRecCtrl) {
          try { this._rtRecCtrl.stop(); } catch (e) { /* 忽略 */ }
        }
        /* commit 之后服务端会关掉这条连接，下次点麦克风必须重开一条 */
        this.setData({ rtConnected: false, rtLive: '' });
        return;
      }
      /* 开麦。连接没就绪也不怕：管线会把分片先攒住，ready 后按序补发 */
      this._rtRecording = true;
      this._rtFrames = 0;
      this.setData({ rtState: 'listening', rtStatus: '直接说就行，不用每句按键' });
      if (this._rtPipe) { try { this._rtPipe.cancel(); } catch (e) { /* 已断就别管 */ } }
      this._rtConnect();
      this._rtRecCtrl = recorder.start({
        /* 底噪门限（移植自 H5 那版）：老板的场子有抽油烟机、有马路，
           底噪帧整帧置零再发 —— ASR 只对人声起反应，VAD 也不会被噪声拖着不断句。
           ⚠️ 是"置零"不是"不发"：跳帧会让服务端 VAD 以为你说完了而提前切段。 */
        onFrame: (frame) => {
          this._rtFrames = (this._rtFrames || 0) + 1;
          if (this._rtFrameWatch) { clearTimeout(this._rtFrameWatch); this._rtFrameWatch = null; }
          /* 🔴🔴 2026-10-17 三重防自激（老易 12:47 截图铁证：
           *   "买菜586→AI 答本月盈利→对/比较/来/对/本月盈利" 无限循环。
           *   根因：TTS 异步、状态字段竞争、ASR 端在 TTS 期间仍识别扬声器外放）。
           *   ① rtState='speaking' 时返回（捂住耳朵，原有）
           *   ② rtMuteUntil > now() 时返回（看门狗：TTS 启动后强制闭麦 6 秒，
           *      即使 speaking 状态被异步清掉也拦得住）
           *   ③ rtLastAiAt 1000ms 内识别到的内容**整段丢弃**（AI 刚答完 + 麦还热的窗口）
           *     命中后只显示一句「我没听清，再说一遍」给老板。 */
          const now = Date.now();
          if (this.data.rtState === 'speaking') return;
          if ((this._rtMuteUntil || 0) > now) return;
          if (this._rtPipe) this._rtPipe.feed(noiseGate.apply(frame).buf);
        },
        onStop: () => { if (this._rtPipe) this._rtPipe.finish(); },
        onError: (err) => {
          this._rtRecording = false;
          this.setData({ rtState: 'idle', rtStatus: this._micErrTip(err) });
        }
      });

      /* 🔴 2026-10-17 新增「帧看门狗」。
         背景：微信的 onFrameRecorded 要靠 start() 时传 frameSize 才触发，
         而且**早期基础库只支持 mp3 格式**（后来才加 pcm），不同机型/版本行为不一致。
         一旦这台设备上帧回调不触发：录音在录、连接是好的、界面一切正常，
         但**一帧音频都发不出去** —— 老板说什么都没反应，还看不出哪里错。
         服务端日志里就表现为 closed (partial_count=0, audio=0B, frames=0)。
         2.5 秒还没拿到第一帧，就如实告诉老板，并指回普通语音输入。 */
      if (this._rtFrameWatch) clearTimeout(this._rtFrameWatch);
      this._rtFrameWatch = setTimeout(() => {
        this._rtFrameWatch = null;
        if (!this._rtRecording || this._rtFrames > 0) return;
        this.setData({ rtStatus: '这台手机拿不到录音帧（微信限制）—— 先关掉面板，用普通麦克风说' });
      }, 2500);
  },
  // ===== _rtAsk =====
  /** 对讲里问一句 → 复用同一套 AI + 确认卡，并把回答**读出来**。
   *  🔴 2026-10-16 对讲版：连续聊的时候老板可能一口气说两句，
   *  上一轮还没答完就先排队，答完（含朗读完）自动接下一问 —— 不然回答会交叉插播。 */
  _rtAsk: function(q) {
      if (this._rtBusy) { this._rtQueue = (this._rtQueue || []).concat([q]); return; }
      this._rtBusy = true;
      api.chat(q, 'bookkeeper', { withTTS: false, sessionId: this._sessionId })
        .then((d) => {
          const answer = (d && d.answer) || '(没有回复)';
          this._rtPush('a', answer);

          /* 回答要读出来 —— 面板开场白承诺了"AI 会语音回复你"，
           * 老板在对讲时是听，不是看屏。读不出来必须如实说，不能静默。 */
          const spoken = this._rtSpeak(answer).catch(() => { /* TTS 失败已在面板提示过，不挡队列 */ });

          /* 🔴 /api/chat 在 kind=account 时已经把账写进去了，card 里带的是 undo。
           *   写操作必须能撤销：给撤销入口 + 刷新顶部数字。 */
          const undoIds = (d && d.card && d.card.undo) || [];
          if (undoIds.length) {
            this._rtPush('think', '这笔已经记上了（语音直接入账）—— 记错了点下面撤销', { undoId: undoIds[0] });
            this._loadTodayStat();   // 顶部"今日净余"要跟着变，否则还是旧数字
          }
          return spoken;
        })
        .then(() => {
          this._rtBusy = false;
          if (this._rtRecording) this.setData({ rtState: 'listening', rtStatus: '继续说' });
          const next = (this._rtQueue || []).shift();
          if (next) this._rtAsk(next);
        })
        .catch((e) => {
          /* 🔴 2026-10-17 三处修复（老易 11:17 语音实测"三橙一灰"）：
           * ① 旧代码 catch 里**不取队列** → 第一句失败后，后面句子永远卡在
           *    _rtQueue 不再处理 —— "买肉48"根本没发出去 = 真丢账。
           * ② 超时 ≠ 没记上：查库证实 id=25"买菜38"后端 21ms 就入账了，
           *    只是回应没传回来（半开连接，和上午图片 129s 同款）。
           *    所以 watchdog 失败后先查最近几笔给老板核对，绝不自动重发
           *    （自动重发会把已入的账记两遍）。
           * ③ 话术按错误类型分：401 / 看门狗 / 断网，不再一律"云端暂时没连上"。 */
          this._rtBusy = false;
          if (this._rtRecording) this.setData({ rtState: 'listening', rtStatus: '继续说' });
          let tip;
          if (e && e.code === 401) tip = '登录过期了 —— 退出小程序重新进一次，再继续说。';
          else if (e && e.watchdog) tip = '回应没传回来（这句很可能已经记上了）。我看一下最近几笔——';
          else if (e && e.netFail) tip = '网络断了一下，这句先不算，信号好了再说一遍。';
          else tip = '这句没处理成（' + ((e && e.message) || '未知错误') + '），再说一遍试试。';
          this._rtPush('a', tip);
          if (e && e.watchdog) {
            api.recent().then((d) => {
              const rows = (d && d.rows) || [];
              if (!rows.length) {
                this._rtPush('a', '核对结果：账上最近没有记录，这句没记上 —— 信号好了再说一遍。');
                return;
              }
              const m = /(\d+(?:\.\d+)?)/.exec(q);
              const amt = m ? Number(m[1]) : null;
              const hit = amt != null && rows.some((r) => Number(r.amount) === amt);
              const lines = rows.map((r) => (Number(r.type) === 1 ? '+' : '-') + r.amount +
                ' ' + String(r.content || '').slice(0, 12)).join('；');
              this._rtPush('a', hit
                ? '核对好了：这句已经记上了（回应被网络弄丢而已）。最近几笔：' + lines
                : '最近几笔里没看到这笔（' + lines + '），应该没记上 —— 信号好了再说一遍。');
            }).catch(() => {
              this._rtPush('a', '核对也没查出来（网络还是不通）—— 信号好了再说一遍，我先不自动补，免得记重。');
            });
          }
          const next = (this._rtQueue || []).shift();
          if (next) this._rtAsk(next);
        });
  },
  // ===== onTapRtUndo =====
  /**
   * 对讲面板里撤销一笔。
   *
   * ⚠️ 后端撤销缓存 TTL 只有 30 秒 —— 超时不是"失败"而是"来不及了"，
   *    两者要对用户说清楚（见 act_undo_delete 的 not_found_in_cache）。
   */
  onTapRtUndo: function(e) {
      const k = e.currentTarget.dataset.k;
      const id = e.currentTarget.dataset.id;
      if (!id) return;

      api.undoRecord(id).then((d) => {
        this._rtPatchLine(k, { undoId: '', text: '已撤销这笔' });
        this._loadTodayStat();
        wx.showToast({ title: '已撤销', icon: 'none' });
      }).catch((err) => {
        const msg = (err && err.message) || '';
        /* 缓存过期会回 not_found_in_cache 之类的原话 —— 照实说，别统一成"网络异常" */
        this._rtPatchLine(k, {
          undoId: '',
          text: /cache|not_found|不存在|过期/.test(msg)
            ? '撤销来不及了（只有 30 秒）—— 到对话页手动改吧'
            : '撤销没成功：' + (this._opErrTip(err, '稍后再试'))
        });
      });
  },
  // ===== _rtSpeak =====
  /** 把 AI 的回答读出来（对讲面板用）。返回 Promise：读完才resolve ——
   *  _rtAsk 靠它在朗读期间挂住队列，也靠它让 rtState='speaking' 捂住麦克风。
   *  失败只提示一次，不刷屏。
   *
   *  🔴 2026-10-17 强化：除设 rtState='speaking' 外，还设
   *  _rtMuteUntil = now + 朗读耗时+缓冲（≥8s）——防止 TTS 异步结束、
   *  状态字段被清后，麦克风"立刻"又开始收 TTS 扬声器的尾巴残声，
   *  把 AI 自己的回答再次识别成下一句输入。 */
  _rtSpeak: function(text) {
      const t = _stripForTts(text);
      if (!t) return Promise.resolve();
      this.setData({ rtState: 'speaking', rtStatus: 'AI 在答……答完你接着说' });
      this._rtMuteUntil = Date.now() + Math.max(8000, t.length * 250);
      return tts.speak(t).then(() => {
        /* TTS 实际播放可能比估算短，再延 1.5s 收尾（扬声器衰减/回声尾巴）*/
        this._rtMuteUntil = Date.now() + 1500;
        if (this.data.rtState === 'speaking') this.setData({ rtState: 'idle' });
      }).catch((e) => {
        this._rtMuteUntil = Date.now() + 1500;
        if (this.data.rtState === 'speaking') this.setData({ rtState: 'idle' });
        if (!this._rtTtsWarned) {
          this._rtTtsWarned = true;
          this._rtPush('think', '语音没播出来（' + ((e && e.message) || 'TTS 未接入') + '）—— 上面那条是文字版');
        }
        throw e;   // 抛给调用方，朗读失败不该假装"说完了"
      });
  },
};
