#!/usr/bin/env bash
# skill-dispatch-hint.selftest.sh -- direct unit coverage for skill_dispatch_hint() (card 2f5caa6f).
# Uses a SYNTHETIC CLAUDE.md fixture, not a real agent's, so the test pins the matching behaviour
# itself rather than today's roster -- the same reasoning card-decompose-templates.selftest.sh
# gives for testing its pure function directly instead of only through a wrapper.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./skill-dispatch-hint.sh
. "$HERE/skill-dispatch-hint.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

PASS=0
FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $desc"
    echo "  want: $want"
    echo "  got:  $got"
  fi
}

mkdir -p "$TMPDIR/agents/fixture-agent"
cat > "$TMPDIR/agents/fixture-agent/CLAUDE.md" <<'EOF'
# Fixture Agent

## Szerep
Prose that must NOT be scanned as a skill entry.

## Core skilljeid (MikroB altal hozzarendelve)

- `engineering-standards` -- a nem-alkudhato mernoki baseline minden prod kodhoz
- `tenant-pure-domain` -- pure domain modul injektalt portokkal es tenant-scope invarians
- `threat-modeling` -- STRIDE a designra, mielott epitesz
- `karpathy-guidelines` -- KOTELEZO minden kodolasi kartyanal

## Masik szekcio
- `not-a-core-skill` -- ez a szekcion kivul all, nem szamit
EOF

hint_for() {
  MARVEEN_MAIN="$TMPDIR" skill_dispatch_hint "fixture-agent" "$1" | paste -sd, -
}

# --- a card whose text overlaps exactly one skill's description picks that one -------------------
check "matches tenant-pure-domain on 'tenant-scope' + 'domain'" \
  "$(hint_for 'Uj tenant-scope domain modul kell egy uj endpointhoz.')" \
  "tenant-pure-domain"

# --- a card matching two skills returns both, higher-overlap first -------------------------------
check "matches both threat-modeling and engineering-standards, ordered by overlap" \
  "$(hint_for 'Design STRIDE elemzes mielott epitesz, mernoki baseline is kell.')" \
  "threat-modeling,engineering-standards"

# --- unrelated prose matches nothing -------------------------------------------------------------
check "no match on unrelated prose returns nothing" \
  "$(hint_for 'Ez egy sima Telegram szoveg a reggeli napindtorohoz, semmi kozos szo.')" \
  ""

# --- a skill listed OUTSIDE the Core skilljeid section is never a candidate ----------------------
check "a skill outside the section is ignored even on a perfect keyword match" \
  "$(hint_for 'not-a-core-skill szekcion kivul all nem szamit')" \
  ""

# --- unknown agent (no CLAUDE.md) -> empty, not an error ------------------------------------------
check "unknown agent with no CLAUDE.md returns nothing, does not error" \
  "$(MARVEEN_MAIN="$TMPDIR" skill_dispatch_hint "no-such-agent" "anything" | paste -sd, -)" \
  ""

# --- same input twice -> same output (determinism, the whole point of the design) -----------------
first="$(hint_for 'Design STRIDE elemzes mielott epitesz, mernoki baseline is kell.')"
second="$(hint_for 'Design STRIDE elemzes mielott epitesz, mernoki baseline is kell.')"
check "identical input yields identical output on repeat calls" "$first" "$second"

echo "skill-dispatch-hint.selftest.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
