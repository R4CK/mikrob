#!/usr/bin/env bash
# agent-checkpoint.sh -- branchless checkpoint ref per card (card 295ae6a3 F1.1, phase ed332869).
# Ideas-only, no code copied, from pingdotgg/t3code @37481f04 (MIT): capture a turn's full
# worktree state as a commit nothing points at except a hidden ref, built from a TEMP index so the
# agent's real index/HEAD/branch/stash are never touched.
#
# Usage:
#   agent-checkpoint.sh <agent> <cardId>   creates refs/mikrob/ckpt/<cardId>/<n> (n = next unused)
#                                           from <agent>'s own worktree, prints "<ref> <sha>"
#   agent-checkpoint.sh --selftest         proves index/HEAD/branch/stash are untouched
#
# Env overrides (tests only -- production uses the real marveen checkout):
#   MARVEEN_MAIN   default /home/neon/marveen (passed through to agent-worktree-marveen.sh)
#
# L3 decision (card 6ff6d1dc, Cybersec finding on 3517b027): `git add -A` intentionally captures
# ALL untracked files in the worktree, including an unguarded secret file (.env, id_rsa,
# credentials.json) if one is sitting there -- this is ACCEPTED, not a gap, because the resulting
# commit lives ONLY under refs/mikrob/ckpt/<cardId>/<n>, a ref this script and
# agent-worktree-marveen.sh never push, fetch, or expose to any remote. The checkpoint is
# local-only by construction. If a future change ever pushes or syncs these refs, an exclusion
# list must be added before this script can be reused as-is.
#
# Exit: 0 ok | 2 bad usage | 3 worktree path does not resolve to a real git worktree
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
DB="${MARVEEN_DB:-$MAIN/store/claudeclaw.db}"

die() { echo "agent-checkpoint.sh: $2" >&2; exit "$1"; }

agent_checkpoint() {
  local agent="$1" card="$2"
  case "$agent" in *[!a-z0-9-]*|-*|'') die 2 "agent name must match [a-z0-9-]+ (got: $agent)" ;; esac
  case "$card" in *[!0-9a-f]*|'') die 2 "card id must be hex (got: $card)" ;; esac

  # Forgery binding (card 0c03aa06, RedHat finding on 295ae6a3): refuse BEFORE touching the
  # worktree or creating anything if the card's kanban assignee is recorded and names a DIFFERENT
  # agent -- nothing else here checks that the caller actually owns the card it is checkpointing.
  # FAIL-OPEN only on ambiguity ($DB missing, or this specific card has no row yet), matching this
  # file's existing fail-open posture (see sweep_checkpoints' DB-missing die being the one place
  # that's NOT ambiguous -- its whole job IS the DB). A refused forgery must leave no trace: this
  # runs first, so nothing is created at all, not even the checkpoint commit.
  if [ -f "$DB" ]; then
    local assignee
    assignee="$(sqlite3 "$DB" "SELECT assignee FROM kanban_cards WHERE id = '$card'" 2>/dev/null || true)"
    if [ -n "$assignee" ] && [ "${assignee,,}" != "${agent,,}" ]; then
      die 1 "checkpoint refused: card $card is assigned to '$assignee', not '$agent' (forgery binding, card 0c03aa06)"
    fi
  fi

  local wt
  wt="$(MARVEEN_MAIN="$MAIN" bash "$HERE/agent-worktree-marveen.sh" "$agent" --path)"

  # The worktree path NOT resolving to a real git worktree must refuse, never fall back to
  # running git against $MAIN -- a checkpoint "of the agent's state" taken against the SHARED
  # clone would record some other agent's in-flight files under this agent's name.
  [ -e "$wt/.git" ] || die 3 "worktree path does not resolve to a real git worktree: $wt (run agent-worktree-marveen.sh $agent first; never falling back to the shared clone)"

  local head
  head="$(git -C "$wt" rev-parse HEAD)"

  # Not `local`: an EXIT trap fires after this function's scope is gone, so the trap body needs a
  # variable that survives past the function -- a local here would be unbound by then under `set -u`.
  tmp_index="$(mktemp -u)"
  # L1 (Cybersec finding on 3517b027): a RETURN trap does not fire when `set -e` aborts the whole
  # script on a failing command inside this function -- the script exits before the function ever
  # "returns", leaking tmp_index into TMPDIR. EXIT fires on every process exit, including that one.
  trap 'rm -f "$tmp_index"' EXIT

  # Blank temp index + add -A: git populates it from the CURRENT WORKING TREE (tracked, modified
  # and untracked-but-not-ignored paths), which is exactly the full snapshot a checkpoint wants --
  # same shape t3code uses (apps/server/src/vcs/GitVcsDriverCore.ts:4209, ideas only, no code
  # copied). This never touches $wt/.git/index: GIT_INDEX_FILE redirects every index read/write
  # below to $tmp_index instead.
  GIT_INDEX_FILE="$tmp_index" git -C "$wt" add -A

  local tree commit
  tree="$(GIT_INDEX_FILE="$tmp_index" git -C "$wt" write-tree)"
  commit="$(git -C "$wt" commit-tree "$tree" -p "$head" -m "checkpoint $card")"

  # M1 (Cybersec finding on 3517b027): create-only ref update, not check-then-act. The old code
  # found a free n with `show-ref`, then did an unconditional `update-ref` -- two concurrent runs
  # can both see the same free n, and the second overwrites the first's ref, silently losing a
  # checkpoint. Passing the all-zero value as update-ref's OLD value means "this ref must not
  # already exist"; git then refuses (rc=128) if another run claimed this n first, and we retry
  # with n+1 instead of racing.
  #
  # M1 follow-up (Cybersec finding on 6ff6d1dc/3835c1054): a plain `2>/dev/null && break` cannot
  # tell "ref already taken" apart from any OTHER update-ref failure (read-only refs dir, full
  # disk, corrupt packed-refs) -- both give rc=128, so the old retry loop spun on n forever on a
  # persistent failure, silently, with nothing printed. Capture stderr instead and only retry when
  # git itself says the ref already exists; any other failure is fatal, with git's own message and
  # a bounded attempt count so a persistent-but-unanticipated failure can never spin unbounded.
  local zero_oid
  zero_oid="$(printf '0%.0s' $(seq 1 ${#commit}))"
  local n=1 ref max_attempts=1000 update_err
  while true; do
    ref="refs/mikrob/ckpt/$card/$n"
    update_err="$(git -C "$wt" update-ref "$ref" "$commit" "$zero_oid" 2>&1)" && break
    case "$update_err" in
      *"reference already exists"*) ;;
      *) echo "$update_err" >&2; exit 1 ;;
    esac
    n=$((n + 1))
    [ "$n" -le "$max_attempts" ] || die 1 "update-ref: $max_attempts attempts, all claimed -- giving up"
  done

  # Wire the write (card 0c03aa06, RedHat finding on 295ae6a3): the ref above is the authoritative
  # checkpoint; this row is what lets gate-closure-check.py's _checkpoint_coverage actually find it.
  # Best-effort and non-fatal -- $DB missing (e.g. a test fixture, or MARVEEN_DB pointed elsewhere)
  # must not fail a checkpoint that otherwise succeeded; the git ref is still the source of truth.
  if [ -f "$DB" ]; then
    sqlite3 "$DB" "INSERT INTO card_checkpoints (card_id, n, sha, head_sha, agent, created_at)
      VALUES ('$card', (SELECT COALESCE(MAX(n), 0) + 1 FROM card_checkpoints WHERE card_id = '$card'),
              '$commit', '$head', '$agent', strftime('%s', 'now'));" 2>/dev/null || true
  fi

  echo "$ref $commit"
}

# sweep_checkpoints -- delete refs/mikrob/ckpt/<card>/* for cards done > N days (card F1.1.2).
# Usage: sweep_checkpoints [--dry-run] [--older-than-days N]
sweep_checkpoints() {
  local dry_run=0 older_days=14
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --older-than-days) older_days="${2:-}"; shift 2 ;;
      *) die 2 "usage: agent-checkpoint.sh --sweep [--dry-run] [--older-than-days N]" ;;
    esac
  done
  case "$older_days" in ''|*[!0-9]*) die 2 "--older-than-days must be a positive integer (got: $older_days)" ;; esac
  # F1 (card 0c03aa06, Cybered 31713): the un-capped value fed into date-arithmetic wraps for a
  # mistyped or injected huge threshold -- measured: 1000000000000000 and 213503982334601 both
  # delete a card's refs done minutes ago, not just astronomically large inputs. 36500 days
  # (100 years) is far past any real retention need, so anything above it is rejected outright
  # rather than trusted to stay negative.
  # F1b (Cybered 31725): the numeric comparison below runs $((10#$older_days)) FIRST, and that is
  # 64-bit signed arithmetic -- a digit string at or above 2^63 wraps to a small or negative number
  # BEFORE the -gt 36500 check ever sees it, sailing under the cap (measured: 9223372036854775808
  # and 18446744073709551615 both still delete a done-today card's refs). Bound the STRING LENGTH
  # before any arithmetic touches it at all: 36500 is 5 digits, so 6+ digits is already over cap,
  # no wrap can hide behind a comparison that never runs.
  case "$older_days" in ??????*) die 2 "--older-than-days too large (max 36500, got: $older_days)" ;; esac
  [ "$((10#$older_days))" -gt 36500 ] && die 2 "--older-than-days too large (max 36500, got: $older_days)"

  [ -f "$DB" ] || die 1 "DB not found: $DB (set MARVEEN_DB to override)"

  local cutoff=$(( $(date +%s) - (10#$older_days) * 86400 ))
  local card_ids
  card_ids="$(sqlite3 "$DB" "SELECT id FROM kanban_cards WHERE status='done' AND updated_at < $cutoff" 2>&1)" \
    || die 1 "sqlite3 query failed: $card_ids"

  local deleted=0 listed=0
  while IFS= read -r card; do
    [ -z "$card" ] && continue
    local refs
    refs="$(git -C "$MAIN" for-each-ref "refs/mikrob/ckpt/$card/" --format='%(refname)' 2>/dev/null)"
    [ -z "$refs" ] && continue
    while IFS= read -r ref; do
      [ -z "$ref" ] && continue
      if [ "$dry_run" -eq 1 ]; then
        echo "would delete: $ref (card $card)"
        listed=$((listed + 1))
      else
        git -C "$MAIN" update-ref -d "$ref"
        echo "deleted: $ref"
        deleted=$((deleted + 1))
      fi
    done <<< "$refs"
  done <<< "$card_ids"

  if [ "$dry_run" -eq 1 ]; then
    echo "sweep: dry-run complete, $listed ref(s) would be deleted (cards done > ${older_days}d)"
  else
    echo "sweep: $deleted ref(s) deleted (cards done > ${older_days}d)"
  fi
}

if [ "${1:-}" = "--selftest" ]; then
  fail=0
  ok() { echo "  ok   $1"; }
  no() { echo "  FAIL $1"; fail=1; }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  TEST_MAIN="$tmp/main"
  TEST_ROOT="$tmp/worktrees"

  git init -q -b develop "$TEST_MAIN"
  git -C "$TEST_MAIN" config user.email t@t
  git -C "$TEST_MAIN" config user.name t
  git -C "$TEST_MAIN" config commit.gpgsign false
  echo base > "$TEST_MAIN/notes.txt"
  git -C "$TEST_MAIN" add notes.txt
  git -C "$TEST_MAIN" commit -qm base

  ORIGIN="$tmp/origin.git"
  git init -q --bare -b develop "$ORIGIN"
  git -C "$TEST_MAIN" remote add origin "$ORIGIN"
  git -C "$TEST_MAIN" push -q origin develop
  git -C "$TEST_MAIN" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

  run() { MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$0" "$@"; }

  # 1. worktree path that does not resolve (never created) -> refuse, exit 3, never touches MAIN.
  if out="$(MARVEEN_MAIN="$TEST_MAIN" bash "$0" testagent deadbeef12 2>&1)"; then
    no "expected refusal for a non-existent worktree, got success: $out"
  else
    rc=$?
    if [ "$rc" = 3 ] && printf '%s' "$out" | grep -q "never falling back"; then
      ok "non-existent worktree path is refused (exit 3), never falls back to the shared clone"
    else
      no "expected exit 3 with the fallback-refusal message, got rc=$rc out=$out"
    fi
  fi

  # Now create the real worktree via the sibling script, same env.
  run_wt() { MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$HERE/agent-worktree-marveen.sh" "$@"; }
  run_wt testagent >/dev/null
  WT="$TEST_ROOT/testagent"

  # An UNRELATED, pre-existing stash entry first (committed to the stash and the working tree
  # cleaned again), so "stash list untouched" has something real to prove without `git stash
  # push` later sweeping away the very staged/modified state the checkpoint is supposed to catch
  # (stash push reverts staged + unstaged tracked changes to HEAD by default).
  echo stashme > "$WT/stash-source.txt"
  git -C "$WT" add stash-source.txt
  git -C "$WT" stash push -q -m "selftest stash"

  # Seed real, varied worktree state: a staged file, an unstaged modification, an untracked file.
  echo staged > "$WT/staged.txt"
  git -C "$WT" add staged.txt
  echo modified >> "$WT/notes.txt"
  echo untracked > "$WT/untracked.txt"

  real_index="$(git -C "$WT" rev-parse --git-path index)"
  before_index_hash="$(sha256sum "$real_index" | awk '{print $1}')"
  before_head="$(git -C "$WT" rev-parse HEAD)"
  before_branch="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"
  before_stash="$(git -C "$WT" stash list)"
  before_status="$(git -C "$WT" status --porcelain)"

  out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$0" testagent cafebabe01)"
  ref="$(echo "$out" | awk '{print $1}')"
  sha="$(echo "$out" | awk '{print $2}')"

  after_index_hash="$(sha256sum "$real_index" | awk '{print $1}')"
  after_head="$(git -C "$WT" rev-parse HEAD)"
  after_branch="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"
  after_stash="$(git -C "$WT" stash list)"
  after_status="$(git -C "$WT" status --porcelain)"

  [ "$ref" = "refs/mikrob/ckpt/cafebabe01/1" ] && ok "first checkpoint for a card is numbered /1" \
    || no "expected refs/mikrob/ckpt/cafebabe01/1, got $ref"

  git -C "$WT" cat-file -e "$sha" 2>/dev/null && ok "checkpoint commit object exists" \
    || no "checkpoint commit $sha does not exist"

  [ "$(git -C "$WT" rev-parse "$sha^")" = "$before_head" ] \
    && ok "checkpoint commit's parent is HEAD (-p HEAD pin)" \
    || no "checkpoint parent should be pre-checkpoint HEAD $before_head, got $(git -C "$WT" rev-parse "$sha^" 2>&1)"

  [ "$before_index_hash" = "$after_index_hash" ] && ok "real index file untouched (byte-identical)" \
    || no "index file CHANGED: $before_index_hash -> $after_index_hash"
  [ "$before_head" = "$after_head" ] && ok "HEAD untouched" || no "HEAD changed: $before_head -> $after_head"
  [ "$before_branch" = "$after_branch" ] && ok "current branch untouched" || no "branch changed: $before_branch -> $after_branch"
  [ "$before_stash" = "$after_stash" ] && ok "stash list untouched" || no "stash list changed"
  [ "$before_status" = "$after_status" ] && ok "working-tree status untouched" || no "working-tree status changed"

  # Checkpointed tree contains the staged + unstaged + untracked changes (the point of the
  # snapshot), proven by reading the commit's tree, not by re-deriving from the live worktree.
  tree_files="$(git -C "$WT" ls-tree -r --name-only "$sha")"
  if echo "$tree_files" | grep -qx staged.txt && echo "$tree_files" | grep -qx untracked.txt \
    && git -C "$WT" show "$sha:notes.txt" | grep -q modified; then
    ok "checkpoint tree captures staged + unstaged + untracked changes"
  else
    no "checkpoint tree missing expected files: $tree_files"
  fi

  # A second checkpoint for the SAME card gets the NEXT number, not a collision.
  out2="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$0" testagent cafebabe01)"
  ref2="$(echo "$out2" | awk '{print $1}')"
  [ "$ref2" = "refs/mikrob/ckpt/cafebabe01/2" ] && ok "a second checkpoint for the same card is numbered /2" \
    || no "expected refs/mikrob/ckpt/cafebabe01/2, got $ref2"

  # M1 (card 6ff6d1dc): >=4 concurrent checkpoints for the SAME card must end with that many
  # DISTINCT ref numbers -- fails on the pre-fix (Gate-SHA 6858f2bbf) check-then-act version, and
  # on a mutant that drops the old-value argument from update-ref, because two racing runs can
  # then read the same free n and the second silently overwrites the first instead of being
  # refused.
  run_wt concuragent >/dev/null
  conc_out="$(mktemp -d)"
  conc_pids=()
  for i in 1 2 3 4 5 6; do
    ( MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$0" concuragent deadc0de01 \
        >"$conc_out/$i.out" 2>"$conc_out/$i.err" ) &
    conc_pids+=("$!")
  done
  for p in "${conc_pids[@]}"; do wait "$p" || true; done
  conc_refs="$(cat "$conc_out"/*.out 2>/dev/null | awk '{print $1}' | sort -u | wc -l)"
  [ "$conc_refs" = 6 ] && ok "6 concurrent checkpoints for the same card produce 6 distinct refs (no collision)" \
    || no "expected 6 distinct refs from 6 concurrent runs, got $conc_refs ($(cat "$conc_out"/*.out 2>/dev/null | awk '{print $1}' | sort | tr '\n' ' '))"
  rm -rf "$conc_out"

  # L1 leak case (QA 28269 / Cybersec 28270, card 6ff6d1dc fix round): a forced mid-run failure
  # must leave 0 temp index files in TMPDIR -- the EXIT trap's whole point over the old RETURN
  # trap, which a mutant reverting it back would silently break. Forced via commit-tree failing
  # on "no git identity anywhere" (rc=128): a dedicated fixture with NO [user] section at all --
  # not even its own bootstrap commit goes through `git commit` (which would need an identity) --
  # built with write-tree + commit-tree, author/committer supplied only as env for that one call,
  # never written to config. The worktree's own per-worktree identity (agent-worktree-marveen.sh
  # sets one) is unset too, and HOME/the author/committer env vars are isolated for the actual
  # call under test so no ambient identity can leak in and make the failure flaky.
  failmain="$tmp/failmain"
  git init -q -b develop "$failmain"
  echo base > "$failmain/notes.txt"
  git -C "$failmain" add notes.txt
  failtree0="$(git -C "$failmain" write-tree)"
  failbase="$(GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t \
    git -C "$failmain" commit-tree "$failtree0" -m base)"
  git -C "$failmain" update-ref refs/heads/develop "$failbase"
  failorigin="$tmp/failorigin.git"
  git init -q --bare -b develop "$failorigin"
  git -C "$failmain" remote add origin "$failorigin"
  git -C "$failmain" push -q origin develop
  git -C "$failmain" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

  failroot="$tmp/fail-worktrees"
  MARVEEN_MAIN="$failmain" MARVEEN_WORKTREES="$failroot" bash "$HERE/agent-worktree-marveen.sh" failagent >/dev/null
  failwt="$failroot/failagent"
  git -C "$failwt" config --worktree --unset user.name
  git -C "$failwt" config --worktree --unset user.email

  failtmpdir="$tmp/forced-fail-tmpdir"
  mkdir -p "$failtmpdir" "$tmp/emptyhome"
  if out="$(env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
      HOME="$tmp/emptyhome" TMPDIR="$failtmpdir" \
      MARVEEN_MAIN="$failmain" MARVEEN_WORKTREES="$failroot" bash "$0" failagent beefcafe03 2>&1)"; then
    no "expected the forced no-identity commit-tree failure to make the script exit non-zero, got success: $out"
  else
    leftover="$(find "$failtmpdir" -type f | wc -l)"
    [ "$leftover" = 0 ] && ok "forced mid-run failure (commit-tree, no identity, rc=128) leaves 0 temp index files in TMPDIR" \
      || no "expected 0 leaked temp index files in TMPDIR after a forced failure, found $leftover: $(find "$failtmpdir" -type f)"
  fi

  # M1 follow-up (Cybersec 28270): a PERSISTENT update-ref failure that is NOT "reference already
  # exists" (e.g. a read-only refs directory -- stands in for a full disk or bad permissions) must
  # exit promptly with git's own error, not spin retrying n forever in silence.
  run_wt roagent >/dev/null
  # Worktrees share the MAIN repo's refs dir (only HEAD/index are per-worktree) -- the read-only
  # bit has to go on $TEST_MAIN's .git/refs, not the worktree's. -R: earlier cases already created
  # refs/mikrob/ckpt/... under here, so the write permission that matters is on that subdirectory,
  # not just the top-level "refs" entry.
  chmod -R -w "$TEST_MAIN/.git/refs"
  ro_start="$(date +%s)"
  if out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" timeout 5 bash "$0" roagent facefeed04 2>"$tmp/ro.err")"; then
    chmod -R +w "$TEST_MAIN/.git/refs"
    no "expected a persistent update-ref failure (read-only refs dir) to exit non-zero, got success: $out"
  else
    ro_rc=$?
    chmod -R +w "$TEST_MAIN/.git/refs"
    ro_elapsed=$(( $(date +%s) - ro_start ))
    ro_err="$(cat "$tmp/ro.err")"
    if [ "$ro_rc" != 124 ] && [ -n "$ro_err" ] && [ "$ro_elapsed" -le 4 ]; then
      ok "persistent update-ref failure (read-only refs dir) exits non-zero promptly (${ro_elapsed}s), stderr non-empty"
    else
      no "expected a prompt (<=4s, not a 124 timeout) non-zero exit with stderr, got rc=$ro_rc elapsed=${ro_elapsed}s stderr=$ro_err"
    fi
  fi

  # --- forgery binding + DB write wiring (card 0c03aa06, RedHat finding on 295ae6a3) -------------
  ckptdb="$tmp/ckpt-claudeclaw.db"
  sqlite3 "$ckptdb" "
    CREATE TABLE kanban_cards (id TEXT, assignee TEXT);
    CREATE TABLE card_checkpoints (
      card_id TEXT NOT NULL, n INTEGER NOT NULL, sha TEXT NOT NULL, head_sha TEXT NOT NULL,
      agent TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (card_id, n)
    );
    INSERT INTO kanban_cards VALUES ('deadbeef11', 'owneragent');
  "
  run_wt owneragent >/dev/null
  owner_head="$(git -C "$TEST_ROOT/owneragent" rev-parse HEAD)"

  # The card's real owner succeeds, and the row actually lands with the right columns.
  if out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" MARVEEN_DB="$ckptdb" \
      bash "$0" owneragent deadbeef11)"; then
    ok "the card's own owner can checkpoint it"
  else
    no "the card's own owner was refused: $out"
  fi
  row="$(sqlite3 "$ckptdb" "SELECT card_id, head_sha, agent FROM card_checkpoints WHERE card_id = 'deadbeef11'")"
  [ "$row" = "deadbeef11|$owner_head|owneragent" ] \
    && ok "the write actually lands in card_checkpoints, with the real HEAD and agent" \
    || no "expected deadbeef11|$owner_head|owneragent in card_checkpoints, got: $row"

  # An impostor (a different agent than the card's assignee) is refused, BEFORE anything is
  # created: no new git ref, no new row -- a refused forgery must leave no trace.
  run_wt impostoragent >/dev/null
  refs_before="$(git -C "$TEST_MAIN" for-each-ref 'refs/mikrob/ckpt/deadbeef11/' | wc -l)"
  rows_before="$(sqlite3 "$ckptdb" "SELECT COUNT(*) FROM card_checkpoints WHERE card_id = 'deadbeef11'")"
  if out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" MARVEEN_DB="$ckptdb" \
      bash "$0" impostoragent deadbeef11 2>&1)"; then
    no "an impostor agent was NOT refused: $out"
  else
    printf '%s' "$out" | grep -q "forgery binding" \
      && ok "an agent that is not the card's assignee is refused, with the forgery-binding message" \
      || no "refused, but not with the expected forgery-binding message: $out"
  fi
  refs_after="$(git -C "$TEST_MAIN" for-each-ref 'refs/mikrob/ckpt/deadbeef11/' | wc -l)"
  rows_after="$(sqlite3 "$ckptdb" "SELECT COUNT(*) FROM card_checkpoints WHERE card_id = 'deadbeef11'")"
  [ "$refs_before" = "$refs_after" ] && ok "a refused forgery creates no new checkpoint ref" \
    || no "refs/mikrob/ckpt/deadbeef11/ grew from $refs_before to $refs_after after a refused forgery"
  [ "$rows_before" = "$rows_after" ] && ok "a refused forgery writes no new row" \
    || no "card_checkpoints rows for deadbeef11 grew from $rows_before to $rows_after after a refused forgery"

  # Control: an UNKNOWN card (no kanban_cards row at all) is ambiguous, not provably forged, so the
  # fail-open posture lets it through -- same posture as _checkpoint_coverage's own count==0 case.
  if out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" MARVEEN_DB="$ckptdb" \
      bash "$0" owneragent deadbeef09)"; then
    ok "a card with no kanban_cards row at all fails open (ambiguous, not refused)"
  else
    no "an unknown card should fail open, not be refused: $out"
  fi

  # --- sweep selftest (card 1778f6ac F1.1.2) ---
  sweep_db="$tmp/sweep.db"
  sqlite3 "$sweep_db" "
    CREATE TABLE kanban_cards (id TEXT, status TEXT, updated_at INTEGER);
    INSERT INTO kanban_cards VALUES ('oldcard01', 'done', $(( $(date +%s) - 2*86400 )));
    INSERT INTO kanban_cards VALUES ('opencard2', 'in_progress', $(( $(date +%s) )));
  "
  sweep_head="$(git -C "$TEST_MAIN" rev-parse HEAD)"
  git -C "$TEST_MAIN" update-ref "refs/mikrob/ckpt/oldcard01/1" "$sweep_head"
  git -C "$TEST_MAIN" update-ref "refs/mikrob/ckpt/opencard2/1" "$sweep_head"

  dry_out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_DB="$sweep_db" bash "$0" --sweep --dry-run --older-than-days 1 2>&1)"
  echo "$dry_out" | grep -q "oldcard01" \
    && ok "sweep --dry-run lists old card's ref" \
    || no "sweep --dry-run missing old card: $dry_out"
  echo "$dry_out" | grep -q "opencard2" \
    && no "sweep --dry-run listed open card's ref (should not): $dry_out" \
    || ok "sweep --dry-run skipped open card"

  # F2 (card 0c03aa06, Cybered 31713): a dry-run that ALSO deletes (e.g. a `git update-ref -d`
  # mutant dropped next to the "would delete:" echo) previously stayed green, since nothing
  # checked the ref still existed after a dry-run -- only the printed text was asserted.
  if git -C "$TEST_MAIN" rev-parse --verify "refs/mikrob/ckpt/oldcard01/1" >/dev/null 2>&1; then
    ok "sweep --dry-run did not actually delete the old card's ref"
  else
    no "sweep --dry-run deleted a ref it should have only listed"
  fi

  MARVEEN_MAIN="$TEST_MAIN" MARVEEN_DB="$sweep_db" bash "$0" --sweep --older-than-days 1 >/dev/null
  if git -C "$TEST_MAIN" rev-parse --verify "refs/mikrob/ckpt/oldcard01/1" >/dev/null 2>&1; then
    no "old card's ref still exists after sweep"
  else
    ok "old card's refs removed after sweep"
  fi
  if git -C "$TEST_MAIN" rev-parse --verify "refs/mikrob/ckpt/opencard2/1" >/dev/null 2>&1; then
    ok "open card's ref kept after sweep"
  else
    no "open card's ref was deleted (should not)"
  fi

  # Huge --older-than-days (card 0c03aa06, WhiteHat2 finding on 295ae6a3; Cybered 31713 F1 delta).
  # The OLD pin used 999999999: a cutoff built from it goes deeply NEGATIVE under plain 64-bit
  # arithmetic, so it behaved identically whether or not a cap existed (vacuous -- it could never
  # go red). Measured: values like 1000000000000000 and 213503982334601 DO make the pre-fix
  # (uncapped) formula wrap and delete a just-done card's refs. The fix is a hard cap (36500 days,
  # 100 years) rather than trusting the arithmetic to stay negative, so EVERY value past the cap is
  # now rejected outright -- including the old 999999999 pin itself.
  huge_db="$tmp/huge-sweep.db"
  sqlite3 "$huge_db" "
    CREATE TABLE kanban_cards (id TEXT, status TEXT, updated_at INTEGER);
    INSERT INTO kanban_cards VALUES ('donetoday1', 'done', $(date +%s));
  "
  git -C "$TEST_MAIN" update-ref "refs/mikrob/ckpt/donetoday1/1" "$sweep_head"

  # At the cap (accepted): still correctly deletes nothing of a card done today.
  if huge_out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_DB="$huge_db" bash "$0" --sweep --dry-run --older-than-days 36500 2>&1)"; then
    printf '%s' "$huge_out" | grep -q "donetoday1" \
      && no "--older-than-days 36500 (at cap) dry-run would delete a card done TODAY: $huge_out" \
      || ok "--older-than-days 36500 (at cap) deletes nothing of a card done today"
  else
    no "--older-than-days 36500 (at cap) should be ACCEPTED, got refused: $huge_out"
  fi
  if git -C "$TEST_MAIN" rev-parse --verify "refs/mikrob/ckpt/donetoday1/1" >/dev/null 2>&1; then
    ok "--older-than-days 36500 (at cap) dry-run did not actually delete the today card's ref"
  else
    no "--older-than-days 36500 (at cap) dry-run deleted a ref it should have only listed"
  fi

  # Past the cap (rejected outright): the old vacuous pin (999999999) plus the two values that
  # measurably delete today's refs on the uncapped base.
  # F1b (Cybered 31725): 9223372036854775808 (2^63) and 18446744073709551615 (2^64-1) both wrap
  # the OLD bare-arithmetic cap check to a small/negative number and sailed under it -- the
  # string-length bound above must reject them before any arithmetic runs.
  for _huge_days in 999999999 1000000000000000 213503982334601 9223372036854775808 18446744073709551615; do
    if out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_DB="$huge_db" bash "$0" --sweep --dry-run --older-than-days "$_huge_days" 2>&1)"; then
      no "--older-than-days $_huge_days should have been rejected (cap 36500), got: $out"
    else
      printf '%s' "$out" | grep -q "too large" \
        && ok "--older-than-days $_huge_days is rejected (cap 36500)" \
        || no "--older-than-days $_huge_days refused, but not with the cap message: $out"
    fi
    if git -C "$TEST_MAIN" rev-parse --verify "refs/mikrob/ckpt/donetoday1/1" >/dev/null 2>&1; then
      ok "--older-than-days $_huge_days: today card's ref untouched after rejection"
    else
      no "--older-than-days $_huge_days: today card's ref is gone after a refused sweep"
    fi
  done

  # L3 (same card): a leading-zero value must not hit bash's octal arithmetic (base-10 pin).
  if MARVEEN_MAIN="$TEST_MAIN" MARVEEN_DB="$huge_db" bash "$0" --sweep --dry-run --older-than-days 08 >/dev/null 2>&1; then
    ok "--older-than-days 08 (leading zero) is accepted, not an octal arithmetic error"
  else
    no "--older-than-days 08 (leading zero) failed -- likely bash octal arithmetic"
  fi

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

if [ "${1:-}" = "--sweep" ]; then
  shift
  sweep_checkpoints "$@"
  exit 0
fi

[ $# -eq 2 ] || die 2 "usage: agent-checkpoint.sh <agent> <cardId>  |  agent-checkpoint.sh --selftest  |  agent-checkpoint.sh --sweep [--dry-run] [--older-than-days N]"
agent_checkpoint "$1" "$2"
