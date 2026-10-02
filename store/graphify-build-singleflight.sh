#!/usr/bin/env bash
# graphify-build-singleflight.sh -- single-flight + coalescing wrapper around `graphify.sh build`
# (card 0cfd1dbc).
#
# PROBLEM (measured repeatedly): mopsion-land.sh fires a detached `graphify.sh build <repo>` on
# EVERY successful landing, with no dedup. In a landing-heavy window this accumulates: 2026-09-29
# 08:20 saw 11 concurrent/queued builds, 2026-10-01 saw 5 then 3 more (same day), 2026-10-02 18:20
# saw 7, the oldest 3 hours old and none finishing -- each ~1.1GB RSS, pushing load to 21-24 and
# tripping the load-guard's sigstop-freeze.
#
# PATTERN: at most ONE `graphify.sh build <repo>` runs per repo at a time. A request that arrives
# while one is already running does not start a second process -- it marks a "dirty" flag, which
# the IN-FLIGHT run itself picks up and loops to cover with ONE more build before releasing the
# lock. So a burst of N landings collapses to at most 2 actual builds (the one already running,
# plus at most one more covering everything that arrived during it) -- never N.
#
# USAGE: store/graphify-build-singleflight.sh <repo-path>
# Exit 0 whether this invocation becomes the builder or just defers to one already running --
# callers (mopsion-land.sh) must not treat a fast return as failure.
set -euo pipefail

REPO="${1:?usage: graphify-build-singleflight.sh <repo-path>}"
[ -d "$REPO" ] || { echo "graphify-build-singleflight.sh: not a directory: $REPO" >&2; exit 4; }

# Testability seam only -- production callers never set this; it lets the selftest substitute a
# fake builder without touching the real graphify.sh.
GRAPHIFY_SH="${GRAPHIFY_SH:-$(dirname "$0")/graphify.sh}"

STATE_DIR="$REPO/graphify-out"
mkdir -p "$STATE_DIR"
LOCK="$STATE_DIR/.graphify-build.lock"
DIRTY="$STATE_DIR/.graphify-build.dirty"

# Mark "a build covering the CURRENT state is wanted" BEFORE attempting the lock. This is what
# lets a run already in flight pick up our request even when we never get the lock ourselves --
# without it, a request that loses the race for the lock would be silently dropped instead of
# coalesced.
touch "$DIRTY"

exec 9>"$LOCK"
if ! flock -n 9; then
  # Someone else is already building (or about to loop again below) -- the dirty-flag touch above
  # is sufficient; it will be picked up without us starting a second process.
  exit 0
fi

# We hold the lock. Loop: claim the current dirty state, build, then check whether a NEW request
# arrived while we were building -- if so, what we just built is already stale, so build once
# more before releasing the lock.
while :; do
  rm -f "$DIRTY"
  "$GRAPHIFY_SH" build "$REPO"
  [ -e "$DIRTY" ] || break
done
flock -u 9
