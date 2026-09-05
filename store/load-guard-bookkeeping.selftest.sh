#!/usr/bin/env bash
# Self-test for store/load-guard-bookkeeping.sh's kanban comment AUTHORSHIP (card 9444a7bb).
#
# Run: bash store/load-guard-bookkeeping.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# THE DEFECT: the author was hardcoded "backend", so every PAUSED-LOAD/RESUMED-LOAD note claimed
# backend had been frozen regardless of who actually was. Measured on card 98dbbcc9: 36 notes in
# ~4.5 minutes, all authored "backend", on FULLSTACK's card while fullstack was the SIGSTOPped
# process. Only the attribution was wrong -- the freeze itself targeted correctly -- which is what
# made it survive: nothing about the fleet's behaviour looked broken, only its audit trail lied.
#
# HERMETIC: every state path is overridden (the script already supports that for exactly this
# reason), the dashboard is a `curl` shim on PATH that records what would have been posted, and
# --alert-dryrun keeps Telegram out. Nothing real is read or written.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/load-guard-bookkeeping.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- the fake dashboard -------------------------------------------------------------------------
# Answers the kanban list so a card id resolves, and records every POSTed body verbatim.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'SHIM'
#!/usr/bin/env bash
body=""; is_post=0; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) [ "${2:-}" = "POST" ] && is_post=1; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    -H) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ "$is_post" = "1" ]; then
  printf '%s\n' "$body" >> "$CAPTURE"
  exit 0
fi
# GET /api/kanban -- one in_progress card per agent the test cares about.
printf '%s' '[{"id":"card-fs","status":"in_progress","assignee":"fullstack"},
              {"id":"card-be","status":"in_progress","assignee":"backend"}]'
SHIM
chmod +x "$TMP/bin/curl"
export PATH="$TMP/bin:$PATH"
export CAPTURE="$TMP/posted.jsonl"
: > "$CAPTURE"
printf 'dummy-token\n' > "$TMP/token"

state() { # $1 = json for the sigstop state file
  printf '%s' "$1" > "$TMP/sigstop.json"
  printf '%s' '{}' > "$TMP/cgroup.json"
}
run() {
  DASH="http://127.0.0.1:9" DASHBOARD_TOKEN_FILE="$TMP/token" \
  bash "$RUN" --cgroup-state "$TMP/cgroup.json" --sigstop-state "$TMP/sigstop.json" \
    --paused "$TMP/paused.json" --events "$TMP/events.json" \
    --alert-stamp "$TMP/alert.json" --alert-dryrun --now "$1" >/dev/null 2>&1
}
author_of() { python3 -c '
import json,sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    if sys.argv[2] in d.get("content",""):
        print(d.get("author","")); break
' "$CAPTURE" "$1"; }

# --- 1. PAUSED-LOAD is authored by the agent that was FROZEN -------------------------------------
printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"
state '{"frozen":"fullstack","since":1788000000}'
run 1788000010
a="$(author_of 'PAUSED-LOAD')"
if [ "$a" = "fullstack" ]; then
  ok "PAUSED-LOAD is authored by the frozen agent (fullstack)"
else
  bad "PAUSED-LOAD author is '$a', want 'fullstack'" "$(cat "$CAPTURE")"
fi
# The regression, named: this is the exact value the bug produced.
[ "$a" = "backend" ] && bad "the hardcoded 'backend' author is back" "$(cat "$CAPTURE")" \
  || ok "the note does not claim backend was frozen"

# --- 2. RESUMED-LOAD is authored by the same agent -----------------------------------------------
: > "$CAPTURE"
state '{}'
run 1788000100
a="$(author_of 'RESUMED-LOAD')"
if [ "$a" = "fullstack" ]; then
  ok "RESUMED-LOAD is authored by the agent that was released"
else
  bad "RESUMED-LOAD author is '$a', want 'fullstack'" "$(cat "$CAPTURE")"
fi

# --- 3. a DIFFERENT agent gets its own name, so case 1 is not a constant --------------------------
# Without this, an author hardcoded to "fullstack" would satisfy everything above.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"
state '{"frozen":"backend","since":1788000200}'
run 1788000210
a="$(author_of 'PAUSED-LOAD')"
if [ "$a" = "backend" ]; then
  ok "a genuinely frozen backend IS authored backend -- the field follows the agent, not a constant"
else
  bad "author is '$a', want 'backend' for a real backend freeze" "$(cat "$CAPTURE")"
fi

echo
echo "load-guard-bookkeeping.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
