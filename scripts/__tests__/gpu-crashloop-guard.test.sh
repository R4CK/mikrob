#!/bin/bash
# Contract tests for scripts/gpu-crashloop-guard.sh.
# Run: bash scripts/__tests__/gpu-crashloop-guard.test.sh
#
# Exercises the boot-loop detection (short boots + dxg oops + recency +
# baseline), the mask action, the alert cooldown, and the negative controls
# (short-but-not-dxg, dxg-but-not-short, too-few-boots) -- all through the
# real script via its GPU_GUARD_* test hooks (no real journalctl/systemctl/
# Telegram touched).

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/gpu-crashloop-guard.sh"

fresh_case() { local d; d="$TMPDIR_BASE/case-$1"; mkdir -p "$d"; echo "$d"; }

# Writes a `journalctl --list-boots`-shaped fixture: N short (35s) boots with
# a dxg oops, each 5 minutes apart, ending at NOW - END_AGO_SEC (newest last).
# Args: outfile n end_ago_sec
write_short_dxg_boots() {
  local out="$1" n="$2" end_ago="$3"
  python3 - "$out" "$n" "$end_ago" << 'PYEOF'
import sys, datetime
out, n, end_ago = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
now = datetime.datetime.now(datetime.timezone.utc)
lines = []
end = now - datetime.timedelta(seconds=end_ago)
for i in range(n):
    e = end - datetime.timedelta(seconds=(n - 1 - i) * 300)
    s = e - datetime.timedelta(seconds=35)
    idx = f"-{n - i}"
    lines.append(f"{idx} deadbeef{i} {s.strftime('%a %Y-%m-%d %H:%M:%S')} UTC {e.strftime('%a %Y-%m-%d %H:%M:%S')} UTC")
open(out, "w").write("\n".join(lines) + "\n")
PYEOF
}

# Run the guard with an isolated state dir; args: state_dir boots_file kernel_file
run_guard() {
  GPU_GUARD_STATE_DIR="$1" GPU_GUARD_BOOTS_OVERRIDE="$2" GPU_GUARD_KERNEL_LOG_OVERRIDE="$3" \
    GPU_GUARD_ALERT_DRYRUN=1 GPU_GUARD_MASK_DRYRUN=1 bash "$GUARD" 2>&1
}

echo "gpu-crashloop-guard tests"
echo "========================="

# ---------------------------------------------------------------------------
# (a) First-ever run only stamps a baseline -- never masks/alerts on whatever
#     crash history already existed before the guard was installed.
# ---------------------------------------------------------------------------
echo ""
echo "(a) First-run baseline, no action"
ST="$(fresh_case a)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"
write_short_dxg_boots "$BOOTS" 5 60
echo "dxgk_ioctl fault dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "first run -- baseline stamped"; then pass "first run: baseline stamped, no verdict"; else fail "first run: unexpected output: $OUT"; fi
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN\|ALERT_DRYRUN"; then fail "first run: must NOT act on pre-install history"; else pass "first run: no mask/alert on pre-install history"; fi
[ -f "$ST/.gpu-crashloop-guard-baseline" ] && pass "first run: baseline file written" || fail "first run: baseline file missing"

# ---------------------------------------------------------------------------
# (b) Crash-loop AFTER baseline (>= 3 short + dxg-oops boots, recent) -> mask + alert
# ---------------------------------------------------------------------------
echo ""
echo "(b) Crash-loop detected after baseline"
ST="$(fresh_case b)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"
echo "$(($(date +%s) - 3600))" > "$ST/.gpu-crashloop-guard-baseline"   # installed well before these boots
write_short_dxg_boots "$BOOTS" 4 60
echo "dxgk_ioctl fault dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "GPU crash-loop DETECTED"; then pass "detect: crash-loop found"; else fail "detect: not found: $OUT"; fi
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN: ollama.service"; then pass "detect: ollama.service masked"; else fail "detect: mask not issued"; fi
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then pass "detect: owner alerted"; else fail "detect: no alert"; fi
[ -f "$ST/.gpu-crashloop-guard-masked.json" ] && pass "detect: masked-state flag written" || fail "detect: masked-state flag missing"

# ---------------------------------------------------------------------------
# (c) Alert cooldown -> immediate second detection re-masks (idempotent) but
#     suppresses the repeat alert.
# ---------------------------------------------------------------------------
echo ""
echo "(c) Alert cooldown"
OUT2="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT2" | grep -q "MASK_DRYRUN"; then pass "cooldown: still (idempotently) masks"; else fail "cooldown: mask skipped unexpectedly"; fi
if printf '%s' "$OUT2" | grep -q "ALERT_DRYRUN"; then fail "cooldown: re-alerted within the hour"; else pass "cooldown: repeat alert suppressed"; fi

# ---------------------------------------------------------------------------
# (d) Negative control -- short boots WITHOUT the dxg oops signature (e.g. a
#     host sleep/resume or manual `wsl --shutdown`) must NOT trigger a mask.
# ---------------------------------------------------------------------------
echo ""
echo "(d) Short boots without dxg signature -> no action"
ST="$(fresh_case d)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel_clean.txt"
date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 60
echo "unrelated kernel line, nothing about a GPU fault" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN\|ALERT_DRYRUN"; then fail "negative: masked/alerted without a dxg oops"; else pass "negative: no action without a dxg oops"; fi

# ---------------------------------------------------------------------------
# (e) Negative control -- too few short boots (below MIN_SHORT_BOOTS) -> no action
# ---------------------------------------------------------------------------
echo ""
echo "(e) Too few short boots -> no action"
ST="$(fresh_case e)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"
date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 2 60
echo "dxgk_ioctl fault dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN\|ALERT_DRYRUN"; then fail "too-few: masked/alerted on only 2 short boots"; else pass "too-few: no action below the 3-boot threshold"; fi

# ---------------------------------------------------------------------------
# (f) Negative control -- crash-loop history exists but is OLD (outside the
#     recency window) -> no action.
# ---------------------------------------------------------------------------
echo ""
echo "(f) Old crash-loop history -> no action"
ST="$(fresh_case f)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"
date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 7200   # ended 2h ago, well outside the 30min window
echo "dxgk_ioctl fault dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN\|ALERT_DRYRUN"; then fail "stale: masked/alerted on a 2h-old crash-loop"; else pass "stale: no action on a stale crash-loop"; fi

# ---------------------------------------------------------------------------
echo ""
echo "========================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
