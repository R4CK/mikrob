#!/usr/bin/env bash
# gate-sha-repo.sh -- answer "which repo is this Gate-SHA in?" by LOOKUP, not by declaration.
#
# WHY THIS EXISTS, and why it is not the `Gate-repo:` field card edd4c3bf originally scoped.
#
# The incident (2026-09-04, card a3b4e0f4): the marveen commit a2efe5ff looked "lost" because it was
# searched for in CleanCore's object database. The card's proposed fix was a MANDATORY, script-read
# `Gate-repo:` line in every REVIEW. Measured before building it, which the card asked for:
#
#   - 1019 REVIEW comments carry a `Gate-SHA:`. THIRTEEN carry an explicit `Gate-repo:`, and 36 carry
#     a `repo:` block. 983 carry NEITHER. A newly mandated field starts life absent from 96.5% of the
#     corpus, so every consumer needs the fallback path anyway -- and the fallback is what gets used.
#   - gate-pretriage-card.sh, the one script that actually resolves a sha, ALREADY probes both clones
#     with `cat-file -e` and takes whichever answers. It never needed the field.
#   - Ambiguity is the only thing a declaration could settle that a lookup cannot. Measured across all
#     1076 distinct Gate-SHAs ever posted: 590 resolve in marveen, 481 in CleanCore, 5 in neither
#     (unlanded or pruned), and ZERO in both. Abbreviated shas are 7+ hex; two unrelated repos
#     colliding is vanishingly unlikely, and it has never happened here.
#
# So the failure was never in the SCRIPT path -- it was an agent looking in one repo and concluding
# the commit did not exist. That is what this fixes, retroactively, for all 1076 existing shas and
# without asking anyone to write a new line: ask, do not guess.
#
# An explicit `Gate-repo:` is still HONOURED when present (see --check), because an author who states
# it should be told when they are wrong. It is a cross-check, not the mechanism.
#
# USAGE:
#   gate-sha-repo.sh <sha>              # prints: marveen | cleancore | unlanded
#   gate-sha-repo.sh <sha> --path       # prints the clone path instead of the name
#   gate-sha-repo.sh <sha> --check <declared>   # compares a declared repo against the lookup;
#                                               # exit 1 and a loud line if they disagree
#   gate-sha-repo.sh --selftest
#
# EXIT: 0 resolved (or agreed) | 1 declared/actual mismatch | 3 not found in any clone | 2 usage
set -uo pipefail

MARVEEN_REPO="${MARVEEN_MAIN:-/home/neon/marveen}"
CLEANCORE_REPO="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"

die() { echo "gate-sha-repo: $2" >&2; exit "$1"; }

# Normalise the many shapes a repo gets named in: a git URL, a bare name, a path. Measured on the
# real corpus -- the `repo:` blocks in existing REVIEWs carry all three
# (git@github.com:R4CK/mikrob.git, marveen, git@github.com:R4CK/CleanCore.git), so a comparison that
# only understood one of them would report false mismatches on honest reviews.
normalise_repo() {
  local raw; raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    *cleancore*) echo cleancore ;;
    *mikrob*|*marveen*) echo marveen ;;
    *) echo "$raw" ;;
  esac
}

lookup() {
  local sha="$1"
  # Order is irrelevant to correctness (ambiguity is measured at zero), so it is chosen for cost:
  # marveen is the local, warm clone. A caller that needs BOTH answers should call twice.
  if git -C "$MARVEEN_REPO" cat-file -e "${sha}^{commit}" 2>/dev/null; then echo marveen; return 0; fi
  if git -C "$CLEANCORE_REPO" cat-file -e "${sha}^{commit}" 2>/dev/null; then echo cleancore; return 0; fi
  echo unlanded; return 3
}

path_of() {
  case "$1" in
    marveen) echo "$MARVEEN_REPO" ;;
    cleancore) echo "$CLEANCORE_REPO" ;;
    *) echo "" ;;
  esac
}

selftest() {
  local fails=0 n=0
  t() { # t <label> <expected> <actual>
    n=$((n + 1))
    if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: expected '$2', got '$3'"; fails=$((fails + 1)); fi
  }
  # normalise_repo covers every shape measured in the real corpus, plus the bare owner/repo form the
  # card proposed for the field itself.
  t "url form, fork"        marveen   "$(normalise_repo 'git@github.com:R4CK/mikrob.git')"
  t "url form, cleancore"   cleancore "$(normalise_repo 'git@github.com:R4CK/CleanCore.git')"
  t "bare name"             marveen   "$(normalise_repo 'marveen')"
  t "owner/repo form"       marveen   "$(normalise_repo 'R4CK/mikrob')"
  t "owner/repo, cleancore" cleancore "$(normalise_repo 'R4CK/CleanCore')"
  t "case insensitive"      cleancore "$(normalise_repo 'CLEANCORE')"
  t "unknown passes through" 'whatever' "$(normalise_repo 'whatever')"
  # A sha that cannot exist must report unlanded rather than defaulting to a repo -- the whole point
  # is to stop guessing, and a confident wrong answer is worse than "not here".
  t "impossible sha"        unlanded  "$(lookup 0000000000000000000000000000000000000000)"
  t "path of marveen"       "$MARVEEN_REPO"   "$(path_of marveen)"
  t "path of cleancore"     "$CLEANCORE_REPO" "$(path_of cleancore)"
  echo "gate-sha-repo selftest: $((n - fails))/$n passed"
  [ "$fails" -eq 0 ] || return 1
}

[ $# -ge 1 ] || die 2 "usage: gate-sha-repo.sh <sha> [--path | --check <declared>] | --selftest"

if [ "$1" = "--selftest" ]; then selftest; exit $?; fi

SHA="$1"; shift
case "$SHA" in
  *[!0-9a-fA-F]*|'') die 2 "'$SHA' is not a hex sha" ;;
esac
[ "${#SHA}" -ge 7 ] || die 2 "'$SHA' is shorter than 7 hex chars; git itself would call it ambiguous"

FOUND="$(lookup "$SHA")"; RC=$?

case "${1:-}" in
  --path)
    [ "$RC" -eq 0 ] || die 3 "$SHA is in neither clone (unlanded branch, or pruned)"
    path_of "$FOUND"
    ;;
  --check)
    [ $# -ge 2 ] || die 2 "--check needs the declared repo"
    DECL="$(normalise_repo "$2")"
    if [ "$RC" -ne 0 ]; then
      echo "UNRESOLVED: $SHA is in neither clone; the declared '$2' cannot be confirmed" >&2
      exit 3
    fi
    if [ "$DECL" = "$FOUND" ]; then
      echo "AGREE|$FOUND"
    else
      echo "MISMATCH|declared=$DECL|actual=$FOUND -- the REVIEW names the wrong repo for $SHA" >&2
      exit 1
    fi
    ;;
  '')
    echo "$FOUND"
    [ "$RC" -eq 0 ] || exit 3
    ;;
  *) die 2 "unknown option '${1}'" ;;
esac
