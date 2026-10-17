/**
 * utils/recorder.js —— 录音机封装
 *
 * 2026-10-09。腾讯云开发版。
 *
 * ── 为什么单独一个文件 ──
 *   录音机在 wx 下是全局单例 `wx.getRecorderManager()`，
 *   但 `onStop` / `onFrameRecorded` 这些回调**后注册会覆盖先注册的**
 *   （2026-09-22 易帮930版真机就因为这个栽过：在记账页录音、却触发了参谋页的 onStop）。
 *
 *   解法：把回调做成**回调数组**——所有页面都注册自己的处理函数，
 *   `onStop` 触发时依次调一遍，谁跟谁都不冲突。
 *
 * ── 用法 ──
 *   const rec = require('../../utils/recorder');
 *   const ctrl = rec.start({
 *     onFrame: (frameBuffer) => pipe.feed(frameBuffer),
 *     onStop:  (fullPath, duration, fileSize) => { ... },
 *     onError: (e) => { ... }
 *   });
 *   // ... 用户松手或页面要停
 *   ctrl.stop();
 *
 * ── 录音参数 ──
 *   sampleRate: 16000    - 腾讯云 ASR 流式需要 16k PCM
 *   numberOfChannels: 1 - 单声道
 *   encodeBitRate: 48000 - 16k * 16bit / 8 = 32000，加点余量取 48k
 *   format: 'PCM'       - 裸 PCM，体积最小、ASR 最准
 *   frameSize: 1        - 16k 下 32ms 一帧 = 512 samples ≈ 1KB
 */
const FRAME_SIZE = 1;          // KB / 帧，约 32ms @ 16k
const MAX_DURATION = 60;       // 秒，超时自动停 —— 防止老板忘了松手

const _stopCbs = [];
const _frameCbs = [];
const _errorCbs = [];

let _manager = null;
let _active = false;

/** 单例获取录音管理器（懒初始化） */
function _mgr() {
  if (_manager) return _manager;
  _manager = wx.getRecorderManager();
  _manager.onStop((res) => {
    _active = false;
    // 依次调用所有回调；某个回调抛错不能让后面的不执行
    _stopCbs.slice().forEach((fn) => {
      try { fn(res && res.tempFilePath, res && res.duration, res && res.fileSize); }
      catch (e) { /* 单个回调挂掉不影响其他 */ }
    });
  });
  _manager.onFrameRecorded((res) => {
    // 🔴 流式 ASR 的核心数据源 —— 每 32ms 推一片
    const buf = res && res.frameBuffer;
    if (!buf) return;
    _frameCbs.slice().forEach((fn) => {
      try { fn(buf); } catch (e) { /* 同上 */ }
    });
  });
  _manager.onError((e) => {
    _active = false;
    _errorCbs.slice().forEach((fn) => {
      try { fn(e); } catch (e) {}
    });
  });
  return _manager;
}

/**
 * 开始录音。
 *
 * @param {{
 *   onFrame?: function(ArrayBuffer): void,
 *   onStop?: function(string, number, number): void,
 *   onError?: function(Error): void
 * }} handlers
 * @returns {{ stop: function(): void, off: function(): void }}
 */
function start(handlers) {
  const h = handlers || {};
  const mgr = _mgr();

  // 注册回调（**追加，不覆盖**）—— 解决易帮930版的"后注册覆盖"问题
  if (h.onFrame) _frameCbs.push(h.onFrame);
  if (h.onStop)  _stopCbs.push(h.onStop);
  if (h.onError) _errorCbs.push(h.onError);

  // 如果已经在录，不重复 start —— 避免 wx.startRecord 报"already recording"
  if (!_active) {
    _active = true;
    try {
      mgr.start({
        duration: MAX_DURATION * 1000,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'PCM',
        frameSize: FRAME_SIZE
      });
    } catch (e) {
      _active = false;
      if (h.onError) h.onError(e);
    }
  }

  // 解绑函数：页面卸载时调，确保回调不泄露
  const myFrameIdx = h.onFrame ? _frameCbs.lastIndexOf(h.onFrame) : -1;
  const myStopIdx  = h.onStop  ? _stopCbs.lastIndexOf(h.onStop) : -1;
  const myErrIdx   = h.onError ? _errorCbs.lastIndexOf(h.onError) : -1;

  return {
    /** 主动停止（松手、取消都走这里） */
    stop() {
      try { mgr.stop(); } catch (e) { /* 已停就别管 */ }
    },
    /** 页面卸载时清理：把自己的回调从数组里摘掉 */
    off() {
      if (myFrameIdx >= 0) _frameCbs.splice(myFrameIdx, 1);
      if (myStopIdx  >= 0) _stopCbs.splice(myStopIdx, 1);
      if (myErrIdx   >= 0) _errorCbs.splice(myErrIdx, 1);
    }
  };
}

module.exports = { start };
