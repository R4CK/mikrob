#!/usr/bin/env bash
# gemini-agy-call.sh -- fleet wrapper around scripts/seged-hivo.py, scoped to the "agy" (Google
# Gemini, Antigravity CLI) engine only (card 64788453, Peti 11248-11287). seged-hivo.py's own quota
# is per-agent/per-ENGINE and DAILY (store/seged-hivo-kvota.json); this wrapper adds what the card
# explicitly asks for on top of that, before anything is sent:
#   1) a fleet-wide, rolling-60-minute cap of 5 real agy calls (Peti 11251: "oránkent max 5 hívás",
#      not napi 5/ügynök) -- counted the same way seged-hivo.py counts a "sent" call (status !=
#      blocked), restricted to engine=agy;
#   2) a mandatory --kategoria the CALLER must declare: anything but "safe" refuses before the call
#      (Peti's adaptation point 4: security/auth/financial cards, mopsion code, secrets and client
#      data must never go to an external helper) -- an unknown value refuses too (fail-closed: a
#      typo must never silently fall through to "safe");
#   3) a fixed model, gemini-3.8-flash-medium (Peti 11251: thinking level ALWAYS medium -- on agy
#      the reasoning level is baked into the model name itself: `agy models` lists only
#      gemini-3.8-flash-{low,medium,high} today, no 3.1-pro/4-argon/3.5-flash variant exists on this
#      account yet. GEMINI_AGY_MODEL overrides for when billing adds the richer chain MikroB's
#      comment 18049 describes -- this script does not implement model fallback, there is exactly
#      one real Gemini model to pick from right now);
#   4) a daily-log entry for every attempt that reaches this far (Peti 11279), never carrying the
#      prompt text -- best-effort, a failed POST must not turn a real call's result into a failure.
# Claude models are simply not reachable through this script (no model-selection surface beyond the
# one override above) -- that is Peti's point 6 ("a Claude-modellek agy-n keresztül NEM
# haszándandók") enforced structurally, not by a runtime check.
#
# Usage: gemini-agy-call.sh --hivo AGENT --kartya ID --feladattipus TYPE --kategoria CAT
#                            --prompt FILE --mappa DIR [--timeout SEC] [--model NAME]
#   CAT: safe | security | auth | finance | mopsion  (anything but "safe" refuses, exit 3)
# Exit codes mirror seged-hivo.py: 0 ok | 1 helper failed | 2 bad usage | 3 blocked (gate/category)
#                                   | 4 timeout | 5 quota/lock
set -euo pipefail

ROOT="${MARVEEN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STORE="$ROOT/store"
# The REAL seged-hivo.py, always: only used to borrow its read_log()/calls_of() for the hourly
# count, so that logic reads the SAME log path the real script writes (derived from MARVEEN_ROOT).
# Kept separate from SEGED_HIVO_SCRIPT below, which a test harness may point at a stub instead.
SEGED_HIVO_HELPERS="$ROOT/scripts/seged-hivo.py"
# The script actually invoked for the call -- overridable so a test can stub out the real engine
# (bwrap/agy) without touching the hourly-count logic above.
SEGED_HIVO="${SEGED_HIVO_SCRIPT:-$ROOT/scripts/seged-hivo.py}"
DASHBOARD_URL="${GEMINI_DASHBOARD_URL:-http://localhost:3420}"
DASHBOARD_TOKEN_FILE="${DASHBOARD_TOKEN_FILE:-$STORE/.dashboard-token}"
MODEL="${GEMINI_AGY_MODEL:-gemini-3.8-flash-medium}"
HOURLY_LIMIT="${GEMINI_AGY_HOURLY_LIMIT:-5}"
FORBIDDEN_CATEGORIES="security auth finance mopsion"

hivo="" kartya="" feladattipus="" kategoria="" prompt_file="" mappa="" timeout_s="120"
while [ $# -gt 0 ]; do
  case "$1" in
    --hivo) hivo="$2"; shift 2 ;;
    --kartya) kartya="$2"; shift 2 ;;
    --feladattipus) feladattipus="$2"; shift 2 ;;
    --kategoria) kategoria="$2"; shift 2 ;;
    --prompt) prompt_file="$2"; shift 2 ;;
    --mappa) mappa="$2"; shift 2 ;;
    --timeout) timeout_s="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "gemini-agy-call: unknown argument: $1" >&2; exit 2 ;;
  esac
done
for req_name in hivo kartya feladattipus kategoria prompt_file mappa; do
  req_val="${!req_name}"
  if [ -z "$req_val" ]; then
    echo "gemini-agy-call: --${req_name//_/-} is required" >&2
    exit 2
  fi
done

# Fail-closed category gate.
case " safe $FORBIDDEN_CATEGORIES " in
  *" $kategoria "*) ;;
  *)
    echo "gemini-agy-call: unknown --kategoria '$kategoria' (must be one of: safe $FORBIDDEN_CATEGORIES)" >&2
    exit 3
    ;;
esac
if [ "$kategoria" != safe ]; then
  echo "gemini-agy-call: --kategoria '$kategoria' is on the fleet's forbidden list for external" \
       "helpers (card 64788453: biztonsagi/auth/penzugyi kartya vagy mopsion kod nem mehet" \
       "Geminire), refusing before anything is sent" >&2
  exit 3
fi

# Hourly, FLEET-WIDE rolling cap. Reuses seged-hivo.py's own read_log()/calls_of() (same file it
# loads below has been imported only, nothing is re-executed: it guards its __main__ block).
now_epoch=$(date +%s)
window_start=$((now_epoch - 3600))
sent_count=$(python3 - "$SEGED_HIVO_HELPERS" "$window_start" <<'PY'
import datetime, importlib.util, sys
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
window_start = int(sys.argv[2])
n = 0
for row in sh.calls_of(sh.read_log()):
    if row.get('seged') != 'agy' or row.get('status') == 'blocked':
        continue
    try:
        ts = datetime.datetime.fromisoformat(str(row.get('ido', ''))).timestamp()
    except ValueError:
        continue
    if ts >= window_start:
        n += 1
print(n)
PY
)
if [ "$sent_count" -ge "$HOURLY_LIMIT" ]; then
  echo "gemini-agy-call: hourly fleet quota reached ($sent_count/$HOURLY_LIMIT agy calls in the last 60 min); try again later" >&2
  exit 5
fi

# Jitter between helper calls: 5-12 minutes (Peti 11248: "véletlen időzítés, szétszórva"), unless the
# caller already set tighter values (e.g. this script's own test harness).
export SEGED_SZUNET_MIN_S="${SEGED_SZUNET_MIN_S:-300}"
export SEGED_SZUNET_MAX_S="${SEGED_SZUNET_MAX_S:-720}"

t0=$(date +%s.%N)
set +e
out=$(python3 "$SEGED_HIVO" --seged "agy:$MODEL" --mappa "$mappa" --prompt "$prompt_file" \
      --hivo "$hivo" --kartya "$kartya" --feladattipus "$feladattipus" --timeout "$timeout_s")
rc=$?
set -e
t1=$(date +%s.%N)
duration_s=$(awk "BEGIN{printf \"%.1f\", $t1-$t0}")

call_status="ok"
[ "$rc" -ne 0 ] && call_status="hiba(rc=$rc)"
if [ -f "$DASHBOARD_TOKEN_FILE" ]; then
  token=$(cat "$DASHBOARD_TOKEN_FILE")
  content="Gemini-hivas (agy): modell=$MODEL hivo=$hivo kartya=$kartya feladattipus=$feladattipus status=$call_status ido=${duration_s}s ora-keret=$((sent_count + 1))/$HOURLY_LIMIT"
  payload=$(python3 -c 'import json,sys; print(json.dumps({"agent_id": sys.argv[1], "content": sys.argv[2]}))' "$hivo" "$content")
  curl -s -o /dev/null -X POST "$DASHBOARD_URL/api/daily-log" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data-binary "$payload" || true
fi

echo "$out"
exit "$rc"
