/* utils/chat-intake.js —— 上传/OCR/确认卡（page methods）
 *
 * 2026-10-17 从 chat.js 113KB 拆出，行为完全一致。
 * module.exports 导出方法对象；chat.js 启动时 Object.assign(this, mod) 挂回 page 实例。
 * this 链不变（仍是 page 实例），setData / this.data.* / 其他 page methods 仍可用。
 *
 * 🔴 16:57 老易真机发现 ReferenceError: intake is not defined —— 拆文件时漏了 require intake 模块。
 * 这里 require 后函数内才能用 intake.KIND.IMAGE 等常量。
 */
const intake = require('./upload-intake');
const receipt = require('./receipt-flow');
const api = require('./api');

module.exports = {
  // ===== onTapPlus =====
  /* ═══════════════ 上传入口（拍照 / 相册 / 文件）═══════════════
   *
   * ── 为什么这块是重头 ──
   *   小老板真实的工作流是"扔一张小票/一张账单截图给我"，
   *   而不是打字。所以入口要短、要一眼看懂、要能批量。
   *
   * ── ⚠️ 关于"粘贴" ──
   *   小程序**没有全局 paste 事件**（input / textarea 都没有 bindpaste）。
   *   所以这一项不做假功能，只提示用户直接贴到输入框 —— 输入框原生支持长按粘贴。
   */

  /** 点 ＋：开合上传面板 */
  onTapPlus: function() {
      this.setData({ upOpen: !this.data.upOpen });
      this._bumpIdle();
  },
  // ===== onTapUpload =====
  /** 点上传面板里的一项 */
  onTapUpload: function(e) {
      const up = e.currentTarget.dataset.up;
      this.setData({ upOpen: false });

      if (up === 'cam') return this._chooseImage('camera');
      if (up === 'img') return this._chooseImage('album');
      if (up === 'file') return this._chooseMessageFile();

      /* paste：小程序没有全局粘贴事件，如实告知，不假装 */
      wx.showModal({
        title: '粘贴',
        content: '小程序没有全局粘贴入口。\n直接长按输入框粘贴就行 —— 图片会进相册，文字我会自动认。',
        showCancel: false,
        confirmText: '知道了'
      });
  },
  // ===== _intake =====
  /**
   * 一条上传进流程：
   *   ① 用户气泡（带缩略图）② 三步进度 ③ 待确认卡（**确认才入账**）
   * @param {object} item 归一化后的上传项
   * @param {function} [done] 这条处理完（确认卡出现 / 失败卡出现在）回调，
   *                           用于多选串行队列：一张结束再跑下一张。
   */
  _intake: function(item, done) {
      this._bumpIdle();

      /* ① 用户气泡 */
      const isImg = item.kind === intake.KIND.IMAGE && item.path;
      this._appendMsg({
        role: 'user',
        text: item.name,
        thumb: isImg ? item.path : '',
        fileKind: isImg ? '' : item.kind,
        meta: { title: item.name, sub: item.sub }
      });

      /* 🔴 2026-10-16 样表学习分流：用户刚说过「参照这个表格做表」类话术，
         紧跟着传的文件是**样表**（图/PDF/Excel），走学习通道而不是记账解析。
         挂起有效期 10 分钟，过期恢复普通记账解析。 */
      if (this._pendingLearn && Date.now() - (this._pendingLearnAt || 0) < 10 * 60 * 1000) {
        this._pendingLearn = false;
        if (done) done();
        return this._learnFromSample(item);
      }

      /* ② 三步进度 */
      const msg = this._appendMsg({
        role: 'ai',
        text: '',
        steps: receipt.buildSteps(intake.step0Text(item.kind)),
        card: null,
        suggest: null,
        _intakeItem: item
      });

      this._runIntake(msg.id, item, 0, done);
  },
  // ===== _runIntake =====
  /**
   * 推进解析进度，走完就换成待确认卡。
   *
   * 来路说明（避免以后误以为"已经在用真 OCR"）：
   *   · 图片(IMAGE) → 真 OCR：进度跑完后 _showConfirmCard 走 _showOcrConfirm
   *     调后端 /api/parse-receipt（qwen-vl 抽条+解析），再人审确认入账。
   *   · 表格/PDF/文本 → 仍用本地演示样本（_parseSample），因这些格式的后端
   *     解析端点未接；等接上再把这里换成真实返回即可。
   */
  _runIntake: function(msgId, item, step, done) {
      const STEPS = 3;
      if (step >= STEPS) return this._showConfirmCard(msgId, item, done);

      setTimeout(() => {
        const m = this.data.msgs.find((x) => x.id === msgId);
        if (!m || !m.steps) {
          /* 消息被撤了/页面走了 —— 必须解队列，否则后面所有上传都死锁 */
          if (done) done();
          return;
        }
        const r = receipt.advance(m.steps);
        this._replaceMsg(msgId, { steps: r.steps });
        if (r.allDone) this._showConfirmCard(msgId, item, done);   /* 🔴 老易 13:08 实测：
           原代码 _showConfirmCard(msgId, item) 没传 done → 看门狗触发后队列不前进，
           再传图直接死锁。这里必须把 done 透传到底。 */
        else this._runIntake(msgId, item, step + 1, done);
      }, 620);
  },
  // ===== _showConfirmCard =====
  /**
   * 把进度换成"待您确认"卡。
   * 图片 → 走真 OCR（qwen-vl 结构化抽条，see _showOcrConfirm）；
   * 表格/PDF/文本 → 仍用本地演示样本（这些格式的后端解析端点未接，保持原样）。
   */
  _showConfirmCard: function(msgId, item, done) {
      if (item.kind === intake.KIND.IMAGE) {
        return this._showOcrConfirm(msgId, item, done);
      }
      const sample = this._parseSample(item);
      this._renderConfirm(msgId, sample.rows, sample.note);
      if (done) done();
  },
  // ===== _showOcrConfirm =====
  /**
   * 图片走真 OCR：
   *   读文件 → 后端 /api/parse-receipt（qwen3-vl-plus 抽 JSON + 解析）→ 渲染确认卡。
   *   若后端同时读出页面「合计」，则与识别出的行之和**对账**：
   *   对不上（手写掉零/漏行导致）就在确认卡上显式提醒老板逐笔核对 —— 这是准确率的兜底闸门。
   *   失败如实说（模糊/格式不对/网络断），不假装识别成功。
   */
  _showOcrConfirm: function(msgId, item, done) {
      const self = this;
      const t0 = Date.now();

      /* 🔴 2026-10-17 加秒表：服务端跑视觉大模型（qwen3-vl-plus）抽整页手写要十几秒，
         这十几秒里进度卡如果一动不动，老板会以为小程序死了 —— 老易真机原话
         「刚上传的图片一直还没识别出来」，截图上就是卡在三步进度不动的样子。
         现在第三步边跑边报秒数，等待可见；失败也必给原因，绝不留死卡。 */
      let tick = null;
      const stopTick = () => { if (tick) { clearInterval(tick); tick = null; } };
      const tickOnce = () => {
        const m = self.data.msgs.find((x) => x.id === msgId);
        if (!m || !m.steps) return stopTick();
        const n = m.steps.length;
        const sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
        const steps = m.steps.map((s, i) => ({
          icon: s.icon,
          state: i < n - 1 ? 'done' : 'run',
          text: i < n - 1
            ? s.text
            : '识别与归类中 · 已等 ' + sec + ' 秒' + (sec >= 25 ? '（网络偏慢，再等等）' : '')
        }));
        self._replaceMsg(msgId, { steps: steps });
      };

      const fsm = wx.getFileSystemManager();
      fsm.readFile({
        filePath: item.path,
        encoding: 'base64',
        success: (res) => {
          tick = setInterval(tickOnce, 1000);
          tickOnce();
          api.parseReceipt({ mime: item.mime || '', filename: item.name || '', dataBase64: res.data })
            .then((d) => {
              stopTick();
              const rows = (d && d.rows) || [];
              const totals = (d && d.totals) || null;
              const rawText = (d && (d.raw || d.text)) || '';   // 🔴 C 项：OCR 原文，前端校验 txt 是否真在原文里（防 AI 编内容）
              let note = rows.length ? ('小票识别 ' + rows.length + ' 笔') : '这张图没认出可入账的内容';

              /* 与页面合计对账 */
              if (rows.length && totals && (totals.in_total || totals.out_total)) {
                const s = receipt.summarize(rows);
                const warn = [];
                if (totals.out_total && Math.abs(s.outSum - totals.out_total) > 0.01) {
                  warn.push('支出 页面' + receipt.money(totals.out_total) + ' vs 识别' + receipt.money(s.outSum));
                }
                if (totals.in_total && Math.abs(s.inSum - totals.in_total) > 0.01) {
                  warn.push('收入 页面' + receipt.money(totals.in_total) + ' vs 识别' + receipt.money(s.inSum));
                }
                if (warn.length) {
                  note += '；⚠️ 与页面合计对不上（' + warn.join('；') + '），请逐笔核对';
                }
              }
              this._renderConfirm(msgId, rows, note, { rawText: rawText });
              if (done) done();
            })
            .catch((e) => {
              stopTick();
              if (done) done();
              const why = (e && (e.hint || e.message)) || '识别失败';
              /* 三种失败嘴脸不一样，说的话也得不一样，别拿一句"识别失败"糊掉：
                 watchdog = 服务端可能算完了但结果没回程（切网/断网/语音或视频通话抢带宽）；
                 netFail  = 压根没连上；
                 其它     = 服务端明确回了错（图片太小/格式不认/模型没返回）。 */
              let advice;
              if (e && e.watchdog) {
                advice = '\n服务端很可能已经把这张图认完了，只是结果没传回来（中途掉线）。' +
                  '关掉语音通话（或语音/视频通话）、换个网（Wi-Fi↔流量）再发一次这张图，通常一次就成。';
              } else if (e && e.netFail) {
                advice = '\n网络没走通，等信号好点再发一次，或换个 Wi-Fi。';
              } else {
                advice = '\n可以重发清晰的图（正对票面·光线足·整页入框），或直接把账目说给我听。';
              }
              this._replaceMsg(msgId, {
                steps: null,
                text: '',
                card: { summary: '这张图没识别出来：' + why + advice, numbers: [], points: [] }
              });
            });
        },
        fail: () => {
          stopTick();
          if (done) done();
          this._replaceMsg(msgId, {
            steps: null,
            text: '',
            card: { summary: '文件读取失败，再发一次试试。', numbers: [], points: [] }
          });
        }
      });
  },
  // ===== _maybePreshare =====
  /**
   * 卡片消息入列后后台预生成快照（静默，失败不吭声）。
   * 就绪后 WXML 会把「分享」从 view 换成原生转发 button。
   * 对账单（type=2）要选客户名，不预生成 —— 点击时走输入流程。
   */
  _maybePreshare: function(aiMsg) {
      const m = aiMsg;
      if (!m || !m.card) return;
      if (!(m.card.numbers || m.card.list || m.card.points)) return;
      const s = this._inferShare(m);
      if (s.type === 2) return;
      api.createShare(s).then((r) => {
        if (!r || !r.token) return;
        const cur = this.data.msgs.find((x) => x.id === m.id);
        if (!cur || cur.shareToken) return;
        this._replaceMsg(m.id, { shareToken: r.token, shareName: s.name });
      }).catch(() => { /* 真点分享时还有兜底流程 */ });
  },
};
