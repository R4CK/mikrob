#!/usr/bin/env bash
# Say out loud how much of a finished vitest run did NOT run (card beb9c8d3).
#
# Usage:  vitest-skip-report.sh <log-file> [<repo-root>]
# Prints a report to STDERR when the run skipped anything; silent otherwise.
# Exit:   0 = something was skipped and has been reported
#         1 = nothing to report (no skips, or an unreadable log)
#         2 = usage
#
# WHY THIS EXISTS. store/cleancore-suite-run.sh does not set PG_E2E_URL and nothing else in the
# fleet does either, while CI does (.github/workflows/ci.yml:442). Every PG-dependent e2e file is
# `describe.skipIf(!PG_E2E_URL)`, so a fleet suite run walks past all of them. MEASURED on this box
# 2026-09-06, `cleancore-suite-run.sh backend -- --project api-e2e`:
#
#     Test Files  7 passed | 58 skipped (65)
#          Tests  31 passed | 460 skipped (491)
#     exit 0
#
# 460 tests did not execute and the run is GREEN. vitest does print those counts, so the skip is not
# literally invisible -- but the number carries no attribution, and it sits in the same line as the
# handful of files that skip for a Stripe or Redis key nobody expects to have locally. A reader (or
# a gate) sees green plus a skipped count they have been trained to treat as normal. The card this
# came from (cea77ed2) is precisely a case where the half that mattered never ran.
#
# WHAT IT DOES NOT DO, deliberately:
#   * It never changes the exit code. Same contract as vitest-flake-classify.sh, and for the same
#     reason: turning a skip into a failure would break every legitimate local run, and turning a
#     failure into a pass is the thing a wrapper must never do.
#   * It stays SILENT when nothing was skipped. A notice that fires on healthy traffic is one that
#     gets skipped when it matters -- cleancore-suite-run.sh's own stated principle.
#   * It does NOT post a kanban comment. The semaphore notices in cleancore-suite-run.sh do, because
#     they fire rarely; this one fires on every local run until somebody wires a Postgres, and a
#     comment on every card is the noise the rule above warns about.
#
# WHAT IT CLAIMS, and it is narrower than "these skipped BECAUSE of PG_E2E_URL": for each file the
# run reports as skipped, it asks whether that file REFERENCES PG_E2E_URL in code, and whether
# PG_E2E_URL is unset here. Both halves are checkable. Anything it cannot attribute goes in a stated
# leftover bucket rather than being folded into the PG number -- an attribution that quietly absorbs
# what it does not understand is how a count stops being evidence.
set -uo pipefail

LOG="${1:-}"
ROOT="${2:-}"

if [ -z "$LOG" ]; then
  echo "usage: vitest-skip-report.sh <log-file> [<repo-root>]" >&2
  exit 2
fi
[ -f "$LOG" ] || exit 1

# The gate variable is named ONCE, here, and passed to the reader below. Two spellings of it in one
# file is how a rename leaves half the tool looking at the old name.
GATE_VAR="${VITEST_SKIP_REPORT_GATE_VAR:-PG_E2E_URL}"
GATE_SET=0
[ -n "${!GATE_VAR:-}" ] && GATE_SET=1

python3 - "$LOG" "$ROOT" "$GATE_VAR" "$GATE_SET" >&2 <<'PY'
import os, re, sys

log_path, root, gate_var, gate_set_s = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
gate_set = gate_set_s == "1"

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
try:
    lines = [ANSI.sub("", l.rstrip("\n")) for l in open(log_path, encoding="utf-8", errors="replace")]
except OSError:
    sys.exit(1)

# vitest's own totals are the headline. They are the run's report about itself, not a count this
# script reconstructed -- so a parsing gap below can understate the ATTRIBUTION but can never
# understate how much did not run.
def summary(label):
    rx = re.compile(r"^\s*%s\s+(?P<body>.*?)\((?P<total>\d+)\)\s*$" % label)
    for l in reversed(lines):
        m = rx.match(l)
        if m:
            sk = re.search(r"(\d+)\s+skipped", m.group("body"))
            return (int(sk.group(1)) if sk else 0), int(m.group("total"))
    return None

files_sum = summary("Test Files")
tests_sum = summary("Tests")
if files_sum is None or tests_sum is None:
    sys.exit(1)
files_skipped, files_total = files_sum
tests_skipped, tests_total = tests_sum
if tests_skipped == 0 and files_skipped == 0:
    sys.exit(1)  # nothing to say

# Per-file lines, e.g.  " down |api-e2e| apps/api/src/x.e2e.test.ts (8 tests | 8 skipped)".
# The marker distinguishes a file that ran none of its tests from one that ran some.
FILE_RX = re.compile(
    r"^\s*(?P<mark>\S)\s+(?:\|[^|]*\|\s*)?(?P<path>\S+\.(?:test|spec)\.[cm]?tsx?)"
    r"\s+\((?P<tests>\d+)\s+tests?\s*\|\s*(?P<skipped>\d+)\s+skipped\)"
)
seen, whole, partial = set(), [], []
for l in lines:
    m = FILE_RX.match(l)
    if not m:
        continue
    p = m.group("path")
    if p in seen:
        continue
    seen.add(p)
    (whole if int(m.group("skipped")) == int(m.group("tests")) else partial).append(p)

# COMMENT-STRIPPED, because this is a PRESENCE claim: a file that merely mentions the variable in a
# comment (this one does, several times) must not be counted as gated on it. The ABSENCE direction
# would need the opposite treatment, which is why the two are never the same helper.
# `://` is exempted from the line-comment rule so a connection-string literal cannot truncate a line.
BLOCK = re.compile(r"/\*.*?\*/", re.S)
LINE = re.compile(r"(?<!:)//[^\n]*")
def references(path):
    if not root:
        return False
    try:
        src = open(os.path.join(root, path), encoding="utf-8", errors="replace").read()
    except OSError:
        return False
    code = LINE.sub("", BLOCK.sub("", src))
    # Identifier boundary, not substring: PG_E2E_URL_ALT is a different variable.
    return re.search(r"(?<![A-Za-z0-9_$])%s(?![A-Za-z0-9_$])" % re.escape(gate_var), code) is not None

gated = [p for p in whole if references(p)]
other = [p for p in whole if p not in gated]

out = []
out.append("")
out.append("cleancore suite: %d of %d test FILES did not run -- %d of %d tests were SKIPPED."
           % (files_skipped, files_total, tests_skipped, tests_total))
out.append("  The exit code says nothing about them. A green summary is not evidence about a test")
out.append("  that never executed.")
if not root:
    out.append("  No repo root was given, so the skips are not attributed. Pass one as $2.")
elif gate_set:
    out.append("  %s IS set here, so these did not skip for want of it -- the reason is elsewhere"
               % gate_var)
    out.append("  (a missing Stripe/Redis/storage key, or an explicit .skip).")
else:
    out.append("  %s is UNSET here. The files that ran nothing, split by whether they reference it:"
               % gate_var)
    out.append("    %4d file(s) gated on %s -- set it and they run (skill: embedded-pg-e2e-runner)."
               % (len(gated), gate_var))
    out.append("    %4d file(s) skipped for a reason this report does not attribute." % len(other))
if partial:
    out.append("  %d further file(s) ran but skipped some of their own cases." % len(partial))
out.append("")
print("\n".join(out))
PY
rc=$?
[ "$rc" -eq 0 ] || exit 1
exit 0
