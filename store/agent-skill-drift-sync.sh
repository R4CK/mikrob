#!/usr/bin/env bash
# agent-skill-drift-sync.sh -- close the THIRD skill-propagation gap (card 84b304c1).
#
# WHY THIS EXISTS. A skill fix in seed-skills/<name>/SKILL.md reaches two places automatically:
#   1. $HOME/.claude/skills/<name>/SKILL.md   -- update.sh's refresh_untouched_seeds (update.sh:710)
#   2. seed-fleet-agents/<agent>/.claude/skills/<name>/SKILL.md -- seeded ONCE, when a NEW agent is
#      created (install-linux.sh), never touched again by design.
# A THIRD copy exists that nothing syncs: agents/<agent>/.claude/skills/<name>/SKILL.md -- the live,
# gitignored (.gitignore:58) per-agent skill copy an ALREADY-RUNNING agent actually reads at runtime.
# Measured concretely (2026-08-27, Cybersec finding on card 843abd91 comment #16871): after
# cybered-gate-pattern was fixed (commit d85602e6, seed-skills/cybered-gate-pattern/SKILL.md), the
# global ~/.claude/skills copy healed correctly via update.sh, but
# agents/cybered/.claude/skills/cybered-gate-pattern/SKILL.md stayed on stale content -- Cybered would
# keep running fixed-away-from-but-still-broken instructions until its next full re-seed (never, in
# practice: re-seeding only happens for a brand-new agent).
#
# SAFETY (the reason this is not a blind whole-file sync, per this fleet's own "Skill patch (runtime
# javitas)" convention in CLAUDE.md -- an agent is EXPECTED to be able to hand-patch its own live skill
# copy mid-session, and this tool must never silently clobber that). A live copy is only auto-synced
# when it is byte-identical to SOME commit we actually shipped -- i.e. provably just stale, never
# independently edited. This mirrors update.sh's seed_copy_is_untouched (update.sh:600) exactly:
#   - render each of the last HIST_CAP commits of the canonical seed-skills/<name>/SKILL.md with this
#     install's identity placeholders ({{INSTALL_DIR}}, {{MAIN_AGENT_ID}}, {{BOT_NAME}}, {{OWNER_NAME}},
#     {{WEB_PORT}}) and hash it;
#   - also accept the UNRENDERED historical blob's hash (same reasoning as update.sh's comment at
#     seed_copy_is_untouched: a copy can be byte-identical to what we shipped and still carry a raw
#     placeholder, if it was seeded before rendering applied to this path);
#   - if the live copy's hash matches ANY of those -> STALE, safe to auto-sync (--apply only).
#   - if it matches NONE of them -> DIVERGED. Never overwritten, ever -- flagged for manual review only,
#     even under --apply. There is no "old pre-fix seed content" fallback beyond git history: if a
#     skill's whole history is one commit, "diverged" is also what a hand-edited copy of that one
#     version looks like, and treating that as safe-to-sync would be exactly the silent clobber this
#     tool exists to prevent.
#   - a live skill directory with NO seed-skills/<name> counterpart at all (agent-specific skill, never
#     centrally tracked -- e.g. backend's shared-checkout-safe-commit) has nothing to compare against:
#     skipped, not flagged as diverged (diverged implies drift FROM a canonical baseline that exists).
#
# Usage:
#   agent-skill-drift-sync.sh                  # dry-run report over every live agent, all skills
#   agent-skill-drift-sync.sh --apply          # actually sync STALE copies (diverged untouched)
#   agent-skill-drift-sync.sh --agent cybered   # limit to one agent (repeatable)
#   agent-skill-drift-sync.sh --skill cybered-gate-pattern  # limit to one skill (repeatable)
#   agent-skill-drift-sync.sh --telegram       # compact summary only, for Telegram/heartbeat reporting
#   agent-skill-drift-sync.sh selftest         # fixture-based checks against a throwaway git repo
#
# SECOND CHECK, same file (card a6abb230, Peti complaint 2026-09-18): clone-family MISSING skills.
# The pass above answers "is this agent's copy of a CENTRALLY TRACKED skill stale/diverged" -- it says
# nothing about an agent-specific skill (never in seed-skills/, e.g. backend's
# shared-checkout-safe-commit) that one sibling in a clone family (backend<->backend2<->backend3,
# qa<->qa2, fron-ted<->fron-teddy) has and another does not. MEASURED root cause of the complaint: the
# seed-fleet-agents/<clone> sources a NEW clone is provisioned from had drifted stale themselves
# (backend3's seed had 0 of 19 family skills) -- this second pass is the runtime backstop for the
# family ever going out of sync again, the seed fix itself is a one-time normalization (not this
# script's job). For each family, the union of skill directory names across its PRESENT live members
# is the target; any present member missing one is reported, and under --apply the missing directory
# is copied WHOLESALE from whichever sibling has it (first found, family list order) -- never
# overwriting an existing directory, so this can only ever ADD a skill, never touch one already there.
# Same running-agent fail-closed guard as the stale pass (_agent_running_state) applies: a live agent
# may be reading its own skills dir at that instant, so a missing-skill sync into a RUNNING or
# UNDETERMINED agent is skipped and retried next run, exactly like a stale sync is.
#
# EVERY RUN ENDS WITH A VERDICT LINE, and callers should key on it rather than on the counts
# (card 222fdc5e):
#   ALERT:no  (diverged set unchanged since <when>, N entries; stale=0, no concurrent-write skips)
#   ALERT:yes reasons=<comma-list> diverged=N stale=N skipped-concurrent=N skipped-running=N
#             skipped-undetermined=N missing=N
# reasons: stale-synced | concurrent-write-skipped | running-agent-skipped |
#          undetermined-agent-skipped | diverged-set-changed | no-baseline | baseline-unreadable |
#          no-agents-dir | missing-synced | missing-running-agent-skipped |
#          missing-undetermined-agent-skipped
#
# `skipped-running` is the count of stale copies left alone because their agent was CONFIRMED
# running (card e667c8bd). `skipped-undetermined` (card 75b90343 part 2) is a DIFFERENT count: tmux
# could not be read at all, so the tool cannot tell running from parked and fails closed the same
# way -- but conflating the two into one "is RUNNING" label would tell an operator that every agent
# in that count is genuinely busy, when some of them are simply unreadable. Both are work still
# owed, not an error -- the copy stays exactly as stale as it already was, and the next run
# re-checks. See _agent_running_state for why the write is refused in both cases.
#
# PRE-EXISTING IMPRECISION, noted rather than changed here: `stale-synced` fires whenever STALE>0,
# including on a DRY RUN where nothing was written. That predates this card and has its own
# consumers; the `skipped-running` field exists partly so a reader can tell the two apart until
# somebody fixes the label properly.
# The diverged SET (not its size) is what is remembered, in $AGENT_SKILL_DRIFT_STATE
# (default store/agent-skill-drift-state.json), and ONLY --apply advances that baseline.
#
# Env overrides (all exist so a selftest never touches the live install):
#   AGENT_SKILL_DRIFT_ROOT / _AGENTS_DIR / _SEEDS_DIR / _STATE
#   AGENT_SKILL_DRIFT_TEST_RACE=<skill>  test-only; COMPARED, never executed
#   AGENT_SKILL_DRIFT_TEST_SESSIONS=<newline-separated session names>  test-only; stands in for
#     `tmux list-sessions` output so the selftest drives the REAL matching code. Setting it to the
#     empty string claims nothing is running -- which is why it is named as a test hook and why the
#     unset case always does the real check.
#
# Exit: 0 always (report tool, not a gate) -- selftest exits 1 on failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AGENT_SKILL_DRIFT_ROOT:-$(cd "$HERE/.." && pwd)}"
AGENTS_DIR="${AGENT_SKILL_DRIFT_AGENTS_DIR:-$ROOT/agents}"
SEEDS_DIR="${AGENT_SKILL_DRIFT_SEEDS_DIR:-$ROOT/seed-skills}"
# Card 85521c7e F2: the per-CLONE tracked seed (distinct from SEEDS_DIR above, which is the single
# canonical seed-skills/<name> copy) -- the missing-skill copy source below, never a sibling's live
# directory.
SEED_FLEET_DIR="${AGENT_SKILL_DRIFT_SEED_FLEET_DIR:-$ROOT/seed-fleet-agents}"
HIST_CAP=25   # same cap update.sh's seed_copy_is_untouched uses -- a skill unfixed for 25+
              # revisions is not worth the extra git calls (update.sh:605-606).

# Where the last APPLIED diverged set is remembered, so a routine run can stay quiet (card 222fdc5e).
# Overridable for the same reason the paths above are: a selftest must never touch the live state.
STATE="${AGENT_SKILL_DRIFT_STATE:-$ROOT/store/agent-skill-drift-state.json}"

# F1 STOPGAP + F2 FIX (card 85521c7e, Cybersec GO on a6abb230). scan_missing_skills() used to copy
# from a sibling's LIVE .claude/skills/<name> directory, not from the tracked seed-fleet-agents
# source -- a skill absent from git (e.g. adopted by hand, curl|sh install instructions, a stray
# symlink pointing outside the skill directory) reached --apply and got propagated to every other
# family member, bypassing the CLAUDE.md skill-quarantine invariant entirely. Measured live:
# exactly this happened, two siblings picked up an unreviewed skill plus an out-of-directory
# symlink in one --apply run. F1 forced this flag to 0 (report-only, no matter --apply) as an
# immediate stopgap. F2 (this flag back to 1) closes the actual gap: the copy source is now
# _seed_fleet_src() (seed-fleet-agents only, never a live sibling directory -- an untracked
# live-only skill is reported, never copied) and every copy is refused if its source directory
# contains a symlink resolving outside itself (_dir_has_escaping_symlink). Re-disable this flag
# again if either of those two functions is ever weakened without a matching safety review.
MISSING_SYNC_APPLY_ENABLED=1

APPLY=0
TELEGRAM=0
ONLY_AGENTS=()
ONLY_SKILLS=()
MODE=report
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)    APPLY=1; shift ;;
    --telegram) TELEGRAM=1; shift ;;
    --agent)    ONLY_AGENTS+=("$2"); shift 2 ;;
    --skill)    ONLY_SKILLS+=("$2"); shift 2 ;;
    selftest)   MODE=selftest; shift ;;
    -h|--help)  sed -n '/^# Usage:/,/^# Exit:/p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "agent-skill-drift-sync: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# --- identity values for placeholder rendering -- same source update.sh:655 uses -------------------
_env_val() {
  key="$1"; def="$2"
  if [ -f "$ROOT/.env" ]; then
    v="$(sed -n "s/^${key}=//p" "$ROOT/.env" | head -1 | tr -d '"\r')"
    [ -n "$v" ] && { printf '%s' "$v"; return; }
  fi
  printf '%s' "$def"
}
MAIN_AGENT_ID="$(_env_val MAIN_AGENT_ID mikrob)"
BOT_NAME="$(_env_val BOT_NAME MikroB)"
OWNER_NAME="$(_env_val OWNER_NAME Peti)"
WEB_PORT="$(_env_val WEB_PORT 3420)"

render_seed_template() {
  sed -e "s/{{MAIN_AGENT_ID}}/${MAIN_AGENT_ID:-}/g" \
      -e "s/{{BOT_NAME}}/${BOT_NAME:-}/g" \
      -e "s/{{OWNER_NAME}}/${OWNER_NAME:-}/g" \
      -e "s|{{INSTALL_DIR}}|${ROOT}|g" \
      -e "s|{{PROJECT_ROOT}}|${ROOT}|g" \
      -e "s/{{WEB_PORT}}/${WEB_PORT:-3420}/g"
}

_hash() { shasum -a 256 | awk '{print $1}'; }

# Prints one of: current | stale | diverged | no-canonical
# $1 = live installed file, $2 = repo-relative canonical path (e.g. seed-skills/<name>/SKILL.md)
classify_copy() {
  installed="$1"; rel="$2"
  [ -f "$ROOT/$rel" ] || { echo "no-canonical"; return; }
  cur="$(_hash <"$installed")"
  [ -n "$cur" ] || { echo "no-canonical"; return; }

  want_current="$(render_seed_template <"$ROOT/$rel" | _hash)"
  if [ "$cur" = "$want_current" ]; then
    echo "current"
    return
  fi

  blobtmp="$(mktemp)"
  for blob in $(git -C "$ROOT" log --format=%H -n "$HIST_CAP" -- "$rel" 2>/dev/null); do
    # A `git show` that ERRORS (e.g. this historical commit deleted the file) produces empty
    # stdout -- indistinguishable from a genuinely empty live file if we just hash whatever came
    # out of the pipe (both hash to the empty-string sha256). Capture to a temp file and check
    # the exit status explicitly; only a successful `git show` counts as real content to compare
    # against. Using a temp file (not a `content="$(...)"` capture) also avoids stripping
    # trailing newlines, which would otherwise corrupt the hash of real content.
    if ! git -C "$ROOT" show "$blob:$rel" >"$blobtmp" 2>/dev/null; then
      continue
    fi
    rendered="$(render_seed_template <"$blobtmp" | _hash)"
    if [ "$cur" = "$rendered" ]; then rm -f "$blobtmp"; echo "stale"; return; fi
    raw="$(_hash <"$blobtmp")"
    if [ "$cur" = "$raw" ]; then rm -f "$blobtmp"; echo "stale"; return; fi
  done
  rm -f "$blobtmp"
  echo "diverged"
}

_wanted_agent() {
  [ ${#ONLY_AGENTS[@]} -eq 0 ] && return 0
  for a in "${ONLY_AGENTS[@]}"; do [ "$a" = "$1" ] && return 0; done
  return 1
}
_wanted_skill() {
  [ ${#ONLY_SKILLS[@]} -eq 0 ] && return 0
  for s in "${ONLY_SKILLS[@]}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}

# --- is the target agent RUNNING? (card e667c8bd, Cybered finding, comment 20436) ------------
#
# WHY THIS IS A REFUSAL AND NOT A WARNING. The tool already guards the narrow race it can SEE: the
# TOCTOU re-hash below catches a write that lands between classify and mv. It cannot see the wide
# one. A live agent reads these files at runtime and is EXPECTED to hand-patch its own copy
# mid-session (CLAUDE.md, "Skill patch (runtime javitas)"), so rewriting one under a working agent
# changes the instructions it is following, with nothing in the session saying so. The measured
# incident (Cybered, 2026-09-05 11:04) wrote a dozen backups into live trees while their owners
# worked, and the acceptable counter-example from the same morning -- MikroB's 10:57 correction --
# differed in exactly one respect: it verified running=False on all three targets first.
#
# THE SOURCE IS TMUX, NOT THE DASHBOARD API, and the reason is the failure direction. Both agree
# exactly today (measured on all 15 agents: `running` in /api/agents is true iff a tmux session
# `agent-<name>` exists). But the API adds a service that can be DOWN while the agents it describes
# are UP, and a down dashboard would answer "not running" for everyone -- the dangerous direction,
# on an unattended six-hourly --apply. tmux runs on the same host as the trees being written, so it
# cannot be absent while its own sessions are alive.
#
# FAIL-CLOSED, and it can only cost a delay: an agent we cannot prove is parked is treated as
# running, so the sync is skipped and the next run re-checks. The asymmetry is the same one this
# file already argues for the unreadable baseline -- when we cannot PROVE the situation is safe, we
# do not call it safe.
#
# NOT WAITING FOR THE PARK, which the card offered as an alternative: this runs unattended every six
# hours, so blocking on a busy agent would stall the whole sweep behind one long-running session.
# Skipping names the agent and re-tries in six hours; the copy stays stale in the meantime, which is
# the state it was already in.
#
# WHAT THIS DOES NOT CLOSE, stated because the card's goal is broader than its code half: a manual
# `cp` into agents/<name>/.claude/skills/ bypasses this file entirely. The refusal is only worth
# what the rule that every skill write goes through this path is worth. That rule is the card's
# other half and it lives in the process, not here.
_RUNNING_SESSIONS=""      # cached per run; "?" means undetermined -> everything counts as running
_load_running_sessions() {
  if [ -n "${AGENT_SKILL_DRIFT_TEST_SESSIONS+set}" ]; then
    # Test-only, mirroring AGENT_SKILL_DRIFT_TEST_RACE above: supplies exactly what tmux would have
    # printed, one session name per line, so the selftest exercises the REAL matching code rather
    # than a second implementation of it.
    _RUNNING_SESSIONS="$(printf '%s\n' "$AGENT_SKILL_DRIFT_TEST_SESSIONS")"
    return
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    _RUNNING_SESSIONS="?"
    return
  fi
  local out rc
  out="$(tmux list-sessions -F '#{session_name}' 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    _RUNNING_SESSIONS="$out"
  elif printf '%s' "$out" | grep -qi 'no server running'; then
    # tmux answered, and its answer is "nothing is up". That is a real reading, not a failure.
    _RUNNING_SESSIONS=""
  else
    _RUNNING_SESSIONS="?"
  fi
}
_agent_is_running() {
  [ "$_RUNNING_SESSIONS" = "?" ] && return 0
  printf '%s\n' "$_RUNNING_SESSIONS" | grep -qx "agent-$1"
}

# Prints one of: running | undetermined | parked (card 75b90343, part 2). _agent_is_running above
# collapses "confirmed running" and "could not tell" into the same true/false so the fail-closed
# skip logic can stay a one-line check; this function keeps the distinction so the REPORT can tell
# an operator which one actually happened, without changing which copies get skipped.
_agent_running_state() {
  if [ "$_RUNNING_SESSIONS" = "?" ]; then
    echo "undetermined"
    return
  fi
  if printf '%s\n' "$_RUNNING_SESSIONS" | grep -qx "agent-$1"; then
    echo "running"
  else
    echo "parked"
  fi
}

# --- clone-family MISSING-skill detection (card a6abb230) -------------------------------------
# Known sibling groups. Not derived from anything live (no naming convention reliably implies
# "same family" -- qa2 does, cybersec2 would not), so this is a short, explicit list, same spirit as
# the root CLAUDE.md's own hardcoded "ma: backend<->backend2, qa<->qa2, fron-ted<->fron-teddy" note.
# An agent not listed here returns nothing and is simply never part of a missing-skill comparison.
_family_members() {
  case "$1" in
    backend|backend2|backend3) echo "backend backend2 backend3" ;;
    qa|qa2)                    echo "qa qa2" ;;
    fron-ted|fron-teddy)       echo "fron-ted fron-teddy" ;;
    *) echo "" ;;
  esac
}

# Card 85521c7e F2: resolves a missing skill's copy source to a family member's TRACKED
# seed-fleet-agents copy, in family order -- never a sibling's live .claude/skills directory. A
# skill that exists only in a live copy (never seeded/reviewed) has no seed-fleet-agents entry
# anywhere in the family and this returns failure, which the caller turns into a report-only line.
_seed_fleet_src() {
  local members="$1" skill="$2" s
  for s in $members; do
    if [ -d "$SEED_FLEET_DIR/$s/.claude/skills/$skill" ]; then
      printf '%s' "$SEED_FLEET_DIR/$s/.claude/skills/$skill"
      return 0
    fi
  done
  return 1
}

# Card 85521c7e F2: refuses a copy source containing ANY symlink that resolves outside its own
# root -- defense in depth even against the tracked seed (a symlink escaping the skill directory,
# committed by mistake or malice, is still a hazard once `cp -r` recreates it on every family
# member's disk). Deliberately walks with `find -type l` (never `-L`, which would descend THROUGH
# an escaping link instead of finding it) and resolves each link with `readlink -f`.
_dir_has_escaping_symlink() {
  local root="$1" real_root link target
  real_root="$(cd "$root" 2>/dev/null && pwd -P)" || return 0  # can't even resolve the root: refuse
  while IFS= read -r -d '' link; do
    target="$(readlink -f -- "$link" 2>/dev/null)" || return 0  # unresolvable link -> treat as escaping
    case "$target" in
      "$real_root"/*|"$real_root") ;;
      *) return 0 ;;  # escapes the root
    esac
  done < <(find "$root" -type l -print0 2>/dev/null)
  return 1
}

scan_missing_skills() {
  MISSING=0; MISSING_SYNCED=0; MISSING_SKIPPED_RUNNING=0; MISSING_SKIPPED_UNDETERMINED=0
  MISSING_LIST=""
  [ -d "$AGENTS_DIR" ] || return 0

  local seen_families=","
  for adir in "$AGENTS_DIR"/*/; do
    [ -d "$adir" ] || continue
    local agent members
    agent="$(basename "${adir%/}")"
    members="$(_family_members "$agent")"
    [ -n "$members" ] || continue
    # Process each family exactly once, keyed by its member list (identical for every member).
    case "$seen_families" in *",${members},"*) continue ;; esac
    seen_families="${seen_families}${members},"

    # Union of skill dirnames across whichever members actually exist on this box. Deliberately NOT
    # filtered by --agent/--skill here: those narrow which member gets REPORTED/synced below, not
    # which siblings are allowed to contribute to the comparison -- an --agent backend3 run must
    # still see what backend/backend2 have, or it would never find anything missing.
    local union="" m sdir s
    for m in $members; do
      sdir="$AGENTS_DIR/$m/.claude/skills"
      [ -d "$sdir" ] || continue
      for s in "$sdir"/*/; do
        [ -d "$s" ] || continue
        s="$(basename "${s%/}")"
        _wanted_skill "$s" || continue
        case ",$union," in *",$s,"*) ;; *) union="${union}${union:+,}$s" ;; esac
      done
    done
    [ -n "$union" ] || continue

    local skill target_dir src_dir agent_state union_arr
    IFS=',' read -r -a union_arr <<<"$union"
    for m in $members; do
      _wanted_agent "$m" || continue
      [ -d "$AGENTS_DIR/$m/.claude" ] || continue   # agent not provisioned on this box at all
      for skill in "${union_arr[@]}"; do
        target_dir="$AGENTS_DIR/$m/.claude/skills/$skill"
        [ -e "$target_dir" ] && continue

        # Card 85521c7e F2: the copy source is the TRACKED seed-fleet-agents copy, never a
        # sibling's live directory. A skill present in a live sibling but absent from every family
        # member's seed-fleet-agents was never reviewed/committed -- report it, never copy it.
        if ! src_dir="$(_seed_fleet_src "$members" "$skill")"; then
          MISSING=$((MISSING+1))
          MISSING_LIST="${MISSING_LIST}${m}/${skill} -- present in a sibling's LIVE copy only, absent from seed-fleet-agents -- reported, never auto-synced (add it to seed-fleet-agents after review)\n"
          continue
        fi

        MISSING=$((MISSING+1))

        if [ "$APPLY" -eq 1 ] && [ "$MISSING_SYNC_APPLY_ENABLED" -eq 1 ]; then
          agent_state="$(_agent_running_state "$m")"
          if [ "$agent_state" = "running" ]; then
            MISSING_SKIPPED_RUNNING=$((MISSING_SKIPPED_RUNNING+1))
            MISSING_LIST="${MISSING_LIST}${m}/${skill} -- SKIPPED, ${m} is RUNNING\n"
            continue
          elif [ "$agent_state" = "undetermined" ]; then
            MISSING_SKIPPED_UNDETERMINED=$((MISSING_SKIPPED_UNDETERMINED+1))
            MISSING_LIST="${MISSING_LIST}${m}/${skill} -- SKIPPED, could not determine whether ${m} is running\n"
            continue
          fi
          # Re-check right before writing: additive-only, so the worst a race can do is a
          # harmless second copy landing on an already-created directory -- refuse that instead.
          if [ -e "$target_dir" ]; then
            continue
          fi
          if _dir_has_escaping_symlink "$src_dir"; then
            MISSING_LIST="${MISSING_LIST}${m}/${skill} -- seed-fleet-agents copy contains a symlink escaping its own directory, REFUSED (needs manual review)\n"
            continue
          fi
          if cp -r "$src_dir" "$target_dir" 2>/dev/null; then
            MISSING_SYNCED=$((MISSING_SYNCED+1))
            MISSING_LIST="${MISSING_LIST}${m}/${skill} -- copied from seed-fleet-agents -> synced\n"
          else
            MISSING_LIST="${MISSING_LIST}${m}/${skill} -- copy from seed-fleet-agents FAILED (left untouched)\n"
          fi
        else
          MISSING_LIST="${MISSING_LIST}${m}/${skill} -- present in seed-fleet-agents, absent here (would-sync, dry-run)\n"
        fi
      done
    done
  done
}

run_scan() {
  CUR=0; STALE=0; DIVERGED=0; SKIPPED=0; SKIPPED_CONCURRENT=0; SKIPPED_RUNNING=0; SKIPPED_UNDETERMINED=0
  STALE_LIST=""; DIVERGED_LIST=""
  MISSING=0; MISSING_SYNCED=0; MISSING_SKIPPED_RUNNING=0; MISSING_SKIPPED_UNDETERMINED=0; MISSING_LIST=""
  _load_running_sessions

  # An ALERT line on this path too. Returning early without a verdict would leave the heartbeat --
  # which keys on that line -- with nothing to read, and "no output" is indistinguishable from
  # "routine" to whatever is downstream. A missing agents directory is not routine: it means the
  # tool scanned nothing at all, which is exactly the state that must never pass as quiet.
  if [ ! -d "$AGENTS_DIR" ]; then
    echo "agent-skill-drift-sync: no $AGENTS_DIR -- nothing to scan"
    echo "ALERT:yes reasons=no-agents-dir diverged=0 stale=0 skipped-concurrent=0 skipped-running=0 skipped-undetermined=0"
    return 0
  fi

  for adir in "$AGENTS_DIR"/*/; do
    [ -d "$adir" ] || continue
    agent="$(basename "${adir%/}")"
    _wanted_agent "$agent" || continue
    skdir="$adir.claude/skills"
    [ -d "$skdir" ] || continue
    # Once per agent, not once per skill: the answer cannot change usefully inside one agent's
    # loop, and asking repeatedly would only widen the window between the reading and the write.
    agent_state="$(_agent_running_state "$agent")"
    if [ "$agent_state" = "parked" ]; then agent_running=0; else agent_running=1; fi

    agent_lines=""
    for sdir in "$skdir"/*/; do
      [ -d "$sdir" ] || continue
      skill="$(basename "${sdir%/}")"
      _wanted_skill "$skill" || continue
      installed="$sdir/SKILL.md"
      [ -f "$installed" ] || continue
      rel="seed-skills/$skill/SKILL.md"

      verdict="$(classify_copy "$installed" "$rel")"
      case "$verdict" in
        current)      CUR=$((CUR+1)) ;;
        no-canonical) SKIPPED=$((SKIPPED+1)) ;;
        stale)
          STALE=$((STALE+1))
          STALE_LIST="${STALE_LIST}${agent}/${skill}\n"
          agent_lines="${agent_lines}  STALE     ${skill} -- byte-identical to a shipped-but-superseded version, safe to re-sync\n"
          if [ "$APPLY" -eq 1 ] && [ "$agent_running" -eq 1 ]; then
            # The wide race the TOCTOU guard below cannot see. See _agent_is_running for why this
            # refuses rather than warns, and why it does not wait for the agent to park.
            # "running" and "undetermined" are BOTH skipped (fail-closed, same code path above),
            # but they are not the same finding: one means a live agent genuinely holds this file,
            # the other means tmux could not be read at all (card 75b90343 part 2) -- an operator
            # reading "is RUNNING" for the second case would believe all agents are busy when the
            # tool simply could not tell. Additive distinction, not filtering: both still count
            # toward the same fail-closed skip, just labelled by which one actually happened.
            if [ "$agent_state" = "undetermined" ]; then
              SKIPPED_UNDETERMINED=$((SKIPPED_UNDETERMINED+1))
              agent_lines="${agent_lines}            -> SKIPPED, could not determine whether ${agent} is running (tmux state unreadable) -- re-runs when determinable\n"
            else
              SKIPPED_RUNNING=$((SKIPPED_RUNNING+1))
              agent_lines="${agent_lines}            -> SKIPPED, ${agent} is RUNNING (a live agent reads and may hand-patch this file) -- re-runs when it parks\n"
            fi
          elif [ "$APPLY" -eq 1 ]; then
            # TOCTOU guard: re-hash the live file immediately before the mv and compare against
            # the hash classify_copy just judged safe. If something else wrote to this live
            # per-agent skill file in the window between classification and now, the file no
            # longer matches what we decided was safe to overwrite -- skip it and say so,
            # instead of silently clobbering (or silently dropping) a concurrent local edit.
            classify_hash="$(_hash <"$installed" 2>/dev/null)"
            # Test-only: deterministically simulate a concurrent write landing in the
            # classify->mv window, instead of relying on a flaky sleep-based race. The variable
            # names a SKILL to race on and is COMPARED, never executed -- the earlier form took a
            # path to an executable and ran it, which meant an unattended scheduled task carried a
            # run-arbitrary-command edge for a selftest that only ever needed one fixed write
            # (card 222fdc5e, Cybersec LOW). A no-op in every real invocation.
            if [ "${AGENT_SKILL_DRIFT_TEST_RACE:-}" = "$skill" ]; then
              printf 'CONCURRENT LOCAL EDIT, MUST SURVIVE\n' >"$installed"
            fi
            tmp="$installed.$$.tmp"
            if render_seed_template <"$ROOT/$rel" >"$tmp"; then
              live_hash="$(_hash <"$installed" 2>/dev/null)"
              if [ "$live_hash" != "$classify_hash" ]; then
                rm -f "$tmp"
                SKIPPED_CONCURRENT=$((SKIPPED_CONCURRENT+1))
                agent_lines="${agent_lines}            -> SKIPPED, file changed between classify and sync (concurrent write) -- re-run to re-check\n"
              elif mv "$tmp" "$installed"; then
                agent_lines="${agent_lines}            -> synced\n"
              else
                rm -f "$tmp"
                agent_lines="${agent_lines}            -> SYNC FAILED (left untouched)\n"
              fi
            else
              rm -f "$tmp"
              agent_lines="${agent_lines}            -> SYNC FAILED (left untouched)\n"
            fi
          fi
          ;;
        diverged)
          DIVERGED=$((DIVERGED+1))
          DIVERGED_LIST="${DIVERGED_LIST}${agent}/${skill}\n"
          agent_lines="${agent_lines}  DIVERGED  ${skill} -- does not match current canonical OR any of the last ${HIST_CAP} shipped versions; NOT touched, needs manual review\n"
          ;;
      esac
    done

    if [ -n "$agent_lines" ] && [ "$TELEGRAM" -eq 0 ]; then
      echo "== $agent =="
      printf '%b' "$agent_lines"
    fi
  done

  scan_missing_skills

  if [ "$TELEGRAM" -eq 1 ]; then
    echo "Agent skill drift: current=${CUR} stale=${STALE} diverged=${DIVERGED} skipped(no-canonical)=${SKIPPED} missing=${MISSING}"
    if [ "$STALE" -gt 0 ]; then
      echo "Stale (untouched, $([ "$APPLY" -eq 1 ] && echo synced || echo would-sync)):"
      printf '%b' "$STALE_LIST" | sed 's/^/  /'
    fi
    if [ "$DIVERGED" -gt 0 ]; then
      echo "Diverged (flagged, NOT touched -- needs manual review):"
      printf '%b' "$DIVERGED_LIST" | sed 's/^/  /'
    fi
    if [ "$MISSING" -gt 0 ]; then
      echo "Missing (clone-family sibling has it, this member does not):"
      printf '%b' "$MISSING_LIST" | sed 's/^/  /'
    fi
  else
    if [ "$MISSING" -gt 0 ]; then
      echo "== clone-family missing skills =="
      printf '%b' "$MISSING_LIST" | sed 's/^/  MISSING   /'
    fi
    echo "---"
    echo "SUMMARY: current=${CUR} stale=${STALE}$([ "$APPLY" -eq 1 ] && echo '(synced)' || echo '(would-sync, dry-run)') diverged=${DIVERGED}(flagged-only) skipped=${SKIPPED}(no-canonical) missing=${MISSING}$([ "$APPLY" -eq 1 ] && [ "$MISSING_SYNC_APPLY_ENABLED" -eq 1 ] && echo '(synced-where-possible)' || echo '(would-sync, dry-run)')"
  fi

  emit_alert_verdict
}

# WHY A VERDICT LINE AND NOT JUST THE COUNTS (card 222fdc5e, Cybersec MEDIUM on 13512bde).
#
# The heartbeat that drives this tool was told to stay quiet only when `stale=0 AND diverged=0`.
# Measured live: current=89 stale=0 diverged=5. So the ROUTINE state is not "everything current" --
# it is "five diverged" -- and the task therefore sent the same five lines every six hours, four
# times a day, forever. The diverged set is legitimately stable (QA's own 84b304c1 verdict: those
# copies are deliberate local extensions, not faults). Two weeks of that and nobody reads it, least
# of all on the day it finally changes.
#
# The alert-worthy event is therefore a CHANGE of the diverged SET, not its size: a count is equal
# when one entry appears and another disappears. So the set is hashed and compared against the last
# APPLIED run.
#
# Alert-worthy: stale>0 (we actually changed files), any SKIPPED-on-concurrent-write line (a sync
# collided and needs a re-run), a diverged set that differs from the baseline, no baseline at all,
# or a baseline we cannot read.
#
# THE UNREADABLE-BASELINE CASE DELIBERATELY ALERTS instead of dying. store/cleancore-main-suite-guard.sh
# -- the house precedent for this pattern -- `die`s on a corrupt state file, and it is right to: it is
# a GATE, and a gate that cannot compare must not report a verdict (card 6d46c7d3). This is an
# ALERTING tool with `exit 0` in its contract, and killing it would take the six-hourly sync down
# with it. Same principle, opposite mechanism: when we cannot PROVE the situation is routine, we say
# it is not routine. Never the reverse.
#
# ONLY --apply WRITES THE BASELINE. A dry-run is someone looking; it must not consume the change
# that the next real run is supposed to announce.
#
# ACCEPTED, and stated rather than buried: the baseline advances as soon as an --apply run OBSERVES
# a change, not when the notification is confirmed delivered. If the Telegram send fails, that one
# change is not re-announced. The state file therefore records `previousList` and `changedAt`, so the
# next run's --status still shows what moved and when -- visible, just not re-alerted. The
# alternative (hold the baseline until an explicit ack) puts the acknowledgement back in the prompt,
# which is exactly the layer whose rule failed here in the first place.
emit_alert_verdict() {
  local now diverged_now diverged_sha prev_sha prev_list prev_changed reasons
  now="$(date +%s)"
  diverged_now="$(printf '%b' "$DIVERGED_LIST" | sed '/^$/d' | LC_ALL=C sort | paste -sd, -)"
  diverged_sha="$(printf '%s' "$diverged_now" | _hash)"

  reasons=""
  [ "$STALE" -gt 0 ] && reasons="${reasons}stale-synced,"
  [ "$SKIPPED_CONCURRENT" -gt 0 ] && reasons="${reasons}concurrent-write-skipped,"
  # A skipped sync is work still owed, so it must not read as routine. It is NOT an error: the copy
  # simply stays as stale as it already was until the agent parks. Two distinct reasons (card
  # 75b90343 part 2): CONFIRMED running vs tmux state UNDETERMINED -- both fail closed the same way,
  # but they are different findings and must not collapse into one label.
  [ "$SKIPPED_RUNNING" -gt 0 ] && reasons="${reasons}running-agent-skipped,"
  [ "$SKIPPED_UNDETERMINED" -gt 0 ] && reasons="${reasons}undetermined-agent-skipped,"
  # Same convention as stale-synced above (including the pre-existing imprecision: this fires on a
  # dry run too, not only when --apply actually wrote something) -- a clone-family gap is exactly as
  # newsworthy as a stale copy, and giving it its own reason keeps it distinguishable in the verdict.
  [ "$MISSING" -gt 0 ] && reasons="${reasons}missing-synced,"
  [ "$MISSING_SKIPPED_RUNNING" -gt 0 ] && reasons="${reasons}missing-running-agent-skipped,"
  [ "$MISSING_SKIPPED_UNDETERMINED" -gt 0 ] && reasons="${reasons}missing-undetermined-agent-skipped,"

  if [ ! -f "$STATE" ]; then
    reasons="${reasons}no-baseline,"
    prev_list=""; prev_changed="$now"
  else
    prev_sha="$(sed -n 's/.*"divergedSha"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$STATE" | head -1)"
    prev_list="$(sed -n 's/.*"divergedList"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE" | head -1)"
    prev_changed="$(sed -n 's/.*"changedAt"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$STATE" | head -1)"
    if [ -z "$prev_sha" ]; then
      # Present but unparseable. Not "no baseline" -- we say so, and we say we could not read it.
      reasons="${reasons}baseline-unreadable,"
      prev_changed="$now"
    elif [ "$prev_sha" != "$diverged_sha" ]; then
      reasons="${reasons}diverged-set-changed,"
      prev_changed="$now"
    fi
  fi

  if [ -n "$reasons" ]; then
    echo "ALERT:yes reasons=${reasons%,} diverged=${DIVERGED} stale=${STALE} skipped-concurrent=${SKIPPED_CONCURRENT} skipped-running=${SKIPPED_RUNNING} skipped-undetermined=${SKIPPED_UNDETERMINED} missing=${MISSING} missing-skipped-running=${MISSING_SKIPPED_RUNNING} missing-skipped-undetermined=${MISSING_SKIPPED_UNDETERMINED}"
    [ -n "$prev_list" ] && [ "$prev_list" != "$diverged_now" ] && echo "  diverged set was: ${prev_list:-(empty)}"
    [ -n "$reasons" ] && echo "  diverged set now: ${diverged_now:-(empty)}"
    [ "$MISSING" -gt 0 ] && { echo "  missing set:"; printf '%b' "$MISSING_LIST" | sed '/^$/d;s/^/    /'; }
  else
    echo "ALERT:no (diverged set unchanged since $(date -d "@$prev_changed" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$prev_changed"), ${DIVERGED} entr$([ "$DIVERGED" -eq 1 ] && echo y || echo ies); stale=0, missing=0, no concurrent-write skips)"
  fi

  # Only a real run moves the baseline -- see the comment above.
  if [ "$APPLY" -eq 1 ]; then
    mkdir -p "$(dirname "$STATE")" 2>/dev/null
    cat >"$STATE.tmp.$$" <<EOF
{
  "divergedSha": "$diverged_sha",
  "divergedList": "$diverged_now",
  "divergedCount": $DIVERGED,
  "previousList": "$prev_list",
  "changedAt": $prev_changed,
  "measuredAt": $now
}
EOF
    mv -f "$STATE.tmp.$$" "$STATE" 2>/dev/null || {
      rm -f "$STATE.tmp.$$"
      echo "WARN: could not write the state file at $STATE -- the next run will report no-baseline"
    }
  fi
}

if [[ "$MODE" == selftest ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  fail=0

  # Build a throwaway ROOT: a real git repo so `git log`/`git show` work exactly like on the real
  # install, with two commits of one canonical skill (old -> fixed) plus one agent-specific skill that
  # was NEVER centrally tracked.
  git init -q "$tmp/root"
  git -C "$tmp/root" config user.email t@t; git -C "$tmp/root" config user.name t
  mkdir -p "$tmp/root/seed-skills/demo-skill"
  printf 'OLD VERSION\ninstall dir: {{INSTALL_DIR}}\nagent: {{MAIN_AGENT_ID}}\n' > "$tmp/root/seed-skills/demo-skill/SKILL.md"
  git -C "$tmp/root" add -A && git -C "$tmp/root" commit -q -m "old"
  printf 'NEW FIXED VERSION\ninstall dir: {{INSTALL_DIR}}\nagent: {{MAIN_AGENT_ID}}\nfix: closed the gap\n' > "$tmp/root/seed-skills/demo-skill/SKILL.md"
  git -C "$tmp/root" commit -aqm "fix"
  printf 'MAIN_AGENT_ID=selftest\nBOT_NAME=Selfy\nOWNER_NAME=Tester\n' > "$tmp/root/.env"

  # agent A: still on the OLD rendered content -> STALE (safe to sync)
  mkdir -p "$tmp/root/agents/agentA/.claude/skills/demo-skill"
  printf 'OLD VERSION\ninstall dir: %s\nagent: selftest\n' "$tmp/root" > "$tmp/root/agents/agentA/.claude/skills/demo-skill/SKILL.md"

  # agent B: hand-edited mid-session (per the fleet's own runtime-patch convention) -> DIVERGED, must
  # NEVER be overwritten
  mkdir -p "$tmp/root/agents/agentB/.claude/skills/demo-skill"
  printf 'OLD VERSION\ninstall dir: %s\nagent: selftest\nMY OWN HAND-PATCHED NOTE, DO NOT LOSE THIS\n' "$tmp/root" > "$tmp/root/agents/agentB/.claude/skills/demo-skill/SKILL.md"

  # agent C: already current -> no-op
  mkdir -p "$tmp/root/agents/agentC/.claude/skills/demo-skill"
  printf 'NEW FIXED VERSION\ninstall dir: %s\nagent: selftest\nfix: closed the gap\n' "$tmp/root" > "$tmp/root/agents/agentC/.claude/skills/demo-skill/SKILL.md"

  # agent D: a skill with no seed-skills counterpart at all -> skipped, not flagged
  mkdir -p "$tmp/root/agents/agentD/.claude/skills/local-only-skill"
  printf 'stays local always\nAGENT D CUSTOM STUFF\n' > "$tmp/root/agents/agentD/.claude/skills/local-only-skill/SKILL.md"

  run() { AGENT_SKILL_DRIFT_ROOT="$tmp/root" bash "${BASH_SOURCE[0]}" "$@"; }

  out="$(run --telegram)"
  echo "$out" | grep -q 'current=1 stale=1 diverged=1 skipped(no-canonical)=1' \
    && echo "  ok   counts: current=1 stale=1 diverged=1 skipped=1" \
    || { echo "  FAIL counts wrong:"; echo "$out"; fail=1; }
  echo "$out" | grep -q 'agentA/demo-skill' && echo "  ok   agentA listed as stale" \
    || { echo "  FAIL agentA not listed as stale"; fail=1; }
  echo "$out" | grep -q 'agentB/demo-skill' && echo "  ok   agentB listed as diverged" \
    || { echo "  FAIL agentB not listed as diverged"; fail=1; }

  # dry-run must not touch anything
  b_before="$(cat "$tmp/root/agents/agentB/.claude/skills/demo-skill/SKILL.md")"
  a_before="$(cat "$tmp/root/agents/agentA/.claude/skills/demo-skill/SKILL.md")"
  run >/dev/null
  [ "$(cat "$tmp/root/agents/agentA/.claude/skills/demo-skill/SKILL.md")" = "$a_before" ] \
    && echo "  ok   dry-run left agentA (stale) untouched" \
    || { echo "  FAIL dry-run modified agentA without --apply"; fail=1; }

  # --apply: STALE gets synced to the NEW rendered content
  run --apply >/dev/null
  if grep -q 'fix: closed the gap' "$tmp/root/agents/agentA/.claude/skills/demo-skill/SKILL.md" \
     && grep -q "install dir: $tmp/root" "$tmp/root/agents/agentA/.claude/skills/demo-skill/SKILL.md"; then
    echo "  ok   --apply synced agentA (stale) to the current rendered canonical"
  else
    echo "  FAIL --apply did not sync agentA correctly"; fail=1
  fi

  # --apply: DIVERGED must be BYTE-IDENTICAL to before -- this is the safety-critical assertion
  if [ "$(cat "$tmp/root/agents/agentB/.claude/skills/demo-skill/SKILL.md")" = "$b_before" ]; then
    echo "  ok   --apply left agentB (diverged) BYTE-IDENTICAL -- hand-patched note preserved"
  else
    echo "  FAIL --apply overwrote a diverged (hand-patched) copy -- SAFETY VIOLATION"; fail=1
  fi
  grep -q 'MY OWN HAND-PATCHED NOTE' "$tmp/root/agents/agentB/.claude/skills/demo-skill/SKILL.md" \
    && echo "  ok   agentB's hand-patched note is still present after --apply" \
    || { echo "  FAIL agentB's hand-patched note was lost"; fail=1; }

  # --agent / --skill filters
  out2="$(run --telegram --agent agentA)"
  echo "$out2" | grep -q 'diverged=0' && echo "  ok   --agent filter excludes other agents' findings" \
    || { echo "  FAIL --agent filter did not narrow the scan"; fail=1; }

  # --- PART 2 regression: git-show ERROR vs a genuinely-empty file must not collapse to the same
  # signal. History: add -> DELETE -> re-add. On the delete commit `git show` errors (empty
  # stdout); a live copy that is genuinely 0 bytes hashes the same as that error output. Before
  # the fix this misclassified the empty live file as "stale" (safe to sync) when it actually
  # just means the classifier failed to read a real historical version.
  mkdir -p "$tmp/root/seed-skills/gone-skill"
  printf 'FIRST VERSION\n' > "$tmp/root/seed-skills/gone-skill/SKILL.md"
  git -C "$tmp/root" add -A && git -C "$tmp/root" commit -q -m "gone-skill add"
  git -C "$tmp/root" rm -q seed-skills/gone-skill/SKILL.md
  git -C "$tmp/root" commit -q -m "gone-skill delete"
  mkdir -p "$tmp/root/seed-skills/gone-skill"   # git rm cleans up the now-empty directory too
  printf 'THIRD VERSION\n' > "$tmp/root/seed-skills/gone-skill/SKILL.md"
  git -C "$tmp/root" add -A && git -C "$tmp/root" commit -q -m "gone-skill re-add"

  mkdir -p "$tmp/root/agents/agentE/.claude/skills/gone-skill"
  : > "$tmp/root/agents/agentE/.claude/skills/gone-skill/SKILL.md"   # genuinely empty, 0 bytes

  out4="$(run --telegram --agent agentE --skill gone-skill --apply)"
  echo "$out4" | grep -q 'current=0 stale=0 diverged=1' \
    && echo "  ok   empty live file against add/DELETE/re-add history classifies as diverged, not stale" \
    || { echo "  FAIL empty-file/deleted-commit ambiguity misclassified:"; echo "$out4"; fail=1; }
  [ ! -s "$tmp/root/agents/agentE/.claude/skills/gone-skill/SKILL.md" ] \
    && echo "  ok   --apply left the empty agentE copy untouched (0 bytes)" \
    || { echo "  FAIL --apply wrote to a diverged copy that should never be touched"; fail=1; }

  # --- PART 3 regression: TOCTOU between classify and mv. Simulate a concurrent local write
  # landing in the classify->mv window via the test-only race hook; the sync must detect the
  # mismatch, skip the mv, and report it -- never silently overwrite, never silently drop it.
  mkdir -p "$tmp/root/agents/agentF/.claude/skills/demo-skill"
  printf 'OLD VERSION\ninstall dir: %s\nagent: selftest\n' "$tmp/root" > "$tmp/root/agents/agentF/.claude/skills/demo-skill/SKILL.md"
  f_target="$tmp/root/agents/agentF/.claude/skills/demo-skill/SKILL.md"

  # The variable NAMES the skill to race on and is compared, not executed (card 222fdc5e): the old
  # form pointed at a script and ran it, which is a run-arbitrary-command edge on the --apply path
  # that an unattended scheduled task now uses. One fixed write is all this test ever needed.
  out5="$(AGENT_SKILL_DRIFT_ROOT="$tmp/root" AGENT_SKILL_DRIFT_TEST_RACE=demo-skill \
          bash "${BASH_SOURCE[0]}" --apply --agent agentF)"
  echo "$out5" | grep -q 'SKIPPED, file changed between classify and sync' \
    && echo "  ok   TOCTOU race detected and sync skipped, reported" \
    || { echo "  FAIL TOCTOU race not detected/reported:"; echo "$out5"; fail=1; }
  [ "$(cat "$f_target")" = "CONCURRENT LOCAL EDIT, MUST SURVIVE" ] \
    && echo "  ok   concurrent local edit survived (not overwritten by the sync)" \
    || { echo "  FAIL concurrent local edit was lost -- TOCTOU not closed"; fail=1; }

  # --- PART 4: the WIDE race -- writing into a RUNNING agent's tree (card e667c8bd) ------------
  # The TOCTOU guard above only sees a write that lands inside the classify->mv window. A live agent
  # holds these files for a whole session and is expected to hand-patch them, so the sync must not
  # touch its tree at all. Fixture: agentG is stale in exactly the way agentA was, so the ONLY
  # difference between "synced" and "skipped" below is whether a session named agent-agentG exists.
  mkdir -p "$tmp/root/agents/agentG/.claude/skills/demo-skill"
  g_target="$tmp/root/agents/agentG/.claude/skills/demo-skill/SKILL.md"
  g_stale() { printf 'OLD VERSION\ninstall dir: %s\nagent: selftest\n' "$tmp/root" > "$g_target"; }
  sync_run() { AGENT_SKILL_DRIFT_ROOT="$tmp/root" AGENT_SKILL_DRIFT_TEST_SESSIONS="$1" \
               bash "${BASH_SOURCE[0]}" --apply --agent agentG; }

  g_stale
  out7="$(sync_run "agent-agentG
agent-someone-else")"
  echo "$out7" | grep -q 'SKIPPED, agentG is RUNNING' \
    && echo "  ok   a RUNNING agent's stale copy is skipped, and the report says why" \
    || { echo "  FAIL running agent was not skipped:"; echo "$out7"; fail=1; }
  grep -q 'OLD VERSION' "$g_target" \
    && echo "  ok   the running agent's file is byte-untouched (still the old content)" \
    || { echo "  FAIL the sync wrote into a running agent's tree"; fail=1; }
  echo "$out7" | grep -q 'skipped-running=1' \
    && echo "  ok   the verdict line carries skipped-running=1" \
    || { echo "  FAIL skipped-running missing from the verdict:"; echo "$out7"; fail=1; }
  echo "$out7" | grep -q 'reasons=.*running-agent-skipped' \
    && echo "  ok   the skip is a REASON, so the run cannot read as routine" \
    || { echo "  FAIL running-agent-skipped is not among the reasons:"; echo "$out7"; fail=1; }

  # THE CONTROL THAT MAKES THE CASE ABOVE MEAN SOMETHING. Same fixture, same command, only the
  # session list differs: a parked agent must still be synced. Without this, a guard that refused
  # every write would pass every assertion above.
  g_stale
  out8="$(sync_run "agent-someone-else")"
  grep -q 'fix: closed the gap' "$g_target" \
    && echo "  ok   CONTROL: a PARKED agent is still synced -- the guard is not a blanket refusal" \
    || { echo "  FAIL a parked agent was not synced:"; echo "$out8"; fail=1; }

  # FAIL-CLOSED when the reading itself fails. A tmux that errors for any reason OTHER than "no
  # server running" tells us nothing, and an agent we cannot prove is parked is treated as running
  # for the SKIP decision -- but (card 75b90343 part 2) the REPORT must say "could not determine",
  # not "is RUNNING": those are different findings that happen to fail closed the same way, and an
  # operator reading "is RUNNING" here would wrongly believe agentG is confirmed busy.
  mkdir -p "$tmp/fakebin"
  printf '#!/usr/bin/env bash\necho "connect failed: no such file or directory" >&2\nexit 1\n' > "$tmp/fakebin/tmux"
  chmod +x "$tmp/fakebin/tmux"
  g_stale
  out9="$(AGENT_SKILL_DRIFT_ROOT="$tmp/root" PATH="$tmp/fakebin:$PATH" \
          bash "${BASH_SOURCE[0]}" --apply --agent agentG)"
  echo "$out9" | grep -q 'SKIPPED, could not determine whether agentG is running' \
    && echo "  ok   an UNREADABLE tmux fails closed, and the report says UNDETERMINED, not RUNNING" \
    || { echo "  FAIL undetermined tmux did not report distinctly from RUNNING:"; echo "$out9"; fail=1; }
  if ! echo "$out9" | grep -q 'agentG is RUNNING'; then
    echo "  ok   the misleading confirmed-RUNNING phrase does not appear for an undetermined read"
  else
    echo "  FAIL the undetermined case still printed the confirmed-RUNNING phrase:"; echo "$out9"; fail=1
  fi
  echo "$out9" | grep -q 'skipped-undetermined=1' \
    && echo "  ok   the verdict line carries skipped-undetermined=1 (separate from skipped-running)" \
    || { echo "  FAIL skipped-undetermined missing from the verdict:"; echo "$out9"; fail=1; }
  echo "$out9" | grep -q 'reasons=.*undetermined-agent-skipped' \
    && echo "  ok   undetermined-agent-skipped is its own reason" \
    || { echo "  FAIL undetermined-agent-skipped is not among the reasons:"; echo "$out9"; fail=1; }
  grep -q 'OLD VERSION' "$g_target" \
    && echo "  ok   the undetermined case still left the file untouched (fail-closed)" \
    || { echo "  FAIL the undetermined case wrote to the file"; fail=1; }

  # ...and the other half of that distinction, which is the load-bearing one: "no server running" is
  # tmux ANSWERING, not tmux failing. Collapsing the two would make the tool a permanent no-op on
  # any box where the fleet is parked -- exactly when the sync is safest and most useful.
  printf '#!/usr/bin/env bash\necho "no server running on /tmp/tmux-1000/default" >&2\nexit 1\n' > "$tmp/fakebin/tmux"
  g_stale
  out10="$(AGENT_SKILL_DRIFT_ROOT="$tmp/root" PATH="$tmp/fakebin:$PATH" \
           bash "${BASH_SOURCE[0]}" --apply --agent agentG)"
  grep -q 'fix: closed the gap' "$g_target" \
    && echo "  ok   \"no server running\" is an ANSWER, not a failure -- the sync proceeds" \
    || { echo "  FAIL a parked box was treated as undetermined:"; echo "$out10"; fail=1; }

  # --- PART 5: REAL tmux, not the fake-binary/env-var stand-ins above (card 75b90343 part 1) -----
  # Every case above drives _load_running_sessions via either AGENT_SKILL_DRIFT_TEST_SESSIONS (a
  # value that stands in for tmux's output BEFORE the real branch at _load_running_sessions ever
  # runs) or a fake `tmux` binary on PATH. Neither one executes the actual `command -v tmux` /
  # `tmux list-sessions` code this tool runs in production -- a real tmux version that phrases its
  # errors differently would sail through every case above with zero red tests. This block runs the
  # genuine binary, isolated so it cannot touch the live fleet's tmux server: TMUX_TMPDIR points at
  # a throwaway directory, AND $TMUX is unset -- TMUX_TMPDIR alone is not enough, because a tmux
  # CLIENT invoked from inside an existing tmux pane (which this very selftest may be running
  # under) ignores TMUX_TMPDIR and reconnects to the session named in $TMUX instead (measured: with
  # $TMUX left set, the isolated calls below reached the real 11-session fleet server). Skippable
  # when tmux is not installed on this host, per the card's own scope note.
  if command -v tmux >/dev/null 2>&1; then
    TMUX_ISO="$(mktemp -d)"
    real_tmux() { env -u TMUX TMUX_TMPDIR="$TMUX_ISO" tmux "$@"; }
    iso_run() { env -u TMUX TMUX_TMPDIR="$TMUX_ISO" AGENT_SKILL_DRIFT_ROOT="$tmp/root" \
                bash "${BASH_SOURCE[0]}" --apply --agent agentG; }

    # (a) MEASURED (2026-09-07, tmux 3.6, this host): a socket that was never used at all errors
    # "No such file or directory", which does not match "no server running" -> undetermined.
    g_stale
    out16="$(iso_run)"
    echo "$out16" | grep -q 'could not determine whether agentG is running' \
      && echo "  ok   REAL tmux, never-used socket -> undetermined (matches the measured error text)" \
      || { echo "  FAIL never-used-socket case did not report undetermined:"; echo "$out16"; fail=1; }
    grep -q 'OLD VERSION' "$g_target" \
      && echo "  ok   the never-used-socket read left the file untouched (fail-closed)" \
      || { echo "  FAIL the never-used-socket read wrote to the file"; fail=1; }

    # (b) a GENUINE session named agent-agentG -> the real code must classify it as RUNNING, driven
    # by actual tmux output, not a fixture standing in for it.
    real_tmux new-session -d -s agent-agentG
    g_stale
    out17="$(iso_run)"
    echo "$out17" | grep -q 'agentG is RUNNING' \
      && echo "  ok   REAL tmux with a genuine agent-agentG session -> classified as RUNNING" \
      || { echo "  FAIL a real running session was not classified as RUNNING:"; echo "$out17"; fail=1; }
    grep -q 'OLD VERSION' "$g_target" \
      && echo "  ok   a genuinely running agent's file stayed untouched" \
      || { echo "  FAIL a genuinely running agent's file was overwritten"; fail=1; }

    # (c) THE CONTROL: once the transient window has passed, tmux settles to "no server running"
    # (a genuine parked answer), and the sync must proceed. Without this, a guard that always fails
    # closed on real tmux would pass every assertion above. MEASURED (2026-09-07, tmux 3.6, this
    # host): the FIRST call immediately after kill-server can still catch a transient "server exited
    # unexpectedly" (also undetermined, same safe direction -- see the classify_copy-adjacent doc
    # comment above _agent_running_state), but that window is sub-tens-of-milliseconds and closes
    # before this script's own startup work (identity rendering, etc.) completes, so asserting on it
    # through a full script invocation would be racy, not deterministic. One warm-up read here
    # deliberately consumes that window so the assertion below tests the settled state on purpose,
    # not by accident of timing.
    real_tmux kill-server 2>/dev/null
    real_tmux list-sessions -F '#{session_name}' >/dev/null 2>&1
    g_stale
    out18="$(iso_run)"
    grep -q 'fix: closed the gap' "$g_target" \
      && echo "  ok   REAL tmux, settled \"no server running\" -> genuinely parked, sync proceeds" \
      || { echo "  FAIL the settled no-server-running state did not sync:"; echo "$out18"; fail=1; }

    rm -rf "$TMUX_ISO"
  else
    echo "  skip REAL tmux integration case (tmux not installed on this host)"
  fi

  # ---------------------------------------------------------------------------------------------
  # The change-based alert trigger (card 222fdc5e). The bug being pinned: the heartbeat treated
  # diverged>0 as newsworthy, and the live steady state IS diverged>0 (measured: current=93 stale=0
  # diverged=5), so it sent the same five lines four times a day forever. What is newsworthy is the
  # SET CHANGING -- and a count cannot see one entry replacing another, which is why these cases
  # check a swap, not just a growth.
  # ---------------------------------------------------------------------------------------------
  st="$tmp/alert-state.json"
  alert_run() { AGENT_SKILL_DRIFT_ROOT="$tmp/root" AGENT_SKILL_DRIFT_STATE="$st" \
                bash "${BASH_SOURCE[0]}" "$@"; }

  # A dry-run must not create a baseline: someone LOOKING must not consume the change that the next
  # real run is supposed to announce.
  rm -f "$st"
  out6="$(alert_run --telegram)"
  echo "$out6" | grep -q 'ALERT:yes reasons=no-baseline' \
    && echo "  ok   first look with no state -> ALERT:yes (no-baseline)" \
    || { echo "  FAIL no-baseline not reported:"; echo "$out6"; fail=1; }
  [ ! -f "$st" ] && echo "  ok   a dry-run wrote NO baseline" \
    || { echo "  FAIL a dry-run wrote the state file"; fail=1; }

  # --apply establishes the baseline...
  out7="$(alert_run --apply --telegram)"
  echo "$out7" | grep -q 'ALERT:yes' && [ -f "$st" ] \
    && echo "  ok   --apply reports and writes the baseline" \
    || { echo "  FAIL --apply did not baseline:"; echo "$out7"; fail=1; }

  # ...and the SECOND identical run is the whole point of the card: silence.
  out8="$(alert_run --apply --telegram)"
  echo "$out8" | grep -q 'ALERT:no' \
    && echo "  ok   unchanged diverged set -> ALERT:no (the routine run is quiet)" \
    || { echo "  FAIL an unchanged run still alerted:"; echo "$out8"; fail=1; }

  # A SWAP: one diverged copy heals, another appears. The COUNT is identical (1), so a count-based
  # trigger would stay silent through a real change -- the failure this design exists to prevent.
  printf 'NEW FIXED VERSION\ninstall dir: %s\nagent: selftest\nfix: closed the gap\n' "$tmp/root" \
    > "$tmp/root/agents/agentB/.claude/skills/demo-skill/SKILL.md"
  mkdir -p "$tmp/root/agents/agentG/.claude/skills/demo-skill"
  printf 'OLD VERSION\ninstall dir: %s\nagent: selftest\nA DIFFERENT HAND-PATCH\n' "$tmp/root" \
    > "$tmp/root/agents/agentG/.claude/skills/demo-skill/SKILL.md"
  count_before="$(echo "$out8" | sed -n 's/.*ALERT:no.*, \([0-9]*\) entr.*/\1/p')"
  out9="$(alert_run --apply --telegram)"
  count_after="$(echo "$out9" | sed -n 's/.*ALERT:yes.* diverged=\([0-9]*\) .*/\1/p')"
  # The count must be UNCHANGED across the swap -- that is what makes this a real test of the design.
  # Asserted against the MEASURED before-count rather than a literal, because the fixtures above
  # contribute diverged entries of their own and hard-coding a number here would silently stop
  # testing the swap the day one of them changes.
  [ -n "$count_before" ] && [ "$count_before" = "$count_after" ] \
    && echo "  ok   the swap kept the COUNT at $count_after (a count-based trigger would miss it)" \
    || { echo "  FAIL not an equal-count swap (before='$count_before' after='$count_after'):"; echo "$out9"; fail=1; }
  echo "$out9" | grep -q 'ALERT:yes reasons=diverged-set-changed' \
    && echo "  ok   an equal-count SET change still alerts" \
    || { echo "  FAIL a set change with an unchanged count did not alert:"; echo "$out9"; fail=1; }

  # An unreadable baseline must say so and ALERT -- never decay into a silent "no baseline", and
  # never take the six-hourly sync down with a die() (see emit_alert_verdict's comment).
  printf 'this is not json\n' > "$st"
  out10="$(alert_run --telegram)"
  echo "$out10" | grep -q 'ALERT:yes reasons=baseline-unreadable' \
    && echo "  ok   a corrupt baseline alerts and says which" \
    || { echo "  FAIL corrupt baseline mishandled:"; echo "$out10"; fail=1; }

  # Scanning NOTHING must not read as routine.
  out11="$(AGENT_SKILL_DRIFT_ROOT="$tmp/empty-root" AGENT_SKILL_DRIFT_STATE="$st" \
           bash "${BASH_SOURCE[0]}" --telegram)"
  echo "$out11" | grep -q 'ALERT:yes reasons=no-agents-dir' \
    && echo "  ok   a missing agents dir alerts instead of returning quietly" \
    || { echo "  FAIL scanning nothing passed as routine:"; echo "$out11"; fail=1; }

  # --- PART 6: clone-family MISSING-skill detection (card a6abb230; F2 source/symlink fix on
  # card 85521c7e) --------------------------------------------------------------------------------
  # Own isolated root: _family_members only recognizes the real fleet names (backend/backend2/
  # backend3, qa/qa2, fron-ted/fron-teddy), so these fixtures cannot collide with the demo-skill
  # cases above, but a separate root keeps the two concerns visibly apart anyway.
  #
  # F2 changed the copy SOURCE from a sibling's live directory to the tracked seed-fleet-agents
  # copy, so fixtures now need BOTH trees: a live tree (what determines "missing" -- the union of
  # skill names present on any family member) and a seed-fleet-agents tree (what a copy is actually
  # allowed to read from).
  mkdir -p "$tmp/family-root/agents/backend/.claude/skills/skillA"
  mkdir -p "$tmp/family-root/agents/backend2/.claude/skills/skillB"
  mkdir -p "$tmp/family-root/agents/backend3/.claude/skills"
  printf 'SKILL A CONTENT\n' > "$tmp/family-root/agents/backend/.claude/skills/skillA/SKILL.md"
  printf 'SKILL B CONTENT\n' > "$tmp/family-root/agents/backend2/.claude/skills/skillB/SKILL.md"
  # The tracked seed mirrors backend/skillA and backend2/skillB -- this is what a copy actually reads.
  mkdir -p "$tmp/family-root/seed-fleet-agents/backend/.claude/skills/skillA"
  mkdir -p "$tmp/family-root/seed-fleet-agents/backend2/.claude/skills/skillB"
  printf 'SKILL A CONTENT\n' > "$tmp/family-root/seed-fleet-agents/backend/.claude/skills/skillA/SKILL.md"
  printf 'SKILL B CONTENT\n' > "$tmp/family-root/seed-fleet-agents/backend2/.claude/skills/skillB/SKILL.md"
  # backend2 ALREADY has its own skillC (independently authored, different content from backend's) --
  # this must NEVER be touched: existence alone, even with different content, means "not missing".
  mkdir -p "$tmp/family-root/agents/backend/.claude/skills/skillC"
  mkdir -p "$tmp/family-root/agents/backend2/.claude/skills/skillC"
  mkdir -p "$tmp/family-root/agents/backend3/.claude/skills/skillC"
  printf 'BACKEND OWN skillC\n' > "$tmp/family-root/agents/backend/.claude/skills/skillC/SKILL.md"
  printf 'BACKEND2 OWN skillC (independently authored)\n' > "$tmp/family-root/agents/backend2/.claude/skills/skillC/SKILL.md"
  printf 'BACKEND3 OWN skillC (independently authored)\n' > "$tmp/family-root/agents/backend3/.claude/skills/skillC/SKILL.md"
  # skillD: LIVE on backend2 only, and deliberately has NO seed-fleet-agents entry anywhere in the
  # family -- an unreviewed/hand-adopted skill. This is exactly what card 85521c7e's live incident
  # was: it must be reported, and NEVER copied, no matter --apply.
  mkdir -p "$tmp/family-root/agents/backend2/.claude/skills/skillD"
  printf 'UNREVIEWED, NOT IN ANY SEED\n' > "$tmp/family-root/agents/backend2/.claude/skills/skillD/SKILL.md"
  # skillE: LIVE on backend2, and its seed-fleet-agents copy (also on backend2) contains a symlink
  # that resolves OUTSIDE the skill directory -- a hazard even from the "trusted" tracked source
  # (committed by mistake or malice). Must be refused, even though the skill IS in the seed.
  mkdir -p "$tmp/family-root/agents/backend2/.claude/skills/skillE"
  printf 'SKILL E\n' > "$tmp/family-root/agents/backend2/.claude/skills/skillE/SKILL.md"
  mkdir -p "$tmp/family-root/seed-fleet-agents/backend2/.claude/skills/skillE"
  printf 'SKILL E\n' > "$tmp/family-root/seed-fleet-agents/backend2/.claude/skills/skillE/SKILL.md"
  printf 'outside secret\n' > "$tmp/outside-secret.txt"
  ln -s "$tmp/outside-secret.txt" "$tmp/family-root/seed-fleet-agents/backend2/.claude/skills/skillE/escape-link"

  # Forces the running-agent guard to see nothing running (deterministic parked state), so these
  # tests exercise the sync itself, not the guard -- the guard gets its own dedicated case below.
  # Without this, "backend"/"backend2"/"backend3" are also this FLEET's own real tmux session names,
  # and a run on a live box would find them genuinely running and skip every sync (measured: it did).
  fam_run() { AGENT_SKILL_DRIFT_ROOT="$tmp/family-root" AGENT_SKILL_DRIFT_TEST_SESSIONS="" \
              bash "${BASH_SOURCE[0]}" "$@"; }

  # Dry run: report only, nothing written.
  outF1="$(fam_run --telegram)"
  echo "$outF1" | grep -q 'missing=' && ! echo "$outF1" | grep -qE 'missing=0[^0-9]' \
    && echo "  ok   dry-run reports a nonzero missing count" \
    || { echo "  FAIL dry-run did not report missing skills:"; echo "$outF1"; fail=1; }
  [ ! -e "$tmp/family-root/agents/backend2/.claude/skills/skillA" ] \
    && [ ! -e "$tmp/family-root/agents/backend/.claude/skills/skillB" ] \
    && [ ! -e "$tmp/family-root/agents/backend3/.claude/skills/skillA" ] \
    && echo "  ok   dry-run created nothing" \
    || { echo "  FAIL dry-run wrote a skill directory"; fail=1; }

  # --apply: a sibling's skill is copied from seed-fleet-agents (never the live directory),
  # byte-for-byte, into every member missing it.
  fam_run --apply >/dev/null
  if [ "$(cat "$tmp/family-root/agents/backend2/.claude/skills/skillA/SKILL.md" 2>/dev/null)" = "SKILL A CONTENT" ] \
     && [ "$(cat "$tmp/family-root/agents/backend/.claude/skills/skillB/SKILL.md" 2>/dev/null)" = "SKILL B CONTENT" ] \
     && [ "$(cat "$tmp/family-root/agents/backend3/.claude/skills/skillA/SKILL.md" 2>/dev/null)" = "SKILL A CONTENT" ] \
     && [ "$(cat "$tmp/family-root/agents/backend3/.claude/skills/skillB/SKILL.md" 2>/dev/null)" = "SKILL B CONTENT" ]; then
    echo "  ok   --apply filled every member's gap from seed-fleet-agents, content byte-identical"
  else
    echo "  FAIL --apply did not fill the clone-family gaps correctly"; fail=1
  fi

  # The three independently-authored skillC copies must survive UNTOUCHED -- this is the guarantee
  # that makes the whole feature additive-only: existing content is never a sync target.
  if [ "$(cat "$tmp/family-root/agents/backend/.claude/skills/skillC/SKILL.md")" = "BACKEND OWN skillC" ] \
     && [ "$(cat "$tmp/family-root/agents/backend2/.claude/skills/skillC/SKILL.md")" = "BACKEND2 OWN skillC (independently authored)" ] \
     && [ "$(cat "$tmp/family-root/agents/backend3/.claude/skills/skillC/SKILL.md")" = "BACKEND3 OWN skillC (independently authored)" ]; then
    echo "  ok   pre-existing skillC on all three siblings stayed byte-untouched (additive-only, never overwrites)"
  else
    echo "  FAIL an existing skill directory was overwritten -- SAFETY VIOLATION"; fail=1
  fi

  # SECURITY (card 85521c7e F2, the actual fix): skillD exists live on backend2 but has NO
  # seed-fleet-agents entry anywhere in the family -- --apply must NOT copy it to backend/backend3,
  # only report it, distinctly worded so a human knows it needs review, not "just sync it".
  outApplyD="$(fam_run --apply --telegram)"
  if [ ! -e "$tmp/family-root/agents/backend/.claude/skills/skillD" ] \
     && [ ! -e "$tmp/family-root/agents/backend3/.claude/skills/skillD" ]; then
    echo "  ok   SECURITY: a live-only, unreviewed skill (skillD) is NEVER copied, even under --apply"
  else
    echo "  FAIL skillD (live-only, no seed-fleet-agents entry) was copied -- QUARANTINE BYPASS"; fail=1
  fi
  echo "$outApplyD" | grep -q 'skillD' && echo "$outApplyD" | grep -qi 'never auto-synced' \
    && echo "  ok   skillD is reported with the never-auto-synced wording (needs human review)" \
    || { echo "  FAIL skillD's report is missing or miscategorized:"; echo "$outApplyD"; fail=1; }

  # SECURITY (card 85521c7e F2): skillE IS in seed-fleet-agents, but that seed copy contains a
  # symlink resolving outside its own directory -- --apply must refuse it too, not just a live-only
  # skill. Defense in depth: even a "tracked" source is not blindly trusted if it looks like this.
  outApplyE="$(fam_run --apply --telegram)"
  if [ ! -e "$tmp/family-root/agents/backend/.claude/skills/skillE" ] \
     && [ ! -e "$tmp/family-root/agents/backend3/.claude/skills/skillE" ]; then
    echo "  ok   SECURITY: a seed-fleet-agents copy with an escaping symlink (skillE) is REFUSED"
  else
    echo "  FAIL skillE (escaping symlink in the seed copy) was copied -- SYMLINK ESCAPE"; fail=1
  fi
  echo "$outApplyE" | grep -q 'skillE' && echo "$outApplyE" | grep -qi 'escaping.*REFUSED\|REFUSED'\
    && echo "  ok   skillE is reported as REFUSED (escaping symlink), not silently dropped" \
    || { echo "  FAIL skillE's refusal is not reported:"; echo "$outApplyE"; fail=1; }

  # --agent filter narrows which member is SYNCED, but the union must still be computed from ALL
  # siblings -- otherwise a --agent backend3 run could never see what backend/backend2 have.
  rm -rf "$tmp/family-root/agents/backend3/.claude/skills/skillA" "$tmp/family-root/agents/backend3/.claude/skills/skillB"
  outF2="$(fam_run --apply --agent backend3 --telegram)"
  if [ "$(cat "$tmp/family-root/agents/backend3/.claude/skills/skillA/SKILL.md" 2>/dev/null)" = "SKILL A CONTENT" ]; then
    echo "  ok   --agent backend3 still fills its gap from seed-fleet-agents (union not narrowed by the filter)"
  else
    echo "  FAIL --agent filter starved the union -- backend3 was not synced"; fail=1
  fi

  # Running-agent guard applies to missing-sync exactly like it applies to stale-sync: a member
  # confirmed RUNNING must be skipped, and the report must say so and carry it as a reason. backend3
  # is still missing BOTH skillA and skillE at this point (skillE never got created -- it was
  # correctly REFUSED above for the symlink reason, not synced), so a RUNNING backend3 skips 2, not 1.
  rm -rf "$tmp/family-root/agents/backend3/.claude/skills/skillA"
  outF3="$(AGENT_SKILL_DRIFT_ROOT="$tmp/family-root" AGENT_SKILL_DRIFT_TEST_SESSIONS="agent-backend3" \
           bash "${BASH_SOURCE[0]}" --apply --agent backend3)"
  [ ! -e "$tmp/family-root/agents/backend3/.claude/skills/skillA" ] \
    && [ ! -e "$tmp/family-root/agents/backend3/.claude/skills/skillE" ] \
    && echo "  ok   a RUNNING member's missing-skill sync is skipped, files stay absent" \
    || { echo "  FAIL a running member's tree was written to"; fail=1; }
  echo "$outF3" | grep -q 'missing-skipped-running=2' \
    && echo "  ok   the verdict line carries missing-skipped-running=2 (skillA AND skillE)" \
    || { echo "  FAIL missing-skipped-running=2 missing from the verdict:"; echo "$outF3"; fail=1; }
  echo "$outF3" | grep -q 'reasons=.*missing-running-agent-skipped' \
    && echo "  ok   missing-running-agent-skipped is its own reason" \
    || { echo "  FAIL missing-running-agent-skipped is not among the reasons:"; echo "$outF3"; fail=1; }

  # CONTROL: the same fixture, parked -- must still sync. Without this, a guard that refuses every
  # write would pass the RUNNING assertions above for the wrong reason. skillE must STILL be absent
  # here -- parking the agent lifts the running-guard, not the independent symlink refusal.
  outF4="$(AGENT_SKILL_DRIFT_ROOT="$tmp/family-root" AGENT_SKILL_DRIFT_TEST_SESSIONS="agent-someone-else" \
           bash "${BASH_SOURCE[0]}" --apply --agent backend3)"
  [ "$(cat "$tmp/family-root/agents/backend3/.claude/skills/skillA/SKILL.md" 2>/dev/null)" = "SKILL A CONTENT" ] \
    && echo "  ok   CONTROL: a PARKED member is still synced -- the guard is not a blanket refusal" \
    || { echo "  FAIL a parked member was not synced:"; echo "$outF4"; fail=1; }
  [ ! -e "$tmp/family-root/agents/backend3/.claude/skills/skillE" ] \
    && echo "  ok   ...but skillE (escaping symlink) is STILL refused once parked -- separate guard" \
    || { echo "  FAIL skillE was copied once backend3 was parked -- symlink guard bypassed"; fail=1; }

  # An agent outside every known family (e.g. one of the demo fixtures above) contributes nothing
  # and is never flagged -- the feature must stay silent where no family is declared.
  outF5="$(AGENT_SKILL_DRIFT_ROOT="$tmp/root" AGENT_SKILL_DRIFT_STATE="$tmp/no-family-state.json" \
           bash "${BASH_SOURCE[0]}" --telegram --agent agentA)"
  echo "$outF5" | grep -qE 'missing=0([^0-9]|$)' \
    && echo "  ok   an agent outside every declared family reports missing=0" \
    || { echo "  FAIL an undeclared-family agent was scanned for missing skills:"; echo "$outF5"; fail=1; }

  # Non-vacuity on the fixtures themselves: every alert case above ran against the throwaway root
  # and the throwaway state path, so none of them can have touched the live install's state file.
  [ ! -e "/home/neon/marveen/store/agent-skill-drift-state.json.tmp.$$" ] \
    && echo "  ok   no stray temp state left in the live install" \
    || { echo "  FAIL selftest leaked a temp state file into the live install"; fail=1; }

  [ $fail -eq 0 ] && { echo 'selftest: PASS'; exit 0; } || { echo 'selftest: FAIL'; exit 1; }
fi

run_scan
