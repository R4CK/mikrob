#!/usr/bin/env bash
# Self-test for unlazy-stop-hook-verified.sh (card 9ed32347, WhiteHat F2 MEDIUM on e060a794;
# hardened round after QA FAIL 39488 + CYBERED NO-GO 39489 on the v1 wrapper, f5b8b136).
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

# Builds a tampered copy of stop-hook.mjs whose marker-write is the FIRST executable statement in
# the file (not appended after the original body, which ends in process.exit(0) and would make the
# marker UNREACHABLE regardless of what runs it -- a vacuous oracle, CYBERED/QA F-4 on the v1
# selftest). Dropping the original shebang line is harmless: this file is always invoked as
# `node <path>`, never executed directly by the shell.
make_tampered_skill() {
  local dest_skill="$1" marker="$2"
  mkdir -p "$dest_skill/scripts/lib"
  cp "$GOOD_SKILL/scripts/lib/gates.mjs" "$dest_skill/scripts/lib/gates.mjs"
  {
    printf 'import { writeFileSync as __pwn } from "node:fs";\n'
    printf '__pwn(%s, "pwned");\n' "$(printf '%s' "$marker" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    tail -n +2 "$GOOD_SKILL/scripts/stop-hook.mjs"
  } > "$dest_skill/scripts/stop-hook.mjs"
}

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
# Control (guards-that-pin-behaviour #8: assert non-vacuity in the guard itself): the tampered
# file's marker must be REACHABLE when the file is run directly, bypassing the wrapper entirely --
# otherwise "marker absent via the wrapper" proves nothing (this is exactly what killed the v1
# selftest's case 2, CYBERED/QA F-4).
CTRL_SKILL="$WORK/ctrl-direct-run"
CTRL_MARKER="$WORK/ctrl.marker"
rm -f "$CTRL_MARKER"
make_tampered_skill "$CTRL_SKILL" "$CTRL_MARKER"
node "$CTRL_SKILL/scripts/stop-hook.mjs" --unlazy < /dev/null >/dev/null 2>&1 || true
if [ -f "$CTRL_MARKER" ]; then
  echo "  ok   control: the tampered file's marker IS reachable when run directly (oracle is non-vacuous)"
else
  echo "  FAIL control failed -- the marker is unreachable even with no wrapper at all, the oracle proves nothing"; fail=1
fi

n=$((n + 1))
# Mutant 1: tamper with stop-hook.mjs itself. Must be refused, never executed -- the marker (now
# reachable per the control above) must stay absent when run THROUGH the wrapper.
MUT_SKILL="$WORK/mut-stop-hook"
MARKER="$WORK/pwned-stop-hook.marker"
rm -f "$MARKER"
make_tampered_skill "$MUT_SKILL" "$MARKER"
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
# Missing sha256sum/node must fail closed. The production script hardcodes the absolute path
# (deliberately, to kill the PATH-hijack class -- see the PATH test below), so there is no safe
# way to make the REAL /usr/bin/sha256sum disappear for a test. Instead this exercises the exact
# same command-v-or-fail branch via a MUTANT COPY whose absolute path constant points at a
# nonexistent file -- the production script itself is never weakened, only a disposable copy is.
MUT_BIN_WRAPPER="$WORK/wrapper-missing-sha256sum.sh"
sed 's#^SHA256SUM="/usr/bin/sha256sum"#SHA256SUM="/nonexistent/sha256sum"#' "$WRAPPER" > "$MUT_BIN_WRAPPER"
chmod +x "$MUT_BIN_WRAPPER"
if ! grep -q 'SHA256SUM="/nonexistent/sha256sum"' "$MUT_BIN_WRAPPER"; then
  echo "  FAIL could not construct the missing-sha256sum mutant copy (sed did not match)"; fail=1
else
  no_sha_out="$(printf '{"cwd": "%s"}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$GOOD_SKILL" bash "$MUT_BIN_WRAPPER" --unlazy)"
  if printf '%s' "$no_sha_out" | grep -q '"decision": "block"' && printf '%s' "$no_sha_out" | grep -q "sha256sum not found"; then
    echo "  ok   a missing sha256sum binary fails closed (block), never silently execs unverified"
  else
    echo "  FAIL expected a block decision about missing sha256sum -> out=$no_sha_out"; fail=1
  fi
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

n=$((n + 1))
# F-2 TOCTOU close: a background writer toggles the SOURCE file good<->evil via the SAME technique
# QA/CYBERED used against the v1 wrapper (plain overwrite, "as fast as cat allows", no special
# timing). v1 lost 22-50 of 120 such races. The fix hashes a PRIVATE COPY made before the check,
# not the live path re-read at exec time, so this must now be zero wins across the same style of
# race, run for the same order of magnitude of iterations.
RACE_SKILL="$WORK/race-skill"
mkdir -p "$RACE_SKILL/scripts/lib"
cp "$GOOD_SKILL/scripts/lib/gates.mjs" "$RACE_SKILL/scripts/lib/gates.mjs"
cp "$GOOD_SKILL/scripts/stop-hook.mjs" "$RACE_SKILL/scripts/stop-hook.mjs"
RACE_MARKER="$WORK/race.marker"
rm -f "$RACE_MARKER"
EVIL_SRC="$WORK/race-evil-stop-hook.mjs"
{
  printf 'import { writeFileSync as __pwn } from "node:fs";\n'
  printf '__pwn(%s, "pwned");\n' "$(printf '%s' "$RACE_MARKER" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  tail -n +2 "$GOOD_SKILL/scripts/stop-hook.mjs"
} > "$EVIL_SRC"
(
  for _ in $(seq 1 400); do
    cat "$EVIL_SRC" > "$RACE_SKILL/scripts/stop-hook.mjs" 2>/dev/null
    cat "$GOOD_SKILL/scripts/stop-hook.mjs" > "$RACE_SKILL/scripts/stop-hook.mjs" 2>/dev/null
  done
) &
WRITER_PID=$!
race_wins=0
for _ in $(seq 1 120); do
  printf '{"cwd": "%s"}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$RACE_SKILL" bash "$WRAPPER" --unlazy >/dev/null 2>&1
  if [ -f "$RACE_MARKER" ]; then
    race_wins=$((race_wins + 1))
    rm -f "$RACE_MARKER"
  fi
done
wait "$WRITER_PID" 2>/dev/null
if [ "$race_wins" -eq 0 ]; then
  echo "  ok   F-2 closed: 0/120 TOCTOU wins against the same race style that beat the v1 wrapper 22-50/120 times"
else
  echo "  FAIL TOCTOU still wins $race_wins/120 times -- the private-copy-then-exec design did not close the race"; fail=1
fi

# unlazy's own stop-hook.mjs keeps gate-progress STATE keyed by cwd (hookStatePath), so repeated
# calls against the SAME fixture dir accumulate a block counter and eventually switch to its own
# "releasing after 6 blocks" message -- a test-isolation artifact, not a security property. Each
# stateful check below therefore gets its OWN fresh fixture dir and its OWN freshly-computed
# "expected" direct-node output, instead of reusing $direct_out from the very first case.
fresh_gates_fixture() {
  local d="$1"
  mkdir -p "$d"
  cp "$GATES_FIXTURE/GATES.md" "$d/GATES.md"
}

n=$((n + 1))
# F-3 PATH hijack: put fake sha256sum/cut/node earlier on PATH than /usr/bin, each writing its own
# "I ran" marker. The wrapper must never invoke them (it uses hardcoded absolute paths) and must
# still produce the correct, byte-identical happy-path output using the REAL binaries.
HIJACK_BIN="$WORK/hijack-bin"
mkdir -p "$HIJACK_BIN"
for fake in sha256sum cut node; do
  cat > "$HIJACK_BIN/$fake" <<EOF
#!/usr/bin/env bash
touch "$WORK/hijack-$fake.ran"
exit 1
EOF
  chmod +x "$HIJACK_BIN/$fake"
done
rm -f "$WORK"/hijack-*.ran
HIJACK_FIXTURE="$WORK/hijack-gates-project"
fresh_gates_fixture "$HIJACK_FIXTURE"
hijack_expected="$(printf '{"cwd": "%s"}' "$HIJACK_FIXTURE" | UNLAZY_SKILL_DIR="$GOOD_SKILL" node "$GOOD_SKILL/scripts/stop-hook.mjs" --unlazy)"
hijack_out="$(printf '{"cwd": "%s"}' "$HIJACK_FIXTURE" | UNLAZY_SKILL_DIR="$GOOD_SKILL" PATH="$HIJACK_BIN:/usr/bin:/bin" bash "$WRAPPER" --unlazy)"
if [ "$hijack_out" = "$hijack_expected" ] && [ ! -f "$WORK/hijack-sha256sum.ran" ] && [ ! -f "$WORK/hijack-cut.ran" ] && [ ! -f "$WORK/hijack-node.ran" ]; then
  echo "  ok   F-3 closed: a hostile PATH entry ahead of /usr/bin is never invoked, real binaries used, output unchanged"
else
  echo "  FAIL PATH hijack not fully closed -> out=$hijack_out sha256sum.ran=$([ -f "$WORK/hijack-sha256sum.ran" ] && echo yes || echo no) cut.ran=$([ -f "$WORK/hijack-cut.ran" ] && echo yes || echo no) node.ran=$([ -f "$WORK/hijack-node.ran" ] && echo yes || echo no)"; fail=1
fi

n=$((n + 1))
# F-3 NODE_OPTIONS: an injected --require must not run inside the hook's node process.
NODE_OPTS_MARKER="$WORK/node-options.marker"
rm -f "$NODE_OPTS_MARKER"
EVIL_REQUIRE="$WORK/evil-require.cjs"
cat > "$EVIL_REQUIRE" <<EOF
require("fs").writeFileSync("$NODE_OPTS_MARKER", "pwned");
EOF
NODE_OPTS_FIXTURE="$WORK/node-opts-gates-project"
fresh_gates_fixture "$NODE_OPTS_FIXTURE"
node_opts_expected="$(printf '{"cwd": "%s"}' "$NODE_OPTS_FIXTURE" | UNLAZY_SKILL_DIR="$GOOD_SKILL" node "$GOOD_SKILL/scripts/stop-hook.mjs" --unlazy)"
node_opts_out="$(printf '{"cwd": "%s"}' "$NODE_OPTS_FIXTURE" | UNLAZY_SKILL_DIR="$GOOD_SKILL" NODE_OPTIONS="--require=$EVIL_REQUIRE" bash "$WRAPPER" --unlazy)"
if [ "$node_opts_out" = "$node_opts_expected" ] && [ ! -f "$NODE_OPTS_MARKER" ]; then
  echo "  ok   F-3 closed: an injected NODE_OPTIONS --require is cleared, never runs inside the hook's node"
else
  echo "  FAIL NODE_OPTIONS was not cleared -> out=$node_opts_out marker=$([ -f "$NODE_OPTS_MARKER" ] && echo present || echo absent)"; fail=1
fi

n=$((n + 1))
# F-1 wedge fix: on a pin mismatch with stop_hook_active already true, the wrapper must RELEASE
# (no "decision":"block", a systemMessage instead) rather than block again -- and still never run
# the unverified file (marker absent).
WEDGE_SKILL="$WORK/wedge-skill"
WEDGE_MARKER="$WORK/wedge.marker"
rm -f "$WEDGE_MARKER"
make_tampered_skill "$WEDGE_SKILL" "$WEDGE_MARKER"
wedge_out="$(printf '{"cwd": "%s", "stop_hook_active": true}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$WEDGE_SKILL" bash "$WRAPPER" --unlazy)"
if ! printf '%s' "$wedge_out" | grep -q '"decision"' \
  && printf '%s' "$wedge_out" | grep -q '"systemMessage"' \
  && [ ! -f "$WEDGE_MARKER" ]; then
  echo "  ok   F-1 closed: stop_hook_active=true + pin mismatch releases (systemMessage, no block) without ever running unverified code"
else
  echo "  FAIL expected a release (systemMessage, no decision field) and no marker -> out=$wedge_out marker=$([ -f "$WEDGE_MARKER" ] && echo present || echo absent)"; fail=1
fi

n=$((n + 1))
# Same mismatch with stop_hook_active absent/false must still BLOCK as before (the release path
# must not leak into the normal case).
normal_block_out="$(printf '{"cwd": "%s", "stop_hook_active": false}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$WEDGE_SKILL" bash "$WRAPPER" --unlazy)"
if printf '%s' "$normal_block_out" | grep -q '"decision": "block"'; then
  echo "  ok   stop_hook_active=false + pin mismatch still blocks normally (release path does not leak into the default case)"
else
  echo "  FAIL expected a normal block decision when stop_hook_active is false -> out=$normal_block_out"; fail=1
fi

n=$((n + 1))
# M2-style mutant (CYBERED/QA naming): neutralise fail()'s OWN internal exit (the line tagged
# MUTATION-TARGET-FAIL-EXIT) and confirm the CALL SITE's redundant `exit 0` right after fail(...)
# still halts the script before any copy/exec step -- this is the actual fix for the v1 vacuous
# oracle (F-4), proven live rather than just claimed.
M2_WRAPPER="$WORK/wrapper-m2.sh"
sed 's/^  exit 0 # MUTATION-TARGET-FAIL-EXIT.*/  : # exit neutralised by M2 mutant/' "$WRAPPER" > "$M2_WRAPPER"
chmod +x "$M2_WRAPPER"
if ! grep -q ': # exit neutralised by M2 mutant' "$M2_WRAPPER"; then
  echo "  FAIL could not construct the M2 mutant copy (sed did not match the tagged line)"; fail=1
else
  M2_MARKER="$WORK/m2.marker"
  rm -f "$M2_MARKER"
  M2_SKILL="$WORK/m2-skill"
  make_tampered_skill "$M2_SKILL" "$M2_MARKER"
  m2_out="$(printf '{"cwd": "%s"}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$M2_SKILL" bash "$M2_WRAPPER" --unlazy)"
  if printf '%s' "$m2_out" | grep -q '"decision": "block"' && [ ! -f "$M2_MARKER" ]; then
    echo "  ok   M2 mutant (fail()'s own exit neutralised) still refuses: the call-site's redundant exit catches it"
  else
    echo "  FAIL M2 mutant defeated the refusal -> out=$m2_out marker=$([ -f "$M2_MARKER" ] && echo present || echo absent)"; fail=1
  fi
fi

n=$((n + 1))
# The private temp copy dir must not leak on the success path (this is why the final node call is
# not `exec`'d -- see the script's own comment). Run the happy path once more and confirm no
# cc-* / tmp.* directory from this invocation is left behind under the system temp root.
BEFORE_TMP_COUNT=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -user "$(id -un)" -newer "$WORK" 2>/dev/null | wc -l)
printf '{"cwd": "%s"}' "$GATES_FIXTURE" | UNLAZY_SKILL_DIR="$GOOD_SKILL" bash "$WRAPPER" --unlazy >/dev/null 2>&1
AFTER_TMP_COUNT=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -user "$(id -un)" -newer "$WORK" 2>/dev/null | wc -l)
if [ "$AFTER_TMP_COUNT" -le "$BEFORE_TMP_COUNT" ]; then
  echo "  ok   the private temp copy dir does not leak on the success path"
else
  echo "  FAIL temp entries under \${TMPDIR:-/tmp} grew from $BEFORE_TMP_COUNT to $AFTER_TMP_COUNT after one successful call -- a leak"; fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
