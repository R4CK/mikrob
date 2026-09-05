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
# GET /api/agents -- the registry the author check consults (card be81d16c). Served BEFORE the
# kanban branch: the author validation is what most of these cases are about, and a shim that
# answered a card list here would make every author fall back to the sentinel.
case "$url" in
  */api/agents*)
    if [ -n "${AGENTS_UNREADABLE:-}" ]; then exit 22; fi
    printf '%s' '[{"agent_id":"fullstack"},{"agent_id":"backend"},{"agent_id":"qa"},{"agent_id":"mikrob"}]'
    exit 0 ;;
esac
# GET /api/kanban -- one in_progress card per agent the test cares about.
printf '%s' '[{"id":"card-fs","status":"in_progress","assignee":"fullstack"},
              {"id":"card-be","status":"in_progress","assignee":"backend"},
              {"id":"card-gh","status":"in_progress","assignee":"ghost-agent"},
              {"id":"card-qa","status":"in_progress","assignee":"qa"}]'
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

# --- 4. the author restriction is EXPLICIT, not a side effect (card be81d16c) -------------------
# Cybersec's point: the name happened to be constrained only because today's caller looks the card
# up by assignee. That is an accident of one caller, not a rule -- so the rule is stated here.
#
# An UNKNOWN name must not reach a card's audit trail as if it were an agent.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"
state '{"frozen":"fullstack","since":1788000300}'
# The card lookup still resolves (fullstack has a card); the AUTHOR is what we bend, by asking the
# validator directly through a fabricated state whose name is not in the registry.
printf '%s' '{"frozen":"ghost-agent","since":1788000300}' > "$TMP/sigstop.json"
out="$(run 1788000310 2>&1)"
a="$(author_of 'PAUSED-LOAD')"
if [ -n "$a" ] && [ "$a" != "ghost-agent" ]; then
  ok "an UNKNOWN author is replaced (posted as '$a', not 'ghost-agent')"
else
  bad "unknown-author case: posted author was '$a' (empty means NOTHING was posted -- vacuous)" "$(cat "$CAPTURE")"
fi

# An identity that CANNOT have been throttled must not sign a throttle note. MikroB and the gate
# pool are excluded from every mechanism (load-guard-excluded.sh), so such a note would assert
# something impossible.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"
printf '%s' '{"frozen":"qa","since":1788000400}' > "$TMP/sigstop.json"
printf '%s' '{}' > "$TMP/cgroup.json"
out="$(run 1788000410 2>&1)"
a="$(author_of 'PAUSED-LOAD')"
if [ -n "$a" ] && [ "$a" != "qa" ]; then
  ok "an EXCLUDED identity cannot sign a throttle note (posted as '$a', not 'qa')"
else
  bad "excluded-identity case: posted author was '$a' (empty means NOTHING was posted -- vacuous)" "$(cat "$CAPTURE")"
fi

# CONTROL for the two above: a known, throttleable agent IS still written as itself. Without this,
# a validator that rejected everything would satisfy both cases.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"
state '{"frozen":"fullstack","since":1788000500}'
run 1788000510
[ "$(author_of 'PAUSED-LOAD')" = "fullstack" ] \
  && ok "CONTROL: a known, throttleable agent still signs as itself" \
  || bad "the validator rejects a legitimate agent too" "$(cat "$CAPTURE")"

echo
echo "load-guard-bookkeeping.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
