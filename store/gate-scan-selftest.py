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
from gate_scan_lib import PASS_RE, FAIL_RE, declared_gate_excludes_me, verdict_body  # noqa: E402

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

# ------------------------------------------------------------- PASS_RE/FAIL_RE vocabulary (171422d2)
# The 62-board-wide measured synonym shapes (2026-08-24), plus the base forms both scanners already
# recognized, kept here so a future refactor cannot silently narrow the vocabulary back down.
check('base form: QA PASS', bool(PASS_RE.match('QA PASS -- everything green')), True)
check('base form: QA2 PASS', bool(PASS_RE.match('QA2 PASS')), True)
check('base form: CYBERSEC GO', bool(PASS_RE.match('CYBERSEC GO')), True)
check('base form: CYBERED GO', bool(PASS_RE.match('CYBERED GO')), True)
# ---- sentence/clause anchoring of GATE_DECL_RX (card 82fa48b0) -----------------------------
#
# THE FOUNDING CASE, on its ORIGINAL text. This matters: the live 67a5ee01 no longer reproduces the
# bug, because MikroB appended an explicit `Gate: QA + Cybersec` line to it afterwards. Anyone who
# tests against the live card gets {QA, CYBERSEC} under every candidate rule and concludes there was
# nothing to fix. The text below is the live description with that appended line removed -- every
# `Gate:` in it is prose ABOUT designations, not a designation.
FOUNDING_ORIGINAL = (
    '2) A MikroB altal a kartyara irt "Gate: QA + X" designacio eddig CSAK kommentbe kerult,\n'
    'nem a description-be. Forditott kockazat is van: ha egy epito sajat kommentjebol\n'
    '(pl. "Gate: QA") atmasolja a description-be, az egy korabban nem letezo designaciot csinal.\n'
    'MEGOLDAS: (a) a regex bovitese testver-agensekkel; (b) MikroB mostantol a Gate: sort\n'
    'description-be irja PUT-tal, nem csak kommentbe.'
)
# The whole point: NO gate may be excluded by prose that merely discusses designations. Under the
# old bare-search rule the LAST match was "...a Gate: sort description-be irja PUT-tal...", which
# names no role -> an empty role set -> all three gates excluded from an undesignated card.
for _g in ('qa', 'cybersec', 'cybered'):
    check('founding case (67a5ee01 ORIGINAL text): %s is NOT excluded by quoted prose' % _g,
          declared_gate_excludes_me(FOUNDING_ORIGINAL, _g), False)

check('quoted prose alone is not a designation',
      declared_gate_excludes_me('Az epito azt irta "Gate: QA + Cybersec" a kommentben.', 'cybered'),
      False)
check('prose naming the line mid-sentence is not a designation',
      declared_gate_excludes_me('MikroB mostantol a Gate: sort description-be irja.', 'cybersec'),
      False)

# The 77fd0f07 shape that line-start anchoring broke, and that this rule must keep: a real
# designation written as the CLOSING SENTENCE of a paragraph. 419 board cards look like this.
check('REGRESSION 77fd0f07: a designation closing a sentence still counts',
      declared_gate_excludes_me('... a felbontas szerint. Gate: QA.', 'cybersec'), True)
check('clause boundary: after a semicolon',
      declared_gate_excludes_me('elso resz; Gate: QA + Cybersec', 'cybered'), True)
check('clause boundary: after a comma',
      declared_gate_excludes_me('valami, Gate: QA + Cybersec', 'cybered'), True)
check('clause boundary: immediately after an opening paren, no space',
      declared_gate_excludes_me('valami (Gate: QA+Cybersec, internet-facing)', 'cybered'), True)
check('a designation on its own line still counts',
      declared_gate_excludes_me('szoveg\n\nGate: QA + Cybersec', 'cybered'), True)
check('CONTROL: the boundary class must NOT admit a quote -- that is the founding bug',
      declared_gate_excludes_me('valami "Gate: QA" valami', 'cybered'), False)
check('CONTROL: a word ending in -gate is not a designation',
      declared_gate_excludes_me('a watergate: QA + Cybersec', 'cybered'), False)

check('base form: CYBERED FULL-CARD GO', bool(PASS_RE.match('CYBERED FULL-CARD GO')), True)
check('base form: QA FAIL', bool(FAIL_RE.match('QA FAIL')), True)
check('base form: CYBERSEC NO-GO', bool(FAIL_RE.match('CYBERSEC NO-GO')), True)
check('base form: CYBERED NO-GO', bool(FAIL_RE.match('CYBERED NO-GO')), True)
check('measured synonym: QA GATE: PASS (38 board-wide)', bool(PASS_RE.match('QA GATE: PASS')), True)
check('measured synonym: QA2 GATE: PASS', bool(PASS_RE.match('QA2 GATE: PASS')), True)
check('measured synonym: QA VERDICT: PASS (21 board-wide)', bool(PASS_RE.match('QA VERDICT: PASS')), True)
check('measured synonym: CYBERSEC GATE: GO (3 board-wide)', bool(PASS_RE.match('CYBERSEC GATE: GO')), True)
check('measured synonym, FAIL side: QA GATE: FAIL', bool(FAIL_RE.match('QA GATE: FAIL')), True)
check('measured synonym, FAIL side: QA VERDICT: FAIL', bool(FAIL_RE.match('QA VERDICT: FAIL')), True)
check('measured synonym, FAIL side: CYBERSEC GATE: NO-GO', bool(FAIL_RE.match('CYBERSEC GATE: NO-GO')), True)
check('CONTROL: an unmeasured CYBERED GATE: GO form is NOT added speculatively',
      bool(PASS_RE.match('CYBERED GATE: GO')), False)
check('CONTROL: PASS_RE does not also match a FAIL comment',
      bool(PASS_RE.match('QA GATE: FAIL')), False)
check('CONTROL: FAIL_RE does not also match a PASS comment',
      bool(FAIL_RE.match('QA VERDICT: PASS')), False)
check('CONTROL: prose mentioning GATE/VERDICT without the verdict word is not a match',
      bool(PASS_RE.match('QA GATE: still running, no verdict yet')), False)

print()
if FAILS:
    print(f'controls: FAIL ({len(FAILS)}): ' + '; '.join(FAILS))
    sys.exit(1)
print('controls: PASS')
