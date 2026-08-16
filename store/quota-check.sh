#!/bin/bash
# Quota/usage-limit monitor -- REWRITTEN 2026-07-11 (Peti: stale-modal false
# positives).
#
# ROOT CAUSE of the old false positive: Claude Code's client-side usage-limit
# MODAL ("What do you want to do? 1. Stop and wait for limit to reset ...") stays
# stuck in an agent's tmux pane after a PRIOR limit hit, and does NOT self-clear
# when the plan's 5h window resets -- only a session restart clears it. The old
# banner-regex scan read that stale modal as a live limit, so backend/qa/cybersec/
# cybered read as "limited" for hours while jogasz/fron-ted/mikrob kept working on
# the same shared plan (proof the plan was NOT limited).
#
# NEW PRINCIPLE: a detected limit-modal is only SUSPECT, not proof. We confirm via
# a RESTART-PROBE: restart the modal-showing agent (dashboard stop+start -> fresh
# session that re-checks the limit on boot). If the FRESH pane shows the modal
# again -> REAL limit. If the fresh pane boots clean -> the modal was STALE
# (recovered, not a real limit). Esc does NOT clear the modal, so restart is the
# only reliable recovery. Ground-truth = "can a fresh session work?", per CLAUDE.md.
set -u
STORE="/home/neon/marveen/store"
STATE="$STORE/quota-monitor-state.json"
COUNTDOWN="$STORE/quota-reset-countdown.json"
TOKEN_FILE="$STORE/.dashboard-token"
API="http://localhost:3420"
# Canonical phrase source, shared with src/model-fallback.ts and 5 other scripts (card 115c21e7).
# (The "/upgrade to increase your usage limit" STARTUP HINT is intentionally NOT
# here -- it appears in every fresh idle session and caused a different false
# positive in 2026-06-30.)
. "$STORE/session-limit-pattern.sh"
RX="$SESSION_LIMIT_RX"

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): the token must never be a curl
# argv (/proc/<pid>/cmdline is world-readable). write_auth_header refreshes a private 0600 header file
# (curl -H @"$hdr_file" reads it) instead of interpolating "Authorization: Bearer $T" on the command
# line. Called once per suspect (T is re-read from disk each time, unchanged from the original
# defensive per-iteration check); the ONE temp file is removed on EXIT.
tok() { cat "$TOKEN_FILE" 2>/dev/null; }
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
write_auth_header() { printf 'Authorization: Bearer %s\n' "$1" > "$hdr_file"; }
have_modal() { tmux capture-pane -t "$1" -p -S -25 2>/dev/null | grep -qiE "$RX"; }
# Parse the banner's stated reset time (e.g. "resets 11:50am") -> epoch, or "".
reset_epoch_of() {
  local rt
  rt=$(tmux capture-pane -t "$1" -p -S -25 2>/dev/null | grep -oiE 'resets [^()\n]+' | head -1 | sed -E 's/^[Rr]esets[[:space:]]+//')
  [ -n "$rt" ] && date -d "$rt" +%s 2>/dev/null || echo ""
}

prev=$(cat "$STATE" 2>/dev/null || echo '[]')
sessions=$(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^agent-|^mikrob-channels$')

# Pass 1: who currently shows a modal?
suspect=()
for s in $sessions; do have_modal "$s" && suspect+=("$s"); done

confirmed=()        # real limits (modal survived a restart-probe)
recovered=()        # stale modals cleared by restart
reset_epoch=0
for s in "${suspect[@]:-}"; do
  [ -z "$s" ] && continue
  # mikrob-channels is THIS orchestrator; never restart it (it runs this check and
  # receives Telegram). If it shows a modal it is a genuine live limit on the
  # controlling session -> report without probing.
  if [ "$s" = "mikrob-channels" ]; then
    confirmed+=("$s"); ep=$(reset_epoch_of "$s")
    [ -n "$ep" ] && { [ "$reset_epoch" -eq 0 ] || [ "$ep" -lt "$reset_epoch" ]; } && reset_epoch=$ep
    continue
  fi
  agent="${s#agent-}"
  T=$(tok)
  if [ -z "$T" ]; then confirmed+=("$s"); continue; fi   # fail-safe: can't probe -> treat as limited
  write_auth_header "$T"
  # RESTART-PROBE: fresh session re-checks the limit on boot.
  curl -s -o /dev/null -X POST "$API/api/agents/$agent/stop"  -H @"$hdr_file" -d '{}'
  curl -s -o /dev/null -X POST "$API/api/agents/$agent/start" -H @"$hdr_file" -d '{}'
  # wait for boot (no foreground sleep: bounded poll on a cheap endpoint)
  for _ in $(seq 1 40); do curl -s -o /dev/null "$API/api/kanban" -H @"$hdr_file"; done
  if have_modal "$s"; then
    confirmed+=("$s"); ep=$(reset_epoch_of "$s")
    [ -n "$ep" ] && { [ "$reset_epoch" -eq 0 ] || [ "$ep" -lt "$reset_epoch" ]; } && reset_epoch=$ep
  else
    recovered+=("$s")
  fi
done

# Countdown + dedup: only CONFIRMED (real) limits count. Recovered stale modals
# are logged, not reported, and never start a countdown.
python3 - "$prev" "$STATE" "$COUNTDOWN" "$reset_epoch" "$(IFS=,; echo "${confirmed[*]:-}")" "$(IFS=,; echo "${recovered[*]:-}")" <<'PY'
import json,sys,time,os
prev=set(json.loads(sys.argv[1] or "[]"))
statepath, countdownpath = sys.argv[2], sys.argv[3]
reset_epoch=float(sys.argv[4] or 0)
confirmed=[x for x in sys.argv[5].split(",") if x]
recovered=[x for x in sys.argv[6].split(",") if x]
new=[s for s in confirmed if s not in prev]
json.dump(confirmed, open(statepath,"w"))
FIVE_H_FIVE_M=5*3600+5*60
if confirmed:
    if not os.path.exists(countdownpath):
        t=time.time(); blind=t+FIVE_H_FIVE_M
        dl=min(blind, reset_epoch+120) if reset_epoch>0 else blind
        src="banner" if (reset_epoch>0 and dl<blind) else "blind-5h05m"
        json.dump({"hit_at":t,"deadline":dl,"deadline_source":src,"limited":confirmed}, open(countdownpath,"w"))
    else:
        try:
            cd=json.load(open(countdownpath)); cd["limited"]=confirmed; json.dump(cd,open(countdownpath,"w"))
        except Exception: pass
else:
    # No real limit. Clear any countdown (the restart-probe already recovered any
    # stale-modal agents, so there is nothing to wait for).
    if os.path.exists(countdownpath):
        try: os.remove(countdownpath)
        except Exception: pass
if recovered:
    print("RECOVERED-STALE:"+",".join(recovered))
print("NEW:"+",".join(new) if new else "NEW:")
print("CURRENT:"+",".join(confirmed) if confirmed else "CURRENT:")
PY
