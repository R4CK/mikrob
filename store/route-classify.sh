#!/usr/bin/env bash
# route-classify.sh -- stage 1 of the two-stage router (card 05f8d99c, EPIC ebc7b4dd / T3).
#
# WHAT IT IS FOR. The deterministic blocklist is a keyword machine, and five rounds of NO-GOs showed
# what that costs: `login` missing, isolation words missing, predictability words missing, camelCase
# hidden, crypto-weakness missing. Each was fixed; each was the same shape. Cybersec then produced
# five REAL RBAC questions that no list caught at all -- "Restrict the payroll export to the finance
# team", "Give admins the ability to impersonate a user" -- because they name no security noun.
# A semantic class cannot be closed by enumerating words, so this asks the local model instead.
#
# THE SAFETY PROPERTY, and it is the whole design: this classifier may only move a task
# LOCAL -> ONLINE. It is never consulted to make something local that the deterministic rules called
# online. So a wrong answer, a hung model, a missing model or a first-run machine with nothing
# installed can COST an online draft -- it can never open a hole. Everything below fails in that
# direction on purpose.
#
# MEASURED BEFORE BUILDING (2026-08-13, qwen2.5-coder 7B q4_K_M on this host):
#   zero-shot, one-line prompt : 2/5 on Cybersec's own security sentences -- would have been worse
#                                than useless, because an "intelligent" component invites trust
#   few-shot prompt (this one) : 9/9 on that set, and 10/10 on a HELD-OUT set the prompt never saw
#                                (5 security, 5 mechanical, none paraphrased from the examples)
# The binding constraint was the PROMPT, not the model. The held-out run is the one that counts:
# the tuned score is partly memorisation, since three of the examples are the test sentences.
#
# Usage: route-classify.sh "<task description>"
#   prints SECURITY | MECHANICAL | UNKNOWN   (exit 0 always -- the caller decides, see above)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXT="${1:-}"
TIMEOUT="${ROUTE_CLASSIFY_TIMEOUT:-45}"
LLM="${ROUTE_CLASSIFY_LLM:-$HERE/local-llm.sh}"

[ -n "${TEXT// }" ] || { echo UNKNOWN; exit 0; }

# Only the first 600 characters. The decision is about what the task IS, and on this board the tail
# of a card is postmortem quotes, gate prose and log excerpts -- the same noise that made the keyword
# matcher fire on the fleet's own dialect.
SHORT="$(printf '%s' "$TEXT" | tr '\n' ' ' | head -c 600)"

OUT="$(timeout "$TIMEOUT" bash "$LLM" --task route-triage --caller route-classify --source routing \
        "$SHORT" 2>/dev/null | tr -dc 'A-Za-z' | tr '[:lower:]' '[:upper:]')"

case "$OUT" in
  *SECURITY*)   echo SECURITY ;;
  *MECHANICAL*) echo MECHANICAL ;;
  # No model, no answer, a timeout, or anything unparseable. UNKNOWN means "this stage abstains",
  # and the caller keeps the deterministic verdict -- which is what a first-run machine with no
  # model installed will hit on every single call, by design.
  *)            echo UNKNOWN ;;
esac
exit 0
