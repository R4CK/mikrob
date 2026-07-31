#!/usr/bin/env bash
# local-llm-tune.sh -- apply the measured Ollama GPU tuning to the user systemd unit (card 7041c165).
#
# WHY THIS EXISTS AS A TRACKED SCRIPT: the tuning is two Environment lines in
# ~/.config/systemd/user/ollama.service -- a file no installer in this repo generates and git does not
# track. Left as a hand-edit it is invisible, unreviewable, and silently lost on a fresh install or a
# new host, which is precisely the "a fix that lives only outside the repo is not saved" failure this
# fleet has hit before. The script is idempotent, so re-running it after an OS/ollama reinstall
# restores the measured configuration.
#
# WHAT IT SETS, AND THE EVIDENCE (GTX 1660 Ti, 6 GiB, Turing/cc7.5; 3 runs per point, identical
# prompt, via store/local-llm-bench.sh):
#   OLLAMA_FLASH_ATTENTION=1   -- prerequisite for KV quantisation
#   OLLAMA_KV_CACHE_TYPE=q8_0  -- halves the KV cache; the freed VRAM keeps more layers on the GPU
#
#   ctx    GPU share      KV cache        generation
#   4096   82% -> 84%     224 -> 119 MiB  29.1 -> 31.7 tok/s  (+9%)
#   16384  73% -> 79%     896 -> 476 MiB  24.4 -> 27.4 tok/s  (+12%)
#   24576  67% -> 73%    1344 -> 714 MiB  21.8 -> 22.3 tok/s  (and stays usable)
#
# HONEST LIMITS: these numbers are for THIS card and THIS model (qwen2.5-coder:7b q4_K_M). The model
# never fully fits in 6 GiB -- even tuned it runs ~16-27% on CPU -- so the win is "more of the model
# on the GPU at a bigger context", not "fits entirely". On a card with tensor cores, or with enough
# VRAM for a full offload, re-measure before assuming the same direction: q8_0 KV costs some
# dequantisation work per token and is only a net win while VRAM is the binding constraint.
#
# USAGE: local-llm-tune.sh [--check] [--revert]
#   (no args)  apply + daemon-reload + restart ollama
#   --check    report what is currently set, change nothing (exit 0 tuned / 1 untuned)
#   --revert   remove the tuning lines and restart

set -uo pipefail

UNIT="${OLLAMA_UNIT:-$HOME/.config/systemd/user/ollama.service}"
MARKER='# --- local-llm-tune (card 7041c165) ---'
MODE="apply"

case "${1:-}" in
  --check) MODE="check" ;;
  --revert) MODE="revert" ;;
  "") ;;
  *) echo "local-llm-tune: unknown arg '$1'" >&2; exit 2 ;;
esac

[[ -f "$UNIT" ]] || { echo "local-llm-tune: no unit at $UNIT" >&2; exit 2; }

if [[ "$MODE" == "check" ]]; then
  fa=$(grep -c '^Environment=OLLAMA_FLASH_ATTENTION=1' "$UNIT" || true)
  kv=$(grep -c '^Environment=OLLAMA_KV_CACHE_TYPE=q8_0' "$UNIT" || true)
  echo "unit:            $UNIT"
  echo "flash_attention: $([[ "$fa" -gt 0 ]] && echo set || echo UNSET)"
  echo "kv_cache_type:   $([[ "$kv" -gt 0 ]] && echo q8_0 || echo UNSET)"
  # The server is the authority on what is actually in effect, not the file on disk.
  journalctl --user -u ollama --no-pager -n 50 2>/dev/null \
    | grep -o 'OLLAMA_FLASH_ATTENTION:[a-z]*\|OLLAMA_KV_CACHE_TYPE:[a-z0-9_]*' | tail -2
  [[ "$fa" -gt 0 && "$kv" -gt 0 ]] && exit 0 || exit 1
fi

# Always strip any previous block first -- that is what makes both apply and revert idempotent.
python3 - "$UNIT" "$MARKER" <<'PY'
import re, sys
path, marker = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
src = re.sub(re.escape(marker) + r'.*?' + re.escape(marker) + r'\n', '', src, flags=re.S)
# Also drop any bare (hand-added) copies so we never end up with duplicate Environment lines.
src = re.sub(r'^Environment=OLLAMA_(FLASH_ATTENTION|KV_CACHE_TYPE)=.*\n', '', src, flags=re.M)
open(path, 'w', encoding='utf-8').write(src)
PY

if [[ "$MODE" == "apply" ]]; then
  python3 - "$UNIT" "$MARKER" <<'PY'
import sys
path, marker = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
block = (marker + "\n"
         "# Measured on a GTX 1660 Ti/6 GiB: KV 896->476 MiB and 24.4->27.4 tok/s at ctx 16384.\n"
         "# Re-measure with store/local-llm-bench.sh before assuming this holds on other hardware.\n"
         "Environment=OLLAMA_FLASH_ATTENTION=1\n"
         "Environment=OLLAMA_KV_CACHE_TYPE=q8_0\n"
         + marker + "\n")
anchor = "[Service]\n"
if anchor not in src:
    print("local-llm-tune: unit has no [Service] section", file=sys.stderr)
    raise SystemExit(2)
src = src.replace(anchor, anchor + block, 1)
open(path, 'w', encoding='utf-8').write(src)
PY
  [[ $? -eq 0 ]] || exit 2
fi

systemctl --user daemon-reload || exit 2
systemctl --user restart ollama || exit 2
sleep 4
systemctl --user is-active ollama >/dev/null || { echo "local-llm-tune: ollama failed to restart" >&2; exit 2; }
echo "local-llm-tune: ${MODE}d; ollama active"
journalctl --user -u ollama --no-pager -n 50 2>/dev/null \
  | grep -o 'OLLAMA_FLASH_ATTENTION:[a-z]*\|OLLAMA_KV_CACHE_TYPE:[a-z0-9_]*' | tail -2
