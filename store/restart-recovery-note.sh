#!/usr/bin/env bash
# restart-recovery-note.sh -- ONE recovery dispatch per in-flight agent after a host/channels
# restart (card 7c1e6a65, FAZIS 5978afaa "dsh-superagent adoption"). Ideas re-implemented on our
# stack from deepseek-ai/dsh-superagent-prototype @8c32a9dc (MIT, research prototype); no code
# vendored.
#
# WHY. Before this, a restart meant MikroB manually re-reading every in-flight card and messaging
# each agent by hand ("the manual morning resume", 13 times so far per the card). This script
# replaces that: it finds every agent with real in-flight work -- an in_progress card, or a
# waiting card whose land run was killed (store/land-run-stale-check.sh STALE) -- plus any gate
# agent sitting on an unread message backlog, and sends each ONE fixed-text recovery note naming
# its own in-flight card ids (oldest first) and its unread-backlog size. It does NOT duplicate
# store/agent-boot-reconcile.sh (which starts stopped tmux sessions): this script only sends the
# recovery NOTE, assuming the agent (or boot-reconcile) is already running.
#
# CONSTRAINT (Peti 14288, additive only): reads existing wiring only -- GET /api/kanban,
# GET/POST /api/messages, GET /api/messages/backlog, store/land-run-stale-check.sh. Nothing here
# changes any existing endpoint, script or gate keyword.
#
# Usage:
#   restart-recovery-note.sh [--dry-run]         default: print the per-agent plan, send nothing
#   restart-recovery-note.sh --apply             actually POST the notes, then record the boot id
#   restart-recovery-note.sh --selftest
#
# Idempotent per boot id (default source: /proc/sys/kernel/random/boot_id, a kernel-generated
# UUID that changes every boot -- override with RESTART_RECOVERY_BOOT_ID for tests). --apply
# records the boot id it ran for in RESTART_RECOVERY_STATE_FILE (default
# store/.restart-recovery-note-boot); a second --apply for the SAME boot id is a no-op (prints
# "already sent", sends nothing) so a cron/heartbeat re-run after the first successful pass never
# re-notifies. --dry-run never reads or writes the state file -- it is always safe to re-run.
#
# If the boot id cannot be determined at all (no /proc/sys/kernel/random/boot_id and no override),
# this fails toward OVER-notifying, not under-notifying: idempotency is skipped and --apply always
# sends. A duplicate recovery note is cheap noise; a silently-skipped one after a real restart is
# the incident this script exists to prevent.
#
# Exit: 0 ok | 1 the initial kanban/messages fetch failed (fail-closed visibility, not silent), or
#       (in --apply mode) at least one recovery note did not get a 2xx -- the boot id is then NOT
#       recorded, so the next --apply retries | 2 bad usage
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${MARVEEN_MAIN:-/home/neon/marveen}"
DASH="${DASH:-http://localhost:3420}"
STATE_FILE="${RESTART_RECOVERY_STATE_FILE:-$ROOT/store/.restart-recovery-note-boot}"
BOOT_ID_FILE="${RESTART_RECOVERY_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
# land-run-stale-check.sh is a SIBLING of this script, not under $ROOT/store -- $ROOT is
# overridden in tests to a fake "main" that holds only a fixture token file, never a copy of the
# real store/ scripts.
STALE_CHECK_BIN="${RESTART_RECOVERY_STALE_CHECK_BIN:-$HERE/land-run-stale-check.sh}"
GATE_AGENTS="qa qa2 cybersec cybersec2 cybered"

die() { echo "restart-recovery-note.sh: $2" >&2; exit "$1"; }

current_boot_id() {
  if [ -n "${RESTART_RECOVERY_BOOT_ID:-}" ]; then
    printf '%s' "$RESTART_RECOVERY_BOOT_ID"
  elif [ -r "$BOOT_ID_FILE" ]; then
    cat "$BOOT_ID_FILE" 2>/dev/null
  fi
}

mode="dry-run"
case "${1:-}" in
  --selftest) exec bash "$HERE/restart-recovery-note.selftest.sh" ;;
  --dry-run|'') mode="dry-run" ;;
  --apply) mode="apply" ;;
  *) die 2 "usage: restart-recovery-note.sh [--dry-run|--apply] | --selftest" ;;
esac

TOK="$(cat "$ROOT/store/.dashboard-token" 2>/dev/null)"
[ -n "$TOK" ] || die 1 "no dashboard token at $ROOT/store/.dashboard-token"
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$TOK" > "$hdr_file"

boot_id="$(current_boot_id)"
if [ "$mode" = "apply" ] && [ -n "$boot_id" ] && [ -f "$STATE_FILE" ]; then
  last="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [ -n "$last" ] && [ "$last" = "$boot_id" ]; then
    echo "already sent for boot $boot_id -- nothing to do"
    exit 0
  fi
fi

KANBAN_JSON="$(curl -s --max-time 15 -H @"$hdr_file" "$DASH/api/kanban?status=in_progress&limit=500" 2>/dev/null)"
[ -n "$KANBAN_JSON" ] || die 1 "GET /api/kanban?status=in_progress failed (empty response)"
# CYBERSEC NO-GO 37713 LOW-4: the full kanban JSON (card descriptions included) used to travel as
# a python3 argv string -- visible to same-user processes via /proc/<pid>/cmdline, and capped at
# roughly 131072 bytes (E2BIG past ~57 in-flight cards at today's size). A temp file has neither
# limit and is not readable via /proc/<pid>/cmdline.
KANBAN_FILE="$(mktemp)"
trap 'rm -f "$hdr_file" "$KANBAN_FILE"' EXIT
printf '%s' "$KANBAN_JSON" > "$KANBAN_FILE"

BACKLOG_JSON="$(curl -s --max-time 15 -H @"$hdr_file" "$DASH/api/messages/backlog" 2>/dev/null)"
[ -n "$BACKLOG_JSON" ] || BACKLOG_JSON="[]"

STALE_OUT="$(bash "$STALE_CHECK_BIN" 2>/dev/null || true)"

# Confirm each STALE run's card is still status=waiting (the card may have moved on since the
# land run died -- a re-land, a manual close, etc. -- in which case it is stale JOURNAL info, not
# a live signal) and fetch its created_at for the oldest-first ordering below.
waiting_cards_for_stale() {
  python3 -c '
import json, sys
stale_lines = sys.argv[1]
dash = sys.argv[2]
hdr_file = sys.argv[3]
import subprocess

pairs = []  # (agent, card)
for line in stale_lines.splitlines():
    if not line.startswith("STALE "):
        continue
    fields = dict(p.split("=", 1) for p in line[len("STALE "):].split() if "=" in p)
    agent, card = fields.get("agent"), fields.get("card")
    if agent and card and card != "-":
        pairs.append((agent, card))

for agent, card in pairs:
    out = subprocess.run(
        ["curl", "-s", "--max-time", "10", "-H", f"@{hdr_file}", f"{dash}/api/kanban/{card}"],
        capture_output=True, text=True,
    ).stdout
    try:
        rec = json.loads(out)
    except Exception:
        continue
    if rec.get("status") == "waiting":
        created_at = rec.get("created_at", 0)
        print(f"{agent}\t{card}\t{created_at}")
' "$STALE_OUT" "$DASH" "$hdr_file"
}

PLAN="$(python3 -c '
import json, sys

with open(sys.argv[1]) as _f:
    kanban = json.load(_f)
backlog = json.loads(sys.argv[2])
stale_waiting_raw = sys.argv[3]  # agent\tcard\tcreated_at lines
gate_agents = sys.argv[4].split()

agent_cards = {}  # agent -> list of (card_id, created_at)
for c in kanban:
    a = c.get("assignee")
    if not a:
        continue
    agent_cards.setdefault(a, []).append((c.get("id"), c.get("created_at", 0)))

for line in stale_waiting_raw.splitlines():
    if not line.strip():
        continue
    agent, card, created_at = line.split("\t")
    try:
        created_at = int(created_at)
    except ValueError:
        created_at = 0
    existing = agent_cards.setdefault(agent, [])
    if not any(cid == card for cid, _ in existing):
        existing.append((card, created_at))

backlog_by_agent = {}
for row in backlog:
    a = row.get("agent")
    if a:
        backlog_by_agent[a] = row

for g in gate_agents:
    if g in backlog_by_agent and g not in agent_cards:
        agent_cards[g] = []

plan = []
for agent, cards in sorted(agent_cards.items()):
    cards_sorted = [cid for cid, _ in sorted(cards, key=lambda x: x[1])]
    b = backlog_by_agent.get(agent)
    # CYBERSEC NO-GO 37713 MEDIUM-1: GET /api/messages/backlog returns {agent, pending,
    # oldestAgeSeconds} (src/db.ts getPendingBacklogByAgent) -- "count"/"oldest_age_s" never
    # existed on the real endpoint, so every note silently said "Unread backlog: none" even with
    # real pending messages. Read the real keys first; keep the old names only as a fallback.
    backlog_count = b.get("pending", b.get("count", 0)) if b else 0
    backlog_age_s = b.get("oldestAgeSeconds", b.get("oldest_age_s", b.get("oldest_age", 0))) if b else 0
    plan.append({"agent": agent, "cards": cards_sorted, "backlog_count": backlog_count, "backlog_age_s": backlog_age_s})

print(json.dumps(plan))
' "$KANBAN_FILE" "$BACKLOG_JSON" "$(waiting_cards_for_stale)" "$GATE_AGENTS")"

[ -n "$PLAN" ] && [ "$PLAN" != "null" ] || die 1 "failed to build recovery plan (malformed kanban/backlog JSON)"

FIXED_TEXT="host restarted; check your worktree, git log and origin/develop before repeating any outward action (push, land, Telegram, comment)."

send_or_print() {
  python3 -c '
import json, sys, subprocess

plan = json.loads(sys.argv[1])
mode = sys.argv[2]
fixed_text = sys.argv[3]
dash = sys.argv[4]
hdr_file = sys.argv[5]

all_2xx = True
for entry in plan:
    agent = entry["agent"]
    cards = entry["cards"]
    backlog_count = entry["backlog_count"]
    cards_part = ", ".join(cards) if cards else "none"
    backlog_part = f"{backlog_count} message(s)" if backlog_count else "none"
    text = f"[RESTART-RECOVERY] {fixed_text} In-flight cards (oldest first): {cards_part}. Unread backlog: {backlog_part}."
    if mode == "dry-run":
        print(f"PLAN agent={agent} cards={cards_part} backlog={backlog_part}")
        continue
    payload = json.dumps({"from": "mikrob", "to": agent, "content": text})
    res = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
         "-H", f"@{hdr_file}", "-H", "Content-Type: application/json",
         "--data-binary", payload, f"{dash}/api/messages"],
        capture_output=True, text=True,
    )
    http_code = res.stdout.strip()
    if not http_code.startswith("2"):
        all_2xx = False
    print(f"SENT agent={agent} http={http_code} cards={cards_part} backlog={backlog_part}")

# CYBERSEC NO-GO 37713 LOW-1: in apply mode, the exit code tells the caller whether every send
# came back 2xx -- a failed send must not let the caller record the boot id (that would block the
# retry for the rest of this boot), matching the header comment "fails toward over-notifying, not
# under-notifying". dry-run never sends anything, so it always counts as fully successful.
sys.exit(0 if (mode == "dry-run" or all_2xx) else 1)
' "$PLAN" "$mode" "$FIXED_TEXT" "$DASH" "$hdr_file"
}

send_or_print
SEND_RC=$?

if [ "$mode" = "apply" ]; then
  if [ "$SEND_RC" -ne 0 ]; then
    echo "WARN: not every recovery note returned 2xx -- boot id NOT recorded, next --apply will retry" >&2
  elif [ -n "$boot_id" ]; then
    printf '%s' "$boot_id" > "$STATE_FILE"
  else
    echo "WARN: boot id unknown ($BOOT_ID_FILE unreadable) -- idempotency not recorded, next --apply will resend" >&2
  fi
fi

exit "$SEND_RC"
