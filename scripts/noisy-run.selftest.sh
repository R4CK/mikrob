#!/usr/bin/env bash
# Self-test for scripts/noisy-run.sh's small-output skip and git log/diff --stat partial-keep
# (card fc3a6a39, items 3-4).
#
# Run: bash scripts/noisy-run.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# HERMETIC: all fixtures write to a mktemp -d; nothing in the real repo is touched. NOISY_RUN_LOG_DIR
# is pointed at a throwaway dir too, so this never writes to /tmp/claude-noisy-logs.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/noisy-run.sh"

pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export NOISY_RUN_LOG_DIR="$TMP/logs"

# --- small-output skip ------------------------------------------------------------------------
# A command whose output is small must come back BYTE-FOR-BYTE identical to running it raw --
# the header ("=== noisy-run ===" / "exit=" / "-- final N lines --") must not appear at all.
SMALL_SCRIPT='printf "line one\nline two\nline three\n"'
direct="$(bash -c "$SMALL_SCRIPT")"
wrapped="$(bash "$RUN" bash -c "$SMALL_SCRIPT")"
if [ "$direct" = "$wrapped" ]; then
  ok "small output passes through byte-for-byte (no header)"
else
  bad "small output was wrapped" "direct=${direct@Q} wrapped=${wrapped@Q}"
fi

# --- large output still gets the header + filtering (small-output skip must not swallow everything)
LARGE_SCRIPT='for i in $(seq 1 200); do echo "filler line $i"; done; echo "ERROR: boom"'
wrapped_large="$(bash "$RUN" bash -c "$LARGE_SCRIPT")"
if printf '%s' "$wrapped_large" | grep -q '^=== noisy-run:'; then
  ok "large output still gets the noisy-run header (small-output skip did not over-fire)"
else
  bad "large output was NOT wrapped -- small-output skip over-fired" "$wrapped_large"
fi
if printf '%s' "$wrapped_large" | grep -q 'ERROR: boom'; then
  ok "large output's error line survives filtering"
else
  bad "large output's error line was dropped"
fi

# --- git log/diff --stat partial-keep ---------------------------------------------------------
REPO="$TMP/repo"
mkdir -p "$REPO"
git init -q "$REPO"
git -C "$REPO" -c user.email=t@t -c user.name=t checkout -q -b main 2>/dev/null || true
echo "content 0" > "$REPO/file0.txt"
git -C "$REPO" add "file0.txt"
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m "OLDEST-SENTINEL-COMMIT"
for i in $(seq 1 15); do
  echo "content $i" > "$REPO/file$i.txt"
  git -C "$REPO" add "file$i.txt"
  git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m "filler commit $i"
done
echo "content 99" > "$REPO/file99.txt"
git -C "$REPO" add "file99.txt"
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m "NEWEST-SENTINEL-COMMIT"

wrapped_stat="$(bash "$RUN" git -C "$REPO" log --stat)"
newest_commit_msg="NEWEST-SENTINEL-COMMIT"
oldest_commit_msg="OLDEST-SENTINEL-COMMIT"
if printf '%s' "$wrapped_stat" | grep -q "$newest_commit_msg"; then
  ok "git log --stat partial-keep shows the newest commit"
else
  bad "git log --stat partial-keep DROPPED the newest commit" "$wrapped_stat"
fi
if printf '%s' "$wrapped_stat" | grep -q "$oldest_commit_msg"; then
  bad "git log --stat partial-keep unexpectedly includes the oldest commit (head-keep should have capped before reaching it)"
else
  ok "git log --stat partial-keep correctly caps before the oldest commit (proves head-keep, not a lucky full dump)"
fi

# --- MUTATION: a plain (non-stat) git log must NOT take the stat partial-keep branch ----------
wrapped_plain_log="$(bash "$RUN" git -C "$REPO" log --oneline)"
if printf '%s' "$wrapped_plain_log" | grep -q 'first 60 lines'; then
  bad "plain 'git log --oneline' (no --stat) incorrectly took the stat partial-keep branch"
else
  ok "plain 'git log --oneline' (no --stat) does not take the stat partial-keep branch"
fi

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
