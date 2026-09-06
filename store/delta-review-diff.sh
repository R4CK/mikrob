#!/usr/bin/env bash
# delta-review-diff.sh -- the FULL changed-file list between two shas for a delta-gate review.
#
# WHY THIS EXISTS (card c266ec74, Cybered's finding off the a37bb36d landing, komment 24334). A
# delta-review (re-verifying a fix after a NO-GO) needs to see EVERY file that changed between the
# previously-reviewed sha and the fix -- not just the card's own listed files. QA2's delta-diff on
# efaf8926 was scoped to `-- src/`, and the two stowaway commits (16fcee57, 6193ef7c) that rode along
# on the same branch were entirely under store/, so that diff never saw them: the delta-review passed
# a landing that, unknown to the reviewer, also shipped two OTHER cards' work -- one of them a live,
# not-yet-fixed Cybered NO-GO (82fa48b0) that then sat on develop for ~33 minutes.
#
# THIS SCRIPT TAKES NO PATHSPEC, ON PURPOSE, AND NEVER WILL. A narrowed diff is exactly the shape of
# the defect: it looks complete and is not. If a future call genuinely needs to narrow the range,
# that has to be an explicit, stated decision on that card -- not the accidental default of typing
# the one directory most card work happens to live in.
#
# Usage: delta-review-diff.sh <old-sha> <new-sha> [repo-dir]
#   old-sha   the sha a prior gate verdict actually judged (e.g. the NO-GO's Gate-SHA)
#   new-sha   the fix being re-verified
#   repo-dir  default "." -- pass the gate's own disposable worktree (see the
#             gate-worktree-pattern skill), never a shared checkout another agent may be using
set -euo pipefail

usage() { echo "usage: delta-review-diff.sh <old-sha> <new-sha> [repo-dir]" >&2; exit 2; }

OLD="${1:-}"; NEW="${2:-}"; REPO="${3:-.}"
[ -n "$OLD" ] && [ -n "$NEW" ] || usage

git -C "$REPO" rev-parse --verify --quiet "$OLD^{commit}" >/dev/null || { echo "delta-review-diff.sh: not a commit: $OLD" >&2; exit 2; }
git -C "$REPO" rev-parse --verify --quiet "$NEW^{commit}" >/dev/null || { echo "delta-review-diff.sh: not a commit: $NEW" >&2; exit 2; }

# No pathspec after `--`, and no `--`: the header above is the reason. --name-only only, not full
# patches -- the caller decides which of the listed files are worth reading in full.
git -C "$REPO" diff --name-only "$OLD" "$NEW"
