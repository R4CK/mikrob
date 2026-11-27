#!/usr/bin/env bash
# unlazy-stop-hook-verified.sh -- fail-closed integrity wrapper for unlazy's Claude Code Stop hook
# (card 9ed32347, WhiteHat F2 MEDIUM on e060a794; hardened twice: QA FAIL 39488 + CYBERED NO-GO
# 39489 on f5b8b136, then CYBERED NO-GO 39499 on 47b72ccf).
#
# WHY THIS EXISTS: every fleet agent's Stop hook used to exec
# ~/.claude/skills/unlazy/scripts/stop-hook.mjs directly. That path is inside ~/.claude/skills,
# which EVERY agent (same uid) can write -- an unauthorised edit there becomes code execution in
# every agent's session, with nothing but a periodic, after-the-fact integrity sweep
# (vendored-skill-integrity.py) to ever notice. There is no per-agent OS-level isolation yet
# (that is a separate, larger card: 85a668aa), so same-uid separation is NOT what closes this --
# this wrapper NARROWS the attack window, it does NOT remove it. CYBERED (39499 F-1) raced the
# private copy itself (a same-uid poller that finds the new temp dir and rewrites the copy before
# the hash reads it) and won 2 of 240 runs with a naive, non-inotify poller against a mktemp-named
# dir -- down from 22-50 of 120 (roughly 18-42%) against the v1 design, but not zero. 85a668aa
# (per-agent OS user) is the actual close; until it lands, this wrapper plus the read-only
# hardening below (which raises the attacker's cost from "overwrite" to "chmod then overwrite")
# is the best available mitigation, not a substitute.
#
# HOW IT WORKS (v3):
#   1. PATH is reset to /usr/bin:/bin and NODE_OPTIONS is cleared, BEFORE anything else runs, so
#      an agent-writable earlier PATH entry (e.g. ~/.bun/bin) or an injected NODE_OPTIONS require
#      cannot substitute a binary or runtime module (QA 39488 F-3 / CYBERED 39489 F-3, both closed:
#      QA/CYBERED's own independent re-probes on 47b72ccf found 0 fake-binary invocations).
#   2. stdin is read ONCE into a shell variable, and stop_hook_active is decided from that
#      variable, BEFORE any mktemp call. This matters: v2 captured stdin via `mktemp` + `cat >`,
#      so a broken TMPDIR (full disk, read-only, missing) made the wrapper hard-block even when
#      stop_hook_active was already true -- CYBERED 39499 F-2, the same wedge class as F-1 on the
#      first attempt, just triggered by TMPDIR instead of a pin mismatch. Deciding
#      STOP_HOOK_ACTIVE from the in-memory variable first means a later mktemp/cp failure can
#      still correctly choose "release" over "block forever".
#   3. The two execution-critical files (scripts/stop-hook.mjs + its only import,
#      scripts/lib/gates.mjs) are COPIED into a fresh, private, 0700 temp directory, then the
#      COPIES are chmod'd to 0400 (files) / 0500 (dirs) -- read-only to everyone including this
#      same uid, so reopening them for a write needs an explicit chmod first, not a bare
#      overwrite (CYBERED 39499 F-1 hardening: this does not make the race impossible, it adds one
#      more step the racer's loop has to do, which is why "2 of 240" and not "0 of 240" is the
#      honest number to carry forward, not "0").
#   4. The hash check runs against the (now read-only) COPY, not the live skill-dir original, and
#      the exec target is the SAME path that was hashed (QA 39488 F-2 / CYBERED 39489 F-2: 0/120
#      and 0/300 wins respectively against the skill-dir race once hashing moved to the copy; this
#      closed that specific race completely -- it is the SEPARATE copy-dir race in point 3 above
#      that remains open and is now named honestly rather than claimed closed).
#      The temp dir is removed on every exit path (trap on EXIT) -- including the success path,
#      which is why the final node call is NOT `exec`'d (exec would replace this process and skip
#      the trap, leaking a temp dir on every single call). A SIGKILL (not SIGTERM) to this script
#      can still leak the dir -- no trap catches that signal; CYBERED measured this as leftover
#      entries after SIGKILL only, SIGTERM is caught and cleaned (39499, INFO).
#   5. On any verification failure (mismatch, missing file, missing binary, mktemp/cp failure)
#      while stop_hook_active is already true, this RELEASES (systemMessage, no
#      "decision":"block") instead of blocking again -- a pin mismatch, a re-vendor-without-re-pin,
#      or a broken TMPDIR must not wedge every Stop of every wired agent forever (QA 39488 F-1 /
#      CYBERED 39489 F-1 / CYBERED 39499 F-2: the real unlazy script's own MAX_BLOCKS=6 does not
#      apply here, since this is a wrapper-level refusal, not unlazy's own gate state). Releasing
#      never runs anything unverified; it just stops insisting on a re-check the agent cannot fix
#      by retrying.
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

# --- F-3 (39489): absolute, non-agent-writable binaries only; no PATH/NODE_OPTIONS influence ---
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
  # the copy dir was chmod'd 0500/0400 (F-1 hardening) -- chmod it back to writable first, or
  # rm -rf on some systems/umask combos cannot remove read-only entries it does not own the write
  # bit on, even as the same uid that created them.
  [ -n "$TMP_COPY_DIR" ] && chmod -R u+w "$TMP_COPY_DIR" 2>/dev/null
  [ -n "$TMP_COPY_DIR" ] && rm -rf "$TMP_COPY_DIR" 2>/dev/null
  [ -n "$TMP_STDIN_FILE" ] && rm -f "$TMP_STDIN_FILE" 2>/dev/null
}
trap cleanup EXIT

# --- F-2 (39499): decide stop_hook_active from an in-memory read BEFORE any mktemp call ---------
# v2 captured stdin via `mktemp` + `cat > file`, so a broken TMPDIR made this block even when
# stop_hook_active was already true. Reading into a variable first has no filesystem dependency,
# so STOP_HOOK_ACTIVE is known even if every mktemp call below fails.
STOP_INPUT="$(cat)"
STOP_HOOK_ACTIVE=0
if printf '%s' "$STOP_INPUT" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
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

# --- copy FIRST (into a private 0700 dir), lock the copy read-only, hash the COPY, exec the SAME
# copy. This closes the skill-dir race completely (QA 0/300, CYBERED 0/120 independent re-probes
# on 47b72ccf) and narrows -- does not close -- the separate copy-dir race (CYBERED 39499 F-1,
# 2/240 against a naive poller). mktemp/chmod/cp failures release instead of blocking when
# stop_hook_active is already true (F-2 above), since STOP_HOOK_ACTIVE was already decided.
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
# TEST-SEAM-COPY-LOOP-DONE -- selftest anchor: a deterministic (non-racy) tamper-after-copy case
# sed-inserts a line right after this comment, in a disposable copy of this script only.

# F-1 hardening: make the copies read-only to EVERYONE, including this same uid, right after the
# copy and before the hash. This does not make the race impossible (the same uid can chmod its
# own files back to writable and then overwrite them -- same uid, same privileges, always true
# until 85a668aa), but it removes "a bare overwrite wins" and requires an extra chmod step, which
# is why the measured window narrowed further under this same hardening pattern.
chmod 400 "$TMP_COPY_DIR/scripts/stop-hook.mjs" "$TMP_COPY_DIR/scripts/lib/gates.mjs" 2>/dev/null
chmod 500 "$TMP_COPY_DIR/scripts/lib" "$TMP_COPY_DIR/scripts" "$TMP_COPY_DIR" 2>/dev/null

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

TMP_STDIN_FILE="$(mktemp)" || { fail "mktemp failed while preparing to feed stdin to node -- refusing to run an unverified Stop hook"; exit 0; }
printf '%s' "$STOP_INPUT" > "$TMP_STDIN_FILE" || { fail "could not write the captured stdin to a temp file -- refusing to run an unverified Stop hook"; exit 0; }

# NOT `exec` here on purpose: exec would replace this process image, which would skip the EXIT
# trap above and leak the private copy dir on every single successful Stop hook call, forever,
# across all 15 wired agents. Running node as a child and exiting explicitly keeps stdin/stdout/
# exit-code passthrough identical from the caller's side while still letting cleanup() run.
"$NODE" "$TMP_COPY_DIR/scripts/stop-hook.mjs" "$@" < "$TMP_STDIN_FILE"
rc=$?
exit "$rc"
