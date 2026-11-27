#!/usr/bin/env bash
# unlazy-stop-hook-verified.sh -- fail-closed integrity wrapper for unlazy's Claude Code Stop hook
# (card 9ed32347, WhiteHat F2 MEDIUM on e060a794; hardened per QA FAIL 39488 + CYBERED NO-GO 39489
# on the first attempt, f5b8b136).
#
# WHY THIS EXISTS: every fleet agent's Stop hook used to exec
# ~/.claude/skills/unlazy/scripts/stop-hook.mjs directly. That path is inside ~/.claude/skills,
# which EVERY agent (same uid) can write -- an unauthorised edit there becomes code execution in
# every agent's session, with nothing but a periodic, after-the-fact integrity sweep
# (vendored-skill-integrity.py) to ever notice. There is no per-agent OS-level isolation yet
# (that is a separate, larger card: 85a668aa), so same-uid separation is NOT what closes this --
# this wrapper is the best available mitigation until that card lands, not a substitute for it.
#
# HOW IT WORKS (v2, closes the TOCTOU the first version had):
#   1. PATH is reset to /usr/bin:/bin and NODE_OPTIONS is cleared, BEFORE anything else runs, so
#      an agent-writable earlier PATH entry (e.g. ~/.bun/bin) or an injected NODE_OPTIONS require
#      cannot substitute a binary or runtime module (QA 39488 F-3 / CYBERED 39489 F-3).
#   2. The two execution-critical files (scripts/stop-hook.mjs + its only import,
#      scripts/lib/gates.mjs) are COPIED into a fresh, private, 0700 temp directory FIRST.
#   3. The hash check runs against the COPY, not the live skill-dir original. The copy and the
#      exec target are now the SAME bytes on disk -- there is no window between "verified" and
#      "executed" for a concurrent writer to win (QA 39488 F-2 / CYBERED 39489 F-2, both measured:
#      22/120 and 50/120 TOCTOU wins respectively against the v1 hash-then-exec-original design).
#      The temp dir is removed on every exit path (trap on EXIT) -- including the success path,
#      which is why the final node call is NOT `exec`'d (exec would replace this process and skip
#      the trap, leaking a temp dir on every single call).
#   4. stdin is read ONCE into a temp file (so it can be re-fed to node without a shell exec'd
#      pipeline eating it) and the stop_hook_active field is checked. On any verification failure
#      (mismatch, missing file, missing binary) while stop_hook_active is already true, this
#      RELEASES (systemMessage, no "decision":"block") instead of blocking again -- a pin
#      mismatch or re-vendor-without-re-pin must not wedge every Stop of every wired agent forever
#      (QA 39488 F-1 / CYBERED 39489 F-1: the real unlazy script's own MAX_BLOCKS=6 does not apply
#      here, since this is a wrapper-level refusal, not unlazy's own gate state). Releasing never
#      runs anything unverified; it just stops insisting on a re-check the agent cannot fix by
#      retrying.
#
# store/ is gitignored by default except for *.sh/*.py (update-safety skill), so the pin lives
# INLINE in this tracked script, not a separate store/*.json manifest (a manifest would never be
# tracked, silently defeating the whole point of a reviewed, version-controlled pin).
#
# Usage: unchanged from the direct-exec shape it replaces --
#   unlazy-stop-hook-verified.sh [--unlazy] [--scope <id>]
# (stdin/stdout/exit code and all args are passed through to node unmodified on a match.)
#
# Re-pin (deliberate act, as part of a store/vendor-skill.sh re-vendor of unlazy -- that script now
# prints a loud reminder when it re-vendors a skill a *-verified.sh wrapper pins; see its own
# VENDORED.md too; never re-pin to silence a mismatch without checking why it changed first):
#   /usr/bin/sha256sum ~/.claude/skills/unlazy/scripts/stop-hook.mjs ~/.claude/skills/unlazy/scripts/lib/gates.mjs
# and update PINNED_FILES below.
set -u

# --- F-3: absolute, non-agent-writable binaries only; no PATH/NODE_OPTIONS influence -----------
PATH="/usr/bin:/bin"
unset NODE_OPTIONS
SHA256SUM="/usr/bin/sha256sum"
CUT="/usr/bin/cut"
NODE="/usr/bin/node"

SKILL_DIR="${UNLAZY_SKILL_DIR:-$HOME/.claude/skills/unlazy}"

# relative-path:pinned-sha256 pairs, pinned at vendored commit 754d9a68109e39b836cc72a39fb9a823f9d6b613.
PINNED_FILES=(
  "scripts/stop-hook.mjs:202afd68d7a2b77373d7855fe5263071c081c587850c0e2426cd6ed63ce6ce5c"
  "scripts/lib/gates.mjs:ea65998774486d47cd93317960c81b553251a4ccf2dfd8ba6a57c84ef1c75e5b"
)

TMP_COPY_DIR=""
TMP_STDIN_FILE=""
cleanup() {
  [ -n "$TMP_COPY_DIR" ] && rm -rf "$TMP_COPY_DIR" 2>/dev/null
  [ -n "$TMP_STDIN_FILE" ] && rm -f "$TMP_STDIN_FILE" 2>/dev/null
}
trap cleanup EXIT

# --- F-1: read stdin ONCE, check stop_hook_active before deciding how to fail -------------------
TMP_STDIN_FILE="$(mktemp)" || { printf '{"decision": "block", "reason": "unlazy-stop-hook-verified: mktemp failed for stdin capture -- refusing to run an unverified Stop hook"}\n'; exit 0; }
cat > "$TMP_STDIN_FILE"
STOP_HOOK_ACTIVE=0
if grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' "$TMP_STDIN_FILE" 2>/dev/null; then
  STOP_HOOK_ACTIVE=1
fi

# fail() NEVER execs anything -- it only ever blocks or releases. Every call site also `exit`s
# redundantly right after calling it, so a mutant that removes fail()'s own exit (CYBERED/QA's
# "M2": block() made a no-op, falls through to exec the unverified file) cannot defeat the refusal
# -- the call site's own exit still terminates the script before any copy/exec step runs.
fail() {
  local reason="$1"
  if [ "$STOP_HOOK_ACTIVE" = "1" ]; then
    printf '{"systemMessage": "unlazy-stop-hook-verified: %s -- stop_hook_active is already true, releasing instead of blocking again so the agent is not wedged by a condition it cannot fix by retrying. No unverified code was run."}\n' "$reason"
  else
    printf '{"decision": "block", "reason": "unlazy-stop-hook-verified: %s"}\n' "$reason"
  fi
  exit 0 # MUTATION-TARGET-FAIL-EXIT (selftest neutralises exactly this line to test the call-site redundant exit)
}

command -v "$SHA256SUM" >/dev/null 2>&1 || { fail "sha256sum not found at $SHA256SUM -- cannot verify the pinned hashes, refusing to run an unverified Stop hook"; exit 0; }
command -v "$NODE" >/dev/null 2>&1 || { fail "node not found at $NODE -- cannot run the Stop hook at all, refusing silently would be worse than saying so"; exit 0; }

for entry in "${PINNED_FILES[@]}"; do
  rel="${entry%%:*}"
  expected="${entry#*:}"
  src="$SKILL_DIR/$rel"
  if [ ! -f "$src" ]; then
    fail "pinned file $rel is missing at $src -- refusing to run an unverified Stop hook"
    exit 0
  fi
done

# --- F-2: copy FIRST (into a private 0700 dir), hash the COPY, exec the SAME copy ---------------
# This is the line that closes the race: there is no gap between "the bytes we checked" and "the
# bytes we run", because after this point we never touch $SKILL_DIR again.
TMP_COPY_DIR="$(mktemp -d)" || { fail "mktemp -d failed -- cannot make a private copy, refusing to run an unverified Stop hook"; exit 0; }
chmod 700 "$TMP_COPY_DIR"
mkdir -p "$TMP_COPY_DIR/scripts/lib"

for entry in "${PINNED_FILES[@]}"; do
  rel="${entry%%:*}"
  src="$SKILL_DIR/$rel"
  dst="$TMP_COPY_DIR/$rel"
  if ! cp "$src" "$dst" 2>/dev/null; then
    fail "could not copy pinned file $rel into a private temp dir -- refusing to run an unverified Stop hook"
    exit 0
  fi
done

for entry in "${PINNED_FILES[@]}"; do
  rel="${entry%%:*}"
  expected="${entry#*:}"
  copy="$TMP_COPY_DIR/$rel"
  actual="$("$SHA256SUM" "$copy" 2>/dev/null | "$CUT" -d' ' -f1)"
  if [ -z "$actual" ] || [ "$actual" != "$expected" ]; then
    fail "$rel does not match its pinned hash (expected ${expected:0:12}..., got ${actual:0:12}...) -- the live unlazy copy differs from what was pinned; refusing to run it until this is checked and this script's own PINNED_FILES is updated via a deliberate store/vendor-skill.sh re-vendor"
    exit 0
  fi
done

# NOT `exec` here on purpose: exec would replace this process image, which would skip the EXIT
# trap above and leak the private copy dir on every single successful Stop hook call, forever,
# across all 15 wired agents. Running node as a child and exiting explicitly keeps stdin/stdout/
# exit-code passthrough identical from the caller's side while still letting cleanup() run.
"$NODE" "$TMP_COPY_DIR/scripts/stop-hook.mjs" "$@" < "$TMP_STDIN_FILE"
rc=$?
exit "$rc"
