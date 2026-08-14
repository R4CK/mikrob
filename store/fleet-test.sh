#!/usr/bin/env bash
# fleet-test.sh -- the ONE way the fleet runs the vitest suite (card 9070461f).
#
# WHY THIS EXISTS. Running `npm test` in the live install is a HARD failure by design
# (src/__tests__/setup/assert-not-live-install.ts): the suite mutates store/, .env and
# .claude/skills/ under whatever checkout it runs in, and on 2026-07-27 a full-suite run in
# production deleted the live config-overrides.json, rewrote .env 600->644, and fired real
# break-glass Telegram alerts. So a separate checkout is REQUIRED.
#
# But the obvious separate checkout is the wrong one. A worktree under /tmp makes 7 test files
# SKIP -- the hook-registration guard correctly refuses /tmp-rooted script paths, so those suites
# cannot assert what they exist to assert (see src/__tests__/helpers/repo-location.ts; a "14 failing
# tests" baseline was once tracked as a defect when 13 were purely this artifact).
#
# Every agent was rediscovering both facts and hand-rolling a temp worktree. This script encodes the
# answer once: ONE durable, non-/tmp worktree, reused across runs and agents.
#
# Usage:
#   store/fleet-test.sh                     # sync to the live install's HEAD, run the whole suite
#   store/fleet-test.sh src/__tests__/x.ts  # ...run only these paths (any vitest args pass through)
#   store/fleet-test.sh --ref <sha|branch>  # test a specific commit instead of HEAD
#   store/fleet-test.sh --path              # print the worktree path and exit (for scripting)
#
# Exit: the vitest exit code | 2 bad usage | 3 setup failed
set -uo pipefail

ROOT="/home/neon/marveen"
TEST_TREE="${FLEET_TEST_TREE:-/home/neon/marveen-test}"
# How long to queue behind another agent's run before giving up. A full suite is ~40s including the
# build, so this is many runs deep; it exists so a stuck holder fails loudly instead of hanging.
LOCK_WAIT_SECONDS="${FLEET_TEST_LOCK_WAIT:-900}"

die() { echo "fleet-test.sh: $2" >&2; exit "$1"; }

case "$TEST_TREE" in
  /tmp/*|/var/folders/*|/private/var/folders/*)
    die 2 "FLEET_TEST_TREE points under a temp dir ($TEST_TREE). That is exactly the case this script exists to avoid: 7 suites would silently SKIP there." ;;
esac

REF=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)  REF="${2:-}"; shift 2 ;;
    --path) echo "$TEST_TREE"; exit 0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

cd "$ROOT" || die 3 "cannot cd to $ROOT"
[ -n "$REF" ] || REF="$(git rev-parse HEAD)"
TARGET="$(git rev-parse "$REF" 2>/dev/null)" || die 2 "unknown ref '$REF'"

# ONE RUN AT A TIME PER TREE (card 85faec1b). Everything below -- checkout, reset, clean, build,
# vitest -- mutates the tree, and until this lock existed every agent did that to the SAME tree with
# no coordination.
#
# MEASURED, not theorised. Two full-suite runs at the same sha reported 13 and 7 failures with
# different failing sets. The tree's reflog named the cause: while one run was in flight, other
# agents checked out fb60b0f at 20:27:54, ccb86e6 at 20:28:19 and fb60b0f again at 20:28:55. Their
# checkouts swapped the source under the running suite and rewrote source mtimes, so the
# dist-loading suites judged a build that no longer matched. The same sha in an uncontended tree
# gave 8073 passed with one unrelated failure.
#
# WHY THIS IS NOT MERELY NOISY: a gate verdict (QA/Cybersec/Cybered PASS or FAIL) could depend on
# another agent's checkout. A false red sends correct work back to in_progress; a false green lets a
# real defect through. That is corrupted evidence, not flakiness -- and it reads like flakiness,
# which invites a re-run instead of an investigation.
#
# WHY A LOCK AND NOT A TREE PER AGENT. A per-agent tree looks like the tidier fix and is not
# sufficient: the same agent can have two runs in flight (its own plus a scheduled task), and they
# would collide in exactly this way. The lock is sufficient on its own, so it is what ships;
# FLEET_TEST_TREE remains for anyone who wants their own tree, and gets its own lock, because the
# lock is keyed on the TREE PATH. A private tree therefore never queues behind the shared one.
command -v flock >/dev/null 2>&1 || die 3 "flock is required to serialise runs against $TEST_TREE (util-linux)"
LOCK_FILE="${TEST_TREE}.lock"   # beside the tree, never inside it: `git clean` must not be able to remove it
exec 9>"$LOCK_FILE" || die 3 "cannot open the lock file $LOCK_FILE"
if ! flock -n 9; then
  echo "fleet-test.sh: another run holds $TEST_TREE -- waiting (up to ${LOCK_WAIT_SECONDS}s)" >&2
  flock -w "$LOCK_WAIT_SECONDS" 9 \
    || die 3 "timed out after ${LOCK_WAIT_SECONDS}s waiting for $TEST_TREE. Another run is stuck, or use FLEET_TEST_TREE=<your own path>."
fi

# Create once, reuse forever. `git worktree add --detach` fails if the path exists, so the
# create and the update paths are deliberately separate.
if [ ! -d "$TEST_TREE/.git" ] && [ ! -f "$TEST_TREE/.git" ]; then
  echo "fleet-test.sh: creating the fleet test worktree at $TEST_TREE (one-time)" >&2
  git worktree add --detach "$TEST_TREE" "$TARGET" >/dev/null 2>&1 \
    || die 3 "could not create the worktree at $TEST_TREE"
else
  # Reset rather than pull: this tree is a disposable mirror, never a place to author changes.
  # Anything left in it from a previous run is noise we WANT gone before measuring.
  git -C "$TEST_TREE" checkout --detach "$TARGET" >/dev/null 2>&1 \
    || die 3 "could not move $TEST_TREE to $TARGET"
  git -C "$TEST_TREE" reset --hard "$TARGET" >/dev/null 2>&1
  git -C "$TEST_TREE" clean -fdq -e node_modules >/dev/null 2>&1
fi

# Share the live install's node_modules by symlink instead of installing a second copy: the deps are
# large, and a per-run `npm ci` would dominate the runtime of a 20-second suite. The symlink is
# re-pointed every run so it cannot go stale.
if [ ! -e "$TEST_TREE/node_modules" ]; then
  ln -s "$ROOT/node_modules" "$TEST_TREE/node_modules" 2>/dev/null \
    || die 3 "could not link node_modules into $TEST_TREE"
fi

# Belt and braces: prove the guard will let us run. If a live marker ever appears in the test tree
# (someone pointed FLEET_TEST_TREE at an install), fail HERE with a clear reason rather than letting
# the suite throw its generic refusal.
for m in store/.dashboard-token store/claudeclaw.db store/.claude-oauth-token; do
  [ -e "$TEST_TREE/$m" ] && die 3 "$TEST_TREE contains a LIVE marker ($m) -- it is an install, not a test tree"
done

echo "fleet-test.sh: $TEST_TREE @ $(git -C "$TEST_TREE" rev-parse --short HEAD)" >&2
cd "$TEST_TREE" || die 3 "cannot cd to $TEST_TREE"

# BUILD, because syncing the SOURCE says nothing about the ARTIFACT (card c32577e4).
#
# Nine suites load dist/ rather than src/ (process-lock, local-llm-rag-routes-by-default,
# build-freshness, version, fix-landed-check and four more). dist/ is gitignored, so the checkout
# above does not touch it and `git clean -fd` does not remove it -- it is simply whatever some
# earlier run happened to leave behind, at some other commit, with nothing recording which.
#
# MEASURED, not argued: `fleet-test.sh --ref ccb86e6` (the commit BEFORE the router's SEC-tag
# feature) synced a source with zero occurrences of SECURITY_TAGS while dist/local-llm-router.js
# still held two. The suite ran the OLD commit's source against the NEW commit's artifact and
# reported 5 failures that belonged to neither. A run like that is worse than no run: it produces a
# verdict about a commit it never tested.
#
# WHY A MARKER AND NOT AN UNCONDITIONAL BUILD. tsc takes 6.8s here, and the common call is a single
# test file that finishes in 0.5s -- a 13x tax on the cheapest, most frequent use. The marker is
# sound precisely because of the hard reset above: the tree is an exact checkout of TARGET, so the
# sha determines the source completely. Same file and same convention the live install uses
# (update.sh, recovery-prev-version.sh), so a reader meets one idea, not two.
#
# The marker is removed BEFORE building and written only after tsc succeeds: an interrupted or
# failing build must not leave behind a claim that dist matches TARGET. A failed build is fatal --
# running the suite anyway would put us back in exactly the case above, testing a stale artifact.
BUILT_MARKER="dist/.built-commit"
if [ "$(cat "$BUILT_MARKER" 2>/dev/null)" != "$TARGET" ]; then
  echo "fleet-test.sh: building dist (was: $(cat "$BUILT_MARKER" 2>/dev/null || echo 'unrecorded'))" >&2
  rm -f "$BUILT_MARKER"
  npx tsc || die 3 "the build failed -- refusing to run the suite against a stale dist/ (see above)"
  echo "$TARGET" > "$BUILT_MARKER"
fi

# KNOWN BENIGN FLAKE (card 54699bbb). vitest's own worker-pool RPC (birpc) has a HARDCODED 60s
# timeout with no config knob; under load (this suite, this WSL sandbox) that round-trip
# occasionally misses it, and vitest exits 1 with an "Unhandled Error: [vitest-worker]: Timeout
# calling \"onTaskUpdate\"" even though every single test passed. This is not our bug: it is
# upstream and reported non-deterministic (vitest-dev/vitest #6479, #4497, #8164 -- "~1 in 5
# runs locally", CI-only for some). Reproduced identically in an UNRELATED codebase (CleanCore,
# vitest 3.2.6) in the same sandbox, confirming it tracks the environment, not this repo's tests.
#
# CORRECTED 2026-08-14 (backend, card e00c12ad; verified here in the installed source rather than
# taken on trust). This used to say "no config knob BEFORE vitest 3.x", which reads as though 3.x
# has one. It does not: in vitest 3.2.6, `createForksRpcOptions()` returns serialize/deserialize/
# post/on and passes NO timeout at all, so birpc's default applies on this version too. The scope of
# the statement was wrong, not its conclusion -- and a comment that quietly narrows a known
# limitation is how the next person stops looking for it.
#
# The exit code is real and callers must NOT swallow it -- but a reader who sees only "exit 1"
# without reading the whole log can mistake this for a regression (exactly the signal-blindness
# risk this card exists to close: don't just eyeball the green counter, and don't just eyeball
# the exit code either -- read what's ACTUALLY unhandled). So: run once, capture the log, and if
# the ONLY thing wrong is this exact known flake (no "N failed" anywhere in the summary), say so
# explicitly instead of leaving a bare exit 1 for the next reader to re-diagnose from scratch.
run_log="$(mktemp)"
trap 'rm -f "$run_log"' EXIT
if [ ${#ARGS[@]} -gt 0 ]; then
  npx vitest run "${ARGS[@]}" 2>&1 | tee "$run_log"
else
  npx vitest run 2>&1 | tee "$run_log"
fi
status="${PIPESTATUS[0]}"

if [ "$status" -ne 0 ] \
  && grep -q 'Timeout calling "onTaskUpdate"' "$run_log" \
  && ! grep -qE '(Test Files|Tests)[[:space:]]+[0-9]+ failed' "$run_log"
then
  {
    echo
    echo "fleet-test.sh: KNOWN BENIGN FLAKE, not a regression (card 54699bbb)."
    echo "  Every test above passed (no 'N failed' in the summary). The nonzero exit ($status)"
    echo "  comes ONLY from vitest's own worker-RPC timeout (birpc's hardcoded 60s bound,"
    echo "  vitest-dev/vitest#6479/#4497/#8164), not from this repo. Re-run for a clean exit"
    echo "  code if you need one; do not treat this run alone as a failed suite."
  } >&2
fi

exit "$status"
