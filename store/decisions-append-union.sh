#!/usr/bin/env bash
# decisions-append-union.sh -- narrow, structurally-verified auto-resolution for the ONE conflict
# shape that recurred 6 times in a single day (cards 0755e234, fed9409f, 093a9914, 9fca322b,
# 73540a68, cbb66abf): two branches landing concurrently BOTH append a new dated entry to the same
# DECISIONS.md, at the same trailing position -- a real conflict by git's own rules (both sides
# touched adjacent/the same region), but not a real DISAGREEMENT: neither side removed or altered
# anything the other wrote, they only added to the end of an append-only log.
#
# SCOPE, DELIBERATELY NARROW (backend's own note, card cbb66abf: "NEM javasolja szelesebbre venni",
# a general auto-merge would bring back the silent content loss this whole landing pipeline exists
# to prevent). This fires ONLY when:
#   - DECISIONS.md (or whatever file the caller names) is the ONLY conflicted file;
#   - BOTH sides' full content, compared against the merge-base, is a PURE ADDITION at the tail --
#     i.e. neither side's version differs from the base anywhere except by having extra lines
#     appended after it. This is verified structurally from the merge's own three index stages
#     (:1 base, :2 ours, :3 theirs), never guessed from conflict-marker shape or the filename alone.
# Every other conflict -- including a DECISIONS.md conflict that touches or removes an existing
# line (an archival rewrite, a correction to a past entry) -- falls through untouched: the caller's
# existing refuse-and-report path runs exactly as before.
#
# WHAT THIS DOES NOT REPLACE: the calling script's seam-check still runs afterward on the completed
# merge, exactly as for any clean, non-conflicting merge -- this function does not have to be
# perfect on its own, because every line either side added is independently re-verified present in
# the final file by that existing, unrelated check. This only has to get the common case right and
# refuse everything else; the seam-check is the backstop if it somehow does not.
#
# USAGE, from a caller whose `git merge --no-ff` just failed, worktree at $1, the ONE file it is
# willing to auto-resolve at $2 (parameterized rather than hardcoded so a future append-only file
# can reuse this without a copy -- today always "DECISIONS.md"):
#   try_append_union <worktree-path> <relative-file-path>
#   returns 0 = resolved: the file is fixed up and `git add`-ed in the worktree; the CALLER must
#               then `git commit --no-edit` to complete the merge instead of aborting it.
#   returns 1 = not this shape (more than one file conflicted, or the base/ours/theirs prefix check
#               or the header-count sanity check did not hold) -- caller's existing abort-and-refuse
#               path is unchanged. Never partially mutates the worktree on a 1 return.
try_append_union() {
  local wt="$1" file="$2"
  local conflicted
  conflicted="$(git -C "$wt" diff --name-only --diff-filter=U)"
  # Must be the ONLY conflicted file -- a conflict alongside anything else is a different, wider
  # situation than "two appends collided", and is left to the normal refusal.
  [ "$conflicted" = "$file" ] || return 1

  local base ours theirs
  base="$(git -C "$wt" show ":1:$file" 2>/dev/null)" || return 1
  ours="$(git -C "$wt" show ":2:$file" 2>/dev/null)" || return 1
  theirs="$(git -C "$wt" show ":3:$file" 2>/dev/null)" || return 1

  # PURE APPEND ON BOTH SIDES: each side's content must begin with EXACTLY the base content --
  # nothing removed, nothing changed, only lines added after it. A real edit (a correction to an
  # existing entry, an archival rewrite touching old text) breaks this prefix match and correctly
  # falls through to the refusal, never a guess about which edit "wins".
  case "$ours" in
  "$base"*) ;;
  *) return 1 ;;
  esac
  case "$theirs" in
  "$base"*) ;;
  *) return 1 ;;
  esac

  local ours_added theirs_added
  ours_added="${ours#"$base"}"
  theirs_added="${theirs#"$base"}"
  # Both sides must have actually ADDED something. If one side is byte-identical to base, git would
  # not have conflicted this file in the first place -- reaching here with an empty added-half means
  # some assumption above is wrong, so fall through to the refusal rather than guess.
  [ -n "$ours_added" ] && [ -n "$theirs_added" ] || return 1

  # LINE-BOUNDARY, not just a string prefix (caught by this file's own selftest before landing):
  # bash's `${var#pattern}` prefix strip is byte-based, so "## entry A" is a "prefix" of both
  # "## entry A" (unchanged) AND "## entry A (CORRECTED)" -- the latter is an EDIT of the base's own
  # last line, not a new line appended after it, and the string-prefix check alone cannot tell them
  # apart. Requiring the added half to itself START WITH A NEWLINE closes that: a genuine append
  # always begins a fresh line, an edit to the existing last line never does.
  case "$ours_added" in
  $'\n'*) ;;
  *) return 1 ;;
  esac
  case "$theirs_added" in
  $'\n'*) ;;
  *) return 1 ;;
  esac

  local union="${base}${ours_added}${theirs_added}"

  # HEADER-COUNT CHECK (backend's own verification idea, card cbb66abf) as the actual arithmetic,
  # not the shorthand "both sides' counts added together": base's own headers are counted in BOTH
  # ours and theirs, so the true identity is
  #     headers(union) == headers(ours) + headers(theirs) - headers(base)
  # A real DECISIONS.md already carries hundreds of headers on both sides by the time two branches
  # diverge, so the literal "added together" reading would refuse every real case -- this is the
  # corrected form, cheap belt-and-suspenders ahead of the caller's own seam-check.
  local h_base h_ours h_theirs h_union
  h_base="$(grep -c '^## ' <<<"$base")"
  h_ours="$(grep -c '^## ' <<<"$ours")"
  h_theirs="$(grep -c '^## ' <<<"$theirs")"
  h_union="$(grep -c '^## ' <<<"$union")"
  [ "$h_union" -eq "$((h_ours + h_theirs - h_base))" ] || return 1

  printf '%s\n' "$union" >"$wt/$file"
  git -C "$wt" add "$file" || return 1
  return 0
}

# --- selftest: REAL git repos, REAL conflicts -- no mocked merge state -----------------------
# Every case builds an actual throwaway repo, forces an actual `git merge` conflict, and asserts
# on try_append_union's actual return code + the actual resulting file content. A hand-built
# fixture of git's three index stages would only prove the parsing logic agrees with itself; a
# real conflict is what the caller (cleancore-land.sh / marveen-land.sh) actually hands this
# function, and the pure-append precondition is exactly the kind of thing that is easy to get
# subtly wrong reasoning about in the abstract (line-boundary slicing, trailing newlines).
# RUN-DIRECTLY GUARD: this file is normally SOURCED by cleancore-land.sh/marveen-land.sh, which
# inherits the CALLER's positional params -- without this check, sourcing this file from inside
# `cleancore-land.sh --selftest` would see `--selftest` here too and run (and exit on) THIS file's
# selftest instead of continuing the caller's own script.
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--selftest" ]; then
  fail=0
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  # $1 = case label; sets up $REPO with an initial DECISIONS.md ($2, the base content) committed
  # on a "main" branch, then a "left" branch and a "right" branch each getting one commit ($3/$4,
  # the FULL new file content for that side). Returns with $REPO checked out on a merge conflict
  # (left merged, right attempted) -- exactly the state a landing script's failed merge leaves.
  setup_conflict() {
    REPO="$TMP/$1"; rm -rf "$REPO"; mkdir -p "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
    printf '%s' "$2" >"$REPO/DECISIONS.md"
    git -C "$REPO" add DECISIONS.md
    git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m base
    git -C "$REPO" branch -q left
    git -C "$REPO" branch -q right
    git -C "$REPO" checkout -q left
    printf '%s' "$3" >"$REPO/DECISIONS.md"
    git -C "$REPO" add DECISIONS.md
    # `|| true`, silenced: the one-sided-noop case deliberately makes left identical to base, so
    # this commit is legitimately a no-op there ("nothing to commit") -- expected, not an error.
    git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m left >/dev/null 2>&1 || true
    git -C "$REPO" checkout -q right
    printf '%s' "$4" >"$REPO/DECISIONS.md"
    git -C "$REPO" add DECISIONS.md
    git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m right >/dev/null 2>&1 || true
    git -C "$REPO" checkout -q left
    git -C "$REPO" -c user.email=t@t -c user.name=t merge --no-ff right -m attempt >/dev/null 2>&1 || true
  }

  t_resolved() { # $1 = label, $2 = expected final content
    if try_append_union "$REPO" "DECISIONS.md"; then
      local got want
      got="$(cat "$REPO/DECISIONS.md")"
      # $(...) strips trailing newlines from BOTH sides the same way, so the comparison is not
      # thrown off by the literal trailing newline in the $2 string constant.
      want="$(printf '%s' "$2")"
      if [ "$got" = "$want" ]; then echo "  ok   $1"
      else echo "  FAIL $1 -> content mismatch"; printf 'got:\n%s\nwant:\n%s\n' "$got" "$want"; fail=1; fi
      git -C "$REPO" diff --cached --name-only --diff-filter=U | grep -q . && {
        echo "  FAIL $1 -> DECISIONS.md still shows as unmerged after try_append_union claimed success"
        fail=1
      }
    else
      echo "  FAIL $1 -> expected try_append_union to resolve (return 0), it returned 1"; fail=1
    fi
  }
  t_refused() { # $1 = label
    if try_append_union "$REPO" "DECISIONS.md"; then
      echo "  FAIL $1 -> expected try_append_union to refuse (return 1), it resolved"; fail=1
    else
      # DECISIONS.md must STILL be unmerged (a return-1 must never have staged/written it) -- other
      # files may or may not also be unmerged, that is not this helper's business to assert.
      if git -C "$REPO" diff --name-only --diff-filter=U | grep -qx "DECISIONS.md"; then
        echo "  ok   $1"
      else
        echo "  FAIL $1 -> refused but DECISIONS.md no longer shows as unmerged"; fail=1
      fi
    fi
    git -C "$REPO" merge --abort 2>/dev/null || true
  }

  echo "decisions-append-union selftest"

  # THE COMMON CASE: both sides append one new entry each, at the same position -- a real conflict,
  # but not a real disagreement. Union keeps base, then left's addition, then right's.
  setup_conflict pure-append \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A
## 2026-01-02 -- entry B (left)
" \
    "## 2026-01-01 -- entry A
## 2026-01-03 -- entry C (right)
"
  t_resolved "pure append-append: auto-unions, base then left then right" \
    "## 2026-01-01 -- entry A
## 2026-01-02 -- entry B (left)
## 2026-01-03 -- entry C (right)
"

  # MULTI-ENTRY APPEND on both sides -- the real recurring shape had each side land more than one
  # decision between fetches, not always exactly one. The concatenation must not drop, reorder, or
  # interleave lines within a side's own block.
  setup_conflict multi-entry-append \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A
## 2026-01-02 -- entry B1 (left)
## 2026-01-02 -- entry B2 (left)
" \
    "## 2026-01-01 -- entry A
## 2026-01-03 -- entry C1 (right)
## 2026-01-03 -- entry C2 (right)
## 2026-01-03 -- entry C3 (right)
"
  t_resolved "multi-entry append on both sides -- each side's whole block survives, in order" \
    "## 2026-01-01 -- entry A
## 2026-01-02 -- entry B1 (left)
## 2026-01-02 -- entry B2 (left)
## 2026-01-03 -- entry C1 (right)
## 2026-01-03 -- entry C2 (right)
## 2026-01-03 -- entry C3 (right)
"

  # A REAL EDIT ON ONE SIDE (a correction to the existing entry, not just an append at the tail):
  # must NOT auto-union -- silently keeping "both versions" here is exactly the content-mangling
  # this whole landing pipeline exists to prevent.
  setup_conflict left-edits-existing \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A (CORRECTED)
" \
    "## 2026-01-01 -- entry A
## 2026-01-03 -- entry C (right)
"
  t_refused "one side EDITS an existing entry -- refused, not auto-unioned"

  # BOTH SIDES edit the SAME line differently (the classic conflict) -- must refuse.
  setup_conflict both-edit-same-line \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A (left version)
" \
    "## 2026-01-01 -- entry A (right version)
"
  t_refused "both sides edit the SAME existing line -- refused"

  # A conflict where DECISIONS.md is NOT the only file involved must not auto-union either -- the
  # narrow scope is "the ONLY conflicted file", not "one of the conflicted files".
  REPO="$TMP/other-file-too"; rm -rf "$REPO"; mkdir -p "$REPO"
  git -C "$REPO" init -q -b main
  printf 'base\n' >"$REPO/DECISIONS.md"; printf 'base\n' >"$REPO/other.txt"
  git -C "$REPO" add -A; git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m base
  git -C "$REPO" branch -q left; git -C "$REPO" branch -q right
  git -C "$REPO" checkout -q left
  printf 'base\nleft-entry\n' >"$REPO/DECISIONS.md"; printf 'left\n' >"$REPO/other.txt"
  git -C "$REPO" add -A; git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m left
  git -C "$REPO" checkout -q right
  printf 'base\nright-entry\n' >"$REPO/DECISIONS.md"; printf 'right\n' >"$REPO/other.txt"
  git -C "$REPO" add -A; git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m right
  git -C "$REPO" checkout -q left
  git -C "$REPO" -c user.email=t@t -c user.name=t merge --no-ff right -m attempt >/dev/null 2>&1 || true
  t_refused "a conflict alongside ANOTHER file is refused, even with a pure-append DECISIONS.md"

  # A one-sided append (only ONE branch actually added anything) is not a real append-append
  # conflict in the first place -- git would not conflict this at all, exercised as a defensive
  # completeness check on the function's own precondition, not a real landing scenario.
  setup_conflict one-sided-noop \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A
## 2026-01-03 -- entry C (right)
"
  if git -C "$REPO" diff --name-only --diff-filter=U | grep -q DECISIONS.md; then
    t_refused "one side identical to base (git still conflicted it) -- refused, not guessed at"
  else
    echo "  ok   one side identical to base -- git fast-forwarded it, never reached try_append_union"
  fi

  echo "selftest: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi
