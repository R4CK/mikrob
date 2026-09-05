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

# --- F: bootstrap -- no baseline at all, --update must not refuse over parse errors -------------
# Without this the guard makes the FIRST --update impossible on any tree that has parse errors,
# and this repo records six of them as its normal state.
root="$(new_root --no-baseline)"; export REPORT_JSON="$TMP/f.json"
mk_report "$REPORT_JSON" "parse=6" "$UA=101"
run "$root" --update
[ "$CODE" = 0 ] && [ -f "$root/store/lint-baseline.json" ] \
  && ok "bootstrap --update with no baseline writes one despite parse errors" \
  || bad "bootstrap --update with no baseline writes one despite parse errors" "code=$CODE out=$OUT"

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

echo
printf 'lint-ratchet selftest: %d passed, %d failed (%d cases)\n' "$pass" "$fail" "$((pass+fail))"
[ "$fail" -eq 0 ] || exit 1
