#!/bin/bash
# Skill Index Generator
# Generates a Level 0 index of all available skills (name + description only)
# This keeps token usage low while making all skills discoverable
#
# Usage: skill-index.sh [AGENT_DIR]
#   Without arg: generates global index at ~/.claude/skills/.skill-index.md
#   With AGENT_DIR: generates merged index (global + agent-specific) at
#                   <AGENT_DIR>/.claude/skills/.skill-index.md
#                   (backward-compatible format for no-arg callers)

# The global skills dir defaults to ~/.claude/skills but can be overridden via the
# SKILL_INDEX_GLOBAL_DIR env var (e.g. to index the repo's seed-skills/ during seeding).
# The optional first positional arg selects AGENT_DIR for a merged agent+global index (see below).
GLOBAL_SKILLS_DIR="${SKILL_INDEX_GLOBAL_DIR:-$HOME/.claude/skills}"

if [ $# -ge 1 ]; then
  AGENT_DIR="$1"
  AGENT_SKILLS_DIR="$AGENT_DIR/.claude/skills"
  OUTPUT="$AGENT_SKILLS_DIR/.skill-index.md"
  MERGED=1
  mkdir -p "$AGENT_SKILLS_DIR"
else
  AGENT_DIR=""
  AGENT_SKILLS_DIR=""
  OUTPUT="$GLOBAL_SKILLS_DIR/.skill-index.md"
  MERGED=0
fi

if [ ! -d "$GLOBAL_SKILLS_DIR" ]; then
  echo "No global skills directory found at $GLOBAL_SKILLS_DIR"
  exit 0
fi

echo "# Skill Index (Level 0)" > "$OUTPUT"
echo "" >> "$OUTPUT"

if [ "$MERGED" = "1" ]; then
  echo "Ez az ágensspecifikus skill index: globális (~/.claude/skills) és ágensspecifikus (.claude/skills) skilleket egyaránt tartalmaz." >> "$OUTPUT"
  echo "Ha egy skill releváns, olvasd be a teljes SKILL.md-t (Level 1)." >> "$OUTPUT"
  echo "Ha segédfájlokra is szükség van, nézd meg a scripts/ és references/ mappákat (Level 2)." >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  echo "| Skill | Leírás | Scope |" >> "$OUTPUT"
  echo "|-------|--------|-------|" >> "$OUTPUT"
else
  echo "Ez az összes elérhető skill rövid indexe. Csak a nevet és leírást tartalmazza (Level 0)." >> "$OUTPUT"
  echo "Ha egy skill releváns, olvasd be a teljes SKILL.md-t (Level 1)." >> "$OUTPUT"
  echo "Ha segédfájlokra is szükség van, nézd meg a scripts/ és references/ mappákat (Level 2)." >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  echo "| Skill | Leírás |" >> "$OUTPUT"
  echo "|-------|--------|" >> "$OUTPUT"
fi

SKILL_COUNT=0

index_skills_dir() {
  local dir="$1"
  local scope="$2"  # only used when MERGED=1
  for skill_dir in "$dir"/*/; do
    [ -d "$skill_dir" ] || continue
    local skill_md="$skill_dir/SKILL.md"
    [ -f "$skill_md" ] || continue

    local name
    name=$(grep -m1 "^name:" "$skill_md" 2>/dev/null | sed 's/^name: *//' | tr -d '"' | tr -d "'")
    if [ -z "$name" ]; then
      name=$(basename "$skill_dir")
    fi

    # c13c6340 (qa2 observation, 339d29a5): `description:` can be a plain one-liner,
    # or a YAML block scalar (folded `>` / literal `|`) whose actual text lives on the
    # indented lines that follow -- a single-line grep only ever saw the indicator
    # character itself. Fold any block scalar's lines (joined by spaces, since the
    # index is a single-row markdown table cell either way).
    local desc
    desc=$(awk '
      state == 0 && /^description:[ \t]*/ {
        val = $0
        sub(/^description:[ \t]*/, "", val)
        if (val ~ /^[>|][+-]?$/) { state = 1; next }
        gsub(/"/, "", val)
        gsub(/'"'"'/, "", val)
        result = val; exit
      }
      state == 1 {
        if (indent < 0) {
          if ($0 ~ /^[ \t]*$/) { next }
          match($0, /^[ \t]*/); indent = RLENGTH
        }
        match($0, /^[ \t]*/); cur = RLENGTH
        if ($0 !~ /^[ \t]*$/ && cur < indent) { exit }
        line = substr($0, indent + 1)
        gsub(/"/, "", line)
        gsub(/'"'"'/, "", line)
        if (line == "") { next }
        result = (result == "") ? line : result " " line
      }
      END { print result }
    ' "$skill_md" | cut -c1-120)
    if [ -z "$desc" ]; then
      desc="(nincs leírás)"
    fi

    if [ "$MERGED" = "1" ]; then
      echo "| \`$name\` | $desc | $scope |" >> "$OUTPUT"
    else
      echo "| \`$name\` | $desc |" >> "$OUTPUT"
    fi
    SKILL_COUNT=$((SKILL_COUNT + 1))
  done
}

index_skills_dir "$GLOBAL_SKILLS_DIR" "global"

if [ "$MERGED" = "1" ] && [ -d "$AGENT_SKILLS_DIR" ]; then
  index_skills_dir "$AGENT_SKILLS_DIR" "agent"
fi

echo "" >> "$OUTPUT"
echo "_${SKILL_COUNT} skill indexelve. Generálva: $(date '+%Y-%m-%d %H:%M')_" >> "$OUTPUT"

echo "Skill index generated: $OUTPUT ($SKILL_COUNT skills)"
