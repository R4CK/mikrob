#!/usr/bin/env bash
# cleancore-main-suite-guard.sh -- notice when the SHARED LOCAL main goes red (card ec44220b).
#
# THE GAP THIS CLOSES. CI runs on push to origin/main. But the fleet does not commit to origin --
# every agent commits into ONE shared local checkout of `main`, and nothing runs the apps/api suite
# there. So local main can sit red for hours (it did) until someone happens to run the right file,
# and the eventual landing merge then carries a break nobody attributed. This is not a CI gap and
# not a bypass: it is a branch no CI was ever pointed at.
#
# WHAT IT MEASURES, AND WHAT IT DELIBERATELY DOES NOT.
#   - The COMMITTED tip of local main, in a separate worktree. Never the shared working tree: that
#     holds a dozen agents' uncommitted WIP and untracked files, so a run there tells you about
#     work in flight, not about what landed. (The same distinction that makes `git checkout-index`
#     the honest way to verify a commit.)
#   - Only apps/api. That is the suite the card is about and the one the landing merge keeps
#     breaking; widening it later is a one-line change to SUITE.
#
# WHY IT IS CHEAP DESPITE A SLOW SUITE. The full apps/api run takes MINUTES on this machine, so a
# fixed-interval full run would burn a core all day for nothing. Instead the guard is keyed on the
# HEAD SHA: if nothing new was committed since the last run it exits in well under a second. The
# cost therefore tracks commit activity, not wall-clock.
#
# REPORTS ONLY TRANSITIONS. A repo with a known-red baseline that shouts every run gets muted, and
# a muted guard is not a guard. It speaks when the failure count RISES (or green -> red), names the
# commit range that can be responsible, and otherwise stays quiet.
#
# Usage:
#   store/cleancore-main-suite-guard.sh            # the scheduled path: silent unless it regressed
#   store/cleancore-main-suite-guard.sh --force    # run even if HEAD is unchanged
#   store/cleancore-main-suite-guard.sh --status   # print the recorded baseline and exit
#
# Output contract (for the scheduled task that reads it):
#   STATE:unchanged | STATE:measured
#   RESULT:OK | RESULT:REGRESSION | RESULT:IMPROVED | RESULT:SETUP-FAILED
# Exit: 0 measured or skipped | 1 regression | 3 setup failed | 2 bad usage
set -uo pipefail

REPO="${CC_REPO:-/mnt/h/LM_Studio_Workdir/CleanCore}"
TREE="${CC_MAIN_GUARD_TREE:-/home/neon/cc-mainguard}"
STATE="${CC_MAIN_GUARD_STATE:-/home/neon/marveen/store/cleancore-main-suite-state.json}"
SUITE="${CC_MAIN_GUARD_SUITE:-apps/api}"
BRANCH="${CC_MAIN_GUARD_BRANCH:-main}"

die() { echo "RESULT:SETUP-FAILED"; echo "cleancore-main-suite-guard: $1" >&2; exit 3; }

# A worktree under /tmp is not equivalent: the fleet has already measured suites silently SKIPPING
# there because guards refuse /tmp-rooted paths (see store/fleet-test.sh). A green run in the wrong
# place is worse than no run, so refuse rather than quietly measure less.
case "$TREE" in
  /tmp/*|/var/tmp/*|/dev/shm/*) die "CC_MAIN_GUARD_TREE is under a temp dir ($TREE); suites can silently skip there" ;;
esac

FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  --status) [ -f "$STATE" ] && cat "$STATE" || echo '{}'; exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--force|--status]" >&2; exit 2 ;;
esac

# ONE RUN AT A TIME. Added the moment this went on cron at */15 (card ec44220b): the full apps/api
# suite is 8.1 minutes MEASURED on a quiet machine, and the fleet does not keep the machine quiet.
# A run that overruns 15 minutes would meet the next tick, and the damage is not merely two suites
# competing for CPU -- both instances drive the SAME worktree, so the second one's
# `checkout --detach` + `reset --hard` + `clean -fd` yanks files out from under the first one's
# vitest. That manufactures failures that no commit caused, writes them to the shared state file,
# and sends a REGRESSION alert naming innocent commits. A guard that cries wolf is worse than no
# guard, so a second instance exits immediately and silently instead.
LOCK="${CC_MAIN_GUARD_LOCK:-/home/neon/marveen/store/.cleancore-main-suite-guard.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK" || die "cannot open the lock file at $LOCK"
  if ! flock -n 9; then
    echo "STATE:busy"   # a previous run is still measuring; the next tick will pick it up
    exit 0
  fi
fi

[ -d "$REPO/.git" ] || die "no CleanCore checkout at $REPO"
HEAD="$(git -C "$REPO" rev-parse "$BRANCH" 2>/dev/null)" || die "cannot resolve $BRANCH in $REPO"

prev_sha=""; prev_fails=""
if [ -f "$STATE" ]; then
  prev_sha="$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$STATE" | head -1)"
  prev_fails="$(sed -n 's/.*"fails"[[:space:]]*:[[:space:]]*\([0-9-]*\).*/\1/p' "$STATE" | head -1)"
fi

if [ "$FORCE" -eq 0 ] && [ "$HEAD" = "$prev_sha" ]; then
  echo "STATE:unchanged"
  exit 0
fi

# Disposable mirror of the committed tip. Reset rather than pull: anything left from a previous run
# is noise we want gone before measuring.
if [ ! -e "$TREE/.git" ]; then
  git -C "$REPO" worktree add --detach "$TREE" "$HEAD" >/dev/null 2>&1 \
    || die "could not create the guard worktree at $TREE"
else
  git -C "$TREE" checkout --detach "$HEAD" >/dev/null 2>&1 || die "could not move $TREE to $HEAD"
  git -C "$TREE" reset --hard "$HEAD" >/dev/null 2>&1
  git -C "$TREE" clean -fdq -e node_modules -e '*/node_modules' >/dev/null 2>&1
fi

# pnpm resolves per package, so a single root symlink is NOT enough -- vitest fails to resolve its
# own plugins from a package dir that has no node_modules, which reads like "the guard is broken"
# rather than "the copy is incomplete". Link the root and every package dir the real checkout has.
[ -e "$TREE/node_modules" ] || ln -s "$REPO/node_modules" "$TREE/node_modules" 2>/dev/null \
  || die "could not link the root node_modules into $TREE"
while IFS= read -r nm; do
  rel="${nm#"$REPO"/}"
  [ -e "$TREE/$rel" ] || ln -s "$nm" "$TREE/$rel" 2>/dev/null
done < <(find "$REPO/apps" "$REPO/packages" -maxdepth 3 -name node_modules -not -path '*/node_modules/*' 2>/dev/null)

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
( cd "$TREE" && ./node_modules/.bin/vitest run "$SUITE" ) >"$log" 2>&1
summary="$(grep -E '^[[:space:]]*Tests[[:space:]]' "$log" | tail -1)"
[ -n "$summary" ] || { sed -n '$p' "$log" >&2; die "the suite produced no 'Tests' summary (see the tail above)"; }

fails="$(printf '%s' "$summary" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) failed.*/\1/p')"
[ -n "$fails" ] || fails=0

printf '{"sha":"%s","fails":%s,"suite":"%s","summary":"%s"}\n' \
  "$HEAD" "$fails" "$SUITE" "$(printf '%s' "$summary" | tr -d '"' | sed 's/^[[:space:]]*//')" >"$STATE"
echo "STATE:measured"
echo "  $BRANCH @ ${HEAD:0:8} -- ${summary# }"

# First ever run has no baseline: record it, do not cry regression over a number nobody set.
if [ -z "$prev_fails" ]; then
  echo "RESULT:OK (baseline recorded, no previous measurement to compare)"
  exit 0
fi

if [ "$fails" -gt "$prev_fails" ]; then
  suspects="$(git -C "$REPO" log --oneline "${prev_sha}..${HEAD}" 2>/dev/null)"
  echo "RESULT:REGRESSION"
  echo "  apps/api failures rose ${prev_fails} -> ${fails} on the SHARED LOCAL $BRANCH."
  echo "  Commits since the last measured state (${prev_sha:0:8}), newest first:"
  printf '%s\n' "$suspects" | sed 's/^/    /'
  echo "  Reproduce exactly what this measured:"
  echo "    cd $TREE && ./node_modules/.bin/vitest run $SUITE"

  # Tell the fleet through the message API, never by writing into a tmux pane. A cron-driven pane
  # write races the dashboard's in-process send lock and can interleave with a live prompt -- the
  # defect class cards 7560bb6a / 9cfed589 exist for. /api/messages goes through the same
  # serialised path the dashboard itself uses.
  tok="/home/neon/marveen/store/.dashboard-token"
  if [ -r "$tok" ]; then
    body="$(printf 'A megosztott lokalis %s PIROSABB lett: apps/api bukasok %s -> %s (%s).\nGyanusitottak (a legutobbi meres, %s ota):\n%s\nRepro: cd %s && ./node_modules/.bin/vitest run %s' \
      "$BRANCH" "$prev_fails" "$fails" "${HEAD:0:8}" "${prev_sha:0:8}" "$suspects" "$TREE" "$SUITE" \
      | python3 -c 'import json,sys; print(json.dumps({"from":"fullstack","to":"mikrob","content":sys.stdin.read()}))')"
    printf 'Authorization: Bearer %s\n' "$(cat "$tok")" \
      | curl -H @- -s -m 15 -X POST http://localhost:3420/api/messages \
        -H 'Content-Type: application/json' --data-binary "$body" >/dev/null 2>&1 \
      || echo "  (note: could not reach the message API -- the finding is only in this output)"
  fi
  exit 1
fi

[ "$fails" -lt "$prev_fails" ] && echo "RESULT:IMPROVED (${prev_fails} -> ${fails})" && exit 0
echo "RESULT:OK (${fails} failing, unchanged)"
exit 0
