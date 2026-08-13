#!/usr/bin/env bash
# route-classify-selftest.sh -- acceptance for the two-stage router (card 05f8d99c).
#
# Cybersec's acceptance requirement, verbatim: the five regression sentences, at least two negative
# controls, and a BEFORE/AFTER measurement on the same sentence set. Their methodological point is
# the reason this file exists at all: "the full suite is NOT enough -- it only catches what already
# has a pinned test", so the measurement has to run on sentences held OUTSIDE the suite.
#
# BEFORE = the deterministic router alone (ROUTE_CLASSIFY=0).
# AFTER  = deterministic + stage-1 classifier.
# The five sentences are Cybersec's own, produced against the keyword rules AFTER five rounds of
# fixes -- they name no security noun, which is why no list caught them.
#
# HELD-OUT block: five sentences the route-triage prompt has never seen, in either direction. The
# tuned score is partly memorisation (three of the prompt's examples ARE test sentences); the
# held-out score is the one that means anything.
#
# Needs a running local model. With none, every classifier call abstains (UNKNOWN) and the AFTER
# column collapses onto BEFORE -- which is the designed first-run behaviour, and this script says so
# rather than reporting a false pass.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0

route() { # $1 = sentence, $2 = 1|0 stage-1 on/off  -> prints local|online
  local out
  out="$(ROUTE_CLASSIFY="$2" timeout 200 bash "$HERE/local-llm-rag.sh" "$1" 2>&1 >/dev/null | grep -o 'ROUTE=[a-z]*' | tail -1)"
  echo "${out#ROUTE=}"
}

if [ "$(bash "$HERE/route-classify.sh" 'Which roles may approve a shift?')" = "UNKNOWN" ]; then
  echo "SKIP: no local model answering -- stage 1 abstains, so AFTER would equal BEFORE by design."
  echo "      (that IS the documented first-run behaviour; this is not a pass and not a failure)"
  exit 0
fi

echo "two-stage router acceptance (BEFORE = deterministic only, AFTER = + stage 1)"
printf '%-58s %-8s %-8s %s\n' 'sentence' 'BEFORE' 'AFTER' 'verdict'

check() { # $1 = sentence, $2 = expected AFTER
  local b a v
  b="$(route "$1" 0)"; a="$(route "$1" 1)"
  if [ "$a" = "$2" ]; then v=ok; else v=FAIL; fail=1; fi
  printf '%-58s %-8s %-8s %s\n' "$(echo "$1" | cut -c1-58)" "$b" "$a" "$v"
}

echo "-- Cybersec's five (must end ONLINE) --"
check 'Restrict the payroll export to the finance team.' online
check 'Give admins the ability to impersonate a user.' online
check 'Should crew leads have access to other crews aggregate stats?' online
check 'Limit who can override the terminal-state guard.' online
check 'Which users can assign themselves to a crew?' online

echo "-- negative controls (must stay LOCAL) --"
check 'Add a helper that formats a duration in minutes as h:mm.' local
check 'Rename the approve button label to Accept.' local
check 'reduce the token cost of the nudge prompt' local

echo "-- HELD OUT: the prompt has never seen these --"
check 'Who is allowed to void an invoice after it is paid?' online
check 'Store the reset code hashed or in plain text?' online
check 'Add pagination to the equipment list page.' local
check 'Split the 400-line component into three files.' local

[ $fail -eq 0 ] && { echo "acceptance: PASS"; exit 0; } || { echo "acceptance: FAIL"; exit 1; }
