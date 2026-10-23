#!/usr/bin/env bash
# overlap-signal-check.sh -- warn an agent, BEFORE it posts REVIEW, that another unlanded
# agent/*/work or card/* branch touches the SAME function in a file it also touched (card
# ca72e5d4, Trail-otlet 1 -- idea adopted from trailhq/Trail-Code, MIT, no install, per MikroB
# elemzes 11529).
#
# Signal only, never blocks (switch: OVERLAP_SIGNAL=off). Exit code is always 0 unless a real
# tool failure happens (missing worktree, git error) -- an overlap finding is reported on stdout,
# not via a non-zero exit, so a caller that greps the output cannot be accidentally treated as a
# CI gate.
#
# HOW IT FINDS "THE SAME FUNCTION" WITHOUT PARSING ANY LANGUAGE ITSELF: git's own diff hunk
# header already carries the enclosing-function context line (`@@ -a,b +c,d @@ <context>`), via
# git's built-in funcname heuristics (xfuncname patterns for python/etc, a sane default fallback
# for everything else, including bash and ts/js in this repo). Two branches that changed the SAME
# file and produced a hunk whose CONTEXT LINE IS IDENTICAL changed the same enclosing symbol with
# very high probability -- comparing that string is cheaper and more honest than a bespoke regex
# per language, and it is exactly what the hunk header is for.
#
# Usage: overlap-signal-check.sh <agent>
#   <agent>'s OWN worktree (store/agent-worktree-marveen.sh <agent> --path) is compared, including
#   uncommitted changes, against every OTHER unlanded origin/agent/*/work and origin/card/* branch.
set -uo pipefail

AGENT="${1:-}"
[ -n "$AGENT" ] || { echo "usage: overlap-signal-check.sh <agent>" >&2; exit 2; }

if [ "${OVERLAP_SIGNAL:-on}" = off ]; then
  echo "overlap-signal-check: OVERLAP_SIGNAL=off -- skipped"
  exit 0
fi

MV="${MARVEEN_MAIN:-/home/neon/marveen}"
API="${DASHBOARD_URL:-http://localhost:3420}"

# Hunk context lines for a diff <base>..<ref> (or <base>..worktree with ref="") restricted to one
# file -- trimmed, deduped, blank context (no funcname found) dropped since an empty string would
# falsely "match" every other empty-context hunk.
hunk_contexts() { # <dir> <base> <ref-or-empty-for-worktree> <file>
  local dir="$1" base="$2" ref="$3" file="$4"
  if [ -n "$ref" ]; then
    git -C "$dir" diff --unified=0 "$base" "$ref" -- "$file" 2>/dev/null
  else
    git -C "$dir" diff --unified=0 "$base" -- "$file" 2>/dev/null
  fi | grep -E '^@@ .* @@.+' | sed -E 's/^@@ [^@]*@@[[:space:]]*//' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | grep -v '^$' | sort -u
}

changed_files() { # <dir> <base> <ref-or-empty-for-worktree>
  local dir="$1" base="$2" ref="$3"
  if [ -n "$ref" ]; then
    git -C "$dir" diff --name-only "$base" "$ref" 2>/dev/null
  else
    { git -C "$dir" diff --name-only "$base" 2>/dev/null; git -C "$dir" status --porcelain --no-renames 2>/dev/null | awk '{print $2}'; } | sort -u
  fi
}

card_for_branch() { # <branch-short-name, e.g. agent/backend/work or card/ab12cd34>
  case "$1" in
    card/*) echo "${1#card/}" ;;
    *) echo "" ;;
  esac
}

own_dir=$(bash "$MV/store/agent-worktree-marveen.sh" "$AGENT" --path 2>/dev/null)
[ -n "$own_dir" ] && [ -d "$own_dir" ] || { echo "overlap-signal-check: no worktree for $AGENT, skipped" >&2; exit 0; }

git -C "$own_dir" fetch origin --prune --quiet 2>/dev/null
own_base=$(git -C "$own_dir" merge-base HEAD origin/develop 2>/dev/null)
[ -n "$own_base" ] || { echo "overlap-signal-check: cannot resolve merge-base for $AGENT, skipped" >&2; exit 0; }

own_files=$(changed_files "$own_dir" "$own_base" "")
own_branch="origin/agent/$AGENT/work"

found=0
while read -r branch; do
  [ -n "$branch" ] || continue
  [ "$branch" = "$own_branch" ] && continue

  dir="$own_dir"  # read via the ref object, no need for the OTHER agent's worktree to exist
  base_b=$(git -C "$dir" merge-base "$branch" origin/develop 2>/dev/null)
  [ -n "$base_b" ] || continue
  files_b=$(git -C "$dir" diff --name-only "$base_b" "$branch" 2>/dev/null)
  [ -n "$files_b" ] || continue

  shared_files=$(comm -12 <(echo "$own_files" | sort -u) <(echo "$files_b" | sort -u))
  [ -n "$shared_files" ] || continue

  while read -r f; do
    [ -n "$f" ] || continue
    own_ctx=$(hunk_contexts "$own_dir" "$own_base" "" "$f")
    other_ctx=$(hunk_contexts "$dir" "$base_b" "$branch" "$f")
    [ -n "$own_ctx" ] && [ -n "$other_ctx" ] || continue
    shared_ctx=$(comm -12 <(echo "$own_ctx" | sort -u) <(echo "$other_ctx" | sort -u))
    [ -n "$shared_ctx" ] || continue
    found=1
    cid=$(card_for_branch "${branch#origin/}")
    while read -r sym; do
      [ -n "$sym" ] || continue
      if [ -n "$cid" ]; then
        echo "OVERLAP file=$f symbol=\"$sym\" other_branch=${branch#origin/} other_card=$cid"
      else
        echo "OVERLAP file=$f symbol=\"$sym\" other_branch=${branch#origin/} other_agent=$(echo "${branch#origin/agent/}" | cut -d/ -f1)"
      fi
    done <<< "$shared_ctx"
  done <<< "$shared_files"
done < <(git -C "$own_dir" for-each-ref --format='%(refname:short)' refs/remotes/origin --no-merged origin/develop 2>/dev/null | grep -E '^origin/(agent/|card/)')

if [ "$found" = 0 ]; then
  echo "overlap-signal-check: no overlap found for $AGENT against other unlanded branches"
fi
exit 0
