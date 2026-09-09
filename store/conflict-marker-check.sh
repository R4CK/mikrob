#!/usr/bin/env bash
# conflict-marker-check.sh -- refuse to push unresolved merge-conflict markers (card 4b4c89eb,
# Cybered measurement off incident bb52c2fa/24405).
#
# Sourced by BOTH store/cleancore-land.sh and store/marveen-land.sh, verbatim, for the same reason
# decisions-append-union.sh and landing-downward-check.sh are: two copies of a landing precondition
# drift, and the half that drifts is the half nobody is looking at.
#
# THE INCIDENT. The 3af9d833 landing pushed 6 conflict-marker lines (<<<<<<</=======/>>>>>>>) into
# DECISIONS.md on develop. It was not the conflict-resolver's fault: the landing chain's git
# add/commit sequence around the resolver was never &&-bound to the resolver's exit code, and nothing
# ELSE inspected the merge RESULT before push. The full suite ran GREEN on the marker-carrying tip --
# no test in the suite uses a runtime-generated fixture for this shape, so nothing caught it
# structurally. Cybered pre-measured both directions: this exact check gives 4 hits on the
# marker-carrying sha and ZERO on a clean develop -- no false positive on the real repo.
#
# ONLY THE TWO UNAMBIGUOUS MARKERS ARE CHECKED. `=======` alone is a legitimate line in real content
# (a markdown Setext heading underline, for one, and a plain visual separator in plenty of plaintext
# docs) -- including it would produce false refusals on ordinary files. `<<<<<<< ` and `>>>>>>> `
# (WITH the trailing space git always appends before the ref/label) are never legitimate outside an
# unresolved conflict.
set -uo pipefail

# Pure text filter, no git involved -- reads full file content (or a git-grep-shaped stream) on
# stdin, prints only the conflict-marker lines. Separated from find_conflict_markers below so the
# discriminating logic (which two patterns, anchored how) is unit-testable without a real repo.
conflict_marker_lines() {
  grep -n -e '^<<<<<<< ' -e '^>>>>>>> '
}

# The production check: everything TRACKED at HEAD in the given repo/worktree, scanned for
# conflict-marker lines. `git grep`, not a plain `grep -r`, so it stays scoped to tracked content and
# reads the SAME tree that is about to be pushed (HEAD), not whatever happens to sit on disk.
# Empty output means clean. Non-empty output is grep's own `file:line:content` -- printable as-is.
find_conflict_markers() {
  local repo="$1"
  git -C "$repo" grep -n -e '^<<<<<<< ' -e '^>>>>>>> ' HEAD -- . 2>/dev/null
}

# Shared selftest cases (same convention as downward_selftest_cases in landing-downward-check.sh):
# the CALLER defines t()/n/fail before calling this, so both landers' --selftest blocks exercise the
# identical cases rather than each hand-rolling its own and drifting apart.
conflict_marker_selftest_cases() {
  t "finds a <<<<<<< marker line" \
    "$(printf '<<<<<<< HEAD\nours\n' | conflict_marker_lines | wc -l)" "1"
  t "finds a >>>>>>> marker line" \
    "$(printf 'theirs\n>>>>>>> some-branch\n' | conflict_marker_lines | wc -l)" "1"
  t "finds BOTH markers in a real conflict block" \
    "$(printf '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> some-branch\n' | conflict_marker_lines | wc -l)" "2"
  # THE FALSE-POSITIVE GUARD, the reason `=======` is deliberately excluded: a markdown Setext
  # heading underline is legitimate content, not a conflict remnant.
  t "a lone ======= line (markdown Setext heading) is NOT flagged" \
    "$(printf 'Some Heading\n=======\n\nbody text\n' | conflict_marker_lines | wc -l)" "0"
  t "ordinary content has nothing to find" \
    "$(printf 'nothing unusual here\n' | conflict_marker_lines | wc -l)" "0"
  # Anchoring: the marker must be at the START of the line, with the trailing space git always
  # writes before the ref/label -- a mid-line mention (e.g. quoted in a comment or doc) is prose
  # about conflict markers, not one, and must not trip the check.
  t "a mid-line mention of the marker text is NOT flagged (anchored to line-start)" \
    "$(printf '# example: a line starting with <<<<<<< HEAD marks a conflict\n' | conflict_marker_lines | wc -l)" "0"
  t "a marker with no trailing space is NOT flagged (git always writes one before the label)" \
    "$(printf '<<<<<<<\n>>>>>>>\n' | conflict_marker_lines | wc -l)" "0"
}
