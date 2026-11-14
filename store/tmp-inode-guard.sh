#!/usr/bin/env bash
# tmp-inode-guard.sh -- keep the /tmp tmpfs from running out of inodes.
#
# Why: on 2026-11-14 ~16:20 the /tmp tmpfs (1M inodes) hit 100% IUse because a
# selftest leaked its mktemp dir on every run (175 dirs, ~4,000 files each). Every
# agent Bash call then failed with ENOSPC. Peti asked for a cron job (Telegram 13803).
#
# What it does (cron, every 5 min, per the live crontab line):
#   - removes $TMP_GUARD_ROOT/tmp.* directories owned by this user in which NOTHING
#     changed for MAX_AGE_MIN minutes (default 120). A dir with any file touched
#     inside the window is kept, so a long test that is still writing is not pulled
#     out from under it.
#   - logs one line per run with the inode use before/after.
#   - prints ALERT and notifies MikroB (via sched-wake-mikrob.sh, best-effort) when
#     inode use is still >= ALERT_PCT after the sweep (card b1813ab2).
# It never touches anything outside $TMP_GUARD_ROOT/tmp.*, nor dirs owned by another user.
#
# TMP_GUARD_ROOT defaults to /tmp; the selftest overrides it to a sandbox so it never
# mutates the real /tmp (which other agents' live processes are using concurrently).
#
# Cybersec LOW-3 (31235), re-dispatched after CYBERSEC NO-GO 31244: a non-numeric or <=0 age
# env makes `find -mmin` fail silently (stderr discarded), which this script used to read as
# "nothing fresh" and delete FRESH dirs. _valid_min rejects anything that is not a positive
# integer and falls back to the built-in default instead; a bad TMP_GUARD_ALERT_PCT falls back
# the same way. A `find` failure for any OTHER reason (permissions, odd filesystem) also fails
# CLOSED below: the dir is kept, never deleted, when find's exit code is non-zero.
# NO-GO 31244: the first version only rejected the literal string "0", not "00"/"000" -- both
# are all-digit and non-empty, so they fell through every branch as "accepted" even though they
# are numerically zero (`find -mmin -00` matches nothing, same fail-open as a bare "0"). The
# `*[1-9]*` branch below requires at least one nonzero digit, so any all-zeros spelling is
# rejected while a legitimately zero-padded positive value (e.g. "007") still passes.
set -u
_valid_min() {
  case "$1" in ''|*[!0-9]*|0) return 1 ;; esac
  case "$1" in *[1-9]*) ;; *) return 1 ;; esac
}

ROOT="${TMP_GUARD_ROOT:-/tmp}"
MAX_AGE_MIN="${TMP_GUARD_MAX_AGE_MIN:-120}"
_valid_min "$MAX_AGE_MIN" || MAX_AGE_MIN=120
LEAK_AGE_MIN="${TMP_GUARD_LEAK_AGE_MIN:-10}"
_valid_min "$LEAK_AGE_MIN" || LEAK_AGE_MIN=10
ALERT_PCT="${TMP_GUARD_ALERT_PCT:-80}"
case "$ALERT_PCT" in ''|*[!0-9]*) ALERT_PCT=80 ;; esac
ME="$(id -u)"
S="$(cd "$(dirname "$0")" && pwd)"

ipct() { df -i "$ROOT" | awk 'NR==2{gsub("%","",$5); print $5}'; }

before="$(ipct)"
removed=0
kept=0
for d in "$ROOT"/tmp.*; do
  [ -d "$d" ] || continue
  [ "$(stat -c %u "$d" 2>/dev/null)" = "$ME" ] || continue
  # marveen-land.sh --selftest-land-batch leaks a ~4,000-file dir per run (caseA..caseQ);
  # those go after LEAK_AGE_MIN (default 10) untouched minutes, not the general window.
  win="$MAX_AGE_MIN"
  [ -e "$d/caseA" ] && win="$LEAK_AGE_MIN"
  # keep if the dir itself or anything inside changed within the window, OR if find itself
  # errored (fail-closed: an unreadable entry must not be read as "nothing is fresh").
  fresh="$(find "$d" -mmin "-$win" -print -quit 2>/dev/null)"
  find_rc=$?
  if [ "$find_rc" -ne 0 ] || [ -n "$fresh" ]; then
    kept=$((kept + 1))
    continue
  fi
  rm -rf -- "$d" && removed=$((removed + 1))
done
after="$(ipct)"
echo "$(date '+%F %T') tmp-inode-guard: removed=$removed kept=$kept inodes ${before}% -> ${after}%"
if [ "${after:-0}" -ge "$ALERT_PCT" ]; then
  echo "$(date '+%F %T') ALERT: /tmp inode use still ${after}% after sweep"
  if [ -z "${TMP_GUARD_ALERT_DRYRUN:-}" ] && [ -x "$S/sched-wake-mikrob.sh" ]; then
    "$S/sched-wake-mikrob.sh" tmp-inode-guard \
      "/tmp inode use still ${after}% after the sweep (removed=$removed kept=$kept)." \
      >/dev/null 2>&1 || true
  fi
fi
