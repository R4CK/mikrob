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
#   store/lint-ratchet.sh              # check against the baseline; exit 1 if any rule got worse
#   store/lint-ratchet.sh --update     # rewrite the baseline from the current counts
#   store/lint-ratchet.sh --show       # print current counts vs baseline, always exit 0
#   store/lint-ratchet.sh --bootstrap  # CREATE a baseline where none exists (see below)
#
# Exit: 0 no rule got worse | 1 a rule got worse | 3 the run could not be MEASURED (ESLint could
# not run at all, or the run read a DEGRADED view of the tree -- see `degradation_reason`)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$ROOT/store/lint-baseline.json"
MODE="check"

BOOTSTRAP=0
case "${1:-}" in
  --update)    MODE="update" ;;
  --show)      MODE="show" ;;
  # A SEPARATE VERB, not a flag on --update, because the two say different things. `--update`
  # means "I have a bound and I am moving it"; `--bootstrap` means "there is no bound yet".
  # Deleting the baseline used to turn the first into the second silently -- see the block beside
  # `degradation_reason`.
  --bootstrap) MODE="update"; BOOTSTRAP=1 ;;
  "")          ;;
  *) echo "lint-ratchet.sh: unknown argument '$1' (expected --update, --bootstrap, --show or nothing)" >&2; exit 3 ;;
esac

cd "$ROOT" || { echo "lint-ratchet.sh: cannot cd to $ROOT" >&2; exit 3; }

# ESLint exits 1 when it finds problems, which is the NORMAL case here -- the ratchet, not the
# exit code, decides. Only a missing/broken ESLint is fatal, and that shows up as unparseable
# output rather than as a nonzero status.
report="$(mktemp)"
trap 'rm -f "$report"' EXIT
npx eslint src -f json > "$report" 2>/dev/null

MODE="$MODE" BOOTSTRAP="$BOOTSTRAP" BASELINE="$BASELINE" REPORT="$report" python3 - <<'PY'
import json, os, sys, collections

mode = os.environ['MODE']
bootstrap = os.environ.get('BOOTSTRAP') == '1'
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

try:
    with open(baseline_path, encoding='utf-8') as fh:
        baseline = json.load(fh)
    have_baseline = True
except FileNotFoundError:
    # A MISSING BASELINE IS NOT AUTOMATICALLY A FIRST RUN (Cybersec NO-GO, bypass A, comment
    # 21010). This branch used to treat "no file" as bootstrap whenever the mode was --update,
    # which made every guard below unreachable by `rm`: delete the baseline, re-run --update on a
    # degraded tree, and the collapsed counts are written as the new normal with exit 0 and a
    # congratulatory message. Measured: it wrote `{"(parse-error)": 861}` -- all five type-aware
    # rules erased from the bound, permanently.
    #
    # The likely author of that sequence is not an attacker. It is an agent who hits the refusal,
    # cannot fix the toolchain, and starts "from a clean slate" -- a documented pattern on this
    # very card, where the card text itself would have led to --update.
    #
    # So creating a bound is now its own verb. It stays possible (a real first run needs it) but
    # it can no longer happen as a SIDE EFFECT of asking to move an existing bound.
    if mode == 'update' and bootstrap:
        baseline, have_baseline = {}, False
    elif mode == 'update':
        print(f'lint-ratchet.sh: REFUSING to write a baseline -- there is none at {baseline_path}, '
              f'and --update MOVES an existing bound rather than creating one.', file=sys.stderr)
        print('    If the baseline was deleted, restore it from git; the recorded bound is the '
              'point of the ratchet.', file=sys.stderr)
        print('    If this genuinely is the first run on this tree, say so explicitly: '
              '`store/lint-ratchet.sh --bootstrap`.', file=sys.stderr)
        raise SystemExit(3)
    else:
        print(f'lint-ratchet.sh: no baseline at {baseline_path}. Create it with '
              f'`store/lint-ratchet.sh --bootstrap` and commit it.', file=sys.stderr)
        raise SystemExit(3)

# THE MEASUREMENT CAN BREAK, AND A BROKEN ONE LOOKS LIKE GOOD NEWS (card 26ab08a2).
#
# Five of the six ratcheted rules are TYPE-AWARE: they need typescript-eslint to resolve a TS
# program for each file. When that resolution fails, the rules do not error -- they simply find
# nothing. Measured on a throwaway worktree at 332fa462 by removing tsconfig.json: every typed
# rule went to ZERO and the script printed five `IMPROVED` lines plus its standing advice to run
# `--update` and record them. Only the `(parse-error)` bucket moved the other way (6 -> 861),
# which is what made the run fail at all.
#
# So a parse-error rise is not "one more rule got worse" -- it means the run linted a DEGRADED
# view of the tree, and every other number in it was produced against that same degraded view.
# Reporting it as rule movement points the reader at lint findings when the actual fault is the
# toolchain, and the printed remedy (`--update`) would then RECORD the degraded numbers. That is
# how a gate gets disarmed by someone following its own instructions.
parse_key = '(parse-error)'
parse_now, parse_was = counts.get(parse_key, 0), baseline.get(parse_key, 0)

# THE PREDICATE ANCHORS ON THE INVARIANT, NOT ON ONE SYMPTOM (Cybersec NO-GO, comment 21010).
#
# The first version of this guard was `parse_now > parse_was`: it fired only when the tree got
# LOUDER about being unreadable. That is one signature of a degraded run, and Cybersec measured
# SEVEN ways past it -- every degradation that SHRINKS the measured set instead of producing parse
# errors leaves that count flat or falling while the type-aware rules go to zero, so the script
# printed IMPROVED and offered to record it. The quiet half of the same failure.
#
# The invariant the ratchet actually depends on is: DID THIS RUN MEASURE THE SAME TREE THE
# BASELINE MEASURED? Three independent signals say it did not, and each returns its own reason so
# the message names the trigger that fired rather than the one that happened to be written first.
# (That was Cybersec's own note on their prototype: a refusal that blames parse errors when the
# real trigger was a rule collapse re-creates the misdirected-message class this card is about.)
#
# ORDER IS MOST-SPECIFIC FIRST, because more than one can be true at once and the first is the
# most actionable.
COLLAPSE_MIN = 2


def degradation_reason(counts, baseline, have_baseline, files_linted):
    """Why this run cannot be compared to the baseline, or None if it can."""
    findings = sum(counts.values())
    # (c) FILES WENT IN, NOTHING CAME OUT. The zero-FILES case was already a setup fault; this is
    # the same fault one level in, and it needs no deletion and no broken toolchain to reach.
    # Recording it writes an EMPTY ratchet, which un-bounds every rule at once.
    if files_linted and not findings:
        return (f'ESLint linted {files_linted} file(s) and reported ZERO findings of any kind. '
                f'On a tree with a recorded bound that is a configuration fault, not a clean '
                f'sweep -- a working run on this repo has never once reported nothing.')
    if not have_baseline:
        return None
    # (b) SEVERAL BOUNDED RULES AT EXACTLY ZERO AT ONCE. A real fix drives ONE rule to zero; the
    # type-aware rules going dark together is what a lost TS program looks like from here. The
    # threshold is deliberately two rather than one, so that genuinely finishing off a single rule
    # is not called a degradation -- the cost of that choice is stated in the card.
    collapsed = sorted(r for r, was in baseline.items()
                       if r != parse_key and was > 0 and counts.get(r, 0) == 0)
    if len(collapsed) >= COLLAPSE_MIN:
        return (f'{len(collapsed)} rules that had recorded findings are ALL at exactly zero in '
                f'this run ({", ".join(collapsed)}). A fix moves one rule; several going dark at '
                f'once is what an unresolved TS program looks like from in here.')
    # (a) THE ORIGINAL SIGNAL, kept: the loud half is still real, and still the only one that
    # fires when the set is intact but unreadable.
    if parse_now > parse_was:
        return (f'parse errors are ABOVE the recorded bound ({parse_was} -> {parse_now}), so this '
                f'run read a tree it could not fully parse.')
    return None


degraded = degradation_reason(counts, baseline, have_baseline, len(report))
measurement_degraded = degraded is not None

if mode == 'update' and measurement_degraded:
    print(f'lint-ratchet.sh: REFUSING to write the baseline -- {degraded}', file=sys.stderr)
    print('    Recording it would bake the blindness in: a rule that was not measured reads as a '
          'rule with no findings,', file=sys.stderr)
    print('    so these counts are not evidence of anything. Fix the measurement, then re-run '
          '--update.', file=sys.stderr)
    print('    Start here: npx eslint src | grep -i "parsing error", and check that tsconfig.json '
          'resolves for every linted file.', file=sys.stderr)
    raise SystemExit(3)

if mode == 'update':
    with open(baseline_path, 'w', encoding='utf-8') as fh:
        json.dump(dict(sorted(counts.items())), fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    total = sum(counts.values())
    print(f'lint-ratchet.sh: baseline written -- {len(counts)} rules, {total} findings.')
    raise SystemExit(0)

worse, better = [], []
for rule in sorted(set(baseline) | set(counts)):
    now, was = counts.get(rule, 0), baseline.get(rule, 0)
    if now > was:
        worse.append((rule, was, now))
    elif now < was:
        better.append((rule, was, now))

for rule, was, now in better:
    label = 'UNMEASURED' if measurement_degraded else 'IMPROVED  '
    print(f'lint-ratchet.sh: {label}{rule}: {was} -> {now}')
if better and mode != 'show' and not measurement_degraded:
    print('lint-ratchet.sh: run `store/lint-ratchet.sh --update` and commit the baseline so the '
          'bound tightens -- an improvement nobody records can be spent again later.')

if mode == 'show':
    total = sum(counts.values())
    print(f'lint-ratchet.sh: {total} findings across {len(counts)} rules')
    for rule, n in sorted(counts.items()):
        print(f'   {n:5d}  {rule}   (baseline {baseline.get(rule, 0)})')
    raise SystemExit(0)

if measurement_degraded:
    print(file=sys.stderr)
    print(f'lint-ratchet.sh: COULD NOT MEASURE -- {degraded}', file=sys.stderr)
    print('    The type-aware rules find NOTHING in a file they cannot resolve, so the counts '
          'above are not', file=sys.stderr)
    print('    comparable to the baseline in either direction -- a drop here is missing '
          'measurement, not progress.', file=sys.stderr)
    print('    Fix the measurement first, then re-run. Do NOT --update in this state; the '
          'script refuses it for the same reason.', file=sys.stderr)
    print('    Start here: npx eslint src | grep -i "parsing error", and check that tsconfig.json '
          'resolves for every linted file.', file=sys.stderr)
    for rule, was, now in worse:
        if rule != parse_key:
            print(f'    (also above baseline, but measured in the same degraded run) '
                  f'{rule}: {was} -> {now}', file=sys.stderr)
    raise SystemExit(3)

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
