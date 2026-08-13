#!/usr/bin/env bash
# gpu-detect-selftest.sh -- controls for gpu-detect.sh (card fb66b856 / e21f8432).
#
# WHY IT EXISTS. The detector's job is to be right on machines nobody here has: an AMD box, a Mac, a
# host with no GPU at all. None of those can be tested by running it here -- on this host it will
# always take the first branch and report a GTX 1660 Ti. So every branch is exercised against FAKE
# probe binaries through the documented overrides.
#
# THE CONTROL THAT MATTERS is not "no binary -> CPU-only". Absence is the easy case. The dangerous
# case is a probe that RUNS and returns nothing useful -- an empty line, a header with no numbers, a
# permissions error on stdout. That must FALL THROUGH to the next probe, and it must never end the
# chain or invent a number. Deleting a binary would not test that at all, so the fakes below RUN and
# misbehave rather than being absent.
#
# Usage: store/gpu-detect-selftest.sh   (exit 0 = PASS, 1 = FAIL)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECT="$HERE/gpu-detect.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

mkfake() { # $1 = name, $2 = stdout body ("" = print nothing), $3 = exit code
  local p="$TMP/$1"
  { echo '#!/usr/bin/env bash'
    [ -n "$2" ] && printf 'cat <<%s\n%s\n%s\n' "EOF_FAKE" "$2" "EOF_FAKE"
    echo "exit ${3:-0}"
  } > "$p"
  chmod +x "$p"
  echo "$p"
}

# Every case runs with ALL probes pointed at absent paths by default, then overrides just the one(s)
# under test -- so a case can never accidentally pass because the real host had a GPU.
run() { # stdin: extra env assignments
  env GPU_DETECT_WSL_NVIDIA_SMI="$TMP/absent-wsl" \
      GPU_DETECT_NVIDIA_SMI="$TMP/absent-nv" \
      GPU_DETECT_ROCM_SMI="$TMP/absent-rocm" \
      GPU_DETECT_SYSTEM_PROFILER="$TMP/absent-sp" \
      GPU_DETECT_LSPCI="$TMP/absent-lspci" \
      "$@" bash "$DETECT"
}

field() { python3 -c 'import json,sys; d=json.load(sys.stdin); v=d.get(sys.argv[1]); print("null" if v is None else v)' "$1"; }

check() { # $1 = label, $2 = expected, $3 = actual
  if [ "$3" = "$2" ]; then echo "  ok   $1 -> $3"
  else echo "  FAIL $1 -> got '$3', expected '$2'"; fail=1; fi
}

NV_GOOD='NVIDIA GeForce RTX 4070, 12282, 11000, 550.54'
WSL=$(mkfake wsl-good "$NV_GOOD" 0)
EMPTY=$(mkfake wsl-empty "" 0)
GARBAGE=$(mkfake wsl-garbage "no devices were found" 0)
NOTOTAL=$(mkfake wsl-nototal "Some GPU, , , 1.2.3" 0)
PATHNV=$(mkfake path-nv "$NV_GOOD" 0)
LSPCI=$(mkfake lspci-fake "01:00.0 VGA compatible controller: Some Vendor Fancy Card [1002:73df]" 0)

echo "gpu-detect controls"

# 1. POSITIVE: the WSL branch wins and reports both numbers.
out="$(run GPU_DETECT_WSL_NVIDIA_SMI="$WSL")"
check "wsl probe wins"            "wsl-nvidia-smi" "$(echo "$out" | field detectedBy)"
check "wsl total parsed"          "12282"          "$(echo "$out" | field vramTotalMib)"
check "wsl free parsed"           "11000"          "$(echo "$out" | field vramFreeMib)"
check "wsl not cpuOnly"           "False"          "$(echo "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cpuOnly"])')"

# 2. THE LOAD-BEARING CONTROL: a probe that RUNS and prints NOTHING must not end the chain. If the
#    chain stopped here, the machine would be reported CPU-only while a perfectly good GPU sat behind
#    the next probe. Deleting the binary would not exercise this path at all.
out="$(run GPU_DETECT_WSL_NVIDIA_SMI="$EMPTY" GPU_DETECT_NVIDIA_SMI="$PATHNV")"
check "empty probe falls through"  "nvidia-smi" "$(echo "$out" | field detectedBy)"
check "  ...and the next probe's number is used" "12282" "$(echo "$out" | field vramTotalMib)"

# 3. Same for a probe that prints a human sentence instead of CSV.
out="$(run GPU_DETECT_WSL_NVIDIA_SMI="$GARBAGE" GPU_DETECT_NVIDIA_SMI="$PATHNV")"
check "garbage probe falls through" "nvidia-smi" "$(echo "$out" | field detectedBy)"

# 4. A probe that names a card but has no TOTAL is not capability -- fall through, never guess.
out="$(run GPU_DETECT_WSL_NVIDIA_SMI="$NOTOTAL" GPU_DETECT_NVIDIA_SMI="$PATHNV")"
check "no-total probe falls through" "nvidia-smi" "$(echo "$out" | field detectedBy)"

# 4b. THE CONTROL THE MUTATION TEST DEMANDED. A probe names a card but cannot size it, and no later
#     probe can either. The card IS there, so the name and vendor must survive -- but capability is
#     unknown, so cpuOnly must be TRUE and the size must stay null. Before the chain was refactored
#     this path was unreachable (probes refused to emit without a total), which made the cpuOnly
#     derivation an equivalent mutant: flipping it to a constant broke nothing. Found by mutating,
#     not by reading.
out="$(run GPU_DETECT_WSL_NVIDIA_SMI="$NOTOTAL")"
check "named-but-unsized -> keeps the probe" "wsl-nvidia-smi" "$(echo "$out" | field detectedBy)"
check "named-but-unsized -> vendor kept"     "nvidia"         "$(echo "$out" | field vendor)"
check "named-but-unsized -> size null"       "null"           "$(echo "$out" | field vramTotalMib)"
check "named-but-unsized -> cpuOnly TRUE"    "True"           "$(echo "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cpuOnly"])')"

# 5. NEGATIVE: nothing at all -> a real, supported answer, with RAM still reported so the catalogue
#    can fall back to a RAM-sized filter rather than dead-ending the wizard.
out="$(run)"
check "no probes -> detectedBy"   "none"  "$(echo "$out" | field detectedBy)"
check "no probes -> vendor"       "none"  "$(echo "$out" | field vendor)"
check "no probes -> vram null"    "null"  "$(echo "$out" | field vramTotalMib)"
check "no probes -> cpuOnly"      "True"  "$(echo "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cpuOnly"])')"
ram="$(echo "$out" | field ramTotalMib)"
if [ "$ram" != "null" ] && [ "$ram" -gt 0 ] 2>/dev/null; then echo "  ok   no probes -> RAM still reported ($ram MiB)"
else echo "  FAIL no probes -> RAM missing ('$ram'), the CPU-only fallback has nothing to size against"; fail=1; fi

# 6. Named but unsized: say BOTH. Reporting "no GPU" here would be a different and wrong claim, and
#    reporting a size would be an invented one.
out="$(run GPU_DETECT_LSPCI="$LSPCI")"
check "lspci names the card"      "lspci-name-only" "$(echo "$out" | field detectedBy)"
check "  ...but still cpuOnly"    "True"            "$(echo "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cpuOnly"])')"
check "  ...and vram stays null"  "null"            "$(echo "$out" | field vramTotalMib)"
name="$(echo "$out" | field name)"
case "$name" in *"Fancy Card"*) echo "  ok   ...and the card name survived -> $name" ;;
  *) echo "  FAIL lspci name not carried -> '$name'"; fail=1 ;; esac

# 7. Output is always valid JSON, including on the all-absent path -- the installer parses it.
if run | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then echo "  ok   emits valid JSON even with no GPU"
else echo "  FAIL invalid JSON on the no-GPU path"; fail=1; fi

[ $fail -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
