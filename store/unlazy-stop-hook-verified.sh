#!/usr/bin/env bash
# unlazy-stop-hook-verified.sh -- fail-closed integrity wrapper for unlazy's Claude Code Stop hook
# (card 9ed32347, WhiteHat F2 MEDIUM on e060a794).
#
# WHY THIS EXISTS: every fleet agent's Stop hook used to exec
# ~/.claude/skills/unlazy/scripts/stop-hook.mjs directly. That path is inside ~/.claude/skills,
# which EVERY agent (same uid) can write -- an unauthorised edit there becomes code execution in
# every agent's session, with nothing but a periodic, after-the-fact integrity sweep
# (vendored-skill-integrity.py) to ever notice. There is no per-agent OS-level isolation yet
# (that is a separate, larger card: 85a668aa) so the actual prevention available today is a
# pre-exec hash check against hashes PINNED IN THIS SCRIPT ITSELF -- store/ is gitignored by
# default except for *.sh/*.py (update-safety skill), so a SEPARATE manifest .json here would
# silently never be tracked, defeating the whole point of a reviewed, version-controlled pin. The
# hashes below are the pin; this file's own git history is the audit trail.
#
# On any mismatch (tampered file, missing file, missing python3/sha256sum) this FAILS CLOSED: it
# never silently execs the live copy, and it never silently does nothing either. It emits the
# SAME Stop-hook "block" JSON contract unlazy's own script uses, so a tamper (or an unpinned
# legitimate upstream update) is loud -- it blocks the agent's turn from ending with a visible
# reason, instead of either running unverified code or vanishing without a trace.
#
# Usage: unchanged from the direct-exec shape it replaces --
#   unlazy-stop-hook-verified.sh [--unlazy] [--scope <id>]
# (stdin/stdout/exit code and all args are passed through to node unmodified on a match.)
#
# Re-pin (deliberate act, as part of a store/vendor-skill.sh re-vendor of unlazy -- see its own
# VENDORED.md, never to silence a mismatch without checking why it changed first):
#   sha256sum ~/.claude/skills/unlazy/scripts/stop-hook.mjs ~/.claude/skills/unlazy/scripts/lib/gates.mjs
# and update PINNED_FILES below.
set -u

SKILL_DIR="${UNLAZY_SKILL_DIR:-$HOME/.claude/skills/unlazy}"

# relative-path:pinned-sha256 pairs, pinned at vendored commit 754d9a68109e39b836cc72a39fb9a823f9d6b613.
PINNED_FILES=(
  "scripts/stop-hook.mjs:202afd68d7a2b77373d7855fe5263071c081c587850c0e2426cd6ed63ce6ce5c"
  "scripts/lib/gates.mjs:ea65998774486d47cd93317960c81b553251a4ccf2dfd8ba6a57c84ef1c75e5b"
)

block() {
  printf '{"decision": "block", "reason": "unlazy-stop-hook-verified: %s"}\n' "$1"
  exit 0
}

command -v sha256sum >/dev/null 2>&1 || block "sha256sum not on PATH -- cannot verify the pinned hashes, refusing to run an unverified Stop hook"

for entry in "${PINNED_FILES[@]}"; do
  rel="${entry%%:*}"
  expected="${entry#*:}"
  file="$SKILL_DIR/$rel"
  if [ ! -f "$file" ]; then
    block "pinned file $rel is missing at $file -- refusing to run an unverified Stop hook"
  fi
  actual="$(sha256sum "$file" 2>/dev/null | cut -d' ' -f1)"
  if [ -z "$actual" ] || [ "$actual" != "$expected" ]; then
    block "$rel does not match its pinned hash (expected ${expected:0:12}..., got ${actual:0:12}...) -- the live unlazy copy differs from what was pinned; refusing to run it until this is checked and this script's own PINNED_FILES is updated via a deliberate store/vendor-skill.sh re-vendor"
  fi
done

exec node "$SKILL_DIR/scripts/stop-hook.mjs" "$@"
