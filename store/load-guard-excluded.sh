#!/usr/bin/env bash
# Shared exclusion policy for EVERY load-guard throttle mechanism (cgroup_throttle, sigstop_freeze,
# and any future one). Extracted from load-guard-cgroup-target.sh (card d7a28a0a) when
# load-guard-sigstop-target.sh (card 2bfbf805, Feladat 3) needed the identical check: two throttle
# mechanisms independently re-typing "which sessions can never be a target" is exactly the kind of
# drift that quietly stops protecting one of them while the other still looks safe (see memory:
# sibling-guards-drift-check-the-wrapper-unwrap). One file, sourced by both.
#
# EXCLUSION IS HARDCODED, NOT CONFIGURABLE (KOCKAZAT #2 mitigation, phase 19f3bbb5 plan-grilling
# verdict): MikroB and the full gate-pool (qa/qa2/cybersec/cybered -- qa2 included even though the
# card's own prose only names qa, because rule 4/6a establish qa2 as an equal-standing QA-gate
# member for load-balancing) can never be a throttle target of ANY kind. A runtime config file
# cannot add or remove from this list.
#
# Usage: `. load-guard-excluded.sh` then call `is_excluded "$session_name"`.

EXCLUDED_SESSIONS=(agent-qa agent-qa2 agent-cybersec agent-cybered)

is_excluded() {
  local s="$1"
  # Both forms checked: the current MikroB session-naming convention (mikrob-channels/
  # mikrob-worker/...) never matches the caller's "agent-*" pre-filter, so THAT branch alone
  # is dead code today -- it protects nothing on its own, it only reads as if it does (Cybersec
  # NO-GO, card d7a28a0a: real, reproducible today only by accident of naming, not by this
  # check). The agent-mikrob* branch is the one that actually fires on any candidate that
  # reaches this function, and is what keeps MikroB excluded if a future session-naming
  # consistency pass ever puts MikroB under the same agent-<name> convention as everyone else.
  [[ "$s" == mikrob* || "$s" == agent-mikrob* ]] && return 0
  local e
  for e in "${EXCLUDED_SESSIONS[@]}"; do
    [ "$s" = "$e" ] && return 0
  done
  return 1
}
