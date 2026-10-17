/**
 * utils/tts.js —— TTS 播放器（前端）
 *
 * 2026-10-09。腾讯云开发版。
 *
 * ── 它做什么 ──
 *   接收一段文字 + 音色名，POST 到 yibang-api/tts/synthesize，
 *   把返回的音频 URL 用 wx.createInnerAudioContext() 播放。
 *
 *   第一版只做"整段合成 + 整段播放"。流式（边合成边播）留作 v1.1
 *   —— 老板的对话节奏大部分 ≤ 30 字，整段合成的延迟能接受。
 *
 * ── 可打断 ──
 *   `stop()` 把当前播放停掉 + 取消正在飞的请求。
 *   AI 答到一半老板又问新问题时，必须能立即停；不然两个声音会叠在一起。
 *
 * ── 13 个音色白名单（与后端 lib/tts.js 同步）──
 *   改这里一定要同步后端；否则前端选的音色被后端拒掉，会合成失败。
 */

const api = require('./api');

/** 13 个音色白名单。⚠️ 改这里必须**同步后端** lib/tts.js 的 TTS_VOICES。
 *  label 只写「性别 · 音色本名」，**不要重复 dialect** —— 面板里下面一行就是 dialect，
 *  写「男声 · 北京话 / 北京话」是白占一行。 */
const VOICES = [
  { v: 'Cherry', label: '女声 · 芊悦',   dialect: '普通话' },
  { v: 'Ethan',  label: '男声 · 晨煦',   dialect: '普通话' },
  { v: 'Serena', label: '女声 · 苏瑶',   dialect: '普通话' },
  { v: 'Sunny',  label: '女声 · 晴儿',   dialect: '四川话' },
  { v: 'Eric',   label: '男声 · 程川',   dialect: '四川话' },
  { v: 'Kiki',   label: '女声 · 阿清',   dialect: '粤语' },
  { v: 'Rocky',  label: '男声 · 阿强',   dialect: '粤语' },
  { v: 'Jada',   label: '女声 · 阿珍',   dialect: '上海话' },
  { v: 'Dylan',  label: '男声 · 晓东',   dialect: '北京话' },
  { v: 'Peter',  label: '男声 · 李彼得', dialect: '天津话' },
  { v: 'Li',     label: '男声 · 老李',   dialect: '南京话' },
  { v: 'Marcus', label: '男声 · 秦川',   dialect: '陕西话' },
  { v: 'Roy',    label: '男声 · 阿杰',   dialect: '闽南语' }
];

/** 默认音色。沿用易帮930版的口径：女声芊悦。 */
const DEFAULT_VOICE = 'Cherry';

let _audio = null;   // 单例音频上下文 —— 不复用会让多个 stop/stop 互相打架
let _playing = false;

function _ensureAudio() {
  if (_audio) return _audio;
  _audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
  _audio.onEnded(() => { _playing = false; });
  _audio.onStop(() => { _playing = false; });
  _audio.onError(() => { _playing = false; });
  return _audio;
}

/**
 * 朗读一段文字。
 *
 * @param {string} text   要朗读的中文（≤ 150 字，超过会被服务端截断）
 * @param {string} [voice] 音色名；不传用默认 Cherry
 * @returns {Promise<void>} 播完 resolve；被打断不会 reject
 */
function speak(text, voice) {
  const t = String(text || '').trim();
  if (!t) return Promise.resolve();

  // 已经在说就把当前的停掉 —— 老板的问题比 AI 上一次的回答更重要
  stop();

  return api.ttsSynthesize({ text: t, voice: voice || DEFAULT_VOICE })
    .then((d) => {
      const url = d && d.url;
      if (!url) throw new Error('TTS 返回空 URL');
      const a = _ensureAudio();
      a.src = url;
      a.play();
      _playing = true;
    });
}

/** 立即停掉当前播放（不 reject 任何 in-flight promise） */
function stop() {
  if (_audio) {
    try { _audio.stop(); } catch (e) { /* 可能根本没在播 */ }
  }
  _playing = false;
}

/** 当前是否在播（页面"录音"按钮被禁用时用） */
function isPlaying() { return !!_playing; }

module.exports = { speak, stop, isPlaying, VOICES, DEFAULT_VOICE };
