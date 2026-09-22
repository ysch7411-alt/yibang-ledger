#!/bin/sh
# 源码快照 —— 给「没有版本控制」这件事兜底
#
# 为什么需要它（2026-09-19 一天内同类事故三次，全部发生在写文件这一步）：
#   1. pages/promote/promote.wxss  被 `cat >>` 覆盖开头，丢了 .pg-card/.pg-top/.pg-num/.pg-cur
#   2. .workbuddy/memory/2026-09-19.md  被同样手法覆盖开头 64 行
#   3. pages/purchase/purchase.wxss  被同样手法覆盖开头 62 行（.line1 / .po-head /
#      .po-row / .po-no 属性头全没了，只靠设计稿重建）
#   三次都是「工具说追加、实际从第 1 字节覆写」。项目里没有 git，也没有任何备份，
#   每次都是靠人肉对照设计稿重建 —— 早晚有一次重建不出来。
#
# 用法：
#   sh _verify/snapshot.sh              # 打一个快照
#   sh _verify/snapshot.sh --list       # 列出已有快照
#   sh _verify/snapshot.sh --verify <名>  # 校验某个快照可读、文件数与当前一致
#
# 打快照的时机（不用多，够用就行）：
#   动手改一批文件之前 + 改完自查通过之后。两次都用同一个 tag 前缀，靠时间戳分开。
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/_snapshots"
TAG="${SNAP_TAG:-manual}"

# 只收源码。node_modules 上万个文件没必要，且它随时能重装。
SRC_FRONT="$ROOT/yibang-miniprogram"
SRC_SERVER="$ROOT/yibang-server"

if [ "${1:-}" = "--list" ]; then
  [ -d "$DEST" ] || { echo "还没有任何快照"; exit 0; }
  ls -1 "$DEST" | sort
  exit 0
fi

if [ "${1:-}" = "--verify" ]; then
  NAME="${2:-}"
  [ -n "$NAME" ] || { echo "用法: sh snapshot.sh --verify <快照名>"; exit 1; }
  T="$DEST/$NAME"
  [ -d "$T" ] || { echo "找不到快照 $NAME"; exit 1; }

  ok=1
  for pair in "yibang-miniprogram:$SRC_FRONT" "yibang-server:$SRC_SERVER"; do
    sub=${pair%%:*}; cur=${pair#*:}
    [ -d "$T/$sub" ] || { echo "  ✗ 快照里缺 $sub"; ok=0; continue; }
    n_snap=$(find "$T/$sub" -type f | wc -l | tr -d ' ')
    n_cur=$(find "$cur" -type f \
      -not -path "*/node_modules/*" -not -path "*/_snapshots/*" \
      -not -path "*/.git/*" -not -path "*/uploads/*" | wc -l | tr -d ' ')
    if [ "$n_snap" -eq "$n_cur" ]; then
      echo "  ✓ $sub 文件数一致：$n_snap"
    else
      echo "  ! $sub 文件数不同：快照 $n_snap / 当前 $n_cur（改过就正常，没改过要查）"
    fi
  done
  [ "$ok" -eq 1 ] && echo "快照结构完整" || { echo "快照不完整"; exit 1; }
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
T="$DEST/$STAMP-$TAG"
mkdir -p "$T"

copydir() {
  from=$1
  to=$2
  [ -d "$from" ] || { echo "  · 跳过（不存在）：$from"; return 0; }
  # tar 管道比 cp -r 更能保住目录结构，也比逐个 find 快
  (cd "$(dirname "$from")" && tar cf - \
      --exclude=node_modules \
      --exclude=.git \
      --exclude=uploads \
      --exclude=miniprogram_npm \
      "$(basename "$from")") | (cd "$to" && tar xf -)
}

echo "正在快照到 $T"
copydir "$SRC_FRONT" "$T"
copydir "$SRC_SERVER" "$T"

# 顺手把验证脚本也存一份：重建靠的就是它们
[ -d "$ROOT/_verify" ] && copydir "$ROOT/_verify" "$T" >/dev/null

n=$(find "$T" -type f | wc -l | tr -d ' ')
sz=$(du -sh "$T" 2>/dev/null | cut -f1)
echo "完成：$n 个文件，$sz"
echo
echo "回滚单个文件："
echo "  cp \"$T/yibang-miniprogram/pages/xxx/xxx.wxss\" \"$SRC_FRONT/pages/xxx/xxx.wxss\""
