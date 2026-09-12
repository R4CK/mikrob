#!/usr/bin/env bash
# log-permissions.sh [--check|--fix] [DIR]   (default: --check on the install's store/)
#
# Card 9cbc471e (Cybersec L1/L2 on 6cee9225): store/*.log files are created 664 (rw-rw-r--), a few
# 644. Nothing in them is secret TODAY, but a log is exactly the file that grows a secret later --
# one added `curl -v`, one traceback with a token in a URL -- so least-privilege here is preventive.
#
# WHY A SWEEP AND NOT ONLY A umask AT EACH CREATOR. Twenty scripts write a store log, and the two
# most sensitive files are not created by a script at all: cron's own shell creates
# `kanban-snapshot-cron.log` and `db-backup-cron.log` through the `>>` in the crontab line, BEFORE
# the script runs. Both scripts already set `umask 077` (cards 90e4cbdf, e804262d) and both cron
# logs are still 664 -- measured, and it is the point: a umask inside the script cannot reach a file
# the shell opened for it. Those two need `umask 077;` in the crontab line itself, which is host
# state, not repo state.
#
# So this is the net under the umasks, not a replacement for them: it NAMES what is loose, and can
# tighten it. Use --check from a monitor, --fix by hand or after a deploy.
set -uo pipefail

MODE="${1:---check}"
DIR="${2:-${MARVEEN_STORE:-/home/neon/marveen/store}}"

case "$MODE" in
  --check|--fix) ;;
  *) echo "usage: log-permissions.sh [--check|--fix] [DIR]" >&2; exit 2 ;;
esac

[ -d "$DIR" ] || { echo "log-permissions: no such directory: $DIR" >&2; exit 2; }

# Group- or world-readable/writable is the finding. Owner bits are not this card's business.
loose=()
while IFS= read -r -d '' f; do
  mode="$(stat -c '%a' "$f" 2>/dev/null)" || continue
  # Anything beyond owner bits: the last two octal digits must be 0.
  [ "${mode: -2}" = "00" ] && continue
  loose+=("$f")
done < <(find "$DIR" -maxdepth 1 -type f \( -name '*.log' -o -name '*.log-*' \) -print0 2>/dev/null)

if [ "${#loose[@]}" -eq 0 ]; then
  echo "log-permissions: all $DIR log files are owner-only."
  exit 0
fi

if [ "$MODE" = "--check" ]; then
  echo "log-permissions: ${#loose[@]} log file(s) readable beyond the owner in $DIR:" >&2
  for f in "${loose[@]}"; do echo "  $(stat -c '%a' "$f") $(basename "$f")" >&2; done
  echo "  Fix: bash store/log-permissions.sh --fix" >&2
  echo "  NOTE: the two cron-redirect logs come back at 664 every time cron recreates them --" >&2
  echo "  that needs 'umask 077;' in the crontab line, which this script cannot reach." >&2
  exit 1
fi

rc=0
for f in "${loose[@]}"; do
  if chmod 600 "$f" 2>/dev/null; then echo "log-permissions: 600 $(basename "$f")"; else
    echo "log-permissions: FAILED to chmod $(basename "$f")" >&2; rc=1; fi
done
exit "$rc"
