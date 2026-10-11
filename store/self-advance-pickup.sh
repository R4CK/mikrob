#!/usr/bin/env bash
# self-advance-pickup.sh <agent> <cardId> -- the single entry point a self-advancing role-agent calls
# when it picks its own next planned card (root CLAUDE.md rule 11a), instead of hand-curling
# `POST /api/kanban/<id>/move {"status":"in_progress"}` itself.
#
# WHY THIS EXISTS (card 3906d77b, Peti Telegram 8748/8835): the heartbeat's own C section 4b step
# already runs card-build-route.sh before MikroB dispatches a card to another agent, and if the
# verdict is LOCAL, puts the local-llm-rag.sh command straight into the dispatch message. But that
# path only fires when MikroB itself picks the card up. A role-agent's SELF-advance pickup (11a) is a
# different code path entirely -- prose in CLAUDE.md that each agent's own turn follows -- and nothing
# on it ever called the router. MEASURED: card-build-route.log's last entry before this card was
# 2026-09-18 08:41; every card picked up by self-advance since then never reached the router at all.
# "Local-first" therefore lived on exactly one of the fleet's two dispatch paths.
#
# What this does, IN ORDER, and every step fails toward "pick the card up anyway":
#   0. INSTALLED GATE (Peti Telegram 8928, 2026-09-19): "ha nincs telepitve local-llm akkor ez az ag
#      el se induljon" -- local-llm-installed.sh, a network-free ollama-binary + configured-model
#      check. NOT installed -> the whole branch (steps 1-4) is skipped, one log line, straight to
#      step 5, exactly like LOCAL_FIRST_DRAFT=off. This is a DIFFERENT state from "installed but not
#      running" (step 2's health check) -- a host that never ran first-run-llm.sh should never pay a
#      classify pipeline's timeout budget discovering that on its own.
#   1. LOCAL_FIRST_DRAFT flag (env var, or store/local-first-draft.json {"enabled":false}). Default ON;
#      the flag's ABSENCE means ON. OFF skips straight to step 5 -- the pre-3906d77b self-advance
#      behaviour: PUT in_progress, no draft attempt, exactly like the flag never existed.
#   2. Ollama health check FIRST (plan-grilling point 3): `local-llm.sh --health`, the SAME check
#      local-llm.sh's own --mode health already performs -- not reinvented. Down -> one log line,
#      skip straight to step 5. This is a genuinely measured failure mode: Ollama did not survive the
#      2026-09-18 07:21 WSL restart and stayed down until 08:22 (MikroB, comment 5355) -- without a
#      fast explicit check here, every leaf attempt inside offload-dispatch.sh would instead spend its
#      own internal timeout budget discovering the same thing, one leaf at a time.
#   3. card-build-route.sh <cardId>, with CARD_BUILD_ROUTE_DISPATCHER=self-advance exported so the log
#      (and card-build-route-24h-measure.sh's dispatcher breakdown) can tell this call apart from the
#      heartbeat's own orchestrator-dispatch calls -- the actual measurement gap this card was opened to close.
#   4. LOCAL verdict -> offload-dispatch.sh <cardId> <agent>. That script already resolves the card's
#      open leaves, posts the "LOCAL-LLM DRAFT" comment itself, and nudges the owner -- nothing here
#      duplicates that. A non-LOCAL verdict (or offload-dispatch finding nothing local-eligible) simply
#      leaves the card undrafted, exactly like today.
#   4b. CARD-WORKTREE (card cd3e577b, F1 of the b8ac0ef1 "software factory" phase), independent of
#      steps 0-4 above (local-llm) -- gated by its OWN flag, MARVEEN_CARD_WORKTREE, default OFF
#      (plan-grilling change 4: "kapcsolo OFF -> a mai ut"). ON means: if this card looks like a
#      marveen-repo card (see SCOPING below), create/top up a PER-CARD worktree+branch
#      (card/<cardId>, via agent-worktree-marveen.sh --card) instead of leaving the agent to keep
#      committing this card's work onto its own shared agent/<agent>/work branch -- the structural
#      fix for the class measured three times on 2026-10-11 (1cdac111 riding along inside
#      c40385b1's landing, watched-repos.json inside e25a549a's, and 21abfe0b's two commits inside
#      9835e4ff's). Best-effort and NEVER blocks the pickup, same contract as steps 0-4.
#
#      SCOPING (a judgment call, stated here rather than left implicit): self-advance-pickup.sh is
#      called for EVERY card any agent picks up, marveen-repo infra cards and ordinary mopsion
#      product cards alike. Creating a marveen branch/worktree for a mopsion card would be noise,
#      not help. There is no reliable structural signal for "this card touches the marveen repo" --
#      the board's own `project` field is inconsistent (measured 2026-10-11: 334 of 663 cards carry
#      no project at all, including this very card and its parent phase). The one signal measured
#      to be reliable is the `[MikroB]` title tag this fleet already uses for its own fleet/infra
#      cards: of 105 cards explicitly tagged project=mopsion, only 1 also carried `[MikroB]` in its
#      title; of 224 cards tagged project=MikroB, correlation the other way (title tag absent) was
#      common, but that only means some untagged MikroB cards are missed here (harmless -- the
#      agent falls back to today's behaviour for them), never that a mopsion card is wrongly
#      claimed. So: ON + `[MikroB]` in the card's title -> attempt the card-worktree; any other
#      case (flag OFF, title fetch fails, or no tag) -> skip silently, today's behaviour.
#
#      CLEANUP (plan-grilling change 2: "egy ugynok egyszerre legfeljebb 1 kartya-worktree-t
#      tartson nyitva"). Before creating the new one, if this agent's previous card-worktree marker
#      names a DIFFERENT card that the board now reports as `done`, that worktree is removed (the
#      BRANCH is never touched -- it is already merged, per requirement 5 of the card). A previous
#      card that is NOT done yet (still in_progress/waiting -- e.g. sent back by a NO-GO) is left
#      alone; removing a worktree with live, uncommitted work in it would be the wrong kind of
#      cleanup.
#
#   5. PUT the card to in_progress, actor=<agent>. This is the ONE step that always runs, in every
#      branch above -- drafting is advisory, pickup is not, and so is the card-worktree step.
#
# Usage: self-advance-pickup.sh <agent> <cardId>
# Exit 0 on a successful pickup (steps 1-4 are all best-effort and never change the exit code).
# Exit 1 only if step 5 itself fails (no token, or the API call did not return 200) -- the one failure
# the caller actually needs to react to, since nothing else in this script blocks the pickup.
# Exit 2 on bad usage.
#
# SECURITY: the dashboard token is never placed in argv -- read from file, sent via stdin header
# (`-H @-`), the fleet-wide pattern (token-in-argv-guard.test.ts enforces this repo-wide).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM="${SELF_ADVANCE_PICKUP_LLM:-$HERE/local-llm.sh}"
ROUTE="${SELF_ADVANCE_PICKUP_ROUTE:-$HERE/card-build-route.sh}"
OFFLOAD="${SELF_ADVANCE_PICKUP_OFFLOAD:-$HERE/offload-dispatch.sh}"
INSTALLED="${SELF_ADVANCE_PICKUP_INSTALLED:-$HERE/local-llm-installed.sh}"
API="${SELF_ADVANCE_PICKUP_API:-http://localhost:3420}"
TOKEN_FILE="${SELF_ADVANCE_PICKUP_TOKEN_FILE:-$HERE/.dashboard-token}"
FLAG_FILE="${SELF_ADVANCE_PICKUP_FLAG_FILE:-$HERE/local-first-draft.json}"
LOG="${SELF_ADVANCE_PICKUP_LOG:-$HERE/card-build-route.log}"
# Card cd3e577b (F1), step 4b.
MARVEEN_WORKTREE_SCRIPT="${SELF_ADVANCE_PICKUP_WORKTREE_SCRIPT:-$HERE/agent-worktree-marveen.sh}"
MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
CARD_WORKTREE_MARKER_DIR="${SELF_ADVANCE_PICKUP_MARKER_DIR:-$HERE/.marveen-card-worktree-markers}"

AGENT="${1:-}"
CARD_ID="${2:-}"
if [ -z "$AGENT" ] || [ -z "$CARD_ID" ]; then
  echo "usage: self-advance-pickup.sh <agent> <cardId>" >&2
  exit 2
fi
# A card id is a hex slug, same guard card-build-route.sh uses -- refuse anything else rather than
# interpolating it into a URL or a shell command below.
if ! printf '%s' "$CARD_ID" | grep -Eq '^[0-9a-f]{6,40}$'; then
  echo "self-advance-pickup: bad card id '$CARD_ID'" >&2
  exit 2
fi

# EVIDENCE THAT THIS RAN, on the SAME log card-build-route.sh writes to, so a reader piecing together
# "why did/didn't card X get a draft" has one file to look at, not two. A SKIP line here (flag off,
# Ollama down) is deliberately shaped like a card-build-route.sh verdict line -- same field count, same
# tab layout -- so card-build-route-24h-measure.sh's capacity-reason regex can recognise it later if a
# future measurement wants to (it does not need to today; these two reasons never reach that script
# today because they short-circuit before card-build-route.sh would have logged anything at all).
log_skip() { # $1 = reason
  printf '%s\t%s\tONLINE\t%s\tcalls=0\tchars=0\tdispatcher=self-advance\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$CARD_ID" "$1" >> "$LOG" 2>/dev/null || true
}

# --- 0. INSTALLED GATE, BEFORE ANYTHING ELSE (Peti Telegram 8928, 2026-09-19): "ha nincs telepitve
# local-llm akkor ez az ag el se induljon". A cheap, network-free precheck -- see
# local-llm-installed.sh's own header for why this is not the same question as "is it running".
# Checked once, up front: everything below (the flag, the health check, the classifier) is moot on
# a host that never had a local model installed at all.
LOCAL_LLM_INSTALLED=0
bash "$INSTALLED" >/dev/null 2>&1 && LOCAL_LLM_INSTALLED=1

# --- 1. FLAG --------------------------------------------------------------------------------------
# card d57d8a01: the read logic itself now lives in local-first-draft-check.sh (shared with every
# other local-first entry point, DRY), not duplicated here. LOCAL_FIRST_DRAFT_FLAG_FILE lets this
# script keep its own FLAG_FILE override (tests already rely on SELF_ADVANCE_PICKUP_FLAG_FILE).
# shellcheck source=./local-first-draft-check.sh
. "$HERE/local-first-draft-check.sh"
LOCAL_FIRST_DRAFT_FLAG_FILE="$FLAG_FILE"

if [ "$LOCAL_LLM_INSTALLED" -eq 0 ]; then
  echo "local-llm: not installed, branch skipped" >&2
  log_skip not-installed
elif ! local_first_draft_enabled; then
  echo "self-advance-pickup: $CARD_ID -> LOCAL_FIRST_DRAFT=off, skipping local draft" >&2
  log_skip flag-off
else
  # --- 2. OLLAMA HEALTH, BEFORE ANYTHING ELSE (plan-grilling point 3) ------------------------------
  if ! bash "$LLM" --health >/dev/null 2>&1; then
    echo "self-advance-pickup: $CARD_ID -> ollama down, skipping local draft (never blocks pickup)" >&2
    log_skip ollama-down
  else
    # --- 3. CLASSIFY, ATTRIBUTED TO self-advance ----------------------------------------------------
    VERDICT="$(CARD_BUILD_ROUTE_DISPATCHER=self-advance bash "$ROUTE" "$CARD_ID" 2>/dev/null | tr -d '[:space:]')"
    if [ "$VERDICT" = "LOCAL" ]; then
      # --- 4. DRAFT. offload-dispatch.sh posts its own "LOCAL-LLM DRAFT" comment and nudge; nothing
      # here duplicates that. Its own output goes to stderr so it never corrupts this script's stdout.
      bash "$OFFLOAD" "$CARD_ID" "$AGENT" >&2 || true
    fi
  fi
fi

# --- 4b. CARD-WORKTREE (card cd3e577b) -------------------------------------------------------------
# Best-effort, same contract as steps 0-4: every failure here is logged to stderr and swallowed,
# never changes the exit code, never blocks step 5.
if [ "${MARVEEN_CARD_WORKTREE:-}" = "1" ]; then
  _board_card_field() { # $1 = card id, $2 = field name -> prints the value, or nothing on failure
    local id="$1" field="$2" tok
    tok="$(cat "$TOKEN_FILE" 2>/dev/null)"
    [ -n "$tok" ] || return 0
    printf 'Authorization: Bearer %s\n' "$tok" \
      | timeout 10 curl -H @- -s "$API/api/kanban" 2>/dev/null \
      | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for r in rows if isinstance(rows, list) else []:
    if r.get("id") == sys.argv[1]:
        print(r.get(sys.argv[2]) or ""); break
' "$id" "$field" 2>/dev/null
  }

  TITLE="$(_board_card_field "$CARD_ID" title)"
  case "$TITLE" in
    *'[MikroB]'*)
      mkdir -p "$CARD_WORKTREE_MARKER_DIR" 2>/dev/null
      MARKER="$CARD_WORKTREE_MARKER_DIR/$AGENT"
      PREV_CARD="$(cat "$MARKER" 2>/dev/null || true)"
      if [ -n "$PREV_CARD" ] && [ "$PREV_CARD" != "$CARD_ID" ]; then
        PREV_STATUS="$(_board_card_field "$PREV_CARD" status)"
        if [ "$PREV_STATUS" = "done" ]; then
          PREV_PATH="$(bash "$MARVEEN_WORKTREE_SCRIPT" "$AGENT" --card "$PREV_CARD" --path 2>/dev/null)"
          if [ -n "$PREV_PATH" ]; then
            # R2 (RedHat NO-GO 16276): the card's own status ("done") was being trusted as proof the
            # branch actually landed, and --force threw away whatever was on disk either way --
            # measured: a done card whose card/<id> branch never reached origin/<default> (merge
            # raced, or the card closed without a landing at all) lost its own uncommitted file
            # silently, with the branch left behind unreachable from anywhere a human would look.
            # merge-base --is-ancestor is the actual, checkable claim "done" was standing in for;
            # dropping --force means a genuinely dirty/unpushed tree refuses to remove instead of
            # being thrown away.
            _psab_default="$(git -C "$MARVEEN_MAIN" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
            [ -n "$_psab_default" ] || _psab_default="develop"
            if git -C "$MARVEEN_MAIN" merge-base --is-ancestor "card/$PREV_CARD" "origin/$_psab_default" 2>/dev/null; then
              git -C "$MARVEEN_MAIN" worktree remove "$PREV_PATH" >/dev/null 2>&1 \
                && echo "self-advance-pickup: removed done card $PREV_CARD's worktree ($PREV_PATH) -- branch card/$PREV_CARD is untouched" >&2 \
                || echo "self-advance-pickup: card $PREV_CARD's branch is landed but the worktree ($PREV_PATH) would not remove cleanly (dirty/unpushed?) -- left in place, check by hand" >&2
            else
              echo "self-advance-pickup: card $PREV_CARD is done but card/$PREV_CARD is NOT an ancestor of origin/$_psab_default -- worktree ($PREV_PATH) kept, not removed" >&2
            fi
          fi
        fi
      fi
      if bash "$MARVEEN_WORKTREE_SCRIPT" "$AGENT" --card "$CARD_ID" >&2; then
        printf '%s' "$CARD_ID" > "$MARKER" 2>/dev/null
      fi
      ;;
    *)
      echo "self-advance-pickup: $CARD_ID -> no [MikroB] title tag (or title unreadable), skipping card-worktree" >&2
      ;;
  esac
fi

# --- 5. THE PICKUP ITSELF, ALWAYS ------------------------------------------------------------------
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
if [ -z "$TOKEN" ]; then
  echo "self-advance-pickup: no dashboard token at $TOKEN_FILE, cannot PUT in_progress" >&2
  exit 1
fi
BODY="$(python3 -c 'import json,sys; print(json.dumps({"status":"in_progress","actor":sys.argv[1],"reason":"self-advance pickup"}))' "$AGENT")"
HTTP_CODE="$(printf 'Authorization: Bearer %s\n' "$TOKEN" \
  | timeout 10 curl -H @- -s -o /dev/null -w '%{http_code}' -X POST "$API/api/kanban/$CARD_ID/move" \
    -H 'Content-Type: application/json' -d "$BODY" 2>/dev/null)"
if [ "$HTTP_CODE" != "200" ]; then
  echo "self-advance-pickup: $CARD_ID -> PUT in_progress FAILED (http ${HTTP_CODE:-no-response})" >&2
  exit 1
fi
echo "self-advance-pickup: $CARD_ID -> in_progress (actor=$AGENT)"
exit 0
