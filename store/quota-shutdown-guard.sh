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
SELFTEST=0
DRY_RUN=0
FORCE_REASON=""
ISOLATED=0

usage() { printf 'Usage: %s [--dry-run] [--force-reason "reason"]\n       %s --selftest\n' "$0" "$0" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY_RUN=1; shift ;;
    --selftest)     SELFTEST=1; shift ;;
    --selftest-subprocess)
      # Card 1b08cf10 F3 (RedHat ccbfece8 19944d / MikroB 19945): the _QSG_*_OVERRIDE env vars
      # (and SHUTDOWN_EXE) used to take effect on ANY invocation, selftest or not -- RedHat
      # reached a real TRIGGER on the live path with no --selftest flag at all, just a missing
      # token-file override, a 99% hardstop override, and a fake binary. This internal flag,
      # set ONLY by the selftest's own subprocess helper (never documented in usage(), never
      # set by production cron), is now the SOLE gate for honoring those overrides below --
      # an attacker who can set env vars but not the version-controlled crontab invocation
      # line gains nothing from them.
      ISOLATED=1; shift ;;
    --force-reason)
      shift
      if [ $# -eq 0 ]; then
        echo "error: --force-reason requires a non-empty value (not a flag)" >&2; usage; exit 2
      fi
      _fr="${1#"${1%%[![:space:]]*}"}"     # strip leading whitespace
      _fr="${_fr%"${_fr##*[![:space:]]}"}" # strip trailing whitespace
      if [ -z "$_fr" ] || [[ "$_fr" == -* ]]; then
        echo "error: --force-reason requires a non-empty value (not a flag)" >&2; usage; exit 2
      fi
      FORCE_REASON="$_fr"; shift ;;
    *)
      echo "error: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ "$SELFTEST" = "1" ] || [ "$ISOLATED" = "1" ]; then
  TOKEN_FILE="${_QSG_TOKEN_FILE_OVERRIDE:-$STORE/.dashboard-token}"
  API="${_QSG_API_OVERRIDE:-http://localhost:3420}"
  HARDSTOP="${_QSG_HARDSTOP_OVERRIDE:-$STORE/weekly-hard-stop.json}"
  STATE="${_QSG_STATE_OVERRIDE:-$STORE/quota-shutdown-guard-state.json}"
  LOG="${_QSG_LOG_OVERRIDE:-$STORE/quota-shutdown-guard.log}"
  SHUTDOWN_EXE="${SHUTDOWN_EXE:-/mnt/c/Windows/System32/shutdown.exe}"
else
  TOKEN_FILE="$STORE/.dashboard-token"
  API="http://localhost:3420"
  HARDSTOP="$STORE/weekly-hard-stop.json"
  STATE="$STORE/quota-shutdown-guard-state.json"
  LOG="$STORE/quota-shutdown-guard.log"
  SHUTDOWN_EXE="/mnt/c/Windows/System32/shutdown.exe"
fi

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
  # _QSG_NO_TELEGRAM=1 suppresses Telegram sends in selftest subprocess cases -- production never
  # sets this. Card 1b08cf10 F1 (WhiteHat 19791): the suppression now leaves a positive trace in
  # LOG, so a regression that silently stops honoring this override is pinned, not just assumed
  # absent -- a pure "nothing happened" check can't tell suppressed-correctly from broken-silently.
  # Card 1b08cf10 F3 (RedHat ccbfece8 19944d): same gate as the other _QSG_* overrides below --
  # only honored under --selftest/--selftest-subprocess, never on a live invocation.
  if { [ "$SELFTEST" = "1" ] || [ "$ISOLATED" = "1" ]; } && [ "${_QSG_NO_TELEGRAM:-0}" = "1" ]; then
    log "TELEGRAM-SUPPRESSED (_QSG_NO_TELEGRAM=1): $text"
    return 0
  fi
  TG_TOKEN_FILE="$TOKEN_FILE" TG_API="$API" python3 - "$text" <<'PYEOF'
import os, sys, json, urllib.request
text = sys.argv[1]
try:
    token = open(os.environ["TG_TOKEN_FILE"]).read().strip()
    req = urllib.request.Request(
        os.environ["TG_API"] + "/api/messages",
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

if [ "$SELFTEST" = "1" ]; then
  # Card 0daf0033: izolalt STATE/LOG/SHUTDOWN_EXE minden esethez, SOHA nem a valodi gep leallitasa
  # vagy az eles STATE/LOG. send_telegram no-op-ra cserelve, hogy a selftest ne kuldjon valodi
  # Telegram uzenetet minden futtataskor.
  n=0
  fail=0
  t() { n=$((n + 1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  send_telegram() { :; }

  TMPD="$(mktemp -d)"
  SLOW_API_PID=""
  trap '[ -n "$SLOW_API_PID" ] && kill "$SLOW_API_PID" 2>/dev/null; rm -rf "$TMPD"' EXIT

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

  # Cases 5-13: argument-feldolgozas fail-closed -- ismeretlen argumentum = exit 2, nincs leallitas.
  # Subprocess-kent futnak, hogy a top-level arg-parsing ag legyen tesztelve; a FAKE_SHUTDOWN_MARKER
  # touch()-ot hivna, ha a trigger_shutdown tenyleg elerhetove valna.
  #
  # Card 49b9e7d0 RedHat F-RH-Q1: korabban CSAK a --dry-run-parser-effect esetek (12-13, a regi
  # _dryrun_test) kaptak STATE/LOG/Telegram izolaciot -- az 5-11. esetek (_arg_test) csak a
  # SHUTDOWN_EXE-t irtak felul. Ha a parser regresszal (vagy egy mutans futtatja), az az ag az ELO
  # STATE/LOG-ba irt es valodi Telegram-uzenetet kuldott -- ez tenylegesen megtortent ketszer
  # (2026-10-15 11:52 es 16:03). Minden subprocess-eset egy kozos helperen fut, ami MINDIG izolal.
  FAKE_MARKER="$TMPD/arg-test-marker.txt"
  FAKE_SHUTDOWN_MARKER="$TMPD/fake-shutdown-marker.sh"
  printf '#!/bin/bash\ntouch "%s"\nexit 0\n' "$FAKE_MARKER" > "$FAKE_SHUTDOWN_MARKER"
  chmod +x "$FAKE_SHUTDOWN_MARKER"
  SUBPROC_STATE="$TMPD/subproc-state.json"
  SUBPROC_LOG="$TMPD/subproc-log.txt"

  _subproc_run() {
    # timeout 3: a helyes eset azonnal exit 2-vel/0-val ter vissza; ha a mutacio miatt a script
    # tovabb fut (pl. curl --max-time 10 miatt blokkolna), a timeout 124-gyel ter vissza.
    #
    # Card 1b08cf10 F-RH-A3 (RedHat delta-lelet): --selftest-subprocess korabban "$@" UTAN allt,
    # tehat a "--force-reason without value" eset ("$@" = --force-reason) a hivott script szamara
    # valojaban "--force-reason --selftest-subprocess"-kent latszott -- nem az "ertek nelkul" agat
    # probalta, hanem a "jelzo koveti" agat (ugyanaz a vegeredmeny-exit-kod, de mas pin gyengult
    # el). A jelzo MOST "$@" ELE kerul, hogy minden _arg_test pontosan azt az argumentum-sorrendet
    # kapja, amit a label allit.
    local fake_exe="$1"; shift
    rm -f "$SUBPROC_STATE"
    : > "$SUBPROC_LOG"
    timeout 3 env SHUTDOWN_EXE="$fake_exe" _QSG_NO_TELEGRAM=1 \
      _QSG_STATE_OVERRIDE="$SUBPROC_STATE" _QSG_LOG_OVERRIDE="$SUBPROC_LOG" \
      bash "$0" --selftest-subprocess "$@" 2>/dev/null
  }

  _arg_test() {
    local label="$1"; shift
    rm -f "$FAKE_MARKER"
    _subproc_run "$FAKE_SHUTDOWN_MARKER" "$@"
    local rc=$?
    t "${label}: exit 2" "$rc" "2"
    t "${label}: shutdown marker NOT created" "$([ -f "$FAKE_MARKER" ] && echo YES || echo NO)" "NO"
    t "${label}: isolated STATE NOT written (not the live store)" "$([ -f "$SUBPROC_STATE" ] && echo YES || echo NO)" "NO"
  }

  _arg_test "unknown-arg 'selftest'" selftest
  _arg_test "unknown-arg '--self-test'" --self-test
  _arg_test "--force-reason without value" --force-reason
  _arg_test "--dry-run then unknown 'selftest'" --dry-run selftest
  _arg_test "--force-reason followed by a flag (--dry-run)" --force-reason --dry-run
  _arg_test "--force-reason followed by a flag (--selftest)" --force-reason --selftest
  _arg_test "--force-reason followed by a short flag (-n)" --force-reason -n
  # L1: whitespace-padded values -- exit 2 after trim (whitespace-only or space-prefixed flag).
  _arg_test "--force-reason with all-space value" --force-reason " "
  _arg_test "--force-reason with space-prefixed flag (' --dry-run')" --force-reason " --dry-run"

  # Cases 12-13: --dry-run parser-effect pinned (M3 mutant: DRY_RUN=1 removed from --dry-run branch).
  # Without DRY_RUN=1 in the parser, trigger_shutdown would call SHUTDOWN_EXE, creating the marker.
  # With the correct parser, DRY_RUN=1 causes trigger_shutdown to no-op -- marker stays absent.
  FAKE_MARKER2="$TMPD/dryrun-parse-marker.txt"
  FAKE_SHUTDOWN_DRY="$TMPD/fake-shutdown-dry.sh"
  printf '#!/bin/bash\ntouch "%s"\nexit 0\n' "$FAKE_MARKER2" > "$FAKE_SHUTDOWN_DRY"
  chmod +x "$FAKE_SHUTDOWN_DRY"

  _dryrun_test() {
    local label="$1"; shift
    rm -f "$FAKE_MARKER2"
    _subproc_run "$FAKE_SHUTDOWN_DRY" "$@"
    local rc=$?
    t "${label}: exit 0 (dry-run is not an error)" "$rc" "0"
    t "${label}: shutdown marker NOT created (--dry-run honored by parser)" \
      "$([ -f "$FAKE_MARKER2" ] && echo YES || echo NO)" "NO"
    t "${label}: isolated STATE NOT written (dry-run never commits)" "$([ -f "$SUBPROC_STATE" ] && echo YES || echo NO)" "NO"
  }

  _dryrun_test "--dry-run --force-reason ok" --dry-run --force-reason ok
  _dryrun_test "--force-reason ok --dry-run" --force-reason ok --dry-run

  # Case 14: FELTETEL 1 fail-closed hianyzo/olvashatatlan TOKEN_FILE eseten (card 548a92ee,
  # RedHat N3, 19814) -- a fo (nem --selftest) utat futtatjuk subprocess-kent, izolalva, ugy
  # hogy a token-fajl ne leteztessen es a kvota 99% legyen.
  MISSING_TOKEN_FILE="$TMPD/no-such-token"
  HARDSTOP_99="$TMPD/hardstop-99.json"
  printf '{"percent":99}\n' > "$HARDSTOP_99"
  FAKE_MARKER3="$TMPD/token-missing-marker.txt"
  FAKE_SHUTDOWN_TOKEN="$TMPD/fake-shutdown-token.sh"
  printf '#!/bin/bash\ntouch "%s"\nexit 0\n' "$FAKE_MARKER3" > "$FAKE_SHUTDOWN_TOKEN"
  chmod +x "$FAKE_SHUTDOWN_TOKEN"
  SUBPROC_STATE3="$TMPD/subproc-state3.json"
  SUBPROC_LOG3="$TMPD/subproc-log3.txt"

  rm -f "$FAKE_MARKER3" "$SUBPROC_STATE3"
  : > "$SUBPROC_LOG3"
  timeout 3 env SHUTDOWN_EXE="$FAKE_SHUTDOWN_TOKEN" _QSG_NO_TELEGRAM=1 \
    _QSG_STATE_OVERRIDE="$SUBPROC_STATE3" _QSG_LOG_OVERRIDE="$SUBPROC_LOG3" \
    _QSG_TOKEN_FILE_OVERRIDE="$MISSING_TOKEN_FILE" _QSG_HARDSTOP_OVERRIDE="$HARDSTOP_99" \
    bash "$0" --selftest-subprocess 2>/dev/null
  t "missing token-file + percent=99: shutdown marker NOT created (fail-closed)" \
    "$([ -f "$FAKE_MARKER3" ] && echo YES || echo NO)" "NO"
  t "missing token-file + percent=99: isolated STATE NOT written" \
    "$([ -f "$SUBPROC_STATE3" ] && echo YES || echo NO)" "NO"
  t "missing token-file + percent=99: isolated LOG names the SKIP reason" \
    "$(grep -q 'token-fajl hianyzik' "$SUBPROC_LOG3" 2>/dev/null && echo YES || echo NO)" "YES"

  # F-RH-A4 (RedHat delta-lelet, 1b08cf10): a case 15/16 subprocessei nem irtak felul a
  # token-fajlt. Ha az F2 (FORCE_REASON alatt nincs API-hivas) visszaesne, ezek a subprocessek
  # az ELO dashboard-tokent olvasnak es az ELO /api/agents-et hivnak -- egy biztonsagos, letezo
  # hamis token-fajl ezt kizarja meg regresszio eseten is.
  FAKE_TOKEN_FILE="$TMPD/fake-token-for-force-cases.txt"
  printf 'fake-token-not-a-real-credential\n' > "$FAKE_TOKEN_FILE"

  # Case 15: F1 pozitiv kontroll (card 1b08cf10, WhiteHat 19791 a 49b9e7d0 4. deltajan). A
  # korabbi izolacios pinek CSAK negativak voltak ("az izolalt STATE NEM irodott") -- egyik sem
  # bizonyitotta, hogy maga az izolacio ERVENYESUL. Ha egy regresszio csendben eldobja a
  # _QSG_STATE_OVERRIDE/_QSG_LOG_OVERRIDE env-sort a _subproc_run-bol, az irast ez nem akadalyozza
  # meg, csak az ELO utvonalra tereli -- a negativ allitas ("a stand-in NEM irodott") AKKOR IS
  # igaz marad. Ez az eset egy VALODI (nem --dry-run) force-triggert valt ki, es MINDEGYIK
  # izolalt celpontra (SUBPROC_STATE, SUBPROC_LOG, a marker) POZITIVAN allitja, hogy odairodott,
  # plusz hogy az ELO STATE/LOG mtime-ja valtozatlan maradt.
  LIVE_STATE="$STORE/quota-shutdown-guard-state.json"
  LIVE_LOG="$STORE/quota-shutdown-guard.log"
  live_state_mtime_before="$(stat -c %Y "$LIVE_STATE" 2>/dev/null || echo ABSENT)"
  live_log_mtime_before="$(stat -c %Y "$LIVE_LOG" 2>/dev/null || echo ABSENT)"

  FAKE_MARKER4="$TMPD/positive-control-marker.txt"
  FAKE_SHUTDOWN_POSITIVE="$TMPD/fake-shutdown-positive.sh"
  printf '#!/bin/bash\ntouch "%s"\nexit 0\n' "$FAKE_MARKER4" > "$FAKE_SHUTDOWN_POSITIVE"
  chmod +x "$FAKE_SHUTDOWN_POSITIVE"
  SUBPROC_STATE4="$TMPD/subproc-state4.json"
  SUBPROC_LOG4="$TMPD/subproc-log4.txt"
  rm -f "$FAKE_MARKER4" "$SUBPROC_STATE4"
  : > "$SUBPROC_LOG4"
  timeout 3 env SHUTDOWN_EXE="$FAKE_SHUTDOWN_POSITIVE" _QSG_NO_TELEGRAM=1 \
    _QSG_STATE_OVERRIDE="$SUBPROC_STATE4" _QSG_LOG_OVERRIDE="$SUBPROC_LOG4" \
    _QSG_TOKEN_FILE_OVERRIDE="$FAKE_TOKEN_FILE" _QSG_API_OVERRIDE="http://127.0.0.1:1" \
    bash "$0" --force-reason "positive-control" --selftest-subprocess 2>/dev/null
  rc=$?
  t "F1 positive-control: trigger_shutdown returns 0" "$rc" "0"
  t "F1 positive-control: shutdown marker IS created (the fake exe was actually invoked)" \
    "$([ -f "$FAKE_MARKER4" ] && echo YES || echo NO)" "YES"
  t "F1 positive-control: isolated STATE IS written (the override took effect)" \
    "$([ -f "$SUBPROC_STATE4" ] && echo YES || echo NO)" "YES"
  t "F1 positive-control: isolated LOG contains the TRIGGER line (the override took effect)" \
    "$(grep -q 'TRIGGER: manualis force: positive-control' "$SUBPROC_LOG4" && echo YES || echo NO)" "YES"
  t "F1 positive-control: isolated LOG shows Telegram was suppressed, not silently skipped" \
    "$(grep -q 'TELEGRAM-SUPPRESSED' "$SUBPROC_LOG4" && echo YES || echo NO)" "YES"
  live_state_mtime_after="$(stat -c %Y "$LIVE_STATE" 2>/dev/null || echo ABSENT)"
  live_log_mtime_after="$(stat -c %Y "$LIVE_LOG" 2>/dev/null || echo ABSENT)"
  t "F1 positive-control: the LIVE state file was not touched" "$live_state_mtime_after" "$live_state_mtime_before"
  t "F1 positive-control: the LIVE log file was not touched" "$live_log_mtime_after" "$live_log_mtime_before"

  # Case 16: F2 pozitiv kontroll (card 1b08cf10, WhiteHat 19791). A force-ut korabban MINDIG
  # meghivta az elo /api/agents-et is, es egy lassu/elerhetetlen API a selftest 3 mp-es
  # timeout-jaba futott bele (rc=124, hamis piros -- ez tortent elesben is, lasd a
  # quota-shutdown-guard-state.json.false-trigger-* fajlokat). Egy valodi, 4 mp-et varakozo
  # helyi HTTP-szerverre iranyitjuk az _QSG_API_OVERRIDE-ot (ugyanaz a repro, mint amit WhiteHat
  # mert): ha a javitas helyes, a force-ut SOHA nem er oda, es a subprocess a 3 mp-es timeout-on
  # belul visszater; ha visszaregresszalna (megint mindig lekerdezne running_flotta-t), a curl
  # --max-time 10 a 4 mp-es valaszra varva a `timeout 3`-ba futna, rc=124-et adva.
  SLOW_API_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  python3 - "$SLOW_API_PORT" <<'PYEOF' &
import sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[1])
class SlowHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(4)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"[]")
    def log_message(self, *a):
        pass
HTTPServer(("127.0.0.1", port), SlowHandler).serve_forever()
PYEOF
  SLOW_API_PID=$!

  SUBPROC_STATE5="$TMPD/subproc-state5.json"
  SUBPROC_LOG5="$TMPD/subproc-log5.txt"
  rm -f "$SUBPROC_STATE5"
  : > "$SUBPROC_LOG5"
  timeout 3 env SHUTDOWN_EXE="$FAKE_SHUTDOWN_POSITIVE" _QSG_NO_TELEGRAM=1 \
    _QSG_STATE_OVERRIDE="$SUBPROC_STATE5" _QSG_LOG_OVERRIDE="$SUBPROC_LOG5" \
    _QSG_TOKEN_FILE_OVERRIDE="$FAKE_TOKEN_FILE" \
    _QSG_API_OVERRIDE="http://127.0.0.1:$SLOW_API_PORT" \
    bash "$0" --dry-run --force-reason "f2-positive-control" --selftest-subprocess 2>/dev/null
  rc=$?
  t "F2 positive-control: force path finishes within the timeout (skips running_flotta)" "$rc" "0"

  kill "$SLOW_API_PID" 2>/dev/null
  wait "$SLOW_API_PID" 2>/dev/null
  SLOW_API_PID=""

  # Local stand-in returning zero running agents, instant response -- shared by Case 17 (F-RH-A1)
  # and Case 18 (F-RH-A2 control), both of which need FELTETEL 1 to actually fire under override.
  EMPTY_API_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  python3 - "$EMPTY_API_PORT" <<'PYEOF' &
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[1])
class EmptyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"[]")
    def log_message(self, *a):
        pass
HTTPServer(("127.0.0.1", port), EmptyHandler).serve_forever()
PYEOF
  EMPTY_API_PID=$!

  # Case 17: F-RH-A1 positive control (RedHat ccbfece8/1b08cf10 delta). Case 15's positive control
  # never drove FELTETEL 1 (the non-force path) through the overrides, so losing EITHER
  # _QSG_API_OVERRIDE or _QSG_HARDSTOP_OVERRIDE alone still passed 53/53 -- without them, a
  # real-looking percent/running-flotta reading (from the real files/API) just as plausibly fails
  # the condition and stays green for the wrong reason. This drives HARDSTOP=99% + a stand-in
  # reporting zero running agents through to an actual (safely faked) trigger: losing either
  # override breaks the match and the trigger silently stops firing.
  FAKE_MARKER6="$TMPD/a1-positive-control-marker.txt"
  FAKE_SHUTDOWN_A1="$TMPD/fake-shutdown-a1.sh"
  printf '#!/bin/bash\ntouch "%s"\nexit 0\n' "$FAKE_MARKER6" > "$FAKE_SHUTDOWN_A1"
  chmod +x "$FAKE_SHUTDOWN_A1"
  SUBPROC_STATE6="$TMPD/subproc-state6.json"
  SUBPROC_LOG6="$TMPD/subproc-log6.txt"
  rm -f "$FAKE_MARKER6" "$SUBPROC_STATE6"
  : > "$SUBPROC_LOG6"
  timeout 3 env SHUTDOWN_EXE="$FAKE_SHUTDOWN_A1" _QSG_NO_TELEGRAM=1 \
    _QSG_STATE_OVERRIDE="$SUBPROC_STATE6" _QSG_LOG_OVERRIDE="$SUBPROC_LOG6" \
    _QSG_TOKEN_FILE_OVERRIDE="$FAKE_TOKEN_FILE" _QSG_HARDSTOP_OVERRIDE="$HARDSTOP_99" \
    _QSG_API_OVERRIDE="http://127.0.0.1:$EMPTY_API_PORT" \
    bash "$0" --selftest-subprocess 2>/dev/null
  t "F-RH-A1 positive-control: shutdown marker IS created (hardstop+API overrides both took effect)" \
    "$([ -f "$FAKE_MARKER6" ] && echo YES || echo NO)" "YES"
  t "F-RH-A1 positive-control: isolated STATE IS written" "$([ -f "$SUBPROC_STATE6" ] && echo YES || echo NO)" "YES"
  t "F-RH-A1 positive-control: isolated LOG shows the HARDSTOP override's 99% drove the trigger" \
    "$(grep -q 'TRIGGER: heti kvota 99%, minden flotta-ugynok leallt' "$SUBPROC_LOG6" && echo YES || echo NO)" "YES"

  # Case 18: F-RH-A2 (RedHat finding, 1b08cf10 delta). Every case above runs FROM WITHIN this
  # already-isolated selftest, so a bug in the SELFTEST||ISOLATED gate itself could write to this
  # run's own TMPD-backed defaults instead of anything real and still read as green -- it can't
  # prove the gate holds on a flag-less, "looks like production" invocation. This builds an actual
  # STANDALONE COPY of the script with its own defaults (STORE and the hardcoded shutdown.exe path)
  # rewritten to scratch locations, and runs THAT without any --selftest/--selftest-subprocess flag
  # at all -- proving the _QSG_*_OVERRIDE vars, AND a direct environment-variable spoof of
  # ISOLATED=1/SELFTEST=1 (RedHat's own second mutant), have NO effect without the flag, with a
  # same-overrides control run WITH the flag proving the test is sensitive.
  NEUTRAL_COPY="$TMPD/neutral-copy.sh"
  NEUTRAL_STORE="$TMPD/neutral-store"
  mkdir -p "$NEUTRAL_STORE"
  NEUTRAL_STUB="$TMPD/neutral-stub-shutdown.sh"
  printf '#!/bin/bash\nexit 0\n' > "$NEUTRAL_STUB"
  chmod +x "$NEUTRAL_STUB"
  cp "$0" "$NEUTRAL_COPY"
  sed -i "s#/home/neon/marveen/store#$NEUTRAL_STORE#g; s#/mnt/c/Windows/System32/shutdown.exe#$NEUTRAL_STUB#g" "$NEUTRAL_COPY"
  chmod +x "$NEUTRAL_COPY"

  NEUTRAL_OVERRIDE_HARDSTOP="$TMPD/neutral-override-hardstop.json"
  printf '{"percent":99}\n' > "$NEUTRAL_OVERRIDE_HARDSTOP"
  NEUTRAL_OVERRIDE_TOKEN="$TMPD/neutral-override-token.txt"
  printf 'neutral-fake-token\n' > "$NEUTRAL_OVERRIDE_TOKEN"
  NEUTRAL_OVERRIDE_STATE="$TMPD/neutral-override-state.json"
  NEUTRAL_OVERRIDE_LOG="$TMPD/neutral-override-log.txt"
  rm -f "$NEUTRAL_OVERRIDE_STATE" "$NEUTRAL_OVERRIDE_LOG" \
        "$NEUTRAL_STORE/quota-shutdown-guard-state.json" "$NEUTRAL_STORE/quota-shutdown-guard.log"

  timeout 3 env _QSG_STATE_OVERRIDE="$NEUTRAL_OVERRIDE_STATE" _QSG_LOG_OVERRIDE="$NEUTRAL_OVERRIDE_LOG" \
    _QSG_HARDSTOP_OVERRIDE="$NEUTRAL_OVERRIDE_HARDSTOP" _QSG_TOKEN_FILE_OVERRIDE="$NEUTRAL_OVERRIDE_TOKEN" \
    _QSG_API_OVERRIDE="http://127.0.0.1:$EMPTY_API_PORT" ISOLATED=1 SELFTEST=1 \
    bash "$NEUTRAL_COPY" >/dev/null 2>&1
  t "F-RH-A2 no-flag: hardstop override IGNORED without the flag (neutral default log shows percent=0, not 99)" \
    "$(grep -q 'percent=0' "$NEUTRAL_STORE/quota-shutdown-guard.log" 2>/dev/null && echo YES || echo NO)" "YES"
  t "F-RH-A2 no-flag: override STATE file NOT created (the override path was never used)" \
    "$([ -f "$NEUTRAL_OVERRIDE_STATE" ] && echo YES || echo NO)" "NO"
  t "F-RH-A2 no-flag: override LOG file NOT created (log went to the neutral default path instead)" \
    "$([ -f "$NEUTRAL_OVERRIDE_LOG" ] && echo YES || echo NO)" "NO"

  NEUTRAL_CTRL_STATE="$TMPD/neutral-ctrl-state.json"
  NEUTRAL_CTRL_LOG="$TMPD/neutral-ctrl-log.txt"
  NEUTRAL_CTRL_MARKER="$TMPD/neutral-ctrl-marker.txt"
  NEUTRAL_CTRL_SHUTDOWN="$TMPD/neutral-ctrl-shutdown.sh"
  printf '#!/bin/bash\ntouch "%s"\nexit 0\n' "$NEUTRAL_CTRL_MARKER" > "$NEUTRAL_CTRL_SHUTDOWN"
  chmod +x "$NEUTRAL_CTRL_SHUTDOWN"
  rm -f "$NEUTRAL_CTRL_STATE" "$NEUTRAL_CTRL_LOG" "$NEUTRAL_CTRL_MARKER"
  timeout 3 env SHUTDOWN_EXE="$NEUTRAL_CTRL_SHUTDOWN" _QSG_NO_TELEGRAM=1 \
    _QSG_STATE_OVERRIDE="$NEUTRAL_CTRL_STATE" _QSG_LOG_OVERRIDE="$NEUTRAL_CTRL_LOG" \
    _QSG_HARDSTOP_OVERRIDE="$NEUTRAL_OVERRIDE_HARDSTOP" _QSG_TOKEN_FILE_OVERRIDE="$NEUTRAL_OVERRIDE_TOKEN" \
    _QSG_API_OVERRIDE="http://127.0.0.1:$EMPTY_API_PORT" \
    bash "$NEUTRAL_COPY" --selftest-subprocess 2>/dev/null
  t "F-RH-A2 control: the SAME overrides DO take effect WITH --selftest-subprocess (test is sensitive)" \
    "$([ -f "$NEUTRAL_CTRL_MARKER" ] && echo YES || echo NO)" "YES"
  t "F-RH-A2 control: isolated STATE IS written" "$([ -f "$NEUTRAL_CTRL_STATE" ] && echo YES || echo NO)" "YES"

  kill "$EMPTY_API_PID" 2>/dev/null
  wait "$EMPTY_API_PID" 2>/dev/null

  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

# --- FELTETEL 1: 99% heti kvota ES minden flotta-ugynok leallt ---
percent="$(python3 -c 'import json;print(json.load(open("'"$HARDSTOP"'")).get("percent",0))' 2>/dev/null || echo 0)"

# Card 548a92ee (RedHat N3, 19814): -1 = ISMERETLEN allapot alapertelmezesben (fail-closed).
# Hianyzo/olvashatatlan token-fajl vagy sikertelen API-lekerdezes SOHA nem egyezik a "0"-val
# lejjebb, tehat nem ertelmezodik "minden agens leallt"-kent.
#
# Card 1b08cf10 F2 (WhiteHat 19791): a force-ut (FORCE_REASON) nem hasznalja running_flotta-t
# (FELTETEL 1 ilyenkor ugyis irrelevans, lasd lejjebb az "exit $?" a force-agban), tehat a
# lekerdezes csak akkor fut, ha nincs FORCE_REASON -- korabban minden force/dry-run eset is
# meghivta az elo /api/agents-et, es egy lassu API hamis pirosat okozott a selftestben (timeout 3
# a wrapperben vs. --max-time 10 a curl-ban).
running_flotta=-1
if [ -z "$FORCE_REASON" ]; then
  if [ -f "$TOKEN_FILE" ] && [ -r "$TOKEN_FILE" ]; then
    running_flotta="$(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" | curl -H @- -s --max-time 10 "$API/api/agents" | python3 -c '
import json,sys
try:
    agents=json.load(sys.stdin)
except Exception:
    print(-1); raise SystemExit
n=sum(1 for a in agents if a.get("running") and a.get("name") != "mikrob")
print(n)
' 2>/dev/null || echo -1)"
  else
    log "WARN: token-fajl hianyzik vagy olvashatatlan ($TOKEN_FILE) -- flotta-allapot ISMERETLEN, a kvota-alapu automatikus leallitas (FELTETEL 1) ebben a korben SKIP."
    send_telegram "Flotta: quota-shutdown-guard nem tudja leolvasni a token-fajlt ($TOKEN_FILE) -- a flotta-allapot ISMERETLEN, a kvota-alapu automatikus leallitas ezert kimaradt ebben a korben. Kezi ellenorzes ajanlott."
  fi
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
