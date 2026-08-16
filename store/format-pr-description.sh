#!/bin/bash
# Formats a kanban card's REVIEW comment into the shape of
# .github/pull_request_template.md, for the (rare) case a change actually
# needs a GitHub PR body -- e.g. pushing a fork-divergent fix upstream, or a
# change reviewed via the GitHub web UI. The fleet's own day-to-day gate
# workflow lands with a direct merge + push (no PR, no gh CLI installed --
# see card 2a73ee70), so this is a copy-paste aid for the human at the PR
# text box, not an automated `gh pr create` integration.
#
# Idea from BloopAI/vibe-kanban (abandoned project, idea-only -- card 227f4cc1):
# "auto-generated PR description from the card's REVIEW". No code adopted.
#
# Usage: store/format-pr-description.sh <card-id>
# Prints markdown to stdout; nothing is written anywhere, no GitHub call.
set -euo pipefail

CARD_ID="${1:?usage: format-pr-description.sh <card-id>}"
TOKEN_FILE="$(dirname "$0")/.dashboard-token"
BASE_URL="${DASHBOARD_BASE_URL:-http://localhost:3420}"

auth_header() { printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")"; }

CARD_JSON=$(auth_header | curl -s -H @- "$BASE_URL/api/kanban" | python3 -c "
import json, sys
cards = json.load(sys.stdin)
cards = cards if isinstance(cards, list) else cards.get('cards', cards)
for c in cards:
    if c.get('id') == '$CARD_ID':
        print(json.dumps(c))
        break
")
if [ -z "$CARD_JSON" ]; then
  echo "no such card: $CARD_ID" >&2
  exit 1
fi

COMMENTS_JSON=$(auth_header | curl -s -H @- "$BASE_URL/api/kanban/$CARD_ID/comments")

python3 - "$CARD_JSON" "$COMMENTS_JSON" <<'PYEOF'
import json, re, sys

card = json.loads(sys.argv[1])
comments = json.loads(sys.argv[2])

title = card.get("title", "")
description = card.get("description", "")

review = None
for c in reversed(comments):  # latest REVIEW wins
    content = c.get("content", "")
    if re.match(r"^\s*REVIEW\b", content):
        review = content
        break

gate_sha = None
if review:
    m = re.search(r"^Gate-SHA:\s*(\S.*)$", review, re.MULTILINE)
    if m:
        gate_sha = m.group(1).strip()

title_upper = title.upper()
kind = "other"
if "[BUG]" in title_upper or "BUGFIX" in title_upper or "FIX" in title_upper:
    kind = "bugfix"
elif "[FEAT]" in title_upper or "[FEATURE]" in title_upper:
    kind = "feature"
elif "[DOC]" in title_upper or "[DOKS]" in title_upper:
    kind = "docs"

def box(checked):
    return "[x]" if checked else "[ ]"

print("<!-- DRAFT, generated from kanban card %s -- verify every line before using. -->" % card.get("id"))
print()
print("## A változtatás típusa / Type of change")
print()
print("- %s Bug fix (hibajavítás / bug fix)" % box(kind == "bugfix"))
print("- %s Új funkció (feature / new feature)" % box(kind == "feature"))
print("- %s Dokumentáció (docs)" % box(kind == "docs"))
print("- %s Egyéb / Other:" % box(kind == "other"))
print()
print("## Rövid leírás / Summary")
print()
print(title)
print()
if review:
    print(review.strip())
else:
    print("(nincs REVIEW komment a kártyán -- töltsd ki kézzel / no REVIEW comment on the card -- fill in by hand)")
print()
print("## Kapcsolódó issue / Related issue")
print()
print("Kanban kártya / Kanban card: %s (nincs GitHub issue -- ez a flotta a kanban táblát használja, nem GitHub Issues-t)" % card.get("id"))
print()
print("## Ellenőrzőlista / Checklist")
print()
print("- [ ] Kipróbáltam a módosítást a lokális környezetben (Telegram/Slack + dashboard), az ágensek hiba nélkül kommunikálnak. / Tested locally (Telegram/Slack + dashboard); the agents communicate without errors.")
print("- [ ] Frissítettem a `docs/` mappát, ha a változtatás érinti a telepítést vagy az architektúrát. / Updated `docs/` if the change affects installation or architecture.")
print("- [ ] A kód nem tartalmaz beleégetett szenzitív adatot (API kulcs, token, személyes adat). / No hardcoded secrets (API keys, tokens, personal data).")
print("- [ ] Saját, beszédes nevű branch-ről nyitom (nem közvetlenül `develop`-ra). / Opened from an own, descriptively named branch (not directly on `develop`).")
if gate_sha:
    print()
    print("Gate-SHA: %s" % gate_sha)
PYEOF
