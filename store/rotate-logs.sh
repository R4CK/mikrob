#!/usr/bin/env bash
# Daily log rotation for MikroB service + deploy logs.
# copytruncate-style: the services hold O_APPEND handles (systemd `append:`),
# so we copy then truncate-in-place instead of rename (rename would orphan the
# open fd and the service would keep writing to the rotated-away inode).
# Rotated files are gzipped and pruned after RETAIN_DAYS. Idempotent per day.
#
# KNOWN, ACCEPTED RACE (Cybered, 2026-08-07): between `cp` and the truncate, a
# line written by a live service can be lost -- this is the standard price of
# copytruncate (vs. logrotate's own documented tradeoff) and is accepted here,
# not a bug to "fix" by switching to rename (that would break the O_APPEND fd
# instead). Not currently wired to any scheduled task -- inert until scheduled.
set -uo pipefail

STORE=/home/neon/marveen/store
RETAIN_DAYS=14
STAMP=$(date +%Y-%m-%d)

LOGS=(
  "$STORE/deploy.log"
  "$STORE/channels.log"
  "$STORE/channels.error.log"
  "$STORE/dashboard.log"
  "$STORE/dashboard.error.log"
)

for f in "${LOGS[@]}"; do
  [ -f "$f" ] || continue
  # skip empty
  [ -s "$f" ] || continue
  dest="${f}-${STAMP}"
  # if already rotated today, append then re-truncate (handles multiple runs)
  if [ -f "${dest}.gz" ]; then
    tmp="${f}.rotpart"
    cp -p "$f" "$tmp" && : > "$f"
    gzip -c "$tmp" >> "${dest}.gz" 2>/dev/null
    rm -f "$tmp"
  else
    cp -p "$f" "$dest" && : > "$f"
    gzip -f "$dest"
  fi
  # Card 9cbc471e: `cp -p` PRESERVES the source mode, so a 664 live log rotates into a 664 archive
  # -- the archive holds the same content and the same risk, and it outlives the file it came from
  # by RETAIN_DAYS. Force owner-only on both sides; the live file is re-truncated in place above,
  # which keeps its original mode, so it needs saying too.
  chmod 600 "$f" 2>/dev/null || true
  chmod 600 "${dest}.gz" 2>/dev/null || true
done

# prune rotated archives older than RETAIN_DAYS
find "$STORE" -maxdepth 1 -type f -name '*.log-*.gz' -mtime "+${RETAIN_DAYS}" -delete 2>/dev/null

echo "[$(date '+%F %T %Z')] rotate-logs: done (retain ${RETAIN_DAYS}d)" >> "$STORE/deploy.log"
