#!/usr/bin/env bash
# Self-test for post-review.sh (card 88b67fb4). No live dashboard: a fake `curl` is prepended to
# PATH that answers from fixed JSON instead of hitting the network, so this runs anywhere.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/post-review.sh"
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A fake curl: decides its answer from the argv it was called with. Logs every call so tests can
# assert "move was never attempted" etc.
cat >"$WORK/curl" <<'STUB'
#!/usr/bin/env bash
echo "CALL: $*" >>"$WORK_LOG"
is_post=0
url=""
for a in "$@"; do
  case "$a" in
    POST) is_post=1 ;;
    http*) url="$a" ;;
  esac
done
case "$url" in
  */comments)
    if [ "$is_post" -eq 1 ]; then
      # find the --data-binary payload
      data=""; prev=""
      for a in "$@"; do [ "$prev" = "--data-binary" ] && data="$a"; prev="$a"; done
      python3 -c '
import json, sys
d = json.loads(sys.argv[1])
d["id"] = 1
print(json.dumps(d))' "$data" | tee "$WORK/posted.json"
    else
      if [ -f "$WORK/posted.json" ] && [ "${MATCH_MODE:-match}" = "match" ]; then
        echo "[$(cat "$WORK/posted.json")]"
      else
        echo "[]"
      fi
    fi
    ;;
  */move)
    echo '{"ok":true}'
    ;;
  *)
    echo '{}'
    ;;
esac
STUB
chmod +x "$WORK/curl"

run() { # $1 label, remaining = args to post-review.sh, env already exported by caller
  WORK_LOG="$WORK/calls.log"; : >"$WORK_LOG"
  export WORK WORK_LOG MATCH_MODE
  PATH="$WORK:$PATH" bash "$SCRIPT" "$@"
}

n=0
t_ok()  { n=$((n+1)); if [ "$1" -eq "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 -> expected exit $2, got $1"; fail=1; fi; }

# 1. Blank file refuses BEFORE touching the board at all (no curl call logged).
echo "" >"$WORK/blank.txt"
: >"$WORK/calls.log"
MATCH_MODE=match
rc=0; run "cardX" "$WORK/blank.txt" "backend" >"$WORK/out1.txt" 2>&1 || rc=$?
t_ok "$rc" 1 "blank review file refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL blank file still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   blank file never touched the board"; fi

# 2. Good content, readback matches -> moves to waiting, exit 0.
echo "REVIEW: all good, Gate-SHA: deadbeef" >"$WORK/good.txt"
MATCH_MODE=match
rc=0; run "card1" "$WORK/good.txt" "backend" "gate ready" >"$WORK/out2.txt" 2>&1 || rc=$?
t_ok "$rc" 0 "matching readback moves the card to waiting"
grep -q "/move" "$WORK/calls.log" || { echo "  FAIL move was never attempted on the success path"; fail=1; }

# 3. Readback does NOT match what was posted (simulated garbled/empty body on the board's side) ->
#    refuses, exit 2, and move must NEVER be attempted.
echo "REVIEW: all good" >"$WORK/good2.txt"
MATCH_MODE=mismatch
rc=0; run "card2" "$WORK/good2.txt" "backend" >"$WORK/out3.txt" 2>&1 || rc=$?
t_ok "$rc" 2 "mismatched readback refuses with exit 2"
grep -q "/move" "$WORK/calls.log" && { echo "  FAIL move was attempted despite a mismatched readback"; fail=1; } || echo "  ok   move was never attempted after a mismatch"

# 4. L1 delta: invisible-only / too-short bodies refuse before touching the board, same as a
#    fully blank file -- a visually-empty REVIEW should not sail through just because it has a
#    stray byte in it.
printf '\xe2\x80\x8b\xe2\x80\x8b\xe2\x80\x8b' >"$WORK/invisible.txt"   # three U+200B zero-width spaces
: >"$WORK/calls.log"
rc=0; run "card3" "$WORK/invisible.txt" "backend" >"$WORK/out4.txt" 2>&1 || rc=$?
t_ok "$rc" 1 "invisible-only (U+200B) body refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL invisible-only file still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   invisible-only file never touched the board"; fi

printf 'x' >"$WORK/onechar.txt"
: >"$WORK/calls.log"
rc=0; run "card4" "$WORK/onechar.txt" "backend" >"$WORK/out5.txt" 2>&1 || rc=$?
t_ok "$rc" 1 "1-character body refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL 1-char file still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   1-char file never touched the board"; fi

echo "post-review.sh selftest: $n checks"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"
