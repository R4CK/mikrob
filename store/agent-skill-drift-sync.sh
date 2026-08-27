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
# Exit: 0 always (report tool, not a gate) -- selftest exits 1 on failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AGENT_SKILL_DRIFT_ROOT:-$(cd "$HERE/.." && pwd)}"
AGENTS_DIR="${AGENT_SKILL_DRIFT_AGENTS_DIR:-$ROOT/agents}"
SEEDS_DIR="${AGENT_SKILL_DRIFT_SEEDS_DIR:-$ROOT/seed-skills}"
HIST_CAP=25   # same cap update.sh's seed_copy_is_untouched uses -- a skill unfixed for 25+
              # revisions is not worth the extra git calls (update.sh:605-606).

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
  CUR=0; STALE=0; DIVERGED=0; SKIPPED=0
  STALE_LIST=""; DIVERGED_LIST=""

  [ -d "$AGENTS_DIR" ] || { echo "agent-skill-drift-sync: no $AGENTS_DIR -- nothing to scan"; return 0; }

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
            # Test-only hook: a no-op in every real invocation (the env var is never set outside
            # selftest). Lets selftest deterministically simulate a concurrent write landing in
            # the classify->mv window, instead of relying on a flaky sleep-based race.
            if [ -n "${AGENT_SKILL_DRIFT_TEST_RACE_HOOK:-}" ]; then "$AGENT_SKILL_DRIFT_TEST_RACE_HOOK" "$installed"; fi
            tmp="$installed.$$.tmp"
            if render_seed_template <"$ROOT/$rel" >"$tmp"; then
              live_hash="$(_hash <"$installed" 2>/dev/null)"
              if [ "$live_hash" != "$classify_hash" ]; then
                rm -f "$tmp"
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

  race_hook="$tmp/race_hook.sh"
  cat > "$race_hook" <<'HOOK'
#!/usr/bin/env bash
# match by glob, not exact string -- the caller's $installed path can carry an extra "/" (from
# the trailing-slash glob it's built from), which would defeat an exact-path comparison.
case "$1" in
  */agentF/*/demo-skill/*SKILL.md)
    printf 'CONCURRENT LOCAL EDIT, MUST SURVIVE\n' > "$1"
    ;;
esac
HOOK
  chmod +x "$race_hook"

  out5="$(AGENT_SKILL_DRIFT_ROOT="$tmp/root" AGENT_SKILL_DRIFT_TEST_RACE_HOOK="$race_hook" \
          bash "${BASH_SOURCE[0]}" --apply --agent agentF)"
  echo "$out5" | grep -q 'SKIPPED, file changed between classify and sync' \
    && echo "  ok   TOCTOU race detected and sync skipped, reported" \
    || { echo "  FAIL TOCTOU race not detected/reported:"; echo "$out5"; fail=1; }
  [ "$(cat "$f_target")" = "CONCURRENT LOCAL EDIT, MUST SURVIVE" ] \
    && echo "  ok   concurrent local edit survived (not overwritten by the sync)" \
    || { echo "  FAIL concurrent local edit was lost -- TOCTOU not closed"; fail=1; }

  [ $fail -eq 0 ] && { echo 'selftest: PASS'; exit 0; } || { echo 'selftest: FAIL'; exit 1; }
fi

run_scan
