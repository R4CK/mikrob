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
    --paused "$TMP/paused.json" --events "$TMP/events.json" --episodes "$TMP/episodes.json" \
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
# TWO POLLS, NOT ONE (card 16e11afb): the pause-start note is no longer immediate -- see the module
# header -- the FIRST poll only records the episode silently, and the heartbeat check that fires
# the first real note needs a PRIOR poll to measure elapsed time against. A single poll jumped
# straight to t+250 would still see a brand-new episode and stay silent. Authorship, which is this
# case's actual subject, is unaffected by when the note fires.
printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{"frozen":"fullstack","since":1788000000}'
run 1788000000
run 1788000250
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
# TIMING CHANGED IN CARD 9c6b1802, AND THE CHANGE IS THE POINT, so it is written here rather than
# quietly absorbed: the resume note is now the end of an EPISODE, not the end of one freeze cycle.
# A release is no longer news by itself, because sigstop_freeze is capped at 90s and therefore
# releases constantly under sustained load -- that cap is what produced 988 of the 1082 pause
# notes on the live board. So this case now drives the episode to its actual end. What it asserts
# is UNCHANGED and is the reason the case exists: the note carries the released agent as author.
# SELF-CONTAINED (card 16e11afb): this used to continue case 1's state; it now sets its own, so
# case 1's probe timing (moved past the heartbeat window) cannot make `now` run backwards here.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{"frozen":"fullstack","since":1788000000}'
run 1788000100
a="$(author_of 'RESUMED-LOAD')"
if [ -z "$a" ]; then
  ok "a mere release posts NO resume note yet -- the episode has not lapsed"
else
  bad "a resume note fired 90s into an open episode (author '$a')" "$(cat "$CAPTURE")"
fi

# now let the episode lapse (episode_gap defaults to 300s) and the note must appear. Gap measured
# from the LAST tick that saw it paused (t=100, set at that poll), so the lapse probe has to clear
# 100+300=400 -- 450 gives clean margin over the boundary.
state '{}'
run 1788000450
a="$(author_of 'RESUMED-LOAD')"
if [ "$a" = "fullstack" ]; then
  ok "RESUMED-LOAD is authored by the agent that was released"
else
  bad "RESUMED-LOAD author is '$a', want 'fullstack'" "$(cat "$CAPTURE")"
fi

# --- 3. a DIFFERENT agent gets its own name, so case 1 is not a constant --------------------------
# Without this, an author hardcoded to "fullstack" would satisfy everything above.
# TWO POLLS (card 16e11afb): same reason as case 1 -- the first records the episode silently.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{"frozen":"backend","since":1788000200}'
run 1788000200
run 1788000450
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
# TWO POLLS (card 16e11afb): same reason as case 1. The mock kanban carries a card for ghost-agent
# too (card-gh), so this can run natively as ghost-agent from the first tick -- no need for the
# fullstack-then-swap trick the pre-16e11afb version used only to get a resolvable card.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{"frozen":"ghost-agent","since":1788000300}'
run 1788000300
out="$(run 1788000560 2>&1)"
a="$(author_of 'PAUSED-LOAD')"
if [ -n "$a" ] && [ "$a" != "ghost-agent" ]; then
  ok "an UNKNOWN author is replaced (posted as '$a', not 'ghost-agent')"
else
  bad "unknown-author case: posted author was '$a' (empty means NOTHING was posted -- vacuous)" "$(cat "$CAPTURE")"
fi

# An identity that CANNOT have been throttled must not sign a throttle note. MikroB and the gate
# pool are excluded from every mechanism (load-guard-excluded.sh), so such a note would assert
# something impossible.
# TWO POLLS (card 16e11afb): same reason as case 1.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
printf '%s' '{"frozen":"qa","since":1788000400}' > "$TMP/sigstop.json"
printf '%s' '{}' > "$TMP/cgroup.json"
run 1788000400
out="$(run 1788000650 2>&1)"
a="$(author_of 'PAUSED-LOAD')"
if [ -n "$a" ] && [ "$a" != "qa" ]; then
  ok "an EXCLUDED identity cannot sign a throttle note (posted as '$a', not 'qa')"
else
  bad "excluded-identity case: posted author was '$a' (empty means NOTHING was posted -- vacuous)" "$(cat "$CAPTURE")"
fi

# CONTROL for the two above: a known, throttleable agent IS still written as itself. Without this,
# a validator that rejected everything would satisfy both cases.

# --- 8. THE FLAPPING COLLAPSE, which is what card 9c6b1802 is about -------------------------------
# sigstop_freeze is capped at max_freeze_seconds (90 by config), so under sustained load it freezes,
# hits the cap, releases into a still-loaded machine and refreezes. Measured on the live board:
# 988 of 1082 pause-starts were sigstop_freeze, median dwell 10s, and card fe5d7967 carried 342 of
# its 353 comments as these notes. Under the OLD rule each cycle posted a pair, so this scenario --
# 15 cycles -- cost 30 comments. The episode rule must cost far less while still saying it is
# happening.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
t=1788100000
for i in $(seq 1 15); do
  state '{"frozen":"backend","since":1788100000}'; run "$t"; t=$((t+10))
  state '{}';                                      run "$t"; t=$((t+10))
done
posted=$(grep -c . "$CAPTURE" 2>/dev/null || echo 0)
if [ "$posted" -lt 10 ]; then
  ok "15 freeze cycles cost $posted notes, not the 30 the per-transition rule charged"
else
  bad "flapping still costs $posted notes for 15 cycles" "$(cat "$CAPTURE")"
fi
# ...and it must not go SILENT: the episode was announced.
if grep -q 'PAUSED-LOAD' "$CAPTURE"; then
  ok "the episode is still announced -- quieter, not invisible"
else
  bad "flapping produced no note at all" "$(cat "$CAPTURE")"
fi

# --- 9. THE HEARTBEAT BOUND is a SAFETY property, not cosmetics -----------------------------------
# The note also moves the card updated_at field. The stuck-card-monitor excludes agents listed in
# load-paused-agents.json, but an agent flapping in and out of that set can be sampled while
# ADMITted, and then only updated_at stands between it and a 10-minute stuck verdict. So a
# CONTINUOUSLY paused agent must keep producing a note well inside that window.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{"frozen":"backend","since":1788200000}'
t=1788200000
for i in $(seq 1 12); do run "$t"; t=$((t+50)); done   # 600s of continuous freeze
# UPDATED (card 16e11afb): the first note is now deferred until the episode has already run
# `heartbeat` seconds, so a 600s freeze posts its first note around t=250s, not t=0. The safety
# property this case pins -- no gap between notes wider than the stuck-monitor window -- still
# holds: notes fire at ~250s and ~500s here, both comfortably under the 600s threshold. 2, not 3,
# is the correct count now; the property is the GAP, never the raw count.
beats=$(grep -c 'PAUSED-LOAD' "$CAPTURE" 2>/dev/null || echo 0)
if [ "$beats" -ge 2 ]; then
  ok "a 600s continuous freeze still posts $beats notes, so updated_at never goes 600s stale"
else
  bad "only $beats note(s) in a 600s freeze -- the stuck-monitor budget is not covered" "$(cat "$CAPTURE")"
fi

# --- 10. THE FIX ITSELF (card 16e11afb): a short, non-flapping pause gets ONLY the end note -------
# Was: "CONTROL: one long, non-flapping pause is still exactly one start and one end" -- that was
# the OLD promise, deliberately reversed here rather than edited in place (same convention as this
# file's own cases 2 and 9 above): a 120s pause never reaches the heartbeat window, so the start
# note this case used to require is now precisely the noise card 16e11afb measured (34 of 36
# comments on card 5e4e629f) and must NOT fire. RESUMED-LOAD alone already reports the full episode.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{"frozen":"backend","since":1788300000}'
run 1788300000
run 1788300060
state '{}'
run 1788300120
run 1788300500                                  # lapse: 380s after the last activity
# `grep -c` exits 1 on zero matches, so `|| echo 0` would emit BOTH the (zero) count and the
# fallback -- the exact bug this file's own script header documents elsewhere. `|| true` plus a
# defaulted expansion avoids it, needed here because this is the first case in this suite that
# legitimately expects a zero count.
starts_n=$(grep -c 'PAUSED-LOAD' "$CAPTURE" 2>/dev/null || true); starts_n="${starts_n:-0}"
ends_n=$(grep -c 'RESUMED-LOAD' "$CAPTURE" 2>/dev/null || true); ends_n="${ends_n:-0}"
if [ "$starts_n" = "0" ] && [ "$ends_n" = "1" ]; then
  ok "a short (120s, sub-heartbeat) pause posts ONLY the end note, no start/heartbeat noise"
else
  bad "short pause posted $starts_n start/heartbeat note(s) and $ends_n end(s), want 0 and 1" "$(cat "$CAPTURE")"
fi

# --- 11. the end note CARRIES the cycle count, which the old pair never did -----------------------
if grep -q 'ciklusb' "$CAPTURE"; then
  ok "the resume note reports how many cycles the episode contained"
else
  bad "the resume note does not name the cycle count" "$(cat "$CAPTURE")"
fi

# TWO POLLS (card 16e11afb): same reason as case 1.
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{"frozen":"fullstack","since":1788000500}'
run 1788000500
run 1788000750
[ "$(author_of 'PAUSED-LOAD')" = "fullstack" ] \
  && ok "CONTROL: a known, throttleable agent still signs as itself" \
  || bad "the validator rejects a legitimate agent too" "$(cat "$CAPTURE")"

# --- 12. a MISSING load-guard-excluded.sh must SPEAK, not silently drop the exclusion (card c5baa683) --
# Before: `. "$SCRIPT_DIR/load-guard-excluded.sh" 2>/dev/null || true` swallowed a missing/broken
# file with no trace. is_excluded() then never gets defined, the gate-pool exclusion check is
# skipped, and _valid_author() falls through to the known-agent registry -- which happily accepts
# "qa"/"cybersec"/"cybered" as real authors again, reopening exactly what card be81d16c closed,
# only quietly this time. The presence check below is on the STDERR TEXT, not on the file's
# existence, per this card's own acceptance criterion.
REAL_EXCLUDED="$HERE/load-guard-excluded.sh"
MOVED_EXCLUDED="$TMP/load-guard-excluded.sh.moved-aside"
mv "$REAL_EXCLUDED" "$MOVED_EXCLUDED"
trap 'mv -f "$MOVED_EXCLUDED" "$REAL_EXCLUDED" 2>/dev/null; rm -rf "$TMP"' EXIT

: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{}'
STDERR_FILE="$TMP/stderr-missing.txt"
DASH="http://127.0.0.1:9" DASHBOARD_TOKEN_FILE="$TMP/token" \
  bash "$RUN" --cgroup-state "$TMP/cgroup.json" --sigstop-state "$TMP/sigstop.json" \
    --paused "$TMP/paused.json" --events "$TMP/events.json" --episodes "$TMP/episodes.json" \
    --alert-stamp "$TMP/alert.json" --alert-dryrun --now 1788400000 \
    >/dev/null 2>"$STDERR_FILE"
rc=$?
if [ "$rc" = "0" ]; then
  ok "a missing load-guard-excluded.sh still exits 0 (|| true semantics kept)"
else
  bad "exit code was $rc, want 0" "$(cat "$STDERR_FILE")"
fi
if grep -q 'load-guard-excluded.sh could not be loaded' "$STDERR_FILE"; then
  ok "the missing file is announced on stderr, not swallowed"
else
  bad "no warning on stderr for a missing load-guard-excluded.sh" "$(cat "$STDERR_FILE")"
fi

# --- 13. CONTROL: with the file back in place, the normal path is unchanged (no new noise) --------
mv -f "$MOVED_EXCLUDED" "$REAL_EXCLUDED"
: > "$CAPTURE"; printf '%s' '{}' > "$TMP/paused.json"; printf '%s' '{}' > "$TMP/events.json"; printf '%s' '{}' > "$TMP/episodes.json"
state '{}'
STDERR_FILE="$TMP/stderr-present.txt"
DASH="http://127.0.0.1:9" DASHBOARD_TOKEN_FILE="$TMP/token" \
  bash "$RUN" --cgroup-state "$TMP/cgroup.json" --sigstop-state "$TMP/sigstop.json" \
    --paused "$TMP/paused.json" --events "$TMP/events.json" --episodes "$TMP/episodes.json" \
    --alert-stamp "$TMP/alert.json" --alert-dryrun --now 1788400010 \
    >/dev/null 2>"$STDERR_FILE"
rc=$?
if [ "$rc" = "0" ] && ! grep -q 'load-guard-excluded.sh could not be loaded' "$STDERR_FILE"; then
  ok "CONTROL: with the file present, no missing-file warning fires"
else
  bad "CONTROL failed: rc=$rc" "$(cat "$STDERR_FILE")"
fi
trap 'rm -rf "$TMP"' EXIT

echo
echo "load-guard-bookkeeping.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
