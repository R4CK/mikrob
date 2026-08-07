#!/usr/bin/env bash
# branch-upstream-audit.sh -- find local branches whose upstream points somewhere it must not
# (card 63e2069c).
#
# THE TRAP. Backend hit this and self-corrected: a worktree's branch had its upstream set to
# `origin/main`, so `@{u}..HEAD` was silently comparing against MAIN instead of that branch's own
# remote. The commit count it produced was meaningless, and the agent reading it concluded the wrong
# thing about whether the work was pushed. Nothing errors in that state -- git answers confidently
# with a number computed against the wrong ref, which is the worst shape a measurement can have.
#
# WHAT IT IS NOT. With git's default `push.default = simple`, a mismatched upstream does NOT cause
# `git push` to write to main: simple REFUSES when the upstream's name differs from the branch's.
# So this is a mis-measurement hazard, not an accidental-push-to-main one. Worth saying, because the
# fix is cheap either way and overstating it invites a rushed change to push.default that would be
# genuinely dangerous.
#
# Usage:
#   store/branch-upstream-audit.sh [repo]        # report only (default: the CleanCore checkout)
#   store/branch-upstream-audit.sh [repo] --fix  # repoint where the remote exists, unset otherwise
#
# Exit: 0 clean | 1 problems found (report mode) | 2 bad usage
set -uo pipefail

REPO="${1:-/mnt/h/LM_Studio_Workdir/CleanCore}"
[ "${1:-}" = "--fix" ] && { REPO=/mnt/h/LM_Studio_Workdir/CleanCore; FIX=1; } || FIX=0
[ "${2:-}" = "--fix" ] && FIX=1
[ -d "$REPO/.git" ] || { echo "not a git checkout: $REPO" >&2; exit 2; }

problems=0
while IFS=$'\t' read -r branch upstream; do
  [ -n "$branch" ] || continue
  want="origin/$branch"
  # No upstream at all is HONEST: `@{u}` errors instead of answering against the wrong ref.
  [ -z "$upstream" ] && continue
  [ "$upstream" = "$want" ] && continue
  problems=$((problems + 1))
  if git -C "$REPO" rev-parse --verify -q "$want" >/dev/null; then
    echo "WRONG  $branch"
    echo "         upstream=$upstream  but $want exists -> repoint"
    [ "$FIX" -eq 1 ] && git -C "$REPO" branch --set-upstream-to="$want" "$branch" >/dev/null 2>&1 \
      && echo "         FIXED -> $want"
  else
    echo "WRONG  $branch"
    echo "         upstream=$upstream  and $want does NOT exist -> unset (never leave it on main)"
    [ "$FIX" -eq 1 ] && git -C "$REPO" branch --unset-upstream "$branch" >/dev/null 2>&1 \
      && echo "         FIXED -> no upstream (@{u} now errors instead of lying)"
  fi
done < <(git -C "$REPO" for-each-ref --format='%(refname:short)%09%(upstream:short)' refs/heads)

total="$(git -C "$REPO" for-each-ref --format='x' refs/heads | wc -l)"
if [ "$problems" -eq 0 ]; then
  echo "OK: all $total local branches track their own remote branch, or nothing at all."
  exit 0
fi
echo "$problems of $total local branches had a misdirected upstream."
[ "$FIX" -eq 1 ] && exit 0
exit 1
