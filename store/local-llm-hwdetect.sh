#!/usr/bin/env bash
# local-llm-hwdetect.sh -- CPU/RAM/VRAM hardware detection for the local-LLM host (card 1c542799,
# alfeladat 1: da98873f).
#
# WHY: local-llm-tune.sh is hardcoded to ONE machine's hand-measured numbers (GTX 1660 Ti, 6 GiB).
# Before building a benchmark+auto-decide pipeline on top of that (alfeladat 2-3), the fleet needed to
# know it can actually SEE the hardware on whatever box Ollama runs on -- this script is exactly that,
# and nothing more. Decision/auto-apply logic is later alfeladat-ok, on purpose (plan-grilling comment
# 14327 required detection to be verified FIRST, separately, before anything is built on top of it).
#
# VERIFIED LIVE on the real local-LLM GPU host (DESKTOP-NPJIMPC, WSL2, GTX 1660 Ti, ollama.service
# active): nvidia-smi is NOT on PATH in this shell, but it exists and works at the fixed WSL2
# CUDA-passthrough path below (`nvidia-smi --query-gpu=... ` returned "NVIDIA GeForce GTX 1660 Ti,
# 6144, 1844" through it). So PATH alone is not a reliable detection strategy on this platform, and the
# fallback path is required, not defensive programming for a case that can't happen.
#
# USAGE: local-llm-hwdetect.sh   -> one JSON object on stdout, human-readable warnings on stderr.
# Exit codes: 0 always -- a machine with no usable GPU is a valid, reportable state, not a script
# failure. Callers branch on the JSON body ("gpu":{"backend":"none",...}), not the exit code.
set -uo pipefail

# --- platform detection (same method as local-llm.sh's detect_platform(), kept in sync deliberately:
# one opinion about how this fleet tells WSL apart from native Linux, not two that could disagree) ---
detect_platform() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) echo macos ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl; else echo linux; fi
      ;;
    *) echo unknown ;;
  esac
}
PLATFORM="$(detect_platform)"

# --- nvidia-smi path resolution ---------------------------------------------------------------------
# Try PATH first (native Linux with drivers installed, and most non-WSL setups), then the fixed WSL2
# CUDA-passthrough path (present and working on this box, NOT on PATH -- see header). No further
# fallback: guessing additional paths risks silently finding the WRONG binary -- e.g. the Windows-side
# nvidia-smi.exe under /mnt/c/Windows/System32 also works and reports the same card, but it is not the
# binary in the same execution context as the WSL-side ollama process, and routing through it is a much
# slower cross-boundary call for no benefit.
# WSL2_NVIDIA_SMI_PATH override exists ONLY so the selftest can exercise this branch on a machine
# where the real path may or may not exist -- production always reads the real fixed path.
WSL2_NVIDIA_SMI_PATH="${WSL2_NVIDIA_SMI_PATH:-/usr/lib/wsl/lib/nvidia-smi}"
NVIDIA_SMI=""
if command -v nvidia-smi >/dev/null 2>&1; then
  NVIDIA_SMI="nvidia-smi"
elif [[ -x "$WSL2_NVIDIA_SMI_PATH" ]]; then
  NVIDIA_SMI="$WSL2_NVIDIA_SMI_PATH"
fi

CORES="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"

RAM_TOTAL_MIB=0
RAM_AVAIL_MIB=0
if [[ -r /proc/meminfo ]]; then
  RAM_TOTAL_MIB=$(( $(awk '/^MemTotal:/{print $2}' /proc/meminfo) / 1024 ))
  RAM_AVAIL_MIB=$(( $(awk '/^MemAvailable:/{print $2}' /proc/meminfo) / 1024 ))
elif [[ "$PLATFORM" == macos ]]; then
  RAM_TOTAL_MIB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 ))
fi

GPU_JSON="[]"
BACKEND="none"
METHOD="none"

if [[ -n "$NVIDIA_SMI" ]]; then
  GPU_CSV="$("$NVIDIA_SMI" --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits 2>/dev/null || true)"
  if [[ -n "$GPU_CSV" ]]; then
    BACKEND="cuda"
    METHOD="$NVIDIA_SMI"
    GPU_JSON="$(printf '%s\n' "$GPU_CSV" | python3 -c '
import json, sys
devices = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    parts = [p.strip() for p in line.split(",")]
    if len(parts) != 3:
        continue
    name, total, free = parts
    devices.append({"name": name, "vram_total_mib": int(total), "vram_free_mib": int(free)})
print(json.dumps(devices))
')"
  else
    METHOD="$NVIDIA_SMI (found but query failed)"
  fi
elif [[ "$PLATFORM" == macos ]]; then
  # Metal uses unified memory -- there is no separate VRAM pool to query, and Ollama's own
  # auto-detection already handles this internally. NOT independently verified on real macOS hardware
  # (no such host exists in this fleet to test against); reported honestly as unverified rather than
  # guessed at, per card 1c542799's plan-grilling requirement to verify before claiming.
  BACKEND="metal"
  METHOD="unified-memory (=ram; unverified, no macOS host in this fleet)"
fi

if [[ "$BACKEND" == "none" ]]; then
  echo "local-llm-hwdetect: no GPU detected (nvidia-smi not on PATH or at the known WSL2 path) -- CPU-only" >&2
fi

PLATFORM="$PLATFORM" CORES="$CORES" RAM_TOTAL_MIB="$RAM_TOTAL_MIB" RAM_AVAIL_MIB="$RAM_AVAIL_MIB" \
BACKEND="$BACKEND" METHOD="$METHOD" GPU_JSON="$GPU_JSON" python3 -c '
import json, os
print(json.dumps({
    "platform": os.environ["PLATFORM"],
    "cpu": {"cores": int(os.environ["CORES"])},
    "ram": {"total_mib": int(os.environ["RAM_TOTAL_MIB"]), "available_mib": int(os.environ["RAM_AVAIL_MIB"])},
    "gpu": {
        "backend": os.environ["BACKEND"],
        "detection_method": os.environ["METHOD"],
        "devices": json.loads(os.environ["GPU_JSON"]),
    },
}, indent=2))
'
