#!/usr/bin/env bash
# Self-test for local-llm-hwdetect.sh (card 1c542799, alfeladat 1 / da98873f, lepes 9c553fe5).
#
# Run: bash store/local-llm-hwdetect.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# WHY THIS FILE EXISTS (not just "it ran once and printed the right JSON manually"): the manual run
# during development only proved the DEFAULT branch on THIS box. The other two branches (PATH-resolved
# nvidia-smi, and no-GPU CPU-only fallback) were verified once by hand with ad hoc sed/PATH tricks and
# then thrown away -- exactly the kind of check that needs to survive as a real regression test, not a
# one-off terminal transcript. This drives all three branches for real, on the live host.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm-hwdetect.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

# --- 0. the script parses and always exits 0 -----------------------------------------------------
if bash -n "$SCRIPT" 2>/dev/null; then ok "local-llm-hwdetect.sh parses (bash -n)"; else bad "parses" ""; fi

# --- 1. default run on THIS host produces valid, well-shaped JSON ---------------------------------
out="$(bash "$SCRIPT" 2>/tmp/hwdetect-stderr.$$)"; rc=$?
[[ $rc -eq 0 ]] && ok "exits 0 on the real host" || bad "exits 0 on the real host" "rc=$rc"

echo "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["platform"] in ("wsl", "linux", "macos", "unknown"), d["platform"]
assert isinstance(d["cpu"]["cores"], int) and d["cpu"]["cores"] > 0, d["cpu"]
assert isinstance(d["ram"]["total_mib"], int) and d["ram"]["total_mib"] > 0, d["ram"]
assert d["gpu"]["backend"] in ("cuda", "metal", "none"), d["gpu"]
assert isinstance(d["gpu"]["devices"], list), d["gpu"]
' 2>/tmp/hwdetect-shape.$$ && ok "default-run JSON has the expected shape" \
  || bad "default-run JSON has the expected shape" "$(cat /tmp/hwdetect-shape.$$)"
rm -f /tmp/hwdetect-shape.$$

# --- 2. PATH-resolved nvidia-smi branch: a shim on PATH must be picked up over the WSL fallback,
# and its output must actually be parsed (a fake CSV line, not just "found") ------------------------
fakepath="$(mktemp -d)"
cat > "$fakepath/nvidia-smi" <<'SHIM'
#!/usr/bin/env bash
echo "Fake Test GPU, 1234, 567"
SHIM
chmod +x "$fakepath/nvidia-smi"
out2="$(PATH="$fakepath:$PATH" bash "$SCRIPT" 2>/dev/null)"
echo "$out2" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["gpu"]["detection_method"] == "nvidia-smi", d
assert d["gpu"]["backend"] == "cuda", d
assert d["gpu"]["devices"] == [{"name": "Fake Test GPU", "vram_total_mib": 1234, "vram_free_mib": 567}], d
' 2>/tmp/hwdetect-path.$$ && ok "PATH-resolved nvidia-smi wins over the WSL fallback and its CSV is parsed" \
  || bad "PATH-resolved nvidia-smi wins" "$(cat /tmp/hwdetect-path.$$)"
rm -rf "$fakepath" /tmp/hwdetect-path.$$

# --- 3. WSL-fixed-path branch, driven for real against the actual live GPU -----------------------
# Only meaningful where that path genuinely exists (the fleet's real GPU host); skip cleanly elsewhere
# rather than fabricate a pass.
if [[ -x /usr/lib/wsl/lib/nvidia-smi ]]; then
  out3="$(PATH="/usr/bin:/bin" WSL2_NVIDIA_SMI_PATH=/usr/lib/wsl/lib/nvidia-smi bash "$SCRIPT" 2>/dev/null)"
  echo "$out3" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["gpu"]["backend"] == "cuda", d
assert d["gpu"]["detection_method"] == "/usr/lib/wsl/lib/nvidia-smi", d
assert len(d["gpu"]["devices"]) >= 1, d
dev = d["gpu"]["devices"][0]
assert dev["vram_total_mib"] > 0, dev
' 2>/tmp/hwdetect-wsl.$$ && ok "WSL fixed-path branch finds the real GPU (live nvidia-smi)" \
    || bad "WSL fixed-path branch finds the real GPU" "$(cat /tmp/hwdetect-wsl.$$)"
  rm -f /tmp/hwdetect-wsl.$$
else
  echo "  [skip] WSL fixed-path branch -- /usr/lib/wsl/lib/nvidia-smi not present on this host"
fi

# --- 3b. the script's OWN COMPILED-IN default, with NO override at all (Cybersec NO-GO, comment
# 14338): check #3 above always passes WSL2_NVIDIA_SMI_PATH explicitly, so it never exercises the
# literal default baked into the script (line 44: `WSL2_NVIDIA_SMI_PATH="${WSL2_NVIDIA_SMI_PATH:-...}"`)
# -- a future typo in that literal would go undetected by check #3 while still showing "7/7 green".
# This drives the script with the env var completely UNSET, only PATH stripped of any real
# nvidia-smi, so the fallback must resolve through the compiled-in default or fail. -------------------
if [[ -x /usr/lib/wsl/lib/nvidia-smi ]]; then
  out3b="$(PATH="/usr/bin:/bin" env -u WSL2_NVIDIA_SMI_PATH bash "$SCRIPT" 2>/dev/null)"
  echo "$out3b" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["gpu"]["backend"] == "cuda", d
assert d["gpu"]["detection_method"] == "/usr/lib/wsl/lib/nvidia-smi", d
' 2>/tmp/hwdetect-default.$$ && ok "compiled-in default WSL2 path (no override) finds the real GPU" \
    || bad "compiled-in default WSL2 path (no override) finds the real GPU" "$(cat /tmp/hwdetect-default.$$)"
  rm -f /tmp/hwdetect-default.$$
else
  echo "  [skip] compiled-in default path -- /usr/lib/wsl/lib/nvidia-smi not present on this host"
fi

# --- 4. no-GPU fallback: neither PATH nor the (overridden, nonexistent) fixed path resolve ---------
out4="$(PATH="/usr/bin:/bin" WSL2_NVIDIA_SMI_PATH=/nonexistent/nvidia-smi bash "$SCRIPT" 2>/dev/null)"
echo "$out4" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["gpu"]["backend"] == "none", d
assert d["gpu"]["devices"] == [], d
' 2>/tmp/hwdetect-nogpu.$$ && ok "no-GPU fallback reports backend=none, devices=[] (no crash, no fabrication)" \
  || bad "no-GPU fallback reports backend=none" "$(cat /tmp/hwdetect-nogpu.$$)"
rm -f /tmp/hwdetect-nogpu.$$

# --- 5. no-GPU fallback still exits 0 and warns on stderr, not stdout -----------------------------
stderr4="$(PATH="/usr/bin:/bin" WSL2_NVIDIA_SMI_PATH=/nonexistent/nvidia-smi bash "$SCRIPT" 2>&1 >/dev/null)"
if [[ "$stderr4" == *"no GPU detected"* ]]; then
  ok "no-GPU fallback warns on stderr"
else
  bad "no-GPU fallback warns on stderr" "got: $stderr4"
fi

rm -f /tmp/hwdetect-stderr.$$

echo
if [[ $fail -gt 0 ]]; then echo "$fail FAILED, $pass passed"; exit 1; fi
echo "All $pass checks pass."
