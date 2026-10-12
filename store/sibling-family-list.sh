#!/usr/bin/env bash
# sibling-family-list.sh -- the ONE place sibling clone-family membership is declared (card
# 31e70128). Sourced by store/agent-skill-drift-sync.sh (_family_members) and
# store/sibling-skill-drift-check.sh (FAMILIES) -- each previously kept its OWN hardcoded copy
# of this exact list, and the two had already drifted from each other: agent-skill-drift-sync.sh
# added cybersec/cybersec2 when WhiteHat2 was stood up (card 21abfe0b), but
# sibling-skill-drift-check.sh's own copy was never updated to match, so it silently skipped that
# family in every run since. Not a tool: no args, no output, no side effect -- just a function and
# a canonical family-key list for callers to iterate, so a future sibling (RedHat2, etc.) is a
# one-line, one-place edit instead of a hunt across every script that happens to care.
#
# Not derived from any naming convention (qa2 implies a sibling, cybersec2 did too, cybered does
# NOT despite also ending in a digit-free "red" stem), so this stays an explicit list, same spirit
# as the root CLAUDE.md's own hardcoded sibling note.

# sibling_family_members <agent> -- echoes the full family (space-separated, declaration order)
# the given agent belongs to, or an empty string if it is not part of any declared family.
sibling_family_members() {
  case "$1" in
    backend|backend2|backend3) echo "backend backend2 backend3" ;;
    qa|qa2)                    echo "qa qa2" ;;
    fron-ted|fron-teddy)       echo "fron-ted fron-teddy" ;;
    cybersec|cybersec2)        echo "cybersec cybersec2" ;;
    *) echo "" ;;
  esac
}

# One representative member per known family, in declaration order -- what a caller needs to
# enumerate "every family" without re-declaring the list a third time.
SIBLING_FAMILY_KEYS=(backend qa fron-ted cybersec)
