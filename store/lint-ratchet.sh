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
#   store/lint-ratchet.sh --update --accept-cleared=<rule>[,<rule>...]
#                                      # acknowledge that those ratcheted rules are now at ZERO
#
# Exit: 0 no rule got worse | 1 a rule got worse | 3 the run could not be MEASURED (ESLint could
# not run at all, or the run read a DEGRADED view of the tree -- see `degradation_reason`)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$ROOT/store/lint-baseline.json"
MODE="check"

BOOTSTRAP=0
ACCEPT_CLEARED=""
ACCEPT_BLIND_CLEAR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --update)    MODE="update" ;;
    --show)      MODE="show" ;;
    # A SEPARATE VERB, not a flag on --update, because the two say different things. `--update`
    # means "I have a bound and I am moving it"; `--bootstrap` means "there is no bound yet".
    # Deleting the baseline used to turn the first into the second silently -- see the block beside
    # `degradation_reason`.
    --bootstrap) MODE="update"; BOOTSTRAP=1 ;;
    # THE SPOKEN ACKNOWLEDGEMENT FOR A CLEARED RULE (Cybersec NO-GO 21092, R-A; MikroB 21030).
    # It NAMES THE RULES rather than being a bare flag, and that is the whole difference between
    # this and a bypass. A bare --accept-cleared would suppress the collapse signal wholesale, so
    # a wrapper script could carry it forever and the five-rules-go-dark case -- the founding
    # measurement of this card -- would sail through it. Naming them cannot be scripted blindly:
    # the list changes every time, an unlisted rule going dark still refuses, and a name that is
    # not in the baseline is itself refused rather than silently ignored.
    --accept-cleared=*) ACCEPT_CLEARED="${1#--accept-cleared=}" ;;
    # A SEPARATE, LOUDER VERB for the one state the script can PROVE is ambiguous (Cybersec
    # comment 21387 R-F1, card b6f88f86): parse errors present and NOT ONE type-aware rule found
    # anything. That reads identically whether the tree is genuinely, completely clean of every
    # type-aware finding, or the TS program simply died -- the script cannot tell them apart from
    # counts alone, and --accept-cleared silently trusted whichever one the caller believed. This
    # names the SAME state --bootstrap's own floor already recognises, so trusting it requires
    # saying so in a way that cannot be confused with the routine "one rule finished" flow below.
    --accept-blind-clear=*) ACCEPT_BLIND_CLEAR="${1#--accept-blind-clear=}" ;;
    *) echo "lint-ratchet.sh: unknown argument '$1' (expected --update, --bootstrap, --show, --accept-cleared=<rules>, --accept-blind-clear=<rules> or nothing)" >&2; exit 3 ;;
  esac
  shift
done

if [ -n "$ACCEPT_CLEARED" ] && [ "$BOOTSTRAP" = 1 ]; then
  echo "lint-ratchet.sh: --accept-cleared and --bootstrap answer different questions -- one says" >&2
  echo "    'this recorded rule is now at zero', the other 'there is no record yet'. Pick one." >&2
  exit 3
fi

if [ -n "$ACCEPT_BLIND_CLEAR" ] && [ "$BOOTSTRAP" = 1 ]; then
  echo "lint-ratchet.sh: --accept-blind-clear and --bootstrap answer different questions -- one says" >&2
  echo "    'this recorded rule is now at zero even though the run cannot prove it', the other" >&2
  echo "    'there is no record yet'. Pick one." >&2
  exit 3
fi

if [ -n "$ACCEPT_CLEARED" ] && [ -n "$ACCEPT_BLIND_CLEAR" ]; then
  echo "lint-ratchet.sh: --accept-cleared and --accept-blind-clear answer different questions -- one" >&2
  echo "    says 'this run measured the clearing', the other 'this run could not, but I am" >&2
  echo "    confirming it anyway'. Pick the one that matches this run; do not name a rule in both." >&2
  exit 3
fi

cd "$ROOT" || { echo "lint-ratchet.sh: cannot cd to $ROOT" >&2; exit 3; }

# THE BOOTSTRAP FLOOR (Cybered, INFO-ONLY 20989, point 2). Making bootstrap its own verb closes the
# ACCIDENTAL path to bypass A -- an agent who hits the refusal and restarts "from a clean slate"
# now has to type something that says what it does. It does NOT close the DELIBERATE path: measured
# after that change, `--bootstrap` on a fully degraded tree still writes {"(parse-error)": 861},
# which is bypass A's exact end state.
#
# Cybered named the fix: the previous bound is in version control, so "there is no baseline" is in
# practice a DELETION, not a first run. If git still has it, this is a restore, not a bootstrap.
#
# FAILS OPEN when git cannot answer (no repo, no git, file never committed) and only then. A
# genuine first run has to stay possible, and the hermetic selftest runs outside any repo. The
# threat here is an agent taking a shortcut inside the real checkout, and there git always answers.
if [ "$BOOTSTRAP" = 1 ] && [ ! -f "$BASELINE" ]; then
  if git -C "$ROOT" show "HEAD:store/lint-baseline.json" >/dev/null 2>&1; then
    echo "lint-ratchet.sh: REFUSING to bootstrap -- store/lint-baseline.json is MISSING from the" >&2
    echo "    working tree but PRESENT in git HEAD, so this is a deleted bound, not a first run." >&2
    echo "    Restore it:  git checkout HEAD -- store/lint-baseline.json" >&2
    echo "    Bootstrapping here would record the current counts as the new normal, and if this" >&2
    echo "    run is degraded that erases every type-aware rule from the bound permanently." >&2
    exit 3
  fi
fi

# ESLint exits 1 when it finds problems, which is the NORMAL case here -- the ratchet, not the
# exit code, decides. Only a missing/broken ESLint is fatal, and that shows up as unparseable
# output rather than as a nonzero status.
report="$(mktemp)"
trap 'rm -f "$report"' EXIT
npx eslint src -f json > "$report" 2>/dev/null

MODE="$MODE" BOOTSTRAP="$BOOTSTRAP" ACCEPT_CLEARED="$ACCEPT_CLEARED" \
  ACCEPT_BLIND_CLEAR="$ACCEPT_BLIND_CLEAR" \
  BASELINE="$BASELINE" REPORT="$report" python3 - <<'PY'
import json, os, sys, collections

mode = os.environ['MODE']
bootstrap = os.environ.get('BOOTSTRAP') == '1'
accepted_cleared = {r for r in os.environ.get('ACCEPT_CLEARED', '').split(',') if r}
accepted_blind_clear = {r for r in os.environ.get('ACCEPT_BLIND_CLEAR', '').split(',') if r}
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

# WHICH RULES GO DARK WHEN THE TS PROGRAM IS LOST, MEASURED RATHER THAN ASSUMED.
#
# The comment above (and this file's selftest header) said "five of the six ratcheted rules are
# TYPE-AWARE". That is wrong, and it matters now that the set is load-bearing code rather than
# prose. Read from the plugin's own metadata (`meta.docs.requiresTypeChecking` on
# @typescript-eslint/eslint-plugin, the copy this repo installs):
#
#   await-thenable          true
#   no-floating-promises    true
#   no-misused-promises     true
#   no-unsafe-argument      true
#   no-unused-vars          undefined   <- NOT type-aware
#
# FOUR, not five. `no-unused-vars` is a syntactic rule: it keeps reporting with no TS program at
# all, and it only falls silent when parsing itself fails -- which the `(parse-error)` bucket
# already covers. Including it here would make the bootstrap floor below STRICTLY WEAKER, because
# that floor asks whether NONE of these rules found anything: one extra rule that keeps reporting
# in the degraded state is one more way for the conjunction to come out false.
TYPE_AWARE_RULES = frozenset({
    '@typescript-eslint/await-thenable',
    '@typescript-eslint/no-floating-promises',
    '@typescript-eslint/no-misused-promises',
    '@typescript-eslint/no-unsafe-argument',
})

# THE SAME PREDICATE ON BOTH SIDES OF THE FORK (Cybersec comment 21387 R-F1, card b6f88f86). The
# bootstrap floor below already computes "parse errors present and not one type-aware rule found
# anything" -- but only inside the `not have_baseline` branch, so a run WITH a baseline never asks
# it. Measured on the shipped script: naming both dark type-aware rules via --accept-cleared on
# such a run wrote a baseline with those rules removed entirely, no bound left at all. Computing it
# once, here, lets both the WITH-baseline collapse check and the bootstrap floor read the same
# answer instead of one of them silently not asking.
blind = parse_now > 0 and not any(counts.get(r, 0) for r in TYPE_AWARE_RULES)

# ONE, not two (Cybersec NO-GO 21092 R-A, on MikroB's ruling 21030). The previous threshold of two
# bought a real single-rule fix at the price of a SLICED path: five separate --update runs, each
# taking one rule to zero, each individually legitimate-looking and exit 0, ending at exactly the
# end state of the bypass this card closed. Cybersec measured all five steps.
#
# The capability is not removed, it is made to ASK -- the same shape as --bootstrap. A genuine
# "we finished off the last one" now passes with --accept-cleared naming the rule.
COLLAPSE_MIN = 1


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
        # (d) THE BOOTSTRAP FLOOR, AND IT IS STATE-BASED (Cybersec NO-GO 21092 R-B, on MikroB's
        # ruling 21035). The git floor above catches a DELETED bound, which is the accidental
        # route; it answers "did this file exist before", so it cannot answer anything at all in a
        # tree with no git, and it fails open there by design. The deliberate route walked
        # straight through that: --bootstrap on a fully degraded tree with no repo wrote
        # {"(parse-error)": 861}, measured, which is the end state of bypass A.
        #
        # This floor asks about the RUN instead of about the repo, so it works on a genuine first
        # run: parse errors present AND not one type-aware rule found anything is not a codebase,
        # it is a toolchain that cannot see one. A healthy first run passes it even with parse
        # errors, because the type-aware rules still report -- that is the control this must not
        # break, and it is pinned as one.
        if blind:
            return (f'{parse_now} parse error(s) and NOT ONE finding from any type-aware rule '
                    f'({", ".join(sorted(TYPE_AWARE_RULES))}). Those rules report nothing in a '
                    f'file whose TS program did not resolve, so this reads as a toolchain that '
                    f'cannot see the tree -- recording it would create a bound that permits '
                    f'everything they exist to catch.')
        return None
    # (b) A BOUNDED RULE AT EXACTLY ZERO. A lost TS program takes the type-aware rules dark
    # together, and taking them one per run is the sliced version of the same end state. An
    # acknowledged clearing is subtracted first, so a real fix passes by naming what it fixed.
    #
    # ON A BLIND RUN, ONLY THE LOUDER VERB COUNTS (Cybersec comment 21387 R-F1, card b6f88f86).
    # --accept-cleared is validated against WHAT THIS RUN MEASURED; a blind run cannot measure
    # anything, so trusting its --accept-cleared here is exactly the state the bootstrap floor
    # above refuses to record. `accepted_blind_clear` is the only acknowledgement honoured while
    # blind -- a caller who typed the routine verb is refused below, by name, before this point.
    honoured = accepted_blind_clear if blind else accepted_cleared
    collapsed = sorted(r for r, was in baseline.items()
                       if r != parse_key and was > 0 and counts.get(r, 0) == 0
                       and r not in honoured)
    if len(collapsed) >= COLLAPSE_MIN:
        subject = (f'{len(collapsed)} rules that had recorded findings are'
                   if len(collapsed) > 1 else
                   f'{len(collapsed)} rule that had recorded findings is')
        verb = '--accept-blind-clear' if blind else '--accept-cleared'
        caveat = ('' if not blind else
                  f' This run ALSO has {parse_now} parse error(s) with not one type-aware finding '
                  f'anywhere, which is indistinguishable from a dead toolchain -- {verb} says you '
                  f'checked by some OTHER means that this is real, not that the run proves it.')
        return (f'{subject} at exactly zero in this run '
                f'({", ".join(collapsed)}).{caveat} A rule that was not measured reads exactly '
                f'like a rule with nothing left to find. If this really is finished work, say so '
                f'-- the whole command, ready to paste: '
                f'store/lint-ratchet.sh --update {verb}={",".join(collapsed)}')
    # (a) THE ORIGINAL SIGNAL, kept: the loud half is still real, and still the only one that
    # fires when the set is intact but unreadable.
    if parse_now > parse_was:
        return (f'parse errors are ABOVE the recorded bound ({parse_was} -> {parse_now}), so this '
                f'run read a tree it could not fully parse.')
    return None


# AN ACKNOWLEDGEMENT IS VALIDATED AGAINST THIS RUN, NOT AGAINST THE STABLE KEY SET (Cybersec
# NO-GO on 382755b3, HIGH, comment 21295 -- reproduced here independently before fixing).
#
# The first version checked the names against `set(baseline)`. The baseline's KEYS are constant;
# only the collapsed subset moves. So a static list naming every rule was permanently valid, which
# made `--accept-cleared` exactly the blanket the named form was introduced to avoid. Measured on
# the shipped script, parse count unchanged:
#
#   both ratcheted rules dark, no flag                        -> exit 3  (correct)
#   the SAME run, --accept-cleared=<every baseline name>       -> exit 0  (the bypass)
#   CONTROL: a HEALTHY run with that same static list          -> exit 0  (nothing notices)
#
# The control is the part that decides it. A static list is harmless on a healthy run, so it can
# sit in a wrapper script forever and nothing ever draws attention to it -- until the day the rules
# really do go dark, and then it waves that run through. Naming the rules only makes the line
# longer; it does not make a stale line fail. That is why my own O3 case did not catch this: O3
# measures that ONE name does not excuse ANOTHER, which is one rule short of the case that matters.
#
# Validating against the rules that ACTUALLY went to zero in THIS run fixes both halves at once: a
# static list now fails on the FIRST healthy run, so it cannot go stale quietly.
#
# The costs, stated rather than discovered later: this is stricter -- naming a rule that did not in
# fact clear is now an error, not a no-op -- and `(parse-error)` can no longer be named at all,
# because it is excluded from the collapse set by construction. Both are deliberate.
cleared_now = {r for r, was in baseline.items()
               if r != parse_key and was > 0 and counts.get(r, 0) == 0}
unknown = sorted(accepted_cleared - cleared_now)
if unknown:
    print(f'lint-ratchet.sh: --accept-cleared names {", ".join(unknown)}, which did not go to zero '
          f'in this run. Nothing was accepted -- acknowledge only what this run actually cleared '
          f'(the refusal below prints the exact list, ready to paste), and check the spelling '
          f'against {baseline_path}.', file=sys.stderr)
    raise SystemExit(3)

# --accept-blind-clear IS THE LOUDER VERB, NOT A SECOND ROUTINE ONE (card b6f88f86): it exists
# specifically for the state degradation_reason's `blind` predicate names, so using it when the
# run is NOT blind is asked-for-the-wrong-thing, same shape as the --bootstrap/--accept-cleared
# mismatch above. Its names are validated against the same `cleared_now` for the same reason: a
# static list would otherwise sit unnoticed until the day it actually matters.
if accepted_blind_clear and not blind:
    print(f'lint-ratchet.sh: --accept-blind-clear names {", ".join(sorted(accepted_blind_clear))}, '
          f'but this run is not blind ({parse_now} parse error(s), type-aware rules still '
          f'reporting) -- that verb is for the one state this run cannot prove either way. Use '
          f'--accept-cleared instead.', file=sys.stderr)
    raise SystemExit(3)
unknown_blind = sorted(accepted_blind_clear - cleared_now)
if unknown_blind:
    print(f'lint-ratchet.sh: --accept-blind-clear names {", ".join(unknown_blind)}, which did not '
          f'go to zero in this run. Nothing was accepted -- acknowledge only what this run '
          f'actually cleared, and check the spelling against {baseline_path}.', file=sys.stderr)
    raise SystemExit(3)

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
    # Padded and separated EXPLICITLY. Both labels used to carry their own trailing spaces, so
    # 'IMPROVED  ' aligned and 'UNMEASURED' -- exactly as long as the padded field -- ran straight
    # into the rule name: 'UNMEASUREDno-floating-promises'. The column is the format's job.
    label = 'UNMEASURED' if measurement_degraded else 'IMPROVED'
    print(f'lint-ratchet.sh: {label:<10} {rule}: {was} -> {now}')
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
