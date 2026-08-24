#!/usr/bin/env bash
# redispatch-guard.sh -- SAFE re-dispatch/nudge guard for the fleet monitors.
#
# WHY (Peti 2026-07-30): a card that only LOOKS stuck (a slow but live build, coarse
# [NN%] updates) was being re-dispatched/nudged over and over by the monitors
# (stuck-card-monitor, fleet-nudger, gate-reconciler, folyamatos-munka). Each nudge made
# the agent redo/continue work, and when the agent was BUSY the nudges just queued and
# replayed -> the same card "developed 18x" -> massive token burn. This guard is the
# single chokepoint every monitor must pass a nudge through, so a working or progressing
# card is NEVER re-dispatched, and a genuinely dead card is retried at most a few times
# with backoff before escalating to Peti ONCE instead of looping forever.
#
# CONTRACT:
#   redispatch-guard.sh check <cardId> <agent>
#       -> prints "ALLOW" (and records the attempt) if a nudge is warranted,
#          or "DENY:<reason>" if it must be suppressed. Exit 0 = ALLOW, 8 = DENY.
#       The caller (a monitor) nudges ONLY on ALLOW.
#   redispatch-guard.sh reset <cardId>       -> clear the ledger entry (card closed/done)
#   redispatch-guard.sh escalations          -> print + clear pending cap-reached escalations
#                                               as JSON [{cardId,count,ts}] for Peti-reporting
#   redispatch-guard.sh selftest             -> run the built-in self-test (no side effects)
#
# DECISION ORDER in `check` (first match wins):
#   1. card not in_progress/waiting            -> DENY:not-active   (nothing to nudge)
#   2. progress since last check               -> DENY:progress     (reset counter; it's alive)
#      (card.updated_at advanced, OR a new commit landed on the tracked branch)
#   3. agent tmux panel is BUSY                 -> DENY:agent-busy   (never queue on a worker)
#   4. hard cap reached (count >= MAX)          -> DENY:cap-reached  (escalate to Peti ONCE)
#      (checked BEFORE backoff, card 86dfba39: a cap already reached must escalate right away,
#       not sit out one more -- and by construction the LONGEST -- backoff window first)
#   5. within backoff window                    -> DENY:backoff:<s>  (base 600s * 2^count)
#   6. otherwise                                -> ALLOW             (count++, stamp ts)
#
# SECURITY (gate-ops-scripts-token-in-argv): the dashboard bearer token is passed to curl
# via a 0600 @headerfile, never in argv. No secret is echoed. Runtime state lives in
# gitignored store/ JSON; the SCRIPT is version-controlled + pushed (ops-scripts rule).
set -uo pipefail

STORE="/home/neon/marveen/store"
DASH="http://localhost:3420"
TOKEN_FILE="${STORE}/.dashboard-token"
LEDGER="${STORE}/redispatch-ledger.json"
ESCAL="${STORE}/stuck-escalations.json"
BASE_BACKOFF=600      # seconds; interval = BASE * 2^count
MAX_REDISPATCH=3      # hard cap on auto re-dispatches per card before escalating

MODE="${1:-}"

# ---- helpers ---------------------------------------------------------------------------
now_ts() { date +%s; }

_curl_get() { # $1 = path ; token via 0600 headerfile, never argv
  local hf; hf="$(mktemp)"; chmod 600 "$hf"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hf"
  curl -s --max-time 12 -H @"$hf" "${DASH}$1" 2>/dev/null
  rm -f "$hf" 2>/dev/null || true
}

# Fetch one card's fields: prints "status<TAB>updated_at<TAB>assignee" or empty if not found.
_card_fields() { # $1 = cardId
  _curl_get "/api/kanban" | CARD="$1" python3 -c '
import json,sys,os
cid=os.environ["CARD"]
try: cards=json.load(sys.stdin)
except Exception: sys.exit(0)
for c in cards:
    if str(c.get("id","")).startswith(cid):
        print("%s\t%s\t%s" % (c.get("status",""), c.get("updated_at",0) or 0, c.get("assignee","") or ""))
        break
'
}

# Is the agent tmux panel actively working? Two 1.2s samples; change => busy. Also treat
# an explicit "queued messages" hint or a live spinner/token-counter line as busy.
_agent_busy() { # $1 = agent short name ; exit 0 = busy, 1 = idle/absent
  local sess="agent-$1" s1 s2
  tmux has-session -t "$sess" 2>/dev/null || return 1   # not running => not busy (park/absent)
  s1="$(tmux capture-pane -t "$sess" -p 2>/dev/null)"
  # explicit busy markers on the current frame
  if printf '%s' "$s1" | grep -qE 'Press up to edit queued messages|esc to interrupt.*tokens|[✻✽✢·✳✶✷] .*\((tokens|[0-9]+s )'; then
    return 0
  fi
  sleep 1.2
  s2="$(tmux capture-pane -t "$sess" -p 2>/dev/null)"
  [ "$s1" != "$s2" ] && return 0   # frame changed => actively rendering => busy
  return 1
}

# ledger read/write via python (atomic-ish rewrite)
_ledger_get() { # $1 cardId -> "count<TAB>last_ts<TAB>last_updated_at" (zeros if absent)
  python3 - "$LEDGER" "$1" <<'PY'
import json,sys,os
path,cid=sys.argv[1],sys.argv[2]
d={}
try:
    with open(path) as f: d=json.load(f)
except Exception: d={}
e=d.get(cid) or {}
print("%d\t%d\t%d" % (int(e.get("count",0)), int(e.get("last_ts",0)), int(e.get("last_updated_at",0))))
PY
}

_ledger_set() { # $1 cardId $2 count $3 last_ts $4 last_updated_at
  python3 - "$LEDGER" "$1" "$2" "$3" "$4" <<'PY'
import json,sys,os,tempfile
path,cid,count,ts,upd=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4]),int(sys.argv[5])
d={}
try:
    with open(path) as f: d=json.load(f)
except Exception: d={}
d[cid]={"count":count,"last_ts":ts,"last_updated_at":upd}
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path) or ".")
with os.fdopen(fd,"w") as f: json.dump(d,f,indent=2)
os.replace(tmp,path)
PY
}

_ledger_del() { # $1 cardId
  python3 - "$LEDGER" "$1" <<'PY'
import json,sys,os,tempfile
path,cid=sys.argv[1],sys.argv[2]
try:
    with open(path) as f: d=json.load(f)
except Exception: return_=0; d=None
if d is None: sys.exit(0)
d.pop(cid,None)
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path) or ".")
with os.fdopen(fd,"w") as f: json.dump(d,f,indent=2)
os.replace(tmp,path)
PY
}

# Card 86dfba39: the cap check MUST win over the backoff check even when the current
# (longest) backoff window has not elapsed yet. Extracted to its own pure function so the
# selftest can exercise the REAL decision, not a hand-copied re-implementation of it -- the
# bug this fixes is entirely about the ORDER of these two conditions, so the test has to run
# the same two conditions in the same order the real `check` command does.
# $1=count $2=last_ts $3=now $4=busy(0/1) -> prints one of:
#   agent-busy | cap-reached | backoff:<remaining-seconds> | allow
_decide_active() {
  local count="$1" last_ts="$2" now="$3" busy="$4" interval elapsed
  if [ "$busy" = "1" ]; then echo "agent-busy"; return; fi
  # cap FIRST: once count has already reached MAX_REDISPATCH, escalate immediately instead of
  # waiting out one more (and by construction the LONGEST) backoff window before noticing.
  if [ "$count" -ge "$MAX_REDISPATCH" ]; then echo "cap-reached"; return; fi
  interval=$(( BASE_BACKOFF * (1 << count) ))
  elapsed=$(( now - last_ts ))
  if [ "$elapsed" -lt "$interval" ]; then echo "backoff:$(( interval - elapsed ))"; return; fi
  echo "allow"
}

_escalate_once() { # $1 cardId $2 count -- record a cap-reached escalation if not already present
  python3 - "$ESCAL" "$1" "$2" "$(now_ts)" <<'PY'
import json,sys,os,tempfile
path,cid,count,ts=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
d={}
try:
    with open(path) as f: d=json.load(f)
except Exception: d={}
if cid not in d:               # ONCE: don't re-add on every subsequent denied tick
    d[cid]={"count":count,"ts":ts,"notified":False}
    fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path) or ".")
    with os.fdopen(fd,"w") as f: json.dump(d,f,indent=2)
    os.replace(tmp,path)
PY
}

# ---- commands --------------------------------------------------------------------------
case "$MODE" in
  check)
    CARD="${2:-}"; AGENT="${3:-}"
    [ -n "$CARD" ] && [ -n "$AGENT" ] || { echo "DENY:usage"; exit 8; }
    fields="$(_card_fields "$CARD")"
    if [ -z "$fields" ]; then echo "DENY:card-not-found"; exit 8; fi
    status="$(printf '%s' "$fields" | cut -f1)"
    upd="$(printf '%s' "$fields" | cut -f2)"
    upd="${upd%%.*}"; [ -n "$upd" ] || upd=0
    case "$status" in in_progress|waiting) : ;; *) echo "DENY:not-active($status)"; exit 8 ;; esac

    IFS=$'\t' read -r count last_ts last_upd <<<"$(_ledger_get "$CARD")"
    ts="$(now_ts)"

    # (2) progress since last check -> reset + suppress
    if [ "$upd" -gt "$last_upd" ] && [ "$last_upd" -gt 0 ]; then
      _ledger_set "$CARD" 0 "$ts" "$upd"
      echo "DENY:progress"; exit 8
    fi
    # first sighting: baseline the updated_at, do NOT nudge yet (give it a full cycle)
    if [ "$last_ts" -eq 0 ]; then
      _ledger_set "$CARD" 0 "$ts" "$upd"
      echo "DENY:first-seen-baseline"; exit 8
    fi

    # (3) busy, (4) cap, (5) backoff -- see _decide_active for why cap is checked before backoff
    busy=0; _agent_busy "$AGENT" && busy=1
    decision="$(_decide_active "$count" "$last_ts" "$ts" "$busy")"
    case "$decision" in
      agent-busy)
        # refresh last_ts so backoff timer tracks real quiet time, keep count
        _ledger_set "$CARD" "$count" "$ts" "$upd"
        echo "DENY:agent-busy"; exit 8 ;;
      cap-reached)
        _escalate_once "$CARD" "$count"
        echo "DENY:cap-reached($count)"; exit 8 ;;
      backoff:*)
        echo "DENY:backoff(${decision#backoff:}s)"; exit 8 ;;
      allow)
        _ledger_set "$CARD" "$(( count + 1 ))" "$ts" "$upd"
        echo "ALLOW"; exit 0 ;;
    esac
    ;;

  reset)
    CARD="${2:-}"; [ -n "$CARD" ] || { echo "usage: reset <cardId>"; exit 2; }
    _ledger_del "$CARD"; echo "reset $CARD"; exit 0 ;;

  escalations)
    # print pending (not-yet-notified) escalations as JSON, mark them notified
    python3 - "$ESCAL" <<'PY'
import json,sys,os,tempfile
path=sys.argv[1]
try:
    with open(path) as f: d=json.load(f)
except Exception: print("[]"); sys.exit(0)
out=[{"cardId":k,"count":v.get("count"),"ts":v.get("ts")} for k,v in d.items() if not v.get("notified")]
for k in d:
    d[k]["notified"]=True
if out:
    fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path) or ".")
    with os.fdopen(fd,"w") as f: json.dump(d,f,indent=2)
    os.replace(tmp,path)
print(json.dumps(out,ensure_ascii=False))
PY
    ;;

  selftest)
    tmpdir="$(mktemp -d)"; LEDGER="$tmpdir/led.json"; ESCAL="$tmpdir/esc.json"; fails=0
    # stub card fields + agent-busy for deterministic testing
    _card_fields() { printf 'in_progress\t%s\tbackend\n' "${STUB_UPD:-1000}"; }
    _agent_busy() { [ "${STUB_BUSY:-0}" = "1" ]; }
    chk() { STUB_UPD="$1" STUB_BUSY="$2" bash -c ':'; }  # placeholder
    run() { MODE=check; CARD=C1; AGENT=backend; }
    # 1) first-seen -> baseline DENY
    out="$(STUB_UPD=1000 STUB_BUSY=0; f="$(_card_fields C1)"; s=$(echo "$f"|cut -f1); u=$(echo "$f"|cut -f2);
      IFS=$'\t' read -r c lt lu <<<"$(_ledger_get C1)"; ts=100;
      if [ "$lt" -eq 0 ]; then _ledger_set C1 0 "$ts" "$u"; echo DENY:first-seen-baseline; fi)"
    [ "$out" = "DENY:first-seen-baseline" ] || { echo "FAIL first-seen: $out"; fails=$((fails+1)); }
    # 2) busy -> DENY:agent-busy (count preserved)
    _ledger_set C1 1 50 1000
    out="$(STUB_BUSY=1; if _agent_busy backend; then echo DENY:agent-busy; fi)"
    [ "$out" = "DENY:agent-busy" ] || { echo "FAIL busy: $out"; fails=$((fails+1)); }
    # 3) progress -> reset
    out="$(u=2000; IFS=$'\t' read -r c lt lu <<<"$(_ledger_get C1)"; if [ "$u" -gt "$lu" ] && [ "$lu" -gt 0 ]; then _ledger_set C1 0 999 "$u"; echo DENY:progress; fi)"
    [ "$out" = "DENY:progress" ] || { echo "FAIL progress: $out"; fails=$((fails+1)); }
    IFS=$'\t' read -r c lt lu <<<"$(_ledger_get C1)"; [ "$c" -eq 0 ] || { echo "FAIL progress-reset count=$c"; fails=$((fails+1)); }
    # 4) cap -> escalate once
    _ledger_set C2 3 1 1000; _escalate_once C2 3; _escalate_once C2 3
    n="$(python3 -c "import json;print(len(json.load(open('$ESCAL'))))")"
    [ "$n" = "1" ] || { echo "FAIL escalate-once n=$n"; fails=$((fails+1)); }
    # 5) backoff math: count=2 -> interval 2400s
    intv=$(( BASE_BACKOFF * (1 << 2) )); [ "$intv" -eq 2400 ] || { echo "FAIL backoff-math $intv"; fails=$((fails+1)); }
    # 6) card 86dfba39: cap MUST win over backoff even while the current backoff window has
    # not elapsed -- calls the REAL decision function, not a re-implementation of it.
    out="$(_decide_active 3 990 1000 0)"  # count==MAX_REDISPATCH, only 10s elapsed of a 4800s window
    [ "$out" = "cap-reached" ] || { echo "FAIL cap-before-backoff: $out"; fails=$((fails+1)); }
    # CONTROL: below the cap, the same still-open window correctly denies on backoff, not cap.
    out="$(_decide_active 2 990 1000 0)"  # count==2 < MAX_REDISPATCH, interval 2400s, elapsed 10s
    [ "$out" = "backoff:2390" ] || { echo "FAIL backoff-control: $out"; fails=$((fails+1)); }
    # CONTROL: busy still wins over both, unconditionally
    out="$(_decide_active 3 990 1000 1)"
    [ "$out" = "agent-busy" ] || { echo "FAIL busy-control: $out"; fails=$((fails+1)); }
    rm -rf "$tmpdir"
    if [ "$fails" -eq 0 ]; then echo "SELFTEST: PASS"; exit 0; else echo "SELFTEST: FAIL ($fails)"; exit 1; fi
    ;;

  *)
    echo "usage: $0 {check <cardId> <agent>|reset <cardId>|escalations|selftest}" >&2; exit 2 ;;
esac
