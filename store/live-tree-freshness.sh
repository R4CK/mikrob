#!/usr/bin/env bash
# live-tree-freshness.sh -- is the tree you are about to SEARCH current, and search a ref if not.
#
# WHY THIS EXISTS
# ---------------
# Card 99fccbcf, from a measured false negative on 2026-09-04. I answered a "does anything call
# this?" question with a recursive grep over the live install (/home/neon/marveen) and got ZERO
# hits. The zero was wrong: the two files that call it existed on origin/develop but not yet in
# that tree, which was 12 commits behind at the time. `git grep origin/develop` gave the right
# answer immediately. A filesystem grep cannot tell "no caller" from "not checked out yet", and it
# fails toward the REASSURING answer, so it stays quiet -- including inside a gate verdict.
#
# The install is not chronically stale; it is INTERMITTENTLY stale, which is worse to reason about.
# store/marveen-land.sh already fast-forwards it after every landing (card 02f462e1). Measured over
# the 142 windows since that shipped: median 16.4 min / 3 commits behind, but 22 windows over an
# hour and 26 windows missing 5+ commits -- because a hand-landing that pushes directly, rather
# than through the lander, never calls sync_live_install. On 2026-09-04 alone the tree sat 17, 16,
# 15, 12 and 12 commits behind in separate windows.
#
# WHY A SCRIPT AND NOT A HOOK. A blocking PreToolUse hook was the first idea and the corpus killed
# it: of 4121 Bash calls in 20 hours, 15 were recursive searches rooted at the live checkout, all
# from one agent, and every one of them was looking for a file under store/ -- not one was a
# source-existence question. Native Grep/Glob calls against that path: zero. A guard there would
# have produced ~15 false positives a day and caught nothing. So this is a tool you call, not a
# gate that fires at you.
#
# USAGE
#   store/live-tree-freshness.sh [--repo <dir>] [--ref <ref>] [--fetch]
#   store/live-tree-freshness.sh --grep <pattern> [--repo <dir>] [--ref <ref>] [--fetch] [-- <pathspec>...]
#   store/live-tree-freshness.sh --selftest
#
# OUTPUT (first line is machine-readable)
#   FRESH <head>
#   BEHIND <n> <head>..<ref> oldest-missing=<iso>
#   DIVERGED ahead=<a> behind=<b> <head> <ref>
#   UNKNOWN:<reason>
# Exit (report mode):  0 fresh | 1 behind or diverged | 2 usage/error | 3 unknown
# Exit (--grep mode):  0 matches | 1 no match | 2 usage/error | 3 unknown (the search did NOT run)
#
# The exit-3 cases are what earn this script over a bare `git grep <ref>`. A search that could not
# RUN must not read as a search that found nothing -- the same false zero, one level down. Measured
# on git 2.x rather than assumed, because the two failures behave differently:
#
#   git grep <pat> origin/no-such-ref            -> "fatal: unable to resolve revision", exit 128
#   git grep <pat> origin/develop                -> honest no-match,                     exit 1
#   git grep <pat> origin/develop -- no/such.ts  -> PRINTS NOTHING,                      exit 1
#
# So the bad REF is already loud and needs no help; the bad PATHSPEC is the silent one, and it is
# the likelier mistake -- a path that was renamed, or typed from memory, in exactly the kind of
# "does anything still reference X?" search this script is for. Both are mapped to exit 3 here so a
# caller has one rule to follow: 3 means the answer is unknown, never "no".
#
# READ-ONLY: git plumbing only. Never checks out, merges, resets or writes. --fetch is the single
# network call and is opt-in, because the caller is usually inside a hook/gate budget.
#
# Ops-scripts rule: tracked + pushed; no secrets embedded.
set -uo pipefail

REPO="${MARVEEN_MAIN:-/home/neon/marveen}"
REF=""
DO_FETCH=0
MODE="report"
PATTERN=""
PATHSPEC=()

usage() { sed -n '35,45p' "$0" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)  REPO="${2:-}"; [ -n "$REPO" ] || usage; shift 2 ;;
    --ref)   REF="${2:-}"; [ -n "$REF" ] || usage; shift 2 ;;
    --fetch) DO_FETCH=1; shift ;;
    --grep)  MODE="grep"; PATTERN="${2:-}"; [ -n "$PATTERN" ] || usage; shift 2 ;;
    --selftest) MODE="selftest"; shift ;;
    --)      shift; PATHSPEC=("$@"); break ;;
    -h|--help) usage ;;
    *) echo "UNKNOWN:bad-argument-$1" >&2; usage ;;
  esac
done

g() { git -C "$REPO" "$@"; }

# Resolve the ref to compare against. Explicit --ref wins; otherwise the checked-out branch's own
# upstream; otherwise origin/develop. Deliberately NOT a bare "develop": the local branch ref is the
# very thing suspected of being stale, so comparing it to itself always says FRESH.
resolve_ref() {
  if [ -n "$REF" ]; then echo "$REF"; return 0; fi
  local up
  up="$(g rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  if [ -n "$up" ]; then echo "$up"; return 0; fi
  echo "origin/develop"
}

freshness() {
  [ -d "$REPO" ] || { echo "UNKNOWN:no-such-repo-dir"; return 3; }
  g rev-parse --git-dir >/dev/null 2>&1 || { echo "UNKNOWN:not-a-git-repo"; return 3; }
  [ "$DO_FETCH" -eq 1 ] && g fetch --quiet 2>/dev/null

  local ref head refsha
  ref="$(resolve_ref)"
  head="$(g rev-parse --short HEAD 2>/dev/null || true)"
  [ -n "$head" ] || { echo "UNKNOWN:no-head"; return 3; }
  refsha="$(g rev-parse --short --verify "$ref^{commit}" 2>/dev/null || true)"
  # A ref that does not resolve is the failure this script exists to make loud. Reporting FRESH
  # here -- "nothing is missing that I could see" -- would be the same reassuring lie one level up.
  [ -n "$refsha" ] || { echo "UNKNOWN:unresolvable-ref-$ref"; return 3; }

  local behind ahead
  behind="$(g rev-list --count "HEAD..$ref" 2>/dev/null || echo "")"
  ahead="$(g rev-list --count "$ref..HEAD" 2>/dev/null || echo "")"
  [ -n "$behind" ] && [ -n "$ahead" ] || { echo "UNKNOWN:count-failed"; return 3; }

  if [ "$behind" -eq 0 ] && [ "$ahead" -eq 0 ]; then echo "FRESH $head"; return 0; fi
  if [ "$ahead" -gt 0 ] && [ "$behind" -gt 0 ]; then
    echo "DIVERGED ahead=$ahead behind=$behind $head $refsha"; return 1
  fi
  if [ "$ahead" -gt 0 ]; then echo "FRESH $head"; return 0; fi   # ahead only: nothing is MISSING

  # The oldest missing commit's date is the number that makes the lag legible: "12 commits" says
  # little, "oldest missing landed 61 minutes ago" says whether your zero is trustworthy.
  local oldest
  oldest="$(g log --reverse --format=%cI "HEAD..$ref" 2>/dev/null | head -1)"
  echo "BEHIND $behind $head..$refsha oldest-missing=${oldest:-unknown}"
  return 1
}

do_grep() {
  local line rc ref
  line="$(freshness)"; rc=$?
  echo "$line"
  [ $rc -eq 3 ] && return 3
  ref="$(resolve_ref)"
  # Resolved once more HERE rather than trusted from freshness(): between the two calls is exactly
  # where a "checked it earlier" assumption goes stale, and the cost is one rev-parse.
  g rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 || {
    echo "UNKNOWN:unresolvable-ref-$ref"; return 3; }
  if [ ${#PATHSPEC[@]} -gt 0 ]; then
    # A pathspec matching NO tracked file at the ref is the silent false zero measured above: git
    # prints nothing and exits 1, the same as an honest no-match. Refuse instead of answering "no"
    # to a question that was never actually asked of any file.
    if [ -z "$(g ls-tree -r --name-only "$ref" -- "${PATHSPEC[@]}" 2>/dev/null | head -1)" ]; then
      echo "UNKNOWN:pathspec-matches-nothing-at-$ref:${PATHSPEC[*]}"
      return 3
    fi
    g grep -n -e "$PATTERN" "$ref" -- "${PATHSPEC[@]}"
  else
    g grep -n -e "$PATTERN" "$ref"
  fi
  return $?
}

case "$MODE" in
  report) freshness; exit $? ;;
  grep)   do_grep;   exit $? ;;
  selftest)
    exec "$(dirname "$0")/live-tree-freshness.selftest.sh" ;;
esac
