#!/usr/bin/env bash
# gpu-detect.sh -- normalized GPU / VRAM detection for the local-LLM model catalogue.
# Card fb66b856 (EPIC ebc7b4dd, T1 Alfeladat 1). Design: docs/local-llm-model-catalog.md section 1.
#
# WHY A CHAIN AND NOT ONE COMMAND. On this very host -- the machine that motivated the card --
# `nvidia-smi` is NOT on PATH and `lspci` is not installed at all. The binary that works lives at
# /usr/lib/wsl/lib/nvidia-smi, a WSL-only location. A detector written around either of the two
# obvious commands would have failed on the first machine it ran on.
#
# So: an ORDERED chain, stopping at the first probe that yields a TOTAL-VRAM number. Every probe may
# legitimately be absent, and a probe that runs but produces nothing parseable FALLS THROUGH rather
# than aborting -- a detector that dies on an unexpected line is worse than one that says "no GPU",
# because the caller can handle "no GPU" and cannot handle a crash mid-install.
#
# WHAT IT NEVER DOES: invent a number. Every field it cannot establish is null. A fabricated VRAM
# figure would be sized against by the catalogue and produce a "fits" promise for a model that does
# not fit -- the exact failure the three-tier rule exists to prevent.
#
# Usage:
#   store/gpu-detect.sh              # JSON on stdout, exit 0 even when no GPU is found
#   store/gpu-detect.sh --probe      # print which probes are available, for diagnosis
#
# Every probe path is overridable so the selftest can point at fakes without a GPU:
#   GPU_DETECT_WSL_NVIDIA_SMI, GPU_DETECT_NVIDIA_SMI, GPU_DETECT_ROCM_SMI,
#   GPU_DETECT_SYSTEM_PROFILER, GPU_DETECT_LSPCI, GPU_DETECT_MEMINFO
set -uo pipefail

WSL_NVIDIA_SMI="${GPU_DETECT_WSL_NVIDIA_SMI:-/usr/lib/wsl/lib/nvidia-smi}"
NVIDIA_SMI="${GPU_DETECT_NVIDIA_SMI:-nvidia-smi}"
ROCM_SMI="${GPU_DETECT_ROCM_SMI:-rocm-smi}"
SYSTEM_PROFILER="${GPU_DETECT_SYSTEM_PROFILER:-system_profiler}"
LSPCI="${GPU_DETECT_LSPCI:-lspci}"
MEMINFO="${GPU_DETECT_MEMINFO:-/proc/meminfo}"

# A probe emits ONE tab-separated record and nothing else:
#   vendor \t name \t vramTotalMib \t vramFreeMib \t driver
# Empty vramTotalMib means "this probe did not establish capability" -> keep going.
#
# THE SEPARATOR IS STRIPPED FROM THE FIELDS (card cf625ba9, Cybered's LOW on the fb66b856 gate).
# A TAB inside a field shifts every later field left, and the reader takes the FIRST five parts --
# so a device NAME containing a tab followed by digits lands those digits in the vramTotalMib slot.
# Reproduced before fixing: a fake probe reporting `Fake GPU<TAB>9999, , ,` -- a card with NO memory
# figures at all -- yielded `"vramTotalMib": 9999, "cpuOnly": false`. That is the one thing this
# detector's own header says it never does, reached without touching the number fields at all.
#
# Stripping at the producer is the primary fix; the reader ALSO rejects a record that is not exactly
# five fields (see the python below), because probe_rocm and probe_apple build their records in
# python and never pass through here -- a fix that only hardened emit() would have left half the
# probes exposed.
emit() {
  local f out=() a
  for a in "$1" "$2" "$3" "$4" "$5"; do
    f="${a//$'\t'/ }"; f="${f//$'\n'/ }"; f="${f//$'\r'/ }"
    out+=("$f")
  done
  printf '%s\t%s\t%s\t%s\t%s\n' "${out[0]}" "${out[1]}" "${out[2]}" "${out[3]}" "${out[4]}"
}

# `nvidia-smi --query-gpu=...` in CSV, used for BOTH nvidia probes -- one parser, so the WSL and the
# PATH branch can never drift apart in how they read the same output.
probe_nvidia() { # $1 = binary
  local bin="$1" out
  [ -x "$bin" ] || command -v "$bin" >/dev/null 2>&1 || return 1
  out="$("$bin" --query-gpu=name,memory.total,memory.free,driver_version \
        --format=csv,noheader,nounits 2>/dev/null | head -1)" || return 1
  [ -n "${out// }" ] || return 1
  local name total free driver
  IFS=',' read -r name total free driver <<< "$out"
  name="$(echo "$name" | sed 's/^ *//;s/ *$//')"
  total="$(echo "$total" | tr -cd '0-9')"
  free="$(echo "$free" | tr -cd '0-9')"
  driver="$(echo "$driver" | sed 's/^ *//;s/ *$//')"
  # A probe REPORTS; it does not decide. Emitting a name with no total is meaningful -- it says "an
  # NVIDIA card is here but this probe could not size it", which is different from "no GPU" and
  # different again from "sized". The single capability decision lives in the chain below, so there
  # is exactly one place where "can this machine run a model of size X" is answered.
  [ -n "$name$total" ] || return 1
  emit nvidia "$name" "$total" "$free" "$driver"
}

# AMD. NOT VERIFIED -- written from documentation, no ROCm host available (see design section 1.4).
# Kept deliberately strict: anything it cannot parse falls through to the next probe.
probe_rocm() {
  command -v "$ROCM_SMI" >/dev/null 2>&1 || return 1
  local json
  json="$("$ROCM_SMI" --showmeminfo vram --json 2>/dev/null)" || return 1
  [ -n "${json// }" ] || return 1
  echo "$json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for card, vals in (d.items() if isinstance(d, dict) else []):
    if not isinstance(vals, dict):
        continue
    total = free = None
    for k, v in vals.items():
        kl = str(k).lower()
        if "total" in kl and "vram" in kl:
            total = v
        if ("used" in kl or "free" in kl) and "vram" in kl:
            free = v
    if total is None:
        continue
    try:
        tot_mib = int(int(str(total).strip()) / (1024 * 1024))
    except Exception:
        continue
    # Same separator strip as emit() -- this record never passes through it (card cf625ba9). The
    # card key comes from rocm-smi JSON, so it is external text like any other probe output.
    safe = str(card).replace("\t", " ").replace("\n", " ").replace("\r", " ")
    print("amd\t%s\t%d\t\t" % (safe, tot_mib))
    sys.exit(0)
sys.exit(1)
' 2>/dev/null || return 1
}

# macOS. NOT VERIFIED -- no Apple host available (design section 1.4). Apple silicon reports UNIFIED
# memory, which is not VRAM in the discrete sense; the catalogue treats it as the ceiling anyway
# because that is what bounds a resident model there.
probe_apple() {
  command -v "$SYSTEM_PROFILER" >/dev/null 2>&1 || return 1
  local json
  json="$("$SYSTEM_PROFILER" SPDisplaysDataType -json 2>/dev/null)" || return 1
  [ -n "${json// }" ] || return 1
  echo "$json" | python3 -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for gpu in d.get("SPDisplaysDataType", []) or []:
    name = gpu.get("sppci_model") or gpu.get("_name") or "Apple GPU"
    raw = gpu.get("spdisplays_vram") or gpu.get("spdisplays_vram_shared") or ""
    m = re.match(r"\s*(\d+)\s*(MB|GB)", str(raw), re.I)
    if not m:
        continue
    mib = int(m.group(1)) * (1024 if m.group(2).upper() == "GB" else 1)
    # Same separator strip as emit() -- see the amd probe above (card cf625ba9).
    safe = str(name).replace("\t", " ").replace("\n", " ").replace("\r", " ")
    print("apple\t%s\t%d\t\t" % (safe, mib))
    sys.exit(0)
sys.exit(1)
' 2>/dev/null || return 1
}

# Last resort: identifies the card but yields NO VRAM. It therefore cannot end the chain -- it only
# enriches the CPU-only answer with a name, so a user sees "we found this card but could not size it"
# rather than a bare "no GPU", which would be a different and wrong claim.
probe_lspci_name() {
  command -v "$LSPCI" >/dev/null 2>&1 || return 1
  "$LSPCI" -nn 2>/dev/null | grep -i 'vga\|3d controller' | head -1 |
    sed 's/.*: //; s/ *\[[0-9a-f]\{4\}:[0-9a-f]\{4\}\].*//' | head -c 120
}

total_ram_mib() {
  if [ -r "$MEMINFO" ]; then
    awk '/^MemTotal:/ {printf "%d", $2/1024; exit}' "$MEMINFO" 2>/dev/null && return 0
  fi
  if command -v sysctl >/dev/null 2>&1; then
    local b; b="$(sysctl -n hw.memsize 2>/dev/null | tr -cd '0-9')"
    [ -n "$b" ] && echo $(( b / 1048576 )) && return 0
  fi
  echo ""
}

if [ "${1:-}" = "--probe" ]; then
  printf 'wsl-nvidia-smi   %s\n' "$([ -x "$WSL_NVIDIA_SMI" ] && echo available || echo absent)"
  for p in "$NVIDIA_SMI" "$ROCM_SMI" "$SYSTEM_PROFILER" "$LSPCI"; do
    printf '%-16s %s\n' "$p" "$(command -v "$p" >/dev/null 2>&1 && echo available || echo absent)"
  done
  exit 0
fi

# --- the chain, in order. First probe with a TOTAL wins. -------------------------------------
REC=""; DETECTED_BY=""
for probe in "wsl-nvidia-smi" "nvidia-smi" "rocm-smi" "system_profiler"; do
  case "$probe" in
    wsl-nvidia-smi)  CAND="$(probe_nvidia "$WSL_NVIDIA_SMI" 2>/dev/null)" ;;
    nvidia-smi)      CAND="$(probe_nvidia "$NVIDIA_SMI" 2>/dev/null)" ;;
    rocm-smi)        CAND="$(probe_rocm 2>/dev/null)" ;;
    system_profiler) CAND="$(probe_apple 2>/dev/null)" ;;
  esac
  [ -n "${CAND// }" ] || continue
  # Keep the FIRST partial answer (a name, no size) so it is not lost, but keep LOOKING: a later
  # probe that can size the card is strictly better. Only a TOTAL ends the chain -- "a probe
  # answered" is not the same question as "we know what this machine can run".
  cand_total="$(printf '%s' "$CAND" | cut -f3)"
  if [ -z "${REC// }" ]; then REC="$CAND"; DETECTED_BY="$probe"; fi
  if [ -n "${cand_total//[^0-9]/}" ]; then REC="$CAND"; DETECTED_BY="$probe"; break; fi
done

RAM_MIB="$(total_ram_mib)"
FALLBACK_NAME=""
[ -z "$REC" ] && FALLBACK_NAME="$(probe_lspci_name 2>/dev/null || true)"

REC="$REC" DETECTED_BY="$DETECTED_BY" RAM_MIB="$RAM_MIB" FALLBACK_NAME="$FALLBACK_NAME" python3 -c '
import json, os

rec = os.environ.get("REC", "")
ram = os.environ.get("RAM_MIB", "").strip()
out = {
    "vendor": "none",
    "name": None,
    "vramTotalMib": None,
    "vramFreeMib": None,
    "driver": None,
    # WHICH probe answered. Without this, "it says CPU-only and I have a GPU" is an investigation;
    # with it, it is one line of output.
    "detectedBy": os.environ.get("DETECTED_BY") or "none",
    "cpuOnly": True,
    "ramTotalMib": int(ram) if ram.isdigit() else None,
}
parts = rec.rstrip("\n").split("\t") if rec.strip() else []
# FAIL CLOSED ON A MALFORMED RECORD (card cf625ba9). The old reader padded and then truncated to
# five, which turns a field-count error into a SILENT re-interpretation: with six parts, the reader
# read the second half of a tab-containing NAME as the VRAM total and reported it as capability.
# Padding is what made the corruption invisible, so it is gone -- the record is exactly five fields
# or it is not a record. Rejecting the whole record rather than one field is deliberate: once the
# separator was crossed, no field can be trusted by position, vendor and name included.
# (No apostrophes anywhere in this block: it lives inside a single-quoted shell string.)
if len(parts) != 5:
    parts = []
    if os.environ.get("DETECTED_BY"):
        # Name the probe that produced it. "malformed" with no origin is an investigation; this is
        # one line of output, the same argument detectedBy itself exists for.
        out["detectedBy"] = os.environ["DETECTED_BY"] + "-malformed-record"
if parts:
    vendor, name, total, free, driver = parts
    out.update(
        vendor=vendor or "none",
        name=name or None,
        vramTotalMib=int(total) if total.isdigit() else None,
        vramFreeMib=int(free) if free.isdigit() else None,
        driver=driver or None,
    )
    # cpuOnly is decided by the TOTAL, not by whether a probe answered: a probe that named a card
    # but could not size it leaves the catalogue with nothing to filter on, which is the same
    # position as having no GPU at all.
    out["cpuOnly"] = out["vramTotalMib"] is None
elif os.environ.get("FALLBACK_NAME", "").strip():
    # Named but unsized -- say both, rather than claiming "no GPU" (a different, wrong claim).
    out["name"] = os.environ["FALLBACK_NAME"].strip()
    out["detectedBy"] = "lspci-name-only"
print(json.dumps(out, indent=2))
'
exit 0
