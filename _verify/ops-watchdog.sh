#!/bin/bash
# 易帮账本 · 服务值守（watchdog）
#
# 为什么需要它：
#   pm2 只会在**进程自己退出**时重启它。而"进程活着、但请求全失败"
#   （数据库断了、端口被占、事件循环卡死、内存泄漏到不响应）——
#   pm2 是察觉不到的，那时服务其实已经不可用，但 pm2 里显示 online ✓
#   这个脚本补的就是那个缺口：健康检查连续失败到阈值就重启。
#
# 为什么是"连续 3 次"而不是 1 次：
#   单次抖动（正好赶上 pm2 重启中的那几秒）不该触发重启，否则会来回折腾。
#   每 2 分钟跑一次 → 连续 3 次 ≈ 6 分钟内恢复。
#
# 为什么加 30 分钟冷却：
#   如果重启解决不了（比如数据库真的挂了），没有冷却就会每 6 分钟重启一次，
#   把日志刷爆、还可能让本来就慢的恢复更慢。冷却期内只记日志、不动作。
#
# 用法：
#   /opt/ops/watchdog.sh                     # 正常值守（cron 每 2 分钟调）
#   WATCHDOG_URL=http://127.0.0.1:3999/api/health /opt/ops/watchdog.sh
#                                            # 指一个不存在的端口 → 可安全验证"失败路径"
#                                            # （不会动到线上服务）
set -u

APP=yibang-server
URL="${WATCHDOG_URL:-http://127.0.0.1:3000/api/health}"
LOG=/var/log/yibang-watchdog.log
FAILS=/var/run/yibang-watchdog.fails
LAST=/var/run/yibang-watchdog.lastrestart
THRESHOLD=3           # 连续失败几次才重启
COOLDOWN=1800         # 重启后 30 分钟内不再重启（秒）
LOGLINES=500          # 日志自截断：这台机器的 logrotate 有历史问题（目录组可写 → 直接跳过），
                      # 所以**不指望 logrotate**，脚本自己管住体积。

ts() { date '+%F %T'; }

# ⚠️ curl 在连接失败时**自己就会输出 000、并且返回非零** —— 所以这里不能再写 `|| echo 000`，
#    否则会拼出 "000000"（2026-09-23 实测踩到）。用 `|| true` 只兜住退出码。
probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || true
}

code=$(probe "$URL")

if [ "$code" = "200" ]; then
  # 正常。只在"上一次是失败"时才写日志 —— 否则每 2 分钟一行，日志很快被正常刷满，
  # 真出事时反而找不着。
  if [ -f "$FAILS" ]; then
    echo "$(ts) 恢复健康（HTTP $code）" >> "$LOG"
    rm -f "$FAILS"
  fi
  exit 0
fi

n=$(cat "$FAILS" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAILS"
echo "$(ts) 健康检查失败 HTTP ${code:-000}（连续 $n/$THRESHOLD 次）" >> "$LOG"

[ "$n" -lt "$THRESHOLD" ] && exit 0

now=$(date +%s)
last=$(cat "$LAST" 2>/dev/null || echo 0)
if [ $((now - last)) -lt "$COOLDOWN" ]; then
  echo "$(ts) 已达阈值，但处于冷却期（$(( (COOLDOWN - (now - last)) / 60 )) 分钟后才允许再重启）" >> "$LOG"
  exit 0
fi

echo "$(ts) 连续 $n 次失败 → 重启 $APP" >> "$LOG"
# ⚠️ pm2 的输出里带一大张进程表，直接进日志会把日志冲垮 —— 只记结果，不记它的输出。
if pm2 restart "$APP" >/dev/null 2>&1; then
  echo "$now" > "$LAST"
  rm -f "$FAILS"
  sleep 5
  # 重启后必须**复验**。⚠️ 复验要打**真实服务地址**，不是 $URL ——
  #    $URL 可能被 WATCHDOG_URL 覆盖过（那是测试用的），拿它复验会得出"重启无效"的假结论
  #    （2026-09-23 实测踩到）。
  c2=$(probe "http://127.0.0.1:3000/api/health")
  echo "$(ts) 重启完成，真实服务复验 HTTP ${c2:-000}" >> "$LOG"
else
  echo "$(ts) ❌ pm2 restart 返回失败" >> "$LOG"
fi

# 自截断
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt "$LOGLINES" ]; then
  tail -n "$LOGLINES" "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit 0
