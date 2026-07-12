#!/usr/bin/env bash
# Feature-driven Stitch design generation. The FUNCTION dictates the design:
# if a feature/flow/screen lacks a design, generate one here, then implement it.
# Uses the vault Stitch key at runtime (never printed/committed).
# Usage: store/stitch-gen.sh "<design prompt>" "<output-dir>"  ->  <out>/generated.{html,png}
set -u
ROOT="/home/neon/marveen"
PROMPT="${1:?need a prompt}"; OUT="${2:?need an output dir}"
KEY="$(echo "K=Stitch" | node "$ROOT/scripts/vault-resolve.mjs" 2>/dev/null | sed 's/^K=//')"
[ -z "$KEY" ] && { echo "NO_KEY (vault)"; exit 2; }
cd "$ROOT/store/stitch-tools" || exit 3
STITCH_API_KEY="$KEY" STITCH_PROJECT="3862263673254942781" STITCH_OUT="$OUT" STITCH_GEN="$PROMPT" node ./gen.mjs
