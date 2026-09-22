#!/bin/bash
# 易帮账本 · MySQL 每日备份
#
# 背景：服务器上原来有两条备份 cron，但都指向不存在的脚本（/opt/yibang/backup.sh、
# /opt/saas/backup.sh），等于每天凌晨静默失败 —— 账本数据从来没被备份过。
# 这个脚本由 2026-09-19 的审计补上，并且**自己校验产物**，不允许"假装成功"。
#
# 用法：cron 里 0 2 * * * bash /opt/yibang/backup.sh >> /opt/yibang/backups/backup.log 2>&1
set -uo pipefail

DB=yibang
DIR=/opt/yibang/backups
KEEP=14                 # 保留最近 14 份日备
ENV_FILE=/www/wwwroot/yibang-server/.env
LOG=$DIR/backup.log

mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT=$DIR/${DB}-${TS}.sql.gz

log() { echo "[$(date '+%F %T')] $*" >>"$LOG"; }

# 凭据从应用的 .env 读，不在脚本里再存一份密码
DB_USER=$(grep -oP '^DB_USER=\K.*' "$ENV_FILE" 2>/dev/null | tr -d '"' | tr -d "'")
DB_PASS=$(grep -oP '^DB_PASS=\K.*' "$ENV_FILE" 2>/dev/null | tr -d '"' | tr -d "'")
DB_HOST=$(grep -oP '^DB_HOST=\K.*' "$ENV_FILE" 2>/dev/null | tr -d '"' | tr -d "'")
DB_PORT=$(grep -oP '^DB_PORT=\K.*' "$ENV_FILE" 2>/dev/null | tr -d '"' | tr -d "'")

if [ -z "${DB_USER}" ] || [ -z "${DB_PASS}" ]; then
  log "✗ 读不到数据库凭据（$ENV_FILE），放弃本次备份"
  exit 1
fi

# 用临时 defaults-file 传密码：不暴露在 ps 里，也不会刷 "password on command line" 警告
CNF=$(mktemp)
chmod 600 "$CNF"
cat >"$CNF" <<EOF
[client]
host=${DB_HOST:-localhost}
port=${DB_PORT:-3306}
user=${DB_USER}
password=${DB_PASS}
EOF

mysqldump --defaults-extra-file="$CNF" \
  --single-transaction --quick --routines --triggers --events \
  --no-tablespaces --default-character-set=utf8mb4 \
  "$DB" 2>>"$LOG" | gzip >"$OUT"
RC=${PIPESTATUS[0]}
rm -f "$CNF"

# ---- 自校验：空文件、或内容不像 SQL，都算失败。绝不留一个假装成功的备份 ----
if [ "$RC" -ne 0 ]; then
  log "✗ mysqldump 退出码 $RC，删除半成品 $OUT"
  rm -f "$OUT"
  exit 1
fi
if [ ! -s "$OUT" ]; then
  log "✗ 备份文件为空，删除 $OUT"
  rm -f "$OUT"
  exit 1
fi
if ! gzip -dc "$OUT" 2>/dev/null | head -80 | grep -q "CREATE TABLE"; then
  log "✗ 备份内容里没有建表语句，可能 dump 异常，删除 $OUT"
  rm -f "$OUT"
  exit 1
fi

SIZE=$(stat -c%s "$OUT")
TABLES=$(gzip -dc "$OUT" | grep -c "^CREATE TABLE")
log "✓ 备份成功 ${DB}-${TS}.sql.gz  $((SIZE / 1024))KB  含 $TABLES 张表"

# 只保留最近 KEEP 份（按时间倒序，从第 KEEP+1 份开始删）
ls -1t "$DIR"/${DB}-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f"
  log "  清理旧备份 $(basename "$f")"
done

exit 0
