#!/bin/bash
# Daily-first-start quota gate (Peti rule, 2026-07-01): on the FIRST session
# start of each calendar day (Europe/Budapest), run quota-check.sh and surface
# NEW/CURRENT to MikroB as SessionStart context so MikroB acts on it. Deduped by
# date via store/.daily-quota-check-date, so every later start the same day stays
# silent (exit 0, no output). Never blocks the session.
set -u
STORE="/home/neon/marveen/store"
DATEFILE="$STORE/.daily-quota-check-date"
TODAY=$(TZ=Europe/Budapest date +%F)
last=$(cat "$DATEFILE" 2>/dev/null || echo "")
if [ "$last" = "$TODAY" ]; then
  exit 0   # already checked today -> stay silent
fi
echo "$TODAY" > "$DATEFILE"
out=$(bash "$STORE/quota-check.sh" 2>/dev/null | tr '\n' ' ')
ctx="[Napi elso indulas -- kvota-ellenorzes $TODAY] ${out}. Ha a NEW: sor NEM ures, ertesitsd Petit Telegramon a kvota-szabaly szerint (melyik agent/session ert limitet, resetig var). Ha NEW ures, nincs teendo -- csak tudomasul veszed."
python3 - "$ctx" <<'PY'
import json,sys
print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":sys.argv[1]}}))
PY
