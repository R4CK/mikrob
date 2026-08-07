#!/usr/bin/env bash
# fix-landed-check.sh -- did that "finished" fix actually reach the ground?
#
# WHY THIS EXISTS
# ---------------
# On 2026-08-06 the same defect class was flagged on three separate cards in one
# afternoon: the fix was written, tested and gate-passed, but lived only on a
# feature branch. It was not in the integration branch, not in the live install's
# HEAD tree, and in one case the file was not even on disk (the store/ scripts
# vanished during a detached-HEAD rollback window). Each card read as DONE.
#
# The worst instance was the rollback guard itself -- the protection against a
# recurring incident existed only on paper. "Committed" is not "landed", and a
# green gate says nothing about which tree the code is sitting in.
#
# This script answers the question the card status cannot: for a given commit,
# is it merged, deployed, present on disk, and built?
#
# It is strictly READ-ONLY: git plumbing, a read-only SQLite open, and stat.
# It never merges, checks out, restarts, or writes anything.
#
# USAGE
#   store/fix-landed-check.sh --commit <sha> [--ref origin/develop] [--install <dir>]
#   store/fix-landed-check.sh --sweep [--limit N] [--status waiting,done]
#   store/fix-landed-check.sh --selftest
#
# OUTPUT (first line is machine-readable)
#   LANDED <short-sha>
#   NOT-LANDED <short-sha> <reason>[,<reason>...]
#   UNKNOWN <short-sha> <what-could-not-be-checked>
#   ERROR:<why>
# Reasons: missing-commit, not-merged, not-deployed, files-missing, stale-build
# Unknowns: merge-unverifiable, deploy-unverifiable, build-unverifiable
# Exit: 0 landed | 1 not landed | 2 error/usage | 3 unknown
#
# UNKNOWN exists because a check that could not RUN is not a check that PASSED.
# A missing origin/develop ref (fresh clone, never fetched) or a missing
# dist/.built-commit used to be a footnote while the verdict stayed LANDED --
# a landed-checker that says LANDED by mistake is worse than none.
#
# Env: LANDED_CHECK_REF (default origin/develop), LANDED_CHECK_INSTALL

set -uo pipefail

REF="${LANDED_CHECK_REF:-origin/develop}"
INSTALL=""
MODE=""
COMMIT=""
SWEEP_LIMIT=40
SWEEP_STATUS="waiting,done"

# `shift 2` on a flag whose value is missing fails without consuming anything,
# which spins this loop forever. Every value-taking flag checks for its argument
# first and exits instead.
_need_value() { [ "$1" -ge 2 ] || { echo "ERROR:missing-value-for:$2"; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --commit) _need_value $# "$1"; MODE="commit"; COMMIT="$2"; shift 2 ;;
    --ref) _need_value $# "$1"; REF="$2"; shift 2 ;;
    --install) _need_value $# "$1"; INSTALL="$2"; shift 2 ;;
    --sweep) MODE="sweep"; shift ;;
    --limit) _need_value $# "$1"; SWEEP_LIMIT="$2"; shift 2 ;;
    --status) _need_value $# "$1"; SWEEP_STATUS="$2"; shift 2 ;;
    --selftest) MODE="selftest"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR:unknown-argument:$1"; exit 2 ;;
  esac
done

# A non-numeric or zero limit used to make `[ "$total" -lt "$SWEEP_LIMIT" ]` error
# to stderr and evaluate false, so the loop exited immediately and the sweep
# reported `checked=0 not-landed=0` with exit 0 -- a mistyped parameter read as
# "everything landed".
case "$SWEEP_LIMIT" in ''|*[!0-9]*) echo "ERROR:invalid-limit:$SWEEP_LIMIT"; exit 2 ;; esac
[ "$SWEEP_LIMIT" -gt 0 ] || { echo "ERROR:invalid-limit:$SWEEP_LIMIT"; exit 2; }

# The live install is the MAIN worktree, not whichever worktree this script runs
# from -- checking a feature worktree against itself would always say "deployed"
# and hide the exact gap this exists to find.
if [ -z "$INSTALL" ]; then
  INSTALL="${LANDED_CHECK_INSTALL:-}"
fi
if [ -z "$INSTALL" ]; then
  _common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")"
  [ -n "$_common" ] && INSTALL="$(dirname "$_common")"
fi
[ -n "$INSTALL" ] || { echo "ERROR:cannot-resolve-install-dir"; exit 2; }
[ -d "$INSTALL/.git" ] || [ -f "$INSTALL/.git" ] || { echo "ERROR:not-a-git-install:$INSTALL"; exit 2; }

_short() { git -C "$INSTALL" rev-parse --short "$1" 2>/dev/null || printf '%s' "$1"; }

# check_commit <sha>
# Prints the verdict line, then indented detail lines. Returns 0 landed, 1 not, 2 error.
check_commit() {
  local sha="$1"
  # `unknowns` is deliberately separate from `reasons`: an UNVERIFIED check is not
  # a passed check. Folding it into details (as the first version did) let a
  # missing ref or a missing build marker read as green -- the exact false-pass
  # this script exists to catch (QA2 FAIL / Cybersec NO-GO on d4d8c56).
  local reasons=() unknowns=() details=()

  if ! git -C "$INSTALL" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "NOT-LANDED $sha missing-commit"
    echo "  a commit nem letezik ebben a repoban (mas fork, vagy sosem lett pusholva ide)"
    return 1
  fi
  local full; full="$(git -C "$INSTALL" rev-parse "${sha}^{commit}")"
  local shortsha; shortsha="$(_short "$full")"

  # 1. merged into the integration ref
  if git -C "$INSTALL" rev-parse --verify --quiet "${REF}^{commit}" >/dev/null 2>&1; then
    if git -C "$INSTALL" merge-base --is-ancestor "$full" "$REF" 2>/dev/null; then
      details+=("merge: OK -- benne van a(z) $REF agban")
    else
      reasons+=("not-merged")
      details+=("merge: NINCS a(z) $REF agban -- csak feature-agon el")
    fi
  else
    # NOT fetched on purpose: a fetch writes to the repo, and this tool must stay
    # read-only. Unverifiable is reported, never assumed good.
    unknowns+=("merge-unverifiable")
    details+=("merge: NEM ELLENORIZHETO -- a(z) $REF ref nem letezik lokalisan (git fetch kell; ez a script nem fetchel)")
  fi

  # 2. present in the LIVE install's checked-out HEAD
  local live_head; live_head="$(git -C "$INSTALL" rev-parse HEAD 2>/dev/null || echo "")"
  if [ -z "$live_head" ]; then
    unknowns+=("deploy-unverifiable"); details+=("deploy: az elo install HEAD-je nem olvashato")
  elif git -C "$INSTALL" merge-base --is-ancestor "$full" "$live_head" 2>/dev/null; then
    details+=("deploy: OK -- benne van az elo install HEAD-jeben ($(_short "$live_head"))")
  else
    reasons+=("not-deployed")
    local behind; behind="$(git -C "$INSTALL" rev-list --count "${live_head}..${full}" 2>/dev/null || echo '?')"
    details+=("deploy: NINCS az elo install HEAD-jeben ($(_short "$live_head")) -- $behind committal elotte")
  fi

  # 3. the files it touched actually exist on disk. A commit can be an ancestor of
  #    HEAD and the file still be gone: a later commit may have removed it, or a
  #    detached-HEAD window may have left the tree inconsistent.
  #    `-m --first-parent` is REQUIRED: without it `git show --name-only` prints
  #    NOTHING for a merge commit, so the loop below ran zero times and the check
  #    reported "files: OK -- all 0 files present" -- a vacuous pass on exactly the
  #    commits that matter most. Measured on 6ac4d10: 0 files without the flags, 5
  #    with. --first-parent picks the diff against the mainline, i.e. what the merge
  #    actually brought in.
  local missing=0 checked=0 f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    checked=$((checked + 1))
    if ! git -C "$INSTALL" cat-file -e "HEAD:$f" 2>/dev/null; then
      missing=$((missing + 1)); details+=("file: HIANYZIK a live HEAD fajabol -- $f")
    elif [ ! -e "$INSTALL/$f" ]; then
      missing=$((missing + 1)); details+=("file: a HEAD-ben benne van, de a LEMEZEN nincs -- $f")
    fi
  done < <(git -C "$INSTALL" show -m --first-parent --pretty=format: --name-only --diff-filter=d "$full" 2>/dev/null | sed '/^$/d' | sort -u)
  if [ "$missing" -gt 0 ]; then
    reasons+=("files-missing")
  elif [ "$checked" -eq 0 ]; then
    # Nothing enumerated means nothing was verified. Reporting OK here is the
    # false-green this whole tool exists to catch.
    unknowns+=("files-unverifiable")
    details+=("files: NEM ELLENORIZHETO -- a commit egyetlen fajlt sem sorolt fel")
  else
    details+=("files: OK -- mind a $checked erintett fajl a helyen van")
  fi

  # 4. the running build. dist/.built-commit records the commit dist was built from;
  #    source-on-disk without a rebuild is the "gate passed, still stale" trap.
  local built_file="$INSTALL/dist/.built-commit"
  if [ -r "$built_file" ]; then
    local built; built="$(tr -d ' \n\r' < "$built_file")"
    if [ -z "$built" ]; then
      unknowns+=("build-unverifiable"); details+=("build: a dist/.built-commit ures")
    elif ! git -C "$INSTALL" cat-file -e "${built}^{commit}" 2>/dev/null; then
      unknowns+=("build-unverifiable"); details+=("build: a dist/.built-commit ismeretlen commitra mutat ($built)")
    elif git -C "$INSTALL" merge-base --is-ancestor "$full" "$built" 2>/dev/null; then
      details+=("build: OK -- a dist ebbol vagy ujabbol epult ($(_short "$built"))")
    else
      reasons+=("stale-build")
      details+=("build: a dist REGEBBI commitbol epult ($(_short "$built")) -- ujraforditas kell")
    fi
  else
    unknowns+=("build-unverifiable")
    details+=("build: nincs dist/.built-commit -- nem ellenorizheto")
  fi

  # A definite failure outranks an unknown: "not landed" is more informative than
  # "cannot tell" when we already know one check failed.
  if [ "${#reasons[@]}" -gt 0 ]; then
    local joined; joined="$(IFS=,; echo "${reasons[*]}")"
    echo "NOT-LANDED $shortsha $joined"
    printf '  %s\n' "${details[@]}"
    return 1
  fi
  if [ "${#unknowns[@]}" -gt 0 ]; then
    local ujoined; ujoined="$(IFS=,; echo "${unknowns[*]}")"
    echo "UNKNOWN $shortsha $ujoined"
    printf '  %s\n' "${details[@]}"
    return 3
  fi
  echo "LANDED $shortsha"
  printf '  %s\n' "${details[@]}"
  return 0
}

# ---- sweep ------------------------------------------------------------------
# Pulls candidate commits out of kanban comments. A REVIEW/verdict comment names
# the commit it is about, which is the only machine-readable link between "a card
# says done" and "a tree contains the code".
sweep() {
  local db="$INSTALL/store/claudeclaw.db"
  [ -r "$db" ] || { echo "ERROR:no-kanban-db:$db"; exit 2; }
  command -v sqlite3 >/dev/null 2>&1 || { echo "ERROR:sqlite3-not-installed"; exit 2; }

  # Status values are interpolated into SQL, so they come off a fixed allowlist
  # rather than being escaped. The sweep is built for automation, and the first
  # caller passing a non-constant status would otherwise open a real injection
  # path: `--status "x') OR 1=1 --"` returned rows the filter should have excluded.
  local status_in="" _s
  for _s in $(printf '%s' "$SWEEP_STATUS" | tr ',' ' '); do
    case "$_s" in
      planned|in_progress|waiting|done) status_in="${status_in:+$status_in,}'$_s'" ;;
      *) echo "ERROR:invalid-status:$_s"; exit 2 ;;
    esac
  done
  [ -n "$status_in" ] || { echo "ERROR:invalid-status:$SWEEP_STATUS"; exit 2; }
  # read-only open: a sweep must never be able to touch the live board
  local rows
  # Comment bodies are multi-line; flattened in SQL because a raw newline would
  # split one comment across several `read` iterations and silently lose the sha.
  rows="$(sqlite3 "file:$db?mode=ro" "
    SELECT cm.card_id || '|' ||
           replace(replace(substr(cm.content, 1, 400), char(10), ' '), char(13), ' ')
    FROM kanban_comments cm JOIN kanban_cards c ON c.id = cm.card_id
    WHERE c.status IN ($status_in)
    ORDER BY cm.created_at DESC LIMIT 400;" 2>/dev/null)" || { echo "ERROR:sqlite-read-failed"; exit 2; }

  # card_id -> first commit-looking token in its comments
  local seen_cards="" total=0 bad=0 unsure=0
  local card sha line
  while IFS='|' read -r card line; do
    [ -n "$card" ] || continue
    case " $seen_cards " in *" $card "*) continue ;; esac
    sha="$(printf '%s' "$line" | grep -oiE '\b(commit|@) *[0-9a-f]{7,40}\b' | head -1 | grep -oiE '[0-9a-f]{7,40}' | head -1)"
    [ -n "$sha" ] || continue
    git -C "$INSTALL" cat-file -e "${sha}^{commit}" 2>/dev/null || continue
    seen_cards="$seen_cards $card"
    # limit checked BEFORE counting, so the summary never reports a card it
    # stopped short of checking
    [ "$total" -lt "$SWEEP_LIMIT" ] || break
    total=$((total + 1))
    local verdict
    verdict="$(check_commit "$sha" | head -1)"
    echo "$card $verdict"
    case "$verdict" in
      NOT-LANDED*) bad=$((bad + 1)) ;;
      UNKNOWN*)    unsure=$((unsure + 1)) ;;
    esac
  done <<< "$rows"

  # Zero coverage is not a clean bill of health. A mistyped parameter in a
  # scheduled caller used to print `checked=0 not-landed=0` and exit 0, i.e.
  # "everything landed" -- the same overstated-coverage class this tool measures.
  [ "$total" -gt 0 ] || { echo "ERROR:nothing-checked"; exit 2; }

  echo "SUMMARY checked=$total not-landed=$bad unknown=$unsure"
  [ "$bad" -eq 0 ] || return 1
  [ "$unsure" -eq 0 ] || return 3
  return 0
}

# ---- selftest ---------------------------------------------------------------
# Proves the four checks against a throwaway repo, so the script is verifiable
# without depending on the state of any real install.
selftest() {
  local tmp fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  git -C "$tmp" init -q
  git -C "$tmp" config user.email selftest@local
  git -C "$tmp" config user.name selftest
  mkdir -p "$tmp/store"
  echo one > "$tmp/a"; git -C "$tmp" add a; git -C "$tmp" commit -q -m base
  local base; base="$(git -C "$tmp" rev-parse HEAD)"
  git -C "$tmp" branch -f fake-integration
  echo two > "$tmp/b"; git -C "$tmp" add b; git -C "$tmp" commit -q -m feature
  local feat; feat="$(git -C "$tmp" rev-parse HEAD)"

  INSTALL="$tmp"; REF="fake-integration"
  # give the box a build marker up front so the LANDED case has all four checks
  # actually RUN -- an unchecked build must not be able to produce LANDED
  mkdir -p "$tmp/dist"; echo "$feat" > "$tmp/dist/.built-commit"

  local out
  out="$(check_commit "$base")"
  case "$out" in LANDED*) echo "ok   merged+deployed commit -> LANDED" ;;
                 *) echo "FAIL merged commit: $out"; fail=1 ;; esac

  out="$(check_commit "$feat")"
  case "$out" in *not-merged*) echo "ok   feature-only commit -> not-merged" ;;
                 *) echo "FAIL feature commit: $(echo "$out" | head -1)"; fail=1 ;; esac

  # deployed=false: move the install back so the feature commit is ahead of HEAD
  git -C "$tmp" checkout -q "$base"
  out="$(check_commit "$feat" | head -1)"
  case "$out" in *not-deployed*) echo "ok   commit ahead of live HEAD -> not-deployed" ;;
                 *) echo "FAIL not-deployed: $out"; fail=1 ;; esac

  # file present in HEAD but deleted from disk
  git -C "$tmp" checkout -q "$feat"
  rm -f "$tmp/b"
  out="$(check_commit "$feat" | head -1)"
  case "$out" in *files-missing*) echo "ok   file gone from disk -> files-missing" ;;
                 *) echo "FAIL files-missing: $out"; fail=1 ;; esac
  git -C "$tmp" checkout -q -- b

  # stale build marker
  echo "$base" > "$tmp/dist/.built-commit"
  out="$(check_commit "$feat" | head -1)"
  case "$out" in *stale-build*) echo "ok   dist built from an older commit -> stale-build" ;;
                 *) echo "FAIL stale-build: $out"; fail=1 ;; esac

  out="$(check_commit "0000000000000000000000000000000000000000" | head -1)"
  case "$out" in *missing-commit*) echo "ok   unknown commit -> missing-commit" ;;
                 *) echo "FAIL missing-commit: $out"; fail=1 ;; esac

  # an UNVERIFIED check must never read as a passed one
  echo "$feat" > "$tmp/dist/.built-commit"
  REF="no-such-ref-anywhere"
  out="$(check_commit "$base" | head -1)"
  case "$out" in UNKNOWN*merge-unverifiable*) echo "ok   missing ref -> UNKNOWN, not LANDED" ;;
                 *) echo "FAIL missing ref: $out"; fail=1 ;; esac
  check_commit "$base" >/dev/null; [ "$?" = "3" ] || { echo "FAIL missing ref: exit was not 3"; fail=1; }

  REF="fake-integration"
  rm -f "$tmp/dist/.built-commit"
  out="$(check_commit "$base" | head -1)"
  case "$out" in UNKNOWN*build-unverifiable*) echo "ok   missing build marker -> UNKNOWN, not LANDED" ;;
                 *) echo "FAIL missing build marker: $out"; fail=1 ;; esac

  [ "$fail" = "0" ] && echo "selftest OK"
  return "$fail"
}

case "$MODE" in
  commit)
    [ -n "$COMMIT" ] || { echo "ERROR:missing-commit-argument"; exit 2; }
    check_commit "$COMMIT"; exit $?
    ;;
  sweep)   sweep; exit $? ;;
  selftest) selftest; exit $? ;;
  *) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
