#!/usr/bin/env bash
# Reads current system load and prints one-line JSON: {psi_some_avg10, psi_full_avg10, loadavg1, loadavg5, nproc, source}
# Prefers /proc/pressure/cpu (PSI, "some" line avg10); falls back to loadavg1/nproc when PSI is unavailable.
set -euo pipefail

NPROC=$(nproc)
read -r LOAD1 LOAD5 _ < /proc/loadavg

SOURCE="loadavg"
PSI_SOME=""
PSI_FULL=""

if [ -r /proc/pressure/cpu ]; then
  SOME_LINE=$(grep '^some' /proc/pressure/cpu || true)
  FULL_LINE=$(grep '^full' /proc/pressure/cpu || true)
  if [ -n "$SOME_LINE" ]; then
    PSI_SOME=$(grep -oP 'avg10=\K[0-9.]+' <<<"$SOME_LINE" || true)
    PSI_FULL=$(grep -oP 'avg10=\K[0-9.]+' <<<"$FULL_LINE" || true)
    if [ -n "$PSI_SOME" ]; then
      SOURCE="psi"
    fi
  fi
fi

if [ "$SOURCE" = "psi" ]; then
  PSI_SOME_JSON="$PSI_SOME"
  PSI_FULL_JSON="${PSI_FULL:-null}"
else
  PSI_SOME_JSON="null"
  PSI_FULL_JSON="null"
fi

printf '{"psi_some_avg10":%s,"psi_full_avg10":%s,"loadavg1":%s,"loadavg5":%s,"nproc":%s,"source":"%s"}\n' \
  "$PSI_SOME_JSON" "$PSI_FULL_JSON" "$LOAD1" "$LOAD5" "$NPROC" "$SOURCE"
