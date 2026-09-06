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
# ONE grammar for "this line carries nothing that could be merged wrongly" -- a blank line or a
# horizontal rule (Cybered C-1, card bb52c2fa). It existed TWICE as an inline `case` list, and the
# duplication is the defect: this file has now been bitten three times by two halves that were meant
# to implement one rule and drifted (the setext/fence indent, the setext/fence trailing whitespace,
# and this one on the LINE ENDING axis). Both copies matched the separators EXACTLY, so on a CRLF
# file `---\r` was not a rule, and byte-identical content RESOLVED on LF while it was REFUSED on
# CRLF. Fail-closed, so nothing merged wrongly -- but a refusal a user cannot reproduce on their own
# copy is its own cost, and the fix belongs in one place rather than two.
_is_blank_or_rule() {
  case "${1%$'\r'}" in
  ''|'---'|'***'|'___') return 0 ;;
  esac
  return 1
}

_common_line_prefix_len() {
  # BYTE SEMANTICS, FORCED. `cmp` reports a BYTE offset; bash's ${#var} and ${var:i:n} count
  # CHARACTERS unless the locale is C. On the real DECISIONS.md -- Hungarian prose, UTF-8 -- those
  # differ by ~36000: the file is 609416 bytes and 573384 characters, and cmp's "differ: byte 601266"
  # was being used as a character index. The result was a "common prefix" LONGER than one of the two
  # sides, which is impossible by definition.
  #
  # It passed every selftest because every fixture was ASCII, where the two counts coincide. That is
  # the whole reason this shipped: the tests could not see the difference they were built out of.
  #
  # WHY THE OLD PARSER BROKE, and it takes TWO facts together -- neither explains it alone (Cybered
  # C-2 and Cybersec F-2, card bb52c2fa; the first two explanations written here, both mine, were
  # wrong and are corrected in DECISIONS.md rather than quietly deleted).
  #
  # FACT 1 -- `local LC_ALL=C` reaches the CHILD only if LC_ALL was ALREADY EXPORTED. bash's `local`
  # inherits the existing export attribute; it does not create one. Proved with `declare -p` inside
  # such a function:
  #     LC_ALL unset in the environment -> declare -- LC_ALL="C"   (child does NOT see it)
  #     LC_ALL exported                 -> declare -x LC_ALL="C"   (child DOES see it)
  #
  # FACT 2 -- GNU cmp's wording follows the locale's CHARACTER WIDTH, inverted from the naive guess:
  #     single-byte locale (C, POSIX, or any invalid value falling back to C) -> "differ: char N"
  #     multibyte locale   (C.UTF-8, or the ambient LANG when LC_ALL is unset) -> "differ: byte N"
  #
  # Together: with LC_ALL unset the local never reached cmp, cmp ran under the multibyte ambient
  # LANG and said "byte", and the `byte`-only pattern worked. With LC_ALL exported to ANYTHING the
  # local DID reach cmp, cmp ran in single-byte C and said "char", the pattern matched nothing, `n`
  # came back empty, and the fallback below answered with the SHORTER side's whole length as the
  # common prefix. That is why every exported value broke it -- the specific locale never mattered,
  # only whether one was exported. Selftest: green with LC_ALL unset, 61/67 with any export. Any CI
  # or agent environment that exports LC_ALL got a FALSE RED on correct code -- the rule-17 class.
  #
  # THE FIX IS NOT A WIDER WORD LIST, because that is the same enumeration mistake one rung up: a
  # translated locale prints a different sentence entirely. `cmp -l` emits NUMBERS -- one line per
  # differing byte, `<1-based byte offset> <octal a> <octal b>` -- and its FORMAT is identical in
  # every environment tried (unset, C, C.utf8, POSIX; only those three locales exist on this host,
  # which is why the earlier five-row table in this comment was wrong: two of its rows were the
  # invalid-locale fallback wearing another name). Verified multibyte: two files differing after
  # `áéí` (6 bytes) report offset 7 under both C and C.utf8, i.e. a byte offset, not a character one.
  local LC_ALL=C
  local a="$1" b="$2" n cut head
  # `awk '{print $1}'`, NOT `cut -d' ' -f1`: cmp -l RIGHT-ALIGNS the offset, so a large one arrives
  # as `              20024 101 102` and a single-space cut returns the empty field before it. My own
  # first attempt did exactly that and it was invisible in a 4-byte fixture, where the offset is one
  # digit and there is no padding -- the same "the fixture could not see the shape it was built out
  # of" trap this function's header already documents about ASCII-only cases.
  n="$(cmp -l <(printf '%s' "$a") <(printf '%s' "$b") 2>/dev/null | head -n1 | awk '{print $1}')"
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

# Does this text end INSIDE an open fenced code block?
#
# STATE, NOT A SPELLING (Cybered R-1). The first version counted `grep -c '^```'` and asked for an
# even number. Measured on the same fixture shape that correctly refuses an unclosed ```: an
# unclosed `~~~` and a ```-fence indented by two spaces both UNIONED, and both produce exactly the
# J-2 harm -- theirs' entry swallowed into the block. That is one spelling of a general property,
# and adding `~~~` beside it would be the third rung of the same ladder this card already climbed
# twice; the answer there was to change the question, and it is the answer here too.
#
# So this tracks the CommonMark rule instead: a fence opens on three or more ` or ~ indented at most
# three spaces (four is an indented code block, never a fence), and closes on the SAME character, at
# least as long, with nothing but whitespace after it. An info string (```bash) is allowed on the
# opener and forbidden on the closer, which is why the closer is matched strictly -- being lenient
# there would close a block the parser leaves open, and that is the fail-OPEN direction.
#
# $1 = the text. 0 = ends inside an open fence (refuse), 1 = balanced.
_ends_inside_code_fence() {
  local LC_ALL=C line body ch run rest open_ch='' open_len=0
  while IFS= read -r line; do
    body="$line"
    case "$body" in
    '    '*) continue ;;
    '   '*) body="${body#   }" ;;
    '  '*)  body="${body#  }" ;;
    ' '*)   body="${body# }" ;;
    esac
    case "$body" in
    '`'*) ch='`' ;;
    '~'*) ch='~' ;;
    *) continue ;;
    esac
    run=0
    while [ "${body:$run:1}" = "$ch" ]; do run=$((run + 1)); done
    [ "$run" -ge 3 ] || continue
    if [ -z "$open_ch" ]; then
      open_ch="$ch"; open_len="$run"
      continue
    fi
    [ "$ch" = "$open_ch" ] && [ "$run" -ge "$open_len" ] || continue
    rest="${body:$run}"
    case "$rest" in
    *[![:space:]]*) continue ;;      # text after the fence -> not a closer
    esac
    open_ch=''; open_len=0
  done <<<"$1"
  [ -n "$open_ch" ]
}

# Would splicing these two lines together form a SETEXT HEADING that neither side wrote?
#
# EXTRACTED SO IT CAN BE TESTED ON ITS OWN CONTRACT (Cybersec, comment 20760). Inline, the `=`
# half could only be exercised through a full merge fixture -- and MEASURED, such a fixture is
# VACUOUS: `===` is not on the shared-new exception list, so `_starts_new_entry` refuses it before
# the seam is ever consulted. Removing this whole check leaves a `===` fixture refused and a `---`
# fixture resolving, which is exactly how an adjacent guard masks the one under test.
#
# WHY THE `=` HALF STAYS even though nothing reaches it today: `===` becomes reachable the moment
# anyone adds it to the shared-new exception list, and Cybered measured that such an addition
# directly manufactures a J-1 instance. "Not wired" is a timing fact, not a safety property -- the
# same standard applied to the merge-driver finding on this card. Keeping it costs one character
# class; dropping it means a future one-line widening silently arms the seam.
#
# $1 = last non-blank line BEFORE the junction, $2 = first line AFTER it.
# 0 = would form a heading (refuse), 1 = safe.
_seam_makes_setext_heading() {
  # A rule under NOTHING is just a rule: markdown needs a paragraph line above it to promote.
  # The `\r` strip is the CRLF half of the same axis the trailing trim below closes: in a CRLF file
  # a BLANK line arrives as a lone `\r`, which is a non-empty string and would read as a paragraph.
  # PIN THE LOCALE HERE TOO (Cybersec N-1, comment 21236). `_ends_inside_code_fence` does; this half
  # did not, so the `[[:space:]]` class introduced in the previous round was evaluated under the
  # AMBIENT locale. Measured: `---` followed by U+2028 or U+3000 REFUSES under C.UTF-8 and is safe
  # under LC_ALL=C. The production path happens to be shielded -- `try_append_union` sets
  # `local LC_ALL=C` and bash scopes that dynamically over this call -- so the merge answer was never
  # environment-dependent; the exposure is a DIRECT caller, which is what the selftest is. Pinned
  # anyway: a predicate that carries its own locale cannot be broken by a future caller that forgets.
  local LC_ALL=C
  local prev="${1%$'\r'}"
  [ -n "$prev" ] || return 1
  # THE SAME 0-3 SPACE INDENT THE FENCE SIDE ALREADY HANDLES (Cybersec, comment 21040). CommonMark
  # lets a setext underline be indented up to three spaces, exactly like a fence opener -- and this
  # predicate anchored at column 0 while `_ends_inside_code_fence`, fixed in the same round, did
  # not. One class, two halves, and only one of them learned it: measured on the landed copy,
  # `---` refused and `  ---` passed. Four or more spaces is safe either way (too deep for a setext
  # underline, and an indented code block cannot interrupt a paragraph).
  local u="$2"
  case "$u" in
  '    '*) return 1 ;;
  '   '*) u="${u#   }" ;;
  '  '*)  u="${u#  }" ;;
  ' '*)   u="${u# }" ;;
  esac
  # Trailing WHITESPACE is allowed after the underline; only OTHER text disqualifies it.
  #
  # ONE CHARACTER CLASS, NOT AN ENUMERATION OF THE TWO SPELLINGS SOMEONE THOUGHT OF (Cybered, comment
  # 21147 -- the same collision class this card exists for, one axis further along). The previous
  # form trimmed space and tab only, so in a CRLF file the underline arrives as `---\r`, the `\r`
  # survives, and `*[!-]*` carries it to SAFE. Measured on the landed copy: `---`, `  ---` and
  # `---\t` all REFUSE correctly, while `---\r`, `===\r` and `   ===\r` all read as safe. The FENCE
  # half was already CR-tolerant, because its check uses `[![:space:]]` -- so once again one half of
  # the pair had learned the rule and the other had not, and this time the untaught half fails OPEN:
  # `safe` means the union runs and the inserted text turns its neighbour into a heading nobody
  # asked for. `[[:space:]]` puts both halves on one grammar rather than closing this one case.
  while :; do
    case "$u" in
    *[[:space:]]) u="${u%?}" ;;
    *) break ;;
    esac
  done
  # ANY RUN OF `-` OR `=`, NOT A HANDFUL OF SPELLINGS. The first version listed
  # `---|===|--------*|========*`, which matches exactly three or at least eight -- so a FOUR to
  # SEVEN character run fell through, and in CommonMark a setext underline is any sequence of `-`
  # (or `=`) with nothing else on the line, of any length. Found by this file's own direct seam
  # cases the moment they were written, which is precisely what Cybersec asked them for: the
  # end-to-end fixture only ever exercised the exact `---` spelling.
  case "$u" in
  '') return 1 ;;
  *[!-]*) : ;;
  *) return 0 ;;
  esac
  case "$u" in
  *[!=]*) return 1 ;;
  *) return 0 ;;
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
  #
  # WHAT THIS PATTERN IS FOR, AFTER CS-3 -- and it is NOT what it was introduced for. It was added
  # to close CS-2 (an undated `## ` body line), and CS-3 then defeated it with a DATED body line
  # (Cybersec NO-GO 20542, Cybered NO-GO 20551). That whole family is now closed STRUCTURALLY, by
  # the shared-new-content check further down, which does not look at line shape at all. Leaving
  # the old justification here would be a lie of exactly the kind Cybersec flagged in the probe
  # guard's comment, so: this pattern no longer carries the ladder.
  #
  # What it still carries is the OTHER axis, and that one the structural check cannot reach: both
  # sides appending PROSE to the LAST EXISTING entry. Nothing new is shared there, so the structural
  # check passes, and only this boundary stops the two continuations being glued into that entry.
  # Measured in both directions (`both-continue-existing-entry` and `cs3-dated-quoted-heading` in
  # the selftest below, each red under the mutation that removes the OTHER check): neither check
  # subsumes the other. Do not delete one because "the other covers it".
  #
  # WIDENING IT is therefore cheaper than it was, but not free: it does not reopen CS-1/CS-2/CS-3
  # any more, it reopens the continuation axis. The DATED form specifically buys nothing measurable
  # over a bare `## ` on the corpus (measured 2026-09-05: marveen 208/208 and CleanCore 154/154
  # headers dated -- a snapshot, and the files keep growing, so re-measure rather than cite this) and
  # costs the refusal of an undated append -- it is kept as the stricter of two equivalent choices,
  # not because anything measured requires it.
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
  local base_vs_prefix
  base_vs_prefix="$(diff <(printf '%s\n' "${base%%$'\n'}") <(printf '%s\n' "${prefix%%$'\n'}"))"
  grep -q '^<' <<<"$base_vs_prefix" && return 1

  # THE STRUCTURAL BOUNDARY, WHICH REPLACES THE LINE-PATTERN LADDER (Cybersec 20542 + Cybered 20551,
  # third rung of the same defect). Three rungs were climbed on this one card: `## ` (Cybersec
  # NO-GO), then dated `## ` (Cybered CS-2), then a DATED BODY LINE defeating that (CS-3). Each fix
  # asked "what does an entry header look like", and each time a body line was found that looks like
  # one. Cybersec named the pattern in the same breath as reporting it: every tightening of a
  # line-pattern heuristic re-asks the same question, and at some point the right answer is that the
  # boundary is not a line pattern. Chronology (Cybered's measured 12-line prototype) is one more
  # rung -- narrower, still defeated by a header quoted with a LATER date, and they said so
  # themselves. So this asks a different question entirely, one about the MERGE rather than the TEXT:
  #
  #   Did the two sides write the same NEW content before they diverged?
  #
  # That is exactly the CS-1/CS-2/CS-3 condition, and it does not care what the content looks like.
  # In a genuine append-append the common prefix IS the merge-base: both sides added only their own
  # tail, so nothing new is shared. In every rung of the ladder the prefix contains the base PLUS
  # something both sides wrote identically -- a shared header, or a shared header and an intro line
  # -- and it is precisely that shared new content that makes "one entry or two?" unanswerable.
  # Refusing there is not a heuristic: it is declining to guess where the data cannot tell us.
  #
  # THE ONE EXCEPTION, and it is why this is not simply "prefix must equal base": the measured case
  # this whole card exists for had BOTH sides insert the SAME blank line mid-file before appending
  # (`git diff --numstat` 30/0 and 924/0, neither side deleting anything), and the separator case
  # has both sides write the same `---` before their own entry. Blank lines and horizontal rules
  # carry no content to merge wrongly -- an entry cannot be silently glued to another through them.
  # So shared new BLANK and SEPARATOR lines are allowed and shared new SUBSTANTIVE lines are not.
  #
  # The diff is the one already computed above, so this costs no extra pass over a 447 KB file.
  local shared_new
  shared_new="$(sed -n 's/^> //p' <<<"$base_vs_prefix")"
  while IFS= read -r line; do
    _is_blank_or_rule "$line" && continue
    return 1
  done <<<"$shared_new"

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
  # WHAT THIS ACTUALLY IS: A FILTER OVER SEVEN FIXED PROBE LINES -- NOT a precondition (Cybersec,
  # msg 23507, doc-accuracy finding on the first version of this comment, which claimed the
  # stronger thing). The difference matters to the next reader: a precondition would mean no
  # pattern matching an inside-an-entry line can get through, and that is NOT what runs here.
  # The probes are a blank line, a bare `## `, a `## ` heading with prose after it (the CS-2
  # shape), ordinary prose, and the three separator forms. `*` fails all of them; `## *` fails the
  # two heading probes, which is correct rather than an oversight, since a bare `## ` boundary is
  # the unsafe spelling this card removed. The default passes every probe: it requires four digits.
  #
  # WHAT GETS THROUGH, stated so nobody stops looking: any pattern narrower than the probes but
  # still wider than a real entry header. My own hostile test value `## entry*` is the proof -- it
  # passes all seven and still matches an undated header. Cybersec's example is sharper: `## [0-9]*`
  # passes all seven and matches the BODY line `## 2 reasons why`. The filter buys the obvious
  # mistakes, not a guarantee.
  #
  # THE ACTUAL CONTROL IS THAT THE PATTERN IS AN ARGUMENT, not this filter, and Cybersec added a
  # reason for that beyond permissiveness: the pattern is interpolated UNQUOTED into `case ... in
  # $header_glob)`, so the string stands in shell pattern position. As an environment variable it
  # was open not only to over-wide values but to `)` and `|` -- case-arm punctuation, read from
  # ambient state. Deleting the environment read closed that too. Which is also why this filter is
  # deliberately NOT made cleverer: with the pattern argument-only there is no attacker at this
  # boundary, and a smarter filter would buy nothing while implying more than it delivers.
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
      case "${line%$'\r'}" in
      $header_glob) return 0 ;;
      esac
      _is_blank_or_rule "$line" && continue
      return 1
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

  # THE JUNCTION IS THE ONLY PLACE THIS FUNCTION CREATES BYTES (Cybered J-1/J-2, comments 20593 and
  # 20597). Every check above examines a HALF -- the prefix, ours' remainder, theirs' remainder --
  # and each half can be individually blameless while the SEAM between them forms markdown structure
  # that neither parent contained. Both findings are that shape, both were reproduced before this
  # was written, and neither loses a byte: they change what the file MEANS, which is the property
  # the whole function exists to preserve.
  #
  # J-1, SETEXT HEADING. A `---` line directly under a non-blank text line is an H2 in markdown, not
  # a horizontal rule. So when ours' remainder ends on prose and theirs' begins with a rule, the
  # join silently promotes ours' last line to a heading. Measured live on the default path; Cybered
  # measured it on about a fifth of the CleanCore pairs. The separator case this function
  # deliberately allows is NOT this: there the rule sits in the SHARED PREFIX, with a blank line
  # around it, and no text line is adopted by it.
  #
  # J-2, OPEN CODE FENCE. If everything up to the junction leaves a fence open, theirs' entire
  # entry lands INSIDE it -- its `## ` header stops being a header and stops being greppable, while
  # every line-based check above still passes because the lines are all present. Parity is counted
  # over prefix+ours precisely because a fence opened in the shared prefix is closed by each side
  # separately; what matters is the state at the point theirs is spliced in.
  local before_junction="${prefix}${joined}" last_before first_after
  # THE ACTUAL LAST LINE, not the last NON-EMPTY one (Cybered R-3). A setext underline must
  # IMMEDIATELY follow paragraph content: a blank line ends the paragraph, so a `---` after one is
  # an ordinary horizontal rule. Filtering blanks out would look past that blank line, find the
  # prose above it, and refuse a legitimate merge.
  #
  # NOT REACHABLE THROUGH THE MERGE PATH TODAY, AND SAYING SO IS THE POINT. Measured: a file ending
  # "prozasor\n\n" on disk arrives here as "prozasor" -- `$(git show ...)` strips trailing newlines,
  # so `before_junction` cannot end on a blank line no matter what either side wrote. The end-to-end
  # behaviour is therefore UNCHANGED by this line, and an end-to-end fixture for it would be vacuous
  # (the same trap as the seam predicate's `=` half, and the reason that half is pinned directly).
  #
  # KEPT ANYWAY, for the reason the `=` half is kept: the predicate should be right on its own
  # contract, and this becomes reachable the moment anyone reads `ours` without command substitution
  # -- which is a live possibility precisely because this file has already been bitten twice by that
  # stripping. The predicate half is pinned by the direct seam cases below (a rule with nothing above
  # it is safe); this line is what would feed it a genuinely empty `last_before`.
  #
  # Parameter expansion, not `$(... | tail -n1)`: the first attempt at this used the latter and
  # measured as a NO-OP, because the substitution had already eaten the blank line before `tail` ran.
  case "$before_junction" in
  *$'\n'$'\n') last_before='' ;;
  *) last_before="$(printf '%s' "$before_junction" | tail -n1)" ;;
  esac
  first_after="$(printf '%s' "$theirs_added" | head -n1)"
  _seam_makes_setext_heading "$last_before" "$first_after" && return 1
  _ends_inside_code_fence "$before_junction" && return 1

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
# NOT A MERGE DRIVER, AND THE REFUSAL IS LOUD (Cybersec, card 3ae71df1). Measured: this file is mode
# 775 and, invoked with three path arguments, returned 0 -- which is exactly `git merge.<name>.driver`
# calling convention (%O %A %B). Nothing wires it that way today, but nothing structural prevents it
# either: one `merge.*.driver` config line plus a .gitattributes entry would be enough, and the
# failure mode is SILENT DATA LOSS -- a driver that exits 0 tells git the merge succeeded, so git
# keeps %A (ours) and discards theirs, with no conflict and no message.
#
# A comment cannot prevent that; an exit code can. Direct execution with anything other than
# --selftest now fails loudly. Sourcing is unaffected (BASH_SOURCE differs from $0), which is how
# every real caller uses this file, and the --selftest path below is untouched.
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" != "--selftest" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): this file is a SOURCED helper, not an executable." >&2
  echo "  It takes no positional arguments. If you reached this from a git merge driver" >&2
  echo "  configuration, REMOVE IT: exiting 0 there would make git keep ours and silently" >&2
  echo "  discard theirs." >&2
  echo "  There is NO supported merge-driver configuration for this file -- do not wire one." >&2
  echo "  (--selftest runs its tests. Note the guard cannot see a driver that SOURCES this file:" >&2
  echo "   sourcing inherits the caller's positional parameters, so a caller invoked with three" >&2
  echo "   arguments would be indistinguishable from a driver call. Cybered R-2.)" >&2
  exit 2
fi

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--selftest" ]; then
  fail=0
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  # THE VERDICT IS DERIVED FROM WHAT WAS PRINTED, NOT ONLY FROM A FLAG A CASE REMEMBERED TO SET
  # (Cybered F-1, card bb52c2fa -- and the two cases it caught were MINE, added in the previous
  # round to close a silent green). Both of them incremented `bad`, a variable nothing reads, so
  # with the regression reintroduced the run printed `FAIL ...` and then said `selftest: PASS`,
  # exit 0. Worse, my mutation evidence for those two cases counted PRINTED FAIL LINES rather than
  # the verdict, so it reported them as catching the regression while CI would have gone green.
  #
  # Fixing the two sites is not enough -- that leaves the same trap set for the next case someone
  # adds. So stdout is captured and the verdict READS IT BACK: if any `  FAIL` line was emitted, the
  # run cannot report PASS, whatever any flag says. A case can now forget the flag and still be
  # counted; it cannot print a failure into a green run.
  #
  # Plain redirect + `cat`, not `tee` through a process substitution: the check has to see a fully
  # flushed file, and a pipeline would put the body in a subshell where `fail` could not survive.
  _selftest_log="$TMP/selftest.out"
  exec 3>&1 >"$_selftest_log"

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
  # Like t_resolved but without an expected-content argument: these fence fixtures differ only in
  # the block they carry, and pinning the whole file for each would assert the fixture, not the rule.
  t_resolved_any() { # $1 = label
    if try_append_union "$REPO" "DECISIONS.md"; then echo "  ok   $1"
    else echo "  FAIL $1 -> expected try_append_union to resolve (return 0), it returned 1"; fail=1; fi
    git -C "$REPO" merge --abort 2>/dev/null || true
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

  # CS-3, THE THIRD RUNG AND THE ONE THE LINE PATTERN CANNOT REACH (Cybersec NO-GO 20542, Cybered
  # NO-GO 20551). Same shape as CS-2, except the quoted body heading is DATED -- so it satisfies the
  # dated boundary, both remainders "start a new entry", and the union glues two continuations under
  # one header. This is what proved the ladder cannot be climbed: `## `, then dated `## `, and a body
  # line was found for each. It is refused by the STRUCTURAL check (shared new content before the
  # split), not by any line pattern -- mutation-verified: with `shared_new` forced empty this case
  # RESOLVES while every other case in this file stays green, which is exactly how it shipped.
  setup_conflict cs3-dated-quoted-heading \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- Same Decision
intro line
## 2026-01-01 -- quoted heading OURS
tail A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- Same Decision
intro line
## 2026-01-01 -- quoted heading THEIRS
tail B
"
  t_refused "a DATED body heading is not an entry boundary either (CS-3, structural)"

  # ...AND THE OTHER AXIS, WHICH THE STRUCTURAL CHECK CANNOT REACH. Both sides append PROSE to the
  # LAST EXISTING entry -- no new header on either side, so nothing new is shared and the structural
  # check passes cleanly. Concatenating the two remainders puts both continuations inside the same
  # existing entry. Only the line-pattern boundary catches this, and only the structural check
  # catches CS-3: measured in both directions, neither check subsumes the other, and a reader who
  # deletes one because "the other one covers it" is wrong on a specific, named case.
  setup_conflict both-continue-existing-entry \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
folytatás BAL
" \
    "## 2026-09-01 -- entry A
body of A
folytatás JOBB
"
  t_refused "both sides continuing the SAME existing entry is refused (line-pattern axis)"

  # THE PRICE OF THE STRUCTURAL RULE, and it is a case that RESOLVED before it (Cybered, comment
  # 20572, who asked for it to be said out loud rather than discovered). Both sides append the SAME
  # new entry X and then each their own: X is shared NEW substantive content, so the union is now
  # refused where it used to produce "X once, then A, then B".
  #
  # NOT HYPOTHETICAL -- it happened on this very card today, when a gate had already landed the
  # DECISIONS entry and this branch still carried its own copy; that was resolved by hand. From here
  # the landing stops instead, and that is the right direction (manual resolution, not a bad merge):
  # a machine cannot tell a duplicate from two independent decisions that happen to say the same
  # thing. But it is a behaviour change, and a behaviour change nobody tests is one the next reader
  # will "fix" back -- the same reason the undated-header price has a case of its own.
  #
  # DISTINCT from `both-continue-existing-entry` above, which Cybered pointed out does NOT cover
  # this: that one is two continuations of an EXISTING entry, this one is the same NEW entry twice.
  setup_conflict same-new-entry-both-sides \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- Közös X
X törzs
## 2026-09-06 -- entry B (left)
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- Közös X
X törzs
## 2026-09-07 -- entry C (right)
"
  t_refused "the SAME new entry on both sides is now refused -- the price of the structural rule"

  # THE EXCEPTION LIST IS LINE-EXACT, AND ITS NEAR MISSES MUST FAIL CLOSED (Cybered named these as
  # their next measurement, comment 20572). Shared new blank and separator lines are the ONE thing
  # allowed through the structural check, so the width of that hole is worth pinning: anything that
  # merely LOOKS like a rule -- a trailing space, `- - -`, `* * *`, four dashes -- is shared new
  # substantive content and is refused.
  #
  # THE ALLOWED SET IS FOUR MEMBERS, NOT TWO (Cybersec, comment 20632). An earlier version of this
  # comment said "only the exact `---` and `***` forms union" while the case arm three lines up
  # allows `''|'---'|'***'|'___'` -- a blank line and three rule spellings. The comment was written
  # from the two forms the fixture happened to exercise, not from the code, which is exactly the
  # habit that produces a doc-accuracy finding. Every member now has its own case below; every
  # near-miss has its own too, because widening them as a block turns one case red and reads as
  # coverage of all four.
  setup_conflict separator-near-miss \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A

--- 

## 2026-09-05 -- entry B (left)
" \
    "## 2026-09-01 -- entry A
body of A

--- 

## 2026-09-06 -- entry C (right)
"
  t_refused "a separator with a trailing space is not on the exception list -- refused"

  # ONE CASE PER NEAR-MISS FORM, not one case for all four (Cybered F-T). The first version of this
  # widened all four spellings at once: that turns a single case red and READS as coverage, while
  # per-form only one of the four was actually pinned. Mutation granularity has to match the claim.
  setup_conflict near-miss-spaced-dashes \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A

- - -

## 2026-09-05 -- entry B (left)
" \
    "## 2026-09-01 -- entry A
body of A

- - -

## 2026-09-06 -- entry C (right)
"
  t_refused "near miss (spaced dashes) is not on the exception list -- refused"

  setup_conflict near-miss-spaced-stars \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A

* * *

## 2026-09-05 -- entry B (left)
" \
    "## 2026-09-01 -- entry A
body of A

* * *

## 2026-09-06 -- entry C (right)
"
  t_refused "near miss (spaced stars) is not on the exception list -- refused"

  setup_conflict near-miss-four-dashes \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A

----

## 2026-09-05 -- entry B (left)
" \
    "## 2026-09-01 -- entry A
body of A

----

## 2026-09-06 -- entry C (right)
"
  t_refused "near miss (four dashes) is not on the exception list -- refused"

  # ...AND ONE CASE PER ALLOWED MEMBER, enumerated from the case arm rather than from whichever
  # spelling a fixture happened to use -- the habit that let the comment above claim two members
  # when the code allows four. The blank-line member is covered by `identical-midfile-insert` and
  # `---` by `separator-led-append`; these are the two that had no case at all.
  setup_conflict allowed-stars-separator \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A

***

## 2026-09-05 -- entry B (left)
" \
    "## 2026-09-01 -- entry A
body of A

***

## 2026-09-06 -- entry C (right)
"
  t_resolved "the shared stars separator is on the exception list -- unions" \
    "## 2026-09-01 -- entry A
body of A

***

## 2026-09-05 -- entry B (left)
## 2026-09-06 -- entry C (right)
"

  setup_conflict allowed-underscores-separator \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A

___

## 2026-09-05 -- entry B (left)
" \
    "## 2026-09-01 -- entry A
body of A

___

## 2026-09-06 -- entry C (right)
"
  t_resolved "the shared underscores separator is on the exception list -- unions" \
    "## 2026-09-01 -- entry A
body of A

___

## 2026-09-05 -- entry B (left)
## 2026-09-06 -- entry C (right)
"

  # J-1: THE SEAM MANUFACTURES A SETEXT HEADING (Cybered, comment 20593). A `---` directly under a
  # non-blank text line is an H2, not a rule. Ours ends on prose, theirs opens with a rule, and the
  # join promotes ours' last line to a heading that neither parent had. Reproduced on the default
  # path before the fix; not a byte is lost, which is why every line-based check stays green.
  setup_conflict junction-setext-heading \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
utolsó prózasor
" \
    "## 2026-09-01 -- entry A
body of A
---

## 2026-09-06 -- entry C (right)
"
  t_refused "J-1: the junction must not manufacture a setext heading"

  # ...AND THE PREDICATE ON ITS OWN CONTRACT (Cybersec, comment 20760). The end-to-end fixture above
  # covers the `-` half and is genuine -- MEASURED: with the seam check removed it RESOLVES. The `=`
  # half cannot be covered that way: `===` is not on the shared-new exception list, so
  # `_starts_new_entry` refuses it first, and a `===` merge fixture stays green with the seam check
  # deleted. Green for the wrong reason is not coverage, so the `=` half is pinned here, directly.
  _seam_case() { # $1 label, $2 last-before, $3 first-after, $4 expected: refuse|safe
    n=$((n+1))
    local got=safe
    _seam_makes_setext_heading "$2" "$3" && got=refuse
    if [ "$got" = "$4" ]; then echo "  ok   seam: $1"
    else echo "  FAIL seam: $1 -> $got, expected $4"; fail=1; fi
  }
  _seam_case "prose then ---  forms a heading"        "utolso prozasor" "---"   refuse
  _seam_case "prose then ===  forms a heading"        "utolso prozasor" "==="   refuse
  # THE RUN LENGTHS THAT THE FIRST PATTERN MISSED. It matched exactly three or at least eight;
  # CommonMark accepts any length, so four through seven silently formed a heading.
  _seam_case "prose then ---- (four dashes)"          "utolso prozasor" "----"  refuse
  _seam_case "prose then ----- (five dashes)"         "utolso prozasor" "-----" refuse
  _seam_case "prose then ==== (four equals)"          "utolso prozasor" "====="  refuse
  _seam_case "prose then a single -"                  "utolso prozasor" "-"     refuse
  _seam_case "prose then a single ="                  "utolso prozasor" "="     refuse
  _seam_case "prose then a very long dash run"        "utolso prozasor" "------------" refuse
  # THE OTHER DIRECTION, so "always refuse" cannot pass the four above.
  _seam_case "prose then an ordinary line is safe"    "utolso prozasor" "jobb torzs" safe
  _seam_case "prose then a *** rule is safe"          "utolso prozasor" "***"   safe
  # MIXED characters are not a setext underline, and refusing them would be a widening with no
  # markdown behind it -- the direction this file refuses to take without a measurement.
  _seam_case "prose then -=- (mixed) is safe"         "utolso prozasor" "-=-"   safe
  _seam_case "prose then '--- x' (trailing text) safe" "utolso prozasor" "--- x" safe
  # A rule with NOTHING above it is a rule, not a heading -- this is the `[ -n "$1" ]` half, and
  # without it the function would refuse a legitimate separator-led append.
  _seam_case "--- with nothing above it is safe"      ""                "---"   safe
  _seam_case "=== with nothing above it is safe"      ""                "==="   safe

  # THE 0-3 SPACE INDENT, WHICH THE FENCE SIDE ALREADY HANDLED AND THIS ONE DID NOT (Cybersec
  # 21040). CommonMark indents a setext underline up to three spaces exactly as it does a fence
  # opener; measured on the landed copy, `---` refused and `  ---` passed -- one class, two halves,
  # and only the half I happened to fix in that round had learned it.
  _seam_case "1-space indented --- is still a heading"  "prozasor" " ---"    refuse
  _seam_case "2-space indented --- is still a heading"  "prozasor" "  ---"   refuse
  _seam_case "3-space indented === is still a heading"  "prozasor" "   ==="  refuse
  # FOUR is past the limit -- and an indented code block cannot interrupt a paragraph either, so
  # it is safe by both readings. This is the control that stops "strip all leading space".
  _seam_case "4-space indented --- is NOT a heading"    "prozasor" "    ---" safe
  # CRLF (Cybered, comment 21147): the trailing trim is a whitespace CLASS now, so a `\r` before
  # the line end no longer carries the underline to safe. The second case is the control that
  # keeps the trim from swallowing real text: `--- x` is not an underline with or without a CR.
  _seam_case "CRLF --- is still a heading"              "prozasor" "$(printf '%s\r' ---)"   refuse
  _seam_case "CRLF === is still a heading"              "prozasor" "$(printf '%s\r' ===)"   refuse
  _seam_case "CRLF trailing text is NOT a heading"      "prozasor" "$(printf '%s\r' '--- x')" safe
  # And the CRLF BLANK previous line: a lone `\r` is markdown-blank, so a rule under it is a
  # thematic break, not a heading promotion.
  _seam_case "CRLF blank line above --- is NOT a heading" "$(printf '\r')" "---" safe
  # AND THE SAME VERDICT UNDER AN EXPORTED FOREIGN LOCALE (Cybersec N-1, comment 21236). The
  # predicate now pins `local LC_ALL=C` like its fence sibling; without that pin the `[[:space:]]`
  # class is evaluated under the AMBIENT locale, and `---` followed by U+2028 or U+3000 flips from
  # safe to REFUSE. The production path never saw it (try_append_union sets the locale and bash
  # scopes that dynamically over the call), so ONLY a direct call can catch it -- which is exactly
  # what this file does, and what left the pin unmeasured until this case existed.
  seam_locale_ok=1
  for probe_locale in C.UTF-8 en_US.UTF-8; do
    for probe_u in "$(printf '%s\u2028' ---)" "$(printf '%s\u3000' ---)"; do
      if LC_ALL="$probe_locale" bash -c '
        source "$1" --selftest-noop 2>/dev/null || true
        _seam_makes_setext_heading "prozasor" "$2"' _ "${BASH_SOURCE[0]}" "$probe_u" 2>/dev/null; then
        seam_locale_ok=0
      fi
    done
  done
  n=$((n+1))
  if [ "$seam_locale_ok" = 1 ]; then
    echo "  ok   seam: a non-ASCII trailing space is safe under an EXPORTED locale too (pinned LC_ALL)"
  else
    echo "  FAIL seam: the verdict CHANGES with the ambient locale -- the predicate does not pin it"
    fail=1
  fi
  # Trailing spaces or tabs are permitted after the underline; other text is not.
  _seam_case "--- with trailing spaces is a heading"    "prozasor" "---  "   refuse
  _seam_case "--- with trailing text is NOT a heading"  "prozasor" "--- x"   safe

  # J-2: THE SEAM SWALLOWS THE OTHER SIDE INTO A CODE FENCE (Cybered, comment 20597). Everything up
  # to the junction leaves a fence open, so theirs' whole entry lands inside it: its `## ` header
  # stops being a header and stops being greppable, while every line is still present.
  setup_conflict junction-open-code-fence \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
\`\`\`bash
echo hello
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_refused "J-2: an unclosed code fence at the junction is refused"

  # ONE CASE PER FENCE SPELLING (Cybered R-1). The parity check used to be `grep -c '^```'`, which
  # is ONE spelling of a general property: measured on this same shape, an unclosed `~~~` and a
  # ```-fence indented two spaces both UNIONED and produced exactly the J-2 harm. Adding `~~~`
  # beside the backtick would have been the third rung of the ladder this card already climbed
  # twice, so the check became a fence-state scan instead -- and each spelling gets its own case,
  # because widening them as a block turns one case red and reads as coverage of all of them.
  setup_conflict junction-unclosed-tilde-fence \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
~~~bash
echo hello
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_refused "J-2: an unclosed ~~~ fence is refused too"

  setup_conflict junction-unclosed-indented-fence \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
  \`\`\`bash
echo hello
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_refused "J-2: an unclosed fence indented 2 spaces is refused"

  # PER-WIDTH, like the setext side already is (Cybersec F-3, comment 21120). The 2-space fixture
  # above pins ONE width, and a mutation map over the 61 cases showed what that costs: deleting the
  # 1-space branch of the fence indent strip left the suite GREEN, and so did deleting the 3-space
  # branch -- both silently, because the only indented-fence fixture used two spaces. The 3-space
  # mutant's harm is reachable end-to-end on the same fixture shape: theirs' whole entry lands
  # inside an open fence. The setext half was pinned at 1/2/3/4 from the start; this brings the
  # fence half to the same grain. Do NOT fold these into the 2-space case -- three separate
  # fixtures are what makes each branch individually load-bearing.
  setup_conflict junction-unclosed-1sp-fence \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
 \`\`\`bash
echo hello
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_refused "J-2: an unclosed fence indented 1 space is refused"

  setup_conflict junction-unclosed-3sp-fence \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
   \`\`\`bash
echo hello
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_refused "J-2: an unclosed fence indented 3 spaces is refused"

  # ...AND THE CONTROLS. Each closer form must still union, or "refuse on any fence character"
  # would pass every case above while breaking ordinary content.
  setup_conflict junction-closed-tilde-fence \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
~~~bash
echo hello
~~~
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_resolved_any "a CLOSED ~~~ fence still unions"

  setup_conflict junction-fence-closed-by-longer \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
\`\`\`bash
echo hello
\`\`\`\`\`
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_resolved_any "a fence closed by a LONGER run still unions"

  setup_conflict junction-tilde-not-closed-by-backtick \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
~~~bash
echo hello
\`\`\`
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_refused "a ~~~ fence is NOT closed by \`\`\` -- refused"

  setup_conflict junction-four-space-indent-not-a-fence \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
    \`\`\`bash
echo hello
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_resolved_any "four spaces is an indented block, not a fence -- unions"

  # THE TWO STRICTNESS RULES ON THE CLOSER, each pinned on its own. Both were unpinned in the first
  # version: mutating "closer must be at least as long" and "closer must have nothing after it" left
  # the whole selftest green, so the code was right and the tests were not watching. CommonMark says
  # a closing fence is at least as long as the opener and carries no info string; being lenient on
  # either would close a block the parser leaves OPEN, which is the fail-open direction.
  setup_conflict junction-closer-too-short \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
\`\`\`\`\`bash
echo hello
\`\`\`
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_refused "a SHORTER closing run does not close the fence -- refused"

  setup_conflict junction-closer-with-text \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
\`\`\`bash
echo hello
\`\`\` trailing
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_refused "a closing fence with trailing text does not close it -- refused"



  # ...AND THE CONTROL THAT KEEPS J-2 HONEST: a fence that ours CLOSES is ordinary content and must
  # still union. Without this, "refuse whenever a backtick appears" would pass the case above.
  setup_conflict junction-closed-code-fence \
    "## 2026-09-01 -- entry A
body of A
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
\`\`\`bash
echo hello
\`\`\`
" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-06 -- entry C (right)
jobb törzs
"
  t_resolved "a CLOSED code fence still unions -- the J-2 rule is about parity, not backticks" \
    "## 2026-09-01 -- entry A
body of A
## 2026-09-05 -- entry B (left)
\`\`\`bash
echo hello
\`\`\`
## 2026-09-06 -- entry C (right)
jobb törzs
"

  # THE PRICE OF THE DATED FORM, PINNED RATHER THAN DESCRIBED. A genuine append whose header is
  # undated is refused and falls to the caller's manual path. Measured before accepting it: every
  # header in marveen's DECISIONS.md (208 as of 2026-09-05) and CleanCore's (154) is dated, so this
  # costs nothing
  # today -- but it is a real behaviour change, and a behaviour change nobody tests is one the next
  # reader will "fix" back. NOTE that after CS-3 this case no longer documents the price of closing
  # anything: CS-2 is closed structurally now, so the date is the stricter of two equally safe
  # spellings. The case is kept because the refusal is still real and still surprises people.
  setup_conflict undated-header-append \
    "## 2026-01-01 -- entry A
" \
    "## 2026-01-01 -- entry A
## entry L (left, undated)
" \
    "## 2026-01-01 -- entry A
## entry R (right, undated)
"
  t_refused "an UNDATED header append is refused -- the price of the dated form"

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
  # THE SAME CONTENT WITH CRLF LINE ENDINGS (Cybered C-1, card bb52c2fa). The separator skip-list
  # matched `---` EXACTLY, so on a CRLF file the rule line is `---\r`, is not recognised, and
  # byte-identical content RESOLVED on LF while it was REFUSED on CRLF. Fail-closed, so nothing ever
  # merged wrongly -- but a refusal a user cannot reproduce on their own checkout is its own cost,
  # and this is the THIRD time this file has been bitten by two halves of one rule drifting (indent,
  # trailing whitespace, and now the line ending). The skip-list lives in `_is_blank_or_rule` now,
  # once, and both call sites go through it.
  setup_conflict separator-led-append-crlf \
    "$(printf '## entry A\r\nbody of A\r\n')" \
    "$(printf '## entry A\r\nbody of A\r\n\r\n---\r\n\r\n## 2026-01-02 -- bal oldali bejegyzes\r\n')" \
    "$(printf '## entry A\r\nbody of A\r\n\r\n---\r\n\r\n## 2026-01-03 -- jobb oldali bejegyzes\r\n')"
  t_resolved_any "a CRLF file gets the SAME verdict as the byte-identical LF one"

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

  # NOT A MERGE DRIVER, PINNED (Cybersec, card 3ae71df1). The guard near the top of this file is a
  # behaviour change -- direct execution used to exit 0 -- and an untested behaviour change is one
  # the next reader reverts. Three path arguments is the `merge.<name>.driver` convention (%O %A %B);
  # a driver that exits 0 tells git the merge succeeded, so git keeps ours and silently drops theirs.
  n=$((n+1))
  if bash "${BASH_SOURCE[0]}" /dev/null /dev/null /dev/null >/dev/null 2>&1; then
    echo "  FAIL invoked with three path args (merge-driver convention) it exited 0 -- git would"
    echo "       take ours and DISCARD theirs with no conflict and no message"
    fail=1
  else
    echo "  ok   invoked like a merge driver it refuses with a non-zero code"
  fi

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

  # THE SAME ANSWER UNDER AN EXPORTED LC_ALL (Cybered C-2, card bb52c2fa). The case above was green
  # only while LC_ALL happened to be UNSET in the runner's environment: exporting C, C.UTF-8,
  # en_US.UTF-8 or hu_HU.UTF-8 turned the whole suite 61/67, because `cmp`'s MESSAGE says "char" in
  # some locales and "byte" in others and the old parser only matched the word "byte". Any CI or
  # agent environment that exports LC_ALL got a FALSE RED on correct code.
  #
  # Asserting the VALUE under a foreign locale is what pins it. Asserting only that the suite passes
  # would not: the suite runs in ONE environment, which is exactly how this hid.
  local_indep_ok=1
  for probe_locale in C C.UTF-8 en_US.UTF-8; do
    probe_n="$(LC_ALL="$probe_locale" bash -c '
      source "$1" --selftest-noop 2>/dev/null || true
      _common_line_prefix_len "$2" "$3"' _ "${BASH_SOURCE[0]}" "$utf8_a" "$utf8_b" 2>/dev/null)"
    [ "$probe_n" = "$utf8_n" ] || local_indep_ok=0
  done
  n=$((n+1))
  if [ "$local_indep_ok" = 1 ]; then
    echo "  ok   the byte offset is the same under an EXPORTED LC_ALL (C / C.UTF-8 / en_US.UTF-8)"
  else
    echo "  FAIL the byte offset CHANGES with the ambient locale -- cmp's wording is being parsed"
    fail=1
  fi

  # ...AND THE SECOND `local LC_ALL=C`, WHICH THE ASSERTION ABOVE DOES NOT COVER (Cybered F-4,
  # comment 20514). There are TWO of them: one in _common_line_prefix_len, where `cmp`'s byte offset
  # is produced, and one in try_append_union, where that offset is USED to slice (`${ours:0:$n}`,
  # `${#prefix}`). The helper assertion above pins only the first. Verified by mutation before this
  # case was written: deleting the SECOND one leaves the whole selftest green at 19/19 -- a
  # load-bearing line with no coverage at all.
  #
  # END-TO-END, not a helper assertion, because that is where the second one lives. Without it the
  # slice counts CHARACTERS while the offset was counted in BYTES, so `prefix` runs PAST the true
  # common prefix into this side's own appended entry; the remainder then no longer starts at an
  # entry header and the union is REFUSED -- exactly the landing this card exists to unblock,
  # failing again for a reason nothing would have explained. The accented body has to be long
  # enough that the byte/character gap exceeds one line, or the truncate-to-newline step absorbs it
  # and the fixture goes green either way (two earlier attempts at a UTF-8 fixture died that way).
  utf8_body=""
  for _ in $(seq 1 200); do
    utf8_body+="Hosszú, ékezetes törzsszöveg: árvíztűrő tükörfúrógép, őúűéáí ÖÜÓŐÚÉÁŰÍ.
"
  done
  setup_conflict utf8-end-to-end \
    "## 2026-01-01 -- alap bejegyzés
${utf8_body}" \
    "## 2026-01-01 -- alap bejegyzés
${utf8_body}## 2026-01-02 -- bal oldali bejegyzés, ékezetekkel: őúű
" \
    "## 2026-01-01 -- alap bejegyzés
${utf8_body}## 2026-01-03 -- jobb oldali bejegyzés, ékezetekkel: ÁÉÍ
"
  t_resolved "UTF-8 end-to-end: the SLICING scope counts bytes too (Cybered F-4)" \
    "## 2026-01-01 -- alap bejegyzés
${utf8_body}## 2026-01-02 -- bal oldali bejegyzés, ékezetekkel: őúű
## 2026-01-03 -- jobb oldali bejegyzés, ékezetekkel: ÁÉÍ
"

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

  # Restore stdout, show everything the run printed, then let the OUTPUT have the last word.
  exec 1>&3 3>&-
  cat "$_selftest_log"
  if grep -q '^  FAIL' "$_selftest_log"; then
    [ "$fail" -eq 0 ] && echo "  (verdict forced to FAIL: a case printed a failure without setting the flag)"
    fail=1
  fi
  echo "selftest: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi
