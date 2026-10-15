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

# ---- temp files + trap (F4: trap before mktemp, card a92e9913) -----------------
# All temp-file variables are initialised to empty so the trap is safe even if a
# mktemp call below never runs (e.g. early exit on missing vault key).
_REDACT_PY="" TMPOUT="" TMPERR="" API_HDR="" REQ_FILE=""
trap 'rm -f "$_REDACT_PY" "$TMPOUT" "$TMPERR" "$API_HDR" "$REQ_FILE"' EXIT

# ---- prompt redaction ----------------------------------------------------------
# FAIL-CLOSED (F2, WhiteHat2, card a92e9913): if the prompt contains ANY secret-shaped
# token the script exits 2 ("no draft") WITHOUT sending anything to the external API.
# Redaction error also exits 2.  This is intentionally strict: a false positive means
# one leaf gets no Gemini draft, a false negative leaks a secret.
#
# The Python script is written to a 0600 temp file so redact_prompt() can call
# `python3 "$file"` with the text on stdin.  The heredoc approach (python3 - <<'EOF')
# cannot work inside a function: the heredoc overrides stdin, so sys.stdin.read()
# always returns empty string when text is piped in.
_REDACT_PY="$(mktemp)"
chmod 0600 "$_REDACT_PY"
cat > "$_REDACT_PY" << 'PYEOF'
import re, sys, unicodedata

text = sys.stdin.read()

# F1 (WhiteHat NO-GO, komment 17848, card e87e7520): the N1 fix normalized title/desc in
# offload-dispatch.sh's is_gemini_blocked() (layer 1, the content gate), but THIS layer (the
# scanner that sees the raw text actually sent to Gemini) never normalized at all -- an
# obfuscated KEY NAME (fullwidth, zero-width-interspersed, or homoglyph letters) stopped the
# SECRET_PATTERNS keyword alternation (password|secret|token|...) from matching, letting the
# real VALUE through unredacted. Mirrors the homoglyph table + fold logic in
# offload-dispatch.sh is_gemini_blocked (kept as a second copy, not a shared import, to avoid
# new cross-script path plumbing for one small function -- same tradeoff the SECRET_PATTERNS
# comment above already documents against src/security/secret-gate.ts).
_HOMOGLYPH_MAP = str.maketrans({
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
    "і": "i", "ѕ": "s", "һ": "h", "ԃ": "d", "ɡ": "g", "ⅰ": "i",
})

# C2 (card 33047d3f): U+2800 BRAILLE PATTERN BLANK is visually invisible but its category
# (So, Symbol-other) is too broad to strip wholesale (it also covers visible symbols like
# dingbats/chess pieces) -- stripped by exact codepoint instead.
_INVISIBLE_CODEPOINTS = {"⠀"}

# card f6f67dff R2c (RedHat 3. kor, komment 19300): the category strip above (Mn/Cf/Cc/Zl/Zp)
# misses the Default_Ignorable_Code_Point ranges that are UNASSIGNED (category Cn) -- a Cn
# codepoint spliced into a key breaks the SECRET_PATTERNS contiguous-charset match without
# being stripped, which is a real leak on THIS redactor (measured directly via --redact-test,
# not just titok-kapu.py's git-commit gate). Mirrors titok-kapu.py's
# _DEFAULT_IGNORABLE_TARTOMANYOK (same ranges, same E0FFF-corrected upper bound).
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
    """NFKD-decompose (fullwidth/compat chars -> plain ASCII) + homoglyph-map, then strip
    combining marks, invisible formatting chars (zero-width space/joiner etc, category Mn/Cf),
    control chars (Cc -- C1, card 33047d3f: an ASCII control byte spliced into a keyword is
    already ascii and survives untouched otherwise, splitting the word), line/paragraph
    separators (Zl/Zp -- C2, card 33047d3f: U+2028/U+2029), the braille-blank invisible char
    above, and the unassigned Default_Ignorable ranges (card f6f67dff R2c). Case is preserved
    so case-sensitive patterns (AKIA..., sk-ant-...) still work. Matching runs on this folded
    text; the ORIGINAL text is what gets sent to Gemini if clean -- normalization only widens
    what we catch, it never changes what we send."""
    s = s.translate(_HOMOGLYPH_MAP)
    s = unicodedata.normalize("NFKD", s)
    return "".join(
        ch for ch in s
        if unicodedata.category(ch) not in ("Mn", "Cf", "Cc", "Zl", "Zp")
        and ch not in _INVISIBLE_CODEPOINTS
        and not _is_default_ignorable(ch)
    )

# F2 (same komment): fail-closed if a script/homoglyph our table does not cover remains after
# folding -- the table is a convenience, not the guarantee. Mirrors has_unmapped_letter() in
# offload-dispatch.sh is_gemini_blocked.
def _has_unmapped_letter(s):
    decomposed = unicodedata.normalize("NFKD", s.translate(_HOMOGLYPH_MAP))
    return any(ord(ch) > 127 and unicodedata.category(ch).startswith("L") for ch in decomposed)

if _has_unmapped_letter(text):
    sys.stderr.write('gemini-offload-call: unmapped non-ASCII letter in prompt (fail-closed), not sending\n')
    sys.exit(2)

scan_text = _fold(text)

# Secret-detection patterns (mirrors src/security/secret-gate.ts SECRET_PATTERNS).
# First: DETECT (fail-closed) -- if any pattern fires, exit 2 without printing.
# EXTENDED (RedHat 17510 finding 4): the previous 18-pattern list missed 19 of 39 tested
# secret-shaped tokens -- mostly provider formats that were never covered (Anthropic, OpenAI
# session keys, Azure, Twilio, SendGrid, npm, Docker Hub, DigitalOcean, Firebase, Cloudflare,
# PayPal/Stripe publishable keys, Discord bot tokens, SSH key fingerprints) and generic
# high-entropy long-token shapes. Each addition is its own line so a future miss is one
# line to add, not a rewrite.
SECRET_PATTERNS = [
    # PEM private key blocks (any kind, not just "PRIVATE KEY" -- also OPENSSH, RSA, EC, DSA)
    (r'-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|OPENSSH PRIVATE KEY)-----', 'privkey'),
    # SSH public key fingerprint-bearing lines (still identifies a specific keypair/host)
    (r'\bssh-(rsa|ed25519|dss) [A-Za-z0-9+/]{40,}={0,2}', 'ssh_pubkey'),
    # Stripe / generic sk_live / sk_test / sk- / sk_
    (r'\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}', 'sk_live'),
    (r'\bsk[-_][A-Za-z0-9_-]{24,}', 'sk_generic'),
    (r'\bsk-proj-[A-Za-z0-9_-]{20,}', 'sk_proj'),
    # Anthropic API key
    (r'\bsk-ant-[A-Za-z0-9_-]{20,}', 'anthropic'),
    # ElevenLabs
    (r'(?i)xi-api-key["\'\s:=]+[A-Za-z0-9_-]{16,}', 'elevenlabs'),
    # Bearer token. WhiteHat2 H2 (card 40d2a253): an 8-char floor missed short real-world tokens
    # (test/staging keys, short API gateway tokens) -- lowered to 4, still well above any English
    # word that could follow "Bearer" in ordinary prose.
    (r'(?i)\bBearer\s+[A-Za-z0-9_\-.=+/]{4,}', 'bearer'),
    # JWT
    (r'\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}', 'jwt'),
    # GitHub tokens
    (r'\bgh[pousr]_[A-Za-z0-9]{30,}', 'github'),
    # Slack tokens
    (r'\bxox[baprs]-[A-Za-z0-9-]{10,}', 'slack'),
    # AWS access key + secret key assignment
    (r'\bAKIA[0-9A-Z]{16}\b', 'aws'),
    (r'(?i)aws_secret_access_key["\'\s:=]+[A-Za-z0-9/+=]{30,}', 'aws_secret'),
    # Supabase
    (r'\bsbp_[0-9a-f]{40}\b', 'supabase'),
    # Google API key / OAuth
    (r'\bAIza[0-9A-Za-z_-]{20,}', 'google'),
    (r'\b[0-9]+-[0-9A-Za-z_-]{32}\.apps\.googleusercontent\.com\b', 'google_oauth'),
    # Telegram bot token
    (r'\b\d{8,12}:[A-Za-z0-9_-]{35,}\b', 'telegram'),
    # Twilio
    (r'\bSK[0-9a-f]{32}\b', 'twilio'),
    (r'\bAC[0-9a-f]{32}\b', 'twilio_sid'),
    # SendGrid
    (r'\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}', 'sendgrid'),
    # npm access token
    (r'\bnpm_[A-Za-z0-9]{36}\b', 'npm'),
    # Docker Hub personal access token
    (r'\bdckr_pat_[A-Za-z0-9_-]{20,}\b', 'dockerhub'),
    # DigitalOcean
    (r'\bdop_v1_[a-f0-9]{64}\b', 'digitalocean'),
    # Discord bot token
    (r'\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b', 'discord'),
    # Cloudflare API token
    (r'(?i)cloudflare[_-]?(api[_-]?)?token["\'\s:=]+[A-Za-z0-9_-]{30,}', 'cloudflare'),
    # Azure connection string / key
    (r'(?i)AccountKey=[A-Za-z0-9+/]{40,}={0,2}', 'azure'),
    # .env KEY=value (indented, export, or plain; value >= 8 non-space chars)
    (r'(?m)^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]+=\S{8,}', 'env'),
    # inline credential assignments (password=, secret=, api_key= ...). WhiteHat2 H3 (card
    # 40d2a253) found two gaps: (a) JSON-style `"apiKey": "..."` has a closing quote on the KEY
    # itself right before the separator ("apiKey"<HERE>: "value") -- the old pattern required the
    # separator immediately after the key name, so the stray quote broke the match; fixed with an
    # optional `["\']?` right after the key name. (b) a quoted value containing spaces (`secret:
    # "my secret value"`) didn't match the old unquoted charset (no space in it); fixed by matching
    # a quoted value as "anything but that quote char, >=8 chars" instead of the narrow charset.
    # (c) WhiteHat2 H3 remainder (card e87e7520): \b treats "_" as a word char, so \bsecret never
    # matched the "secret" inside APP_SECRET or auth_token (no boundary between "_" and the next
    # letter). Fixed with a negative lookbehind that excludes only letters/digits -- "_" now acts
    # as a boundary while "mysecretsauce" (a letter right before "secret") still does not match.
    # F3 (WhiteHat NO-GO, komment 17848, card e87e7520): the (c) lookbehind still missed a
    # camelCase key name (apiToken:, dbPassword:) -- no "_" and no non-alnum char precedes the
    # keyword there, only a lowercase letter immediately followed by the keyword's uppercase
    # first letter. Added a second boundary alternative for exactly that transition; the
    # keyword alternation itself stays scoped case-insensitive ((?i:...)) so the boundary's
    # own case-sensitive lookahead ((?=[A-Z])) keeps working. "mysecretsauce" still does not
    # match: lowercase "s" follows lowercase "y", neither boundary alternative is satisfied.
    (r'((?<![A-Za-z0-9])|(?<=[a-z0-9])(?=[A-Z]))(?i:password|passwd|secret|token|api[_-]?key|auth[_-]?key|access[_-]?key)["\']?[=:\s]+'
     r'(?:"[^"\n]{8,}"|\'[^\'\n]{8,}\'|[A-Za-z0-9_\-.=+/]{8,})', 'cred'),
    # Database URLs with embedded password
    (r'(?i)(postgres|mysql|mongodb|redis)://[^:]+:[^@]{4,}@', 'dburl'),
    # Basic auth header
    (r'(?i)\bBasic\s+[A-Za-z0-9+/=]{8,}', 'basic'),
    # Long hex secrets (32+ consecutive hex chars, either case)
    (r'(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])', 'hex32'),
    # Long base64-shaped opaque blob (40+ chars, mixed case + digits, no spaces -- generic
    # high-entropy token shape not covered by a provider-specific pattern above)
    (r'(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])', 'opaque_token'),
    # N5 (RedHat 17653, card e87e7520): 9 secret/PII shapes that reached Gemini unblocked.
    # AWS temporary-credential (STS) key id -- same shape as AKIA but for session tokens.
    (r'\bASIA[0-9A-Z]{16}\b', 'aws_asia'),
    # Google OAuth refresh token ("1//0...")
    (r'\b1//0[A-Za-z0-9_-]{20,}\b', 'google_refresh'),
    # Cookie: ...session...=<value> header -- not caught by the line-start .env pattern because
    # "Cookie:" precedes the key= assignment instead of starting the line.
    (r'(?i)\bcookie:\s*[^\n]*?session[A-Za-z0-9_]*=[A-Za-z0-9%_.\-]{8,}', 'cookie_session'),
    # Stripe webhook signing secret
    (r'\bwhsec_[A-Za-z0-9]{16,}\b', 'stripe_whsec'),
    # Context-free base64url high-entropy token (opaque_token's URL-safe charset, "-"/"_" instead
    # of "+"/"/", no provider prefix to key on)
    (r'(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])', 'opaque_b64url'),
    # Prose form: "the token is <value>" (no "=" / ":" separator for the "cred" pattern to catch)
    (r'(?i)\bthe\s+token\s+is\s+[A-Za-z0-9_\-./+=]{8,}\b', 'prose_token'),
    # Prose form: "the password for the <thing> is <value>"
    (r'(?i)\bthe\s+password\s+for\s+the\s+\S+\s+is\s+\S{4,}\b', 'prose_password'),
]

for pattern, label in SECRET_PATTERNS:
    if re.search(pattern, scan_text, re.DOTALL):
        sys.stderr.write(f'gemini-offload-call: secret-shaped token ({label}) in prompt, not sending\n')
        sys.exit(2)  # fail-closed: no output, no send

# PII DECISION (RedHat 17510 finding 4: "a PII-dontes hianyzik"). Explicit scope, fail-closed
# the same way as a secret: a leaf's title/description is kanban metadata, never the right place
# for a person's email, phone number, or a Hungarian national ID -- if one is present, the card
# itself needs the PII tag (which already blocks it upstream in is_gemini_blocked), so finding
# one HERE means the upstream tag/content gate was bypassed or missed it. Same fail-closed
# response as a secret: exit 2, nothing sent.
PII_PATTERNS = [
    (r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', 'email'),
    # N5 (card e87e7520): parenthesized area code, e.g. "+36 (30) 123-4567" -- the old charset
    # had no "(" / ")", so this spaced-and-parenthesized form passed through.
    (r'(?<!\d)(\+36|06)[ -]?\(?\d{1,2}\)?[ -]?\d{3}[ -]?\d{4}\b', 'hu_phone'),
    # Hungarian TAJ (social security) number: 9 digits, grouped 3-3-3
    (r'\b\d{3}[ -]?\d{3}[ -]?\d{3}\b(?=.{0,20}(?i:taj))|(?i:taj)[^\n]{0,20}?\b\d{3}[ -]?\d{3}[ -]?\d{3}\b', 'hu_taj'),
    # Hungarian tax number (adoszam): 8 digits - 1 - 2 digits
    (r'\b\d{8}-\d-\d{2}\b', 'hu_adoszam'),
    # Credit card number shape (13-19 digits, optionally grouped in 4s)
    (r'\b(?:\d[ -]?){13,19}\b', 'cc_number'),
    # N5: bare/unlabeled IBAN (2-letter country code + 2 check digits + up to 30 alnum)
    (r'\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b', 'iban'),
]

for pattern, label in PII_PATTERNS:
    if re.search(pattern, scan_text, re.DOTALL):
        sys.stderr.write(f'gemini-offload-call: PII-shaped content ({label}) in prompt, not sending\n')
        sys.exit(2)  # fail-closed: no output, no send

# Clean: print the text unchanged (no redaction needed -- it passed all detectors).
print(text, end='')
PYEOF

redact_prompt() {
  # F-E delta (card f6f67dff, RedHat R3, komment 19135): -I (isolated mode) ignores PYTHONPATH,
  # so an ambient shadow module (e.g. a fake re.py) cannot silently defeat the redactor -- the
  # same fix the card already applied to seged-hivo.py/gemini-agy-call.sh, closed here too.
  python3 -I "$_REDACT_PY"
}

# redact-test: run redact_prompt on stdin/arg and exit WITHOUT touching vault (test hook, card a92e9913 B2)
# Exit code is propagated: 0=clean, 2=secret found (fail-closed), 1=other error.
if [[ "${1:-}" == "--redact-test" ]]; then
  shift
  PROMPT="${*:-$(cat)}"
  printf '%s' "$PROMPT" | redact_prompt; _rc="${PIPESTATUS[1]}"
  exit "$_rc"
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
# F2 (fail-closed): redact_prompt exits 2 when a secret-shaped token is found.
# Redaction error (non-zero, non-2) also aborts -- we never send on uncertainty.
if [[ $? -ne 0 ]]; then
  echo "gemini-offload-call: prompt blocked by secret detector (fail-closed), no draft" >&2
  exit 2
fi

# ---- build request body --------------------------------------------------------
# F3 (WhiteHat2, card a92e9913): write the request body to a 0600 temp file and
# pass it to curl with --data-binary @file so it never appears in /proc/<pid>/cmdline.
TMPOUT="$(mktemp)"
TMPERR="$(mktemp)"
# Write API key to a 0600 header file so it never appears in /proc/<pid>/cmdline (card a92e9913 B3).
API_HDR="$(mktemp)"
chmod 0600 "$API_HDR"
printf 'x-goog-api-key: %s\r\n' "$API_KEY" > "$API_HDR"
REQ_FILE="$(mktemp)"
chmod 0600 "$REQ_FILE"
printf '%s' "$CLEAN_PROMPT" | python3 -I -c '
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
' > "$REQ_FILE"

# ---- call Gemini ---------------------------------------------------------------
http_status="$(curl -s -o "$TMPOUT" -w '%{http_code}' \
  --max-time "$TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -H @"$API_HDR" \
  "$GEMINI_API_BASE/models/$GEMINI_MODEL:generateContent" \
  --data-binary @"$REQ_FILE" 2>"$TMPERR")"

if [[ "$http_status" == "200" ]]; then
  # Extract text from the response
  text="$(python3 -I -c '
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
