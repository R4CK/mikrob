#!/usr/bin/env bash
# Selftest for store/vram-guard-check.sh (card 108c7b10).
#
# A SEPARATE FILE on purpose, not a `selftest` MODE inside the script: the repo discovers and runs
# every `store/*.selftest.{sh,py}` by FILENAME suffix (store-selftests-all-run.test.ts), so a
# selftest carried as a mode is structurally invisible to the suite. Measured on this tree while
# doing card 09a3d52a: of the 15 store scripts carrying a `selftest` mode, ten were invoked by
# nothing at all. This one is wired the moment it lands.
#
# Fully hermetic: no GPU, no network. The metrics come through the --metrics-json seam, and the two
# cases that must exercise the real nvidia-smi invocation path use a stub binary instead.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/vram-guard-check.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

passed=0
failed=0

cfg="$tmpdir/config.json"
cat > "$cfg" <<'EOF'
{"soft_pct": 85, "hard_pct": 92, "sustained_seconds": 30}
EOF

# Runs the guard and checks BOTH the exit code and the printed line. Both, deliberately: a guard
# that prints HOLD while exiting 0 admits the dispatch, and a caller reads the exit code.
check() {
  local name="$1" want_exit="$2" want_substr="$3"; shift 3
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" != "$want_exit" ]; then
    echo "FAIL $name: expected exit $want_exit, got $rc (output: $out)"; failed=$((failed+1)); return
  fi
  case "$out" in
    *"$want_substr"*) passed=$((passed+1)) ;;
    *) echo "FAIL $name: expected output to contain '$want_substr', got: $out"; failed=$((failed+1)) ;;
  esac
}

st() { printf '%s/state-%s.json' "$tmpdir" "$1"; }

# ---- tiers ------------------------------------------------------------------------------------
check "below-soft admits" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$(st a)" --now 1000 \
    --metrics-json '{"used_mib":4000,"total_mib":10000}'

# ---- hysteresis -------------------------------------------------------------------------------
# One reading over the threshold must NOT flip the gate: the GPU frees or claims gigabytes in a
# single step, so a single sample is exactly the thing that lies here.
s="$(st b)"
check "first over-hard reading does NOT flip yet" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1000 \
    --metrics-json '{"used_mib":9500,"total_mib":10000}'
check "still not flipped before sustained_seconds elapses" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1029 \
    --metrics-json '{"used_mib":9500,"total_mib":10000}'
check "flips to HOLD once sustained" 1 "HOLD hard" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1030 \
    --metrics-json '{"used_mib":9500,"total_mib":10000}'
# Downward too, or a momentary dip during a model swap would re-admit into a full GPU.
check "one good reading does NOT immediately re-admit" 1 "HOLD hard" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1031 \
    --metrics-json '{"used_mib":1000,"total_mib":10000}'
check "re-admits once the recovery is sustained" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1061 \
    --metrics-json '{"used_mib":1000,"total_mib":10000}'

# The soft tier holds as well: both non-ok tiers mean "do not start new local work", the tier name
# is carried in the line so the dashboard signal (card a1c4dc51) can tell them apart.
s="$(st c)"
bash "$GUARD" --config "$cfg" --state "$s" --now 2000 --metrics-json '{"used_mib":8700,"total_mib":10000}' >/dev/null 2>&1
check "soft tier holds too" 1 "HOLD soft" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 2030 \
    --metrics-json '{"used_mib":8700,"total_mib":10000}'

# ---- the two fail-safe branches ---------------------------------------------------------------
# (a) tool absent => there may be no GPU at all; holding would disable the local LLM forever.
check "nvidia-smi ABSENT admits" 0 "ADMIT no-gpu" \
  bash "$GUARD" --config "$cfg" --state "$(st d)" --now 3000 \
    --metrics-json '{"error":"nvidia-smi not found","present":false}'

# (b) tool present but unreadable => a GPU exists and we cannot see it. THIS IS THE DELIBERATE
# DEVIATION from the card's single "hianyzik/hibazik -> ADMIT" rule; see the guard's header.
check "nvidia-smi PRESENT but failing HOLDS" 1 "HOLD unreadable" \
  bash "$GUARD" --config "$cfg" --state "$(st e)" --now 3000 \
    --metrics-json '{"error":"nvidia-smi failed or timed out: boom","present":true}'

# ...and the card's literal rule is exactly one env var away, so the deviation is reversible
# without an edit if MikroB wants it the other way.
check "VRAM_GUARD_UNREADABLE=admit restores the card's literal rule" 0 "ADMIT unreadable" \
  env VRAM_GUARD_UNREADABLE=admit bash "$GUARD" --config "$cfg" --state "$(st f)" --now 3000 \
    --metrics-json '{"error":"boom","present":true}'

# ---- the real invocation path, via a stub binary -----------------------------------------------
# These do not use --metrics-json: they exercise read_vram_metrics and its parser, which the seam
# above bypasses entirely. Without them the parser would be written and never run.
stub="$tmpdir/nvidia-smi-two-gpus"
cat > "$stub" <<'EOF'
#!/usr/bin/env bash
echo "5000, 6000"
echo "1000, 6000"
EOF
chmod +x "$stub"
# Summed: 6000/12000 = 50% -> admit. Summing matters: taken per-card, the second GPU alone reads
# 17% and would admit a model that actually loads onto the first one.
check "multi-GPU rows are SUMMED, not taken one at a time" 0 "6000/12000 MiB (50.0%)" \
  env VRAM_GUARD_NVIDIA_SMI="$stub" bash "$GUARD" --config "$cfg" --state "$(st g)" --now 4000

stub_bad="$tmpdir/nvidia-smi-garbage"
cat > "$stub_bad" <<'EOF'
#!/usr/bin/env bash
echo "not a csv row at all"
EOF
chmod +x "$stub_bad"
check "unparseable output is treated as PRESENT-but-unreadable, so it holds" 1 "HOLD unreadable" \
  env VRAM_GUARD_NVIDIA_SMI="$stub_bad" bash "$GUARD" --config "$cfg" --state "$(st h)" --now 4000

stub_fail="$tmpdir/nvidia-smi-failing"
cat > "$stub_fail" <<'EOF'
#!/usr/bin/env bash
echo "Failed to initialize NVML: Driver/library version mismatch" >&2
exit 9
EOF
chmod +x "$stub_fail"
check "a non-zero nvidia-smi holds and quotes the driver's own words" 1 "NVML" \
  env VRAM_GUARD_NVIDIA_SMI="$stub_fail" bash "$GUARD" --config "$cfg" --state "$(st i)" --now 4000

stub_empty="$tmpdir/nvidia-smi-empty"
cat > "$stub_empty" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$stub_empty"
# An empty answer from a PRESENT tool is doubt, not absence -- and a zero total would otherwise be
# a division by zero rather than a decision.
check "an empty answer from a present tool holds" 1 "HOLD unreadable" \
  env VRAM_GUARD_NVIDIA_SMI="$stub_empty" bash "$GUARD" --config "$cfg" --state "$(st j)" --now 4000

stub_hang="$tmpdir/nvidia-smi-hanging"
cat > "$stub_hang" <<'EOF'
#!/usr/bin/env bash
sleep 30
EOF
chmod +x "$stub_hang"
# A hung nvidia-smi in a dispatch path must not wedge the caller: `timeout` turns it into the
# unreadable branch. One second, so the selftest itself stays fast.
check "a HANGING nvidia-smi is bounded and holds" 1 "HOLD unreadable" \
  env VRAM_GUARD_NVIDIA_SMI="$stub_hang" VRAM_GUARD_SMI_TIMEOUT=1 \
    bash "$GUARD" --config "$cfg" --state "$(st k)" --now 4000
# The verdict above is the same one an UNBOUNDED run eventually reaches (the stub exits 0 with no
# output after its sleep), so the verdict alone cannot tell whether the bound exists. Time it.
hang_start=$(date +%s)
env VRAM_GUARD_NVIDIA_SMI="$stub_hang" VRAM_GUARD_SMI_TIMEOUT=1 \
  bash "$GUARD" --config "$cfg" --state "$(st k2)" --now 4000 >/dev/null 2>&1
hang_elapsed=$(( $(date +%s) - hang_start ))
if [ "$hang_elapsed" -le 5 ]; then
  passed=$((passed+1))
else
  echo "FAIL hang-bound: the guard waited ${hang_elapsed}s on a hanging nvidia-smi; the timeout is not in force"
  failed=$((failed+1))
fi

# ---- config robustness ------------------------------------------------------------------------
# A missing config must not decide the outcome by accident; it falls back to the documented
# defaults (85/92/30), so this reading is still hard.
s="$(st l)"
bash "$GUARD" --config "$tmpdir/does-not-exist.json" --state "$s" --now 5000 --metrics-json '{"used_mib":9500,"total_mib":10000}' >/dev/null 2>&1
check "a missing config falls back to the documented defaults" 1 "HOLD hard" \
  bash "$GUARD" --config "$tmpdir/does-not-exist.json" --state "$s" --now 5030 \
    --metrics-json '{"used_mib":9500,"total_mib":10000}'

check "an unknown argument is refused loudly, not ignored" 2 "unknown arg" \
  bash "$GUARD" --nonsense

if [ "$failed" -eq 0 ]; then
  echo "selftest: $passed passed, 0 failed"
  exit 0
fi
echo "selftest: $passed passed, $failed failed"
exit 1
