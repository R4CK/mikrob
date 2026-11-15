#!/usr/bin/env python3
# Card 2ec21127 (Token 8 base-prompt diet), step 1: verifies the Szabály-index bullet
# shortening (bold title + link only, explanatory prose dropped) did not touch any bold-title
# sentence and did not drop any protocol token from CLAUDE.md. Unlike
# claude-md-split-reachability-check.py (card c60e229a), which proves a VERBATIM MOVE lost
# nothing, this script is for an INTENTIONAL REWRITE: every bullet's trailing prose is expected
# to change (that is the point), but its bold-title sentence -- the rule's own actionable
# statement, per c60e229a's H1/H2 precedent -- must be byte-identical before and after, and
# every protocol token (QA PASS, Gate-SHA:, Pair-FE:, ...) that existed anywhere in the old file
# must still exist somewhere in the new one.
#
# Usage: claude-md-index-shrink-check.py <old-claude-md-git-ref> <new-claude-md-path>
import re
import subprocess
import sys

BULLET_RE = re.compile(
    r'^(\s*-\s+\*\*)([\w.]+)(\.\*\*\s+\*\*)(.*?)(\.\*\*)\s+(.*?)(\s*\(/home/neon/marveen/docs/rules/[\w.-]+\.md\))\s*$'
)

PROTOCOL_TOKENS = [
    'QA PASS', 'QA FAIL', 'CYBERSEC GO', 'CYBERSEC NO-GO', 'CYBERED GO', 'CYBERED NO-GO',
    'Gate-SHA:', 'Fix-Direction:', 'Pair-FE:', 'Pair-BE:', 'BLOKKOLT-', 'ELUTASÍTVA',
    'Kész, ha:', 'allowFrom',
]


def bullets(text: str) -> dict[tuple[str, str], str]:
    out: dict[tuple[str, str], str] = {}
    for line in text.split('\n'):
        m = BULLET_RE.match(line)
        if m:
            num, title, link = m.group(2), m.group(4), m.group(7).strip()
            out[(num, link)] = title
    return out


def main() -> int:
    old_ref, new_path = sys.argv[1], sys.argv[2]
    old_text = subprocess.run(
        ['git', 'show', f'{old_ref}:CLAUDE.md'], capture_output=True, text=True, check=True,
    ).stdout
    with open(new_path, encoding='utf-8') as f:
        new_text = f.read()

    old_b, new_b = bullets(old_text), bullets(new_text)
    missing = [k for k in old_b if k not in new_b]
    changed = [k for k in old_b if k in new_b and old_b[k] != new_b[k]]
    lost_tokens = [t for t in PROTOCOL_TOKENS if t in old_text and t not in new_text]

    print(f"old bullets: {len(old_b)}, new bullets: {len(new_b)}")
    print(f"missing bullets: {len(missing)}", missing[:5])
    print(f"bold title changed: {len(changed)}", changed[:5])
    print(f"protocol tokens lost: {len(lost_tokens)}", lost_tokens)

    ok = not missing and not changed and not lost_tokens
    print('RESULT:', 'OK' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
