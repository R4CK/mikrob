#!/usr/bin/env python3
"""skill-drift-map.py -- classify the drift between the LIVE global skills and the tracked templates.

WHY THIS EXISTS (card bf67711e). Three trees hold "the skills", and they are not copies of each other:

  ~/.claude/skills                       the live set every RUNNING agent reads
  seed-skills/                           what install-linux.sh:1462 copies into ~/.claude/skills on a
                                         FRESH install (per-directory skip if it already exists), and
                                         what update.sh:665 refreshes for UNTOUCHED copies
  seed-fleet-agents/<agent>/.claude/skills/   the curated per-agent set a NEW agent is seeded with

A plain `diff -r` over them is useless, because TWO KINDS OF DIFFERENCE ARE CORRECT BY DESIGN and
together they account for most of the noise:

  1. PLACEHOLDER RENDERING. Templates ship `{{INSTALL_DIR}}`, `{{MAIN_AGENT_ID}}`, `{{BOT_NAME}}`,
     `{{OWNER_NAME}}`, `{{WEB_PORT}}`; the installer renders them with sed (card 041681b5). A rendered
     line is not drift.
  2. DE-PERSONALISATION. Templates say "a felhasznalo" / "the user" / "csapat-szabaly" where the live
     copy says "Peti". This is deliberate: a fork template a stranger installs must not carry this
     install's owner name. **Syncing live -> template would leak it into every fresh install**, so the
     one direction this tool must never be used to justify is "make the template say Peti".

What is left after normalising both is real, and it splits three ways:
  template LAGS      the live copy has content the template never received -> a candidate SYNC
  LIVE LOST content  the template has content the live copy dropped        -> needs a decision
  two-sided          each side has content the other lacks                 -> needs the skill's owner

Usage:
  skill-drift-map.py                 summary counts
  skill-drift-map.py --full          every file, grouped by verdict
  skill-drift-map.py --skill <name>  one skill, with the differing lines
"""
from __future__ import annotations

import os
import re
import sys
from collections import Counter
from pathlib import Path

INSTALL_DIR = Path(os.environ.get('INSTALL_DIR', '/home/neon/marveen'))
LIVE = Path(os.environ.get('SKILLS_DIR', str(Path.home() / '.claude/skills')))


def env_value(key: str, default: str) -> str:
    """Read an identity value from .env -- the same source update.sh:655 uses."""
    env = INSTALL_DIR / '.env'
    if env.is_file():
        for line in env.read_text(encoding='utf-8', errors='replace').splitlines():
            if line.startswith(key + '='):
                return line.split('=', 1)[1].strip().strip('"')
    return default


SUBS = {
    '{{INSTALL_DIR}}': str(INSTALL_DIR),
    '{{MAIN_AGENT_ID}}': env_value('MAIN_AGENT_ID', 'mikrob'),
    '{{BOT_NAME}}': env_value('BOT_NAME', 'MikroB'),
    '{{OWNER_NAME}}': env_value('OWNER_NAME', 'Peti'),
    '{{WEB_PORT}}': env_value('WEB_PORT', '3420'),
}

# Both sides collapse to <OWNER> so a de-personalised line matches its personalised twin. The list is
# deliberately explicit rather than a clever pattern: a broad regex here would hide real drift.
_OWNER = env_value('OWNER_NAME', 'Peti')
OWNER_RX = re.compile('|'.join([
    re.escape(_OWNER) + r' szab[aá]lya?', r'csapat-szab[aá]lya?',
    re.escape(_OWNER) + r' j[oó]v[aá]hagyva', r'\b' + re.escape(_OWNER) + r'-?(val|nek|t[oó]l|hez)\b',
    r'\b' + re.escape(_OWNER) + r'\b', r'a felhaszn[aá]l[oó]', r'\bthe user\b', r'\bthe operator\b',
]), re.I)


def trees() -> list[tuple[str, Path]]:
    out = [('seed-skills', INSTALL_DIR / 'seed-skills')]
    seed_agents = INSTALL_DIR / 'seed-fleet-agents'
    if seed_agents.is_dir():
        for agent in sorted(seed_agents.iterdir()):
            p = agent / '.claude/skills'
            if p.is_dir():
                out.append((f'seed-fleet-agents/{agent.name}', p))
    return [(n, p) for n, p in out if p.is_dir()]


def render(raw: bytes) -> bytes:
    for k, v in SUBS.items():
        raw = raw.replace(k.encode(), v.encode())
    return raw


def norm(text: str) -> set[str]:
    return {OWNER_RX.sub('<OWNER>', ln).rstrip() for ln in text.splitlines() if ln.strip()}


def classify(tpl: Path, live: Path) -> tuple[str, set[str], set[str]]:
    traw, lraw = tpl.read_bytes(), live.read_bytes()
    if traw == lraw:
        return ('identical', set(), set())
    if render(traw) == lraw:
        return ('placeholder rendering only (correct)', set(), set())
    t = norm(render(traw).decode('utf-8', 'replace'))
    l = norm(lraw.decode('utf-8', 'replace'))
    if t == l:
        return ('de-personalisation only (correct)', set(), set())
    only_live, only_tpl = l - t, t - l
    if not only_tpl:
        return ('template LAGS', only_live, only_tpl)
    if not only_live:
        return ('LIVE LOST content', only_live, only_tpl)
    return ('two-sided', only_live, only_tpl)


def main(argv: list[str]) -> int:
    want_skill = None
    if '--skill' in argv:
        i = argv.index('--skill')
        if i + 1 >= len(argv):
            sys.stderr.write('--skill needs a name\n')
            return 2
        want_skill = argv[i + 1]
    if not LIVE.is_dir():
        sys.stderr.write(f'no live skills directory at {LIVE}\n')
        return 2

    rows, correct = [], Counter()
    for tree_name, tree in trees():
        for skill in sorted(d for d in tree.iterdir() if d.is_dir()):
            if want_skill and skill.name != want_skill:
                continue
            live_skill = LIVE / skill.name
            if not live_skill.is_dir():
                rows.append((tree_name, skill.name, '', 'TEMPLATE-ONLY skill', set(), set()))
                continue
            seen = set()
            for f in sorted(skill.rglob('*')):
                if not f.is_file():
                    continue
                rel = f.relative_to(skill)
                seen.add(rel)
                lf = live_skill / rel
                if not lf.is_file():
                    rows.append((tree_name, skill.name, str(rel), 'template-only file', set(), set()))
                    continue
                verdict, only_live, only_tpl = classify(f, lf)
                if verdict == 'identical':
                    continue
                if verdict.endswith('(correct)'):
                    correct[verdict] += 1
                    continue
                rows.append((tree_name, skill.name, str(rel), verdict, only_live, only_tpl))
            for f in sorted(live_skill.rglob('*')):
                if f.is_file() and f.relative_to(live_skill) not in seen:
                    rows.append((tree_name, skill.name, str(f.relative_to(live_skill)),
                                 'live-only file', set(), set()))

    print('NOT drift, correct by design:')
    for k, v in correct.most_common() or [('(none)', 0)]:
        print('  %4d  %s' % (v, k))
    print('\nREAL DRIFT:')
    for k, v in Counter(r[3] for r in rows).most_common() or [('(none)', 0)]:
        print('  %4d  %s' % (v, k))

    if want_skill:
        for tree_name, skill, rel, verdict, only_live, only_tpl in rows:
            print(f'\n--- {tree_name}/{skill}/{rel}: {verdict}')
            for ln in sorted(only_live):
                print('  live-only | ' + ln[:150])
            for ln in sorted(only_tpl):
                print('  tpl-only  | ' + ln[:150])
    elif '--full' in argv:
        print()
        for r in sorted(rows, key=lambda r: (r[3], r[0], r[1])):
            print('  %-28s %-40s %-32s %s' % r[:4])
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
