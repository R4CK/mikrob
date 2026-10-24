#!/bin/bash
# upstream-batch-digest-offload.sh -- thin, UNCONDITIONAL environment-sanitizing entry point.
# The real logic lives in upstream-batch-digest-offload-impl.sh; this file's only job is to reach
# it with a brand new, explicitly-listed environment, before a single byte of the real logic runs.
#
# WhiteHat F1'' (card 7b5cf804, delta-3 NO-GO @0b35ec0d, msg 14650): the previous fix's own wipe
# attempt (`builtin unset -f $(builtin compgen -A function)`) is itself shadowable -- `builtin`,
# `unset`, `compgen`, `command`, `declare` are ordinary builtins, not reserved words, so a caller
# that exports a same-named function intercepts the wipe call before it can run (demonstrated
# live, bash 5.3.9: export -f builtin as a no-op + export -f dirname pointing HERE at an attacker
# directory -> the content gate bypassed entirely, rc=0, the Gemini-stub reached). There is no
# in-process wipe immune to this: EVERY plain command name (including unset/compgen/declare/
# command/builtin itself) goes through function lookup first -- only a shell KEYWORD (if, case,
# [[) or a PATH-QUALIFIED command (containing a "/") skips that lookup entirely.
#
# The only construct that is unconditionally immune is therefore: start a BRAND NEW process with a
# BRAND NEW environment (env -i, which drops every exported function along with every other env
# var) before running ANY of the real logic, using nothing but keywords/parameter-expansion and
# absolute paths to get there. This file does exactly that, and nothing else -- it is deliberately
# too small to contain a second bug in the same class.
#
# NO FLAG, ON PURPOSE. A gated version of this fix ( `if [[ -z "${UBD_CLEAN:-}" ]]; then <re-exec
# into self>; else <real body>; fi` in a single file) was considered and rejected: the flag is
# itself just another caller-settable env var -- a caller able to export functions can just as
# easily export UBD_CLEAN=1 and skip the sanitizing re-exec entirely, landing straight in the
# dirty environment the wipe was supposed to close (a strictly EASIER bypass than F1'', since it
# needs no function export at all). Splitting into two files removes the flag, and therefore
# removes anything to forge: THIS file always re-execs, unconditionally, on every invocation; the
# impl file is reached only through that re-exec and never re-execs again (see its own header for
# why it is then safe to use plain `dirname`/`cd`/`bash` there).
#
# WHY "${0%/*}" AND NOT `dirname`: same reasoning as above -- `dirname` is a plain command name,
# shadowable before the environment is clean. "${0%/*}" is bash's own suffix-removal parameter
# expansion (not a command at all), immune by construction. The `case` below only handles the
# (here, defensive-only) edge case of $0 containing no "/" at all (e.g. a bare PATH lookup) --
# `case`/`esac` is a shell keyword, not a command, same immunity.
#
# THE ALLOWLIST BELOW is every env var the real implementation legitimately reads from its
# caller's environment (verified by grepping upstream-batch-digest-offload-impl.sh and the
# gemini-heavy-gate.sh it sources): the heavy-second-opinion flag file, the hourly-budget lock,
# the helper script path, and the two hourly limits. PATH and HOME are the minimum a bash script
# needs to run at all. Nothing else survives -- in particular, none of the UBD_FILTER/UBD_LOCAL_
# LLM/UBD_GEMINI_OFFLOAD/UBD_SELFTEST_MODE/UBD_OFFLOAD_DISPATCH seams the F1/F1'/F2' fixes already
# removed from the code are let back in by name here, and no caller-exported FUNCTION (regardless
# of name) survives env -i at all.
#
# KNOWN, DEFERRED, OUT OF SCOPE FOR THIS CARD (WhiteHat F2'', msg 14650): GEMINI_HEAVY_FLAG /
# GEMINI_AGY_HOURLY_LOCK / SEGED_HIVO_HELPERS / the two hourly limits are themselves still caller-
# settable through this allowlist (the selftest genuinely needs them to exercise the real gate
# logic against scratch files, not production ones). A caller able to set these can force the
# heavy-second-opinion flag on or widen the hourly budget -- that is a feature-flag/budget bypass,
# NOT a content-gate bypass (the sensitive-keyword vocabulary in offload-dispatch.sh --check-
# blocked still runs unconditionally and is not on this allowlist at all). WhiteHat rated this LOW/
# MEDIUM, did not exploit it, and explicitly left it out of this card's scope; track separately.
#
# RedHat KC3 (card 7b5cf804, NO-GO komment 24261, Gate-SHA 6a1b5a7e): this file used to start with
# `set -uo pipefail`, itself an ordinary command name (a POSIX "special builtin", but bash still
# lets a same-named FUNCTION intercept it outside posix mode) running BEFORE env -i. A caller-
# exported `set` function with a DEBUG trap in its body hijacked the IMPL variable right before the
# final line ran, redirecting it to an attacker script -- the exact same shadowing class as
# F1''/F1, just one more command name that was missed. Fix: delete the line. This file has no
# pipeline and no use for `nounset`, so there is nothing to replace it with -- the body below is
# now a `case` (keyword), two parameter expansions, and one absolute-path /usr/bin/env invocation:
# no other plain command name remains between the top of the file and env -i.
#
# RedHat KC5 (same gate): shebang changed from `#!/usr/bin/env bash` to `#!/bin/bash` -- the
# `env bash` form does a PATH lookup for `bash` itself when this file is executed directly
# (./upstream-batch-digest-offload.sh), so a caller-controlled PATH could substitute a fake `bash`
# before this file's own first line ever runs. `#!/bin/bash` is resolved by the kernel from an
# absolute path, no PATH lookup involved.
#
# RedHat KC4 (same gate, INFO -- cannot be fixed inside this file): if this script is invoked as
# `bash upstream-batch-digest-offload.sh` (not executed directly), a caller-exported BASH_ENV/ENV
# is sourced by that `bash` process's own startup, in the PARENT process, BEFORE this file's first
# line runs -- env -i only protects the re-exec'd CHILD, not this file's own execution, and there
# is no in-file fix (the sourcing happens before any of this file's code exists in that process).
# Whoever wires up a caller for this script MUST invoke it either by direct execution
# (./upstream-batch-digest-offload.sh, relying on the #!/bin/bash shebang above) or via
# `/usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" /bin/bash upstream-batch-digest-offload.sh`,
# never as a bare `bash upstream-batch-digest-offload.sh` with an unsanitized caller environment.
# No caller is wired up yet; this requirement carries forward to whichever card adds one.
case "$0" in
  */*) IMPL="${0%/*}/upstream-batch-digest-offload-impl.sh" ;;
  *)   IMPL="./upstream-batch-digest-offload-impl.sh" ;;
esac
/usr/bin/env -i PATH=/usr/bin:/bin HOME="${HOME:-}" \
  GEMINI_HEAVY_FLAG="${GEMINI_HEAVY_FLAG:-}" \
  GEMINI_AGY_HOURLY_LOCK="${GEMINI_AGY_HOURLY_LOCK:-}" \
  SEGED_HIVO_HELPERS="${SEGED_HIVO_HELPERS:-}" \
  GEMINI_AGY_HOURLY_LIMIT="${GEMINI_AGY_HOURLY_LIMIT:-}" \
  GEMINI_AGY_HEAVY_HOURLY_LIMIT="${GEMINI_AGY_HEAVY_HOURLY_LIMIT:-}" \
  /bin/bash "$IMPL" "$@"
