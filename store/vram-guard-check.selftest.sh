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
# This stub answers BOTH query-gpu shapes (card 79aeaeb1's REAL_RUN also probes utilization on
# every real invocation, unconditionally) -- without the branch, this test's own utilization read
# would receive the same two CSV rows and fail to parse as a float, forcing an unrelated HOLD.
case "$*" in
  *"utilization.gpu"*) printf '10\n10\n10\n' ;;
  *) echo "5000, 6000"; echo "1000, 6000" ;;
esac
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


# ---- atomic state persistence under concurrency (card eaef963d, Cybersec's measurement) --------
# A confirmed HOLD must survive concurrent callers. RED without the fix: `open(state_path, "w")`
# truncates in place, so a concurrent reader can observe a half-written file mid-write,
# JSONDecodeError, default to "ok" -- and then WRITE "ok" back as a legitimate observation,
# erasing the confirmed tier for every future reader, not just the one that raced. Measured: 40
# concurrent calls against a confirmed tier=hard state lost the HOLD in 10/12 rounds; a plain
# flock around the SAME truncating write did not fix it (0/12 fixed -- the wrong half of the
# 09a3d52a pattern, a genuine cross-process lock problem there, a torn-write problem here). An
# atomic temp-file + os.replace() fixed it with NO lock at all (0/12 corrupted): a reader either
# sees the old complete file or the new complete one, never a partial one.
# MULTIPLE ROUNDS, deliberately: the pre-fix race is PROBABILISTIC (measured 10/12 rounds at 40
# concurrent, not 12/12), so any single round has a real chance of passing by luck even on the
# unfixed code -- confirmed here (5 rounds of 40 against a reverted copy: ok/hard/hard/ok/hard).
# The atomic fix, by contrast, is not probabilistic: a rename is observed whole or not at all, so
# every round must land on "hard" with no exceptions. One bad round is a real regression, not noise.
atomic_rounds_failed=0
for round in 1 2 3 4 5 6; do
  s="$(st "atomic-$round")"
  cat > "$s" <<'EOF'
{"tier": "hard", "since": 1000, "pending": null}
EOF
  pids=()
  for i in $(seq 1 40); do
    bash "$GUARD" --config "$cfg" --state "$s" --now 1000 \
      --metrics-json '{"used_mib":9500,"total_mib":10000}' >/dev/null 2>&1 &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  final_tier="$(python3 -c "import json; print(json.load(open('$s')).get('tier', 'MISSING'))" 2>/dev/null || echo UNREADABLE)"
  if [ "$final_tier" != "hard" ]; then
    echo "FAIL atomic-write-under-concurrency round $round: expected the confirmed tier to survive 40 concurrent writers as 'hard', got '$final_tier'"
    atomic_rounds_failed=$((atomic_rounds_failed+1))
  fi
done
if [ "$atomic_rounds_failed" -eq 0 ]; then
  passed=$((passed+1))
else
  failed=$((failed+1))
fi

# ---- persist-failure verdict comes from the INSTANTANEOUS level (card eaef963d) ----------------
# The comment this replaces claimed an unwritable state file "degrades to instantaneous readings",
# but the code fell through to the HYSTERESIS-only `current` -- which, without a working state file
# to accumulate `pending` across calls, can never advance past its starting tier. Measured: five
# calls over 140 simulated seconds at a sustained 96% never held once; the guard silently became a
# permanent ADMIT. The fix reads the verdict from `instantaneous` on this branch specifically.
#
# A state path inside a directory that does not exist makes the atomic replace's own mkstemp()
# fail (FileNotFoundError, a subclass of OSError) -- the "path cannot be created" half of the
# finding, distinct from "file exists but is not writable".
check "persist-failure at 96% HOLDs from the instantaneous level (the defect: it used to ADMIT forever)" 1 "HOLD hard" \
  bash "$GUARD" --config "$cfg" --state "$tmpdir/no-such-dir/state.json" --now 6000 \
    --metrics-json '{"used_mib":9600,"total_mib":10000}'
# CONTROL: without this, a "just always print HOLD on persist failure" non-fix would pass the case
# above too. The instantaneous level must actually be READ, not assumed.
check "CONTROL: persist-failure at 16% still ADMITs -- not a stuck-always-HOLD stub" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$tmpdir/no-such-dir-2/state.json" --now 6000 \
    --metrics-json '{"used_mib":1630,"total_mib":10000}'

# ---- utilization dimension (card 79aeaeb1) ------------------------------------------------------
# Independent hysteresis, independent of the VRAM own/foreign attribution on purpose (see the
# script's header comment). All VRAM inputs below are deliberately quiet (a low, steady reading)
# so a failure here cannot be masked by the VRAM tier also holding.
QUIET_VRAM='{"used_mib":1000,"total_mib":10000}'

check "below-threshold utilization admits, no util= suffix wasted on a non-holding read" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$(st util-a)" --now 10000 --metrics-json "$QUIET_VRAM" \
    --util-samples-json '{"samples":[40,45,42]}'

s="$(st util-b)"
check "first over-threshold utilization reading does NOT flip yet" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 10000 --metrics-json "$QUIET_VRAM" \
    --util-samples-json '{"samples":[70,72,75]}'
check "still not flipped before sustained_seconds elapses" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 10029 --metrics-json "$QUIET_VRAM" \
    --util-samples-json '{"samples":[70,72,75]}'
check "flips to HOLD gpu-util-hold once sustained" 1 "HOLD gpu-util-hold" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 10030 --metrics-json "$QUIET_VRAM" \
    --util-samples-json '{"samples":[70,72,75]}'
check "the line names the measured utilization value (median of 70/72/75 is 72)" 1 "util=72%" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 10030 --metrics-json "$QUIET_VRAM" \
    --util-samples-json '{"samples":[70,72,75]}'

# MEDIAN, NOT MEAN OR MAX: a single spike among several samples must not decide the tier -- the
# same "one sample lies" reasoning the VRAM hysteresis already documents, applied at the sampling
# step. [20,22,24,25,95] has a mean of 37.2 (still under 60, coincidentally passes either way) but
# a MAX of 95 would wrongly hold; the median (24) is what the case actually pins.
check "a single spike among samples does not hold (median, not max)" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$(st util-c)" --now 10000 --metrics-json "$QUIET_VRAM" \
    --util-samples-json '{"samples":[20,22,24,25,95]}'

# GPU_UTIL_HOLD_PCT overrides the config default (60) without editing the config file, same
# convention as VRAM_GUARD_UNREADABLE.
check "GPU_UTIL_HOLD_PCT env overrides the config threshold" 0 "ADMIT ok" \
  env GPU_UTIL_HOLD_PCT=90 bash "$GUARD" --config "$cfg" --state "$(st util-d)" --now 10000 \
    --metrics-json "$QUIET_VRAM" --util-samples-json '{"samples":[70,72,75]}'

# FAIL-SAFE, same split as VRAM: tool present but the utilization query itself fails => doubt,
# hold. Tool absent => not a subject, admit (covered implicitly by every VRAM-only case above,
# which never pass --util-samples-json and so read the test-mode default of "not measured").
check "utilization query present-but-failing holds (doubt, not absence)" 1 "HOLD gpu-util-hold" \
  bash "$GUARD" --config "$cfg" --state "$(st util-e)" --now 10000 --metrics-json "$QUIET_VRAM" \
    --util-samples-json '{"error":"nvidia-smi utilization read failed","present":true}'
check "utilization tool absent does not hold (no subject, same as the VRAM case)" 0 "ADMIT ok" \
  bash "$GUARD" --config "$cfg" --state "$(st util-f)" --now 10000 --metrics-json "$QUIET_VRAM" \
    --util-samples-json '{"error":"nvidia-smi not found","present":false}'

# THE POINT OF THE CARD: our own model's compute counts, so utilization holds even while our own
# job holds the GPU lock (lock_held would otherwise ADMIT own-busy on the VRAM dimension alone).
# Sustained first, same as every other hysteresis case, so a one-shot reading cannot pass this.
s="$(st util-lock)"
bash "$GUARD" --config "$cfg" --state "$s" --now 20000 --lock-held yes --own-vram-mib 0 \
  --metrics-json '{"used_mib":6115,"total_mib":6144}' --util-samples-json '{"samples":[95,96,97]}' >/dev/null 2>&1
check "own-busy lock does NOT exempt utilization -- new work still goes online" 1 "HOLD gpu-util-hold own-busy" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 20031 --lock-held yes --own-vram-mib 0 \
    --metrics-json '{"used_mib":6115,"total_mib":6144}' --util-samples-json '{"samples":[95,96,97]}'
# CONTROL: the same lock, low utilization -> still admits own-busy as before card 79aeaeb1.
check "own-busy lock with quiet utilization still ADMITs (unchanged prior behaviour)" 0 "ADMIT own-busy" \
  bash "$GUARD" --config "$cfg" --state "$(st util-lock2)" --now 20000 --lock-held yes --own-vram-mib 0 \
    --metrics-json '{"used_mib":6115,"total_mib":6144}' --util-samples-json '{"samples":[10,12,11]}'

# BOTH dimensions holding at once: the reason names both, and the exit code is still just HOLD.
s="$(st util-both)"
bash "$GUARD" --config "$cfg" --state "$s" --now 30000 \
  --metrics-json '{"used_mib":9500,"total_mib":10000}' --util-samples-json '{"samples":[80,82,81]}' >/dev/null 2>&1
check "VRAM hard AND utilization hold together name both reasons" 1 "HOLD hard+gpu-util-hold" \
  bash "$GUARD" --config "$cfg" --state "$s" --now 30030 \
    --metrics-json '{"used_mib":9500,"total_mib":10000}' --util-samples-json '{"samples":[80,82,81]}'

# BACKWARD COMPATIBILITY, EXPLICIT: every pre-79aeaeb1 call site never passes --util-samples-json.
# The printed line must carry NO "util=" suffix at all in that case, not just "admit anyway" -- a
# caller or test elsewhere in the fleet that greps the exact old line shape must not need editing.
out="$(bash "$GUARD" --config "$cfg" --state "$(st util-compat)" --now 40000 \
  --metrics-json '{"used_mib":1000,"total_mib":10000}' 2>&1)"
case "$out" in
  *"util="*) echo "FAIL no-util-seam has no util= suffix: got [$out]"; failed=$((failed+1)) ;;
  *) passed=$((passed+1)) ;;
esac

# ---- the real invocation path, via a stub binary that answers BOTH query-gpu shapes -------------
# Mirrors the VRAM section's own stub-based cases: --metrics-json is NOT passed, so this exercises
# REAL_RUN, meaning read_vram_metrics() AND read_util_samples() both run for real against the stub.
stub_both="$tmpdir/nvidia-smi-both"
cat > "$stub_both" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"utilization.gpu"*) printf '55\n55\n55\n' ;;
  *) echo "1000, 10000" ;;
esac
EOF
chmod +x "$stub_both"
check "real invocation path: VRAM admits and utilization is read for real (below threshold)" 0 "ADMIT ok" \
  env VRAM_GUARD_NVIDIA_SMI="$stub_both" bash "$GUARD" --config "$cfg" --state "$(st util-real)" --now 50000
check "real invocation path: the util= value in the line comes from the stub, not a stub for --metrics-json" \
  0 "util=55%" \
  env VRAM_GUARD_NVIDIA_SMI="$stub_both" bash "$GUARD" --config "$cfg" --state "$(st util-real2)" --now 50000

stub_util_hold="$tmpdir/nvidia-smi-util-hold"
cat > "$stub_util_hold" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"utilization.gpu"*) printf '90\n91\n92\n' ;;
  *) echo "1000, 10000" ;;
esac
EOF
chmod +x "$stub_util_hold"
s="$(st util-real-hold)"
env VRAM_GUARD_NVIDIA_SMI="$stub_util_hold" bash "$GUARD" --config "$cfg" --state "$s" --now 51000 >/dev/null 2>&1
check "real invocation path: sustained high utilization holds through the real nvidia-smi path" \
  1 "HOLD gpu-util-hold" \
  env VRAM_GUARD_NVIDIA_SMI="$stub_util_hold" bash "$GUARD" --config "$cfg" --state "$s" --now 51031

# TIMEOUT SHARING: VRAM_GUARD_SMI_TIMEOUT bounds the utilization read too, by default, so a caller
# that tightens the VRAM timeout for a hang does not silently keep waiting up to a longer default
# on the utilization side. Regression case for exactly the bug this card's own selftest run caught
# (UTIL_SMI_TIMEOUT defaulting to a fixed 10s let a hang-bound case blow its 5s budget).
stub_hang_util="$tmpdir/nvidia-smi-hang-util-only"
cat > "$stub_hang_util" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"utilization.gpu"*) sleep 30 ;;
  *) echo "1000, 10000" ;;
esac
EOF
chmod +x "$stub_hang_util"
hang_util_start=$(date +%s)
env VRAM_GUARD_NVIDIA_SMI="$stub_hang_util" VRAM_GUARD_SMI_TIMEOUT=1 \
  bash "$GUARD" --config "$cfg" --state "$(st util-hang)" --now 52000 >/dev/null 2>&1
hang_util_elapsed=$(( $(date +%s) - hang_util_start ))
if [ "$hang_util_elapsed" -le 5 ]; then
  passed=$((passed+1))
else
  echo "FAIL util-hang-bound: a hanging utilization read took ${hang_util_elapsed}s under VRAM_GUARD_SMI_TIMEOUT=1; UTIL_SMI_TIMEOUT is not tracking it"
  failed=$((failed+1))
fi

if [ "$failed" -eq 0 ]; then
  echo "selftest: $passed passed, 0 failed"
  exit 0
fi
echo "selftest: $passed passed, $failed failed"
exit 1