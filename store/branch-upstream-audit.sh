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
#   store/branch-upstream-audit.sh --fix [repo]  # same; order does not matter
#   store/branch-upstream-audit.sh selftest      # sandboxed self-test, touches no real repo
#
# Exit: 0 clean (or every requested fix succeeded) | 1 problems found / a fix failed | 2 bad usage
set -uo pipefail

# Overridable ONLY so the selftest can prove the "wrong repo" class without pointing a writing tool
# at the shared checkout. Plain runs are unaffected.
DEFAULT_REPO="${BRANCH_AUDIT_DEFAULT_REPO:-/mnt/h/LM_Studio_Workdir/CleanCore}"

# ARGUMENT PARSING (Cybered NO-GO on 7021f00, finding 1 -- this was the blocker).
# The previous three lines were order-dependent: `--fix <repo>` set REPO back to the DEFAULT and then
# never read $2, so the tool fixed the shared CleanCore checkout while printing the branch names of
# the repo the operator had named, and exited 0. That is this card's own trap one level up -- the
# script exists because a measurement answered confidently against the wrong ref, and the writing
# version of it wrote confidently to the wrong repo. Anything unrecognised or contradictory now
# exits 2 instead of being silently reinterpreted.
if [ "${1:-}" = "selftest" ]; then
  # Sandboxed: builds its own repos in a temp dir and points DEFAULT_REPO at one of them, so the
  # "wrong repo" cases can be proven without a writing tool ever being aimed at a real checkout.
  sandbox="$(mktemp -d)"
  trap 'rm -rf "$sandbox"' EXIT
  st_fail=0
  mk() { # $1 = name -> a repo with branch `feat` whose upstream is wrongly origin/main
    local d="$sandbox/$1"
    git init -q "$d" && git -C "$d" -c user.email=a@b -c user.name=t commit -q --allow-empty -m init
    git -C "$d" branch -q -M main
    git init -q --bare "$sandbox/$1.git"
    git -C "$d" remote add origin "$sandbox/$1.git"
    git -C "$d" push -q origin main
    git -C "$d" branch -q feat
    git -C "$d" branch -q --set-upstream-to=origin/main feat
  }
  up() { git -C "$sandbox/$1" for-each-ref --format='%(upstream:short)' "refs/heads/$2"; }
  chk() { # label, expected, actual
    if [ "$2" = "$3" ]; then echo "  ok   $1"
    else echo "  FAIL $1 -> got '$3', expected '$2'"; st_fail=1; fi
  }
  echo "branch-upstream-audit selftest"
  mk A; mk B

  # THE BLOCKER (Cybered W2): `--fix <repoB>` must fix B and must NOT touch the default repo A.
  BRANCH_AUDIT_DEFAULT_REPO="$sandbox/A" bash "${BASH_SOURCE[0]}" --fix "$sandbox/B" >/dev/null 2>&1
  chk "--fix <repo> fixes the NAMED repo"        ""            "$(up B feat)"
  chk "--fix <repo> leaves the DEFAULT untouched" "origin/main" "$(up A feat)"

  # The documented order must keep working, and a bare --fix must still mean the default.
  mk C; BRANCH_AUDIT_DEFAULT_REPO="$sandbox/A" bash "${BASH_SOURCE[0]}" "$sandbox/C" --fix >/dev/null 2>&1
  chk "<repo> --fix still works"                  ""            "$(up C feat)"
  BRANCH_AUDIT_DEFAULT_REPO="$sandbox/A" bash "${BASH_SOURCE[0]}" --fix >/dev/null 2>&1
  chk "bare --fix targets the default"            ""            "$(up A feat)"

  # Contradictory / unknown input must stop, not be silently reinterpreted.
  bash "${BASH_SOURCE[0]}" "$sandbox/A" "$sandbox/B" >/dev/null 2>&1
  chk "two repos -> exit 2"                       "2"           "$?"
  bash "${BASH_SOURCE[0]}" --wat >/dev/null 2>&1
  chk "unknown option -> exit 2"                  "2"           "$?"

  # F1: a branch tracking a real non-origin remote is reported, never unset.
  mk D
  git init -q --bare "$sandbox/D-up.git"
  git -C "$sandbox/D" remote add upstream "$sandbox/D-up.git"
  git -C "$sandbox/D" push -q upstream main
  git -C "$sandbox/D" branch -q --set-upstream-to=upstream/main feat
  BRANCH_AUDIT_DEFAULT_REPO="$sandbox/A" bash "${BASH_SOURCE[0]}" --fix "$sandbox/D" >/dev/null 2>&1
  chk "non-origin upstream survives --fix"        "upstream/main" "$(up D feat)"

  # F2: when git cannot write, the run must NOT report success.
  mk E
  chmod 500 "$sandbox/E/.git"
  BRANCH_AUDIT_DEFAULT_REPO="$sandbox/A" bash "${BASH_SOURCE[0]}" --fix "$sandbox/E" >/dev/null 2>&1
  chk "unwritable repo -> exit 1, not 0"          "1"           "$?"
  chmod 700 "$sandbox/E/.git"

  [ "$st_fail" -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
fi

REPO=""
FIX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fix) FIX=1; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "unknown option: $1" >&2; exit 2 ;;
    *)
      [ -n "$REPO" ] && { echo "more than one repo given: '$REPO' and '$1'" >&2; exit 2; }
      REPO="$1"; shift ;;
  esac
done
REPO="${REPO:-$DEFAULT_REPO}"
[ -d "$REPO/.git" ] || { echo "not a git checkout: $REPO" >&2; exit 2; }
# Say which repo is about to be touched. A writing tool that does not name its target is how the
# operator ends up reading a success line about a repo the run never opened.
[ "$FIX" -eq 1 ] && echo "repo: $REPO (--fix: WILL WRITE)" || echo "repo: $REPO (report only)"

# Apply one fix and ACCOUNT FOR IT (Cybered finding F2). The old form was
# `[ FIX ] && git ... >/dev/null 2>&1 && echo FIXED`: when git failed, the FIXED line simply did not
# appear, git's reason was discarded, and the run still exited 0. A fixing run that fixed nothing
# looked like a successful one. Now the failure is printed WITH git's own message and counted, and
# the exit code depends on the count.
fixed=0
failed=0
apply() { # $1.. = git args after `git -C $REPO`, then the success line as the last argument
  local ok_msg="${*: -1}" err
  set -- "${@:1:$#-1}"
  if err="$(git -C "$REPO" "$@" 2>&1)"; then
    echo "         $ok_msg"; fixed=$((fixed + 1))
  else
    echo "         FIX FAILED: ${err:-git exited non-zero with no message}"; failed=$((failed + 1))
  fi
}

problems=0
noted=0
while IFS=$'\t' read -r branch upstream; do
  [ -n "$branch" ] || continue
  want="origin/$branch"
  # No upstream at all is HONEST: `@{u}` errors instead of answering against the wrong ref.
  [ -z "$upstream" ] && continue
  [ "$upstream" = "$want" ] && continue

  # A branch deliberately tracking ANOTHER REMOTE is not this defect (Cybered finding F1). This repo
  # has five remotes, one of them a genuine `upstream` (Szotasz/marveen) plus contributor forks, and
  # `want=origin/$branch` called every one of those WRONG -- then --fix unset them, destroying the
  # fork link with no warning, while reporting "never leave it on main" about a branch that was not
  # on main. Zero such branches exist today in either repo, so this was latent, not live; the script
  # takes a repo argument, so it only stays latent until someone points it somewhere else.
  # Reported, never touched, and NOT counted as a problem: tracking upstream/main on purpose gives
  # `@{u}` the ref its author meant, which is the opposite of a mis-measurement.
  remote="${upstream%%/*}"
  if [ "$remote" != "origin" ] && git -C "$REPO" remote get-url "$remote" >/dev/null 2>&1; then
    echo "NOTE   $branch"
    echo "         upstream=$upstream  tracks the '$remote' remote, not origin -- left alone."
    echo "         Deliberate (fork/upstream tracking)? Then this is correct. If not, repoint it by hand."
    noted=$((noted + 1))
    continue
  fi

  problems=$((problems + 1))
  if git -C "$REPO" rev-parse --verify -q "$want" >/dev/null; then
    echo "WRONG  $branch"
    echo "         upstream=$upstream  but $want exists -> repoint"
    [ "$FIX" -eq 1 ] && apply branch --set-upstream-to="$want" "$branch" "FIXED -> $want"
  else
    echo "WRONG  $branch"
    echo "         upstream=$upstream  and $want does NOT exist -> unset"
    [ "$FIX" -eq 1 ] && apply branch --unset-upstream "$branch" \
      "FIXED -> no upstream (@{u} now errors instead of lying)"
  fi
done < <(git -C "$REPO" for-each-ref --format='%(refname:short)%09%(upstream:short)' refs/heads)

total="$(git -C "$REPO" for-each-ref --format='x' refs/heads | wc -l)"
[ "$noted" -gt 0 ] && echo "$noted branch(es) track a non-origin remote and were left alone (see NOTE above)."
if [ "$problems" -eq 0 ]; then
  echo "OK: all $total local branches track their own remote branch, or nothing at all."
  exit 0
fi
echo "$problems of $total local branches had a misdirected upstream."
if [ "$FIX" -eq 1 ]; then
  echo "fixed=$fixed failed=$failed"
  [ "$failed" -eq 0 ] && exit 0
  echo "$failed fix(es) FAILED -- the repo is NOT in the reported state." >&2
  exit 1
fi
exit 1
