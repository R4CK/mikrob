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
#   This script always resolves the real gate-script locations from its own path (M1, card
#   09117e0a) -- there is no --root/--seged-script/--dashboard-token-file/--dashboard-url/
#   --category-check override on the live CLI at all any more (F-B, card f6f67dff): any of those
#   is simply an unknown argument (exit 2). gemini-agy-call.selftest.sh keeps its own copy of that
#   parsing, purely for its own sandboxed fixtures; nothing shipped here understands them.
# Exit codes mirror seged-hivo.py: 0 ok | 1 helper failed | 2 bad usage | 3 blocked (gate/category)
#                                   | 4 timeout | 5 quota/lock
set -euo pipefail

# M1 (card 09117e0a, RedHat NO-GO 2. kor, komment 18611): a kapu-szkriptek helyet (hova mutat a
# gyoker, melyik seged-hivo/kategoria-kapu/dashboard-token/dashboard-url) korabban a hivo
# AKARMELY env-valtozoval lecserelhette, akkor is, amikor ez a script a VALODI, eles
# hivasban futott -- egy a folyamatfa felett allo, nem a kapu altal irt env csendben
# atiranyithatta a kategoria-kaput es a titok-szurot tartalmazo szkriptet magat. Most ezek
# KIZAROLAG CLI-kapcsolok, amiket csak a SAJAT selftest adja at kezzel (lasd
# gemini-agy-call.selftest.sh) -- a VALODI hivas (MikroB/agent dispatch) ezeket soha nem adja
# meg, tehat mindig a __file__ helyebol szamolt valodi gyokeret es alapertelmezett fajlokat
# hasznalja, es az environmentnek erre SEMMI hatasa nincs.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$ROOT/store"
# The REAL seged-hivo.py, always: only used to borrow its read_log()/calls_of() for the hourly
# count, so that logic reads the SAME log path the real script writes (derived from --root).
# Kept separate from SEGED_HIVO below, which the selftest may point at a stub instead.
SEGED_HIVO_HELPERS="$ROOT/scripts/seged-hivo.py"
# The script actually invoked for the call -- overridable (via --seged-script) so the selftest
# can stub out the real engine (bwrap/agy) without touching the hourly-count logic above.
SEGED_HIVO="$ROOT/scripts/seged-hivo.py"
DASHBOARD_URL="http://localhost:3420"
DASHBOARD_TOKEN_FILE="$STORE/.dashboard-token"
CATEGORY_CHECK_OVERRIDE=""
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
    # F-B (card f6f67dff, WhiteHat2): --root/--seged-script/--dashboard-token-file/--dashboard-url/
    # --category-check used to exist here as test-only CLI flags, gated behind an env var
    # (GEMINI_AGY_CALL_TEST_MODE=1). A live caller simply exporting that env var could still
    # re-enable them, so the live script now has NO knowledge of these flags at all: they fall
    # through to the same "unknown argument" refusal as any other mistyped flag, unconditionally,
    # with nothing to flip. gemini-agy-call.selftest.sh carries its own copy of this parsing (built
    # once, at the top of that file) purely for its own sandboxed test fixtures -- it never ships.
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

# N3 (card 09117e0a, RedHat NO-GO komment 18498): --kartya's format must be validated BEFORE it
# is ever inserted into a URL -- a fleet card id is always an 8-char lowercase hex string (see
# src/web/kanban-ref-normalize.ts's HEX8_REF_RE). A malformed value here would otherwise reach
# curl's URL construction unchecked.
if ! [[ "$kartya" =~ ^[A-Fa-f0-9]{8}$ ]]; then
  echo "gemini-agy-call: --kartya '$kartya' is not a valid 8-char hex card id, refusing" \
       "fail-closed before it is used to build a URL" >&2
  exit 3
fi

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

# F1 (card 09117e0a, WhiteHat F1 on 64788453 CYBERSEC GO komment 18210): a declared --kategoria
# 'safe' was trusted as-is -- the gate never looked at what the CARD ITSELF says, so a security/
# auth/finance/mopsion card mislabelled 'safe' (buggy or malicious caller) sailed through. The
# card's own title/description/labels are now checked server-side via the same stem/tag
# vocabulary store/offload-dispatch.sh's sensitive-content gate already uses. Fail-closed: if the
# card cannot be fetched/parsed, this is "cannot verify safe", not "assume safe".
CATEGORY_CHECK="${CATEGORY_CHECK_OVERRIDE:-$STORE/gemini-agy-category-check.py}"
if [ ! -f "$DASHBOARD_TOKEN_FILE" ]; then
  echo "gemini-agy-call: no dashboard token at $DASHBOARD_TOKEN_FILE -- cannot verify card" \
       "'$kartya' against its own content, refusing a declared-safe call fail-closed" >&2
  exit 3
fi
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
printf 'Authorization: Bearer %s\n' "$(cat "$DASHBOARD_TOKEN_FILE")" > "$hdr_file"
resp_file="$(mktemp)"
http_code="$(curl -s -m 10 -H @"$hdr_file" -o "$resp_file" -w '%{http_code}' \
             "$DASHBOARD_URL/api/kanban/$kartya" 2>/dev/null || true)"
rm -f "$hdr_file"
card_json="$(cat "$resp_file" 2>/dev/null || true)"
rm -f "$resp_file"
# N3 (card 09117e0a, RedHat NO-GO komment 18498): a dashboard 404/401/500 valasza is ERVENYES
# JSON-objektum ("error": ...), de nincs benne a kartya tartalma -- korabban ez "nincs jel" ->
# exit 0 -> a hivo szabadon megadhatott egy nem letezo vagy lejart kartya-azonositot, es a
# deklart 'safe' kategoria minden tartalom-ellenorzes nelkul atment. HTTP 200 kotelezo.
if [ "$http_code" != "200" ]; then
  echo "gemini-agy-call: dashboard returned HTTP $http_code for card '$kartya' -- cannot" \
       "verify it against its own content, refusing a declared-safe call fail-closed" >&2
  exit 3
fi
set +e
# F-E (card f6f67dff, WhiteHat2): -I on every python3 invocation here, so an ambient PYTHONPATH
# (inherited from whatever spawned this script) cannot shadow a stdlib module and quietly change
# what these helpers actually do.
detected_cat="$(printf '%s' "$card_json" | python3 -I "$CATEGORY_CHECK" "$kartya")"
check_rc=$?
set -e
if [ "$check_rc" -ne 0 ]; then
  echo "gemini-agy-call: could not verify card '$kartya' against its own content" \
       "(id/title mismatch or parse failed, rc=$check_rc) -- refusing a declared-safe call" \
       "fail-closed" >&2
  exit 3
fi
if [ -n "$detected_cat" ]; then
  echo "gemini-agy-call: --kategoria 'safe' declared for card '$kartya', but the card's own" \
       "title/description/labels signal '$detected_cat' -- refusing before anything is sent" >&2
  exit 3
fi

# Hourly, FLEET-WIDE rolling cap. Reuses seged-hivo.py's own read_log()/calls_of() (same file it
# loads below has been imported only, nothing is re-executed: it guards its __main__ block).
#
# The count-check and the actual call+log-append must be ONE atomic unit, or two concurrent
# invocations can both read the same sent_count and both pass (QA FAIL, comment 18226, measured:
# 4 seeded + 2 concurrent callers both went through -> 6/5). A dedicated flock, held from here
# through the end of the script, serializes the whole quota-sensitive region -- consistent with
# the card's own "flock egy hivas egyszerre" requirement, and cheap at a 5/hour cap.
HOURLY_LOCK="${GEMINI_AGY_HOURLY_LOCK:-$STORE/gemini-agy-call.hourly.lock}"
# F1 (card 5177720d, WhiteHat GO on 64788453 @d2dd388a, komment 11880): the wait for this lock used
# to be unbounded (flock -x 9), so if another caller holds it across seged-hivo.py's own pause()
# (5-12 min jitter, see SEGED_SZUNET_* below), every other caller could stall for that entire time.
# Bounded wait + a loud, named refusal instead of a silent hang.
HOURLY_LOCK_WAIT_S="${GEMINI_AGY_HOURLY_LOCK_WAIT_S:-30}"
exec 9>"$HOURLY_LOCK"
if ! flock -x -w "$HOURLY_LOCK_WAIT_S" 9; then
  echo "gemini-agy-call: could not acquire the hourly-quota lock within ${HOURLY_LOCK_WAIT_S}s" \
       "(another caller is holding it, e.g. inside seged-hivo.py's pause()) -- refusing instead" \
       "of waiting indefinitely" >&2
  exit 5
fi

now_epoch=$(date +%s)
window_start=$((now_epoch - 3600))
# seged-hivo.py's ROOT is __file__-based only now (F-A, card 09117e0a, WhiteHat2 NO-GO komment
# 18851): it resolves from wherever $SEGED_HIVO_HELPERS itself lives, no env var needed or
# honored any more. The test harness points this at its own COPY of the real script (a symlink
# would resolve straight back to the real repo root and defeat the sandbox).
sent_count=$(python3 -I - "$SEGED_HIVO_HELPERS" "$window_start" <<'PY'
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
# seged-hivo.py itself no longer reads MARVEEN_ROOT (F-A, card 09117e0a, WhiteHat2 NO-GO komment
# 18851): its ROOT resolves purely from its own __file__ now, so an unrelated MARVEEN_ROOT sitting
# in the caller's shell has no effect on the REAL script any more. This forward only still matters
# when $SEGED_HIVO is the test harness's STUB (--seged-script, test-only) standing in for it, which
# the stub itself reads to find the sandbox root -- irrelevant to anything this env-security fix
# protects, since the stub never touches the secret gate.
out=$(MARVEEN_ROOT="$ROOT" python3 -I "$SEGED_HIVO" --seged "agy:$MODEL" --mappa "$mappa" --prompt "$prompt_file" \
      --hivo "$hivo" --kartya "$kartya" --feladattipus "$feladattipus" --timeout "$timeout_s")
rc=$?
set -e
t1=$(date +%s.%N)
duration_s=$(awk "BEGIN{printf \"%.1f\", $t1-$t0}")

call_status="ok"
[ "$rc" -ne 0 ] && call_status="hiba(rc=$rc)"
if [ -f "$DASHBOARD_TOKEN_FILE" ]; then
  content="Gemini-hivas (agy): modell=$MODEL hivo=$hivo kartya=$kartya feladattipus=$feladattipus status=$call_status ido=${duration_s}s ora-keret=$((sent_count + 1))/$HOURLY_LIMIT"
  payload=$(python3 -I -c 'import json,sys; print(json.dumps({"agent_id": sys.argv[1], "content": sys.argv[2]}))' "$hivo" "$content")
  # Token goes through a 0600 temp header file, never argv (a Bearer token in argv is readable
  # from /proc/<pid>/cmdline by any local process -- same pattern as offload-dispatch.sh).
  hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
  printf 'Authorization: Bearer %s\n' "$(cat "$DASHBOARD_TOKEN_FILE")" > "$hdr_file"
  curl -s -o /dev/null -X POST "$DASHBOARD_URL/api/daily-log" \
    -H @"$hdr_file" -H 'Content-Type: application/json' \
    --data-binary "$payload" || true
  rm -f "$hdr_file"
fi

echo "$out"
exit "$rc"
