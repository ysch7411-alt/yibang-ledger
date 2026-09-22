#!/bin/sh
# 带重试的 wechatide 调用封装
# 背景：这个工具链会间歇性返回 `read ECONNRESET` / `APPID_ERROR`，它**不是**业务错误，
# 重试 2~3 次基本都过。别因为一次 ECONNRESET 就判定代码有问题。
#
# 用法: sh wxrun.sh <toolName> [args...]
# 环境: WX_TRIES（默认 4）、WX_GAP（默认 5 秒）、WX_CLIENT（默认 ide）
set -u

DIR=$(cd "$(dirname "$0")" && pwd)
TOOL="$1"; shift
TRIES="${WX_TRIES:-4}"
GAP="${WX_GAP:-5}"

i=1
while [ "$i" -le "$TRIES" ]; do
  OUT=$(sh "$DIR/wxcli.sh" -c "${WX_CLIENT:-ide}" "$TOOL" "$@" 2>&1)
  if ! printf '%s' "$OUT" | grep -q '"ok": false'; then
    printf '%s\n' "$OUT"
    exit 0
  fi
  # 只对连接类抖动重试；业务错误（INPUT_ERROR 等）立刻原样抛出
  if ! printf '%s' "$OUT" | grep -qE 'ECONNRESET|APPID_ERROR|timeout waiting'; then
    printf '%s\n' "$OUT"
    exit 1
  fi
  if [ "$i" -lt "$TRIES" ]; then
    printf '[wxrun] 第 %s 次遇到连接抖动，%s 秒后重试…\n' "$i" "$GAP" >&2
    sleep "$GAP"
  fi
  i=$((i + 1))
done

printf '[wxrun] %s 次重试后仍失败\n' "$TRIES" >&2
printf '%s\n' "$OUT"
exit 1
