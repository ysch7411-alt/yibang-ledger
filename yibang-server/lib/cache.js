/**
 * 简单的内存缓存（2026-09-21 新增）
 *
 * 为什么用内存而不是 redis：和限流一样，这是一个几十行的兜底，
 * 不值得为它多加一次网络往返。进程重启后缓存清空，最坏情况是
 * 重启后第一次请求重新调一次AI —— 可接受。
 *
 * 用途：AI问答缓存，相同问题直接返回结果，提升响应速度。
 */

// key → { value, expireAt }
const cache = new Map();

/**
 * 设置缓存
 * @param {string} key - 缓存键
 * @param {any} value - 缓存值
 * @param {number} ttlSec - 过期时间（秒）
 */
function set(key, value, ttlSec = 3600) {
  const expireAt = Date.now() + ttlSec * 1000;
  cache.set(key, { value, expireAt });

  // 超过1000条就清理过期的
  if (cache.size > 1000) {
    gc();
  }
}

/**
 * 获取缓存
 * @param {string} key - 缓存键
 * @returns {any|null} 缓存值，不存在或过期返回null
 */
function get(key) {
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() > item.expireAt) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

/**
 * 删除缓存
 * @param {string} key - 缓存键
 */
function del(key) {
  cache.delete(key);
}

/**
 * 清理过期缓存
 */
function gc() {
  const now = Date.now();
  for (const [key, item] of cache) {
    if (now > item.expireAt) {
      cache.delete(key);
    }
  }
}

module.exports = { set, get, del, gc };
