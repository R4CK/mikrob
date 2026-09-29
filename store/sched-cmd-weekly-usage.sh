#!/usr/bin/env bash
# Command-type runner for `weekly-usage-panel-read` (card 53fffd74). The routine run (reader OK,
# thresholds UNCHANGED, no paused-for-hardstop file) stays silent at zero tokens; a FAIL (Telegram
# relogin flow), a pending hard-stop resume, or a threshold change is sent to MikroB with the
# measured lines, and the task prompt says what to do with each.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
read_out="$(bash "$S/weekly-usage-panel-read.sh" 2>&1 | tail -3)"
watch_out="$(bash "$S/weekly-threshold-watch.sh" 2>&1 | tail -1)"
paused=0; [ -f "$S/scheduler-paused-for-hardstop.json" ] && paused=1
if printf '%s\n' "$read_out" | grep -q '^OK:' && [ "$watch_out" = "UNCHANGED" ] && [ "$paused" = 0 ]; then
  exit 0
fi
bash "$S/sched-wake-mikrob.sh" weekly-usage-panel-read "A mereslepesek MAR lefutottak, ne futtasd oket ujra, ezekre a sorokra cselekedj a feladat SKILL.md szerint (FAIL -> relogin; paused=1 es hard-stop inactive -> auto-resume; CHANGED -> Telegram).
reader: $read_out
threshold-watch: $watch_out
paused-for-hardstop-file: $paused"
