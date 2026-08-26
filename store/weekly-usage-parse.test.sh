#!/usr/bin/env bash
# Test for weekly-usage-parse.sh (card a91c6039). Runs the PURE parse helpers against sample
# /usage captures -- no tmux/network. Exits 0 on pass, 1 on any failure.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${HERE}/weekly-usage-parse.sh"

fails=0
check() { # <label> <got> <want>
  if [ "$2" = "$3" ]; then echo "  ok: $1"; else echo "  FAIL: $1 -- got [$2] want [$3]"; fails=$((fails + 1)); fi
}

# A representative /usage capture (session + weekly all-models + Fable + promo).
SAMPLE="$(cat <<'EOF'
 Usage

 Current session
 ████████░░░░░░░░  45% used
 Resets Thu 3:59 PM

 Current week (all models)
 ██████████████░░  87% used
 Resets Fri 11:00 AM

 Current week (Fable)
 ███░░░░░░░░░░░░░░  20% used
 Resets Fri 11:00 AM

 +50% extra weekly limit through Aug 19
EOF
)"

check "weekly pct"     "$(wu_pct_of "$SAMPLE" 'Current week [(]all models[)]')" "87"
check "weekly reset"   "$(wu_reset_of "$SAMPLE" 'Current week [(]all models[)]')" "Fri 11:00 AM"
check "session pct"    "$(wu_pct_of "$SAMPLE" 'Current session')" "45"
check "session reset"  "$(wu_reset_of "$SAMPLE" 'Current session')" "Thu 3:59 PM"
check "fable pct"      "$(wu_pct_of "$SAMPLE" 'Current week [(]Fable[)]')" "20"
check "promo"          "$(wu_promo_of "$SAMPLE")" "+50% extra weekly limit through Aug 19"

# Section bounding: the session bar must NOT bleed into the weekly bar (distinct %s).
check "no bleed (session!=weekly)" "$([ "$(wu_pct_of "$SAMPLE" 'Current session')" != "$(wu_pct_of "$SAMPLE" 'Current week [(]all models[)]')" ] && echo distinct)" "distinct"

# Full enriched body.
BODY="$(wu_body "$SAMPLE" "test-note")"
check "body pct"     "$(printf '%s' "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pct"])')" "87"
check "body source"  "$(printf '%s' "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin)["source"])')" "panel"
check "body session" "$(printf '%s' "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["pct"])')" "45"
check "body fable"   "$(printf '%s' "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin)["fable"]["pct"])')" "20"
check "body promo"   "$(printf '%s' "$BODY" | python3 -c 'import json,sys;print("promo" in json.load(sys.stdin))')" "True"

# Fail-closed: a capture WITHOUT the weekly (all models) bar -> wu_body returns non-zero.
NOWEEKLY="$(cat <<'EOF'
 Current session
 ████░░░░  30% used
 Resets Thu 3:59 PM
EOF
)"
if wu_body "$NOWEEKLY" "x" >/dev/null 2>&1; then
  echo "  FAIL: wu_body should reject a capture with no weekly bar"; fails=$((fails + 1))
else
  echo "  ok: fail-closed when weekly bar absent"
fi

# Session-only present, Fable missing -> body has session, no fable key.
SESS_ONLY="$(cat <<'EOF'
 Current session
 ██░░  10% used
 Resets Thu 3:59 PM

 Current week (all models)
 ████  40% used
 Resets Fri 11:00 AM
EOF
)"
BODY2="$(wu_body "$SESS_ONLY" "x")"
check "no-fable omits key" "$(printf '%s' "$BODY2" | python3 -c 'import json,sys;print("fable" in json.load(sys.stdin))')" "False"

if [ "$fails" -eq 0 ]; then echo "PASS (all weekly-usage-parse checks)"; exit 0; else echo "FAILED: $fails check(s)"; exit 1; fi
