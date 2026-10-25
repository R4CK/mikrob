#!/usr/bin/env bash
# skill-map-consistency-check.sh -- card d2d47a92, design item 4.
#
# Fails when an agent's CLAUDE.md names (in a "- `skill-name` -- ..." core-skill line) a skill
# that store/skill-role-map.json does NOT give that agent (fleet-core ∪ roles[agent]). The map is
# the thing the provisioner actually symlinks from; a CLAUDE.md that documents a skill the map
# withholds would mean the agent's own docs promise a skill its `.claude/skills/` directory never
# gets, silently, until someone notices by hand.
#
# Only checks the ONE direction stated in the card (CLAUDE.md names it -> map must give it). The
# reverse (map gives a skill CLAUDE.md never mentions) is not a violation: fleet-core skills are
# deliberately NOT meant to be hand-documented in every agent's CLAUDE.md one by one (that is
# exactly the hand-copied-drift problem this card exists to kill).
#
# Usage:
#   skill-map-consistency-check.sh                 # check every agents/<name>/CLAUDE.md
#   skill-map-consistency-check.sh --agent backend # limit to one agent (repeatable)
#   skill-map-consistency-check.sh selftest        # fixture-based checks
#
# Env overrides (selftest never touches the live install):
#   SKILL_MAP_CONSISTENCY_AGENTS_DIR / _MAP
#
# Exit: 0 = consistent (or nothing to check), 1 = at least one violation found, 2 = bad usage.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SKILL_MAP_CONSISTENCY_ROOT:-$(cd "$HERE/.." && pwd)}"
AGENTS_DIR="${SKILL_MAP_CONSISTENCY_AGENTS_DIR:-$ROOT/agents}"
MAP="${SKILL_MAP_CONSISTENCY_MAP:-$ROOT/store/skill-role-map.json}"

ONLY_AGENTS=()
MODE=report
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)   ONLY_AGENTS+=("$2"); shift 2 ;;
    selftest)  MODE=selftest; shift ;;
    -h|--help) sed -n '/^# Usage:/,/^# Exit:/p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "skill-map-consistency-check: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

_wanted_agent() {
  [ "${#ONLY_AGENTS[@]}" -eq 0 ] && return 0
  local a
  for a in "${ONLY_AGENTS[@]}"; do [ "$a" = "$1" ] && return 0; done
  return 1
}

# Allowed set for one agent, one name per line, from the map (fleet-core + roles[agent]).
_allowed_skills() {
  local agent="$1"
  python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        m = json.load(f)
except Exception:
    sys.exit(0)
for s in m.get('fleet-core', []):
    print(s)
for s in m.get('roles', {}).get(sys.argv[2], []):
    print(s)
" "$MAP" "$agent" 2>/dev/null
}

# Skill names an agent's CLAUDE.md documents as its own core skills: lines of the form
# "- `name` -- ..." anywhere in the file (same convention the skill-role-map.md generator reads).
_documented_skills() {
  grep -oE '^- `[a-zA-Z0-9][a-zA-Z0-9_-]*`' "$1" 2>/dev/null | sed -E 's/^- `//; s/`$//' | sort -u
}

run_check() {
  local violations=0
  [ -d "$AGENTS_DIR" ] || { echo "skill-map-consistency-check: no $AGENTS_DIR -- nothing to check"; return 0; }

  for adir in "$AGENTS_DIR"/*/; do
    [ -d "$adir" ] || continue
    agent="$(basename "${adir%/}")"
    _wanted_agent "$agent" || continue
    claude_md="$adir/CLAUDE.md"
    [ -f "$claude_md" ] || continue

    allowed="$(_allowed_skills "$agent")"
    documented="$(_documented_skills "$claude_md")"
    [ -n "$documented" ] || continue

    while IFS= read -r skill; do
      [ -n "$skill" ] || continue
      if ! printf '%s\n' "$allowed" | grep -qxF "$skill"; then
        echo "VIOLATION: ${agent}/CLAUDE.md names \`${skill}\` as a core skill, but skill-role-map.json does not give ${agent} that skill (neither fleet-core nor roles.${agent})"
        violations=$((violations+1))
      fi
    done <<<"$documented"
  done

  if [ "$violations" -gt 0 ]; then
    echo "skill-map-consistency-check: $violations violation(s)"
    return 1
  fi
  echo "skill-map-consistency-check: consistent"
  return 0
}

run_selftest() {
  local tmp fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  mkdir -p "$tmp/agents/alpha" "$tmp/agents/beta"
  cat >"$tmp/agents/alpha/CLAUDE.md" <<'EOF'
# Alpha
- `karpathy-guidelines` -- core
- `only-in-map` -- also core
EOF
  cat >"$tmp/agents/beta/CLAUDE.md" <<'EOF'
# Beta
- `karpathy-guidelines` -- core
- `undocumented-in-map` -- a violation
EOF
  cat >"$tmp/map.json" <<'EOF'
{
  "fleet-core": ["karpathy-guidelines"],
  "roles": { "alpha": ["only-in-map"], "beta": [] }
}
EOF

  out="$(SKILL_MAP_CONSISTENCY_AGENTS_DIR="$tmp/agents" SKILL_MAP_CONSISTENCY_MAP="$tmp/map.json" "${BASH_SOURCE[0]}" --agent alpha)"
  rc=$?
  [ "$rc" -eq 0 ] && echo "$out" | grep -q "consistent" \
    && echo "  ok   alpha (fleet-core + its own role entry) is consistent" \
    || { echo "  FAIL alpha should be consistent (rc=$rc): $out"; fail=1; }

  out="$(SKILL_MAP_CONSISTENCY_AGENTS_DIR="$tmp/agents" SKILL_MAP_CONSISTENCY_MAP="$tmp/map.json" "${BASH_SOURCE[0]}" --agent beta)"
  rc=$?
  [ "$rc" -eq 1 ] && echo "$out" | grep -q "undocumented-in-map" \
    && echo "  ok   beta's undocumented-in-map violation is caught and named" \
    || { echo "  FAIL beta should fail naming undocumented-in-map (rc=$rc): $out"; fail=1; }

  out="$(SKILL_MAP_CONSISTENCY_AGENTS_DIR="$tmp/agents" SKILL_MAP_CONSISTENCY_MAP="$tmp/map.json" "${BASH_SOURCE[0]}")"
  rc=$?
  [ "$rc" -eq 1 ] && echo "$out" | grep -q "1 violation" \
    && echo "  ok   a full run (no --agent filter) reports exactly 1 violation" \
    || { echo "  FAIL full run should report exactly 1 violation (rc=$rc): $out"; fail=1; }

  # A skill the map GIVES but CLAUDE.md never mentions is NOT a violation (fleet-core skills are
  # deliberately not hand-documented everywhere).
  cat >"$tmp/map.json" <<'EOF'
{
  "fleet-core": ["karpathy-guidelines", "never-mentioned-fleet-core"],
  "roles": { "alpha": ["only-in-map"], "beta": [] }
}
EOF
  out="$(SKILL_MAP_CONSISTENCY_AGENTS_DIR="$tmp/agents" SKILL_MAP_CONSISTENCY_MAP="$tmp/map.json" "${BASH_SOURCE[0]}" --agent alpha)"
  rc=$?
  [ "$rc" -eq 0 ] \
    && echo "  ok   a map-only (undocumented) fleet-core skill is NOT a violation" \
    || { echo "  FAIL map-only skill should not be a violation (rc=$rc): $out"; fail=1; }

  rm -rf "$tmp"
  trap - EXIT
  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; return 0; else echo "selftest: FAIL"; return 1; fi
}

if [ "$MODE" = selftest ]; then
  run_selftest
  exit $?
else
  run_check
  exit $?
fi
