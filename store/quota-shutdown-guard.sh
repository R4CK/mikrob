#!/bin/bash
# quota-shutdown-guard.sh -- Peti kereset (Telegram, 2026-08-27 00:32, msg 5796):
# 99%-os heti kvotanal, ha MINDEN flotta-ugynok leallt, VAGY legkesobb ma este
# 20:00-kor fuggetlenul a kvotatol, kapcsolja le a fizikai gepet (Windows host,
# nem csak a WSL-t -- "kapcsold ki a gepet" / "hardweresen allitsd le").
#
# Idempotens: naponta EGYSZER sul el (STATE fajl datumbelyeggel), ujra futtatva
# ugyanazon a napon mar kilep. 5 perces, Windows shutdown.exe-vel megszakithato
# elore-jelzest ad (Telegram + shutdown.exe /s /t 300), nem azonnali /t 0-t.
#
# Usage: quota-shutdown-guard.sh [--dry-run] [--force-reason "..."]
set -uo pipefail

STORE="/home/neon/marveen/store"
TOKEN_FILE="$STORE/.dashboard-token"
API="http://localhost:3420"
HARDSTOP="$STORE/weekly-hard-stop.json"
STATE="$STORE/quota-shutdown-guard-state.json"
LOG="$STORE/quota-shutdown-guard.log"
SHUTDOWN_EXE="/mnt/c/Windows/System32/shutdown.exe"
DRY_RUN=0
FORCE_REASON=""

for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --force-reason) shift ;;
    *) FORCE_REASON="${FORCE_REASON:-}$a " ;;
  esac
done

log() { echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $*" >> "$LOG"; }

today="$(date '+%Y-%m-%d')"

# --- idempotency: legfeljebb naponta egyszer sulhet el ---
already_today=0
if [ -f "$STATE" ]; then
  last_date="$(python3 -c 'import json;print(json.load(open("'"$STATE"'")).get("triggeredDate",""))' 2>/dev/null || echo '')"
  [ "$last_date" = "$today" ] && already_today=1
fi

send_telegram() {
  local text="$1"
  python3 - "$text" <<'PYEOF'
import sys, json, urllib.request
text = sys.argv[1]
try:
    token = open("/home/neon/marveen/store/.dashboard-token").read().strip()
    req = urllib.request.Request(
        "http://localhost:3420/api/messages",
        data=json.dumps({"from": "mikrob", "to": "mikrob", "content": text}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=10)
except Exception as e:
    print(f"telegram-bridge-notify failed: {e}", file=sys.stderr)
PYEOF
}

trigger_shutdown() {
  local reason="$1"
  log "TRIGGER: $reason"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: nem hivom meg a shutdown.exe-t, csak logolok."
    return 0
  fi
  echo "{\"triggeredDate\": \"$today\", \"reason\": $(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$reason"), \"triggeredAt\": \"$(date -Iseconds)\"}" > "$STATE"
  # 5 perces elore-jelzes, Windows-oldalrol megszakithato: shutdown.exe /a
  if [ -x "$SHUTDOWN_EXE" ]; then
    "$SHUTDOWN_EXE" /s /t 300 /c "MikroB: $reason -- automatikus leallitas 5 percen belul. Megszakitas: nyiss cmd-t, futtasd: shutdown /a" 2>&1 | tee -a "$LOG"
  else
    log "HIBA: $SHUTDOWN_EXE nem talalhato/nem futtathato -- WSL interop hianyzik?"
  fi
}

# --- FELTETEL 1: 99% heti kvota ES minden flotta-ugynok leallt ---
percent="$(python3 -c 'import json;print(json.load(open("'"$HARDSTOP"'")).get("percent",0))' 2>/dev/null || echo 0)"

running_flotta=0
if [ -f "$TOKEN_FILE" ]; then
  running_flotta="$(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" | curl -H @- -s --max-time 10 "$API/api/agents" | python3 -c '
import json,sys
try:
    agents=json.load(sys.stdin)
except Exception:
    print(-1); raise SystemExit
n=sum(1 for a in agents if a.get("running") and a.get("name") != "mikrob")
print(n)
' 2>/dev/null || echo -1)"
fi

# --- FELTETEL 2: legkesobb ma este 20:00 (Europe/Budapest, ez a rendszer lokal ideje) ---
hour="$(TZ=Europe/Budapest date '+%H')"

if [ "$already_today" = "1" ] && [ -z "$FORCE_REASON" ]; then
  log "SKIP: ma mar el volt sulve (idempotencia)."
  exit 0
fi

if [ -n "$FORCE_REASON" ]; then
  send_telegram "Flotta: quota-shutdown-guard manualis force -- $FORCE_REASON"
  trigger_shutdown "manualis force: $FORCE_REASON"
  exit 0
fi

if [ "$percent" -ge 99 ] 2>/dev/null && [ "$running_flotta" = "0" ]; then
  send_telegram "Flotta: heti kvota ${percent}%, minden flotta-ugynok leallt -- Peti keresere (2026-08-27) automatikus gep-leallitas indul, 5 perces megszakithato ablakkal."
  trigger_shutdown "heti kvota ${percent}%, minden flotta-ugynok leallt"
  exit 0
fi

# A napi 20:00-as, kvotatol fuggetlen hatarido-szabaly TOROLVE (Peti 2026-09-02, Telegram --
# visszavonta a 2026-08-27-i keresset, mert aktiv munka kozben zavaro volt). A 99%-os
# heti-kvota-alapu leallitas fentebb valtozatlanul all.

log "OK: nincs feltetel teljesitve (percent=$percent running_flotta=$running_flotta hour=$hour)."
exit 0
