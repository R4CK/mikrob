#!/usr/bin/env bash
# jscpd-duplication-check.sh -- runs the jscpd code-duplication scanner against a target path,
# exiting non-zero when duplication is at/above a threshold. Card 4bade960 part 2.
#
# GitHub-first due diligence (rule 10): jscpd (github.com/kucherenko/jscpd, MIT license, ~6100
# stars). The published CLI package (apps/jscpd, v4.3.0) has no postinstall/preinstall scripts;
# direct runtime deps are colors/commander/fs-extra plus workspace-internal @jscpd/* packages from
# the same monorepo. Adopted rather than building a custom scanner: duplication detection is a
# well-solved, widely-used problem, not something specific to this fleet's domain.
#
# MEASURED, not assumed (a tool's own docs are a claim until verified -- this fleet's recurring
# lesson): confirmed with a real planted-duplicate fixture that jscpd@4.3.0 exits non-zero BY
# ITSELF once duplication reaches --threshold -- its own --help text says so directly ("in case
# duplications >= threshold jscpd will exit with error"). No extra --exitCode flag is needed for a
# plain pass/fail gate; that flag only picks WHICH non-zero code to use. Re-measure this if the
# pinned jscpd major version ever changes -- do not carry this claim forward on trust alone.
#
# Usage: store/jscpd-duplication-check.sh <path> [threshold-percent, default 5]
# Exit: 0 = duplication below threshold. 1 = duplication at/above threshold (jscpd's own exit).
#       2 = bad usage / target path does not exist.
set -uo pipefail

TARGET="${1:-}"
THRESHOLD="${2:-5}"

if [ -z "$TARGET" ]; then
  echo "usage: jscpd-duplication-check.sh <path> [threshold-percent]" >&2
  exit 2
fi
if [ ! -d "$TARGET" ]; then
  echo "jscpd-duplication-check: FAIL -- target path does not exist: $TARGET" >&2
  exit 2
fi

REPORT_DIR="$(mktemp -d -t jscpd-report-XXXXXX)"
echo "jscpd-duplication-check: scanning $TARGET (threshold ${THRESHOLD}%, report: $REPORT_DIR)"
npx --yes jscpd@4 "$TARGET" --threshold "$THRESHOLD" --reporters console,json --output "$REPORT_DIR"
STATUS=$?
echo "jscpd-duplication-check: JSON report at $REPORT_DIR/jscpd-report.json"
exit "$STATUS"
