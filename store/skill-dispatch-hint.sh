#!/usr/bin/env bash
# skill-dispatch-hint.sh -- DETERMINISTIC "which of this agent's ALREADY-BOUND core skills fit
# this card" hint for the heartbeat-consolidated dispatch message (card 2f5caa6f, 527c9584 Fazis
# 3. lepese). Keyword-overlap against the one-line descriptions already written in each agent's
# own CLAUDE.md "## Core skilljeid" section (card 27b02677) -- that section IS the per-role skill
# map the card asks to use, already bound, so this reuses it rather than re-deriving a second
# source of truth from the 188-skill global catalog.
#
# Deterministic, no model call: the same (agent, card text) pair always yields the same hint,
# which is what makes the companion selftest meaningful at all -- a model call is not pin-testable.
# A zero-match result is a valid, silent outcome (no fitting skill found), not an error.
#
# Usage:
#   . skill-dispatch-hint.sh; skill_dispatch_hint "<agent>" "<card title + description>"
#     -- as a library function, prints 0-3 skill names, one per line
#   skill-dispatch-hint.sh <cardId> <agent>
#     -- as a script, fetches the card from the dashboard API and prints the same
set -uo pipefail

SKILL_DISPATCH_HINT_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"

# Where a role-agent's "## Core skilljeid" section lives. MikroB's own list sits in the root
# CLAUDE.md under a differently-captioned heading (no "(MikroB altal hozzarendelve)" suffix,
# card 200d2969) -- both start with the same "## Core skilljeid" prefix, so one lookup covers
# both without a special case in the matcher itself.
_skill_dispatch_claude_md() {
  local agent="$1"
  if [ "$agent" = "mikrob" ]; then
    printf '%s/CLAUDE.md\n' "$MARVEEN_MAIN"
  else
    printf '%s/agents/%s/CLAUDE.md\n' "$MARVEEN_MAIN" "$agent"
  fi
}

skill_dispatch_hint() {
  local agent="$1" text="$2"
  local claude_md
  claude_md="$(_skill_dispatch_claude_md "$agent")"
  [ -f "$claude_md" ] || return 0

  AGENT_CLAUDE_MD="$claude_md" CARD_TEXT="$text" python3 - <<'PYEOF'
import os, re, sys

path = os.environ["AGENT_CLAUDE_MD"]
card_text = os.environ["CARD_TEXT"]

with open(path, encoding="utf-8") as f:
    lines = f.readlines()

# Slice the "## Core skilljeid" section: from the matching heading to the next "## " heading
# (or EOF). Only the FIRST such heading -- every agent CLAUDE.md has exactly one core-skill
# section.
start = None
for i, line in enumerate(lines):
    if line.startswith("## Core skilljeid"):
        start = i + 1
        break
if start is None:
    sys.exit(0)
end = len(lines)
for i in range(start, len(lines)):
    if lines[i].startswith("## "):
        end = i
        break
section = lines[start:end]

# Each bound skill is a line "- `name` -- description" (the format every agent CLAUDE.md uses,
# card 27b02677). A line that doesn't match this shape is skipped, not fatal -- a prose line
# between entries is not an error.
entries = []
for line in section:
    m = re.match(r"^-\s*`([a-zA-Z0-9_-]+)`\s*--\s*(.+?)\s*$", line.strip())
    if m:
        entries.append((m.group(1), m.group(2)))

STOPWORDS = {
    "a", "az", "egy", "es", "vagy", "nem", "is", "ha", "hogy", "amit", "ami", "mint",
    "the", "and", "for", "with", "not", "of", "to", "at",
}

def tokenize(s: str):
    words = re.findall(r"[a-zA-Z0-9À-ſ]+", s.lower())
    return {w for w in words if len(w) > 2 and w not in STOPWORDS}

card_tokens = tokenize(card_text)

scored = []
for name, desc in entries:
    overlap = card_tokens & tokenize(desc)
    if overlap:
        scored.append((len(overlap), name))

# Stable, deterministic order: highest overlap first, name as tiebreaker (never input order,
# which would make the result depend on where in the CLAUDE.md list a skill happens to sit).
scored.sort(key=lambda x: (-x[0], x[1]))
for _, name in scored[:3]:
    print(name)
PYEOF
}

# Script mode: skill-dispatch-hint.sh <cardId> <agent>
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  CARD_ID="${1:?usage: skill-dispatch-hint.sh <cardId> <agent>}"
  AGENT="${2:?usage: skill-dispatch-hint.sh <cardId> <agent>}"
  TOKEN="$(cat "$MARVEEN_MAIN/store/.dashboard-token" 2>/dev/null)"
  # Drop any inherited export attribute (613a8142 F1 class, card 2d4c7943 INFO) before the
  # python3 child below is spawned.
  declare +x TOKEN
  PORT="$(sed -n 's/^WEB_PORT=//p' "$MARVEEN_MAIN/.env" 2>/dev/null | head -1 | tr -d '"')"
  PORT="${PORT:-3420}"
  CARD_JSON="$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- -s "http://localhost:$PORT/api/kanban/$CARD_ID")"
  CARD_TEXT="$(CARD_JSON="$CARD_JSON" python3 -c '
import json, os
c = json.loads(os.environ["CARD_JSON"])
print(c.get("title", ""), c.get("description", ""))
')"
  skill_dispatch_hint "$AGENT" "$CARD_TEXT"
fi
