#!/usr/bin/env bash
# local_first_draft_enabled -- is the master local-first-draft kill-switch ON? (card d57d8a01, Peti
# Telegram 10951.)
#
# WHY THIS EXISTS. store/self-advance-pickup.sh already read a LOCAL_FIRST_DRAFT env var / a
# store/local-first-draft.json {"enabled": false} file, but it was the ONLY caller: card-build-
# route.sh, offload-dispatch.sh, route-classify.sh, gate-pretriage.sh, i18n-draft.sh,
# local-llm-rag.sh and local-llm.sh never looked at it at all, and the file itself could only be
# edited by hand. This file is the ONE place the read logic lives (DRY, same reason
# landing-gate-verdict-check.sh/downward-check.sh etc. are shared rather than copied seven times),
# and src/web/routes/local-llm.ts's new /api/local-llm/first-draft-enabled endpoint + the dashboard
# toggle are the ONE place it gets WRITTEN -- so "single source of truth" is true on both axes.
#
# Precedence: an explicit LOCAL_FIRST_DRAFT env var (the literal string "off" disables, anything
# else is ON) wins over the file; a file that EXISTS but is unreadable/unparseable means ON
# (plan-grilling point 2: a config hiccup never silently stops every local-first path -- WhiteHat2
# measured this as LOW, not blocking, card d57d8a01 comment 16744, so it stays unchanged here).
#
# QA FAIL 16742 + WhiteHat2 NO-GO 16744 (card d57d8a01, MikroB decision 16743, B1): the flag file's
# path used to be `$(dirname "${BASH_SOURCE[0]}")/local-first-draft.json` -- the CALLING SCRIPT's
# own, version-controlled directory. Every one of this card's 7+ entry points is a runnable copy
# that lands in every agent worktree (the root CLAUDE.md's OWN mandatory "saját worktree" rule),
# while the dashboard's POST /api/local-llm/first-draft-enabled writes into the RUNNING INSTALL's
# store/ -- different directories in every worktree but the install itself, and store/ is
# gitignored, so the worktree copy never has the file at all. This is the exact defect card
# b536501e already named and fixed for MODEL_FILE (see local-llm-state-dir.sh's own header) --
# that fix just never got reused here. Resolved the same way now: via
# resolve_local_llm_state_dir(), reusing an ALREADY-resolved LOCAL_LLM_STATE_RESOLVED if a caller
# (local-llm.sh, local-llm-rag.sh) set one before sourcing this file, so this never resolves twice
# or prints a second announce line for the same process.
#
# MikroB decision 16743, B1, PARTIALLY NOT IMPLEMENTED AS LITERALLY WORDED, measured and reported
# back rather than applied blind: the decision also said a missing flag file should flip from ON
# to fail-closed OFF. Implemented and fleet-tested first -- it reproduced the worktree-resolution
# fix correctly, but ALSO turned 29 pre-existing, unrelated, already-shipped tests across 9 files
# red (route-classify's GPU-busy-early-exit, local-llm.sh's --task allowlist/GPU-abstain/active-
# task-registration, local-llm-rag's routing-by-default, store-selftests-all-run's own selftest
# wrappers): every one of them runs without ever writing a flag file, which the OLD "absence = ON"
# default let pass through to the actual logic under test; with the file now resolved CORRECTLY
# (this round's real fix) but absent by design in those fixtures, every one of them hit "local-
# first-draft is OFF" before reaching what it meant to test. Root CLAUDE.md rule 7 ("eltünő/
# gyengülő teszt = FAIL, nem 'tisztább kód'") and rule 5 (a working, already-gated feature is not
# silently reverted) both say stop here, not patch 9 unrelated cards' fixtures to route around a
# default-value change this round does not need to make. The MEASURED defect (QA 16742, WhiteHat2
# 16744) was the WRONG DIRECTORY, not the wrong default for "not found at all" -- the resolution
# fix above closes that completely on its own (a correctly-resolved, EXISTING {"enabled":false}
# file is now honoured everywhere). Absence therefore stays ON, unchanged from the original
# plan-grilling point 2 ruling; reported to MikroB for a final call rather than silently kept.
#
# Usage:
#   . "$(dirname "$0")/local-first-draft-check.sh"
#   if local_first_draft_enabled; then ... else echo "... -> ONLINE" >&2; fi
#
# Env override (tests only): LOCAL_FIRST_DRAFT_FLAG_FILE.
local_first_draft_enabled() {
  local flag_file="${LOCAL_FIRST_DRAFT_FLAG_FILE:-}"
  if [ -z "$flag_file" ]; then
    local here state_dir
    here="$(dirname "${BASH_SOURCE[0]}")"
    state_dir="${LOCAL_LLM_STATE_RESOLVED:-}"
    if [ -z "$state_dir" ]; then
      if [ -r "$here/local-llm-state-dir.sh" ]; then
        # shellcheck source=./local-llm-state-dir.sh
        . "$here/local-llm-state-dir.sh"
        resolve_local_llm_state_dir "$here"
        state_dir="$LOCAL_LLM_STATE_RESOLVED"
      else
        state_dir="$here"
      fi
    fi
    flag_file="$state_dir/local-first-draft.json"
  fi
  local value="${LOCAL_FIRST_DRAFT:-}"
  if [ -z "$value" ]; then
    if [ -f "$flag_file" ]; then
      value="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print("off" if d.get("enabled") is False else "on")
except Exception:
    print("on")
' "$flag_file" 2>/dev/null)"
      [ -n "$value" ] || value="on"
    else
      # Absence = ON (plan-grilling point 2, unchanged -- see the header comment above for why
      # MikroB's fail-closed-OFF wording was measured and NOT applied here).
      value="on"
    fi
  fi
  [ "$value" != "off" ]
}
