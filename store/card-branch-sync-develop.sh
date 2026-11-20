#!/usr/bin/env bash
# card-branch-sync-develop.sh -- the ONE command for "pull the integration branch into my own
# card/agent branch" (card 84f90b4e, re-scoped by MikroB from a rejected .gitattributes
# merge=union approach -- see card comment 34985/22392).
#
# WHY THIS EXISTS. store/decisions-sync-resolve.sh already resolves the exact DECISIONS.md
# append-append conflict shape measured live on 2026-11-20 (a2028f35, FOUR separate manual
# resolutions; c4590365; 6d8ef952; 30aa8b29) -- its own --selftest proves it, and it already
# passed before this card touched anything. The gap was never correctness: it was that NOTHING
# CALLED IT. An agent syncing a card branch with develop runs a plain `git merge origin/develop`
# by hand (docs/rules/marveen-worktree-fegyelme.md never mentions the resolver), hits the
# conflict, and resolves it by hand -- exactly the four "manual DECISIONS.md merge-conflict
# resolution" REVIEWs logged on a2028f35 today. This script IS the merge command an agent runs
# instead of the raw `git merge`, so the resolver fires by construction, not by someone
# remembering it exists.
#
# USAGE: store/card-branch-sync-develop.sh [<worktree>] [<integration-ref>]
#   <worktree>:        default: the current directory.
#   <integration-ref>: default: origin/develop. Must already be fetched by the caller -- this
#                       script does not fetch, same as decisions-sync-resolve.sh does not.
#
# exit 0  already up to date, OR merged with no conflict, OR the ONLY conflict was a pure-append
#         DECISIONS.md collision that decisions-sync-resolve.sh resolved -- committed, and the
#         append-only backstop (decisions-append-only-guard.sh) re-verified the result.
# exit 1  a real conflict remains (not DECISIONS.md alone, or not a pure append) -- the merge is
#         left OPEN exactly as a plain `git merge` would leave it; resolve by hand.
# exit 2  used wrongly, OR the resolved merge somehow still violated the append-only invariant --
#         the merge is undone (`git reset --hard` back to the pre-merge commit) rather than left
#         half-applied, so a false-positive resolve can never land silently.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./decisions-append-only-guard.sh
. "$HERE/decisions-append-only-guard.sh"

die() { echo "card-branch-sync-develop: $2" >&2; exit "$1"; }

run_selftest() {
  fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  ok() { echo "  ok   $1"; }
  no() { echo "  FAIL $1"; fail=1; }

  R="$tmp/repo"
  mk_repo() {
    rm -rf "$R"; mkdir -p "$R"
    git -C "$R" init -q -b develop
    git -C "$R" config user.email t@t; git -C "$R" config user.name t
    git -C "$R" config commit.gpgsign false
    printf '## 2026-01-01 -- entry A\n' >"$R/DECISIONS.md"
    git -C "$R" add DECISIONS.md; git -C "$R" commit -qm base
    git -C "$R" checkout -qb card-branch
  }

  # Case 1: today's a2028f35 shape -- develop gained a new tail entry, the card branch has its
  # own, no other file conflicting. Must resolve AND commit, with no manual step.
  mk_repo
  printf '## 2026-01-01 -- entry A\n## 2026-01-02 -- entry B (card)\n' >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md; git -C "$R" commit -qm "card entry"
  git -C "$R" checkout -q develop
  printf '## 2026-01-01 -- entry A\n## 2026-01-03 -- entry C (develop)\n' >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md; git -C "$R" commit -qm "develop entry"
  git -C "$R" checkout -q card-branch
  before="$(git -C "$R" rev-parse HEAD)"
  out="$(bash "$0" "$R" develop 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then ok "a2028f35-shape conflict resolves with rc=0"; else no "a2028f35-shape should resolve, rc=$rc: $out"; fi
  if git -C "$R" diff --name-only --diff-filter=U | grep -q .; then no "left DECISIONS.md unmerged"; else ok "no unmerged path remains"; fi
  if [ "$(git -C "$R" rev-parse HEAD)" = "$before" ]; then no "did not create a merge commit"; else ok "committed the resolved merge"; fi
  want="$(printf '## 2026-01-01 -- entry A\n## 2026-01-03 -- entry C (develop)\n## 2026-01-02 -- entry B (card)')"
  got="$(git -C "$R" show HEAD:DECISIONS.md)"
  if [ "$got" = "$want" ]; then ok "develop's entry first, the card's own entry last"; else no "order wrong; got:\n$got"; fi

  # Case 2: a real, non-append edit on develop's side -- must stay refused (left for manual).
  mk_repo
  printf '## 2026-01-01 -- entry A\n## 2026-01-02 -- entry B (card)\n' >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md; git -C "$R" commit -qm "card entry"
  git -C "$R" checkout -q develop
  printf '## 2026-01-01 -- entry A, corrected\n' >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md; git -C "$R" commit -qm "rewrite old entry"
  git -C "$R" checkout -q card-branch
  out="$(bash "$0" "$R" develop 2>&1)"; rc=$?
  if [ "$rc" -eq 1 ]; then ok "a real edit to an existing entry is refused (rc=1)"; else no "should refuse rc=1, got rc=$rc: $out"; fi
  if git -C "$R" rev-parse --verify --quiet MERGE_HEAD >/dev/null; then ok "the conflicted merge is left open for manual resolution"; else no "MERGE_HEAD missing -- the open-conflict contract broke"; fi
  git -C "$R" merge --abort 2>/dev/null || true

  # Case 3: a conflict on a file OTHER than DECISIONS.md -- must stay refused, untouched.
  mk_repo
  printf 'card content\n' >"$R/other.txt"
  git -C "$R" add other.txt; git -C "$R" commit -qm "card other.txt"
  git -C "$R" checkout -q develop
  printf 'develop content\n' >"$R/other.txt"
  git -C "$R" add other.txt; git -C "$R" commit -qm "develop other.txt"
  git -C "$R" checkout -q card-branch
  out="$(bash "$0" "$R" develop 2>&1)"; rc=$?
  if [ "$rc" -eq 1 ]; then ok "a non-DECISIONS conflict is refused (rc=1)"; else no "should refuse rc=1, got rc=$rc: $out"; fi
  git -C "$R" merge --abort 2>/dev/null || true

  # Case 4: already up to date -- no-op, rc=0, no new commit.
  mk_repo
  before="$(git -C "$R" rev-parse HEAD)"
  out="$(bash "$0" "$R" develop 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$(git -C "$R" rev-parse HEAD)" = "$before" ]; then
    ok "already up to date is a clean no-op"
  else
    no "already-up-to-date case changed something or failed: rc=$rc out=$out"
  fi

  echo "$([ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL")"
  exit "$fail"
}

if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  die 2 "this file is a standalone script, not a sourced helper"
fi

if [ "${1:-}" = "--selftest" ]; then
  run_selftest
fi

WT="${1:-$PWD}"
REF="${2:-origin/develop}"
[ -d "$WT/.git" ] || [ -f "$WT/.git" ] || die 2 "$WT is not a git working tree"
git -C "$WT" rev-parse --verify --quiet "$REF" >/dev/null || die 2 "$REF does not resolve in $WT (fetch it first)"

before_sha="$(git -C "$WT" rev-parse HEAD)"

if ! git -C "$WT" merge --no-ff "$REF" -m "sync: merge $REF" >/tmp/card-branch-sync-develop.$$ 2>&1; then
  conflicted="$(git -C "$WT" diff --name-only --diff-filter=U)"
  if [ "$conflicted" = "DECISIONS.md" ] \
    && DECISIONS_SYNC_INTEGRATION_REFS="$REF" bash "$HERE/decisions-sync-resolve.sh" "$WT" >/dev/null 2>&1; then
    git -C "$WT" commit --no-edit -q
  else
    cat /tmp/card-branch-sync-develop.$$ >&2
    rm -f /tmp/card-branch-sync-develop.$$
    die 1 "merge conflict not auto-resolved (conflicted: ${conflicted:-none}) -- resolve by hand, merge left open"
  fi
fi
rm -f /tmp/card-branch-sync-develop.$$

merge_sha="$(git -C "$WT" rev-parse HEAD)"
if [ "$merge_sha" != "$before_sha" ]; then
  if ! decisions_append_only_check_merge "$WT" "$merge_sha" "DECISIONS.md"; then
    git -C "$WT" reset --hard "$before_sha"
    die 2 "append-only backstop caught a violation on the merge result -- undone, back at $before_sha"
  fi
fi

echo "card-branch-sync-develop: synced to $REF ($before_sha -> $merge_sha)"
exit 0
