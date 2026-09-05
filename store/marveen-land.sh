#!/usr/bin/env bash
# marveen-land.sh -- land an agent's marveen worktree branch (card dc185b52, MikroB komment 14285).
# Sibling of store/cleancore-land.sh, matching naming on purpose: this repo now has the same
# worktree-per-agent shape CleanCore already proved out, and the landing step follows the same
# pattern -- merge in a THROWAWAY detached worktree (never the agent's own persistent worktree from
# store/agent-worktree-marveen.sh, and never the shared main checkout), verify the MERGE RESULT, push
# only on green.
#
# WHAT ELSE RIDES ALONG (card dfff9b37). This used to be a note telling you to run
# `git log --oneline origin/develop..<gate-sha>` yourself. It is now measured by the script: every
# landing PRINTS the commits in that range grouped by the card they name, and the ones naming no
# card at all. It only REFUSES when you name the card you are landing (`--card <id>`) and somebody
# else's card is in there -- because a marveen landing legitimately carries several cards (measured
# over 14 landings; MikroB's `--all` sweep does exactly that on purpose), so a blanket refusal here
# would stop the normal path, not the defect. cleancore-land.sh, which is always called with one
# card, refuses by default. Shared code, different default; the reasoning is in
# store/landing-downward-check.sh, the cherry-pick recipe in
# store/landing-cherry-pick-vs-branch-merge.md.
#
# This script's core mechanics were already present, unchanged, in the now-retired
# store/agent-branch-land.sh and were explicitly confirmed safe by Cybersec's NO-GO review on
# card dc185b52 (komment 14284: "store/agent-branch-land.sh SOHA nem erinti a megosztott
# munkakonyvtarat, csak sajat throwaway worktree-t hasznal ... ez a resz biztonsagos"). The retired
# script's problem was its SIBLING (store/agent-branch.sh, "Step 0"), which ran `git checkout` on the
# ONE shared tree every agent's Read/Edit/Write tools also targeted -- a live-reproduced TOCTOU race.
# This script never did that, so it is renamed and kept (not rewritten) alongside the new
# agent-worktree-marveen.sh, which replaces Step 0 with real filesystem isolation instead of a
# checkout on shared ground.
#
# Usage:
#   marveen-land.sh <agent> [--dry-run] [--card <id>] [--allow-stacked <id>[,<id>...]]
#                                         # land one agent's worktree branch. --card turns the
#                                         # downward report into a refusal; --allow-stacked names
#                                         # the foreign cards you are taking on purpose.
#   marveen-land.sh --all [--dry-run]     # land every agent/*/work branch with unmerged work,
#                                         # sequentially (never concurrent -- shared object store)
#   marveen-land.sh --selftest
#
# Env overrides (tests only):
#   MARVEEN_MAIN     default /home/neon/marveen -- also where `origin` is fetched/pushed
#   MARVEEN_LAND_TEST   default "$MAIN/store/fleet-test.sh --ref" -- verification command, the merge
#                       sha is appended as the final argument. fleet-test.sh hardcodes the real repo
#                       as ROOT, so an automated test of THIS script against a throwaway repo must
#                       override this to a stub.
#   MARVEEN_LAND_MAX_ATTEMPTS  default 3 -- how many full merge+verify+push attempts before giving
#                       up on a repeatedly-raced push (card 65657bad).
#   LANDING_DOWNWARD_CHECK=off  disables the downward range check entirely (card dfff9b37).
#
# Exit: 0 landed (or dry-run clean, or nothing to land) | 2 bad usage | 3 refused a precondition
#       | 4 merge/verify/push failed
#       (5 is internal: land_one lost the push race; land_with_retry consumes it and never leaks it)
set -uo pipefail

MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
say() { echo "  $*"; }
die() { echo "REFUSED: $2" >&2; exit "$1"; }
g() { git -C "$MAIN" "$@"; }

# card 02f462e1: a landing pushes from a DISPOSABLE worktree (land_one's $wt) that shares $MAIN's
# .git, so `g fetch` above already refreshed $MAIN's origin/$DEFAULT_BRANCH ref -- but $MAIN's own
# CHECKED-OUT branch and working-tree files do not follow along on their own. Left alone, that is
# exactly the gap the card measured: 3 unrelated cards landed clean on one day while the live
# install (MikroB's own running checkout) kept serving the pre-landing code/scripts, until someone
# fetched + fast-forwarded it BY HAND. This is a plain `merge --ff-only` and NOTHING else: no
# rebuild, no service restart -- those remain ./update.sh + Peti's approval (a separate, deliberate
# gate). --ff-only is the whole safety story: it can only ever fast-forward or refuse, never force,
# so a dirty/diverged $MAIN is left untouched and reported, not overridden.
sync_live_install() {
  local current
  current="$(git -C "$MAIN" symbolic-ref --short -q HEAD 2>/dev/null || true)"
  # Not on the tracked branch (detached, or mid manual work on something else) -- nothing to sync,
  # and merging origin/$DEFAULT_BRANCH into an unrelated checkout would not even make sense.
  [ "$current" = "$DEFAULT_BRANCH" ] || return 0
  if git -C "$MAIN" merge --ff-only -q "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    say "live install ($MAIN) fast-forwarded to origin/$DEFAULT_BRANCH"
  else
    say "live install ($MAIN) NOT fast-forwarded (dirty tree or diverged) -- sync it by hand, tell MikroB"
  fi
}

# try_append_union (card cbb66abf): the ONE conflict shape (both sides purely append to
# DECISIONS.md) this script auto-resolves, shared verbatim with cleancore-land.sh so the narrow
# precondition and the header-count check cannot drift between the two copies.
# shellcheck source=./decisions-append-union.sh
. "$(dirname "$0")/decisions-append-union.sh"
# shellcheck source=./bump-fork-version.sh
. "$(dirname "$0")/bump-fork-version.sh"
# downward_check (card dfff9b37): what ELSE rides along in origin/develop..<branch>. Shared verbatim
# with cleancore-land.sh. REPORTS here by default and refuses only under --card <id> -- the reason
# is measured and written out in landing-downward-check.sh's header (marveen lands whole agent
# branches, gate-AFTER-landing, and multi-card landings are the normal case, not the anomaly).
# shellcheck source=./landing-downward-check.sh
. "$(dirname "$0")/landing-downward-check.sh"
# gate_verdict_check (card 9081d02d): shared with cleancore-land.sh, but run here in REPORT mode.
# Marveen gates AFTER landing -- the root CLAUDE.md says "a visszaadott sha a Gate-SHA", i.e. the
# sha a gate will judge is the one THIS script is about to produce -- so demanding a verdict up
# front would deadlock every marveen landing rather than tighten it. Measured on the cards landed
# 2026-09-04 (b3bf3cc2, d9b1b418, af5d3dbf): each was already an ancestor of origin/develop when
# its gate ran. Same shape as downward_check above: shared code, different default.
# shellcheck source=./landing-gate-verdict-check.sh
. "$(dirname "$0")/landing-gate-verdict-check.sh"

if [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  agent_of() { case "$1" in agent/*/work) b="${1#agent/}"; echo "${b%/work}" ;; *) echo "" ;; esac; }
  t "extracts agent name from a work branch" "$(agent_of 'agent/backend/work')" "backend"
  t "rejects a non-agent branch" "$(agent_of 'develop')" ""
  t "rejects an agent branch with the wrong suffix" "$(agent_of 'agent/backend/scratch')" ""
  # Downward range check (card dfff9b37) -- the cases live in the shared lib so the two landers
  # cannot end up testing different things about the same code.
  downward_selftest_cases
  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

[ -d "$MAIN/.git" ] || die 3 "$MAIN is not a git repository"
DEFAULT_BRANCH="$(g symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="develop"
TEST_CMD="${MARVEEN_LAND_TEST:-$MAIN/store/fleet-test.sh --ref}"
MAX_ATTEMPTS="${MARVEEN_LAND_MAX_ATTEMPTS:-3}"

land_one() {
  local agent="$1" dry="$2"
  local branch="agent/${agent}/work"

  g show-ref --verify --quiet "refs/heads/$branch" || { say "$agent: no branch $branch -- nothing to land"; return 0; }

  g fetch -q origin "$DEFAULT_BRANCH" || die 3 "could not fetch origin/$DEFAULT_BRANCH"
  local base_sha; base_sha="$(g rev-parse "origin/$DEFAULT_BRANCH")"

  if g merge-base --is-ancestor "$branch" "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    say "$agent: $branch already fully landed on origin/$DEFAULT_BRANCH -- nothing to do"
    return 0
  fi

  local wt="/home/neon/marveen-land-${agent}-$$"
  rm -rf "$wt"
  g worktree add --detach -q "$wt" "origin/$DEFAULT_BRANCH" || die 3 "could not create the landing worktree for $agent"
  # `${wt:-}` and the explicit success, both deliberate (card 65657bad, caught by its own test): the
  # RETURN trap set here also fires when land_with_retry returns, where `wt` is a dead local -- under
  # `set -u` that aborted the whole script mid-landing. Nothing to remove is not a failure, either;
  # a non-zero last command in a RETURN trap would poison the return code it is riding on.
  cleanup() { [ -n "${wt:-}" ] && g worktree remove --force "$wt" >/dev/null 2>&1; return 0; }
  trap cleanup RETURN

  # What ELSE rides along (card dfff9b37). Runs BEFORE the merge, so a refusal costs nothing and a
  # report is on screen at the one moment somebody is watching this landing. Merges dropped -- see
  # decision 3 in landing-downward-check.sh.
  local down_log
  down_log="$(g log --no-merges --format='%h%x09%s' "origin/$DEFAULT_BRANCH..$branch")"
  downward_check "$down_log" "$LAND_CARD" "$ALLOW_STACKED" "$([ -n "$LAND_CARD" ] && echo 1 || echo 0)" "$agent" || {
    echo "$agent: REFUSED -- commits belonging to OTHER cards are in $branch. Nothing merged, nothing pushed."
    return 4
  }

  # Only when the caller NAMED the card -- without one there is no single card to ask about, since
  # a marveen branch legitimately carries several. Report-only, for the reason in the source note.
  if [ -n "$LAND_CARD" ]; then gate_verdict_check "$LAND_CARD" "$branch" report || true; fi

  local msg="merge: $branch into $DEFAULT_BRANCH (marveen-land, base @ $(git -C "$wt" rev-parse --short HEAD))"
  local merge_err
  if ! merge_err="$(git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob \
                    merge --no-ff "$branch" -m "$msg" 2>&1)"; then
    local conflicted; conflicted="$(git -C "$wt" diff --name-only --diff-filter=U)"
    # NARROW AUTO-UNION (card cbb66abf): only when DECISIONS.md is the SOLE conflicted file, and
    # only when try_append_union structurally confirms both sides purely appended -- see
    # decisions-append-union.sh for the full precondition and why it is safe to complete the merge
    # rather than abort it here. Everything else falls through to the unchanged refusal below.
    if [ "$conflicted" = "DECISIONS.md" ] && try_append_union "$wt" "DECISIONS.md"; then
      say "$agent: DECISIONS.md: both sides purely appended -- auto-unioned, header count verified"
      git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob commit --no-edit -q \
        || { echo "$agent: auto-unioned DECISIONS.md but the merge commit itself failed"; return 4; }
    elif [ -n "$conflicted" ]; then
      echo "$agent: CONFLICTS in:"; echo "$conflicted" | sed 's/^/    /'
      git -C "$wt" merge --abort 2>/dev/null
      return 4
    else
      echo "$agent: MERGE FAILED (not a content conflict) -- git says:"; echo "$merge_err" | sed 's/^/    /'
      git -C "$wt" merge --abort 2>/dev/null
      return 4
    fi
  fi
  local merge_sha; merge_sha="$(git -C "$wt" rev-parse HEAD)"
  say "$agent: merged --no-ff, no conflicts ($(git -C "$wt" diff --name-only "$base_sha..HEAD" | wc -l) file(s) changed since $DEFAULT_BRANCH base)"

  # SEAM CHECK, both directions (same reasoning as cleancore-land.sh): "no conflict" only means git
  # found no OVERLAPPING hunks, not that both sides' additions to a shared file both survived.
  local mb; mb="$(g merge-base "$branch" "$base_sha")"
  local branch_files main_files overlap
  branch_files="$(g diff --name-only "$mb..$branch")"
  main_files="$(g diff --name-only "$mb..$base_sha")"
  overlap="$(comm -12 <(echo "$branch_files" | sort) <(echo "$main_files" | sort))"
  if [ -n "$overlap" ]; then
    local lost=0 f line body
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ -f "$wt/$f" ] || { echo "$agent: SEAM FAIL: $f is missing from the merge result"; lost=$((lost+1)); continue; }
      while IFS= read -r line; do
        case "$line" in (''|'+++'*) continue ;; esac
        body="${line#+}"
        [ -n "${body// }" ] || continue
        grep -qF -- "$body" "$wt/$f" || { echo "$agent: SEAM FAIL in $f: dropped line: ${body:0:90}"; lost=$((lost+1)); }
      done < <(g diff "$mb..$branch" -- "$f" | grep '^+')
      while IFS= read -r line; do
        case "$line" in (''|'+++'*) continue ;; esac
        body="${line#+}"
        [ -n "${body// }" ] || continue
        grep -qF -- "$body" "$wt/$f" || { echo "$agent: SEAM FAIL in $f: $DEFAULT_BRANCH's own line dropped: ${body:0:90}"; lost=$((lost+1)); }
      done < <(g diff "$mb..$base_sha" -- "$f" | grep '^+')
    done < <(echo "$overlap")
    [ "$lost" -eq 0 ] || { echo "$agent: REFUSED, $lost seam loss(es)"; git -C "$wt" reset -q --hard "$base_sha"; return 4; }
    say "$agent: seam: $(echo "$overlap" | wc -l) shared file(s) checked in both directions, clean"
  else
    say "$agent: seam: no file touched by both sides"
  fi

  # npm lockfile drift on the MERGE RESULT (card c3f052ad). marveen is an npm repo, and the
  # pnpm-only store/lockfile-sync-check.sh never checked anything here -- it reported
  # ERR_PNPM_NO_LOCKFILE as drift on every landing until card fe06da0c made that "not applicable".
  # Fixing the noise left the real hole open: a dependency declared in package.json without
  # regenerating package-lock.json still reaches the deploy unseen, which is the exact incident
  # class (twice in one day, cards 8d673233 and af7441a3) that produced the pnpm check.
  #
  # ON THE MERGE RESULT, not the branch: two branches that are each internally consistent can
  # merge into an inconsistent whole (one adds a dependency, the other regenerates the lock), and
  # what matters is what LANDS. --base origin/<default> keeps it free on the majority of landings,
  # which touch no manifest at all.
  #
  # REFUSES ON 1, NEVER ON 3, mirroring cleancore-land.sh's pnpm refusal: "the lockfile is stale"
  # and "this lockfile shape is one the checker cannot read" are different facts, and treating a
  # harness fault as a policy would silently block every landing.
  NPM_LF_OUT="$("$(dirname "$0")/npm-lockfile-sync-check.sh" --repo "$wt" --ref "$merge_sha" --base "origin/$DEFAULT_BRANCH" 2>&1)"
  case $? in
    1)
      echo "$agent: REFUSED -- package-lock.json does not match package.json on the merge result."
      echo "$NPM_LF_OUT"
      echo "Regenerate the lockfile (npm install --package-lock-only) on $branch, re-gate, and land again. Nothing pushed; $branch is untouched."
      return 4 ;;
    3) say "$agent: npm lockfile check skipped (harness fault, not a verdict): $(printf '%s' "$NPM_LF_OUT" | head -1)" ;;
    *) : ;;
  esac

  # Fork-own version bump (DECISIONS.md 2026-08-20/25, automated 2026-08-26 per Peti request):
  # every fork-own landing bumps package.json's +mikrob.N build-metadata, keeping package-lock.json's
  # own version fields in sync too. Skipped on --dry-run (nothing gets pushed, so nothing to bump).
  # NON-FATAL by construction, same as the blast-radius/graphify steps further down this function:
  # this script's job is landing CODE safely, and a version-metadata hiccup must never be the reason
  # a real fork commit fails to land. On failure the merge lands with its N unbumped -- annoying, not
  # dangerous -- and the next successful landing's fresh re-read simply bumps from whatever N is
  # actually on disk.
  if [ "$dry" != "1" ]; then
    if new_ver="$(bump_fork_version "$wt" 2>&1)"; then
      git -C "$wt" add package.json package-lock.json 2>/dev/null
      if git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob \
            commit -q -m "chore(version): bump to $new_ver (marveen-land, $agent)"; then
        merge_sha="$(git -C "$wt" rev-parse HEAD)"
        say "$agent: version bumped to $new_ver"
      else
        say "$agent: version bump produced no changes to commit -- left as-is"
      fi
    else
      say "$agent: version bump skipped ($new_ver) -- landing continues unbumped"
    fi
  fi

  # shellcheck disable=SC2086 -- TEST_CMD is an intentional word-split command prefix (script + flags)
  if ! (cd "$wt" && eval "$TEST_CMD $merge_sha"); then
    echo "$agent: REFUSED -- fleet-test failed on the merge result. Nothing pushed; $branch is untouched."
    return 4
  fi
  say "$agent: fleet-test green on the merge result"

  if [ "$dry" = "1" ]; then say "$agent: DRY-RUN -- not pushing"; return 0; fi

  # Card 65657bad: this used to be `>/dev/null 2>&1`, so PUSH FAILED never said why. On a fleet that
  # lands often the usual cause is a LOST RACE -- another agent pushed during our merge+test window,
  # leaving this push non-fast-forward -- which is not a fault at all. Indistinguishable from a real
  # one (credentials, network, a rejecting hook) without git's own words, so two agents re-ran the
  # whole landing by hand to find out. Print them.
  local push_err
  if ! push_err="$(git -C "$wt" push origin "HEAD:$DEFAULT_BRANCH" 2>&1)"; then
    echo "$agent: PUSH FAILED -- git says:"; echo "$push_err" | sed 's/^/    /'
    # A race is the one failure worth retrying, and only these exact markers identify it -- they are
    # what git prints for a non-fast-forward. Matching a bare "rejected" would also catch a
    # pre-receive hook REFUSING the push, which is a decision, not a race: retrying that burns
    # another full merge+verify cycle and fails again for the same reason.
    case "$push_err" in
      *"(fetch first)"*|*"(non-fast-forward)"*) return 5 ;;
    esac
    return 4
  fi
  g fetch -q origin "$DEFAULT_BRANCH"
  if g merge-base --is-ancestor "$merge_sha" "origin/$DEFAULT_BRANCH"; then
    # $branch itself is left untouched here on purpose: it is now an ancestor of origin/$DEFAULT_BRANCH,
    # so the agent's own next agent-worktree-marveen.sh top-up (or a plain `git pull --ff-only` inside
    # their persistent worktree) fast-forwards it there automatically. No reset attempted against a
    # branch that IS the agent's own currently-checked-out worktree.
    # Same reason as in cleancore-land.sh: the blast-radius graph must follow HEAD,
    # or the guard silently stops enforcing. Non-fatal by construction.
    "$(dirname "$0")/blast-radius-check.py" --refresh "$MAIN" 2>&1 | sed 's/^/  /' || true
    # The graphify code-graph feeds the local model's RAG context at dispatch
    # (card 44477615). It rotted the same way the blast-radius graph did -- built once
    # on adoption day, then 24 days stale -- so it follows HEAD here too. Incremental
    # (~13s on marveen) and non-fatal: a graph refresh must not fail a landing.
    "$(dirname "$0")/graphify.sh" build "$MAIN" 2>&1 | tail -1 | sed 's/^/  graphify: /' || true
    sync_live_install
    # Card 77075367: a src/-touching land does NOT rebuild dist/ or restart mikrob-channels/
    # mikrob-dashboard (deliberately -- see this function's header comment, restart stays a
    # separate, confirmed gate). That silence is exactly what let a landed, gated security fix
    # (f0389e81) sit inactive for ~1h until Cybersec's own retest caught it. This is not the
    # rebuild -- it is making the gap VISIBLE at the one moment someone is already watching
    # this output. scripts/build-freshness-guard.sh backstops it if nobody is.
    if git -C "$wt" diff --name-only "$base_sha..$merge_sha" -- src/ | grep -q .; then
      say "$agent: WARNING -- this land touches src/. dist/ is now STALE: mikrob-channels and mikrob-dashboard keep serving the OLD build until someone runs ./update.sh (or npm run build + a confirmed restart)."
    fi
    echo "$agent: LANDED $branch -> origin/$DEFAULT_BRANCH ($(git -C "$wt" rev-parse --short HEAD))"
    return 0
  fi
  echo "$agent: PUSH reported success but $merge_sha is NOT an ancestor of origin/$DEFAULT_BRANCH -- verify by hand"
  return 4
}

# A raced push is retried from the TOP, not by pushing again: the base moved, so the merge result
# fleet-test approved no longer describes what would land. Re-merging and re-verifying is this
# script's whole point -- pushing the already-tested merge onto a different base, or skipping the
# re-test to save two minutes, would put code on develop that no fleet-test ever saw.
land_with_retry() {
  local agent="$1" dry="$2" attempt=1 rc
  while :; do
    land_one "$agent" "$dry"; rc=$?
    [ "$rc" -eq 5 ] || return "$rc"
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      echo "$agent: REFUSED -- lost the push race $attempt time(s) in a row; origin/$DEFAULT_BRANCH keeps moving during the merge+test window. Nothing pushed; agent/${agent}/work is untouched."
      return 4
    fi
    attempt=$((attempt+1))
    say "$agent: another agent landed during the merge+test window -- re-merging onto the new origin/$DEFAULT_BRANCH and verifying again (attempt $attempt/$MAX_ATTEMPTS)"
  done
}

DRY=0; LAND_CARD=""; ALLOW_STACKED=""
TARGET="${1:-}"; [ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    # Naming the card turns the downward report into a refusal (card dfff9b37). Without it marveen
    # only reports: a whole-branch landing legitimately carries several cards, see the shared lib.
    --card) shift; [ $# -gt 0 ] || die 2 "--card needs a card id"; LAND_CARD="$1" ;;
    --card=*) LAND_CARD="${1#--card=}" ;;
    # Not a --force: the operator NAMES the foreign cards they are taking on purpose.
    --allow-stacked) shift; [ $# -gt 0 ] || die 2 "--allow-stacked needs a card id list"; ALLOW_STACKED="$1" ;;
    --allow-stacked=*) ALLOW_STACKED="${1#--allow-stacked=}" ;;
    *) die 2 "unknown option: $1" ;;
  esac
  shift
done
# --card names ONE card, so it cannot mean anything across a sweep of every agent's branch.
if [ "$TARGET" = "--all" ] && [ -n "$LAND_CARD" ]; then
  die 2 "--card cannot be combined with --all -- a sweep lands many agents' branches, not one card"
fi

case "$TARGET" in
  --all)
    overall=0
    while IFS= read -r b; do
      [ -n "$b" ] || continue
      agent="${b#agent/}"; agent="${agent%/work}"
      land_with_retry "$agent" "$DRY" || overall=1
    done < <(g for-each-ref --format='%(refname:short)' 'refs/heads/agent/*/work')
    exit $overall
    ;;
  '') die 2 "usage: marveen-land.sh <agent> [--dry-run] [--card <id>] [--allow-stacked <id>[,<id>...]] | marveen-land.sh --all [--dry-run]" ;;
  *)
    land_with_retry "$TARGET" "$DRY"
    exit $?
    ;;
esac
