#!/usr/bin/env bash
# route-check-audit.selftest.sh -- does the audit stay SOFT, and does the cutoff actually hold?
# (card 0c473a5e)
#
# WHAT THIS FILE IS DEFENDING. The audit's two error directions are not symmetric, exactly like the
# router it audits:
#   A MISSED finding costs visibility -- rule 16 stays quietly unenforced, which is today's baseline
#       and no worse than it.
#   A FALSE finding costs trust, and it is the one MikroB's plan-grilling named as the likely
#       failure: 1659 mostly-reconstructed legacy cards lighting up on day one produces noise nobody
#       reads, at which point the real findings are invisible too. So the cutoff cases below are the
#       load-bearing ones.
#   An audit that BLOCKS a dispatch would be worse than the bug it reports. Hence case 8.
#
# Every case builds its own throwaway sqlite db and log; nothing here touches the live board.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$HERE/route-check-audit.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

command -v sqlite3 >/dev/null 2>&1 || { printf 'sqlite3 missing, cannot self-test\n' >&2; exit 3; }

NOW="$(date +%s)"

# Build a db with the real column set the audit reads.
mkdb() { # $1 = path
  sqlite3 "$1" "CREATE TABLE kanban_card_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, from_status TEXT,
      to_status TEXT NOT NULL, actor TEXT, created_at INTEGER NOT NULL,
      forced INTEGER NOT NULL DEFAULT 0);"
}
dispatch() { # $1 db, $2 card, $3 epoch
  sqlite3 "$1" "INSERT INTO kanban_card_events (card_id,from_status,to_status,created_at)
                VALUES ('$2','planned','in_progress',$3);"
}
verdict() { # $1 log, $2 card, $3 epoch
  printf '%s\t%s\tONLINE\ttest-path\tcalls=0\tchars=10\n' \
    "$(date -d "@$3" '+%Y-%m-%d %H:%M:%S')" "$2" >> "$1"
}
run() { # $@ passed through; echoes json
  ROUTE_AUDIT_DB="$DB" ROUTE_AUDIT_ROUTE_LOG="$LOG" ROUTE_AUDIT_CUTOFF_FILE="$CUT" \
    bash "$AUDIT" --json "$@" 2>/dev/null
}
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"; }

new_case() { # fresh db/log/cutoff triple
  DB="$TMP/db.$1.sqlite"; LOG="$TMP/log.$1"; CUT="$TMP/cut.$1"
  rm -f "$DB" "$LOG" "$CUT"; mkdb "$DB"; : > "$LOG"
}

printf 'route-check-audit selftest\n'

# 1. A dispatch with no verdict is a finding.
new_case 1
dispatch "$DB" aaaa1111 $((NOW - 100))
out="$(run --since $((NOW - 1000)))"
[ "$(field "$out" missing)" = "1" ] && ok "unrouted dispatch is reported" \
  || bad "unrouted dispatch is reported" "$out"

# 2. A verdict inside the window covers it.
new_case 2
dispatch "$DB" bbbb2222 $((NOW - 100))
verdict "$LOG" bbbb2222 $((NOW - 90))
out="$(run --since $((NOW - 1000)))"
[ "$(field "$out" missing)" = "0" ] && ok "verdict inside the window covers the dispatch" \
  || bad "verdict inside the window covers the dispatch" "$out"

# 3. A verdict for the SAME card far outside the window does NOT cover it. Without this, one
#    routed dispatch would whitewash every later dispatch of that card forever.
new_case 3
dispatch "$DB" cccc3333 $((NOW - 100))
verdict "$LOG" cccc3333 $((NOW - 100000))
out="$(run --since $((NOW - 200000)))"
[ "$(field "$out" missing)" = "1" ] && ok "stale verdict does not cover a later dispatch" \
  || bad "stale verdict does not cover a later dispatch" "$out"

# 4. THE CUTOFF CASE MikroB named: a dispatch BEFORE the cutoff is not a finding.
new_case 4
dispatch "$DB" dddd4444 $((NOW - 100000))
out="$(run --since $((NOW - 1000)))"
[ "$(field "$out" dispatches)" = "0" ] && ok "pre-cutoff dispatch is not audited (legacy cards stay quiet)" \
  || bad "pre-cutoff dispatch is not audited" "$out"

# 5. FIRST RUN establishes the cutoff and finds nothing, even with old dispatches present.
new_case 5
dispatch "$DB" eeee5555 $((NOW - 100000))
dispatch "$DB" ffff6666 $((NOW - 50))
out="$(run)"
if [ "$(field "$out" missing)" = "0" ] && [ -s "$CUT" ]; then
  ok "first run writes the cutoff and reports nothing"
else
  bad "first run writes the cutoff and reports nothing" "$out cutfile=$(cat "$CUT" 2>/dev/null)"
fi

# 6. A malformed log line must neither crash the parse nor silently cover a dispatch. The route log
#    is append-only and written by a script that can be killed mid-line, so a truncated or
#    unparseable timestamp is a real state, not a hypothetical one.
#    (An earlier version of this case asserted that a '--text' verdict, logged with card id '-',
#    covers no card. Mutation testing showed that case was VACUOUS: it passes with or without the
#    '-' filter, because a dispatch's card id can never equal '-' and the id comparison already
#    decides it. The filter stays in the audit for cleanliness, but it is not what this suite is
#    entitled to claim it proves.)
new_case 6
dispatch "$DB" aaaa7777 $((NOW - 100))
printf 'not-a-timestamp\taaaa7777\tONLINE\tbroken\n' >> "$LOG"
verdict "$LOG" aaaa7777 $((NOW - 90))
out="$(run --since $((NOW - 1000)))"
[ "$(field "$out" missing)" = "0" ] && ok "a malformed log line neither crashes nor hides a good verdict" \
  || bad "a malformed log line neither crashes nor hides a good verdict" "$out"

# 6b. ...and a malformed line ALONE does not count as coverage.
new_case 6b
dispatch "$DB" aaaa7788 $((NOW - 100))
printf 'not-a-timestamp\taaaa7788\tONLINE\tbroken\n' >> "$LOG"
out="$(run --since $((NOW - 1000)))"
[ "$(field "$out" missing)" = "1" ] && ok "a malformed line alone is not coverage" \
  || bad "a malformed line alone is not coverage" "$out"

# 6c. TIMESTAMP BLEED. The parser resolves each line's time by shelling out to `date`, and a shell
#     that produces no output leaves awk's getline target HOLDING THE PREVIOUS LINE'S VALUE. So a
#     malformed line that FOLLOWS a good one can inherit the good line's timestamp and fraudulently
#     cover a dispatch it has nothing to do with. Case 6b cannot see this (no earlier line to
#     inherit from); this one puts a valid line for a DIFFERENT card immediately before the
#     malformed one, at a time that would land inside the window.
new_case 6c
dispatch "$DB" aaaa7799 $((NOW - 100))
verdict "$LOG" bbbb0001 $((NOW - 95))          # good line, different card, inside the window
printf 'not-a-timestamp\taaaa7799\tONLINE\tbroken\n' >> "$LOG"   # malformed, OUR card
out="$(run --since $((NOW - 1000)))"
[ "$(field "$out" missing)" = "1" ] && ok "a malformed line cannot inherit the previous line's timestamp" \
  || bad "a malformed line cannot inherit the previous line's timestamp" "$out"

# 7. A missing route log is not a crash -- every dispatch is simply unrouted.
new_case 7
dispatch "$DB" bbbb8888 $((NOW - 100))
rm -f "$LOG"
out="$(run --since $((NOW - 1000)))"
[ "$(field "$out" missing)" = "1" ] && ok "absent route log degrades to 'unrouted', not a crash" \
  || bad "absent route log degrades to 'unrouted', not a crash" "$out"

# 8. SOFT: findings must still exit 0. A caller that branches on $? must never see a dispatch
#    failure because the audit disliked what it saw.
new_case 8
dispatch "$DB" cccc9999 $((NOW - 100))
ROUTE_AUDIT_DB="$DB" ROUTE_AUDIT_ROUTE_LOG="$LOG" ROUTE_AUDIT_CUTOFF_FILE="$CUT" \
  bash "$AUDIT" --since $((NOW - 1000)) >/dev/null 2>&1
rc=$?
[ "$rc" = "0" ] && ok "findings still exit 0 (soft, never blocks a dispatch)" \
  || bad "findings still exit 0" "exit=$rc"

# 9. Two dispatches of one card, one routed one not -> exactly one finding. This is the case the
#    window exists for, stated as a count rather than a boolean.
new_case 9
dispatch "$DB" dddd0000 $((NOW - 10000))
verdict  "$LOG" dddd0000 $((NOW - 9995))
dispatch "$DB" dddd0000 $((NOW - 100))
out="$(run --since $((NOW - 20000)))"
if [ "$(field "$out" dispatches)" = "2" ] && [ "$(field "$out" missing)" = "1" ]; then
  ok "re-dispatch is audited independently of the earlier routed one"
else
  bad "re-dispatch is audited independently" "$out"
fi

# The `selftest: N passed, 0 failed` wording is not cosmetic: src/__tests__/store-selftests-all-run.test.ts
# discovers every store/*.selftest.sh and requires one of a known set of PASS summaries, so that a
# selftest which silently runs ZERO cases cannot look identical to one that ran and passed.
printf '\nselftest: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
