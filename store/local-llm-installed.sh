#!/usr/bin/env bash
# local-llm-installed.sh -- is a local LLM actually INSTALLED on this host at all?
#
# Distinct from "is it running" (local-llm.sh --health / ollama_up's curl liveness check): a fresh
# fleet clone or a host that never ran first-run-llm.sh has neither the `ollama` binary nor a
# configured coding model, and the local-first branch (self-advance-pickup.sh, card-build-route.sh,
# offload-dispatch.sh, the heartbeat's own C-section 4b step) must not even START on such a host --
# Peti, 2026-09-19 Telegram 8928, verbatim: "ha nincs telepitve local-llm akkor ez az ag el se
# induljon". Before this gate, the fail-safe chain already resolved a missing/unreachable model to
# ONLINE eventually -- correct, but only after paying a classify pipeline's own timeout budget on a
# host that could never have answered. This is a cheap, filesystem-only, no-network precheck so
# every caller can skip the whole branch instead of discovering the same absence the slow way.
#
# Checks, ALL must hold:
#   1. the ollama.service user unit is not MASKED -- Peti, 2026-10-01: the unit was deliberately
#      masked (gpu-crashloop-guard, dxgkrnl GPU-passthrough crash-loop) and MUST STAY OFF. A masked
#      unit is a different situation from "binary present but service crashed/stopped" (that one has
#      its own recovery path, see local-llm.sh's gpu_guard_mask_note/card b9a657e6): masking is
#      deliberate and does not self-heal, so every attempt against it is guaranteed to fail. Measured
#      2026-10-09: this gate missed exactly that case, so offload-overnight-batch burned a transient-
#      fail attempt on 20 cards in one run (card 5595afa7) before any of them could reach "exhausted"
#      for the right reason.
#   2. an `ollama` binary is reachable -- PATH, or the common ~/.local/bin install location.
#   3. store/local-llm-model names a configured coding model (non-empty) -- the SAME file
#      local-llm.sh reads as its default MODEL. A runtime installed but never pointed at a model
#      still counts as "not installed" for this gate: nothing here would know which model to run.
#
# Usage: local-llm-installed.sh
# Prints "installed" and exits 0 if all hold; prints "not-installed: <reason>" and exits 1
# otherwise. Never touches the network (the systemctl query below is a local D-Bus call, same class
# of cost as the `command -v` binary check, not a network hop).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLLAMA_BIN="${LOCAL_LLM_INSTALLED_OLLAMA_BIN:-ollama}"
MODEL_FILE="${LOCAL_LLM_INSTALLED_MODEL_FILE:-$HERE/local-llm-model}"
LOCAL_BIN_DIR="${LOCAL_LLM_INSTALLED_LOCAL_BIN_DIR:-$HOME/.local/bin}"
SYSTEMCTL_BIN="${LOCAL_LLM_INSTALLED_SYSTEMCTL_BIN:-systemctl}"
OLLAMA_UNIT="${LOCAL_LLM_INSTALLED_OLLAMA_UNIT:-ollama.service}"

have_binary() {
  command -v "$OLLAMA_BIN" >/dev/null 2>&1 && return 0
  [ -x "$LOCAL_BIN_DIR/$OLLAMA_BIN" ] && return 0
  return 1
}

# A host with no systemd user bus at all (CI, macOS, a non-systemd Linux) must not trip this: an
# unanswerable systemctl is not evidence of a mask, and reading it that way would wrongly block an
# install that simply isn't managed by systemd. Only an explicit "masked" answer counts.
unit_masked() {
  command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 || return 1
  local state
  state="$("$SYSTEMCTL_BIN" --user is-enabled "$OLLAMA_UNIT" 2>/dev/null)"
  [ "$state" = "masked" ]
}

if unit_masked; then
  echo "not-installed: ollama.service masked"
  exit 1
fi

if ! have_binary; then
  echo "not-installed: no '$OLLAMA_BIN' binary on PATH or in $LOCAL_BIN_DIR"
  exit 1
fi

if [ ! -s "$MODEL_FILE" ]; then
  echo "not-installed: no coding model configured ($MODEL_FILE missing or empty)"
  exit 1
fi

echo "installed"
exit 0
