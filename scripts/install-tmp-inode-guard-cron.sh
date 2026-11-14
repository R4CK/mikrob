#!/usr/bin/env bash
# Install store/tmp-inode-guard.sh as a user crontab entry (card b1813ab2).
#
# WHY A PLAIN CRONTAB LINE, NOT A SYSTEMD --user TIMER (unlike scripts/install-guard-timers.sh):
# this is what MikroB actually installed live on 2026-11-14 when the /tmp tmpfs hit 100% IUse,
# and the script is already tuned for that shape (it logs via a `>>` redirect, same convention
# as kanban-snapshot.sh/db-backup.sh's cron lines). Idempotent: checks the existing crontab for
# the script's own path before appending, never duplicates the line, never hard-fails the caller.
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$INSTALL_DIR/store/tmp-inode-guard.sh"
LOG="$INSTALL_DIR/store/tmp-inode-guard.log"
LINE="*/5 * * * * /bin/bash $GUARD >> $LOG 2>&1"

[ -f "$GUARD" ] || { echo "install-tmp-inode-guard-cron: no guard at $GUARD" >&2; exit 1; }

command -v crontab >/dev/null 2>&1 || { echo "install-tmp-inode-guard-cron: no crontab on this host" >&2; exit 1; }

existing="$(crontab -l 2>/dev/null || true)"
if printf '%s\n' "$existing" | grep -qF "$GUARD"; then
  echo "install-tmp-inode-guard-cron: already installed"
  exit 0
fi

{ printf '%s\n' "$existing"; printf '%s\n' "$LINE"; } | crontab -
echo "install-tmp-inode-guard-cron: installed ($LINE)"
