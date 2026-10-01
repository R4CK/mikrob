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
#        quota-shutdown-guard.sh --selftest
set -uo pipefail

STORE="/home/neon/marveen/store"
TOKEN_FILE="$STORE/.dashboard-token"
API="http://localhost:3420"
HARDSTOP="$STORE/weekly-hard-stop.json"
STATE="$STORE/quota-shutdown-guard-state.json"
LOG="$STORE/quota-shutdown-guard.log"
# Env-override only for the selftest (a FAKE binary, never the real path) -- the production
# cron config never sets this, so it always resolves to the real shutdown.exe.
SHUTDOWN_EXE="${SHUTDOWN_EXE:-/mnt/c/Windows/System32/shutdown.exe}"
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
  # Card 0daf0033: a STATE csak SIKERES shutdown.exe hivas UTAN irodik -- ezelott a STATE a
  # hivas ELOTT irodott, tehat egy WSL-interop hiba (mert hianyzik/nem futtathato, VAGY mert
  # maga az exec() hibazik, lasd lent) is "ma mar elsult"-nek szamitott, es a guard a nap
  # hatralevo reszeben csendben kihagyta az ujraprobalkozast -- a gep soha nem allt le, es
  # senki nem tudott rola, amig valaki at nem nezte a logot.
  if [ ! -x "$SHUTDOWN_EXE" ]; then
    log "HIBA: $SHUTDOWN_EXE nem talalhato/nem futtathato -- WSL interop hianyzik?"
    send_telegram "Flotta: quota-shutdown-guard HIBA -- $SHUTDOWN_EXE nem futtathato (WSL interop hianyzik?). A gep NEM allt le, STATE nem irodott, ujraprobal a kovetkezo korben. Kezi beavatkozas ajanlott."
    return 1
  fi
  # 5 perces elore-jelzes, Windows-oldalrol megszakithato: shutdown.exe /a
  # NEM pipe-olva tee-be: a `cmd | tee` mintanal a pipe utolso tagjanak (tee) sikeres exit
  # code-ja elfedi a cmd sajat hibajat pipefail NELKUL is olvashatatlanna tenne a hivo szamara
  # -- itt kulon valtozoba gyujtve, hogy a $? explicit, egyertelmu legyen.
  local shutdown_out shutdown_rc
  shutdown_out="$("$SHUTDOWN_EXE" /s /t 300 /c "MikroB: $reason -- automatikus leallitas 5 percen belul. Megszakitas: nyiss cmd-t, futtasd: shutdown /a" 2>&1)"
  shutdown_rc=$?
  printf '%s\n' "$shutdown_out" >> "$LOG"
  if [ "$shutdown_rc" -ne 0 ]; then
    log "HIBA: $SHUTDOWN_EXE exit=$shutdown_rc -- kimenet: $shutdown_out"
    send_telegram "Flotta: quota-shutdown-guard HIBA -- shutdown.exe hivas sikertelen (exit=$shutdown_rc): $shutdown_out. A gep NEM allt le, STATE nem irodott, ujraprobal a kovetkezo korben. Kezi beavatkozas ajanlott."
    return 1
  fi
  echo "{\"triggeredDate\": \"$today\", \"reason\": $(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$reason"), \"triggeredAt\": \"$(date -Iseconds)\"}" > "$STATE"
  return 0
}

if [ "${1:-}" = "--selftest" ]; then
  # Card 0daf0033: izolalt STATE/LOG/SHUTDOWN_EXE minden esethez, SOHA nem a valodi gep leallitasa
  # vagy az eles STATE/LOG. send_telegram no-op-ra cserelve, hogy a selftest ne kuldjon valodi
  # Telegram uzenetet minden futtataskor.
  n=0
  fail=0
  t() { n=$((n + 1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  send_telegram() { :; }

  TMPD="$(mktemp -d)"
  trap 'rm -rf "$TMPD"' EXIT

  # Case 1: shutdown.exe sikeresen lefut (exit 0) -> STATE irodik, trigger_shutdown 0-val ter vissza.
  FAKE_OK="$TMPD/fake-ok.sh"
  printf '#!/bin/bash\nexit 0\n' > "$FAKE_OK"
  chmod +x "$FAKE_OK"
  STATE="$TMPD/state-ok.json"
  LOG="$TMPD/log-ok.txt"
  SHUTDOWN_EXE="$FAKE_OK"
  : > "$LOG"
  trigger_shutdown "selftest-ok"
  rc=$?
  t "success: trigger_shutdown returns 0" "$rc" "0"
  t "success: STATE file IS written" "$([ -f "$STATE" ] && echo YES || echo NO)" "YES"

  # Case 2: shutdown.exe lefut de hibazik (mert a mert elesben eset: EINVAL, exit!=0) -> NO
  # STATE, trigger_shutdown nemzerovel ter vissza, a hiba a LOG-ba is bekerul.
  FAKE_FAIL="$TMPD/fake-fail.sh"
  printf '#!/bin/bash\necho "shutdown.exe: Invalid argument" >&2\nexit 1\n' > "$FAKE_FAIL"
  chmod +x "$FAKE_FAIL"
  STATE="$TMPD/state-fail.json"
  LOG="$TMPD/log-fail.txt"
  SHUTDOWN_EXE="$FAKE_FAIL"
  : > "$LOG"
  trigger_shutdown "selftest-fail"
  rc=$?
  t "failure (EINVAL-shaped): trigger_shutdown returns non-zero" "$([ "$rc" -ne 0 ] && echo NONZERO || echo ZERO)" "NONZERO"
  t "failure (EINVAL-shaped): STATE file NOT written" "$([ -f "$STATE" ] && echo YES || echo NO)" "NO"
  t "failure (EINVAL-shaped): the exit code and the exe's own stderr are both logged" \
    "$(grep -q 'HIBA.*exit=1.*Invalid argument' "$LOG" && echo YES || echo NO)" "YES"

  # Case 3: a SHUTDOWN_EXE egyaltalan nem letezik/nem futtathato -> NO STATE, nemzero exit,
  # a hivas meg sem kiserletve (nincs exec, csak a -x teszt bukik).
  STATE="$TMPD/state-missing.json"
  LOG="$TMPD/log-missing.txt"
  SHUTDOWN_EXE="$TMPD/does-not-exist.exe"
  : > "$LOG"
  trigger_shutdown "selftest-missing"
  rc=$?
  t "missing binary: trigger_shutdown returns non-zero" "$([ "$rc" -ne 0 ] && echo NONZERO || echo ZERO)" "NONZERO"
  t "missing binary: STATE file NOT written" "$([ -f "$STATE" ] && echo YES || echo NO)" "NO"

  # Case 4: DRY_RUN=1 marad valtozatlan viselkedesu (nincs regresszio a meglevo ag ellen).
  DRY_RUN=1
  STATE="$TMPD/state-dryrun.json"
  LOG="$TMPD/log-dryrun.txt"
  SHUTDOWN_EXE="$FAKE_OK"
  : > "$LOG"
  trigger_shutdown "selftest-dryrun"
  rc=$?
  t "dry-run: trigger_shutdown returns 0 without calling the binary" "$rc" "0"
  t "dry-run: STATE file NOT written (dry-run never commits)" "$([ -f "$STATE" ] && echo YES || echo NO)" "NO"
  DRY_RUN=0

  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

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
  # Card 0daf0033: exit code = trigger_shutdown sajat sikeressege, nem feltetlen 0 -- a
  # scheduled-task runner failThreshold-ja (task-config.json, failThreshold:2) csak igy latja
  # meg, ha a shutdown.exe hivas rendszeresen hibazik; eddig a mindig-0 exit code miatt ez a
  # jelzo soha nem tudott kioldani.
  trigger_shutdown "manualis force: $FORCE_REASON"
  exit $?
fi

if [ "$percent" -ge 99 ] 2>/dev/null && [ "$running_flotta" = "0" ]; then
  send_telegram "Flotta: heti kvota ${percent}%, minden flotta-ugynok leallt -- Peti keresere (2026-08-27) automatikus gep-leallitas indul, 5 perces megszakithato ablakkal."
  trigger_shutdown "heti kvota ${percent}%, minden flotta-ugynok leallt"
  exit $?
fi

# A napi 20:00-as, kvotatol fuggetlen hatarido-szabaly TOROLVE (Peti 2026-09-02, Telegram --
# visszavonta a 2026-08-27-i keresset, mert aktiv munka kozben zavaro volt). A 99%-os
# heti-kvota-alapu leallitas fentebb valtozatlanul all.

log "OK: nincs feltetel teljesitve (percent=$percent running_flotta=$running_flotta hour=$hour)."
exit 0
