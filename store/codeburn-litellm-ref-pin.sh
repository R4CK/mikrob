#!/usr/bin/env bash
# codeburn-litellm-ref-pin.sh -- pin CodeBurn's model-price-list fetch away from
# BerriAI/litellm's moving `main` branch, to a specific commit.
#
# Card 4543e8d8 (Cybered finding on 56ed32df's gate round, non-blocking): CodeBurn
# 0.9.20 hardcodes LITELLM_URL to .../litellm/main/model_prices_and_context_window.json
# with a 24h cache TTL -- the same hazard class as a moving `bitnami/minio:latest`
# CI dependency, just for cost-decision data instead of a build image. Not a
# functional bug (an embedded snapshot is the fallback if the fetch ever fails),
# but a pin closes the "upstream silently changes what our cost numbers are based
# on" surface, same as the CI-image fix did.
#
# CodeBurn has no env-var or config override for this URL (checked: `grep -c
# LITELLM_URL dist/main.js` is 3 -- one declaration, one read site, one var-list
# entry; no process.env lookup near it). The only lever is patching the installed,
# already-audited 0.9.20 build artifact directly. That artifact lives OUTSIDE this
# git repo (~/.local/lib/node_modules/codeburn, per-user npm --prefix install, see
# store/codeburn-usage-policy.md) and would be silently reset by any reinstall --
# hence this script is TRACKED (ops-scripts rule) and re-runnable, not a one-off
# hand-edit. Re-run after any `npm install -g --prefix ~/.local codeburn@<ver>`.
#
# Output first line contract:
#   ALREADY-PINNED <sha>      -> no change, the target sha is already in place
#   PATCHED <old-ref> -> <sha> -> patch applied this run
#   NOT-FOUND <path>          -> codeburn dist not installed at the expected path
#   UNEXPECTED                -> neither the moving-ref nor a pinned-ref pattern
#                                 found -- CodeBurn's internals changed shape,
#                                 this script needs re-verification, not blind re-run
set -uo pipefail

TARGET="${CODEBURN_DIST:-$HOME/.local/lib/node_modules/codeburn/dist/main.js}"

# Refreshing the pin is a DELIBERATE decision (same policy as the codeburn version
# pin itself, store/codeburn-usage-policy.md): bump this only after checking the
# new commit's diff on model_prices_and_context_window.json, not on a schedule.
# Pinned 2026-08-16 (card 4543e8d8), latest commit on that file's history at pin time.
PINNED_SHA="0059b497f44d8ad2ab8dae5e17fbd8df0cfcdb11"

OLD_URL="https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
NEW_URL="https://raw.githubusercontent.com/BerriAI/litellm/${PINNED_SHA}/model_prices_and_context_window.json"

if [[ ! -f "$TARGET" ]]; then
  echo "NOT-FOUND $TARGET"
  exit 0
fi

if grep -qF "$NEW_URL" "$TARGET"; then
  echo "ALREADY-PINNED $PINNED_SHA"
  exit 0
fi

if grep -qF "$OLD_URL" "$TARGET"; then
  python3 - "$TARGET" "$OLD_URL" "$NEW_URL" <<'PYEOF'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()
count = content.count(old)
content = content.replace(old, new)
with open(path, "w", encoding="utf-8") as f:
    f.write(content)
print(f"replaced {count} occurrence(s)", file=sys.stderr)
PYEOF
  echo "PATCHED main -> $PINNED_SHA"
  exit 0
fi

echo "UNEXPECTED"
exit 1
