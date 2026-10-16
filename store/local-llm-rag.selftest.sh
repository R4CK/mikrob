#!/usr/bin/env bash
# Self-test for store/local-llm-rag.sh (card 613a8142, Cybersec F1 LOW on c375238d).
#
# THE BUG: TOKEN="$(cat "$TOKEN_FILE")" (local-llm-rag.sh) reassigns a variable named TOKEN. If a
# CALLER already exported a variable of that name, bash keeps the export attribute across the
# reassignment, so the REAL dashboard token ends up in the environ of every child process spawned
# afterward -- including the python3 retriever -- even though the script deliberately passes TOKEN
# over stdin instead (card c375238d). No documented fleet caller exports TOKEN today, but the gap
# is closed with `declare +x TOKEN`, which drops the export attribute without touching the value.
#
# HOW THIS IS PROVEN: a fake `python3` is put ahead of the real one on PATH. It dumps its own
# `env` to a capture file, then execs the REAL python3 (found before PATH is touched) so the script
# keeps working normally. The dashboard memory API is pointed at a closed port (127.0.0.1:1,
# connection refused) so retrieval fails fast and open (card rule 12) -- --show-context then prints
# the assembled prompt and exits 0 without ever calling the local model.
#
# Run:  bash store/local-llm-rag.selftest.sh
# Exit: 0 = all pass, 1 = at least one case wrong.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm-rag.sh"
REAL_PYTHON3="$(command -v python3)"
fail=0
n=0

t() { # $1 = label, $2 = got, $3 = want
  n=$((n + 1))
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1 -> got [$2] want [$3]"
    fail=1
  fi
}

echo "local-llm-rag.sh selftest"

REAL_TOKEN="REAL-DASHBOARD-TOKEN-xyz789"
STATE_DIR="$(mktemp -d)"
FAKEBIN="$(mktemp -d)"
CAPTURE="$(mktemp)"
trap 'rm -rf "$STATE_DIR" "$FAKEBIN" "$CAPTURE"' EXIT

printf '%s' "$REAL_TOKEN" >"$STATE_DIR/.dashboard-token"

cat >"$FAKEBIN/python3" <<EOF
#!/usr/bin/env bash
env >"$CAPTURE"
exec "$REAL_PYTHON3" "\$@"
EOF
chmod +x "$FAKEBIN/python3"

# An already-exported TOKEN in the CALLER's shell, the exact precondition the finding measured --
# the bash itself picks a DIFFERENT value from the real one so a leak of either is detectable.
OUT="$(
  export TOKEN="CALLER-EXPORTED-token"
  LOCAL_LLM_STATE_DIR="$STATE_DIR" DASHBOARD_URL="http://127.0.0.1:1" PATH="$FAKEBIN:$PATH" \
    bash "$SCRIPT" --no-route --show-context --agent selftest "a bounded task" 2>&1
)"
RC=$?

t "the script still completes (exit 0) with the stub python3 in place" "$RC" "0"
t "the real token is NOT in the python3 child's environ" \
  "$(grep -c "TOKEN=$REAL_TOKEN" "$CAPTURE" 2>/dev/null || true)" "0"
t "the caller's exported sentinel is ALSO not in the python3 child's environ (export attribute dropped, not forwarded another way)" \
  "$(grep -c '^TOKEN=' "$CAPTURE" 2>/dev/null || true)" "0"
t "the assembled prompt still reached stdout (retrieval degraded, not aborted -- rule 12 fail-open)" \
  "$(printf '%s' "$OUT" | grep -c 'a bounded task')" "1"

if [ "$fail" -eq 0 ]; then
  echo "local-llm-rag.sh selftest: all $n checks passed"
else
  echo "local-llm-rag.sh selftest: FAILURES among $n checks"
fi
exit "$fail"
