#!/usr/bin/env python3
"""skill-merge-check.py -- catch a merge that PRESERVED a superseded command form.

WHY THIS EXISTS (card 30b76a8d, Cybersec NO-GO comment 20441). Un-shadowing a per-agent skill
copy is done by merging it with the authoritative one under a safe-sounding invariant: "no line
from either side may be lost". That invariant is right for ADDITIVE content and wrong for
SUPERSEDED content, and nothing in it can tell the two apart.

Measured consequence: on `gate-worktree-pattern` the project side had no own content at all -- its
five "project-only" lines were the OLD two-argument `cc-gate-worktree.sh` call that card a7da80d6
replaced, and which exits 2 today. The merge kept them AHEAD of the working `--agent` form, so all
four gate agents were shown the dead command first. The global copy has three invocations of that
script; the merged file had six.

THE SIGNAL, which is Cybersec's and is deliberately simple: if the RESULT mentions the same script
MORE times than the authoritative source does, the extra mentions are candidate superseded forms.
Measured on the real corpus of 11 merged files: it flagged exactly the four broken ones and none of
the ten good ones, where the kept project content was genuine (1 to 66 lines each).

It is a SUSPICION, not a proof -- a project copy may legitimately use a script more often. So this
exits non-zero to force a human look, and prints the lines so the look is cheap.

Usage:
  skill-merge-check.py <result-file> <authoritative-source-file>
  skill-merge-check.py --selftest
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

# A script as it appears in prose or in a command: `store/foo.sh`, `scripts/bar.py`. Keyed on the
# BASENAME, because the same script is written both bare and with a full path in the same file and
# a per-spelling count would compare different things (measured: that alone produced a false
# positive on i18n-parity-sweep, where one prose mention was bare and five commands were absolute).
SCRIPT_RX = re.compile(r'([\w./-]+\.(?:sh|py))\b([^\n`]*)')


def invocation_forms(text: str) -> dict[str, set[tuple[str, ...]]]:
    """script basename -> the distinct argument token sequences it is used with."""
    forms: dict[str, set[tuple[str, ...]]] = {}
    for m in SCRIPT_RX.finditer(text):
        name = m.group(1).lstrip('`').rsplit('/', 1)[-1]
        args = tuple(t for t in m.group(2).split() if t not in ('\\', '|', '&&'))
        forms.setdefault(name, set()).add(args)
    return forms


def _is_strict_subsequence(short: tuple[str, ...], long: tuple[str, ...]) -> bool:
    """Every token of `short`, in order, inside `long` -- and `long` has more."""
    if len(short) >= len(long):
        return False
    it = iter(long)
    return all(tok in it for tok in short)


def check(result_text: str, source_text: str) -> list[tuple[str, tuple, tuple]]:
    """Same script invoked in two forms where one is the other MINUS some arguments.

    That shape is what a superseded call looks like next to its replacement: card a7da80d6 added a
    REQUIRED `--agent <you>`, so the dead form is exactly the live one with those two tokens taken
    out. Merely using a script more often is NOT the signal -- project-only content legitimately
    does that (measured: 5 identical invocations in i18n-parity-sweep, all correct).

    A pair already present in the SOURCE is not the merge's doing, so it is not reported.
    """
    src_pairs = set()
    for name, forms in invocation_forms(source_text).items():
        for a in forms:
            for b in forms:
                if _is_strict_subsequence(a, b):
                    src_pairs.add((name, a, b))
    rows = []
    for name, forms in invocation_forms(result_text).items():
        for a in forms:
            for b in forms:
                if _is_strict_subsequence(a, b) and (name, a, b) not in src_pairs:
                    rows.append((name, a, b))
    rows.sort(key=lambda t: len(t[2]) - len(t[1]), reverse=True)
    return rows



# A top-level YAML key in the frontmatter block: `name:`, `description:`. Indented lines and list
# items belong to the key above them, so they are not candidates.
FM_KEY_RX = re.compile(r'^([A-Za-z_][\w-]*):')


def frontmatter_keys(text: str) -> Counter | None:
    """Top-level keys of the leading `---` block, or None if the file has no frontmatter.

    Returns an EMPTY counter for a block that opens and never closes: that file has no readable
    frontmatter at all, which `frontmatter_issues` reports separately. Scanning to EOF instead
    would read body prose as keys -- measured: doing that reported bogus duplicate keys on two
    seed-skills files whose only real defect is the missing terminator.
    """
    lines = text.split('\n')
    if not lines or lines[0].strip() != '---':
        return None
    keys: Counter = Counter()
    for line in lines[1:]:
        if line.strip() == '---':
            return keys
        m = FM_KEY_RX.match(line)
        if m:
            keys[m.group(1)] += 1
    return Counter()  # opened, never closed


def frontmatter_issues(result_text: str, source_text: str) -> list[str]:
    """Frontmatter the merge made unreadable.

    A skill's frontmatter carries `name` and `description` -- the Level-0 text that decides whether
    the skill is offered at all. YAML has no way to hold two `description:` keys, so an additive
    merge of two copies whose descriptions differ produces a file whose advertised triggers are
    parser-dependent. Measured (card 23d09a68): my own 30b76a8d merge did exactly this to
    vitest-react-router-guard for qa and qa2, in the seed AND the installed copy -- the same
    additive-merge class as the NO-GO, in a file that gate did not reach.

    An issue already present in the SOURCE is not the merge's doing, so it is not reported here,
    matching `check`. A pre-existing malformed frontmatter is a lint's job, not this tool's.
    """
    res, src = frontmatter_keys(result_text), frontmatter_keys(source_text)
    if res is None:
        return []
    issues = []
    if not res and (src is None or src):
        issues.append('frontmatter opens with `---` and never closes, so nothing in it is readable')
    src_dups = {k for k, v in (src or Counter()).items() if v > 1}
    for key, n in sorted(res.items()):
        if n > 1 and key not in src_dups:
            issues.append('`%s:` appears %d times in the frontmatter -- YAML keeps only one, and '
                          'which one is parser-dependent' % (key, n))
    return issues


def _selftest() -> int:
    """The founding case, verbatim in shape: the superseded two-argument call kept alongside
    the --agent one. A guard that has never been run against the case that created it is not
    evidence, so this ships with the tool rather than only in the repo's test file."""
    source = (
        "# create\n"
        "WT=$(bash store/cc-gate-worktree.sh --agent <you> --path <card> <sha>)\n"
        "bash store/cc-gate-worktree.sh --agent <you> <card> <sha>\n"
        "bash store/cc-gate-worktree.sh --agent <you> --remove \"$WT\"\n"
    )
    merged = (
        "# create\n"
        "WT=$(bash store/cc-gate-worktree.sh --path <card> <sha>)\n"
        "bash store/cc-gate-worktree.sh <card> <sha>\n"
        "WT=$(bash store/cc-gate-worktree.sh --agent <you> --path <card> <sha>)\n"
        "bash store/cc-gate-worktree.sh --agent <you> <card> <sha>\n"
        "bash store/cc-gate-worktree.sh --remove \"$WT\"\n"
        "bash store/cc-gate-worktree.sh --agent <you> --remove \"$WT\"\n"
    )
    failures = []
    rows = check(merged, source)
    if not rows or rows[0][0] != 'cc-gate-worktree.sh':
        failures.append('the founding case was not flagged: %r' % rows)
    elif not any('--agent' in b and '--agent' not in a for _, a, b in rows):
        failures.append('flagged, but not on the --agent pair: %r' % rows)
    # CONTROL: a merge that only ADDS prose must stay clean, or the check is unusable in practice.
    if check(source + "\nSome added guidance with no command in it.\n", source):
        failures.append('a prose-only addition was flagged')
    # CONTROL: an identical result is clean.
    if check(source, source):
        failures.append('an identical result was flagged')
    # THE SECOND FOUNDING CASE (card 23d09a68): the same additive merge, applied to frontmatter.
    fm_src = '---\nname: s\ndescription: the project copy\n---\nbody\n'
    fm_bad = '---\nname: s\ndescription: the project copy\ndescription: the global copy\n---\nbody\n'
    if not any('description' in i for i in frontmatter_issues(fm_bad, fm_src)):
        failures.append('a duplicated description: key was not flagged')
    # CONTROL: already duplicated in the source -- not this merge's doing.
    if frontmatter_issues(fm_bad, fm_bad):
        failures.append('a duplicate already present in the source was flagged')
    # CONTROL: a clean merge of the frontmatter stays clean.
    if frontmatter_issues(fm_src, fm_src):
        failures.append('a clean frontmatter was flagged')
    # An opened-but-never-closed block is unreadable, and must not be read as body-prose keys.
    if not frontmatter_issues('---\nname: s\ndescription: d\n\n# Title\nInput: a\nInput: b\n', fm_src):
        failures.append('an unterminated frontmatter was not flagged')
    if any('appears' in i for i in
           frontmatter_issues('---\nname: s\n\n# T\nInput: a\nInput: b\n', fm_src)):
        failures.append('body prose was read as duplicate frontmatter keys')
    for f in failures:
        print('SELFTEST FAIL: %s' % f)
    print('selftest: %s (%d case(s))' % ('FAIL' if failures else 'PASS', 8))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if '--selftest' in argv:
        return _selftest()
    if len(argv) != 2:
        sys.stderr.write(__doc__.split('Usage:')[1])
        return 2
    result, source = Path(argv[0]), Path(argv[1])
    result_text = result.read_text(encoding='utf-8', errors='replace')
    source_text = source.read_text(encoding='utf-8', errors='replace')
    rows = check(result_text, source_text)
    fm = frontmatter_issues(result_text, source_text)
    for issue in fm:
        print('FRONTMATTER in %s: %s' % (result, issue))
    if not rows:
        if fm:
            return 1
        print('OK: %s mentions no script more often than %s, frontmatter intact' % (result, source))
        return 0
    print('SUSPECT superseded-form preservation in %s (source: %s)' % (result, source))
    text = result_text.splitlines()
    for name, a, b in rows:
        print('  %s is invoked BOTH ways -- the first is the second minus %s:'
              % (name, ' '.join(t for t in b if t not in a) or '(nothing)'))
        print('      %s %s' % (name, ' '.join(a)))
        print('      %s %s' % (name, ' '.join(b)))
        for i, line in enumerate(text, 1):
            if name in line:
                print('    %4d| %s' % (i, line.strip()[:110]))
    print('\nEach extra mention is a CANDIDATE superseded form, not a proven one. Read them.')
    return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
