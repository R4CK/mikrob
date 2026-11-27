#!/usr/bin/env bash
# Self-test for unlazy-stop-hook-verified.sh (card 9ed32347, WhiteHat F2 MEDIUM on e060a794).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$HERE/unlazy-stop-hook-verified.sh"
fail=0
n=0

WORK="$(mktemp -d)"

# A fixture skill dir that is a byte-identical copy of the real, currently-pinned unlazy scripts
# (never the real ~/.claude/skills/unlazy -- this selftest must never depend on, or mutate, a
# live agent's actual skill directory).
GOOD_SKILL="$WORK/good-skill"
mkdir -p "$GOOD_SKILL/scripts/lib"
REAL_SKILL_DIR="$HOME/.claude/skills/unlazy"
cp "$REAL_SKILL_DIR/scripts/stop-hook.mjs" "$GOOD_SKILL/scripts/stop-hook.mjs"
cp "$REAL_SKILL_DIR/scripts/lib/gates.mjs" "$GOOD_SKILL/scripts/lib/gates.mjs"

GATES_FIXTURE="$WORK/gates-project"
mkdir -p "$GATES_FIXTURE"
cat > "$GATES_FIXTURE/GATES.md" <<'EOF'
# Gates: selftest fixture

OWNS: src/**

Scope: unlazy-stop-hook-verified.sh selftest

- [ ] G1: something true
  CHECK: true
  EXPECT: ignored, never run
EOF

n=$((n + 1))
# Match: output must be BYTE-IDENTICAL to calling node directly (transparent pass-through), not
# just "also exits 0" -- that would pass even if the wrapper silently swallowed the real decision.
direct_out="$(printf '{"cwd": "%s"}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$GOOD_SKILL" node "$GOOD_SKILL/scripts/stop-hook.mjs" --unlazy)"
wrapped_out="$(printf '{"cwd": "%s"}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$GOOD_SKILL" bash "$WRAPPER" --unlazy)"
if [ -n "$direct_out" ] && [ "$direct_out" = "$wrapped_out" ]; then
  echo "  ok   a hash-matching skill dir execs transparently -- wrapper output is byte-identical to calling node directly"
else
  echo "  FAIL expected identical non-empty output -> direct=[$direct_out] wrapped=[$wrapped_out]"; fail=1
fi

n=$((n + 1))
# Mutant 1: tamper with stop-hook.mjs itself. Must be refused, never executed -- prove it was
# never executed by having the tampered copy write a marker file the real script never writes.
MUT_SKILL="$WORK/mut-stop-hook"
mkdir -p "$MUT_SKILL/scripts/lib"
cp "$GOOD_SKILL/scripts/lib/gates.mjs" "$MUT_SKILL/scripts/lib/gates.mjs"
MARKER="$WORK/pwned-stop-hook.marker"
rm -f "$MARKER"
{
  cat "$GOOD_SKILL/scripts/stop-hook.mjs"
  printf '\nimport { writeFileSync } from "node:fs"; writeFileSync(%s, "pwned");\n' "$(printf '%s' "$MARKER" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
} > "$MUT_SKILL/scripts/stop-hook.mjs"
mut_out="$(printf '{"cwd": "%s"}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$MUT_SKILL" bash "$WRAPPER" --unlazy)"
if printf '%s' "$mut_out" | grep -q '"decision": "block"' \
  && printf '%s' "$mut_out" | grep -q "stop-hook.mjs does not match its pinned hash" \
  && [ ! -f "$MARKER" ]; then
  echo "  ok   a tampered stop-hook.mjs is refused (block decision), and never actually runs (marker absent)"
else
  echo "  FAIL expected a block decision naming stop-hook.mjs and no marker file -> out=$mut_out marker=$([ -f "$MARKER" ] && echo present || echo absent)"; fail=1
fi

n=$((n + 1))
# Mutant 2: tamper with the sibling lib/gates.mjs instead (stop-hook.mjs imports it) -- must also
# be caught, not just the entry-point file.
MUT_LIB="$WORK/mut-gates-lib"
mkdir -p "$MUT_LIB/scripts/lib"
cp "$GOOD_SKILL/scripts/stop-hook.mjs" "$MUT_LIB/scripts/stop-hook.mjs"
{ cat "$GOOD_SKILL/scripts/lib/gates.mjs"; printf '\n// tampered\n'; } > "$MUT_LIB/scripts/lib/gates.mjs"
mut_lib_out="$(printf '{"cwd": "%s"}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$MUT_LIB" bash "$WRAPPER" --unlazy)"
if printf '%s' "$mut_lib_out" | grep -q '"decision": "block"' \
  && printf '%s' "$mut_lib_out" | grep -q "gates.mjs does not match its pinned hash"; then
  echo "  ok   a tampered sibling lib/gates.mjs is also refused (not just the entry-point file)"
else
  echo "  FAIL expected a block decision naming gates.mjs -> out=$mut_lib_out"; fail=1
fi

n=$((n + 1))
# A pinned file simply missing (e.g. a half-finished re-vendor, or deletion) must be refused too.
MISSING_SKILL="$WORK/missing-skill"
mkdir -p "$MISSING_SKILL/scripts/lib"
missing_out="$(printf '{}' | UNLAZY_SKILL_DIR="$MISSING_SKILL" bash "$WRAPPER" --unlazy)"
if printf '%s' "$missing_out" | grep -q '"decision": "block"' && printf '%s' "$missing_out" | grep -q "is missing at"; then
  echo "  ok   a missing pinned file is refused, not silently skipped"
else
  echo "  FAIL expected a block decision about a missing file -> out=$missing_out"; fail=1
fi

n=$((n + 1))
# No sha256sum on PATH must fail closed (block), never silently fall through to exec unverified.
# Resolve bash by its own full path first -- PATH is overridden for the wrapper's own lookups
# (sha256sum included), so the shell invoking it cannot rely on PATH to find bash itself.
BASH_BIN="$(command -v bash)"
mkdir -p "$WORK/empty-path-bin"
no_sha_out="$(printf '{}' | UNLAZY_SKILL_DIR="$GOOD_SKILL" PATH="$WORK/empty-path-bin" "$BASH_BIN" "$WRAPPER" --unlazy)"
if printf '%s' "$no_sha_out" | grep -q '"decision": "block"' && printf '%s' "$no_sha_out" | grep -q "sha256sum not on PATH"; then
  echo "  ok   a missing sha256sum binary fails closed (block), never silently execs unverified"
else
  echo "  FAIL expected a block decision about missing sha256sum -> out=$no_sha_out"; fail=1
fi

n=$((n + 1))
# This script's OWN pinned hashes must currently match the real, live ~/.claude/skills/unlazy
# copy (read-only check -- never writes there). If this ever goes red, it means either the live
# skill drifted from the pin (investigate before touching this test) or this script's own
# PINNED_FILES is stale after a legitimate re-vendor (update PINNED_FILES, not this test).
live_out="$(printf '{"cwd": "%s"}' "$GATES_FIXTURE" | bash "$WRAPPER" --unlazy)"
if ! printf '%s' "$live_out" | grep -q '"decision": "block".*unlazy-stop-hook-verified'; then
  echo "  ok   this script's own pinned hashes currently match the real, live ~/.claude/skills/unlazy copy"
else
  echo "  FAIL the real live unlazy copy no longer matches the hashes pinned in this script -> $live_out"; fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
