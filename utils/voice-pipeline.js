/**
 * utils/voice-pipeline.js —— 实时语音识别（客户端）
 *
 * 2026-10-09。腾讯云开发版。
 *
 * ── 它和「录完再上传」的区别 ──
 *   旧：说完 → 上传录音 → /api/asr → 出字。中间 2~4 秒是黑屏，
 *       老板看到的就是「正在听写…」。
 *   新：边说 → 边把音频分片发出去 → 服务端流式识别 → 字幕一个一个蹦出来，
 *       说完约 0.3 秒拿到最终文字。体验像真人听见一样。
 *
 * ── 协议（小程序 ↔ yibang-realtime）──
 *   C→S {type:'start',    openid, dialect?}
 *   S→C {type:'ready'}
 *   C→S {type:'audio',    b64}      // 32ms 一片 PCM 16k mono
 *   S→C {type:'partial',  text}     // 流式中间结果（可多次）
 *   S→C {type:'final',    text}     // 定稿（commit 触发）
 *   C→S {type:'commit'}             // 松手定稿
 *   S→C {type:'done',     text}     // 真正结束
 *   C→S {type:'cancel'}             // 划出取消
 *   S→C {type:'fail',     msg}      // 失败
 *
 * ── 为什么走自己的 yibang-realtime，不直连腾讯云 ──
 *   ① 微信只允许连「socket 合法域名」白名单里的域名，腾讯云 ASR 网关加不进去；
 *   ② 真机上 wx.connectSocket **带不了自定义请求头**，鉴权信息传不出去；
 *   ③ 网关密钥绝不能下发到客户端。
 *
 * ── 踩过的坑（2026-10-09 抄易帮930版/utils/realtime.js 时验过）──
 *   · 握手未就绪先攒分片 —— socket 握手 ~150ms、录音分片 32ms 一片就来了，
 *     不攒会丢开头那几片，转写结果就是"买菜花了五十"（把"昨天"吃了）。
 *   · 连续失败 2 次自动降级 —— 流式连不上不能瘫痪整个录入路径，
 *     退到「录完上传」的老路，老板至少还能记账。
 *   · 6 秒兜底 —— 正常 0.3 秒定稿；超过 6 秒强制返回已有文字，
 *     不让页面干等。
 *
 * ── 模块边界（刻意只做一件事）──
 *   本模块**只管那条 WebSocket**，不碰录音机。
 *   录音的所有权在调用方（页面），本模块只接收 page 递过来的分片。
 *   这样不与已验通的录音链路产生耦合。
 *
 * ── 用法 ──
 *   const pipe = require('../../utils/voice-pipeline');
 *   const session = pipe.open({
 *     openid, dialect: 'mandarin',
 *     onPartial: (t) => this.setData({ liveText: t }),
 *     onFinal:   (t) => this.setData({ finalText: t }),
 *     onError:   (e) => console.error(e)
 *   });
 *   // ... 录音中
 *   session.feed(frameBuffer);
 *   // ... 松手
 *   const text = await session.finish();
 */
const api = require('./api');

const MAX_FAILURES = 2;       // 连续失败 2 次后本会话内不再尝试实时通道
const MAX_WAIT_MS = 6000;     // 松手后等最终结果的兜底时长（正常约 0.3 秒）
const OPEN_TIMEOUT_MS = 8000; // 连接超时（🔴 2026-10-17 由 4s 放宽到 8s：
                              // 手机上弱网握手常要 2~4 秒，4 秒会误报「连接超时」，
                              // 而这时其实马上就要 ready 了。握手期间的分片会攒在
                              // queue 里（上限 200 帧 ≈ 6.4 秒），不丢音频。
const MAX_QUEUE = 200;        // 握手就绪前攒下的分片数上限

/* 🔴 模块级失败计数：连续失败到阈值就**本会话内**退回「录完上传」的老路。
   理由：这个能力是锦上添花，不能因为它连不上就让老板记不了账。
   用「连续失败计数」而不是写死的开关，是让它自己好起来之后能自动恢复。 */
let _failures = 0;

function _b64Of(buf) {
  let b64 = '';
  try { b64 = wx.arrayBufferToBase64(buf); } catch (e) { return ''; }
  return b64;
}

/** 实时通道现在能不能用 */
function available() {
  if (typeof wx.connectSocket !== 'function') return false;
  if (_failures >= MAX_FAILURES) return false;
  return true;
}

/**
 * 开一条实时识别会话。
 *
 * @param {{openid:string, dialect?:string, onPartial?:function, onFinal?:function, onReady?:function, onError?:function}} handlers
 * @returns {{
 *   feed: function(ArrayBuffer): void,
 *   finish: function(): Promise<string>,
 *   cancel: function(): void
 * }}
 */
function open(handlers) {
  const h = handlers || {};
  let closed = false;
  let ready = false;
  let final = '';
  let errMsg = '';
  let doneResolve = null;
  const queue = [];   // 握手就绪前攒下的分片（顺序不能乱）

  // ── 解析 yibang-realtime 的 WebSocket URL ──
  //    CloudBase 云托管给的不是普通域名，是 service 的内网地址；
  //    这里通过 callContainer 的 base 反推 wss 域，让小程序 socket 合法。
  const base = api._realtimeBase();
  const url = base + '?openid=' + encodeURIComponent(String(h.openid || '')) +
              (h.dialect ? '&dialect=' + encodeURIComponent(h.dialect) : '');

  let task = null;
  /* 🔴 2026-10-17 加 needClose：只有「真的还开着」才允许主动关。
     此前 teardown/cancel 都会无脑 task.close()，对一条已经关掉的连接再关一次，
     微信会抛 closeSocket:fail task not found —— 而且是**异步冒到全局**的
     appServiceSDKScriptError，本地 try/catch 根本接不住（老易工具 Console 里那两条）。
     现在：onOpen 才置 true，onClose/onError 立刻置 false；close 时带上 fail 回调兜住。 */
  let needClose = false;
  try {
    task = wx.connectSocket({
      url,
      tcpNoDelay: true,
      // 一条连接对应一次录音，不需要复用
    });
  } catch (e) {
    errMsg = '连接没建起来';
  }

  const closeTask = () => {
    if (!task || !needClose) return;
    needClose = false;
    try {
      task.close({
        code: 1000,
        success: () => {},
        fail: () => {}    // 已经关了/找不到就静默 —— 不让它变成全局错误
      });
    } catch (e) { /* 同步抛也吞掉 */ }
  };

  const teardown = () => {
    closed = true;
    closeTask();
  };

  const settle = () => {
    if (doneResolve) { const r = doneResolve; doneResolve = null; r(); }
  };

  if (!task) {
    settle();
  } else {
    task.onOpen(() => {
      needClose = true;      // 到这一步才「真的开着」，之后才允许主动关
      // 🔴 2026-10-16 修复「正在连接...」永远卡住：协议要求连上后先发 start，
      //    服务端收到 start（带 openid）才回 ready —— 以前这里什么都没发，
      //    服务端干等 start、客户端干等 ready，死锁，4 秒超时也没人告诉页面。
      try {
        task.send({ data: JSON.stringify({
          type: 'start',
          openid: String(h.openid || 'anon'),
          dialect: h.dialect || 'mandarin'
        }) });
      } catch (e) { /* 发不出去就等 onError 兜底 */ }
    });
    task.onMessage((res) => {
      if (closed) return;
      let msg = null;
      try { msg = JSON.parse(res.data); } catch (e) { return; }
      if (!msg) return;

      if (msg.type === 'ready') {
        ready = true;
        // 补发握手期间攒下的分片（顺序不能乱，否则转写会串词）
        while (queue.length) {
          const b64 = queue.shift();
          try { task.send({ data: JSON.stringify({ type: 'audio', audio: b64 }) }); }
          catch (e) { /* 丢一片不致命 */ }
        }
        if (h.onReady) h.onReady();
      } else if (msg.type === 'partial') {
        if (typeof msg.text === 'string') {
          final = msg.text; // partial 是不断刷新的「目前认为最准」版本
          if (h.onPartial) h.onPartial(msg.text);
        }
      } else if (msg.type === 'final') {
        if (typeof msg.text === 'string') {
          final = msg.text;
          if (h.onFinal) h.onFinal(msg.text);
        }
      } else if (msg.type === 'done') {
        // 服务端真正收尾；finish() 的 Promise 就解在这里
        if (typeof msg.text === 'string' && msg.text) final = msg.text;
        settle();
      } else if (msg.type === 'fail' || msg.type === 'error') {
        errMsg = msg.msg || '识别失败';
        _failures += 1;
        notifyErr();
        settle();
      }
    });
    task.onError((e) => {
      needClose = false;     // 出错时连接多半已经没了，别再主动关（会报 task not found）
      errMsg = (e && e.errMsg) || '连接断了';
      _failures += 1;
      notifyErr();
      settle();
    });
    task.onClose(() => {
      needClose = false;     // 对端已经关了，本地不能再关一次
      if (!closed) _failures += 1;
      /* 连都没连上就断了（合法域名没配、网络拒连），必须告诉页面，
         否则面板永远停在「正在连接...」 */
      if (!ready) notifyErr();
      settle();
    });
  }

  /* 🔴 2026-10-16 补：以前 h.onError 定义了却**从来没人调用**，
     连接失败/超时后页面状态栏就永远卡在「正在连接...」。
     只通知一次（onError 和 onClose 可能接连触发，别让页面弹两遍）。 */
  let errNotified = false;
  function notifyErr() {
    if (errNotified || closed) return;
    errNotified = true;
    if (h.onError) { try { h.onError(new Error(errMsg || '连接失败')); } catch (e) {} }
  }

  // 连接超时兜底：后端 ready 迟迟不来（网络慢、鉴权被拒）也不能让页面干等
  const openTimer = setTimeout(() => {
    if (!ready && !closed) { errMsg = errMsg || '连接超时'; notifyErr(); settle(); }
  }, OPEN_TIMEOUT_MS);

  return {
    /** 喂一片录音数据（页面在 onFrameRecorded 里调） */
    feed(buf) {
      if (closed || !buf) return;
      const b64 = _b64Of(buf);
      if (!b64) return;
      if (!ready) {
        if (queue.length < MAX_QUEUE) queue.push(b64);
        return;
      }
      try { task.send({ data: JSON.stringify({ type: 'audio', audio: b64 }) }); }
      catch (e) { /* 单帧丢了不影响整句，不打断 */ }
    },

    /**
     * 松手：告诉后端"说完了"，等最终结果。
     * @returns {Promise<string>} 拿到返回文本；拿不到返回 ''
     */
    finish() {
      if (closed) return Promise.resolve(final || '');
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(waitTimer);
          clearTimeout(openTimer);
          const out = final || '';
          teardown();
          resolve(out);
        };
        doneResolve = done;
        // 兜底：6 秒还没拿到就强制返回已有 partial
        const waitTimer = setTimeout(done, MAX_WAIT_MS);
        try { task.send({ data: JSON.stringify({ type: 'commit' }) }); }
        catch (e) { done(); }
      });
    },

    /** 划出取消：不 commit、不留痕 */
    cancel() {
      clearTimeout(openTimer);
      if (closed) return;
      try { task.send({ data: JSON.stringify({ type: 'cancel' }) }); } catch (e) {}
      closed = true;
      closeTask();
    }
  };
}

module.exports = { open, available };
