#!/usr/bin/env bash
# card-decompose-templates.sh -- DETERMINISTIC mechanical-subtask-type detection from card text
# (card 501c489f, MikroB plan-grilling VERDIKT: GO-WITH-CHANGES, kanban komment 6007).
#
# THE FIX THIS ENABLES. card-build-route.sh's deterministic ONLINE gates (multi-decision, money,
# auth-tenant-scope, ...) route the WHOLE card online with zero local-model calls -- measured
# (card-build-route.log, last 446h): 50 ONLINE, 0 LOCAL, ~40 of the 50 were
# deterministic-multi-decision alone. But "the DECISION is online-only" and "NOTHING in this card
# can be drafted locally" are different claims -- a card can carry a genuine architecture decision
# AND a mechanical test-scaffold/i18n-string/README-entry/type-definition alongside it. This
# function is the SHARED classifier both card-build-route.sh (for measurement/logging) and
# offload-dispatch.sh (for the actual local-model attempt) call, so the two scripts can never
# disagree about what "decomposable" means.
#
# DETERMINISTIC ONLY, ON PURPOSE (requirement 1 of the verdict, verbatim): "A bontás ELSŐ köre
# DETERMINISZTIKUS sablonból jöjjön, ne a 7B javasolja... A modell-javasolt bontás csak egy második,
# flag mögötti réteg (alapból KI)." That second, model-suggested layer is NOT built by this card --
# it would be premature scope (rule 2, no unrequested configurability) for a layer nothing calls yet.
# This file is the whole first layer: pure keyword matching, same input -> same output always, which
# is what makes it mutation-testable at all (a model call is not).
#
# Usage: card_decompose_candidates "<full card text: title + description + tags>"
# Prints zero or more lines, "<type>\t<subtask task text>", to stdout. Pure, no side effects, no
# network, no exec of anything but grep. Callers cap the candidate count themselves (this always
# returns every match; the per-card ceiling is a dispatch-time policy, not a classification one).
set -uo pipefail

card_decompose_candidates() {
  local text="${1:-}"
  # test-scaffold: the card names tests. Deliberately narrow to the word itself, not "coverage" or
  # "CI" (those name the test-RUNNING machinery, which is multi-decision territory on its own).
  if printf '%s' "$text" | grep -Eqi '\btest(ek|s)?\b|teszt(ek|vaz)?\b|unit test'; then
    printf 'test-scaffold\tWrite the unit test scaffolding this card names (the test cases themselves, not the fix under test).\n'
  fi
  # i18n-keys: draft translated strings for an ALREADY-NAMED key list -- the decision (which keys,
  # which flow) is not this; the mechanical part is filling in wording for languages already spoken
  # elsewhere in the same file.
  if printf '%s' "$text" | grep -Eqi 'i18n|forditas|fordítás|lokaliz|translation|locale string'; then
    printf 'i18n-keys\tDraft the i18n key strings this card names, matching the existing wording style for the other locales.\n'
  fi
  # doc-update: a README / fork-development-section entry, per the README-maintenance rule's own
  # format (name + one tight sentence) -- mechanical once the feature/behaviour itself is decided.
  if printf '%s' "$text" | grep -Eqi 'readme|fork-fejleszt|dokumentaci|dokumentáci'; then
    printf 'doc-update\tDraft the README / fork-development-section entry this card names, following the repo'"'"'s existing one-line-per-feature format.\n'
  fi
  # type-def: a type/interface shape, no runtime logic. Deliberately does NOT match bare "schema" --
  # that word is already inside card-build-route.sh's OWN multi-decision gate (DB/migration territory),
  # and a type-def candidate must never re-open something the parent gate specifically closed.
  if printf '%s' "$text" | grep -Eqi '\btipus\b|\btípus\b|type definition|\binterface\b|typescript type'; then
    printf 'type-def\tDraft the TypeScript type/interface definition this card names, with no runtime logic attached.\n'
  fi
}
