#!/usr/bin/env bash
# lint-ratchet.sh -- run ESLint and fail only when a rule gets WORSE than its recorded baseline.
#
# WHY THIS EXISTS AND WHY IT IS NOT A PLAIN `npm run lint` (card 8fb0aa44).
#
# ESLint arrived with commit 9783a9d7 and nothing has ever called it: not fleet-test.sh, not
# `npm test` (which is only `vitest run`), and there is no .github/workflows at all. Measured
# 2026-08-22: 226 errors and 6 warnings had accumulated silently. The weekly self-audit that
# found this counted 224 the day before -- the backlog grows while nobody is looking, and the
# two-error drift between those counts is itself the evidence.
#
# So the tool was wired and had no consumer, which is the failure class this fleet already has a
# name for (wired-detection-with-no-consumer-is-decorative). The two obvious fixes both fail:
#
#   * Make `npm run lint` blocking now. It refuses every land until 226 pre-existing errors are
#     cleaned, which nobody can do in one card, so it would be reverted within the hour.
#   * Print a non-blocking report. That is the SAME failure class again with extra steps: a
#     report inside a passing script is read by nobody, and error 227 arrives unannounced.
#
# A RATCHET is neither. It records today's count PER RULE and fails only if a rule goes UP, so the
# existing backlog is tolerated while every NEW violation is refused at the gate. Cleanup then
# lowers the baseline, and the bound tightens on its own -- the "gradually make it blocking" step
# that otherwise never gets scheduled happens as a side effect of doing the work.
#
# PER RULE, not a total. A single total lets one fix pay for one regression: clean five unused
# variables, add a floating promise, total unchanged, gate green. The rules are not
# interchangeable -- an unused import is tidiness, a floating promise is a fail-open bug -- so
# each carries its own bound.
#
# Usage:
#   store/lint-ratchet.sh            # check against the baseline; exit 1 if any rule got worse
#   store/lint-ratchet.sh --update   # rewrite the baseline from the current counts
#   store/lint-ratchet.sh --show     # print current counts vs baseline, always exit 0
#
# Exit: 0 no rule got worse | 1 a rule got worse | 3 ESLint could not run
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$ROOT/store/lint-baseline.json"
MODE="check"

case "${1:-}" in
  --update) MODE="update" ;;
  --show)   MODE="show" ;;
  "")       ;;
  *) echo "lint-ratchet.sh: unknown argument '$1' (expected --update, --show or nothing)" >&2; exit 3 ;;
esac

cd "$ROOT" || { echo "lint-ratchet.sh: cannot cd to $ROOT" >&2; exit 3; }

# ESLint exits 1 when it finds problems, which is the NORMAL case here -- the ratchet, not the
# exit code, decides. Only a missing/broken ESLint is fatal, and that shows up as unparseable
# output rather than as a nonzero status.
report="$(mktemp)"
trap 'rm -f "$report"' EXIT
npx eslint src -f json > "$report" 2>/dev/null

MODE="$MODE" BASELINE="$BASELINE" REPORT="$report" python3 - <<'PY'
import json, os, sys, collections

mode = os.environ['MODE']
baseline_path = os.environ['BASELINE']

try:
    with open(os.environ['REPORT'], encoding='utf-8') as fh:
        report = json.load(fh)
except Exception as exc:
    print(f'lint-ratchet.sh: ESLint produced no parseable JSON ({exc}) -- treating as a setup '
          f'failure, NOT as a clean run.', file=sys.stderr)
    raise SystemExit(3)

if not report:
    print('lint-ratchet.sh: ESLint linted ZERO files. That is a configuration fault, not a clean '
          'tree -- refusing to report success.', file=sys.stderr)
    raise SystemExit(3)

counts: collections.Counter = collections.Counter()
for entry in report:
    for message in entry['messages']:
        # A parse error has no ruleId. Bucket it under a stable name so it can be ratcheted too;
        # otherwise a file that stops parsing silently drops out of every rule's count and reads
        # as an improvement.
        counts[message.get('ruleId') or '(parse-error)'] += 1

if mode == 'update':
    with open(baseline_path, 'w', encoding='utf-8') as fh:
        json.dump(dict(sorted(counts.items())), fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    total = sum(counts.values())
    print(f'lint-ratchet.sh: baseline written -- {len(counts)} rules, {total} findings.')
    raise SystemExit(0)

try:
    with open(baseline_path, encoding='utf-8') as fh:
        baseline = json.load(fh)
except FileNotFoundError:
    print(f'lint-ratchet.sh: no baseline at {baseline_path}. Create it with '
          f'`store/lint-ratchet.sh --update` and commit it.', file=sys.stderr)
    raise SystemExit(3)

worse, better = [], []
for rule in sorted(set(baseline) | set(counts)):
    now, was = counts.get(rule, 0), baseline.get(rule, 0)
    if now > was:
        worse.append((rule, was, now))
    elif now < was:
        better.append((rule, was, now))

for rule, was, now in better:
    print(f'lint-ratchet.sh: IMPROVED  {rule}: {was} -> {now}')
if better and mode != 'show':
    print('lint-ratchet.sh: run `store/lint-ratchet.sh --update` and commit the baseline so the '
          'bound tightens -- an improvement nobody records can be spent again later.')

if mode == 'show':
    total = sum(counts.values())
    print(f'lint-ratchet.sh: {total} findings across {len(counts)} rules')
    for rule, n in sorted(counts.items()):
        print(f'   {n:5d}  {rule}   (baseline {baseline.get(rule, 0)})')
    raise SystemExit(0)

if worse:
    print(file=sys.stderr)
    print('lint-ratchet.sh: REFUSED -- a lint rule got worse than its recorded baseline.',
          file=sys.stderr)
    for rule, was, now in worse:
        print(f'    {rule}: {was} -> {now}  (+{now - was})', file=sys.stderr)
    print(file=sys.stderr)
    print('    Fix the new findings, or -- if the increase is deliberate and reviewed -- raise the',
          file=sys.stderr)
    print('    baseline with `store/lint-ratchet.sh --update` and say why in the card.',
          file=sys.stderr)
    print('    See the ones you introduced: npx eslint src', file=sys.stderr)
    raise SystemExit(1)

print(f'lint-ratchet.sh: no rule got worse ({sum(counts.values())} findings, baseline holds).')
raise SystemExit(0)
PY
