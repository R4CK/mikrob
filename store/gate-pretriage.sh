#!/usr/bin/env bash
# gate-pretriage.sh -- LOCAL first-pass before an online gate agent reads a card (card 7041c165).
#
# THE POINT: a QA/Cybersec gate currently spends online Claude tokens re-discovering the same
# mechanical facts on every card -- what changed, does it type-check, do the new tests actually touch
# the diff, are there vacuous assertions, did a secret land in argv. All of that is DETERMINISTIC and
# can run on this machine for free. This script produces that report so the online gate starts from
# facts instead of paying to derive them.
#
# WHAT THIS IS NOT: a verdict. It never prints PASS/FAIL/GO/NO-GO and it never decides whether a card
# ships. The checks below are cheap heuristics chosen because each one corresponds to a finding class
# that ACTUALLY recurred in this fleet's gate history; a clean report means "the cheap traps are
# clear", never "this card is good". The online gate still does the real review. A local 7B must not
# adjudicate security, so the optional --explain summary is explicitly labelled advisory and no check
# result is derived from it.
#
# USAGE:
#   gate-pretriage.sh --repo <path> [--base <ref>] [--head <ref>] [--json] [--explain]
#     --base/--head  commit range to inspect (default: HEAD~1..HEAD)
#     --json         machine-readable output (for a scheduled task / the dashboard)
#     --explain      additionally ask the LOCAL model for a plain-language summary (advisory only)
#
# EXIT: always 0 unless usage/repo is wrong (2). A finding is REPORTED, never fatal -- this is an
# input to a human/agent gate, not a CI blocker, and a non-zero exit would make callers treat a
# heuristic hit as a hard failure.

set -uo pipefail

REPO=""; BASE=""; HEAD_REF="HEAD"; JSON=0; EXPLAIN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD_REF="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    --explain) EXPLAIN=1; shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "gate-pretriage: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO" && -d "$REPO/.git" ]] || { echo "gate-pretriage: --repo must be a git repo" >&2; exit 2; }
cd "$REPO" || exit 2
[[ -n "$BASE" ]] || BASE="$(git rev-parse "${HEAD_REF}~1" 2>/dev/null || echo "$HEAD_REF")"

CHANGED=$(git diff --name-only "$BASE" "$HEAD_REF" 2>/dev/null)
CODE_FILES=$(echo "$CHANGED" | grep -E '\.(ts|tsx|js|mjs|cjs)$' | grep -v '\.test\.' || true)
TEST_FILES=$(echo "$CHANGED" | grep -E '\.test\.(ts|tsx)$' || true)

findings=()   # "severity|check|detail"
add() { findings+=("$1|$2|$(printf %s "$3" | tr "\n" " ")"); }

# NET-NEW counting. A diff-based heuristic that only counts `+` lines cries wolf on every refactor
# that MOVES an existing pattern (verified: this script's own first run flagged "secret-in-argv" on a
# commit that merely swapped a path inside lines that already contained the pattern). Comparing the
# added against the removed count separates "introduced" from "touched"; a check that fires on
# untouched risk teaches gates to ignore it, which is worse than not having the check.
#   net_new <pattern> [paths...]  -> prints "<net_new> <added>"
net_new() {
  local pat="$1"; shift
  local d plus minus
  d=$(git diff "$BASE" "$HEAD_REF" -- "$@" 2>/dev/null)
  plus=$(echo "$d" | grep -cE "^\+.*${pat}" || true)
  minus=$(echo "$d" | grep -cE "^-.*${pat}" || true)
  echo "$(( plus - minus )) $plus"
}

# --- 1. changed code with no changed test -------------------------------------------------------
# Recurring class: a green suite that never executes the diff ("N/N green" is vacuous if no test
# touches the changed symbols).
if [[ -n "$CODE_FILES" && -z "$TEST_FILES" ]]; then
  add "warn" "no-test-for-changed-code" "$(echo "$CODE_FILES" | wc -l) code file(s) changed, 0 test files"
fi

# --- 2. exported symbols added without any test mentioning them ---------------------------------
if [[ -n "$CODE_FILES" ]]; then
  new_syms=$(git diff "$BASE" "$HEAD_REF" -- $CODE_FILES 2>/dev/null \
    | grep -E '^\+export (function|const|class) ' \
    | sed -E 's/^\+export (function|const|class) ([A-Za-z0-9_]+).*/\2/' | sort -u)
  untested=""
  for sym in $new_syms; do
    if ! git grep -qE "\b${sym}\b" "$HEAD_REF" -- '*.test.ts' '*.test.tsx' 2>/dev/null; then
      untested="${untested}${untested:+, }${sym}"
    fi
  done
  [[ -n "$untested" ]] && add "warn" "exported-symbol-untested" "no test references: $untested"
fi

# --- 3. vacuous assertions ----------------------------------------------------------------------
# `.not.toBe(input)` passes for a WRONG output too -- this exact shape once hid a rate-limit bug
# where every IPv4 client collapsed into one bucket.
if [[ -n "$TEST_FILES" ]]; then
  read -r vac_net vac_add <<< "$(net_new '\.not\.(toBe|toEqual)\(' $TEST_FILES)"
  if [[ "${vac_net:-0}" -gt 0 ]]; then
    add "warn" "possibly-vacuous-assertion" \
      "$vac_net NEW .not.toBe/.not.toEqual assertion(s) -- assert the EXACT expected value instead"
  elif [[ "${vac_add:-0}" -gt 0 ]]; then
    add "info" "possibly-vacuous-assertion" "$vac_add touched, none net-new (pre-existing shape)"
  fi
  todo=$(git diff "$BASE" "$HEAD_REF" -- $TEST_FILES 2>/dev/null \
    | grep -cE '^\+\s*(it|test|describe)\.(skip|todo)\(' || true)
  [[ "${todo:-0}" -gt 0 ]] && add "warn" "skipped-test-added" "$todo newly skipped/todo test(s)"
fi

# --- 4. secret material on a command line -------------------------------------------------------
# argv is world-readable via /proc/<pid>/cmdline, so a token passed as an argument leaks to any
# local process for the lifetime of the call.
read -r tok_net tok_add <<< "$(net_new '(Authorization: Bearer \$|--password[= ]\$|token=\$)' .)"
if [[ "${tok_net:-0}" -gt 0 ]]; then
  add "high" "secret-in-argv" \
    "$tok_net NEW line(s) put a token/password on a command line -- read it from a 0600 file instead"
elif [[ "${tok_add:-0}" -gt 0 ]]; then
  add "info" "secret-in-argv" "$tok_add touched, none net-new (pre-existing pattern, not introduced here)"
fi

# --- 5. inline styles on the frontend (CSP) -----------------------------------------------------
# jsdom does not enforce CSP, so an inline style passes every unit test and breaks only in a browser.
fe=$(echo "$CHANGED" | grep -E '\.(tsx|jsx)$' || true)
if [[ -n "$fe" ]]; then
  read -r css_net css_add <<< "$(net_new 'style=\{\{' $fe)"
  if [[ "${css_net:-0}" -gt 0 ]]; then
    add "warn" "csp-inline-style" \
      "$css_net NEW inline style={{...}} -- blocked by a strict CSP, invisible to jsdom tests"
  elif [[ "${css_add:-0}" -gt 0 ]]; then
    add "info" "csp-inline-style" "$css_add touched, none net-new"
  fi
fi

# --- 6. migration without a rollback note -------------------------------------------------------
mig=$(echo "$CHANGED" | grep -E 'migrations/.*\.sql$' || true)
if [[ -n "$mig" ]]; then
  for m in $mig; do
    git show "$HEAD_REF:$m" 2>/dev/null | grep -qiE 'backfill|rollback|down|IF NOT EXISTS' \
      || add "warn" "migration-no-safety-note" "$m has no IF NOT EXISTS / backfill / rollback note"
  done
fi

# --- 7. type-check, scoped to the repo's own command --------------------------------------------
TSC="unknown"
# The repo's OWN tsc, by explicit path -- never `npx --no-install tsc` (card aae6632c). npx resolves
# upward and through its cache, so in a throwaway repo with no node_modules it can find SOME tsc on
# the machine and type-check the fixture against a toolchain the repo does not have. That is how
# this check reported `errors:1` where it should have reported `unavailable`, and it made
# gate-pretriage.test.ts red on develop for anyone whose machine happened to have a resolvable tsc.
TSC_BIN="./node_modules/.bin/tsc"
if [[ -f tsconfig.json ]]; then
  if [[ ! -x "$TSC_BIN" ]]; then
    # No local toolchain: say so instead of type-checking against someone else's compiler.
    TSC="unavailable"
    add "info" "tsc-unavailable" "tsc could not run here (no local toolchain) -- type-check NOT verified"
  else
    # Card aba71f7d: a single FIXED path shared by every invocation was a cross-process race hazard
    # (e.g. concurrent test cases each spawning this script). mktemp gives each invocation its own,
    # created only here (tsc is actually about to run) so the common no-tsconfig/no-local-tsc paths
    # above never leak an unused temp file. Not cleaned up unconditionally: an errors/crash finding
    # below points a human at this exact path ("see $TSC_LOG") for follow-up, so only the clean
    # (nothing to inspect) case removes it.
    TSC_LOG="$(mktemp "${TMPDIR:-/tmp}/gate-pretriage-tsc.XXXXXX.log")"
    if "$TSC_BIN" --noEmit >"$TSC_LOG" 2>&1; then
      TSC="clean"
      rm -f "$TSC_LOG"
    else
      # `grep -c` EXITS 1 when it matches nothing, so `... || echo '?'` emitted BOTH the count and
      # the fallback -- a newline inside the value, which then broke the JSON encoder downstream.
      # Capture with `|| true` and default in the expansion instead.
      _tsc_errs=$(grep -c 'error TS' "$TSC_LOG" 2>/dev/null || true)
      if [[ "${_tsc_errs:-0}" -gt 0 ]]; then
        TSC="errors:${_tsc_errs}"
        add "high" "tsc-errors" "$TSC (see $TSC_LOG)"
      else
        # The local tsc EXISTS and exited non-zero, yet logged no `error TS` line: it crashed, ran
        # out of memory, or rejected its own config. Reporting that as "0 errors, high severity"
        # would be doubly wrong: it invents a code defect AND lets a gate read "tsc: errors:0" as a
        # clean type-check. (The missing-toolchain case is caught above, before tsc runs at all.)
        TSC="unavailable"
        add "info" "tsc-unavailable" "tsc could not run here (no local toolchain) -- type-check NOT verified"
      fi
    fi
  fi
  # A repo whose tsconfig excludes tests cannot surface a stale fixture via `tsc --noEmit`.
  grep -qE '"\*\*/\*\.test\.ts"' tsconfig.json 2>/dev/null \
    && add "info" "tsc-excludes-tests" \
       "root tsconfig excludes **/*.test.ts -- tsc --noEmit CANNOT see test-file type errors"
fi

# --- report -------------------------------------------------------------------------------------
if [[ "$JSON" == "1" ]]; then
  BASE="$BASE" HEAD_REF="$HEAD_REF" TSC="$TSC" CHANGED="$CHANGED" \
  FINDINGS="$(printf '%s\n' "${findings[@]+"${findings[@]}"}")" python3 -c '
import json, os
raw = [l for l in os.environ["FINDINGS"].split("\n") if l.strip()]
out = []
for line in raw:
    sev, check, detail = line.split("|", 2)
    out.append({"severity": sev, "check": check, "detail": detail})
print(json.dumps({
    "base": os.environ["BASE"], "head": os.environ["HEAD_REF"],
    "tsc": os.environ["TSC"],
    "changed_files": [f for f in os.environ["CHANGED"].split("\n") if f],
    "findings": out,
    "verdict": None,
    "note": "MECHANICAL PRE-TRIAGE ONLY. Not a gate verdict. A clean report means the cheap traps are clear, not that the card is correct.",
}, indent=2, ensure_ascii=False))'
else
  echo "== gate pre-triage: $BASE..$HEAD_REF =="
  echo "changed files: $(echo "$CHANGED" | grep -c . || echo 0)   tsc: $TSC"
  if [[ ${#findings[@]} -eq 0 ]]; then
    echo "no mechanical findings (cheap traps clear -- NOT a verdict)"
  else
    for f in "${findings[@]}"; do
      IFS='|' read -r sev check detail <<< "$f"
      printf '  [%-4s] %-26s %s\n' "$sev" "$check" "$detail"
    done
  fi
  echo "-- this is INPUT to a gate, not a verdict; the online gate still reviews the change --"
fi

# --- optional advisory local-LLM summary --------------------------------------------------------
if [[ "$EXPLAIN" == "1" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo
  echo "-- ADVISORY local-model summary (DRAFT, not evidence, not a verdict) --"
  git diff --stat "$BASE" "$HEAD_REF" 2>/dev/null | tail -40 \
    | "$HERE/local-llm.sh" --task summarize --caller gate-pretriage 2>/dev/null \
    || echo "(local model unavailable -- the mechanical report above stands on its own)"
fi
exit 0
