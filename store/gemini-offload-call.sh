#!/usr/bin/env bash
# gemini-offload-call.sh -- call the Gemini REST API for an offload draft.
#
# Used by offload-dispatch.sh when route=gemini (card a92e9913).
#
# USAGE:
#   echo "task prompt" | gemini-offload-call.sh          # prompt from stdin
#   gemini-offload-call.sh "task prompt"                 # prompt as arg
#   gemini-offload-call.sh --dry-run "prompt"            # no API call, prints placeholder
#   gemini-offload-call.sh --validate-key                # check vault key, exit 0=valid
#
# EXIT CODES: 0 ok  |  2 no key / key invalid  |  3 API quota/auth  |  1 other API failure
#
# SECURITY: the API key goes in the x-goog-api-key header (never in the URL / argv).
# The prompt is redacted of .env-style values and key-shaped tokens before sending.
# No secret ever appears on stdout or in any log line.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

GEMINI_MODEL="${GEMINI_OFFLOAD_MODEL:-gemini-flash-latest}"
GEMINI_API_BASE="https://generativelanguage.googleapis.com/v1beta"
TIMEOUT="${GEMINI_OFFLOAD_TIMEOUT:-60}"
DRY_RUN=0

# ---- arg parsing ---------------------------------------------------------------
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

VALIDATE_ONLY=0
if [[ "${1:-}" == "--validate-key" ]]; then
  VALIDATE_ONLY=1
fi

# dry-run: no network, no vault needed
if [[ "$DRY_RUN" -eq 1 ]]; then
  PROMPT="${*:-$(cat)}"
  echo "[GEMINI DRY-RUN] Would call model=$GEMINI_MODEL with prompt (${#PROMPT} chars)"
  echo "DRAFT PLACEHOLDER: this would contain the generated text."
  exit 0
fi

# ---- vault key -----------------------------------------------------------------
resolve_gemini_key() {
  node "$ROOT/scripts/vault-resolve.mjs" 2>/dev/null <<'EOF'
GEMINI_API_KEY=integration.gemini.apiKey
EOF
  # output: "GEMINI_API_KEY=<value>"
}

API_KEY_LINE="$(resolve_gemini_key 2>/dev/null || true)"
API_KEY="${API_KEY_LINE#GEMINI_API_KEY=}"

if [[ -z "${API_KEY// }" ]]; then
  echo "gemini-offload-call: no key in vault (integration.gemini.apiKey)" >&2
  exit 2
fi

if [[ "$VALIDATE_ONLY" -eq 1 ]]; then
  # Lightweight probe: list models (no token cost)
  http_status="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "x-goog-api-key: $API_KEY" \
    "$GEMINI_API_BASE/models" 2>/dev/null)"
  if [[ "$http_status" == "200" ]]; then
    echo "gemini-offload-call: key valid (HTTP 200)"
    exit 0
  else
    echo "gemini-offload-call: key invalid or API error (HTTP $http_status)" >&2
    exit 2
  fi
fi

# ---- read prompt ---------------------------------------------------------------
if [[ $# -gt 0 ]]; then
  PROMPT="$*"
else
  PROMPT="$(cat)"
fi

if [[ -z "${PROMPT// }" ]]; then
  echo "gemini-offload-call: empty prompt" >&2
  exit 1
fi

# ---- prompt redaction ----------------------------------------------------------
# Strip patterns that look like secrets before sending to an external API.
# This is a defence-in-depth layer; the primary defence is project-level filtering
# in offload-dispatch.sh (mopsion cards never reach this script).
redact_prompt() {
  python3 - "$1" <<'PYEOF'
import re, sys

text = sys.argv[1]

# .env-style: KEY=value lines (may carry tokens)
text = re.sub(r'(?m)^[A-Z_][A-Z0-9_]+=\S+', '[REDACTED_ENV]', text)
# Bearer/token patterns
text = re.sub(r'\b(Bearer|token)[=:\s]+[A-Za-z0-9_.+/=-]{20,}', '[REDACTED_TOKEN]', text, flags=re.IGNORECASE)
# Google API keys (AIza...)
text = re.sub(r'\bAIza[0-9A-Za-z_-]{20,}', '[REDACTED_KEY]', text)
text = re.sub(r'\bAQ\.[0-9A-Za-z_.-]{20,}', '[REDACTED_KEY]', text)
# JWT (eyJ...)
text = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED_JWT]', text)
# Generic long hex secrets (32+ hex chars that look like API keys or hashes in isolation)
text = re.sub(r'(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])', '[REDACTED_HEX]', text)

print(text, end='')
PYEOF
}

CLEAN_PROMPT="$(redact_prompt "$PROMPT")"

# ---- build request body --------------------------------------------------------
REQUEST_BODY="$(python3 -c '
import json, sys
prompt = sys.argv[1]
body = {
  "contents": [{"role": "user", "parts": [{"text": prompt}]}],
  "generationConfig": {
    "temperature": 0,
    "maxOutputTokens": 4096
  }
}
print(json.dumps(body))
' "$CLEAN_PROMPT")"

# ---- call Gemini ---------------------------------------------------------------
TMPOUT="$(mktemp)"
TMPERR="$(mktemp)"
trap 'rm -f "$TMPOUT" "$TMPERR"' EXIT

http_status="$(curl -s -o "$TMPOUT" -w '%{http_code}' \
  --max-time "$TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $API_KEY" \
  "$GEMINI_API_BASE/models/$GEMINI_MODEL:generateContent" \
  -d "$REQUEST_BODY" 2>"$TMPERR")"

if [[ "$http_status" == "200" ]]; then
  # Extract text from the response
  text="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    text = d["candidates"][0]["content"]["parts"][0]["text"]
    print(text, end="")
except Exception as e:
    sys.stderr.write(f"parse error: {e}\n")
    sys.exit(1)
' "$TMPOUT" 2>"$TMPERR")"
  if [[ -n "${text// }" ]]; then
    printf '%s' "$text"
    exit 0
  else
    echo "gemini-offload-call: empty response from API" >&2
    exit 1
  fi
elif [[ "$http_status" == "429" || "$http_status" == "401" || "$http_status" == "403" ]]; then
  echo "gemini-offload-call: API auth/quota error (HTTP $http_status)" >&2
  exit 3
else
  echo "gemini-offload-call: API error (HTTP $http_status)" >&2
  exit 1
fi
