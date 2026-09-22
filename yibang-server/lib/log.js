/**
 * lib/log.js —— 极简分级日志（2026-09-23，审查 🅱️5）
 *
 * 为什么需要它（先纠正一件事）：审查报告里写的是"后端有 10 处 console.log" ✗，
 * **实际是 100 处** —— 当时那次扫描的路径过滤写错了，漏掉了大部分。
 * 但看清之后发现：**其中 85 处是 catch 里的 console.error，那本身是对的** ✓
 * 真正缺的不是"少打日志"，而是：
 *   · **没有级别** → 生产环境里"调试噪音"和"真问题"混在一起，没法筛
 *   · **没有时间戳** → pm2 的日志一滚屏，前后顺序全靠猜
 *   · **没有标签** → 一眼看不出是哪个模块报的
 * 这个文件补上这三样，**不引入任何第三方依赖**（整个项目的风格就是零依赖）。
 *
 * 用法：
 *   const log = require('./log');
 *   log.info('服务启动', { port: 3000 });        // 业务里程碑
 *   log.warn('Jev 不可用，降级到规则');            // 能自愈、但值得知道
 *   log.error('记账错误', err);                   // 真出错了（传 Error 会自动带 stack）
 *   log.debug('解析结果', obj);                   // 只在 LOG_LEVEL=debug 时出现
 *
 * 级别由环境变量 `LOG_LEVEL` 控制（默认 info）：
 *   debug < info < warn < error
 *   ⚠️ 默认 info —— **生产不该刷 debug**；排查时临时设 LOG_LEVEL=debug 再重启。
 *
 * ⚠️ **scripts/ 和 db/ 下的脚本不要用这个**：那些是命令行工具，
 *    stdout 就是它的输出界面（对账脚本会把它 print 给人看），
 *    套上 `[INFO] 2026-09-23 …` 前缀反而破坏了可读性。**那边保持 console 是对的。**
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  const v = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[v] !== undefined ? LEVELS[v] : LEVELS.info;
}

const TAGS = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

/** 本地时间戳（服务器时区 UTC+8）—— 不用 toISOString，那会差 8 小时 */
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** Error 要带 stack；普通对象序列化；循环引用不能炸 */
function fmt(v) {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (v instanceof Error) return (v.stack || v.message || String(v));
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (e) { return '[无法序列化的对象]'; }
  }
  return String(v);
}

function write(level, args) {
  if (LEVELS[level] < currentLevel()) return;
  const parts = Array.prototype.slice.call(args).map(fmt).filter(Boolean);
  const line = ts() + ' [' + TAGS[level] + '] ' + parts.join(' ');
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

module.exports = {
  debug: function () { write('debug', arguments); },
  info: function () { write('info', arguments); },
  warn: function () { write('warn', arguments); },
  error: function () { write('error', arguments); },
  level: currentLevel
};
