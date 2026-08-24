#!/usr/bin/env python3
"""Controls for the shared gate-scan recognition rules (card 3477c793).

Runs offline -- no dashboard, no token, no network. Every case is a shape MEASURED on the real board
on 2026-08-24, not an invented one, and the file carries as many NEGATIVE controls as positive ones:
the failure this card fixes was a rule that was too strict, and the obvious over-correction (accept a
verdict word anywhere near the top) would reopen the quoted-word false-positive class both scanners
already carry warnings about.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate_scan_lib import declared_gate_excludes_me, verdict_body  # noqa: E402

FAILS = []


def check(name, got, want):
    if got == want:
        print(f'  ok   {name}')
    else:
        FAILS.append(name)
        print(f'  FAIL {name}\n       got:  {got!r}\n       want: {want!r}')


def opens_with(content, word):
    return verdict_body(content).upper().startswith(word)


print('gate_scan_lib controls (card 3477c793)')

# ---------------------------------------------------------------- verdict_body: recovered shapes
check('verdict on line 1 still recognised',
      opens_with('CYBERSEC GO\nGate-SHA: abc123\n\nbody', 'CYBERSEC'), True)
check('Gate-SHA: first, verdict second -- the 42 measured cases',
      opens_with('Gate-SHA: abc123\nCYBERSEC NO-GO\n\nbody', 'CYBERSEC'), True)
check('Gate-SHA: first, BLANK line, verdict third',
      opens_with('Gate-SHA: abc123\n\nCYBERSEC GO', 'CYBERSEC'), True)
check('leading blank lines before the verdict',
      opens_with('\n\nCYBERSEC GO', 'CYBERSEC'), True)
check('QA form behind a Gate-SHA header',
      opens_with('Gate-SHA: abc123\nQA PASS -- everything green', 'QA PASS'), True)
check('multi-sha Gate-SHA line (rule 4b allows a comma list)',
      opens_with('Gate-SHA: abc123, def456\nCYBERED NO-GO', 'CYBERED'), True)
check('case-insensitive header',
      opens_with('gate-sha: abc123\nCYBERSEC GO', 'CYBERSEC'), True)

# --------------------------------------------------------- verdict_body: the deliberate LIMITS
# These are the 4 measured cases this rule does NOT recover, pinned so that widening it later is a
# decision someone makes on purpose rather than a side effect.
check('PROSE before the verdict is NOT recognised (deliberate)',
      opens_with('Elozetes megjegyzes.\nCYBERSEC GO', 'CYBERSEC'), False)
check('a quoted verdict word mid-sentence is NOT recognised',
      opens_with('Nem adok CYBERSEC GO-t, amig a fix nem all.', 'CYBERSEC'), False)
check('an INFO-ONLY comment is NOT a verdict',
      opens_with('INFO-ONLY: a CYBERSEC GO mar fent van a 15713-as kommentben.', 'CYBERSEC'), False)
check('a Gate-SHA line ALONE yields no opener',
      verdict_body('Gate-SHA: abc123\n\n'), '')
check('empty content is safe',
      verdict_body(None), '')
check('a non-Gate-SHA header line is NOT skipped',
      opens_with('Repo: marveen\nCYBERSEC GO', 'CYBERSEC'), False)
check('"Gate-SHA:" with no value is not treated as a header',
      opens_with('Gate-SHA:\nCYBERSEC GO', 'CYBERSEC'), False)

# ------------------------------------------------------- ANTI-VACUITY: the old rule really differs
# Without this, every case above would also pass on a no-op change, and the suite would be measuring
# nothing. This is the exact pre-fix expression from both scanners.
def old_rule(content):
    return (content or '').lstrip().upper().startswith('CYBERSEC')


check('CONTROL: the pre-fix rule MISSES the recovered shape',
      old_rule('Gate-SHA: abc123\nCYBERSEC NO-GO'), False)
check('CONTROL: the pre-fix rule and the new one agree on line-1 verdicts',
      old_rule('CYBERSEC GO\nGate-SHA: abc'),
      opens_with('CYBERSEC GO\nGate-SHA: abc', 'CYBERSEC'))
check('CONTROL: the pre-fix rule also rejects the prose case (no regression there)',
      old_rule('Elozetes megjegyzes.\nCYBERSEC GO'), False)

# ------------------------------------------------------------------ declared_gate_excludes_me
check('QA-only card excludes cybersec',
      declared_gate_excludes_me('...\nGate: QA (tartalom-ellenorzes, nincs trust-boundary).', 'cybersec'), True)
check('QA-only card excludes cybered',
      declared_gate_excludes_me('...\nGate: QA', 'cybered'), True)
check('QA + Cybersec includes cybersec',
      declared_gate_excludes_me('Gate: QA + Cybersec', 'cybersec'), False)
check('QA + Cybersec EXCLUDES cybered',
      declared_gate_excludes_me('Gate: QA + Cybersec', 'cybered'), True)
check('three-gate card includes both security gates',
      (declared_gate_excludes_me('Gate: QA + Cybersec + Cybered', 'cybersec'),
       declared_gate_excludes_me('Gate: QA + Cybersec + Cybered', 'cybered')), (False, False))
check('no Gate: line at all -> fall through, surface the card',
      declared_gate_excludes_me('A card with no declared tier.', 'cybersec'), False)
check('empty description -> fall through',
      declared_gate_excludes_me(None, 'cybersec'), False)
check('the LAST mention wins when scope widens mid-description',
      declared_gate_excludes_me('Gate: QA\n...later...\nGate: QA + Cybersec + Cybered', 'cybered'), False)
check('the LAST mention wins when scope NARROWS',
      declared_gate_excludes_me('Gate: QA + Cybered\n...later...\nGate: QA', 'cybered'), True)
check('Gate: continued in PROSE on the same line (lesson 77fd0f07)',
      declared_gate_excludes_me('... hosszu szoveg vege. Gate: QA.', 'cybersec'), True)
check('case-insensitive gate name',
      declared_gate_excludes_me('Gate: qa + CYBERSEC', 'cybersec'), False)

print()
if FAILS:
    print(f'controls: FAIL ({len(FAILS)}): ' + '; '.join(FAILS))
    sys.exit(1)
print('controls: PASS')
