#!/usr/bin/env bash
# Optional cross-review by ChatGPT and Gemini before pushing a PR.
# Requires OPENAI_API_KEY and/or GEMINI_API_KEY stored in the vault.
# If a key is missing the reviewer is silently skipped.
#
# Usage: ./scripts/pre-pr-review.sh [base-ref]
#   base-ref defaults to upstream/main

set -euo pipefail

BASE="${1:-upstream/main}"
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_FILE="$INSTALL_DIR/store/.dashboard-token"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "[pre-pr-review] Dashboard token not found, skipping cross-review." >&2
  exit 0
fi

DASHBOARD_TOKEN="$(cat "$TOKEN_FILE")"
# Dashboard port: env WEB_PORT, else the install .env, else 3420.
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')}"
WEB_PORT="${WEB_PORT:-3420}"
API="http://localhost:${WEB_PORT}/api/vault"

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card b267df80): every secret used
# below (dashboard token, and the third-party keys it fetches) goes into a private
# 0600 header file, never curl argv -- /proc/<pid>/cmdline is world-readable.
DASH_HDR_FILE="$(mktemp)"; chmod 600 "$DASH_HDR_FILE"
trap 'rm -f "$DASH_HDR_FILE" "${OPENAI_HDR_FILE:-}" "${GEMINI_HDR_FILE:-}"' EXIT
printf 'Authorization: Bearer %s\n' "$DASHBOARD_TOKEN" > "$DASH_HDR_FILE"

get_secret() {
  local id="$1"
  local val
  val="$(curl -sf -H @"$DASH_HDR_FILE" "$API/$id" 2>/dev/null)" || true
  echo "$val" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('value',''))" 2>/dev/null || true
}

DIFF="$(git diff "$BASE"...HEAD)"
if [ -z "$DIFF" ]; then
  echo "[pre-pr-review] No diff found against $BASE, nothing to review."
  exit 0
fi

PROMPT="You are a senior software engineer reviewing a pull request. Review the following git diff for correctness, security, and code quality. Be concise and specific. List any real issues found.\n\nDiff:\n\`\`\`\n$DIFF\n\`\`\`"

# --- ChatGPT ---
OPENAI_KEY="$(get_secret OPENAI_API_KEY)"
if [ -n "$OPENAI_KEY" ]; then
  echo ""
  echo "=== ChatGPT Review ==="
  PAYLOAD="$(python3 -c "
import json, sys
prompt = sys.stdin.read()
print(json.dumps({'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': 1000}))
" <<< "$PROMPT")"
  OPENAI_HDR_FILE="$(mktemp)"; chmod 600 "$OPENAI_HDR_FILE"
  printf 'Authorization: Bearer %s\n' "$OPENAI_KEY" > "$OPENAI_HDR_FILE"
  curl -sf https://api.openai.com/v1/chat/completions \
    -H @"$OPENAI_HDR_FILE" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])"
  rm -f "$OPENAI_HDR_FILE"
else
  echo "[pre-pr-review] OPENAI_API_KEY not set in vault — ChatGPT review skipped."
fi

# --- Gemini ---
GEMINI_KEY="$(get_secret GEMINI_API_KEY)"
if [ -n "$GEMINI_KEY" ]; then
  echo ""
  echo "=== Gemini Review ==="
  PAYLOAD="$(python3 -c "
import json, sys
prompt = sys.stdin.read()
print(json.dumps({'contents': [{'parts': [{'text': prompt}]}]}))
" <<< "$PROMPT")"
  # x-goog-api-key header is the documented alternative to the ?key= query param --
  # same auth, but the secret no longer sits in the URL (curl argv / access logs).
  GEMINI_HDR_FILE="$(mktemp)"; chmod 600 "$GEMINI_HDR_FILE"
  printf 'x-goog-api-key: %s\n' "$GEMINI_KEY" > "$GEMINI_HDR_FILE"
  curl -sf "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent" \
    -H @"$GEMINI_HDR_FILE" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['candidates'][0]['content']['parts'][0]['text'])"
  rm -f "$GEMINI_HDR_FILE"
else
  echo "[pre-pr-review] GEMINI_API_KEY not set in vault — Gemini review skipped."
fi
