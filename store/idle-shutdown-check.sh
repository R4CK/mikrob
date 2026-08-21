#!/usr/bin/env bash
# Peti 2026-08-21: on explicit request, MikroB hardware-shuts-down the host
# once tonight's active fleet work is finished. This script is the idle
# oracle a reconciliation heartbeat checks before pulling the trigger.
#
# IDLE  = no in_progress card, and no waiting card touched in the last
#         60 minutes that isn't on the long-standing known-blocked list.
# BUSY:<reason> = otherwise.
#
# Known long-blocked cards (pre-existing, not part of "tonight's work",
# excluded from the freshness check): c0b1f7c4 2cb07372 6c118f45 5c6fe8df
# d10e3e70 d5d5781a
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN=$(cat store/.dashboard-token)
BLOCKED_IDS="c0b1f7c4 2cb07372 6c118f45 5c6fe8df d10e3e70 d5d5781a"

printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- -s http://localhost:3420/api/kanban | python3 -c "
import json, sys, time

blocked = set('''$BLOCKED_IDS'''.split())
cards = json.load(sys.stdin)
now = time.time()

in_progress = [c for c in cards if c.get('status') == 'in_progress']
if in_progress:
    ids = ', '.join(c['id'] for c in in_progress)
    print(f'BUSY:in_progress:{ids}')
    sys.exit(0)

fresh_waiting = [
    c for c in cards
    if c.get('status') == 'waiting'
    and c['id'] not in blocked
    and (now - c.get('updated_at', now)) < 3600
]
if fresh_waiting:
    ids = ', '.join(c['id'] for c in fresh_waiting)
    print(f'BUSY:fresh_waiting:{ids}')
    sys.exit(0)

print('IDLE')
"
