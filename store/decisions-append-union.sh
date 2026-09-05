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
# The LENGTH of the longest common prefix of two strings, truncated to the last complete line.
#
# RETURNS A LENGTH, NOT THE STRING, and that is not a style choice. `$(...)` strips trailing
# newlines from what it captures, so a helper that echoed the prefix itself would lose the very
# newline that makes it end on a line boundary -- the caller's offset would then be one byte short
# and every remainder would begin with a stray "\n". A number survives command substitution intact,
# and it also avoids copying a 447 KB string through a subshell.
#
# `cmp` finds the first differing BYTE in one C-speed pass -- bash cannot compare 447 KB strings
# byte by byte without the O(n^2) behaviour card d56786a7 measured.
_common_line_prefix_len() {
  # BYTE SEMANTICS, FORCED. `cmp` reports a BYTE offset; bash's ${#var} and ${var:i:n} count
  # CHARACTERS unless the locale is C. On the real DECISIONS.md -- Hungarian prose, UTF-8 -- those
  # differ by ~36000: the file is 609416 bytes and 573384 characters, and cmp's "differ: byte 601266"
  # was being used as a character index. The result was a "common prefix" LONGER than one of the two
  # sides, which is impossible by definition.
  #
  # It passed every selftest because every fixture was ASCII, where the two counts coincide. That is
  # the whole reason this shipped: the tests could not see the difference they were built out of.
  local LC_ALL=C
  local a="$1" b="$2" n cut head
  n="$(cmp <(printf '%s' "$a") <(printf '%s' "$b") 2>/dev/null | sed -n 's/.*byte \([0-9][0-9]*\).*/\1/p')"
  if [ -z "$n" ]; then
    # cmp is silent on identical input and prints "EOF on <file>" when one side is a prefix of the
    # other. Identical means git would not have conflicted this file at all: refuse rather than
    # answer for a state that should not exist. Otherwise the shorter string is the whole prefix.
    [ "${#a}" -eq "${#b}" ] && return 1
    if [ "${#a}" -lt "${#b}" ]; then n=$(( ${#a} + 1 )); else n=$(( ${#b} + 1 )); fi
  fi
  cut=$(( n - 1 ))                       # cmp reports 1-based; the bytes BEFORE it are common
  head="${a:0:$cut}"
  # Back up to the last complete line. `%$'\n'*` removes everything after the final newline; if
  # there is no newline at all there is no usable line boundary, and the answer is 0.
  case "$head" in
  *$'\n'*) head="${head%$'\n'*}"; printf '%s' "$(( ${#head} + 1 ))" ;;
  *) printf '0' ;;
  esac
}

try_append_union() {
  # Same reason as _common_line_prefix_len: this function SLICES with the offset that function
  # returns, so it has to index the same way cmp counted. Set here as well as there, because the
  # slicing happens in this scope.
  local LC_ALL=C
  local wt="$1" file="$2"
  # ENTRY-BOUNDARY PATTERN: an OPTIONAL THIRD ARGUMENT, deliberately NOT an environment variable
  # (Cybersec, msg 23484). It was read from the environment for one commit, and that was a real
  # regression dressed as a feature: any parent process of a landing script could have set it to
  # `*`, every remainder would have matched, and the silent gluing this function exists to prevent
  # would have come back -- to a WORSE place than before the fix, because the code now implies the
  # boundary is controlled. An argument is settable only by code in this repo, which is reviewed
  # and landed; the ambient-environment surface is gone entirely. Cybered's objection that the
  # DECISIONS.md convention must not be hardcoded into a file-parameterised function is still
  # answered -- a future append-only file's caller passes its own pattern here.
  local header_glob="${3:-## [0-9][0-9][0-9][0-9]-*}"
  local conflicted
  conflicted="$(git -C "$wt" diff --name-only --diff-filter=U)"
  # Must be the ONLY conflicted file -- a conflict alongside anything else is a different, wider
  # situation than "two appends collided", and is left to the normal refusal.
  [ "$conflicted" = "$file" ] || return 1

  local base ours theirs
  base="$(git -C "$wt" show ":1:$file" 2>/dev/null)" || return 1
  ours="$(git -C "$wt" show ":2:$file" 2>/dev/null)" || return 1
  theirs="$(git -C "$wt" show ":3:$file" 2>/dev/null)" || return 1

  # THE SHARED PART IS THE COMMON PREFIX OF THE TWO SIDES, NOT THE MERGE-BASE (card b7e57877).
  #
  # This used to require the base to be a literal byte prefix of BOTH sides. Measured on the real
  # repo, that refused landings for a reason with no meaning: both sides had inserted THE SAME
  # SINGLE BLANK LINE mid-file (line 6520 of 6743) and then appended their own entry at the tail.
  # Neither side deleted anything -- `git diff --numstat` was "30 0" and "924 0" -- so there was no
  # disagreement to protect against, only a byte difference identical on both sides. 5 of the 13
  # open branches that touch this file were blocked that way; 4 of them on BOTH sides at once.
  #
  # What both sides contain IDENTICALLY cannot be a disagreement, so the union is taken against
  # their common prefix. The safety property is preserved by the check below, not weakened: nothing
  # the merge-base held may be missing from that prefix.
  local prefix_len prefix ours_added theirs_added
  prefix_len="$(_common_line_prefix_len "$ours" "$theirs")" || return 1
  [ -n "$prefix_len" ] && [ "$prefix_len" -gt 0 ] 2>/dev/null || return 1
  prefix="${ours:0:$prefix_len}"

  # THE GUARANTEE, and the reason this stays safe when the prefix is no longer the base. If the two
  # sides diverge EARLY -- a real edit at line 10 of a 6743-line file -- the common prefix is those
  # 10 lines, and concatenating the two remainders would DUPLICATE almost the whole file. That is
  # caught here: every line the merge-base had must still be present, in order, in the common
  # prefix. `diff` prints a `<` line for anything present in base and absent from the prefix, so a
  # single such line refuses the union. This is what the old byte-prefix test bought, restated in a
  # form that ignores changes both sides made identically.
  #
  # TRAILING NEWLINES ARE NORMALISED ON BOTH SIDES FIRST, and this is not cosmetic: `$(git show ...)`
  # strips trailing newlines from what it captures, so `base` arrives WITHOUT its final newline while
  # `prefix` -- sliced out of `ours` at a line boundary -- still ends with one. Diffing them raw makes
  # `diff` report "\ No newline at end of file" and emit a `<` line for the last line of base, so the
  # check refused every genuine append. Caught by this file's own selftest, which went red on the two
  # cases that were passing before the rewrite.
  if diff <(printf '%s\n' "${base%%$'\n'}") <(printf '%s\n' "${prefix%%$'\n'}") | grep -q '^<'; then
    return 1
  fi

  # OFFSET, not pattern-strip. `${ours#"$prefix"}` is O(n^2) in bash and froze every landing that
  # touched this file: measured on the real 447 KB DECISIONS.md it took 405 SECONDS at 97% CPU
  # (32 KB 1.9s, 64 KB 8.0s, 128 KB 32.2s, 256 KB 138s -- ~4x per doubling), and fullstack lost
  # ~25 minutes of a landing to it before the cause was found (card d56786a7).
  #
  # _common_line_prefix has ALREADY proved this is a literal prefix of both sides, so there is
  # nothing left to match: skipping ${#prefix} characters is the same answer by construction.
  ours_added="${ours:${#prefix}}"
  theirs_added="${theirs:${#prefix}}"
  # Both sides must have actually ADDED something. If one side is byte-identical to the shared
  # prefix, git would not have conflicted this file in the first place -- reaching here with an
  # empty added-half means some assumption above is wrong, so refuse rather than guess.
  [ -n "$ours_added" ] && [ -n "$theirs_added" ] || return 1

  # EACH REMAINDER MUST BEGIN A NEW ENTRY (Cybersec NO-GO, comment 20499).
  #
  # THE HOLE: the common prefix can legitimately END WITH A SHARED `## ` HEADER LINE -- both sides
  # wrote the same header and then DIFFERENT bodies under it. Concatenating the remainders then
  # produces ONE header with two bodies glued together: not a duplicate entry, a silently merged
  # one. The old base-anchored boundary could not reach that state, so this is a regression my own
  # widening introduced -- and `uniq -d` on the headers would not see it either, because there is
  # only one header.
  #
  # WHY NOT THE LITERAL RULE the NO-GO proposed ("each remainder must start with `## `"): MEASURED
  # on the real file, 18 of its 199 entries are preceded by a `---` separator line and 181 by
  # ordinary text. An append that carries its own separator therefore begins with `---`, not `## `
  # -- including the one this card's own DECISIONS entry made an hour ago. The literal rule would
  # refuse those as edits. So this encodes the INTENT rather than its first spelling: the remainder
  # must reach an entry header with nothing but separator or blank lines before it. Body prose ahead
  # of the first header is exactly the "both sides continued the same entry" shape.
  #
  # ...AND WHY THE HEADER MUST BE DATED, not merely `## ` (Cybered CS-2, msg 23477, fixture
  # reproduced as a selftest case below). A bare `## ` boundary has the SAME hole one level down:
  # if the two sides diverge on a body line that itself begins with `## ` -- a quoted heading inside
  # an entry -- then BOTH remainders start with `## `, the check passes, and the union again glues
  # two bodies under one shared header. Requiring the header to carry a date closes it, because an
  # entry header in this log always does and a quoted heading in prose essentially never does.
  #
  # MEASURED before choosing this over "document the assumption and move on": marveen's DECISIONS.md
  # has 199 `^## ` lines and 199 of them are dated; CleanCore's has 154 of 154. Zero body `## ` lines
  # exist in either file today, so CS-2 is latent rather than live -- but the cost of closing it is
  # only ever a REFUSAL (the caller's normal manual-resolution path), never a bad merge, so the
  # fail-closed direction is the cheap one. A non-dated header append is refused from here on; that
  # cost is pinned by its own selftest case rather than left as prose.
  #
  # THE PERMISSIVE DIRECTION OF THE PATTERN IS PINNED, not just its working direction (Cybersec,
  # msg 23484). The three cases added with the pattern proved it is READ; none proved it cannot be
  # set to something that accepts everything. A guard predicate whose permissive direction is
  # untested is the failure class Cybersec measured three times in one day on separate cards.
  #
  # A boundary pattern that matches a line which can legally appear INSIDE an entry is not a
  # boundary at all -- that is the whole CS-2 lesson, stated as a runtime precondition rather than
  # left to the caller's good taste. The probes are lines that must never be entry boundaries: a
  # blank line, a bare `## ` heading and a `## ` heading with prose after it (exactly the CS-2
  # shape), ordinary prose, and the separator forms. `*` fails on all of them; `## *` fails on the
  # two heading probes -- which is correct and not an oversight, since a bare `## ` boundary is the
  # unsafe spelling this card removed. The default passes all probes: it requires four digits.
  #
  # FAIL-CLOSED, and specifically NOT a silent fall back to the default: a caller that passes an
  # unusable pattern gets the union REFUSED (return 1, the caller's ordinary manual-resolution
  # path), because quietly substituting a different pattern would resolve the merge under a rule
  # the caller did not ask for -- the same class of silent substitution this whole function refuses.
  local probe
  for probe in '' '## ' '## quoted heading in a body' 'ordinary body prose' '---' '***' '___'; do
    case "$probe" in
    $header_glob) return 1 ;;
    esac
  done

  _starts_new_entry() {
    local rest="$1" line
    while IFS= read -r line; do
      case "$line" in
      $header_glob) return 0 ;;
      ''|'---'|'***'|'___') continue ;;
      *) return 1 ;;
      esac
    done <<<"$rest"
    return 1                      # no header at all -- not a new entry
  }
  _starts_new_entry "$ours_added" || return 1
  _starts_new_entry "$theirs_added" || return 1

  # LINE BOUNDARY. _common_line_prefix already truncates to the last newline, so each remainder
  # begins at the start of a line and the concatenation below cannot splice two half-lines into one
  # -- the failure the old code prevented by requiring the remainder to START with a newline. That
  # older form cannot be used here: the prefix now ENDS with the newline instead of the remainder
  # beginning with it. Asserted rather than assumed, because it is the whole basis of the splice.
  case "$prefix" in
  ''|*$'\n') ;;
  *) return 1 ;;
  esac

  # THE JOIN NEEDS AN EXPLICIT NEWLINE, and leaving it out spliced two entries into one line.
  # `$(git show ...)` strips trailing newlines from what it captures, so `ours_added` ends WITHOUT
  # one; concatenating `theirs_added` straight onto it produced "## entry B## entry C" -- a single
  # malformed line carrying both sides' first entry, which would then have been committed.
  #
  # The old code never had to think about this: it kept the newline at the START of each added half
  # (base had none, each tail began with one), which is newline-loss-proof by construction. Moving
  # the boundary into the prefix is what made the join explicit, so it is made explicit HERE rather
  # than relying on either side to carry it. Found by this file's own selftest.
  local joined="$ours_added"
  case "$joined" in
  *$'\n') ;;
  *) joined="${joined}"$'\n' ;;
  esac
  local union="${prefix}${joined}${theirs_added}"

  # HEADER-COUNT CHECK (backend's own verification idea, card cbb66abf) as the actual arithmetic,
  # not the shorthand "both sides' counts added together": base's own headers are counted in BOTH
  # ours and theirs, so the true identity is
  #     headers(union) == headers(ours) + headers(theirs) - headers(base)
  # A real DECISIONS.md already carries hundreds of headers on both sides by the time two branches
  # diverge, so the literal "added together" reading would refuse every real case -- this is the
  # corrected form, cheap belt-and-suspenders ahead of the caller's own seam-check.
  local h_prefix h_ours h_theirs h_union
  h_prefix="$(grep -c '^## ' <<<"$prefix")"
  h_ours="$(grep -c '^## ' <<<"$ours")"
  h_theirs="$(grep -c '^## ' <<<"$theirs")"
  h_union="$(grep -c '^## ' <<<"$union")"
  # Counted against the SHARED PREFIX, not the base: the prefix is what appears once in the union,
  # so it is what must be subtracted. Using the base here would be wrong whenever the two sides made
  # an identical change beyond it -- the exact case this card widened the function to accept.
  [ "$h_union" -eq "$((h_ours + h_theirs - h_prefix))" ] || return 1

  # ...AND THE COUNT ALONE IS NOT ENOUGH (backend's measurement, msg 23346, on an independent
  # implementation of the same idea). A cut that lands MID-LINE glues one side's first entry onto the
  # other's last line and swallows its `## ` header: backend measured 165 headers where 166 were due,
  # and 165 "looks plausible" -- the arithmetic identity can be satisfied while a specific entry is
  # gone. Membership is the property that actually matters, so it is checked directly: every header
  # LINE present on either side must be present in the union.
  #
  # This is defence in depth rather than the primary guarantee. _common_line_prefix_len truncates to
  # the last newline, so the splice cannot land mid-line here in the first place (verified against
  # backend's exact scenario: raw divergence inside a "## 2026-09-05 -- " line still yields a prefix
  # ending at that line's start). But this function writes a file that a human will trust without
  # re-reading, and the cheap check for the exact failure a peer measured is worth its eight lines.
  local missing
  missing="$(comm -23 \
    <({ grep '^## ' <<<"$ours"; grep '^## ' <<<"$theirs"; } | sort -u) \
    <(grep '^## ' <<<"$union" | sort -u))"
  [ -z "$missing" ] || return 1

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
    # CYBERSEC'S POINT 3 (msg 23484): the refusal must be the CALLER'S MANUAL PATH, not a quiet
    # skip that left the tree in some half-state. A return-1 is only worth anything if the merge is
    # still there to resolve by hand, so the conflict markers git wrote must still be on disk --
    # asserted rather than assumed, because "returned 1" and "left the conflict intact" are two
    # different claims and only the first one is in the return value.
    if ! grep -q '^<<<<<<< ' "$REPO/DECISIONS.md" 2>/dev/null; then
      echo "  FAIL $1 -> refused but the conflict markers are gone from the working file"; fail=1
    fi
    git -C "$REPO" merge --abort 2>/dev/null || true
  }

  # The same two helpers, with an explicit entry-boundary pattern passed as the third argument.
  # Separate helpers rather than an optional parameter on the originals: every existing case must
  # keep calling try_append_union with exactly two arguments, so that the DEFAULT pattern stays
  # the thing they cover.
  t_resolved_glob() { # $1 = label, $2 = boundary glob, $3 = expected final content
    if try_append_union "$REPO" "DECISIONS.md" "$2"; then
      local got want
      got="$(cat "$REPO/DECISIONS.md")"
      want="$(printf '%s' "$3")"
      if [ "$got" = "$want" ]; then echo "  ok   $1"
      else echo "  FAIL $1 -> content mismatch"; printf 'got:\n%s\nwant:\n%s\n' "$got" "$want"; fail=1; fi
    else
      echo "  FAIL $1 -> expected try_append_union to resolve (return 0), it returned 1"; fail=1
    fi
    git -C "$REPO" merge --abort 2>/dev/null || true
  }
  t_refused_glob() { # $1 = label, $2 = boundary glob
    if try_append_union "$REPO" "DECISIONS.md" "$2"; then
      echo "  FAIL $1 -> expected try_append_union to refuse (return 1), it resolved"; fail=1
    elif ! git -C "$REPO" diff --name-only --diff-filter=U | grep -qx "DECISIONS.md"; then
      echo "  FAIL $1 -> refused but DECISIONS.md no longer shows as unmerged"; fail=1
    elif ! grep -q '^<<<<<<< ' "$REPO/DECISIONS.md" 2>/dev/null; then
      echo "  FAIL $1 -> refused but the conflict markers are gone from the working file"; fail=1
    else
      echo "  ok   $1"
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

  # THE CASE THIS FUNCTION WAS WIDENED FOR (card b7e57877), measured on the real repo before it was
  # written: both sides insert the SAME single blank line mid-file and then append their own entry.
  # `git diff --numstat` was "30 0" and "924 0" -- neither side deleted anything -- yet the old
  # byte-prefix-against-base test refused, because the base was no longer a literal prefix of either
  # side. 5 of the 13 open branches touching this file were blocked that way, 4 on BOTH sides.
  #
  # ITS HEADERS ARE DATED and that is load-bearing, not decoration: the entry-boundary check above
  # requires a dated header, so an undated `## entry L` remainder is refused. The fixture is about
  # the MID-FILE INSERTION, so it carries the real file's header convention; the undated case has
  # its own fixture below asserting the refusal.
  setup_conflict identical-midfile-insert \
    "## 2026-01-01 -- entry A
body of A
## 2026-01-02 -- entry B
" \
    "## 2026-01-01 -- entry A
body of A

## 2026-01-02 -- entry B
## 2026-01-04 -- entry L (left)
" \
    "## 2026-01-01 -- entry A
body of A

## 2026-01-02 -- entry B
## 2026-01-05 -- entry R (right)
"
  t_resolved "an IDENTICAL mid-file insertion on both sides no longer blocks the union" \
    "## 2026-01-01 -- entry A
body of A

## 2026-01-02 -- entry B
## 2026-01-04 -- entry L (left)
## 2026-01-05 -- entry R (right)
"

  # ...AND THE SAFETY PROPERTY THAT MAKES THE WIDENING SAFE. If the two sides diverge EARLY with
  # DIFFERENT content, their common prefix is short, and concatenating the two remainders would
  # duplicate most of the file. The no-deletion check catches exactly that: lines the merge-base had
  # are missing from the common prefix, so the union is refused. Without this case the widening
  # would be untested where it matters -- the previous version could not reach this shape at all.
  setup_conflict divergent-midfile-insert \
    "## entry A
body of A
## entry B
" \
    "## entry A
LEFT-ONLY LINE
body of A
## entry B
## entry L (left)
" \
    "## entry A
RIGHT-ONLY LINE
body of A
## entry B
## entry R (right)
"
  t_refused "DIFFERENT mid-file insertions are refused -- the union never duplicates the tail"

  # CYBERSEC'S CASE: both sides wrote the SAME header and then DIFFERENT bodies under it. The common
  # prefix then ends AFTER that shared header, and concatenating the remainders would produce ONE
  # header carrying both bodies -- a silently merged entry, which a duplicate-header check cannot
  # see because there is only one header. Must refuse.
  setup_conflict shared-header-split-body \
    "## entry A
body of A
"\
    "## entry A
body of A
## 2026-01-02 -- ugyanaz a fejlec
bal oldali torzs
" \
    "## entry A
body of A
## 2026-01-02 -- ugyanaz a fejlec
jobb oldali torzs
"
  t_refused "a SHARED header with different bodies under it is refused, not glued into one entry"

  # CYBERED'S CS-2: THE SAME HOLE ONE LEVEL DOWN (msg 23477, their fixture reproduced verbatim).
  # Both sides share the header AND an intro line, and then diverge on a body line that itself
  # begins with `## ` -- a quoted heading inside the entry. Under a bare `## ` boundary BOTH
  # remainders start with `## `, so the shared-header check above passes and the union produces one
  # header carrying two continuations. The dated-header boundary is what refuses it: `## quoted
  # heading OURS` is not a dated entry header. Verified failing before the change and passing after.
  setup_conflict cs2-quoted-heading-in-body \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- Same Decision
intro line
## quoted heading OURS
tail A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- Same Decision
intro line
## quoted heading THEIRS
tail B
"
  t_refused "a body line starting with ## does not count as an entry boundary (Cybered CS-2)"

  # THE PRICE OF THAT RULE, PINNED RATHER THAN DESCRIBED. Requiring a DATE means a genuine
  # append whose header is undated is now refused and falls to the caller's manual path. Measured
  # before accepting it: 199 of 199 headers in marveen's DECISIONS.md are dated and 154 of 154 in
  # CleanCore's, so this costs nothing today -- but it is a real behaviour change, and a behaviour
  # change nobody tests is one the next reader will "fix" back.
  setup_conflict undated-header-append \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A
## entry L (left, undated)
" \
    "## 2026-01-01 -- entry A
## entry R (right, undated)
"
  t_refused "an UNDATED header append is refused -- the documented cost of the CS-2 boundary"

  # ...AND THE OVERRIDE IS REAL, not a comment. The boundary pattern is a third argument so a
  # future append-only file with another convention can reuse this function instead of copying it;
  # if that is only asserted in prose it will rot. A DIFFERENT-BUT-SAFE convention is used here
  # (`### ` h3 headers, still dated) rather than a permissive one, because the permissive direction
  # has its own cases below and mixing the two would let one hide the other.
  setup_conflict h3-header-override \
    "### 2026-01-01 -- entry A
" \
    "### 2026-01-01 -- entry A
### 2026-01-02 -- entry L (left)
" \
    "### 2026-01-01 -- entry A
### 2026-01-03 -- entry R (right)
"
  t_resolved_glob "the entry-boundary pattern is overridable (third argument)" \
    '### [0-9][0-9][0-9][0-9]-*' \
    "### 2026-01-01 -- entry A
### 2026-01-02 -- entry L (left)
### 2026-01-03 -- entry R (right)
"

  # THE PERMISSIVE DIRECTION OF THE PATTERN, WHICH THE THREE CASES ABOVE DO NOT COVER (Cybersec,
  # msg 23484). They prove the pattern is READ; none of them proves it cannot be set to a value
  # that accepts everything. That gap is worse than having no override, because the code would
  # then imply a control that does not hold -- and Cybersec measured this same class (a guard
  # predicate with an unpinned permissive direction) three times in one day on separate cards.
  #
  # `*` accepts every line, so every remainder would "begin a new entry" and the silent gluing
  # would be back. It must be REFUSED, not honoured -- and refused rather than silently replaced
  # by the default, so the caller lands in the ordinary manual-resolution path.
  setup_conflict permissive-glob-star \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A
## 2026-01-02 -- entry L (left)
" \
    "## 2026-01-01 -- entry A
## 2026-01-03 -- entry R (right)
"
  t_refused_glob "a permissive boundary pattern (*) is refused, not honoured" '*'

  # ...AND THE ONE THAT MATTERS MOST: the bare `## ` spelling this card REMOVED must not be
  # reachable through the override either. Cybered's CS-2 fixture, run with `## *` as the pattern
  # -- if the override honoured it, CS-2 would resolve again and the fix would be undone from the
  # outside. Same fixture as the CS-2 case, so a regression cannot pass one and fail the other.
  setup_conflict cs2-via-permissive-override \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- Same Decision
intro line
## quoted heading OURS
tail A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- Same Decision
intro line
## quoted heading THEIRS
tail B
"
  t_refused_glob "CS-2 stays refused even when the override asks for the unsafe bare ## " '## *'

  # ...AND THE ENVIRONMENT CANNOT REACH THE PATTERN AT ALL. For one commit this was an environment
  # variable, which meant any parent process of a landing script could have set it. It is now a
  # third ARGUMENT, and that is only a real boundary if nothing still reads the old name -- a
  # leftover `${DECISIONS_ENTRY_HEADER_GLOB:-...}` anywhere in the function would restore the whole
  # hole while every other case here stayed green. So the hostile value is exported, the function
  # is called with TWO arguments as the real callers do, and the DEFAULT behaviour must be
  # completely unaffected: a dated append still unions, which `*` would also have done -- so the
  # discriminating half is the case below it, where `*` would have RESOLVED and the default refuses.
  setup_conflict env-cannot-set-the-pattern \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A
## entry L (left, undated)
" \
    "## 2026-01-01 -- entry A
## entry R (right, undated)
"
  #
  # THE HOSTILE VALUE IS `## entry*`, NOT `*`, AND THAT CHOICE IS THE WHOLE TEST. Written first with
  # `*`, this case PASSED against the very mutation it names: restoring the environment read made
  # the function pick up `*`, the probe guard above refused `*`, the call returned 1, and the case
  # saw the refusal it was waiting for. The guard MASKED the regression the case existed to catch.
  # `## entry*` passes every probe (it is not blank, not bare `## `, does not match prose or a
  # separator) and still matches the undated headers in this fixture -- so if the environment can
  # reach the pattern, this resolves, and only the argument-only form refuses. Re-verified by
  # mutation: with `${DECISIONS_ENTRY_HEADER_GLOB:-...}` put back, this case goes red.
  export DECISIONS_ENTRY_HEADER_GLOB='## entry*'
  t_refused "the environment cannot set the boundary pattern -- it is an argument, not a variable"
  unset DECISIONS_ENTRY_HEADER_GLOB

  # ...AND THE CONTROL THAT KEEPS THAT RULE HONEST: an append carrying its own `---` separator is a
  # NEW entry, not an edit, and must still union. Measured on the real file: 18 of 199 entries are
  # preceded by `---`, so the literal "remainder must start with ## " rule the NO-GO proposed would
  # refuse a legitimate shape -- including this card's own DECISIONS entry.
  setup_conflict separator-led-append \
    "## entry A
body of A
" \
    "## entry A
body of A

---

## 2026-01-02 -- bal oldali bejegyzes
" \
    "## entry A
body of A

---

## 2026-01-03 -- jobb oldali bejegyzes
"
  # THE EXPECTED RESULT KEEPS THE SHARED SEPARATOR ONCE, and that is the correct answer rather than a
  # compromise: both sides wrote the same `---`, so it belongs to the common prefix and appears a
  # single time. The two new entries then sit adjacent with no rule between them -- which is the
  # file's majority shape anyway (181 of 199 entries have no `---` before them). A first version of
  # this expectation demanded the separator twice and failed here; the union was right and my
  # expectation was wrong.
  t_resolved "an append that leads with a --- separator still unions (18 of 199 real entries do)" \
    "## entry A
body of A

---

## 2026-01-02 -- bal oldali bejegyzes
## 2026-01-03 -- jobb oldali bejegyzes
"

  # UTF-8: THE INVARIANT, ASSERTED ON THE HELPER DIRECTLY (card b7e57877).
  #
  # `cmp` reports a BYTE offset; bash's ${#var} and ${var:i:n} count CHARACTERS unless the locale is
  # C. On the real DECISIONS.md -- Hungarian prose -- that file is 609416 bytes and 573384
  # characters, and using one number as the other made the helper return a "common prefix" LONGER
  # THAN ONE OF THE TWO SIDES. That is impossible by definition, and it is what refused the landing
  # this card was supposed to unblock.
  #
  # WHY THIS IS NOT A setup_conflict FIXTURE. Two were written and BOTH passed with the fix removed:
  # a small one because the byte/char gap was under one line and the truncate-to-newline step
  # absorbed it, and a large one because the surviving checks still produced a plausible union for
  # that particular shape. A fixture that cannot tell the bug from the fix reports coverage that is
  # not there, so the property is asserted where it is unambiguous: on the helper's own answer.
  utf8_a="## fejléc
"
  for _ in $(seq 1 200); do
    utf8_a+="Hosszú, ékezetes törzsszöveg: árvíztűrő tükörfúrógép, őúűéáí ÖÜÓŐÚÉÁŰÍ.
"
  done
  utf8_b="${utf8_a}## jobb oldal
"
  utf8_a+="## bal oldal
"
  utf8_n="$(_common_line_prefix_len "$utf8_a" "$utf8_b")"
  # The EXPECTED answer, computed independently and in BYTES: the two sides share everything up to
  # and including the last newline before they diverge, which here is all of utf8_a minus its final
  # "## bal oldal\n" line. `<=` is not enough as an assertion -- the broken form UNDER-shoots on this
  # shape (it returns a character count, which is smaller), so only an equality catches it.
  utf8_expect="$(LC_ALL=C bash -c 'a=$1; h="${a%$'"'"'\n'"'"'*}"; h="${h%$'"'"'\n'"'"'*}"; echo $(( ${#h} + 1 ))' _ "$utf8_a")"
  n=$((n+1))
  if [ "$utf8_n" = "$utf8_expect" ]; then
    echo "  ok   UTF-8: the prefix length is measured in BYTES ($utf8_n), not characters"
  else
    echo "  FAIL UTF-8: prefix length $utf8_n, expected $utf8_expect bytes -- a byte offset from cmp"
    echo "       is being used as a bash CHARACTER index (card b7e57877)"
    fail=1
  fi

  # REALISTIC SIZE, on a clock (card d56786a7). Every case above runs on a few hundred bytes, so
  # every one of them passed just as happily with the O(n^2) `${ours#"$base"}` strip that froze
  # real landings for minutes -- correctness cases cannot see a complexity bug, only size can.
  #
  # This is a wall-clock budget, which is normally a flaky thing to assert. It is safe HERE only
  # because the gap is absurd rather than marginal: measured on this input, pattern-strip took
  # 138s and the offset form 0.007s, ~20000x. A 60s budget is four orders of magnitude above the
  # fixed version and still less than half the broken one, so machine load cannot flip it. Do not
  # copy this pattern where the margin is tight -- that is a different card (3208a968).
  big_base=""
  for _ in $(seq 1 4000); do
    big_base+="## 2026-01-01 -- padding entry to reach a realistic file size
some body text on the following line
"
  done
  setup_conflict big-append "$big_base" \
    "${big_base}## 2026-01-02 -- entry B (left)
" \
    "${big_base}## 2026-01-03 -- entry C (right)
"
  perf_start=$(date +%s)
  t_resolved "a REALISTIC-SIZE file ($(printf '%s' "$big_base" | wc -c) bytes) unions without freezing" \
    "${big_base}## 2026-01-02 -- entry B (left)
## 2026-01-03 -- entry C (right)
"
  perf_elapsed=$(( $(date +%s) - perf_start ))
  if [ "$perf_elapsed" -gt 60 ]; then
    echo "  FAIL the realistic-size union took ${perf_elapsed}s (budget 60s) -- the O(n^2) prefix strip is back"
    fail=1
  else
    echo "  ok   ...and it took ${perf_elapsed}s, well inside the 60s budget"
  fi

  echo "selftest: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi
