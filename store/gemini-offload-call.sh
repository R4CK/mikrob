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

# ---- prompt redaction ----------------------------------------------------------
# Strip patterns that look like secrets before sending to an external API.
# Pattern set mirrors src/security/secret-gate.ts SECRET_PATTERNS (card a92e9913 B2).
# Prompt arrives on stdin to avoid appearing in /proc/<pid>/cmdline.
#
# The Python script is written to a temp file so that redact_prompt() can call
# `python3 "$file"` with the text on stdin.  The heredoc approach (python3 - <<'EOF')
# cannot work here: the heredoc overrides stdin inside the function body, so
# sys.stdin.read() always returns empty string when text is piped in.
_REDACT_PY="$(mktemp)"
chmod 0600 "$_REDACT_PY"
cat > "$_REDACT_PY" << 'PYEOF'
import re, sys

text = sys.stdin.read()

# PEM private key blocks
text = re.sub(r'-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----',
              '[REDACTED_PRIVKEY]', text, flags=re.DOTALL)
# Stripe / generic sk_live / sk_test
text = re.sub(r'\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}', '[REDACTED_KEY]', text)
# Generic vendor secret keys (sk- or sk_)
text = re.sub(r'\bsk[-_][A-Za-z0-9_-]{24,}', '[REDACTED_KEY]', text)
# OpenAI project key (sk-proj-)
text = re.sub(r'\bsk-proj-[A-Za-z0-9_-]{20,}', '[REDACTED_KEY]', text)
# ElevenLabs (xi-api-key header)
text = re.sub(r'xi-api-key["\'\s:=]+[A-Za-z0-9_-]{16,}', '[REDACTED_KEY]', text, flags=re.IGNORECASE)
# Bearer token (any length >= 8)
text = re.sub(r'\bBearer\s+[A-Za-z0-9_\-\.=+/]{8,}', '[REDACTED_TOKEN]', text, flags=re.IGNORECASE)
# JWT: eyJ...eyJ...sig
text = re.sub(r'\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}',
              '[REDACTED_JWT]', text)
# GitHub tokens (ghp_ gho_ ghu_ ghr_ ghs_)
text = re.sub(r'\bgh[pousr]_[A-Za-z0-9]{30,}', '[REDACTED_TOKEN]', text)
# Slack tokens (xoxb- xoxa- xoxp- xoxr- xoxs-)
text = re.sub(r'\bxox[baprs]-[A-Za-z0-9-]{10,}', '[REDACTED_TOKEN]', text)
# AWS access key ID
text = re.sub(r'\bAKIA[0-9A-Z]{16}\b', '[REDACTED_KEY]', text)
# Supabase personal access token
text = re.sub(r'\bsbp_[0-9a-f]{40}\b', '[REDACTED_KEY]', text)
# Google API keys (AIza)
text = re.sub(r'\bAIza[0-9A-Za-z_-]{20,}', '[REDACTED_KEY]', text)
# Telegram bot token (numeric:alphanum)
text = re.sub(r'\b\d{8,12}:[A-Za-z0-9_-]{35,}\b', '[REDACTED_TOKEN]', text)
# .env-style: KEY=value (ALL_CAPS, mixed, export prefix, indented; >= 8 char value)
text = re.sub(r'(?m)^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]+=\S{8,}', '[REDACTED_ENV]', text)
# password/secret/token/api_key assignments (inline)
text = re.sub(
    r'\b(password|passwd|secret|token|api[_-]?key|auth[_-]?key|access[_-]?key)[=:\s]+["\']?[A-Za-z0-9_\-\.=+/]{8,}["\']?',
    '[REDACTED_CRED]', text, flags=re.IGNORECASE)
# Database URLs with embedded password (postgres/mysql/mongodb/redis://user:pass@host)
text = re.sub(r'(postgres|mysql|mongodb|redis)://[^:]+:[^@]{4,}@', r'\1://[REDACTED]@', text)
# Basic auth header
text = re.sub(r'\bBasic\s+[A-Za-z0-9+/=]{8,}', '[REDACTED_BASIC]', text, flags=re.IGNORECASE)
# Long hex secrets (32+ consecutive hex chars)
text = re.sub(r'(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])', '[REDACTED_HEX]', text)

print(text, end='')
PYEOF

redact_prompt() {
  python3 "$_REDACT_PY"
}

# redact-test: run redact_prompt on stdin/arg and exit WITHOUT touching vault (test hook, card a92e9913 B2)
if [[ "${1:-}" == "--redact-test" ]]; then
  shift
  PROMPT="${*:-$(cat)}"
  printf '%s' "$PROMPT" | redact_prompt
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
  # Lightweight probe: list models (no token cost).
  # Key goes in a 0600 header file to keep it out of /proc/<pid>/cmdline (card a92e9913 B3).
  VAL_HDR="$(mktemp)"
  chmod 0600 "$VAL_HDR"
  printf 'x-goog-api-key: %s\r\n' "$API_KEY" > "$VAL_HDR"
  http_status="$(curl -s -o /dev/null -w '%{http_code}' \
    -H @"$VAL_HDR" \
    "$GEMINI_API_BASE/models" 2>/dev/null)"
  rm -f "$VAL_HDR"
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

CLEAN_PROMPT="$(printf '%s' "$PROMPT" | redact_prompt)"

# ---- build request body --------------------------------------------------------
# Prompt arrives via stdin to keep it out of /proc/<pid>/cmdline (card a92e9913 B3).
REQUEST_BODY="$(printf '%s' "$CLEAN_PROMPT" | python3 -c '
import json, sys
prompt = sys.stdin.read()
body = {
  "contents": [{"role": "user", "parts": [{"text": prompt}]}],
  "generationConfig": {
    "temperature": 0,
    "maxOutputTokens": 4096
  }
}
print(json.dumps(body))
')"

# ---- call Gemini ---------------------------------------------------------------
TMPOUT="$(mktemp)"
TMPERR="$(mktemp)"
# Write API key to a 0600 header file so it never appears in /proc/<pid>/cmdline (card a92e9913 B3).
API_HDR="$(mktemp)"
chmod 0600 "$API_HDR"
printf 'x-goog-api-key: %s\r\n' "$API_KEY" > "$API_HDR"
trap 'rm -f "$TMPOUT" "$TMPERR" "$API_HDR" "$_REDACT_PY"' EXIT

http_status="$(curl -s -o "$TMPOUT" -w '%{http_code}' \
  --max-time "$TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -H @"$API_HDR" \
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
    # Redact the response before emitting (card a92e9913 B4): the model may echo
    # fragments from the prompt that slipped through input redaction.
    printf '%s' "$text" | redact_prompt
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
