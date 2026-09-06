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

# HERMETICITY FOR THE ATTRIBUTION INPUTS (card efd18ee4). Without these two, every case below would
# read the developer's live ollama and the real GPU lock, so the same selftest would give different
# verdicts on a machine with a model resident -- an environment-dependent test that looks like a
# deterministic one. Set once here rather than per call site: a case added later without the flag
# would be the silent regression. The attribution cases override them explicitly.
export VRAM_GUARD_OWN_VRAM_MIB=0
export VRAM_GUARD_LOCK_HELD=no

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


# ---- three-state attribution (card efd18ee4) ----------------------------------------------------
# THE PAIR THAT IS THE WHOLE CARD, at the numbers measured on this box on 2026-09-06: total 6144
# MiB, 1649 MiB resident with ollama stopped, the default local model's weights 4466 MiB. Same
# device reading, opposite verdicts, and the only thing that differs is WHO the memory belongs to.
#
# SUSTAINED on purpose. A single sample proves nothing here: the hysteresis admits the FIRST
# reading whatever the tier, so a one-shot assertion passes just as well on a guard with no
# attribution at all -- measured, that exact mutation survived the first version of this case.
# Held past sustained_seconds, the two designs finally disagree.
s="$(st own)"
bash "$GUARD" --config "$cfg" --state "$s" --now 1000 --lock-held no --own-vram-mib 4466 \
  --metrics-json '{"used_mib":6115,"total_mib":6144}' >/dev/null 2>&1
check "our own WARM model does not hold us out, even sustained (the defect this card is about)" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1031 --lock-held no --own-vram-mib 4466 \
    --metrics-json '{"used_mib":6115,"total_mib":6144}'
# CONTROL: the identical device reading with nothing of ours resident is a FOREIGN 99.5%, and must
# hold. Without this arm the case above would pass just as well on a guard that admits everything.
s="$(st fgn)"
check "the same reading with nothing of ours resident is foreign pressure (first sample)" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1000 --lock-held no --own-vram-mib 0 \
    --metrics-json '{"used_mib":6115,"total_mib":6144}'
check "...and holds once sustained" 1 "HOLD hard" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1031 --lock-held no --own-vram-mib 0 \
    --metrics-json '{"used_mib":6115,"total_mib":6144}'

# STATE 1: our own job holds the GPU lock. Admits even at a foreign-looking 99.5% with nothing
# attributable yet -- that is exactly the model-LOAD window /api/ps cannot see.
check "state 1: our own job holds the lock -> admit" 0 "ADMIT own-busy" \
  bash "$GUARD" --config "$cfg" --state "$(st l1)" --now 1000 --lock-held yes --own-vram-mib 0 \
    --metrics-json '{"used_mib":6115,"total_mib":6144}'

# ...and the reading is NOT fed to the hysteresis. Our own load must not teach the tier to distrust
# us: after two sustained own-busy samples the confirmed tier is still whatever it was.
s="$(st l2)"
bash "$GUARD" --config "$cfg" --state "$s" --now 1000 --lock-held yes --own-vram-mib 0 \
  --metrics-json '{"used_mib":6115,"total_mib":6144}' >/dev/null 2>&1
bash "$GUARD" --config "$cfg" --state "$s" --now 1100 --lock-held yes --own-vram-mib 0 \
  --metrics-json '{"used_mib":6115,"total_mib":6144}' >/dev/null 2>&1
check "state 1 does not poison the hysteresis with our own load" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 1200 --lock-held no --own-vram-mib 4466 \
    --metrics-json '{"used_mib":6115,"total_mib":6144}'

# STATE 2: lock free, nothing of ours resident, high pressure -> foreign, hold.
s="$(st s2)"
bash "$GUARD" --config "$cfg" --state "$s" --now 2000 --lock-held no --own-vram-mib 0 \
  --metrics-json '{"used_mib":5900,"total_mib":6144}' >/dev/null 2>&1
check "state 2: foreign load holds" 1 "HOLD hard" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 2031 --lock-held no --own-vram-mib 0 \
    --metrics-json '{"used_mib":5900,"total_mib":6144}'

# STATE 3: lock free, our model resident, low foreign pressure -> admit.
s="$(st s3)"
bash "$GUARD" --config "$cfg" --state "$s" --now 3000 --lock-held no --own-vram-mib 4466 \
  --metrics-json '{"used_mib":6000,"total_mib":6144}' >/dev/null 2>&1
check "state 3: our model resident and the rest quiet -> admit, sustained" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 3031 --lock-held no --own-vram-mib 4466 \
    --metrics-json '{"used_mib":6000,"total_mib":6144}'

# THE ROW THE CARD DOES NOT LIST, and it has to be decided somewhere: lock free, our model resident,
# and foreign pressure high ON TOP of it. Subtracting our share still leaves 5.8 GB of someone
# else's, so this holds. Deciding it by the same subtraction rather than by a fourth special case is
# why the mechanism is attribution and not a case table.
s="$(st s4)"
bash "$GUARD" --config "$cfg" --state "$s" --now 4000 --lock-held no --own-vram-mib 200 \
  --metrics-json '{"used_mib":6100,"total_mib":6144}' >/dev/null 2>&1
check "state 4 (unlisted): our model resident AND a foreign hog -> hold" 1 "HOLD hard" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 4031 --lock-held no --own-vram-mib 200 \
    --metrics-json '{"used_mib":6100,"total_mib":6144}'

# ACCOUNTING FAULT: ollama claiming more VRAM than the device reports. The two measurements
# disagree, so nothing is attributed to us and the whole reading stays foreign -- the direction that
# holds. Clamping foreign to zero instead would ADMIT on the input we understand least.
s="$(st bad)"
bash "$GUARD" --config "$cfg" --state "$s" --now 5000 --lock-held no --own-vram-mib 99999 \
  --metrics-json '{"used_mib":6100,"total_mib":6144}' >/dev/null 2>&1
check "own > used is an accounting fault, and it holds rather than admits" 1 "HOLD hard" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 5031 --lock-held no --own-vram-mib 99999 \
    --metrics-json '{"used_mib":6100,"total_mib":6144}'

# The verdict line has to CARRY the attribution, or card a1c4dc51 has nothing to surface and a
# human reading a HOLD cannot tell whose memory caused it.
check "the line names the attribution, not just the percentage" 0 "own=4466 foreign=1649" \
  bash "$GUARD" --config "$cfg" --state "$(st out)" --now 6000 --lock-held no --own-vram-mib 4466 \
    --metrics-json '{"used_mib":6115,"total_mib":6144}'


if [ "$failed" -eq 0 ]; then
  echo "selftest: $passed passed, 0 failed"
  exit 0
fi
echo "selftest: $passed passed, $failed failed"
exit 1