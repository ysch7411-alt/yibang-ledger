/**
 * utils/noise-gate.js —— 录音底噪门限
 *
 * 2026-10-17。**移植自 H5 那版**（h5.dtzai.cn 的 rtStartMic，注释写的是"借鉴 Claude 语音模式"）。
 *
 * ── 解决什么问题 ──
 *   老板的场子是有底噪的：菜市场、后厨抽油烟机、马路边的店门口。
 *   这些噪声本身不是人声，但会一起送进 ASR：
 *     · 识别出莫名其妙的字（"嗯""啊""那个"）→ 入账内容脏
 *     · 服务端 VAD 被噪声持续触发 → 该断句的地方不断句，一整段糊成一句
 *   底噪帧整帧置零后，送进去的就是"干净的房间声"，ASR 只对人声起反应。
 *
 * ── 🔴 关键设计：置零，但**不跳帧** ──
 *   服务端的 VAD 是靠"还在不在收帧"来判定"你说完没有"的。
 *   如果底噪帧干脆不发，VAD 会以为人停了 → 提前切段 → 一句话被切成两半。
 *   所以底噪帧**照常发**，只是内容全 0 —— 时长在流里是连续的，VAD 计时才准。
 *   这一点是 h5 那版特意写明的，移植时必须保留。
 *
 * ── 为什么用峰值而不是均方根 ──
 *   人声起头那一下（清辅音、爆音）均值很低但峰值很高。
 *   用均值会把"张"字的开头吃掉，听起来就像吞字。
 *
 * ── ⚠️ 单位纪律（这个模块栽过一次，记下来）──
 *   `peakOf` 返回 **PCM16 绝对整数**（0~32768），`peakRatio` 返回 **0~1 比例**，
 *   `thresholdOf` 返回 **PCM16 绝对整数**。
 *   第一版 `apply` 把 `peakRatio`（0.05）和 `thresholdOf`（2621）直接比大小 ——
 *   `0.05 >= 2621` 永远为假 → **每一帧都被当底噪置零** → 语音输入整个哑掉。
 *   所以本模块内部一律用**绝对整数**比：`peakOf` vs `thresholdOf`。
 *   比例只在对外汇报和调试时用。
 *
 * ── 用法 ──
 *   const gate = require('../../utils/noise-gate');
 *   onFrame: (frame) => pipe.feed(gate.apply(frame).buf)
 */

/** 峰值低于这个比例（相对 16bit 满量程）就当底噪。与 h5 保持一致 */
const NOISE_FLOOR = 0.08;

/** 16bit PCM 满量程的一半（负数能到 -32768，正数只到 32767）*/
const PCM16_MAX = 32768;

/**
 * 取出这一帧的 Int16 视图；取不到返回 null。
 *
 * ⚠️ Int16Array 的构造要求字节数是 2 的整数倍，**奇数字节会直接 throw**。
 *    录音分片正常都是 1024 字节，但"正常"不是理由 ——
 *    在这里抛出去会让整段录音中断，用户只看到"录音失败了"。
 */
function _i16(buf) {
  try {
    if (buf instanceof Int16Array) return buf;
    if (buf && buf.byteLength != null) {
      if (buf.byteLength < 2 || buf.byteLength % 2 !== 0) return null;
      return new Int16Array(buf);
    }
  } catch (e) { /* 落到 null */ }
  return null;
}

/**
 * 把 float 比例换成 PCM16 的整数阈值。抽出来是为了能测边界（0.08 → 2621）。
 * @param {number} [ratio] 省略 = NOISE_FLOOR
 * @returns {number} 0~32768 的绝对整数；非法值返回 0（= 不设门限，全部放行）
 */
function thresholdOf(ratio) {
  const r = (ratio == null) ? NOISE_FLOOR : Number(ratio);
  if (!isFinite(r) || r < 0) return 0;
  return Math.round(Math.min(r, 1) * PCM16_MAX);
}

/**
 * 这一帧的绝对峰值（0~32768）。算不出来返回 0。
 * @returns {number}
 */
function peakOf(buf) {
  const i16 = _i16(buf);
  if (!i16 || !i16.length) return 0;
  let peak = 0;
  for (let i = 0; i < i16.length; i++) {
    const v = i16[i];
    const a = v < 0 ? -v : v;      // 负峰值按绝对值算 —— 只看正数会吃掉说话的半周
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * 这一帧的峰值占满量程的比例（0~1）。只用于汇报/调试，判门限请用 peakOf。
 * @returns {number}
 */
function peakRatio(buf) {
  return peakOf(buf) / PCM16_MAX;
}

/**
 * 对一帧应用门限。
 *
 * @param {ArrayBuffer|Int16Array} buf 一帧 PCM16（16k 单声道，约 32ms）
 * @param {number} [ratio] 自定义阈值（默认 0.08；主要是为了测试和以后调参）
 * @returns {{buf: (ArrayBuffer|Int16Array), gated: boolean, peak: number}}
 *   gated=true 表示这一帧被判成底噪、内容已原地置零（**帧还在，照常发**）
 *   peak 是 0~1 的比例，方便调用方打印日志
 */
function apply(buf, ratio) {
  const i16 = _i16(buf);
  const peak = i16 ? peakOf(i16) : 0;          // ← 绝对整数，和下面的阈值同单位
  const thr = thresholdOf(ratio);

  if (peak >= thr) return { buf: buf, gated: false, peak: peak / PCM16_MAX };

  /* 原地置零。用 fill 而不是新建数组：32ms 一帧、一秒约 31 帧，
     新建会让 GC 在整段录音里一直忙。 */
  try { if (i16) i16.fill(0); }
  catch (e) { /* 置零失败就算了 —— 宁可送一帧噪声，也不能让录音链路断掉 */ }

  return { buf: buf, gated: true, peak: peak / PCM16_MAX };
}

module.exports = { apply, peakOf, peakRatio, thresholdOf, NOISE_FLOOR };
