#!/usr/bin/env bash
# MT-06 (card 7c9be2d8): thin wrapper around scripts/kg-backfill.ts. Its only job is the
# INSTALLED gate (root CLAUDE.md rule 16, Peti Telegram 8928: "ha nincs telepitve local-llm akkor
# ez az ag el se induljon") -- the local-LLM-only backfill branch must not even start resolving
# candidates or touching the kg database on a host with no local runtime, same precheck every
# other local-first entry point (self-advance-pickup.sh, offload-dispatch.sh) runs first.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"

if ! bash "$HERE/local-llm-installed.sh" >/dev/null 2>&1; then
  echo "kg-backfill: SKIPPED -- local-llm: not installed. Nothing processed; re-run once a local model is set up." >&2
  exit 0
fi

cd "$MARVEEN_MAIN"
exec npx tsx scripts/kg-backfill.ts "$@"
