#!/usr/bin/env bash
# Self-test for store/vitest-skip-report.sh (card beb9c8d3).
#
# Run: bash store/vitest-skip-report.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# THE PROPERTY UNDER TEST is again a DISCRIMINATION, so the cases come in pairs. A reporter that
# blamed PG_E2E_URL for every skip would be worse than none: it would train a reader to discount the
# one sentence that is supposed to stop them trusting a green run. So each attribution case carries
# its own negative -- a file that only MENTIONS the variable, a file with a longer name that merely
# contains it, and an environment where the variable IS set.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/vitest-skip-report.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SRC="$TMP/repo/apps/api/src"
mkdir -p "$SRC"

# Four skipped files, each a different answer to "is this gated on PG_E2E_URL?".
#   gated-a  : plain reference in code                                   -> gated
#   gated-b  : reference on a line that also carries a `://` literal     -> gated (the :// exemption)
#   comment  : the ONLY reference is inside comments                     -> NOT gated
#   longer   : the only reference is PG_E2E_URL_ALT                      -> NOT gated
printf 'const u = process.env["PG_E2E_URL"]\n' > "$SRC/gated-a.e2e.test.ts"
printf "const u = 'postgres://h/db' + process.env['PG_E2E_URL']\\n" > "$SRC/gated-b.e2e.test.ts"
printf '// needs PG_E2E_URL one day\n/* PG_E2E_URL again */\nconst u = 1\n' > "$SRC/comment.e2e.test.ts"
printf 'const u = process.env["PG_E2E_URL_ALT"]\n' > "$SRC/longer.e2e.test.ts"
printf 'const u = process.env["PG_E2E_URL"]\n' > "$SRC/partial.e2e.test.ts"

mklog() { # $1 = destination; writes a realistic vitest tail
  cat > "$1" <<'LOG'
 RUN  v3.2.6 /repo

 ↓ |api-e2e| apps/api/src/gated-a.e2e.test.ts (3 tests | 3 skipped)
 ↓ |api-e2e| apps/api/src/gated-b.e2e.test.ts (2 tests | 2 skipped)
 ↓ |api-e2e| apps/api/src/comment.e2e.test.ts (4 tests | 4 skipped)
 ↓ |api-e2e| apps/api/src/longer.e2e.test.ts (1 test | 1 skipped)
 ✓ |api-e2e| apps/api/src/partial.e2e.test.ts (9 tests | 4 skipped) 41ms

 Test Files  1 passed | 4 skipped (5)
      Tests  5 passed | 14 skipped (19)
   Duration  11.39s
LOG
}
LOG="$TMP/run.log"; mklog "$LOG"

# --- 1. the headline numbers come from vitest's OWN summary ------------------------------------
# Not from counting the per-file lines: a parsing gap must never be able to understate how much did
# not run. If these two numbers ever disagree with the summary, the report has started guessing.
out="$(env -u PG_E2E_URL bash "$RUN" "$LOG" "$TMP/repo" 2>&1)"; rc=$?
if [[ $rc -eq 0 ]] && echo "$out" | grep -q '4 of 5 test FILES did not run -- 14 of 19 tests were SKIPPED'; then
  ok "the headline quotes vitest's own file and test totals"
else
  bad "headline wrong (rc=$rc)" "$out"
fi

# --- 2. ATTRIBUTION, and the three negatives that make it mean something -------------------------
# 2 gated (plain + the :// line), 2 not (comment-only, and the longer name).
if echo "$out" | grep -qE '^ +2 file\(s\) gated on PG_E2E_URL'; then
  ok "exactly the 2 files that reference PG_E2E_URL in CODE are attributed to it"
else
  bad "gated count wrong -- want 2" "$out"
fi
if echo "$out" | grep -qE '^ +2 file\(s\) skipped for a reason this report does not attribute'; then
  ok "the comment-only and the longer-name file land in the UNATTRIBUTED bucket, not the PG one"
else
  bad "leftover bucket wrong -- want 2" "$out"
fi

# The two negatives again, one at a time, so a future change cannot pass case 2 by cancelling one
# mistake against the other (comment counted + :// line dropped is also "2").
mkdir -p "$TMP/only-comment/apps/api/src"
cp "$SRC/comment.e2e.test.ts" "$TMP/only-comment/apps/api/src/gated-a.e2e.test.ts"
cp "$SRC/comment.e2e.test.ts" "$TMP/only-comment/apps/api/src/gated-b.e2e.test.ts"
cp "$SRC/comment.e2e.test.ts" "$TMP/only-comment/apps/api/src/comment.e2e.test.ts"
cp "$SRC/comment.e2e.test.ts" "$TMP/only-comment/apps/api/src/longer.e2e.test.ts"
out2="$(env -u PG_E2E_URL bash "$RUN" "$LOG" "$TMP/only-comment" 2>&1)"
if echo "$out2" | grep -qE '^ +0 file\(s\) gated on PG_E2E_URL'; then
  ok "a corpus whose ONLY references are comments attributes NOTHING to the gate"
else
  bad "comment-stripping is not working: a comment-only corpus was attributed" "$out2"
fi

mkdir -p "$TMP/only-scheme/apps/api/src"
for f in gated-a gated-b comment longer; do cp "$SRC/gated-b.e2e.test.ts" "$TMP/only-scheme/apps/api/src/$f.e2e.test.ts"; done
out3="$(env -u PG_E2E_URL bash "$RUN" "$LOG" "$TMP/only-scheme" 2>&1)"
if echo "$out3" | grep -qE '^ +4 file\(s\) gated on PG_E2E_URL'; then
  ok "a '://' literal earlier on the line does not swallow the reference behind it"
else
  bad "the :// exemption is broken -- a connection string truncated the line" "$out3"
fi

# --- 3. the partially-skipped file is NOT counted as "did not run" -------------------------------
# It ran. Folding it into the same number would overstate the damage, and an overstated warning is
# discounted just as fast as an absent one.
echo "$out" | grep -q '1 further file(s) ran but skipped some of their own cases' \
  && ok "a file that ran but skipped cases is reported separately" \
  || bad "the partial-skip line is missing or wrong" "$out"

# --- 4. WHEN THE VARIABLE IS SET, it is not blamed ----------------------------------------------
# The case that keeps the report honest on the day somebody wires a Postgres and files still skip.
out4="$(env PG_E2E_URL=postgres://x bash "$RUN" "$LOG" "$TMP/repo" 2>&1)"; rc=$?
if [[ $rc -eq 0 ]] && echo "$out4" | grep -q 'PG_E2E_URL IS set here' && ! echo "$out4" | grep -q 'gated on PG_E2E_URL'; then
  ok "with the variable SET, the skips are reported but NOT attributed to it"
else
  bad "a set variable was still blamed (rc=$rc)" "$out4"
fi

# --- 5. no repo root -> says it cannot attribute, rather than attributing zero -------------------
# Zero-gated and cannot-tell must not print the same sentence: one is a measurement, the other is
# the absence of one.
out5="$(env -u PG_E2E_URL bash "$RUN" "$LOG" 2>&1)"
if echo "$out5" | grep -q 'not attributed' && ! echo "$out5" | grep -qE '^ +0 file\(s\) gated'; then
  ok "without a repo root it says it did not attribute, instead of reporting a zero"
else
  bad "a missing repo root produced an attribution anyway" "$out5"
fi

# --- 6. A CLEAN RUN IS SILENT -------------------------------------------------------------------
# The whole design rests on this: a notice that fires on healthy traffic gets skipped when it counts.
cat > "$TMP/clean.log" <<'LOG'
 ✓ |api-e2e| apps/api/src/gated-a.e2e.test.ts (3 tests) 12ms

 Test Files  5 passed (5)
      Tests  19 passed (19)
LOG
out6="$(env -u PG_E2E_URL bash "$RUN" "$TMP/clean.log" "$TMP/repo" 2>&1)"; rc=$?
if [[ $rc -eq 1 ]] && [[ -z "$out6" ]]; then
  ok "a run with nothing skipped prints NOTHING and exits 1"
else
  bad "a clean run was not silent (rc=$rc)" "$out6"
fi

# --- 7. STDOUT STAYS CLEAN ----------------------------------------------------------------------
# The caller pipes vitest's stdout; a report leaking onto it would land in the middle of the suite
# output and, worse, into anything parsing that stream.
so="$(env -u PG_E2E_URL bash "$RUN" "$LOG" "$TMP/repo" 2>/dev/null)"
[[ -z "$so" ]] && ok "the report goes to stderr only -- stdout is untouched" \
               || bad "the report wrote to stdout" "$so"

# --- 8. usage and an unreadable log --------------------------------------------------------------
bash "$RUN" >/dev/null 2>&1; rc=$?
[[ $rc -eq 2 ]] && ok "no arguments -> exit 2 (usage)" || bad "no-args exit $rc, want 2"
bash "$RUN" "$TMP/definitely-not-here" >/dev/null 2>&1; rc=$?
[[ $rc -eq 1 ]] && ok "a missing log is not a report" || bad "missing log exit $rc, want 1"
out9="$(bash "$RUN" /dev/null 2>&1)"; rc=$?
[[ $rc -eq 1 ]] && [[ -z "$out9" ]] && ok "a log with no vitest summary reports nothing" \
                                    || bad "a summary-less log produced output (rc=$rc)" "$out9"

# --- 9. THE WIRING. The report is only worth anything if the runner calls it ---------------------
# Measured on comment-stripped source and matched on the CALL EXPRESSION, not the bare filename: a
# comment naming the script would otherwise keep this green after the call itself was deleted.
RUNNER="$HERE/cleancore-suite-run.sh"
if [ -f "$RUNNER" ]; then
  code="$(python3 -c '
import re,sys
s=open(sys.argv[1],encoding="utf-8").read()
s=re.sub(r"(?m)^\s*#.*$","",s)
print(s)' "$RUNNER")"
  echo "$code" | grep -qE 'vitest-skip-report\.sh"?[[:space:]]+"' \
    && ok "cleancore-suite-run.sh actually CALLS vitest-skip-report.sh with arguments" \
    || bad "the runner does not call this script -- the report would never run"
else
  bad "cleancore-suite-run.sh is missing next to this script"
fi

echo
echo "vitest-skip-report.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
