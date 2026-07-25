#!/usr/bin/env bash
# weekly-usage-probe.sh -- attempt a PROGRAMMATIC read of the Claude "Weekly / All
# models" usage % via the account OAuth endpoint, and, on success, write the canonical
# store/weekly-limit-snapshot.json (source=oauth). Card c9ce4254 (Peti 2026-07-25:
# "automate the weekly-limit widget, don't hand-enter it").
#
# FEASIBILITY (re-verified FRESH 2026-07-25, NOT from memory -- the card demanded it):
#   The fleet token in marveen/.env is CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat0... (a coding/
#   inference OAuth token). Probed live:
#     GET https://api.anthropic.com/api/oauth/profile -> HTTP 403 permission_error
#         "OAuth token does not meet scope requirement any_of(user:profile, user:office)"
#         (request_ids req_011CdNBKErN4LuisGPQpX2uQ / req_011CdNBKFeEmYzMVLzfNp5yY)
#     GET .../api/oauth/usage -> HTTP 429 rate_limit_error under repeated probing (the
#         account endpoints share the same scope family; usage needs an account scope the
#         coding token does not carry).
#   => There is NO working programmatic source with the CURRENT token. Two unlocks, both
#      OUTSIDE an agent's authority (flagged to MikroB, see the card REVIEW):
#        (1) Peti re-issues the OAuth token WITH an account scope (user:profile/user:office)
#            -- if Anthropic grants it to a setup-token at all; then THIS script (already
#            Cybersec-hardened: token via 0600 @file, never argv) starts returning real
#            data and can be cron'd. (2) A MikroB-run terminal `/usage` parse (Peti
#            2026-07-25 clarified it is `/usage`, not `/status`, that renders the weekly
#            All-models bar) from a DEDICATED subscription-authed spare panel -- NOT a
#            fleet-agent panel (sending keys there disrupts its work), and NOT the
#            mikrob-worker (API-auth: its `/usage` shows only activity characteristics,
#            not the subscription weekly bar). Role agents are governance-blocked from
#            `tmux send-keys`, so this panel-parse path is MikroB-only.
#
# DESIGN: forward-compatible + fail-safe. On a real 200 with a parseable weekly %, it
# writes the snapshot atomically and prints OK. On ANY failure (scope/auth/ratelimit/
# network/parse) it prints the exact reason + request_id and exits non-zero WITHOUT
# touching the snapshot -- so a cron never overwrites the operator's manual value with a
# fake or stale one. Secrets: the token is read from .env at call time and NEVER printed.
#
# Usage:  bash store/weekly-usage-probe.sh            # probe + (on success) write snapshot
#         bash store/weekly-usage-probe.sh --dry-run  # probe + report only, never write
set -euo pipefail

MARVEEN="/home/neon/marveen"
ENV_FILE="${MARVEEN}/.env"
SNAPSHOT="${MARVEEN}/store/weekly-limit-snapshot.json"
USAGE_URL="https://api.anthropic.com/api/oauth/usage"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# --- token (env wins; else .env). Never echoed. -----------------------------------
TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then
  TOKEN="$(sed -nE 's/^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN[[:space:]]*=[[:space:]]*"?([^"[:space:]]+)"?.*/\1/p' "$ENV_FILE" | head -n1)"
fi
if [ -z "$TOKEN" ]; then
  echo "FAIL: no CLAUDE_CODE_OAUTH_TOKEN (env or ${ENV_FILE})." >&2
  exit 2
fi

# --- probe (separate body + status so we never interpolate the token) ---------------
# SECURITY: the Authorization header goes through a 0600 temp file read with curl's
# `-H @file`, NEVER on the curl argv. A header on the command line would land in the
# process's /proc/<pid>/cmdline (world-readable on this host: no hidepid) and `ps`, so
# any local user -- even one who cannot read the 0600 .env -- could scrape the live
# token during the probe window. That would break the fleet's binding rule
# ("token SOHA nem argv-be/logba"). curl reads `@file` headers since 7.55.
tmp_body="$(mktemp)"
hdr_file="$(mktemp)"
trap 'rm -f "$tmp_body" "$hdr_file"' EXIT
chmod 600 "$hdr_file"
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$hdr_file"
http_code="$(curl -s -o "$tmp_body" -w '%{http_code}' --max-time 20 \
  -H "@$hdr_file" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "User-Agent: cleancore-fleet-weekly-usage-probe/1.0" \
  "$USAGE_URL" || echo "000")"

if [ "$http_code" != "200" ]; then
  # Surface the coded reason (redacting any token-ish substrings), never the token.
  reason="$(sed -E 's/sk-ant-[A-Za-z0-9_-]{6,}/sk-ant-<REDACTED>/g' "$tmp_body" | tr -d '\n' | cut -c1-300)"
  echo "FAIL: usage endpoint HTTP ${http_code}. body: ${reason}" >&2
  echo "-> programmatic weekly-% NOT available with the current token scope; the manual snapshot is authoritative (src/costops/weekly-limit.ts). See the script header for the two unlocks." >&2
  exit 1
fi

# --- parse the weekly All-models percentage. The exact JSON shape is unknown until a
#     real 200 is seen (the token is blocked today), so we defensively scan a few likely
#     field names and FAIL rather than guess a wrong number. ------------------------
pct="$(python3 - "$tmp_body" <<'PY'
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(3)
def find(o,keys):
    if isinstance(o,dict):
        for k,v in o.items():
            if k.lower() in keys and isinstance(v,(int,float)): return float(v)
            r=find(v,keys)
            if r is not None: return r
    elif isinstance(o,list):
        for v in o:
            r=find(v,keys)
            if r is not None: return r
    return None
# candidate field names for the weekly all-models utilization percentage
v=find(d,{'weekly_percent','weekly_pct','all_models_percent','weeklyallmodelspercent','utilization','percent_used'})
if v is None: sys.exit(4)
print(round(max(0.0,min(100.0,v))*10)/10)
PY
)" || {
  echo "FAIL: usage endpoint returned 200 but no recognizable weekly-% field; refusing to write a guessed number." >&2
  exit 1
}

reset="$(python3 - "$tmp_body" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
def find(o,keys):
    if isinstance(o,dict):
        for k,v in o.items():
            if k.lower() in keys and isinstance(v,str): return v
            r=find(v,keys)
            if r: return r
    elif isinstance(o,list):
        for v in o:
            r=find(v,keys)
            if r: return r
    return None
print(find(d,{'weekly_reset','reset','resets_at','reset_at'}) or '')
PY
)"

if [ "$DRY_RUN" = "1" ]; then
  echo "OK (dry-run): weekly=${pct}% reset='${reset}' -- would write ${SNAPSHOT} (source=oauth)."
  exit 0
fi

# --- atomic write of the canonical snapshot (source=oauth) --------------------------
now="$(date +%s)"
tmp_out="$(mktemp)"
python3 - "$tmp_out" "$pct" "$reset" "$now" <<'PY'
import json,sys
out,pct,reset,now=sys.argv[1],float(sys.argv[2]),sys.argv[3],int(sys.argv[4])
json.dump({"pct":pct,"setAt":now,"source":"oauth","resetAt":(reset or None),"note":"auto (weekly-usage-probe.sh)"}, open(out,'w'), indent=2)
PY
mv -f "$tmp_out" "$SNAPSHOT"
echo "OK: wrote ${SNAPSHOT} weekly=${pct}% reset='${reset}' source=oauth."
