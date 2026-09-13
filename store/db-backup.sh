#!/usr/bin/env bash
# Periodic full SQLite backup of store/claudeclaw.db.
#
# WHY (2026-09-08 incident): kanban_cards, kanban_comments, memories,
# daily_logs, labels, kanban_dependencies, idea_box, agent_messages, sessions,
# auth_sessions, background_tasks, config_change_log and store_file_audit all
# went from populated to 0 rows between a normal shutdown and the next boot.
# The only prior backup on disk was store/backups/claudeclaw-20260725-190039.tar.gz
# -- six weeks stale -- so there was nothing recent to restore from. This
# script closes that gap going forward; it does not explain or fix the root
# cause (see card 4306e862 for the shutdown() db.close() gap).
#
# Uses SQLite's own online backup API (`.backup`), NOT a plain file copy --
# `.backup` takes a consistent snapshot even while the live process holds the
# WAL open and is actively writing, unlike `cp` which can copy a torn/partial
# state. Safe to run every hour against the live, in-use database.
set -euo pipefail
umask 077

STORE=/home/neon/marveen/store
# THE SCHEDULER'S REDIRECT LOG IS NOT COVERED BY THE umask ABOVE (card 76c3a1fb, Cybersec's finding
# under 90e4cbdf). The scheduled entry is `... db-backup.sh >> db-backup-cron.log 2>&1`, so that file is created by
# the SHELL THE SCHEDULER SPAWNS, before this script -- and its umask -- exists at all. A umask here
# is structurally unable to reach it, which is why the sibling fix on this script's OWN outputs left
# it open. Measured on the live box: both such logs stood at 664, i.e. group-WRITABLE. Reproduced
# locally in exactly the scheduled shape -- outer shell at umask 002 opening the redirect, inner
# shell setting umask 077 afterwards -- which yields 664 without this line and 600 with it. 664 also
# fixes the umask at 002, not the 022 the sibling comments used to assert (that would give 644);
# 002 is what pam_umask produces here, since USERGROUPS_ENAB is on and the user's group matches.
# So tighten the inode BY NAME on every run. This hardcodes the redirect target: if the scheduled
# line changes, this must change with it, and cron-log-modes.test.ts derives the expected name from
# the script's own filename so the two cannot drift apart silently.
# `|| true` because a hand-run has no redirect and so no such file, and `set -e` is on.
chmod 600 "$STORE/db-backup-cron.log" 2>/dev/null || true
DB="$STORE/claudeclaw.db"
OUT_DIR="$STORE/backups"
# Peti 2026-09-08: hard cap on backup count, not age -- these are full DB
# copies and must not grow unbounded on disk.
MAX_BACKUPS=20
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$OUT_DIR/claudeclaw-${STAMP}.db"

mkdir -p "$OUT_DIR"

if [ ! -f "$DB" ]; then
  echo "$(date '+%F %T %Z') db-backup: SKIP, $DB not found" >> "$STORE/db-backup.log"
  exit 0
fi

sqlite3 "$DB" ".backup '${DEST}'"
gzip -f "$DEST"
# Belt and suspenders (Cybersec MEDIUM, card e804262d): umask only governs
# file CREATION -- if gzip/mv ever changes, or a future caller writes the
# temp file differently, umask alone stops protecting it. Force the mode on
# the actual output file regardless of how it got there.
chmod 600 "${DEST}.gz"

# Keep only the newest MAX_BACKUPS files; delete the rest (count-based, not
# age-based -- Peti wants a hard cap on how much disk this eats).
mapfile -t all_backups < <(ls -1t "$OUT_DIR"/claudeclaw-*.db.gz 2>/dev/null)
if [ "${#all_backups[@]}" -gt "$MAX_BACKUPS" ]; then
  for f in "${all_backups[@]:$MAX_BACKUPS}"; do
    rm -f "$f"
  done
fi

SIZE=$(du -h "${DEST}.gz" 2>/dev/null | cut -f1)
echo "$(date '+%F %T %Z') db-backup: wrote ${DEST}.gz (${SIZE:-?})" >> "$STORE/db-backup.log"
