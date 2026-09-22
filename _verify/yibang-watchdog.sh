#!/bin/bash
# 易帮账本 · 服务值守（watchdog）
#
# 为什么需要它：pm2 只能看到"进程还在不在"，看不到
# 「进程还在、但数据库连不上」或「接口全在报错」。
# 而老板不会来报"服务挂了" —— 他只会觉得这软件不好用，然后不用了。
#
# 做法：每 2 分钟探一次 /api/health（那个接口会真的连一次数据库）。
#   连续失败 3 次 → 自动重启一次（自愈）+ 记日志（事后能查）。
# 没有现成的通知渠道，所以优先做「能自己好 + 事后查得到」，
# 而不是发一条没人会看的通知。
#
# 日志：/var/log/yibang-watchdog.log
set -u

LOG=/var/log/yibang-watchdog.log
STATE=/opt/yibang/.watchdog_state
# 探测地址可覆盖：否则"服务挂了"这条路径根本没法测 —— 总不能为了测试把真服务停掉。
# 用 WATCHDOG_URL=http://127.0.0.1:59999/api/health 就能安全地模拟一次故障。
URL="${WATCHDOG_URL:-http://127.0.0.1:3000/api/health}"
APP="${WATCHDOG_APP:-yibang-server}"
FAIL_MAX=3
COOLDOWN_SEC=1800   # 重启后仍不通 → 半小时内不再重启，免得陷进重启循环

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$1" >> "$LOG"; }

# 值守日志不该无限长：超 2000 行就留最近 1000 行
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 2000 ]; then
  tail -1000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

now=$(date +%s)
fails=0
last_restart=0
if [ -f "$STATE" ]; then
  read -r fails last_restart < "$STATE" 2>/dev/null || true
fi
case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
case "$last_restart" in ''|*[!0-9]*) last_restart=0 ;; esac

# 探活。-f 让 4xx/5xx 也算失败；--max-time 防止探测本身卡住
body=$(curl -sf --max-time 8 "$URL" 2>/dev/null)

if [ -n "$body" ]; then
  if [ "$fails" -gt 0 ]; then
    log "恢复：健康检查通过（此前连续失败 $fails 次）"
  fi
  printf '0 0\n' > "$STATE"
else
  fails=$((fails + 1))
  log "健康检查失败（第 $fails 次）"
  printf '%s %s\n' "$fails" "$last_restart" > "$STATE"

  if [ "$fails" -ge "$FAIL_MAX" ]; then
    if [ "$last_restart" -gt 0 ] && [ $((now - last_restart)) -lt "$COOLDOWN_SEC" ]; then
      # 冷却期内不再重启，但**计数要留着** —— 清零的话等它真恢复了，
      # "恢复"那一行就写不出来，而"它到底是几点好的"正是查日志最想知道的事。
      # 这期间每分钟仍然记一条失败，这样能看出"从几点挂到几点"。
      printf '%s %s\n' "$fails" "$last_restart" > "$STATE"
    else
      log "连续 $FAIL_MAX 次失败 → 重启 $APP"
      # pm2 restart 会往 stdout 打一整张进程表。任由它进日志的话，
      # 值守日志会被表格淹没，真正有用的那几行反而找不到了 —— 只记结果。
      if pm2 restart "$APP" > /dev/null 2>&1; then
        log "重启命令已执行"
      else
        log "pm2 restart 执行失败"
      fi
      sleep 5
      if curl -sf --max-time 8 "$URL" > /dev/null 2>&1; then
        log "重启后恢复正常"
        printf '0 0\n' > "$STATE"
      else
        log "重启后仍不通 —— 需要人工介入（查数据库 / 磁盘 / 内存）"
        printf '%s %s\n' "$fails" "$now" > "$STATE"
      fi
    fi
  fi
fi

# 资源阈值提醒：磁盘 85% / 内存 90% 以上各记一条（同一个问题每天只记一次）
today=$(date '+%F')
disk=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [ -n "$disk" ] && [ "$disk" -ge 85 ]; then
  if ! grep -q "磁盘告警 $today" "$LOG" 2>/dev/null; then
    log "磁盘告警 $today：已用 ${disk}%（超过 85%，该清日志或扩盘了）"
  fi
fi
mem=$(free -m | awk '/^Mem:/ {printf "%d", $3 * 100 / $2}')
if [ -n "$mem" ] && [ "$mem" -ge 90 ]; then
  if ! grep -q "内存告警 $today" "$LOG" 2>/dev/null; then
    log "内存告警 $today：已用 ${mem}%（超过 90%）"
  fi
fi

exit 0
