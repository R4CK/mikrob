#!/usr/bin/env bash
# gate-role.sh -- single source for the security-gate identifiers that skills must not spell out.
#
# Skills describe the gates by display name (WhiteHat / RedHat). The machine identifiers behind them
# (agent id, verdict keyword the parsers match on, board label) live here, so a skill resolves them
# at run time instead of carrying the literal strings (Peti, Telegram 10325, 2026-10-03). When the
# verdict parsers accept the WHITEHAT/REDHAT alias (card cf0a8c0b), only the `verdict` column below
# changes; every skill keeps working unchanged.
#
# Usage: gate-role.sh <role> <field>
#   role:  qa | qa2 | whitehat | redhat
#   field: agent   -- agent id (API author/from/agent_id, assignee, tmux session)
#          verdict -- the verdict keyword the gate's first comment line starts with
#                     (append " GO"/" NO-GO" for the security gates, " PASS"/" FAIL" for QA)
#          label   -- board label (@<agent>)
#          subagent -- Agent-tool subagent_type of the role
# Exit 2 on an unknown role/field (fail closed: an empty keyword would post an unparsable verdict).
set -euo pipefail

role="${1:-}"; field="${2:-}"
case "$role" in
  qa)       agent=qa;       verdict=QA;       subagent=qa-engineer ;;
  qa2)      agent=qa2;      verdict=QA;       subagent=qa-engineer ;;
  whitehat) agent=cybersec; verdict=CYBERSEC; subagent=cybersecurity-redteam ;;
  redhat)   agent=cybered;  verdict=CYBERED;  subagent=cybered ;;
  *) echo "gate-role.sh: unknown role '$role' (qa|qa2|whitehat|redhat)" >&2; exit 2 ;;
esac
case "$field" in
  agent)   printf '%s\n' "$agent" ;;
  verdict) printf '%s\n' "$verdict" ;;
  label)   printf '@%s\n' "$agent" ;;
  subagent) printf '%s\n' "$subagent" ;;
  *) echo "gate-role.sh: unknown field '$field' (agent|verdict|label|subagent)" >&2; exit 2 ;;
esac
