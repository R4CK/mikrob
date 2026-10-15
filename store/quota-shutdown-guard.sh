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
TOKEN_FILE="${_QSG_TOKEN_FILE_OVERRIDE:-$STORE/.dashboard-token}"
API="http://localhost:3420"
HARDSTOP="${_QSG_HARDSTOP_OVERRIDE:-$STORE/weekly-hard-stop.json}"
# Env-overrides for selftest subprocess cases only -- production cron never sets these.
STATE="${_QSG_STATE_OVERRIDE:-$STORE/quota-shutdown-guard-state.json}"
LOG="${_QSG_LOG_OVERRIDE:-$STORE/quota-shutdown-guard.log}"
# Env-override only for the selftest (a FAKE binary, never the real path) -- the production
# cron config never sets this, so it always resolves to the real shutdown.exe.
SHUTDOWN_EXE="${SHUTDOWN_EXE:-/mnt/c/Windows/System32/shutdown.exe}"
SELFTEST=0
DRY_RUN=0
FORCE_REASON=""

usage() { printf 'Usage: %s [--dry-run] [--force-reason "reason"]\n       %s --selftest\n' "$0" "$0" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY_RUN=1; shift ;;
    --selftest)     SELFTEST=1; shift ;;
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
  # _QSG_NO_TELEGRAM=1 suppresses Telegram sends in selftest subprocess cases -- production never sets this.
  [ "${_QSG_NO_TELEGRAM:-0}" = "1" ] && return 0
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

# Card ccbfece8 (RedHat F-RH-T2, 548a92ee komment 19867): a running_flotta szamitast kulon
# fuggvenybe emelve, hogy a selftest a VALODI curl-hivas nelkul tudja injektalni a malformed
# API-valaszokat (lasd _QSG_AGENTS_JSON_OVERRIDE lejjebb) ugyanazzal a parse-logikaval, amit
# az eles kod hasznal -- nincs kulon, driftelhet masolat.
# Fail-closed: nem-lista, ures lista, vagy "running" kulcsot nelkulozo bejegyzes -> -1
# (ISMERETLEN), nem 0 (="minden agens leallt"). A {} es a hiányzó-"running"-sémahiba a sum()-ot
# máskülönben csendben 0-ra vinné, ami 99%-nál élesen leállítana a gépet egy puszta
# séma-elcsúszás miatt.
_qsg_parse_agents() {
  python3 -c '
import json,sys
try:
    agents=json.load(sys.stdin)
except Exception:
    print(-1); raise SystemExit
if not isinstance(agents, list) or len(agents) == 0 or any(not isinstance(a, dict) or "running" not in a for a in agents):
    print(-1); raise SystemExit
n=sum(1 for a in agents if a.get("running") and a.get("name") != "mikrob")
print(n)
'
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
    local fake_exe="$1"; shift
    rm -f "$SUBPROC_STATE"
    : > "$SUBPROC_LOG"
    timeout 3 env SHUTDOWN_EXE="$fake_exe" _QSG_NO_TELEGRAM=1 \
      _QSG_STATE_OVERRIDE="$SUBPROC_STATE" _QSG_LOG_OVERRIDE="$SUBPROC_LOG" \
      bash "$0" "$@" 2>/dev/null
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
    bash "$0" 2>/dev/null
  rc=$?
  t "missing token-file + percent=99: shutdown marker NOT created (fail-closed)" \
    "$([ -f "$FAKE_MARKER3" ] && echo YES || echo NO)" "NO"
  t "missing token-file + percent=99: isolated STATE NOT written" \
    "$([ -f "$SUBPROC_STATE3" ] && echo YES || echo NO)" "NO"
  t "missing token-file + percent=99: isolated LOG names the SKIP reason" \
    "$(grep -q 'token-fajl hianyzik' "$SUBPROC_LOG3" 2>/dev/null && echo YES || echo NO)" "YES"
  # Card ccbfece8 F-RH-T1: nemzero exit a degradalt (token-nelkuli) agban, hogy a
  # scheduled-task failThreshold erzekelje, amikor a Telegram-riasztas maga nem tudott kimenni.
  t "missing token-file + percent=99: exit 1 (degraded, observable even if the Telegram alert itself silently failed)" "$rc" "1"

  # Case 15 (card ccbfece8 F-RH-T3): a TOKEN_FILE LETEZIK, de NEM OLVASHATO -- ez a `[ -r ]`
  # feltetelt pinneli kulon a `[ -f ]`-tol (Case 14 nemletezo fajllal mar a `-f`-en elbukik,
  # tehat egy `[ -r ]`-et kivevo mutans ott nem valna pirossa; itt a fajl LETEZIK).
  UNREADABLE_TOKEN_FILE="$TMPD/unreadable-token"
  printf 'sometoken\n' > "$UNREADABLE_TOKEN_FILE"
  chmod 000 "$UNREADABLE_TOKEN_FILE"
  FAKE_MARKER4="$TMPD/token-unreadable-marker.txt"
  FAKE_SHUTDOWN_UNREADABLE="$TMPD/fake-shutdown-unreadable.sh"
  printf '#!/bin/bash\ntouch "%s"\nexit 0\n' "$FAKE_MARKER4" > "$FAKE_SHUTDOWN_UNREADABLE"
  chmod +x "$FAKE_SHUTDOWN_UNREADABLE"
  SUBPROC_STATE4="$TMPD/subproc-state4.json"
  SUBPROC_LOG4="$TMPD/subproc-log4.txt"
  rm -f "$FAKE_MARKER4" "$SUBPROC_STATE4"
  : > "$SUBPROC_LOG4"
  timeout 3 env SHUTDOWN_EXE="$FAKE_SHUTDOWN_UNREADABLE" _QSG_NO_TELEGRAM=1 \
    _QSG_STATE_OVERRIDE="$SUBPROC_STATE4" _QSG_LOG_OVERRIDE="$SUBPROC_LOG4" \
    _QSG_TOKEN_FILE_OVERRIDE="$UNREADABLE_TOKEN_FILE" _QSG_HARDSTOP_OVERRIDE="$HARDSTOP_99" \
    bash "$0" 2>/dev/null
  rc=$?
  t "unreadable token-file (exists, chmod 000) + percent=99: shutdown marker NOT created (pins [ -r ])" \
    "$([ -f "$FAKE_MARKER4" ] && echo YES || echo NO)" "NO"
  t "unreadable token-file: isolated STATE NOT written" "$([ -f "$SUBPROC_STATE4" ] && echo YES || echo NO)" "NO"
  t "unreadable token-file: exit 1 (same degraded path as missing-file)" "$rc" "1"
  chmod 644 "$UNREADABLE_TOKEN_FILE" 2>/dev/null || true

  # Cases 16-18 (card ccbfece8 F-RH-T2): az /api/agents valasz ALAKJA fail-closed legyen --
  # {}, [], vagy "running" kulcsot nelkulozo bejegyzes 99%-nal NE indítson leallitast
  # (running_flotta=-1, nem 0). A valodi tokent/curl-t az _QSG_AGENTS_JSON_OVERRIDE-dal
  # kerulik ki (lasd a fo script running_flotta-agat).
  FAKE_MARKER5="$TMPD/malformed-shape-marker.txt"
  FAKE_SHUTDOWN_SHAPE="$TMPD/fake-shutdown-shape.sh"
  printf '#!/bin/bash\ntouch "%s"\nexit 0\n' "$FAKE_MARKER5" > "$FAKE_SHUTDOWN_SHAPE"
  chmod +x "$FAKE_SHUTDOWN_SHAPE"
  SUBPROC_STATE5="$TMPD/subproc-state5.json"
  SUBPROC_LOG5="$TMPD/subproc-log5.txt"
  READABLE_TOKEN_FILE="$TMPD/readable-token"
  printf 'sometoken\n' > "$READABLE_TOKEN_FILE"

  _shape_test() {
    local label="$1" json="$2" want_marker="$3"
    rm -f "$FAKE_MARKER5" "$SUBPROC_STATE5"
    : > "$SUBPROC_LOG5"
    timeout 3 env SHUTDOWN_EXE="$FAKE_SHUTDOWN_SHAPE" _QSG_NO_TELEGRAM=1 \
      _QSG_STATE_OVERRIDE="$SUBPROC_STATE5" _QSG_LOG_OVERRIDE="$SUBPROC_LOG5" \
      _QSG_TOKEN_FILE_OVERRIDE="$READABLE_TOKEN_FILE" _QSG_HARDSTOP_OVERRIDE="$HARDSTOP_99" \
      _QSG_AGENTS_JSON_OVERRIDE="$json" \
      bash "$0" >/dev/null 2>&1
    t "${label}: shutdown marker $([ "$want_marker" = YES ] && echo CREATED || echo NOT-created)" \
      "$([ -f "$FAKE_MARKER5" ] && echo YES || echo NO)" "$want_marker"
  }

  _shape_test "malformed shape {} at 99%% (not a list)" '{}' "NO"
  _shape_test "malformed shape [] at 99%% (empty list, schema drift)" '[]' "NO"
  _shape_test "malformed shape, entry missing 'running' key, at 99%%" '[{"name":"backend"}]' "NO"
  # Positive control: a LEGITIMATE all-stopped shape must still shut down -- the F-RH-T2 fix
  # must stay fail-closed for malformed input, not become fail-open for every input.
  _shape_test "legitimate shape, mikrob excluded + backend stopped, at 99%% -- MUST still trigger" \
    '[{"name":"mikrob","running":true},{"name":"backend","running":false}]' "YES"

  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

# --- FELTETEL 1: 99% heti kvota ES minden flotta-ugynok leallt ---
percent="$(python3 -c 'import json;print(json.load(open("'"$HARDSTOP"'")).get("percent",0))' 2>/dev/null || echo 0)"

# Card 548a92ee (RedHat N3, 19814): -1 = ISMERETLEN allapot alapertelmezesben (fail-closed).
# Hianyzo/olvashatatlan token-fajl vagy sikertelen API-lekerdezes SOHA nem egyezik a "0"-val
# lejjebb, tehat nem ertelmezodik "minden agens leallt"-kent.
running_flotta=-1
# Card ccbfece8 F-RH-T1: token_unreadable jelzi, hogy a ISMERETLEN allapot oka a token hianya
# volt (nem pl. egy sikertelen curl) -- a riasztas ugyanerrol a tokenrol probal kimenni, tehat
# pont ebben az esetben nemasan elmaradhat (lasd lejjebb a fuggo "exit 1"-et).
token_unreadable=0
if [ -n "${_QSG_AGENTS_JSON_OVERRIDE:-}" ]; then
  # Selftest-only injekcios pont F-RH-T2 (malformed API-alak) tesztelesere -- a production cron
  # ezt SOHA nem allitja, mindig a valodi curl-agon megy at.
  running_flotta="$(printf '%s' "$_QSG_AGENTS_JSON_OVERRIDE" | _qsg_parse_agents 2>/dev/null || echo -1)"
elif [ -f "$TOKEN_FILE" ] && [ -r "$TOKEN_FILE" ]; then
  running_flotta="$(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" | curl -H @- -s --max-time 10 "$API/api/agents" | _qsg_parse_agents 2>/dev/null || echo -1)"
else
  token_unreadable=1
  log "WARN: token-fajl hianyzik vagy olvashatatlan ($TOKEN_FILE) -- flotta-allapot ISMERETLEN, a kvota-alapu automatikus leallitas (FELTETEL 1) ebben a korben SKIP."
  send_telegram "Flotta: quota-shutdown-guard nem tudja leolvasni a token-fajlt ($TOKEN_FILE) -- a flotta-allapot ISMERETLEN, a kvota-alapu automatikus leallitas ezert kimaradt ebben a korben. Kezi ellenorzes ajanlott."
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

# Card ccbfece8 F-RH-T1 (RedHat javitasi iranya, 548a92ee komment 19867): ha a token hianya
# miatt nem tudtuk megallapitani a flotta-allapotot, ez NEM "OK, nincs feltetel teljesitve" --
# nemzero kilepessel jelezzuk (a scheduled-task failThreshold mintaja, 0daf0033), mert a
# Telegram-riasztas pont ebben az esetben nemasan elmaradhat (send_telegram ugyanarrol a
# tokenrol olvas, amit itt nem tudtunk beolvasni).
if [ "$token_unreadable" = "1" ]; then
  log "SKIP (degradalt): token-fajl hianyzik/olvashatatlan, a kvota-allapot ISMERETLEN marad -- ez nem OK, kezi ellenorzes ajanlott."
  exit 1
fi

log "OK: nincs feltetel teljesitve (percent=$percent running_flotta=$running_flotta hour=$hour)."
exit 0
