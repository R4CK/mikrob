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
# SECURITY: no secret in argv, log, stdout. Content gate: real category check
# (gemini-agy-category-check.py on a card-shaped wrapper of the prompt) plus secret/PII
# detection (same SECRET_PATTERNS/PII_PATTERNS fold+scan as gemini-offload-call.sh's
# redactor). Config missing or invalid = OFF (fail-closed). Auth token is read from a 0600
# file and sent via a header file (-H @file), never as an argv value. Service reached on
# 127.0.0.1 only.
#
# F1 (QA FAIL 25363 / WhiteHat2 NO-GO 25366, CRITICAL): an earlier version built the request
# body with an UNQUOTED heredoc (python3 << PYEOF ... """$PROMPT"""), so bash spliced the
# prompt into Python SOURCE TEXT before python3 ever ran -- a prompt that closed the triple
# quote early executed as Python. Every value that reaches a python3 invocation below travels
# via an environment variable (read with os.environ) or stdin (read with sys.stdin, via a
# herestring, never via a heredoc at the same time -- a heredoc IS stdin, so the two cannot
# combine), and every heredoc that supplies PYTHON SOURCE uses a QUOTED delimiter ('PYEOF') so
# bash performs no substitution inside it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

FREELLM_SWITCH="${FREELLM_SWITCH:-$ROOT/store/freellm-enabled.json}"
FREELLM_API_BASE="${FREELLM_API_BASE:-http://127.0.0.1:3001/v1}"
FREELLM_MODEL="${FREELLM_MODEL:-gpt-3.5-turbo}"
FREELLM_AUTH_TOKEN_FILE="${FREELLM_AUTH_TOKEN_FILE:-/home/neon/.config/freellmapi/auth-token}"
CATEGORY_CHECK="${FREELLM_CATEGORY_CHECK_OVERRIDE:-$ROOT/store/gemini-agy-category-check.py}"
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
_WRAP_PY="" _GATE_PY="" _REQ_PY="" TMPOUT="" TMPERR="" REQ_FILE="" AUTH_HDR=""
trap 'rm -f "$_WRAP_PY" "$_GATE_PY" "$_REQ_PY" "$TMPOUT" "$TMPERR" "$REQ_FILE" "$AUTH_HDR"' EXIT

# ---- check freellm switch ---------------------------------------------------------------
# Missing or invalid file = OFF (fail-closed, exit 2)
if [[ ! -f "$FREELLM_SWITCH" ]] || [[ ! -r "$FREELLM_SWITCH" ]]; then
  exit 2  # config missing
fi

# F4 (WhiteHat2 LOW): strict boolean check (`d.get('enabled') is True`), not a string/truthy
# comparison -- {"enabled":"True"} (a JSON string) or {"enabled":1} must NOT turn the client on.
ENABLED="$(FREELLM_SWITCH_PATH="$FREELLM_SWITCH" python3 -I << 'PYEOF' 2>/dev/null
import json, os, sys
try:
    with open(os.environ["FREELLM_SWITCH_PATH"]) as f:
        d = json.load(f)
except Exception:
    print("false")
    sys.exit(0)
print("true" if isinstance(d, dict) and d.get("enabled") is True else "false")
PYEOF
)" || exit 2
if [[ "$ENABLED" != "true" ]]; then
  exit 2  # disabled or malformed
fi

if [[ "$VALIDATE_ONLY" -eq 1 ]]; then
  exit 0  # config valid
fi

# ---- read prompt ---------------------------------------------------------------
PROMPT="${*:-$(cat)}"

# ---- content gate: real category check (F2, WhiteHat2 NO-GO 25366) -------------------
# The card's Korlatok name gemini-agy-category-check.py as the content gate that must run
# caller-side; the removed inline regex was a weaker, English-only, word-list copy, trivially
# bypassed. The real checker expects a kanban-card-shaped JSON on stdin (title/description/
# labels) -- there is no single card behind a free-text prompt, so the prompt is wrapped as
# the "description" field (no --kartya id argv, so the checker's id/title-match branch does
# not engage; it still runs its stem-category scan over description). Checker exit != 0 means
# "cannot verify" (malformed input) -- fail-closed here too, same as a detected category.
if [[ ! -f "$CATEGORY_CHECK" ]]; then
  exit 2  # cannot verify: fail-closed as unconfigured
fi
_WRAP_PY="$(mktemp)"
chmod 0600 "$_WRAP_PY"
cat > "$_WRAP_PY" << 'PYEOF'
import json, sys
print(json.dumps({"description": sys.stdin.read()}))
PYEOF
CAT_JSON="$(python3 -I "$_WRAP_PY" <<< "$PROMPT")"
DETECTED_CAT="$(printf '%s' "$CAT_JSON" | python3 -I "$CATEGORY_CHECK" 2>/dev/null)"
CHECK_RC=$?
if [[ "$CHECK_RC" -ne 0 ]]; then
  exit 4  # cannot verify (malformed) -- refuse like a detected category
fi
if [[ -n "$DETECTED_CAT" ]]; then
  exit 4  # category detected (security/auth/finance/mopsion)
fi

# ---- content gate: secret/PII detection (F2, reuses gemini-offload-call.sh's redactor) ----
# Same fold (NFKD + homoglyph-map + strip invisible/combining/control/default-ignorable) and
# the same SECRET_PATTERNS + PII_PATTERNS alternations as store/gemini-offload-call.sh's
# redact_prompt(), kept as a second copy rather than a shared import (same tradeoff that
# script's own header documents for one small function). Detection only here (no redacted
# text is emitted) -- exit 1 on a hit, 0 clean; the caller below maps a hit to exit 4.
_GATE_PY="$(mktemp)"
chmod 0600 "$_GATE_PY"
cat > "$_GATE_PY" << 'PYEOF'
import re, sys, unicodedata

text = sys.stdin.read()

_HOMOGLYPH_MAP = str.maketrans({
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
    "і": "i", "ѕ": "s", "һ": "h", "ԃ": "d", "ɡ": "g", "ⅰ": "i",
})
_INVISIBLE_CODEPOINTS = {"⠀"}
_DEFAULT_IGNORABLE_RANGES = (
    (0x180B, 0x180D),
    (0x180F, 0x180F),
    (0x2065, 0x2065),
    (0xFE00, 0xFE0F),
    (0xFFF0, 0xFFF8),
    (0xE0000, 0xE0000),
    (0xE0002, 0xE001F),
    (0xE0080, 0xE00FF),
    (0xE0100, 0xE0FFF),
)

def _is_default_ignorable(ch):
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _DEFAULT_IGNORABLE_RANGES)

def _fold(s):
    s = s.translate(_HOMOGLYPH_MAP)
    s = unicodedata.normalize("NFKD", s)
    return "".join(
        ch for ch in s
        if unicodedata.category(ch) not in ("Mn", "Cf", "Cc", "Zl", "Zp")
        and ch not in _INVISIBLE_CODEPOINTS
        and not _is_default_ignorable(ch)
    )

scan_text = _fold(text)

SECRET_PATTERNS = [
    (r'-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|OPENSSH PRIVATE KEY)-----', 'privkey'),
    (r'\bssh-(rsa|ed25519|dss) [A-Za-z0-9+/]{40,}={0,2}', 'ssh_pubkey'),
    (r'\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}', 'sk_live'),
    (r'\bsk[-_][A-Za-z0-9_-]{24,}', 'sk_generic'),
    (r'\bsk-proj-[A-Za-z0-9_-]{20,}', 'sk_proj'),
    (r'\bsk-ant-[A-Za-z0-9_-]{20,}', 'anthropic'),
    (r'(?i)xi-api-key["\'\s:=]+[A-Za-z0-9_-]{16,}', 'elevenlabs'),
    (r'(?i)\bBearer\s+[A-Za-z0-9_\-.=+/]{4,}', 'bearer'),
    (r'\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}', 'jwt'),
    (r'\bgh[pousr]_[A-Za-z0-9]{30,}', 'github'),
    (r'\bxox[baprs]-[A-Za-z0-9-]{10,}', 'slack'),
    (r'\bAKIA[0-9A-Z]{16}\b', 'aws'),
    (r'(?i)aws_secret_access_key["\'\s:=]+[A-Za-z0-9/+=]{30,}', 'aws_secret'),
    (r'\bsbp_[0-9a-f]{40}\b', 'supabase'),
    (r'\bAIza[0-9A-Za-z_-]{20,}', 'google'),
    (r'\b[0-9]+-[0-9A-Za-z_-]{32}\.apps\.googleusercontent\.com\b', 'google_oauth'),
    (r'\b\d{8,12}:[A-Za-z0-9_-]{35,}\b', 'telegram'),
    (r'\bSK[0-9a-f]{32}\b', 'twilio'),
    (r'\bAC[0-9a-f]{32}\b', 'twilio_sid'),
    (r'\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}', 'sendgrid'),
    (r'\bnpm_[A-Za-z0-9]{36}\b', 'npm'),
    (r'\bdckr_pat_[A-Za-z0-9_-]{20,}\b', 'dockerhub'),
    (r'\bdop_v1_[a-f0-9]{64}\b', 'digitalocean'),
    (r'\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b', 'discord'),
    (r'(?i)cloudflare[_-]?(api[_-]?)?token["\'\s:=]+[A-Za-z0-9_-]{30,}', 'cloudflare'),
    (r'(?i)AccountKey=[A-Za-z0-9+/]{40,}={0,2}', 'azure'),
    (r'(?m)^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]+=\S{8,}', 'env'),
    (r'((?<![A-Za-z0-9])|(?<=[a-z0-9])(?=[A-Z]))(?i:password|passwd|secret|token|api[_-]?key|auth[_-]?key|access[_-]?key)["\']?[=:\s]+'
     r'(?:"[^"\n]{8,}"|\'[^\'\n]{8,}\'|[A-Za-z0-9_\-.=+/]{8,})', 'cred'),
    (r'(?i)(postgres|mysql|mongodb|redis)://[^:]+:[^@]{4,}@', 'dburl'),
    (r'(?i)\bBasic\s+[A-Za-z0-9+/=]{8,}', 'basic'),
    (r'(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])', 'hex32'),
    (r'(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])', 'opaque_token'),
    (r'\bASIA[0-9A-Z]{16}\b', 'aws_asia'),
    (r'\b1//0[A-Za-z0-9_-]{20,}\b', 'google_refresh'),
    (r'(?i)\bcookie:\s*[^\n]*?session[A-Za-z0-9_]*=[A-Za-z0-9%_.\-]{8,}', 'cookie_session'),
    (r'\bwhsec_[A-Za-z0-9]{16,}\b', 'stripe_whsec'),
    (r'(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])', 'opaque_b64url'),
    (r'(?i)\bthe\s+token\s+is\s+[A-Za-z0-9_\-./+=]{8,}\b', 'prose_token'),
    (r'(?i)\bthe\s+password\s+for\s+the\s+\S+\s+is\s+\S{4,}\b', 'prose_password'),
]

for pattern, label in SECRET_PATTERNS:
    if re.search(pattern, scan_text, re.DOTALL):
        sys.exit(1)

PII_PATTERNS = [
    (r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', 'email'),
    (r'(?<!\d)(\+36|06)[ -]?\(?\d{1,2}\)?[ -]?\d{3}[ -]?\d{4}\b', 'hu_phone'),
    (r'\b\d{3}[ -]?\d{3}[ -]?\d{3}\b(?=.{0,20}(?i:taj))|(?i:taj)[^\n]{0,20}?\b\d{3}[ -]?\d{3}[ -]?\d{3}\b', 'hu_taj'),
    (r'\b\d{8}-\d-\d{2}\b', 'hu_adoszam'),
    (r'\b(?:\d[ -]?){13,19}\b', 'cc_number'),
    (r'\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b', 'iban'),
]

for pattern, label in PII_PATTERNS:
    if re.search(pattern, scan_text, re.DOTALL):
        sys.exit(1)

sys.exit(0)
PYEOF
python3 -I "$_GATE_PY" <<< "$PROMPT" >/dev/null 2>&1 || exit 4

# ---- call freellm API ---------------------------------------------------------------
TMPOUT="$(mktemp)"
TMPERR="$(mktemp)"
REQ_FILE="$(mktemp)"
chmod 0600 "$REQ_FILE"

# F1 fix: model name travels via env var, prompt via stdin (herestring, not a heredoc --
# a heredoc at this call site would override stdin, same reason gemini-offload-call.sh's
# redactor cannot be a heredoc either). Neither value is ever spliced into Python source text.
_REQ_PY="$(mktemp)"
chmod 0600 "$_REQ_PY"
cat > "$_REQ_PY" << 'PYEOF'
import json, os, sys
prompt = sys.stdin.read()
request = {
    "model": os.environ["FREELLM_MODEL_VALUE"],
    "messages": [{"role": "user", "content": prompt}],
    "temperature": 0,
    "max_tokens": 2000
}
print(json.dumps(request))
PYEOF
FREELLM_MODEL_VALUE="$FREELLM_MODEL" python3 -I "$_REQ_PY" <<< "$PROMPT" > "$REQ_FILE"
if [[ ! -s "$REQ_FILE" ]]; then
  exit 1  # request body build failed
fi

# F5 (WhiteHat2 MEDIUM): Authorization header from the key source, never argv. Same
# session-token-file convention as store/freellm-catalog-sync.sh (card 08d1aa90 owns the
# login/refresh flow for that token; this script only reads the cached value). Header goes
# in a 0600 file passed to curl via -H @file, so it never appears in /proc/<pid>/cmdline.
if [[ ! -r "$FREELLM_AUTH_TOKEN_FILE" ]]; then
  exit 2  # no auth token available: fail-closed as unconfigured, no network attempt
fi
AUTH_TOKEN="$(tr -d '\n' < "$FREELLM_AUTH_TOKEN_FILE")"
if [[ -z "$AUTH_TOKEN" ]]; then
  exit 2
fi
AUTH_HDR="$(mktemp)"
chmod 0600 "$AUTH_HDR"
printf 'Authorization: Bearer %s\n' "$AUTH_TOKEN" > "$AUTH_HDR"

# Call API (localhost, 127.0.0.1 only)
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$TMPOUT" -X POST \
  "$FREELLM_API_BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -H @"$AUTH_HDR" \
  --data @"$REQ_FILE" \
  --connect-timeout 5 \
  --max-time "$TIMEOUT" 2>"$TMPERR")

# ---- handle API response ---------------------------------------------------------------
case "$HTTP_CODE" in
  200)
    # Extract the generated text from OpenAI-compatible response. The file path travels via
    # env var (F1 fix), not spliced into source text; no prompt data is read here so a
    # quoted heredoc (no stdin needed) is safe.
    FREELLM_RESPONSE_FILE_PATH="$TMPOUT" python3 -I << 'PYEOF'
import json, os
try:
    with open(os.environ["FREELLM_RESPONSE_FILE_PATH"], 'r') as f:
        response = json.load(f)
    print(response['choices'][0]['message']['content'])
except (json.JSONDecodeError, KeyError, IndexError):
    exit(1)
PYEOF
    exit 0
    ;;
  401|403)
    # Auth failure
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
