#!/usr/bin/env bash
# Self-test for store/lint-ratchet.sh (card 26ab08a2).
#
# Run: bash store/lint-ratchet.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# WHY THIS EXISTS. Card 26ab08a2 opened on a fleet-wide landing block: the ratchet REFUSED with
# @typescript-eslint/no-unsafe-argument at 101 -> 602. Re-measured on a throwaway worktree at the
# exact commit that produced it (332fa462), the count was 101 -- the baseline. No commit had
# introduced 501 findings; the reading itself was wrong. The card's own remedy would then have
# been the damaging one: `--update` on that reading raises the bound to 602 and permanently
# licenses 501 real new violations, invisibly, because the ratchet only ever compares to its
# baseline.
#
# What IS reproducible, and what this file pins: five of the six ratcheted rules are TYPE-AWARE,
# and when type resolution fails they do not error -- they find nothing. Removing tsconfig.json
# from that same worktree sent every typed rule to ZERO while the script printed five `IMPROVED`
# lines and its standing advice to run `--update` and record them. A gate that reports its own
# blindness as progress, and hands you the command to make it permanent.
#
# HERMETIC: no ESLint, no repo. A fake `npx` on PATH emits a crafted report, and the script under
# test is copied into a temp ROOT so it reads a temp baseline (it derives both from its own
# location). Nothing real is read or written.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/lint-ratchet.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

[ -x "$SRC" ] || [ -f "$SRC" ] || { echo "lint-ratchet.selftest.sh: $SRC not found" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
# The fake ESLint. The real script calls `npx eslint src -f json` and redirects stdout, so the
# shim only has to print whatever REPORT_JSON holds.
cat > "$TMP/bin/npx" <<'SHIM'
#!/usr/bin/env bash
cat "$REPORT_JSON"
exit 1
SHIM
chmod +x "$TMP/bin/npx"
export PATH="$TMP/bin:$PATH"

# Build an ESLint JSON report from `rule=count` pairs. A bare `parse` count becomes messages with
# no ruleId, which is exactly how a parse error reaches the counter.
mk_report() {
  local out="$1"; shift
  python3 - "$out" "$@" <<'PY'
import json, sys
out, pairs = sys.argv[1], sys.argv[2:]
messages = []
for pair in pairs:
    rule, n = pair.rsplit('=', 1)
    for _ in range(int(n)):
        messages.append({} if rule == 'parse' else {'ruleId': rule})
json.dump([{'filePath': '/x/src/a.ts', 'messages': messages}], open(out, 'w'))
PY
}

# A fresh temp ROOT holding the script and a baseline, so $BASELINE resolves inside $TMP.
new_root() {
  local root="$TMP/root.$RANDOM"
  mkdir -p "$root/store"
  cp "$SRC" "$root/store/lint-ratchet.sh"
  if [ "${1:-}" != "--no-baseline" ]; then
    cat > "$root/store/lint-baseline.json" <<'JSON'
{
  "(parse-error)": 6,
  "@typescript-eslint/no-unsafe-argument": 101,
  "@typescript-eslint/no-unused-vars": 107
}
JSON
  fi
  printf '%s' "$root"
}

run() { # run <root> [args...] -> sets OUT / CODE
  local root="$1"; shift
  OUT="$(bash "$root/store/lint-ratchet.sh" "$@" 2>&1)"
  CODE=$?
}

UA='@typescript-eslint/no-unsafe-argument'
UV='@typescript-eslint/no-unused-vars'

echo "lint-ratchet.selftest.sh"

# --- A: a healthy run at the baseline passes ---------------------------------------------------
root="$(new_root)"; export REPORT_JSON="$TMP/a.json"
mk_report "$REPORT_JSON" "parse=6" "$UA=101" "$UV=107"
run "$root"
[ "$CODE" = 0 ] && echo "$OUT" | grep -q "baseline holds" \
  && ok "healthy run at the baseline exits 0" \
  || bad "healthy run at the baseline exits 0" "code=$CODE out=$OUT"

# --- B: a real regression still REFUSES with exit 1 --------------------------------------------
root="$(new_root)"; export REPORT_JSON="$TMP/b.json"
mk_report "$REPORT_JSON" "parse=6" "$UA=104" "$UV=107"
run "$root"
[ "$CODE" = 1 ] && echo "$OUT" | grep -q "REFUSED -- a lint rule got worse" \
  && ok "a genuine rule regression still exits 1 and says REFUSED" \
  || bad "a genuine rule regression still exits 1 and says REFUSED" "code=$CODE out=$OUT"

# --- C: THE FOUNDING CASE -- typed rules collapse while parse errors explode --------------------
# This is the shape measured with tsconfig.json removed: every type-aware rule at zero, parse
# errors far above their bound. Before this card the script called that five IMPROVEMENTS.
root="$(new_root)"; export REPORT_JSON="$TMP/c.json"
mk_report "$REPORT_JSON" "parse=861"
run "$root"
[ "$CODE" = 3 ] && echo "$OUT" | grep -q "COULD NOT MEASURE" \
  && ok "typed rules at zero + parse errors up: exits 3, COULD NOT MEASURE" \
  || bad "typed rules at zero + parse errors up: exits 3, COULD NOT MEASURE" "code=$CODE out=$OUT"

echo "$OUT" | grep -q "IMPROVED" \
  && bad "a degraded run must not call the collapse an IMPROVEMENT" "out=$OUT" \
  || ok "a degraded run does not print IMPROVED"

echo "$OUT" | grep -q "UNMEASURED" \
  && ok "the collapsed rules are labelled UNMEASURED instead" \
  || bad "the collapsed rules are labelled UNMEASURED instead" "out=$OUT"

echo "$OUT" | grep -q "run \`store/lint-ratchet.sh --update\` and commit the baseline" \
  && bad "a degraded run must not advise --update" "out=$OUT" \
  || ok "a degraded run does not advise --update"

# --- D: --update REFUSES on a degraded run, and leaves the baseline untouched -------------------
root="$(new_root)"; export REPORT_JSON="$TMP/d.json"
mk_report "$REPORT_JSON" "parse=861"
before="$(cat "$root/store/lint-baseline.json")"
run "$root" --update
after="$(cat "$root/store/lint-baseline.json")"
[ "$CODE" = 3 ] && echo "$OUT" | grep -q "REFUSING to write the baseline" \
  && ok "--update on a degraded run exits 3 and refuses" \
  || bad "--update on a degraded run exits 3 and refuses" "code=$CODE out=$OUT"
[ "$before" = "$after" ] \
  && ok "--update on a degraded run leaves the baseline byte-identical" \
  || bad "--update on a degraded run leaves the baseline byte-identical" "baseline was rewritten"

# --- E: --update on a healthy run still works --------------------------------------------------
root="$(new_root)"; export REPORT_JSON="$TMP/e.json"
mk_report "$REPORT_JSON" "parse=6" "$UA=90" "$UV=107"
run "$root" --update
[ "$CODE" = 0 ] && grep -q '"@typescript-eslint/no-unsafe-argument": 90' "$root/store/lint-baseline.json" \
  && ok "--update on a healthy run still writes the tightened baseline" \
  || bad "--update on a healthy run still writes the tightened baseline" "code=$CODE out=$OUT"

# --- F: bootstrap -- THIS CASE'S PROMISE WAS REVERSED, deliberately and not silently -----------
# It used to assert that `--update` with NO baseline writes one regardless, so that the first run
# on a tree with parse errors was possible. That promise WAS the bypass: Cybersec (NO-GO, comment
# 21010, bypass A) showed that deleting the baseline turns every guard in this file off, because
# `--update` then means bootstrap and the degraded-run refusal is unreachable. Measured, it wrote
# `{"(parse-error)": 861}` -- all five type-aware rules dropped out of the bound permanently.
#
# The capability is kept, because a real first run does need it; it just has to be ASKED for. So
# the case splits: --update refuses to create, --bootstrap creates. Recording the reversal here
# rather than editing the assertion in place, because a test whose promise changes silently is how
# a reviewer loses the thread.
root="$(new_root --no-baseline)"; export REPORT_JSON="$TMP/f.json"
mk_report "$REPORT_JSON" "parse=6" "$UA=101"
run "$root" --update
[ "$CODE" = 3 ] && [ ! -f "$root/store/lint-baseline.json" ] && echo "$OUT" | grep -q -- "--bootstrap" \
  && ok "BYPASS A: --update with no baseline REFUSES to create one, and names --bootstrap" \
  || bad "BYPASS A: --update with no baseline REFUSES to create one, and names --bootstrap" "code=$CODE out=$OUT"

root="$(new_root --no-baseline)"; export REPORT_JSON="$TMP/f2.json"
mk_report "$REPORT_JSON" "parse=6" "$UA=101"
run "$root" --bootstrap
[ "$CODE" = 0 ] && [ -f "$root/store/lint-baseline.json" ] \
  && ok "--bootstrap with no baseline still writes one despite parse errors (the real first run)" \
  || bad "--bootstrap with no baseline still writes one despite parse errors" "code=$CODE out=$OUT"

# --- G: a genuine improvement in a HEALTHY run still reads as one -------------------------------
root="$(new_root)"; export REPORT_JSON="$TMP/g.json"
mk_report "$REPORT_JSON" "parse=6" "$UA=95" "$UV=107"
run "$root"
[ "$CODE" = 0 ] && echo "$OUT" | grep -q "IMPROVED" \
  && echo "$OUT" | grep -q "run \`store/lint-ratchet.sh --update\` and commit the baseline" \
  && ok "a healthy improvement still says IMPROVED and advises --update" \
  || bad "a healthy improvement still says IMPROVED and advises --update" "code=$CODE out=$OUT"

# --- H: parse errors up AND a real regression -- degraded verdict wins, other rule still named --
root="$(new_root)"; export REPORT_JSON="$TMP/h.json"
mk_report "$REPORT_JSON" "parse=20" "$UA=602" "$UV=107"
run "$root"
[ "$CODE" = 3 ] && echo "$OUT" | grep -q "COULD NOT MEASURE" \
  && echo "$OUT" | grep -q "measured in the same degraded run" \
  && echo "$OUT" | grep -q "no-unsafe-argument: 101 -> 602" \
  && ok "a rule above baseline in a degraded run is named, but not called a regression" \
  || bad "a rule above baseline in a degraded run is named, but not called a regression" "code=$CODE out=$OUT"

# --- I: an empty ESLint report is still a setup fault, not a clean tree -------------------------
root="$(new_root)"; export REPORT_JSON="$TMP/i.json"
printf '[]' > "$REPORT_JSON"
run "$root"
[ "$CODE" = 3 ] && echo "$OUT" | grep -q "linted ZERO files" \
  && ok "an empty report is still refused as a configuration fault" \
  || bad "an empty report is still refused as a configuration fault" "code=$CODE out=$OUT"

# --- THE SIX REMAINING BYPASSES (Cybersec NO-GO, comment 21010) --------------------------------
# Every one of these exited 0 on the shipped version, most of them printing IMPROVED. They share
# one shape: the measured SET shrinks while the parse-error count stays flat or FALLS, so a guard
# keyed on "parse errors rose" never fires. That is why the predicate now asks whether the same
# tree was measured, and reports WHICH signal answered no.

# --- J: BYPASS B -- parse errors UNCHANGED, the typed rules go dark ----------------------------
root="$(new_root)"; export REPORT_JSON="$TMP/j.json"
mk_report "$REPORT_JSON" "parse=6"
run "$root"
[ "$CODE" = 3 ] && echo "$OUT" | grep -q "COULD NOT MEASURE" && ! echo "$OUT" | grep -q "IMPROVED" \
  && ok "BYPASS B: rules dark with parse errors FLAT is COULD NOT MEASURE, not IMPROVED" \
  || bad "BYPASS B: rules dark with parse errors FLAT is COULD NOT MEASURE" "code=$CODE out=$OUT"

# --- K: BYPASS C -- parse errors FALL while the typed rules go dark ----------------------------
# The nastiest reading of the old predicate: it celebrated the degradation, because the one number
# it watched moved in the "good" direction.
root="$(new_root)"; export REPORT_JSON="$TMP/k.json"
mk_report "$REPORT_JSON" "parse=1"
run "$root"
[ "$CODE" = 3 ] && echo "$OUT" | grep -q "COULD NOT MEASURE" \
  && ok "BYPASS C: rules dark while parse errors FALL is still COULD NOT MEASURE" \
  || bad "BYPASS C: rules dark while parse errors FALL is still COULD NOT MEASURE" "code=$CODE out=$OUT"

# --- L: BYPASS D -- files linted, ZERO findings of any kind ------------------------------------
# Needs no deletion and no broken toolchain, which is why Cybersec rated it above A.
root="$(new_root)"; export REPORT_JSON="$TMP/l.json"
mk_report "$REPORT_JSON"
run "$root"
[ "$CODE" = 3 ] && echo "$OUT" | grep -q "ZERO findings" \
  && ok "BYPASS D: files linted with ZERO findings is a configuration fault" \
  || bad "BYPASS D: files linted with ZERO findings is a configuration fault" "code=$CODE out=$OUT"

# --- M: BYPASS E -- the same report with --update must not write an EMPTY ratchet ---------------
# This was the end state: `{}` on disk, every rule unbounded at once, exit 0.
root="$(new_root)"; export REPORT_JSON="$TMP/m.json"
mk_report "$REPORT_JSON"
before="$(cat "$root/store/lint-baseline.json")"
run "$root" --update
after="$(cat "$root/store/lint-baseline.json")"
[ "$CODE" = 3 ] && [ "$before" = "$after" ] \
  && ok "BYPASS E: --update on a zero-findings report refuses and leaves the baseline untouched" \
  || bad "BYPASS E: --update on a zero-findings report refuses" "code=$CODE out=$OUT"

# --- N: THE MESSAGE NAMES THE SIGNAL THAT ACTUALLY FIRED ---------------------------------------
# Cybersec flagged this against their own prototype: a refusal that blames parse errors when the
# trigger was a rule collapse rebuilds the misdirected-message class this card exists for.
root="$(new_root)"; export REPORT_JSON="$TMP/n.json"
mk_report "$REPORT_JSON" "parse=6"
run "$root"
echo "$OUT" | grep -q "are ALL at exactly zero" && ! echo "$OUT" | grep -q "parse errors are ABOVE" \
  && ok "the refusal names the rule collapse, not the parse-error count that did not move" \
  || bad "the refusal names the rule collapse" "code=$CODE out=$OUT"

# --- O: THE ANTI-BLANKET CONTROL, and the stated cost of COLLAPSE_MIN=2 ------------------------
# Cybersec's warning in full: "a fix that refuses EVERYTHING would be just as green on the first
# seven cases -- reaching a closed state is not enough". This is the case that separates the two.
# ONE bounded rule driven to exactly zero is what finishing off a rule looks like, and it must
# still read as IMPROVED and exit 0. It is also the deliberate hole: a single-rule collapse is
# indistinguishable from a single-rule fix from in here, and the threshold buys that on purpose.
root="$(new_root)"; export REPORT_JSON="$TMP/o.json"
mk_report "$REPORT_JSON" "parse=6" "$UV=107"
run "$root"
[ "$CODE" = 0 ] && echo "$OUT" | grep -q "IMPROVED" && ! echo "$OUT" | grep -q "COULD NOT MEASURE" \
  && ok "CONTROL: ONE bounded rule reaching zero is still IMPROVED and exits 0" \
  || bad "CONTROL: ONE bounded rule reaching zero is still IMPROVED" "code=$CODE out=$OUT"

# --- P: CONTROL -- a healthy --update still tightens the bound ---------------------------------
# The other half of the anti-blanket proof: refusing is not the only thing this script can do.
root="$(new_root)"; export REPORT_JSON="$TMP/p.json"
mk_report "$REPORT_JSON" "parse=6" "$UA=95" "$UV=107"
run "$root" --update
[ "$CODE" = 0 ] && grep -q '"@typescript-eslint/no-unsafe-argument": 95' "$root/store/lint-baseline.json" \
  && ok "CONTROL: a healthy --update still writes the tightened bound" \
  || bad "CONTROL: a healthy --update still writes the tightened bound" "code=$CODE out=$OUT"

echo
printf 'lint-ratchet selftest: %d passed, %d failed (%d cases)\n' "$pass" "$fail" "$((pass+fail))"
[ "$fail" -eq 0 ] || exit 1
