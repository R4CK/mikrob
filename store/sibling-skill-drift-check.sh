#!/usr/bin/env bash
# sibling-skill-drift-check.sh -- one-shot read-only drift check across sibling-agent
# clone families (card c40385b1, MikroB decision msg 10538: "egyszeri ellenorzo szkript,
# nevlista + tartalom-hash, FINDING-gel"; recurring enforcement lives in card 31e70128's
# heartbeat hook into the EXISTING store/agent-skill-drift-sync.sh -- this script does not
# duplicate that sync/fix tool, it only REPORTS, and it checks the seed tree too (the sync
# tool's --apply operates on the live agents/<agent> tree, not seed-fleet-agents/<agent>).
#
# WHY THIS EXISTS
# ---------------
# Peti, Telegram 10910 (2026-10-10): "Minden testver ugynoknek ugyanolyan skillek kellenek,
# amelyek bele vannak epitve, hogy hasznaljanak is." Three sibling clone families exist
# today (backend/backend2/backend3, qa/qa2, fron-ted/fron-teddy); each sibling is expected
# to carry the SAME skill directory names, the SAME SKILL.md content per name, and the SAME
# "Core skilljeid" CLAUDE.md binding list -- on BOTH the live runtime tree (agents/<agent>/,
# not git-tracked) and the seed provisioning tree (seed-fleet-agents/<agent>/, git-tracked,
# used when a new sibling instance is spun up). A gap in either tree reproduces the drift
# this card exists to eliminate: card c40385b1 measured real divergence in both (backend3's
# seed template was missing CLAUDE.md/SOUL.md/agent-config.json/avatar.png entirely; several
# SKILL.md files differed byte-for-byte between siblings on both trees).
#
# WHAT THIS CHECKS, per family, per tree (live and seed):
#   1. Skill directory NAME set -- is every member missing any name another member has.
#   2. SKILL.md CONTENT hash -- for skill names present on 2+ members, do they match.
#   3. "## Core skilljeid" CLAUDE.md section -- same skill-name set across members.
# It does NOT decide which side is "right" and does NOT fix anything -- a content mismatch
# is routinely NOT a simple staleness case (see c40385b1: qa/qa2 skill files legitimately
# carry agent-specific worktree-variable names and own-incident narration interleaved with
# genuinely transferable fixes). Splitting that apart is a judgment call for the agent/MikroB,
# not something a hash-diff can safely automate.
#
# Usage:
#   store/sibling-skill-drift-check.sh                  # all families, both trees
#   store/sibling-skill-drift-check.sh --family backend  # limit to one family (repeatable)
#   store/sibling-skill-drift-check.sh --live-only
#   store/sibling-skill-drift-check.sh --seed-only
#   store/sibling-skill-drift-check.sh --selftest
#
# OUTPUT: one line per problem, prefixed FINDING, machine-greppable:
#   FINDING missing-skill-name  <family> <tree> <member> <skill>
#   FINDING content-diff        <family> <tree> <skill> <member>=<sha256-8> [<member>=<sha256-8> ...]
#   FINDING missing-claude-md   <family> <tree> <member>
#   FINDING core-section-diff   <family> <tree> <member> missing=<name,...> extra=<name,...>
# Final line: "sibling-skill-drift-check: N finding(s)" (N=0 means clean).
# Exit: 0 clean | 1 findings present | 2 usage/error.

set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
LIVE_AGENTS_DIR="${LIVE_AGENTS_DIR:-$MARVEEN_MAIN/agents}"
SEED_DIR="${SEED_DIR:-$SELF_DIR/../seed-fleet-agents}"

declare -A FAMILIES=(
  [backend]="backend backend2 backend3"
  [qa]="qa qa2"
  [fron-ted]="fron-ted fron-teddy"
)

ONLY_FAMILIES=()
DO_LIVE=1
DO_SEED=1
SELFTEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --family) ONLY_FAMILIES+=("$2"); shift 2 ;;
    --live-only) DO_SEED=0; shift ;;
    --seed-only) DO_LIVE=0; shift ;;
    --selftest) SELFTEST=1; shift ;;
    # internal, used only by --selftest to point at a throwaway fixture family instead
    # of the real backend/qa/fron-ted families -- not part of the documented interface.
    --override-families) unset FAMILIES; declare -A FAMILIES=(["$2"]="$3"); shift 3 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

FINDINGS=0

finding() {
  echo "FINDING $*"
  FINDINGS=$((FINDINGS + 1))
}

skill_names() {
  local dir="$1"
  [ -d "$dir/.claude/skills" ] || return 0
  find "$dir/.claude/skills" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort
}

skill_hash() {
  local dir="$1" name="$2"
  local f="$dir/.claude/skills/$name/SKILL.md"
  [ -f "$f" ] || return 1
  sha256sum "$f" | cut -c1-8
}

core_skill_names() {
  local claude_md="$1"
  [ -f "$claude_md" ] || return 1
  sed -n '/## Core skilljeid/,/^## /p' "$claude_md" | grep '^- `' | sed 's/^- `\([a-zA-Z0-9_-]*\)`.*/\1/' | sort
}

check_tree() {
  local tree_label="$1" base_dir="$2"
  local family member
  for family in "${!FAMILIES[@]}"; do
    if [ "${#ONLY_FAMILIES[@]}" -gt 0 ]; then
      local keep=0
      for f in "${ONLY_FAMILIES[@]}"; do [ "$f" = "$family" ] && keep=1; done
      [ "$keep" = 1 ] || continue
    fi
    local members=(${FAMILIES[$family]})

    # 1) skill name-set parity
    local union_names=""
    for member in "${members[@]}"; do
      union_names+=$'\n'"$(skill_names "$base_dir/$member")"
    done
    union_names="$(echo "$union_names" | grep -v '^$' | sort -u)"
    for member in "${members[@]}"; do
      [ -d "$base_dir/$member" ] || continue
      local mine; mine="$(skill_names "$base_dir/$member")"
      local missing
      missing="$(comm -23 <(echo "$union_names") <(echo "$mine"))"
      while IFS= read -r name; do
        [ -n "$name" ] && finding "missing-skill-name $family $tree_label $member $name"
      done <<< "$missing"
    done

    # 2) content-hash parity for names present on 2+ members
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      local hashes="" diverged=0 first_hash=""
      for member in "${members[@]}"; do
        [ -d "$base_dir/$member" ] || continue
        local h; h="$(skill_hash "$base_dir/$member" "$name")" || continue
        hashes+=" $member=$h"
        if [ -z "$first_hash" ]; then first_hash="$h"; elif [ "$h" != "$first_hash" ]; then diverged=1; fi
      done
      [ "$diverged" = 1 ] && finding "content-diff $family $tree_label $name${hashes}"
    done <<< "$union_names"

    # 3) Core skilljeid CLAUDE.md section parity
    local union_core=""
    for member in "${members[@]}"; do
      [ -d "$base_dir/$member" ] || continue
      if [ ! -f "$base_dir/$member/CLAUDE.md" ]; then
        finding "missing-claude-md $family $tree_label $member"
        continue
      fi
      union_core+=$'\n'"$(core_skill_names "$base_dir/$member/CLAUDE.md")"
    done
    union_core="$(echo "$union_core" | grep -v '^$' | sort -u)"
    [ -z "$union_core" ] && continue
    for member in "${members[@]}"; do
      [ -f "$base_dir/$member/CLAUDE.md" ] || continue
      local mine_core; mine_core="$(core_skill_names "$base_dir/$member/CLAUDE.md")"
      local missing extra
      missing="$(comm -23 <(echo "$union_core") <(echo "$mine_core") | paste -sd, -)"
      extra="$(comm -13 <(echo "$union_core") <(echo "$mine_core") | paste -sd, -)"
      if [ -n "$missing" ] || [ -n "$extra" ]; then
        finding "core-section-diff $family $tree_label $member missing=${missing:-} extra=${extra:-}"
      fi
    done
  done
}

run_selftest() {
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/a/.claude/skills/shared" "$tmp/b/.claude/skills/shared" "$tmp/b/.claude/skills/extra-only-on-b"
  echo "same content" > "$tmp/a/.claude/skills/shared/SKILL.md"
  echo "different content" > "$tmp/b/.claude/skills/shared/SKILL.md"
  echo "x" > "$tmp/b/.claude/skills/extra-only-on-b/SKILL.md"
  printf '# a\n## Core skilljeid\n- `shared`\n## Other\n' > "$tmp/a/CLAUDE.md"
  printf '# b\n## Core skilljeid\n- `shared`\n- `extra-only-on-b`\n## Other\n' > "$tmp/b/CLAUDE.md"

  local out
  out="$(LIVE_AGENTS_DIR="$tmp" bash "${BASH_SOURCE[0]}" --override-families test "a b" --live-only --family test 2>&1)"
  rm -rf "$tmp"

  local fail=0
  echo "$out" | grep -q "missing-skill-name test live a extra-only-on-b" || { echo "SELFTEST FAIL: missing-skill-name not detected"; fail=1; }
  echo "$out" | grep -q "content-diff test live shared" || { echo "SELFTEST FAIL: content-diff not detected"; fail=1; }
  echo "$out" | grep -q "core-section-diff test live a missing=extra-only-on-b" || { echo "SELFTEST FAIL: core-section-diff not detected"; fail=1; }
  echo "$out"
  if [ "$fail" = 0 ]; then echo "SELFTEST OK"; return 0; else return 1; fi
}

if [ "$SELFTEST" = 1 ]; then
  run_selftest
  exit $?
fi

[ "$DO_LIVE" = 1 ] && check_tree "live" "$LIVE_AGENTS_DIR"
[ "$DO_SEED" = 1 ] && check_tree "seed" "$SEED_DIR"

echo "sibling-skill-drift-check: $FINDINGS finding(s)"
[ "$FINDINGS" -eq 0 ] && exit 0 || exit 1
