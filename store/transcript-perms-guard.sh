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

ROOTS=(
  "$HOME/.claude/projects"
  "/home/neon/marveen/.channels-config/projects"
)

TOKEN_FILE="/home/neon/marveen/store/.dashboard-token"

for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  # Directories -> 700 (blocks external traversal; the real containment).
  find "$root" -type d ! -perm 700 -exec chmod 700 {} + 2>/dev/null || true
  # Transcript + hook/tool-result files -> 600 (last-line defense if a dir
  # perm ever regresses).
  find "$root" -type f \( -name '*.jsonl' -o -path '*/tool-results/*' \) \
    ! -perm 600 -exec chmod 600 {} + 2>/dev/null || true
done

# The token file itself.
[ -f "$TOKEN_FILE" ] && chmod 600 "$TOKEN_FILE" 2>/dev/null || true

exit 0
