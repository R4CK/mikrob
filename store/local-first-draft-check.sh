#!/usr/bin/env bash
# local_first_draft_enabled -- is the master local-first-draft kill-switch ON? (card d57d8a01, Peti
# Telegram 10951.)
#
# WHY THIS EXISTS. store/self-advance-pickup.sh already read a LOCAL_FIRST_DRAFT env var / a
# store/local-first-draft.json {"enabled": false} file, but it was the ONLY caller: card-build-
# route.sh, offload-dispatch.sh, route-classify.sh, gate-pretriage.sh, i18n-draft.sh,
# local-llm-rag.sh and local-llm.sh never looked at it at all, and the file itself could only be
# edited by hand. This file is the ONE place the read logic lives (DRY, same reason
# landing-gate-verdict-check.sh/downward-check.sh etc. are shared rather than copied seven times),
# and src/web/routes/local-llm.ts's new /api/local-llm/first-draft-enabled endpoint + the dashboard
# toggle are the ONE place it gets WRITTEN -- so "single source of truth" is true on both axes.
#
# Precedence, unchanged from self-advance-pickup.sh's original logic: an explicit LOCAL_FIRST_DRAFT
# env var (the literal string "off" disables, anything else is ON) wins over the file; the file
# missing, unreadable or unparseable means ON (plan-grilling point 2: absence = ON, never a
# fail-closed surprise that silently stops every local-first path on a config hiccup).
#
# Usage:
#   . "$(dirname "$0")/local-first-draft-check.sh"
#   if local_first_draft_enabled; then ... else echo "... -> ONLINE" >&2; fi
#
# Env override (tests only): LOCAL_FIRST_DRAFT_FLAG_FILE.
local_first_draft_enabled() {
  local flag_file="${LOCAL_FIRST_DRAFT_FLAG_FILE:-$(dirname "${BASH_SOURCE[0]}")/local-first-draft.json}"
  local value="${LOCAL_FIRST_DRAFT:-}"
  if [ -z "$value" ] && [ -f "$flag_file" ]; then
    value="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print("off" if d.get("enabled") is False else "on")
except Exception:
    print("on")
' "$flag_file" 2>/dev/null)"
  fi
  [ "$value" != "off" ]
}
