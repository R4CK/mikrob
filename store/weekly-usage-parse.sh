#!/usr/bin/env bash
# weekly-usage-parse.sh -- PURE parse helpers for a captured `/usage` screen (card a91c6039).
#
# No tmux, no network: given the captured /usage text, extract each section's percentage + reset
# label (Current session, Current week (all models), Current week (Fable)) and the +50% weekly
# promo line, then emit the enriched snapshot JSON body for POST /api/costs/weekly.
#
# Sourced by weekly-usage-panel-read.sh (which drives the panel + POSTs). Kept separate so the
# parse can be unit-tested standalone against sample captures (store/__tests__).
#
# Format assumptions (from the real /usage screen): each section header line ("Current session",
# "Current week (all models)", "Current week (Fable)") is followed by a bar line containing
# "N% used" and a "Resets ..." line. A section ends at the next "Current ..." header, so one bar
# never bleeds into another.

# wu_pct_of <capture> <section-header-regex> -> prints the integer % (or nothing).
wu_pct_of() {
  printf '%s\n' "$1" | awk -v hdr="$2" '
    $0 ~ hdr {found=1; next}
    found && /Current (session|week)/ {exit}
    found && match($0, /([0-9]+)% used/, m) {print m[1]; exit}
  '
}

# wu_reset_of <capture> <section-header-regex> -> prints the reset label (or nothing).
wu_reset_of() {
  printf '%s\n' "$1" | awk -v hdr="$2" '
    $0 ~ hdr {found=1; next}
    found && /Current (session|week)/ {exit}
    found && /Resets/ {sub(/^[[:space:]]*Resets[[:space:]]*/, ""); print; exit}
  '
}

# wu_promo_of <capture> -> prints the first weekly-promo line (e.g. "+50% ... through Aug 19").
wu_promo_of() {
  printf '%s\n' "$1" | grep -iE '\+[0-9]+%.*(week|through)|extra.*week' | head -n1 |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

# wu_body <capture> <note> -> echoes the enriched JSON body, or returns 1 if the REQUIRED weekly
# (all models) bar is absent (fail-closed: the caller must not POST a garbage/partial snapshot).
wu_body() {
  local snap="$1" note="$2"
  local pct reset session_pct session_reset fable_pct fable_reset promo
  pct="$(wu_pct_of "$snap" 'Current week [(]all models[)]')"
  case "$pct" in
    '' | *[!0-9]*) return 1 ;;
  esac
  if [ "$pct" -lt 0 ] || [ "$pct" -gt 100 ]; then return 1; fi
  reset="$(wu_reset_of "$snap" 'Current week [(]all models[)]')"
  session_pct="$(wu_pct_of "$snap" 'Current session')"
  session_reset="$(wu_reset_of "$snap" 'Current session')"
  fable_pct="$(wu_pct_of "$snap" 'Current week [(]Fable[)]')"
  fable_reset="$(wu_reset_of "$snap" 'Current week [(]Fable[)]')"
  promo="$(wu_promo_of "$snap")"
  SESSION_PCT="$session_pct" SESSION_RESET="$session_reset" \
    FABLE_PCT="$fable_pct" FABLE_RESET="$fable_reset" PROMO="$promo" \
    python3 -c "
import json, os, sys
def metric(p, r):
    try: p = int(p)
    except (TypeError, ValueError): return None
    if p < 0 or p > 100: return None
    return {'pct': p, 'resetAt': (r or None)}
out = {'pct': int(sys.argv[1]), 'resetAt': (sys.argv[2] or None), 'note': sys.argv[3], 'source': 'panel'}
s = metric(os.environ.get('SESSION_PCT'), os.environ.get('SESSION_RESET'))
if s: out['session'] = s
f = metric(os.environ.get('FABLE_PCT'), os.environ.get('FABLE_RESET'))
if f: out['fable'] = f
promo = (os.environ.get('PROMO') or '').strip()
if promo: out['promo'] = promo
print(json.dumps(out))
" "$pct" "${reset:-}" "$note"
}
