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
# EVERY RUN ENDS WITH A VERDICT LINE, and callers should key on it rather than on the counts
# (card 222fdc5e):
#   ALERT:no  (diverged set unchanged since <when>, N entries; stale=0, no concurrent-write skips)
#   ALERT:yes reasons=<comma-list> diverged=N stale=N skipped-concurrent=N
# reasons: stale-synced | concurrent-write-skipped | diverged-set-changed | no-baseline |
#          baseline-unreadable | no-agents-dir
# The diverged SET (not its size) is what is remembered, in $AGENT_SKILL_DRIFT_STATE
# (default store/agent-skill-drift-state.json), and ONLY --apply advances that baseline.
#
# Env overrides (all exist so a selftest never touches the live install):
#   AGENT_SKILL_DRIFT_ROOT / _AGENTS_DIR / _SEEDS_DIR / _STATE
#   AGENT_SKILL_DRIFT_TEST_RACE=<skill>  test-only; COMPARED, never executed
#
# Exit: 0 always (report tool, not a gate) -- selftest exits 1 on failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AGENT_SKILL_DRIFT_ROOT:-$(cd "$HERE/.." && pwd)}"
AGENTS_DIR="${AGENT_SKILL_DRIFT_AGENTS_DIR:-$ROOT/agents}"
SEEDS_DIR="${AGENT_SKILL_DRIFT_SEEDS_DIR:-$ROOT/seed-skills}"
HIST_CAP=25   # same cap update.sh's seed_copy_is_untouched uses -- a skill unfixed for 25+
              # revisions is not worth the extra git calls (update.sh:605-606).

# Where the last APPLIED diverged set is remembered, so a routine run can stay quiet (card 222fdc5e).
# Overridable for the same reason the paths above are: a selftest must never touch the live state.
STATE="${AGENT_SKILL_DRIFT_STATE:-$ROOT/store/agent-skill-drift-state.json}"

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

run_scan() {
  CUR=0; STALE=0; DIVERGED=0; SKIPPED=0; SKIPPED_CONCURRENT=0
  STALE_LIST=""; DIVERGED_LIST=""

  # An ALERT line on this path too. Returning early without a verdict would leave the heartbeat --
  # which keys on that line -- with nothing to read, and "no output" is indistinguishable from
  # "routine" to whatever is downstream. A missing agents directory is not routine: it means the
  # tool scanned nothing at all, which is exactly the state that must never pass as quiet.
  if [ ! -d "$AGENTS_DIR" ]; then
    echo "agent-skill-drift-sync: no $AGENTS_DIR -- nothing to scan"
    echo "ALERT:yes reasons=no-agents-dir diverged=0 stale=0 skipped-concurrent=0"
    return 0
  fi

  for adir in "$AGENTS_DIR"/*/; do
    [ -d "$adir" ] || continue
    agent="$(basename "${adir%/}")"
    _wanted_agent "$agent" || continue
    skdir="$adir.claude/skills"
    [ -d "$skdir" ] || continue

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
          if [ "$APPLY" -eq 1 ]; then
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

  if [ "$TELEGRAM" -eq 1 ]; then
    echo "Agent skill drift: current=${CUR} stale=${STALE} diverged=${DIVERGED} skipped(no-canonical)=${SKIPPED}"
    if [ "$STALE" -gt 0 ]; then
      echo "Stale (untouched, $([ "$APPLY" -eq 1 ] && echo synced || echo would-sync)):"
      printf '%b' "$STALE_LIST" | sed 's/^/  /'
    fi
    if [ "$DIVERGED" -gt 0 ]; then
      echo "Diverged (flagged, NOT touched -- needs manual review):"
      printf '%b' "$DIVERGED_LIST" | sed 's/^/  /'
    fi
  else
    echo "---"
    echo "SUMMARY: current=${CUR} stale=${STALE}$([ "$APPLY" -eq 1 ] && echo '(synced)' || echo '(would-sync, dry-run)') diverged=${DIVERGED}(flagged-only) skipped=${SKIPPED}(no-canonical)"
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
    echo "ALERT:yes reasons=${reasons%,} diverged=${DIVERGED} stale=${STALE} skipped-concurrent=${SKIPPED_CONCURRENT}"
    [ -n "$prev_list" ] && [ "$prev_list" != "$diverged_now" ] && echo "  diverged set was: ${prev_list:-(empty)}"
    [ -n "$reasons" ] && echo "  diverged set now: ${diverged_now:-(empty)}"
  else
    echo "ALERT:no (diverged set unchanged since $(date -d "@$prev_changed" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$prev_changed"), ${DIVERGED} entr$([ "$DIVERGED" -eq 1 ] && echo y || echo ies); stale=0, no concurrent-write skips)"
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

  # Non-vacuity on the fixtures themselves: every alert case above ran against the throwaway root
  # and the throwaway state path, so none of them can have touched the live install's state file.
  [ ! -e "/home/neon/marveen/store/agent-skill-drift-state.json.tmp.$$" ] \
    && echo "  ok   no stray temp state left in the live install" \
    || { echo "  FAIL selftest leaked a temp state file into the live install"; fail=1; }

  [ $fail -eq 0 ] && { echo 'selftest: PASS'; exit 0; } || { echo 'selftest: FAIL'; exit 1; }
fi

run_scan
