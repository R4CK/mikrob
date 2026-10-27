#!/usr/bin/env bash
# freellm-call.sh -- call the free LLM API (OpenAI-compatible) for an offload draft.
#
# Used by offload-dispatch.sh when route=freellm.
#
# USAGE:
#   echo "task prompt" | freellm-call.sh          # prompt from stdin
#   freellm-call.sh "task prompt"                 # prompt as arg
#   freellm-call.sh --dry-run "prompt"            # no API call, prints placeholder
#   freellm-call.sh --validate-key                # check config, exit 0=valid
#
# EXIT CODES: 0 ok  |  2 disabled/invalid config  |  3 API quota/auth  |  1 other API failure  |  4 content gate refused
#
# SECURITY: no secret in argv, log, stdout. Content gate refuses mopsion/PII/security/auth/finance.
# Config missing or invalid = OFF (fail-closed). Service binds 127.0.0.1 only.
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

FREELLM_SWITCH="${FREELLM_SWITCH:-$ROOT/store/freellm-enabled.json}"
FREELLM_API_BASE="${FREELLM_API_BASE:-http://127.0.0.1:8000/v1}"
FREELLM_MODEL="${FREELLM_MODEL:-gpt-3.5-turbo}"
TIMEOUT="${FREELLM_TIMEOUT:-60}"
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

# dry-run: no network, no config needed
if [[ "$DRY_RUN" -eq 1 ]]; then
  PROMPT="${*:-$(cat)}"
  echo "[FREELLM DRY-RUN] Would call model=$FREELLM_MODEL with prompt (${#PROMPT} chars)"
  echo "DRAFT PLACEHOLDER: this would contain the generated text."
  exit 0
fi

# ---- temp files + trap ---------------------------------------------------------------
_CAT_PY="" TMPOUT="" TMPERR="" REQ_FILE=""
trap 'rm -f "$_CAT_PY" "$TMPOUT" "$TMPERR" "$REQ_FILE"' EXIT

# ---- check freellm switch ---------------------------------------------------------------
# Missing or invalid file = OFF (fail-closed, exit 2)
if [[ ! -f "$FREELLM_SWITCH" ]] || [[ ! -r "$FREELLM_SWITCH" ]]; then
  exit 2  # config missing
fi

ENABLED="$(python3 -c "import json; d=json.load(open('$FREELLM_SWITCH')); print(d.get('enabled', False))" 2>/dev/null)" || exit 2
if [[ "$ENABLED" != "True" ]]; then
  exit 2  # disabled
fi

if [[ "$VALIDATE_ONLY" -eq 1 ]]; then
  exit 0  # config valid
fi

# ---- read prompt ---------------------------------------------------------------
PROMPT="${*:-$(cat)}"

# ---- content gate: category check ---------------------------------------------------------------
# FAIL-CLOSED (exit 4): if content is sensitive (mopsion/PII/security/auth/finance), refuse.
_CAT_PY="$(mktemp)"
chmod 0600 "$_CAT_PY"
cat > "$_CAT_PY" << 'PYEOF'
import re, sys, json
text = sys.stdin.read()
# Sensitive patterns: mopsion, tenant, API key, password, secret, token, finance, PII, auth
SENSITIVE = r'(?i)(mopsion|tenant|api.?key|password|secret|token|credit.?card|ssn|pii|auth|payroll|invoice|salary)'
if re.search(SENSITIVE, text):
    sys.exit(1)  # refuse
sys.exit(0)  # allow
PYEOF

echo "$PROMPT" | python3 "$_CAT_PY" || exit 4  # exit 4: content gate refused

# ---- call freellm API ---------------------------------------------------------------
TMPOUT="$(mktemp)"
TMPERR="$(mktemp)"
REQ_FILE="$(mktemp)"

# Prepare OpenAI-compatible request with properly escaped JSON
python3 << PYEOF > "$REQ_FILE"
import json
request = {
    "model": "$FREELLM_MODEL",
    "messages": [{"role": "user", "content": """$PROMPT"""}],
    "temperature": 0,
    "max_tokens": 2000
}
print(json.dumps(request))
PYEOF

# Call API (localhost, 127.0.0.1 only, no key)
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$TMPOUT" -X POST \
  "$FREELLM_API_BASE/chat/completions" \
  -H "Content-Type: application/json" \
  --data @"$REQ_FILE" \
  --connect-timeout 5 \
  --max-time "$TIMEOUT" 2>"$TMPERR")

# ---- handle API response ---------------------------------------------------------------
case "$HTTP_CODE" in
  200)
    # Extract the generated text from OpenAI-compatible response
    python3 << PYEOF
import json
try:
    with open('$TMPOUT', 'r') as f:
        response = json.load(f)
    print(response['choices'][0]['message']['content'])
except (json.JSONDecodeError, KeyError, IndexError) as e:
    exit(1)
PYEOF
    exit 0
    ;;
  401|403)
    # Auth failure (should not happen on localhost, but coverage)
    exit 3
    ;;
  429)
    # Quota
    exit 3
    ;;
  *)
    # Other API failure
    exit 1
    ;;
esac
