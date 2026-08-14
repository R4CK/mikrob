#!/usr/bin/env bash
# transcript-perms-guard.sh
#
# Continuous enforcement of restrictive permissions on session transcripts and
# hook/tool-result outputs. Session transcripts persist the dashboard bearer
# token in plaintext (agent commands whose output echoed the token land in the
# model prompt -> transcript). Cybered measured 37 token-bearing files; a
# one-time chmod decays because the harness/hooks create new files at 664.
#
# This runs from cron (every 15 min), NOT as a MikroB prompt-based scheduled
# task -- a mechanical chmod must not wake the agent and burn Claude tokens.
#
# Peti 2026-08-07: token rotation was declined (too many re-logins); this
# perms-hardening is the chosen mitigation. Card bdcd2dc1.
#
# Idempotent, owner-preserving (only tightens; never widens). Safe to re-run.
set -euo pipefail

# ROOTS ARE DERIVED, NOT ENUMERATED (card 89846e07). The hand-written list named two trees and
# MEASUREMENT found two more it had never covered:
#   ~/.claude-usage-probe/projects            (created by weekly-usage-panel-read.sh) -- Cybered's
#                                             finding, 2 transcripts today
#   ~/.claude/tmp/*/projects                  (per-config harness dirs, e.g. marveen-digest-config)
# Both happen to be 700/600 right now, so nothing is exposed today. That is exactly the trap: a
# guard whose scope is a list can only ever protect what someone remembered to add, and the next
# harness directory will arrive the same silent way these two did. Globbing the SHAPE means a new
# sibling tree is covered the first time the guard runs after it appears.
#
# The globs stay narrow on purpose -- config-root/projects, not "anything under $HOME" -- because
# this script chmods directories to 700, and a wide glob would make that a blunt instrument.
MARVEEN_ROOT="${TRANSCRIPT_GUARD_ROOT:-/home/neon/marveen}"

ROOTS=()
while IFS= read -r candidate; do
  [ -d "$candidate" ] && ROOTS+=("$candidate")
done < <(
  printf '%s\n' \
    "$HOME"/.claude*/projects \
    "$HOME"/.claude*/tmp/*/projects \
    "$MARVEEN_ROOT"/.channels-config/projects \
  | sort -u
)

TOKEN_FILE="$MARVEEN_ROOT/store/.dashboard-token"

for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  # Directories -> 700 (blocks external traversal; the real containment).
  find "$root" -type d ! -perm 700 -exec chmod 700 {} + 2>/dev/null || true
  # Transcript + hook/tool-result files -> 600 (last-line defense if a dir
  # perm ever regresses).
  find "$root" -type f \( -name '*.jsonl' -o -path '*/tool-results/*' \) \
    ! -perm 600 -exec chmod 600 {} + 2>/dev/null || true
done

# Transcript-shaped files that sit at a config ROOT rather than inside a projects tree --
# ~/.claude/history.jsonl is the live example (64 MB of prompt history, 600 today, covered by
# nothing). Files only: no directory is touched here, so this cannot widen the sweep above.
for f in "$HOME"/.claude*/*.jsonl; do
  [ -f "$f" ] && [ "$(stat -c '%a' "$f" 2>/dev/null)" != "600" ] && chmod 600 "$f" 2>/dev/null || true
done

# The token file itself.
[ -f "$TOKEN_FILE" ] && chmod 600 "$TOKEN_FILE" 2>/dev/null || true

exit 0
