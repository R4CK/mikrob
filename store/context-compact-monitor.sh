#!/usr/bin/env bash
# context-compact-monitor.sh -- keep the big agents' context off the ceiling (card 9f74a0da).
#
# WHY, with the measurement behind it (card bb7276e7 PART3 + this card):
#   * The fleet's prompt-cache hit rate is 98.4%. Cache-busting is NOT the quota problem.
#   * The cost is the VOLUME of context re-read: 49.3B cache-read tokens. backend/fullstack/cybered
#     average 450-480k per call and run to the ~1M ceiling; qa sits at 119k doing comparable work.
#   * Two tempting fixes were measured and REJECTED before this one:
#       - "sessions are too long" -> false: qa runs 4x more calls per session at 1/4 the context.
#       - "trim big tool outputs"  -> false: median tool result is 269 chars, and everything over
#         20k chars is 4% of volume. There are no whales to harpoon.
#     What remains is periodic /compact: it does not shave individual results, it resets the
#     CARRIED context -- which is the accumulation the measurement actually found.
#
# WHAT IT DOES: reads each agent's most recent context size from the token_usage table (already
# populated from the Claude Code transcripts by src/web/token-usage.ts), and sends `/compact` to the
# tmux session of any TARGET agent above the threshold.
#
# ANTI-BURN. A /compact is not free -- it costs a summarisation pass -- so spamming it would trade
# one waste for another. Guards, in order:
#   1. only TARGET_AGENTS (the ceiling-runners), never the whole fleet;
#   2. only above the threshold, which is COMPACT_PCT% of that agent model context window
#      (Peti rule, CLAUDE.md 2026-08-14) -- derived per agent, never a fixed token count;
#   3. a per-agent COOLDOWN, so a still-large context right after a compact does not re-trigger;
#   4. --dry-run, which is what a scheduled task should use first.
# NOTE: this deliberately does NOT go through store/redispatch-guard.sh -- that guard is keyed by
# cardId and exists to stop an agent being made to REDO work. A /compact is agent-keyed and adds no
# work. The cooldown below is the equivalent control for this shape. Flagged for review.
#
# Usage:
#   context-compact-monitor.sh --dry-run     # report what it WOULD do (safe, no side effects)
#   context-compact-monitor.sh               # act
#   context-compact-monitor.sh --selftest    # verify the decision logic, no DB/tmux needed
#
# Exit: 0 ok | 2 bad usage | 3 environment problem
set -uo pipefail

ROOT="/home/neon/marveen"
DB="$ROOT/store/claudeclaw.db"
STATE="$ROOT/store/context-compact-state.json"
LOG="$ROOT/store/context-compact-monitor.log"

# Ceiling-runners only (measured 2026-08-06). qa/fron-teddy are already at target and must not be
# touched -- compacting an agent that is not the problem is pure cost.
#
# mikrob is EXCLUDED by default despite carrying the largest context (632k measured). It is the
# orchestrator: it dispatches, gates and answers Peti, and a mid-flight compact there disturbs the
# whole fleet rather than one worker. Opt it in deliberately via COMPACT_TARGET_AGENTS if wanted.
TARGET_AGENTS="${COMPACT_TARGET_AGENTS:-backend backend2 fullstack cybered cybersec}"

# THRESHOLD IS A PERCENTAGE OF THE MODEL CONTEXT WINDOW, NOT A TOKEN COUNT (Peti rule, CLAUDE.md
# 2026-08-14, commit 4f315c8; card 35533cca). A fixed token count means something different on every
# model, which is the whole reason the rule is phrased as a percentage.
#
# THE WINDOW COMES FROM THE FLEET'S OWN FUNCTION, NOT FROM A TABLE HERE (Cybered NO-GO, comment
# 11790, finding 3). My first cut hand-listed opus-5 / sonnet-5 / sonnet-4-6 as 1M each, generalising
# from sessions measured on OPUS. src/context-guard.ts already answers this question with evidence
# and says otherwise: sonnet is 200k ("this host has never observed a sonnet session above 198k;
# sonnet-5 max 197,885 across 14 days"), and its default for an unknown model is 200k, not 1M. So my
# table would have set a 750k trigger on a 200k-window model -- unreachable, meaning a sonnet session
# would NEVER be compacted and would run into its real ceiling. That is precisely the freeze this
# card exists to prevent, introduced by the fix for it. backend alone made 1704 sonnet-4-6 calls in
# the 24h before this was caught.
#
# So: call contextLimitForModel from dist. One definition, already tested, already calibrated from
# this host's transcripts. If dist cannot be read we fall back to its own conservative default
# (200k) rather than to the largest window -- under-estimating compacts too eagerly, which is loud
# and cheap; over-estimating is silent and ends in the ceiling.
COMPACT_PCT="${COMPACT_PCT:-75}"
CONTEXT_GUARD_JS="${CONTEXT_GUARD_JS:-$ROOT/dist/context-guard.js}"
window_tokens_for_model() {
  local w
  w="$(node -e '
import(process.argv[1]).then(m => console.log(m.contextLimitForModel(process.argv[2] || null)))
  .catch(() => process.exit(1))
' "$CONTEXT_GUARD_JS" "$1" 2>/dev/null)"
  case "$w" in (''|*[!0-9]*) echo 200000 ;; (*) echo "$w" ;; esac
}
# The live threshold, as its own function so the selftest exercises the SAME arithmetic the loop
# uses rather than a copy of it -- put a token constant back anywhere in this chain and the
# derived-value cases go red.
threshold_tokens_for_model() { echo $(( $(window_tokens_for_model "$1") * COMPACT_PCT / 100 )); }
COOLDOWN_MIN="${COMPACT_COOLDOWN_MIN:-45}"
# Only trust a reading this fresh; a stale row means the agent is parked, and compacting a parked
# session wakes it up for nothing.
MAX_AGE_MIN="${COMPACT_MAX_AGE_MIN:-20}"

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  --selftest) ;;
  "") ;;
  -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
  *) echo "context-compact-monitor.sh: unknown argument '$1'" >&2; exit 2 ;;
esac

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
# The dry-run prints to stdout, which the scheduled task redirects into the SAME log -- and until now
# without a timestamp, so 978 of the log's 989 lines could not be ordered or correlated with anything
# (Cybered NO-GO, finding 4). Evidence a control depends on has to be datable.
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# --- decision logic, isolated so the selftest can exercise it without a DB or tmux -------------
# should_compact <ctx_k> <threshold_k> <age_min> <max_age_min> <mins_since_last> <cooldown_min>
should_compact() {
  local ctx="$1" thr="$2" age="$3" maxage="$4" since="$5" cool="$6"
  [ "$ctx" -ge "$thr" ] || { echo "below-threshold"; return 1; }
  [ "$age" -le "$maxage" ] || { echo "stale-reading"; return 1; }
  [ "$since" -ge "$cool" ] || { echo "cooldown"; return 1; }
  echo "compact"; return 0
}

# --- cooldown state: read once, FAIL CLOSED on damage (Cybered, card 9f74a0da comment 8232) ------
# The old inline read swallowed every exception into last=0, which made since_min enormous and
# silently switched the cooldown off for EVERY agent -- the anti-burn control disappearing exactly
# when its own state got corrupted. Keep one asymmetry: a VALID state with no entry for an agent
# still means "never compacted" and is allowed to act; only a file we cannot parse is a fault.
#
# On a fault we do not just skip and leave the file damaged -- that would make the monitor silently
# dead, which is the 8-day failure this card exists to fix. We quarantine the damaged file and stamp
# every target agent with NOW: the most conservative reading available (as if all had just been
# compacted). This round is skipped; normal operation resumes after one full cooldown.
#
# Both helpers read $STATE at call time, so the selftest can point them at a throwaway file.
STATE_JSON='{}'

# state_put <json> <agent> <epoch> -> prints the updated json, having written it ATOMICALLY.
# temp file in the same directory + fsync + os.replace: an interrupted run can no longer leave the
# half-written file that the fail-closed path above has to defend against.
state_put() {
  python3 - "$STATE" "$1" "$2" "$3" <<'PY'
import json, os, stat, sys, tempfile
path, payload, agent, stamp = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
data = json.loads(payload)
data[agent] = stamp
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or '.',
                           prefix='.context-compact-state.', suffix='.tmp')
try:
    with os.fdopen(fd, 'w') as fh:
        json.dump(data, fh)
        fh.flush()
        os.fsync(fh.fileno())
    # Carry the existing mode over (Cybered NO-GO, finding 5). mkstemp creates 0600 and os.replace
    # takes the temp file's mode with it, so an atomic write silently tightened 0664 -> 0600. Here
    # that was a hardening, but a write that changes permissions as a side effect is a surprise
    # waiting for the first other process that has to read the file; preserving it costs one call.
    try:
        os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
    except OSError:
        pass          # no existing file (first run) -> mkstemp's 0600 is the right default
    os.replace(tmp, path)
except BaseException:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
print(json.dumps(data))
PY
}

# read_state -> "OK <json>" or "ERR <reason>". An absent file is a first run, not corruption.
read_state() {
  python3 - "$STATE" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError('state is not a JSON object')
except FileNotFoundError:
    print('OK {}')
except Exception as exc:
    print('ERR ' + str(exc).replace('\n', ' '))
else:
    print('OK ' + json.dumps(data))
PY
}

# read_agent_ctx <db> <agent> <now> -> "<context_tokens> <timestamp> <model>" for that agent's newest
# real call, or nothing. Its own function so the selftest can run it against a fixture DB -- the query
# was the one part of this script no case covered, and it was where the worst bug lived.
#
# ONE ROW (Cybered NO-GO, comment 11790, finding 1). It used to be
#   SELECT MAX(cache_read_tokens) ... || MAX(timestamp) ... WHERE agent=? AND timestamp > now-7200
# -- two INDEPENDENT aggregates over a 2h window that spans session restarts. The size could come
# from a dead session's peak while the timestamp came from a fresh row, and the staleness gate, seeing
# only the fresh timestamp, waved it through. Cybered measured 71 such 15-minute ticks in 7 days, the
# worst pairing a ~998k peak with a live context of 0-19k. The consequence chain is the opposite of
# this card's purpose: a pointless compact on a just-restarted agent, then a 45-minute cooldown stamp
# that suppresses the REAL compact while the session actually grows.
#
# THE FULL CONTEXT, NOT THE CACHE-READ PROXY (same NO-GO, finding 3). cache_read_tokens is
# cache_read_input_tokens alone: it omits the uncached prefix and the newly-cached segment, so a
# percentage of it is not a percentage of the window. The prompt size of a call is
# input + cache_read + cache_creation -- which is what src/web/active-model.ts
# (readContextTokensFromProjectDir) computes from the transcript, and what token-usage.ts itself
# already treats as context size (its minTokens filter and per-call totals).
#
# NEWEST NON-ZERO ROW: bookkeeping rows carry zeros, and a zero is not a measurement. Same rule as
# readContextTokensFromProjectDir, which walks back to the last usage line with a positive total.
read_agent_ctx() {
  sqlite3 "$1" "SELECT (input_tokens + cache_read_tokens + cache_creation_tokens) || ' ' ||
                       timestamp || ' ' ||
                       CASE WHEN model IS NULL OR model IN ('', '<synthetic>') THEN '?' ELSE model END
                FROM token_usage
                WHERE agent='$2' AND timestamp > $(( $3 - 7200 ))
                  AND (input_tokens + cache_read_tokens + cache_creation_tokens) > 0
                ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null
}

# cooldown_stamp <json> <agent> -> that agent's last-compact epoch, or ERR if it is not a timestamp.
# A missing key in a valid state is 0 ("never compacted"), which is allowed to act; anything that is
# not a plain non-negative number is a fault, because defaulting it to 0 is what dropped the cooldown.
cooldown_stamp() {
  python3 -c "
import json, sys
v = json.loads(sys.argv[1]).get(sys.argv[2], 0)
print(int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else 'ERR')
" "$1" "$2" 2>/dev/null || echo ERR
}

# Quarantine-counter helpers (card 208ad121). Defined here, ahead of the selftest block below, so
# the selftest can exercise them the same way it exercises read_state/state_put/cooldown_stamp --
# the WHY (this counter exists to survive a shared-cause corruption hitting BOTH the cooldown state
# and this counter at once) is documented at the QUARANTINE TRIPWIRE comment further down, where the
# counter is actually used.
QUARANTINE_COUNT_FILE="${COMPACT_QUARANTINE_FILE:-$ROOT/store/.context-compact-quarantines}"

# read_quarantine_count -> "OK <n>" or "ERR <reason>", same OK/ERR convention as read_state. An
# absent file is a first run (0), not corruption. A PRESENT but unparseable file is now a FAULT, not
# silently 0 -- the old `case ... *[!0-9]*) echo 0` treated a damaged counter exactly like a healthy
# fresh one, which is the same fail-open shape the cooldown state itself had before Cybered's
# comment 8232 fix.
read_quarantine_count() {
  python3 -c "
import sys
try:
    with open(sys.argv[1]) as fh:
        raw = fh.read().strip()
except FileNotFoundError:
    print('OK 0'); sys.exit(0)
except Exception as exc:
    print('ERR ' + str(exc).replace(chr(10), ' ')); sys.exit(0)
print(('OK ' + raw) if raw.isdigit() else ('ERR not-a-non-negative-integer: ' + repr(raw)[:80]))
" "$QUARANTINE_COUNT_FILE" 2>/dev/null || echo "ERR read_quarantine_count crashed"
}

# write_quarantine_count <n> -- ATOMIC: same tempfile-in-same-dir + fsync + os.replace + mode-
# preservation pattern as state_put, for the same reason -- a truncating `echo N > file` can leave a
# half-written (hence unparseable-next-read) file on a crash, which is exactly the damage this
# tripwire exists to detect, so the tripwire's OWN write must not be able to cause it.
write_quarantine_count() {
  python3 - "$QUARANTINE_COUNT_FILE" "$1" <<'PY'
import os, stat, sys, tempfile
path, n = sys.argv[1], sys.argv[2]
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or '.',
                           prefix='.context-compact-quarantines.', suffix='.tmp')
try:
    with os.fdopen(fd, 'w') as fh:
        fh.write(n)
        fh.flush()
        os.fsync(fh.fileno())
    try:
        os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
    except OSError:
        pass          # no existing file (first run) -> mkstemp's 0600 is the right default
    os.replace(tmp, path)
except BaseException:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
}

if [ "${1:-}" = "--selftest" ]; then
  fails=0
  t() { # t <expect> <args...>
    local want="$1"; shift
    local got; got="$(should_compact "$@")"
    if [ "$got" != "$want" ]; then echo "FAIL: want=$want got=$got args=$*"; fails=$((fails+1)); fi
  }
  t compact          400 350 5 20 60 45   # over threshold, fresh, cooled down
  t below-threshold  300 350 5 20 60 45   # under threshold
  t below-threshold  349 350 5 20 60 45   # boundary: strictly below stays put
  t compact          350 350 5 20 60 45   # boundary: at threshold acts
  t stale-reading    400 350 99 20 60 45  # agent parked -> do not wake it
  t cooldown         400 350 5 20 10 45   # compacted recently
  t compact          400 350 5 20 45 45   # boundary: cooldown exactly elapsed

  # --- cooldown-state layer (Cybered comment 8232: fail-open cooldown + non-atomic write) -------
  # The seven cases above only ever exercised should_compact's arithmetic. They stayed green while
  # the state file -- the thing that FEEDS the `since` argument -- silently degraded the cooldown to
  # a no-op. These cases test that input.
  s() { # s <label> <expect> <got>
    if [ "$3" != "$2" ]; then echo "FAIL: $1 want=[$2] got=[$3]"; fails=$((fails+1)); fi
  }
  s_err() { # s_err <label> <got> -- an ERR verdict; read_state appends a reason, cooldown_stamp does not
    case "$2" in ERR|ERR\ *) ;; *) echo "FAIL: $1 want=[ERR...] got=[$2]"; fails=$((fails+1)) ;; esac
  }
  sttmp="$(mktemp -d)"
  trap 'rm -rf "$sttmp"' EXIT
  STATE="$sttmp/state.json"

  s     "absent-state-is-a-first-run-not-corruption" "OK {}"                   "$(read_state)"
  printf '{"backend": 1700000000}' > "$STATE"
  s     "valid-state-parses"        'OK {"backend": 1700000000}'               "$(read_state)"
  printf '{"backend": 17000'        > "$STATE"   # what a truncated write leaves behind
  s_err "truncated-state-is-a-fault"                                           "$(read_state)"
  : > "$STATE"                                   # and what an interrupted one leaves behind
  s_err "empty-state-is-a-fault"                                               "$(read_state)"
  printf '[]'                       > "$STATE"
  s_err "non-object-state-is-a-fault"                                          "$(read_state)"

  s "missing-agent-in-a-valid-state-means-never-compacted" "0" \
    "$(cooldown_stamp '{"other": 1700000000}' backend)"
  s "present-agent-returns-its-stamp"      "1700000000" \
    "$(cooldown_stamp '{"backend": 1700000000}' backend)"
  s_err "non-numeric-stamp-is-a-fault"     "$(cooldown_stamp '{"backend": "soon"}' backend)"
  s_err "negative-stamp-is-a-fault"        "$(cooldown_stamp '{"backend": -5}' backend)"
  s_err "unparseable-payload-is-a-fault"   "$(cooldown_stamp '{"backend"' backend)"

  # ATOMICITY DISCRIMINATOR. A read-only state file in a writable directory: os.replace only needs
  # write permission on the DIRECTORY, so the atomic write goes through, while the old truncating
  # open(path,'w') fails with EACCES. Put that write back and this case turns RED -- that mutation,
  # not a green suite, is what makes the case evidence. Skipped as root, which ignores the mode.
  if [ "$(id -u)" != "0" ]; then
    printf '{"backend": 1}' > "$STATE"; chmod 400 "$STATE"
    s "atomic-write-survives-a-read-only-state-file" '{"backend": 1786700000}' \
      "$(state_put '{"backend": 1}' backend 1786700000 2>/dev/null)"
    chmod 600 "$STATE" 2>/dev/null
    s "atomic-write-actually-landed-on-disk"         '{"backend": 1786700000}' "$(cat "$STATE")"
  else
    echo "NOTE: running as root, skipping the read-only-file atomicity case"
  fi
  s "atomic-write-leaves-no-temp-debris" "0" \
    "$(find "$sttmp" -name '.context-compact-state.*.tmp' | wc -l)"

  # --- PERCENTAGE THRESHOLD (Peti rule, CLAUDE.md 2026-08-14; card 35533cca) --------------------
  # The trigger is COMPACT_PCT% of the model context window, derived per agent, never a token
  # constant. Put a fixed number back in place of the derivation and the two derived-value cases
  # below go red -- which is the whole point of pinning the arithmetic rather than the outcome.
  # The window comes from the fleet's own contextLimitForModel, so these assert AGREEMENT with it,
  # not a private table. My first cut listed sonnet as 1M and would have set an unreachable 750k
  # trigger on a 200k model -- a sonnet session would never have been compacted at all.
  s "opus-5 is a 1M-window model"        "1000000" "$(window_tokens_for_model claude-opus-5)"
  s "sonnet-5 is 200k, NOT 1M"           "200000"  "$(window_tokens_for_model claude-sonnet-5)"
  s "sonnet-4-6 is 200k, NOT 1M"         "200000"  "$(window_tokens_for_model claude-sonnet-4-6)"
  s "an unknown model is conservative"   "200000"  "$(window_tokens_for_model claude-future-9)"
  s "an unreadable dist falls back small" "200000" \
    "$(CONTEXT_GUARD_JS=/nonexistent/context-guard.js window_tokens_for_model claude-opus-5)"
  s "75% of a 1M window"    "750000" "$(threshold_tokens_for_model claude-opus-5)"
  s "75% of a 200k window"  "150000" "$(threshold_tokens_for_model claude-sonnet-5)"
  s "the percentage is overridable" "500000" "$(COMPACT_PCT=50 threshold_tokens_for_model claude-opus-5)"
  # And the derived number has to be the one the decision actually uses, at its boundary.
  s "at the derived threshold it acts"     "compact"         "$(should_compact 750000 750000 5 20 60 45)"
  s "one below the derived threshold it does not" "below-threshold" "$(should_compact 749999 750000 5 20 60 45)"
  # The old constant must no longer be able to trigger on its own.
  s "the old 350k constant is below the derived threshold" "below-threshold" \
    "$(should_compact 350000 750000 5 20 60 45)"

  # --- THE QUERY (Cybered NO-GO finding 1) -----------------------------------------------------
  # A fixture DB with TWO sessions inside the same 2h window: a dead one that peaked at 998k and a
  # fresh one sitting at 20k. That is the real 2026-08-13 cybered shape. The old two-aggregate query
  # paired the dead peak with the fresh timestamp; the reader must return the FRESH row, whole.
  qdb="$sttmp/usage.db"
  sqlite3 "$qdb" "CREATE TABLE token_usage (agent TEXT, session_id TEXT, timestamp INTEGER,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0, model TEXT);" 2>/dev/null
  qnow=2000000000
  sqlite3 "$qdb" "INSERT INTO token_usage VALUES
    ('cybered','dead', $((qnow-3600)), 1000, 0, 990000, 7000, 'claude-opus-5'),
    ('cybered','live', $((qnow-60)),    500, 0,  19000,  500, 'claude-opus-5'),
    ('backend','live', $((qnow-120)),  2000, 0, 300000, 1000, 'claude-sonnet-4-6');" 2>/dev/null
  s "two sessions: the FRESH row wins, not the dead peak" "20000 $((qnow-60)) claude-opus-5" \
    "$(read_agent_ctx "$qdb" cybered "$qnow")"
  s "context is input+cache_read+cache_creation, not cache_read alone" "303000 $((qnow-120)) claude-sonnet-4-6" \
    "$(read_agent_ctx "$qdb" backend "$qnow")"
  # A zero-total bookkeeping row must not become the reading, and must not shadow a real one.
  sqlite3 "$qdb" "INSERT INTO token_usage VALUES ('cybered','live', $((qnow-30)), 0,0,0,0, '<synthetic>');" 2>/dev/null
  s "a zero-total row is not a measurement" "20000 $((qnow-60)) claude-opus-5" \
    "$(read_agent_ctx "$qdb" cybered "$qnow")"
  # Outside the 2h window there is nothing to report -- an empty answer, not a stale one.
  s "nothing inside the window -> empty" "" "$(read_agent_ctx "$qdb" cybered "$((qnow + 100000))")"

  # --- QUARANTINE COUNTER: fail-closed read + atomic write (card 208ad121, Cybered NO-GO finding 2) -
  # Same OK/ERR convention and same atomicity discriminator as the cooldown state above, applied to
  # the counter that exists specifically to survive a shared-cause corruption hitting BOTH files.
  QUARANTINE_COUNT_FILE="$sttmp/quarantines"
  s     "absent-counter-is-a-first-run-not-corruption" "OK 0" "$(read_quarantine_count)"
  printf '3' > "$QUARANTINE_COUNT_FILE"
  s     "valid-counter-parses"          "OK 3" "$(read_quarantine_count)"
  printf 'soon'                       > "$QUARANTINE_COUNT_FILE"
  s_err "non-numeric-counter-is-a-fault"                                      "$(read_quarantine_count)"
  printf -- '-5'                      > "$QUARANTINE_COUNT_FILE"
  s_err "negative-counter-is-a-fault"                                         "$(read_quarantine_count)"
  : > "$QUARANTINE_COUNT_FILE"
  s_err "empty-counter-is-a-fault"                                            "$(read_quarantine_count)"
  rm -f "$QUARANTINE_COUNT_FILE"

  write_quarantine_count 7
  s "atomic-write-actually-landed-on-disk-too" "OK 7" "$(read_quarantine_count)"
  s "atomic-write-leaves-no-temp-debris-either" "0" \
    "$(find "$sttmp" -name '.context-compact-quarantines.*.tmp' | wc -l)"

  if [ "$(id -u)" != "0" ]; then
    printf '1' > "$QUARANTINE_COUNT_FILE"; chmod 400 "$QUARANTINE_COUNT_FILE"
    write_quarantine_count 9 2>/dev/null
    chmod 600 "$QUARANTINE_COUNT_FILE" 2>/dev/null
    s "atomic-write-survives-a-read-only-counter-file" "OK 9" "$(read_quarantine_count)"
  else
    echo "NOTE: running as root, skipping the read-only-file atomicity case (counter)"
  fi

  [ "$fails" -eq 0 ] && { echo "selftest OK (43 cases)"; exit 0; } || { echo "selftest FAILED: $fails"; exit 1; }
fi

[ -r "$DB" ] || { echo "context-compact-monitor.sh: cannot read $DB" >&2; exit 3; }

# The dashboard header file is built HERE, before the state read, because the quarantine branch
# below has to be able to raise an alarm -- not only because the token-usage refresh further down
# needs it. Token from a 0600 header file, never argv.
TOKEN_FILE="$ROOT/store/.dashboard-token"
HDR_FILE=""   # stays empty if the token is unreadable; every caller checks this (set -u)
if [ -r "$TOKEN_FILE" ]; then
  HDR_FILE="$(mktemp)"; trap 'rm -f "$HDR_FILE"' EXIT; chmod 600 "$HDR_FILE"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$HDR_FILE"
fi

# QUARANTINE TRIPWIRE (Cybered NO-GO, comment 11790, finding 2). The fail-closed branch below is
# self-healing for ONE corruption -- but not for a repeated one: writing `{` into the state file
# every 45 minutes stamps all five targets each time and keeps the control permanently, silently
# off. Every fleet agent runs as the same UNIX user and all of them read untrusted external text,
# so this is reachable without crossing a privilege boundary.
#
# The counter lives in its OWN file, not in the state JSON: the thing being counted is the state
# file being destroyed, and a counter inside it would be destroyed with it.
#
# Cybered's framing, which is the part worth keeping: the quarantine branch is NEVER legitimate --
# nobody damages this file by accident -- so it is the cheapest possible tripwire, and one whose
# only current output is a line in the very log this card proves nobody read for 8 days. A control
# whose failure is reported only into an unread log is decoration. From the SECOND consecutive
# quarantine it messages MikroB directly.
#
# QUARANTINE_COUNT_FILE / read_quarantine_count / write_quarantine_count (card 208ad121, fail-closed
# read + atomic write) are defined earlier in this file, alongside read_state/state_put/
# cooldown_stamp, so the selftest block above can exercise them the same way.
alert_mikrob() { # alert_mikrob <text>
  [ -n "$HDR_FILE" ] || { log "WARN: no dashboard token, cannot alert MikroB"; return; }
  python3 -c 'import json,sys; print(json.dumps({"from":"mikrob","to":"mikrob","content":sys.argv[1]}))' "$1" \
    | curl -fsS -m 15 -o /dev/null -H "@$HDR_FILE" -H 'Content-Type: application/json' \
        -X POST "http://127.0.0.1:${WEB_PORT:-3420}/api/messages" --data-binary @- 2>/dev/null \
    || log "WARN: could not deliver the quarantine alert"
}

state_raw="$(read_state 2>&1)"
if [ "${state_raw%% *}" = "OK" ]; then
  STATE_JSON="${state_raw#OK }"
  # A clean read ends the streak. Counting CONSECUTIVE quarantines is the point: one is an accident
  # to recover from, a second in a row is somebody or something doing it repeatedly. A corrupt
  # counter observed HERE (during an otherwise-healthy round) is not on the critical escalation
  # path, so it is simply healed back to a clean 0 along with a genuinely-nonzero one.
  qc_raw="$(read_quarantine_count)"
  [ "$qc_raw" = "OK 0" ] || write_quarantine_count 0
else
  if [ "$DRY" = "1" ]; then
    # --dry-run promises no side effects, so it reports the damage instead of repairing it.
    say "SKIP RUN: cooldown state unreadable (${state_raw#ERR }) -- a live run would quarantine it"
    exit 0
  fi
  log "SKIP RUN: cooldown state unreadable (${state_raw#ERR }) -- quarantining and stamping all targets"
  # FAIL CLOSED, and closed here means the escalating direction, not 0: if the counter is ALSO
  # unreadable in the same round the state went bad, that is exactly the shared-cause scenario this
  # tripwire exists for (see the QUARANTINE TRIPWIRE note above) -- treat it as "at least once
  # already" so this round's increment crosses the alert threshold, instead of restarting the streak
  # at 0 and silently absorbing the very corruption it is supposed to catch.
  qc_raw="$(read_quarantine_count)"
  case "$qc_raw" in
    "OK "*) prior="${qc_raw#OK }" ;;
    *)      prior=1 ;;
  esac
  QCOUNT=$(( prior + 1 ))
  write_quarantine_count "$QCOUNT"
  if [ "$QCOUNT" -ge 2 ]; then
    log "ALERT: ${QCOUNT} consecutive quarantines -- notifying MikroB"
    alert_mikrob "[context-compact-monitor] RIASZTAS: a cooldown-allapot ${QCOUNT}. alkalommal EGYMAS UTAN serult (${STATE}). Ez az ag SOHA nem legitim -- ezt a fajlt senki nem rontja el veletlenul. Amig ismetlodik, minden korben mind az ot cel-agens 'epp most compactolva' belyeget kap, tehat a compact-vedelem 45 percenkent ujra ki van kapcsolva. A serult peldanyok a $(dirname "$STATE") mappaban vannak .corrupt.<ts> neven, nezd meg oket. (Kartya 35533cca, Cybered 2. lelete.)"
  fi
  # Quarantine, never delete: the damaged file is the only evidence of what went wrong. If the move
  # itself fails we leave it in place and carry on -- state_put's os.replace overwrites it anyway.
  mv -f "$STATE" "$STATE.corrupt.$(date +%s)" 2>/dev/null || log "WARN: could not quarantine $STATE"
  for agent in $TARGET_AGENTS; do
    STATE_JSON="$(state_put "$STATE_JSON" "$agent" "$(date +%s)")" || {
      log "SKIP RUN: could not rewrite cooldown state, giving up this round"; exit 3; }
  done
  exit 0
fi

# Refresh token_usage BEFORE deciding. The dashboard only auto-collects hourly (web.ts), so without
# this the monitor would read context sizes up to an hour old -- and an hour-old number is not a
# safe basis for compacting a live session (the agent may already have compacted, or grown far past
# it). Best-effort: if the refresh fails we still run, and the staleness check below is what stops
# us acting on an old reading. Token from a 0600 header file, never argv.
if [ -n "$HDR_FILE" ]; then
  curl -fsS -m 60 -X POST "http://127.0.0.1:${WEB_PORT:-3420}/api/token-usage/collect" \
    -H "@$HDR_FILE" >/dev/null 2>&1 || log "WARN: token-usage refresh failed; using stored rows"
fi

NOW=$(date +%s)
ACTED=0

for agent in $TARGET_AGENTS; do
  row=$(read_agent_ctx "$DB" "$agent" "$NOW")
  ctx=$(echo "$row" | awk '{print $1}')
  ts=$(echo "$row" | awk '{print $2}')
  model=$(echo "$row" | awk '{print $3}')
  [ -n "$ctx" ] || continue
  case "$ctx" in (*[!0-9]*) continue ;; esac
  case "$ts" in (''|*[!0-9]*) continue ;; esac

  # Per-agent threshold, derived: COMPACT_PCT% of that model window.
  window=$(window_tokens_for_model "$model")
  THRESHOLD=$(threshold_tokens_for_model "$model")
  ctx_k=$(( ctx / 1000 )); window_k=$(( window / 1000 )); THRESHOLD_K=$(( THRESHOLD / 1000 ))

  age_min=$(( (NOW - ts) / 60 ))
  # From the already-validated state of this run. A per-agent value that is not a plain timestamp is
  # the same class of fault as an unparseable file, so it skips this agent rather than defaulting to
  # 0 (which would read as "never compacted" and drop the cooldown).
  last=$(cooldown_stamp "$STATE_JSON" "$agent")
  case "$last" in (''|*[!0-9]*) log "SKIP $agent: cooldown stamp is not a timestamp"; continue ;; esac
  since_min=$(( (NOW - last) / 60 ))

  reason=$(should_compact "$ctx" "$THRESHOLD" "$age_min" "$MAX_AGE_MIN" "$since_min" "$COOLDOWN_MIN")
  if [ "$reason" != "compact" ]; then
    [ "$DRY" = "1" ] && say "SKIP $agent ctx=${ctx_k}k/${window_k}k (${COMPACT_PCT}% = ${THRESHOLD_K}k) age=${age_min}m since=${since_min}m -> $reason"
    continue
  fi

  if [ "$DRY" = "1" ]; then
    say "WOULD COMPACT $agent ctx=${ctx_k}k/${window_k}k (${COMPACT_PCT}% = ${THRESHOLD_K}k, ${model}) age=${age_min}m since=${since_min}m"
    continue
  fi

  # POST /api/agents/<agent>/compact, not a direct tmux write (card 9cfed589, Cybered's
  # cron-shell-pane-writers survey; same defect class as fleet-nudger.sh, card 7560bb6a). The old
  # line -- `tmux send-keys ... && sleep 1 && tmux send-keys Enter` -- ran from this scheduled-task
  # process, OUTSIDE the dashboard's in-process pane mutex, with a full second between the text and
  # the Enter for another writer's keystrokes to land in the middle of it. The API route holds the
  # SAME lock every other delivery path in this codebase uses, and still sends a LITERAL, unwrapped
  # '/compact' (unlike /api/messages, which prefixes every delivery with a trusted-peer frame that
  # would turn the command into prose Claude Code no longer recognizes as the built-in slash
  # command). $HDR_FILE already exists above (the token-usage refresh reuses it) -- no argv token.
  # Checked for non-empty first: under `set -u` an unset var would abort the whole run, and a
  # missing token should skip this one compact, not crash every remaining agent in the loop.
  if [ -z "$HDR_FILE" ]; then
    log "SKIP $agent: no dashboard token available, cannot call the compact API"
    continue
  fi
  resp="$(curl -fsS -m 15 -X POST "http://127.0.0.1:${WEB_PORT:-3420}/api/agents/${agent}/compact" \
    -H "@$HDR_FILE" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "SKIP $agent: compact request failed ($resp)"
    continue
  fi
  STATE_JSON="$(state_put "$STATE_JSON" "$agent" "$NOW")" || {
    # The compact already happened; failing to record it would let the next run repeat it.
    log "WARN $agent: compacted but could not persist the cooldown stamp"; }
  log "COMPACT $agent ctx=${ctx_k}k (${COMPACT_PCT}% of ${window_k}k = ${THRESHOLD_K}k, model ${model})"
  ACTED=$((ACTED + 1))
done

[ "$DRY" = "1" ] || log "run complete, compacted=$ACTED"
exit 0
