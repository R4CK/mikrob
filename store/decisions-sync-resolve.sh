#!/usr/bin/env bash
# decisions-sync-resolve.sh -- resolve the DECISIONS.md conflict of a SYNC merge (card edf9c837).
#
# WHAT THIS IS FOR, and why the landers were not enough. try_append_union already resolves the
# append-append conflict, and both landing scripts call it -- but only in ONE direction. Both put
# their worktree on the integration branch (origin/develop, origin/main) and merge the contributing
# branch in, so `ours` is the integration branch and its content is concatenated first. That is the
# order that keeps the log tail-append shaped.
#
# The other direction had no caller at all. An agent syncing (`git merge origin/develop` while on
# its own branch) has `ours` = its own branch, and the conflict is resolved BY HAND -- so the order
# is whatever the person joining the two halves happened to choose. Measured on card edf9c837: when
# the branch's own entry ends up FIRST, that entry is, relative to every later merge-base, an
# insertion in the middle of the file -- and a mid-file insertion on one side is exactly the shape
# try_append_union then refuses. Two independent CleanCore landings were blocked in one heartbeat
# by that, and the suspected cause (identical small mid-file inserts) was measured and ruled out.
#
# So this is the missing caller: same function, same structural verification, `theirs-first`.
#
# USAGE, from a working tree whose sync merge just conflicted:
#   store/decisions-sync-resolve.sh [<worktree>]      default: the current directory
#   exit 0  resolved and `git add`-ed -- YOU still have to `git commit` to complete the merge
#   exit 1  not this shape; the conflict is untouched, resolve it by hand
#   exit 2  used wrongly (no merge in progress, or the merge is not a sync merge)
#
# WHAT IT REFUSES, and this is the part that makes it safe to hand to an agent: it checks that
# MERGE_HEAD really IS the integration branch. Run after the OPPOSITE merge (a branch merged into
# main), `theirs-first` would be exactly the wrong order and would create the shape this whole card
# is about. A tool whose correctness depends on the operator remembering which direction they merged
# is not a fix, so the direction is verified rather than assumed.
#
# IT COMMITS NOTHING. Same contract as the landers: this function resolves and stages, the caller
# completes the merge. An agent looking at a resolved DECISIONS.md should still be the one who
# decides the merge is finished.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./decisions-append-union.sh
. "$HERE/decisions-append-union.sh"

INTEGRATION_REFS="${DECISIONS_SYNC_INTEGRATION_REFS:-origin/develop origin/main}"

die() { echo "decisions-sync-resolve: $2" >&2; exit "$1"; }

if [ "${1:-}" = "--selftest" ]; then
  fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  ok() { echo "  ok   $1"; }
  no() { echo "  FAIL $1"; fail=1; }

  # A real repo, a real sync merge, a real conflict -- the same discipline as the union's own
  # selftest. No mocked merge state: the thing under test reads MERGE_HEAD and the index stages.
  R="$tmp/repo"
  mk_repo() {
    rm -rf "$R"; mkdir -p "$R"
    git -C "$R" init -q
    git -C "$R" config user.email t@t; git -C "$R" config user.name t
    printf '## 2026-01-01 -- entry A\n' >"$R/DECISIONS.md"
    git -C "$R" add DECISIONS.md; git -C "$R" commit -qm base
    git -C "$R" branch -q integration
    # the branch's own entry
    printf '## 2026-01-01 -- entry A\n## 2026-01-02 -- entry B (branch)\n' >"$R/DECISIONS.md"
    git -C "$R" add DECISIONS.md; git -C "$R" commit -qm branch
    # the integration branch's newer entry
    git -C "$R" checkout -q integration
    printf '## 2026-01-01 -- entry A\n## 2026-01-03 -- entry C (integration)\n' >"$R/DECISIONS.md"
    git -C "$R" add DECISIONS.md; git -C "$R" commit -qm integration
    git -C "$R" checkout -q master 2>/dev/null || git -C "$R" checkout -q main
  }

  mk_repo
  git -C "$R" merge --no-ff integration -m sync >/dev/null 2>&1 || true
  out="$(DECISIONS_SYNC_INTEGRATION_REFS=integration bash "$0" "$R" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then ok "a sync merge resolves"; else no "a sync merge resolves (rc=$rc: $out)"; fi
  want="$(printf '## 2026-01-01 -- entry A\n## 2026-01-03 -- entry C (integration)\n## 2026-01-02 -- entry B (branch)')"
  got="$(cat "$R/DECISIONS.md")"
  # THE POINT OF THE WHOLE SCRIPT: the INTEGRATION entry ends up first and the branch's own entry
  # lands at the tail. With the plain default order these two lines are swapped, which is the state
  # that blocks the next branch -- so this comparison is the card's actual acceptance criterion.
  if [ "$got" = "$want" ]; then ok "the integration entry comes first, the branch's own entry last"
  else no "order wrong; got:\n$got"; fi
  if git -C "$R" diff --name-only --diff-filter=U | grep -q .; then no "left the file unmerged"; else ok "the file is staged as resolved"; fi
  # It stages, it does not commit: MERGE_HEAD must still be there for the caller to finish.
  if [ -f "$R/.git/MERGE_HEAD" ]; then ok "the merge is left OPEN for the caller to commit"; else no "it committed the merge itself"; fi

  # The direction check, which is what makes theirs-first safe to apply blind.
  mk_repo
  git -C "$R" checkout -q integration
  git -C "$R" merge --no-ff master -m "wrong direction" >/dev/null 2>&1 \
    || git -C "$R" merge --no-ff main -m "wrong direction" >/dev/null 2>&1 || true
  out="$(DECISIONS_SYNC_INTEGRATION_REFS=integration bash "$0" "$R" 2>&1)"; rc=$?
  if [ "$rc" -eq 2 ]; then ok "the OPPOSITE merge direction is refused, not silently reordered"
  else no "wrong-direction merge should exit 2, got rc=$rc: $out"; fi
  if grep -q '^<<<<<<< ' "$R/DECISIONS.md"; then ok "the refused case keeps the conflict intact"; else no "the refusal touched the file"; fi

  # No merge at all.
  mk_repo
  out="$(bash "$0" "$R" 2>&1)"; rc=$?
  if [ "$rc" -eq 2 ]; then ok "no merge in progress is a usage error, not a resolution"
  else no "no-merge should exit 2, got rc=$rc"; fi

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

WT="${1:-$PWD}"
[ -d "$WT/.git" ] || [ -f "$WT/.git" ] || die 2 "$WT is not a git working tree"

MERGE_HEAD="$(git -C "$WT" rev-parse --verify --quiet MERGE_HEAD || true)"
[ -n "$MERGE_HEAD" ] || die 2 "no merge in progress in $WT -- run this only after a conflicted merge"

# THE DIRECTION CHECK. MERGE_HEAD must be the tip of an integration branch, i.e. this really is
# "integration merged INTO my branch". Anything else and `theirs-first` would be the wrong order.
matched=""
for ref in $INTEGRATION_REFS; do
  tip="$(git -C "$WT" rev-parse --verify --quiet "$ref" || true)"
  [ -n "$tip" ] || continue
  [ "$tip" = "$MERGE_HEAD" ] || continue
  matched="$ref"; break
done
[ -n "$matched" ] || die 2 "MERGE_HEAD is not the tip of an integration branch ($INTEGRATION_REFS) -- this is not a sync merge, so the sync order would be wrong here"

conflicted="$(git -C "$WT" diff --name-only --diff-filter=U)"
[ "$conflicted" = "DECISIONS.md" ] \
  || die 1 "the conflict is not DECISIONS.md alone (got: ${conflicted:-none}) -- resolve it by hand"

if try_append_union "$WT" "DECISIONS.md" "" "theirs-first"; then
  echo "decisions-sync-resolve: DECISIONS.md unioned with $matched first, your entry at the tail -- staged, NOT committed"
  exit 0
fi

die 1 "DECISIONS.md is not a clean append-append in this merge -- resolve it by hand (the conflict is untouched)"
