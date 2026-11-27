#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="$HOME/Pictures/New_updated-_School_ERP_Latest_DevOps"
PATCH="$HOME/Downloads/EDUTRACK_SPARK_PLAN_SCHEDULER_BRIDGE.patch"

if [[ ! -d "$PROJECT" ]]; then
  echo "ERROR: EduTrack project folder not found: $PROJECT" >&2
  exit 1
fi
if [[ ! -f "$PATCH" ]]; then
  echo "ERROR: Spark bridge patch not found: $PATCH" >&2
  exit 1
fi
if ! git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: Target folder is not a Git working tree." >&2
  exit 1
fi

cd "$PROJECT"
echo "===== CURRENT GIT STATUS (preserve existing changes) ====="
git status --short

echo "===== CHECK PATCH COMPATIBILITY ====="
git apply --check "$PATCH"

BACKUP="$HOME/Pictures/EDUTRACK_SPARK_BRIDGE_BACKUP_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP"
tar -czf "$BACKUP/project-before-spark-bridge.tar.gz" \
  --exclude='*/.git' \
  --exclude='*/node_modules' \
  --exclude='*/dist' \
  --exclude='*/.vercel' \
  --exclude='*/.firebase' \
  --exclude='*/.wrangler' \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='*/.dev.vars' \
  --exclude='*/secrets/*' \
  --exclude='*service-account*.json' \
  --exclude='*firebase-adminsdk*.json' \
  --exclude='*credentials*.json' \
  -C "$(dirname "$PROJECT")" "$(basename "$PROJECT")"

echo "===== APPLY SPARK BRIDGE ====="
git apply "$PATCH"
git diff --check

echo "===== PATCH APPLIED ====="
echo "Backup: $BACKUP"
git diff --stat
git status --short
