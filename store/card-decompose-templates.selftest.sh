#!/usr/bin/env bash
# card-decompose-templates.selftest.sh -- direct unit coverage for card_decompose_candidates() and
# decompose_type_disabled() (card d39fc5e7, requirement 3 wiring). Before this file, the only
# coverage for this script was indirect, through offload-dispatch.selftest.sh's
# --test-resolve-decompose hook -- useful for the wrapper's behaviour, but it could not exercise the
# classifier's own four patterns in isolation, nor the disabled-type gate this card adds (that gate
# lives entirely inside card_decompose_candidates(), so a test that only drives the wrapper would
# have to reconstruct a full kanban fixture just to flip one type off).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./card-decompose-templates.sh
. "$HERE/card-decompose-templates.sh"

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

types_for() { card_decompose_candidates "$1" | cut -f1 | paste -sd, - 2>/dev/null; }

# --- each pattern fires on its own trigger words, independent of the others ---------------------
check "test-scaffold fires on 'unit test'"      "$(types_for 'Kell hozza egy unit test.')"              "test-scaffold"
check "test-scaffold fires on magyar 'tesztvaz'" "$(types_for 'Irjunk egy tesztvaz-at ehhez.')"            "test-scaffold"
check "i18n-keys fires on 'i18n'"               "$(types_for 'Az i18n stringeket is kell frissiteni.')" "i18n-keys"
check "i18n-keys fires on magyar 'forditas'"    "$(types_for 'A forditas hianyzik a de locale-hoz.')"   "i18n-keys"
check "doc-update fires on 'readme'"            "$(types_for 'A readme-t is frissitsd.')"               "doc-update"
check "type-def fires on 'interface'"           "$(types_for 'Kell egy uj interface a Widget-hez.')"    "type-def"
check "no pattern fires on unrelated prose"     "$(types_for 'Ez egy sima architektura dontes, semmi mechanikus resz nincs benne.')" ""

# --- multiple patterns in one text all fire, independently ---------------------------------------
multi="$(types_for 'Kell unit test, i18n string, readme bejegyzes es egy uj interface is.')"
check "all four fire together when all four trigger words are present" "$multi" "test-scaffold,i18n-keys,doc-update,type-def"

# --- decompose_type_disabled: missing state file -> not disabled (fail-open) ---------------------
NOFILE="$TMPDIR/does-not-exist.json"
DECOMPOSE_STOP_STATE_FILE="$NOFILE" bash -c ". '$HERE/card-decompose-templates.sh'; decompose_type_disabled test-scaffold"
check "missing state file -> decompose_type_disabled returns 1 (not disabled)" "$?" "1"

# --- decompose_type_disabled: state file present, type marked disabled ---------------------------
STATE="$TMPDIR/decompose-type-disabled.json"
cat > "$STATE" <<'EOF'
{"test-scaffold": {"judged": 10, "accepted": 1, "disabled": true, "updated_at": 1700000000},
 "i18n-keys": {"judged": 10, "accepted": 8, "disabled": false, "updated_at": 1700000000}}
EOF
DECOMPOSE_STOP_STATE_FILE="$STATE" bash -c ". '$HERE/card-decompose-templates.sh'; decompose_type_disabled test-scaffold"
check "disabled type -> decompose_type_disabled returns 0 (disabled)" "$?" "0"
DECOMPOSE_STOP_STATE_FILE="$STATE" bash -c ". '$HERE/card-decompose-templates.sh'; decompose_type_disabled i18n-keys"
check "enabled type in the same state file -> decompose_type_disabled returns 1" "$?" "1"
DECOMPOSE_STOP_STATE_FILE="$STATE" bash -c ". '$HERE/card-decompose-templates.sh'; decompose_type_disabled type-def"
check "a type absent from the state file -> decompose_type_disabled returns 1 (not disabled)" "$?" "1"

# --- MUTATION: a disabled type's trigger words no longer produce that candidate ------------------
disabled_run="$(DECOMPOSE_STOP_STATE_FILE="$STATE" types_for 'Kell unit test, i18n string, readme bejegyzes es egy uj interface is.')"
check "MUTATION: with test-scaffold disabled, the SAME multi-trigger text drops exactly that one type" \
  "$disabled_run" "i18n-keys,doc-update,type-def"

# --- CONTROL: without the disabled-state override, the exact same text behaves as before ---------
control_run="$(types_for 'Kell unit test, i18n string, readme bejegyzes es egy uj interface is.')"
check "CONTROL: the same text with no disabled-state env var still produces all four (proves the mutation above is the gate, not the text)" \
  "$control_run" "test-scaffold,i18n-keys,doc-update,type-def"

echo
echo "card-decompose-templates.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
