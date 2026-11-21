#!/usr/bin/env python3
# Selftest for claude-md-index-shrink-check.py (card 2ec21127). Builds a disposable git repo
# with a minimal OLD CLAUDE.md (one bullet carrying protocol tokens in its trailing clause),
# then runs the checker against hand-built NEW variants -- never the real repo's CLAUDE.md.
#
# WhiteHat follow-up (2026-11-15, same root as RedHat 31633): the shrink-check's old
# PROTOCOL_TOKENS test only asked "does this token exist ANYWHERE in the new file", so a token
# that moved off its own rule's line onto an unrelated one (or an unrelated bullet that happens
# to contain the same literal string) would read as fine. Pins the per-rule-line check with a
# mutant that does exactly that move.
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CHECKER = Path(__file__).parent / 'claude-md-index-shrink-check.py'

OLD_CLAUDE_MD = """## Szabály-index

- **Teszt szabályok** -- egy index-sor minden pontra:
  - **1.** **Első szabály, jelentés formája.** A komment elejére kerüljön egy sor: `Gate-SHA: <sha>`, és `Pair-FE: <id>`/`Pair-BE: <id>` is ide tartozik. (/home/neon/marveen/docs/rules/teszt.md)
  - **2.** **Második szabály, semleges.** Semmi protokoll-token, csak sima szöveg. (/home/neon/marveen/docs/rules/teszt.md)
"""

passed = 0
failed = 0


def case(label: str, new_claude_md: str, expect_ok: bool) -> None:
    global passed, failed
    repo = tempfile.mkdtemp(prefix='shrink-check-selftest-')
    try:
        subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
        subprocess.run(['git', 'config', 'user.email', 'x@x'], cwd=repo, check=True)
        subprocess.run(['git', 'config', 'user.name', 'x'], cwd=repo, check=True)
        (Path(repo) / 'CLAUDE.md').write_text(OLD_CLAUDE_MD, encoding='utf-8')
        subprocess.run(['git', 'add', 'CLAUDE.md'], cwd=repo, check=True)
        subprocess.run(['git', 'commit', '-q', '-m', 'old'], cwd=repo, check=True)
        old_ref = subprocess.run(
            ['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True, check=True,
        ).stdout.strip()

        new_path = Path(repo) / 'new-claude.md'
        new_path.write_text(new_claude_md, encoding='utf-8')

        result = subprocess.run(
            [sys.executable, str(CHECKER), old_ref, str(new_path)],
            cwd=repo, capture_output=True, text=True,
        )
        ok = result.returncode == 0
        if ok == expect_ok:
            print(f"  [ok ] {label}: {'OK' if ok else 'RED'} as expected")
            passed += 1
        else:
            print(f"  [FAIL] {label}: expected {'OK' if expect_ok else 'RED'}, got {'OK' if ok else 'RED'}")
            print('    stdout:', result.stdout.replace('\n', ' | '))
            failed += 1
    finally:
        shutil.rmtree(repo, ignore_errors=True)


def main() -> int:
    # Control: unmodified (just shortened the way step 1 actually shortens things -- title+link
    # only for rule 2, title+its-own-token-bearing-clause kept for rule 1) -- must be green.
    case(
        'control: rule 1 keeps its tokens on its own line, rule 2 shortened cleanly',
        """## Szabály-index

- **Teszt szabályok** -- egy index-sor minden pontra:
  - **1.** **Első szabály, jelentés formája.** A komment elejére kerüljön egy sor: `Gate-SHA: <sha>`, és `Pair-FE: <id>`/`Pair-BE: <id>` is ide tartozik. (/home/neon/marveen/docs/rules/teszt.md)
  - **2.** **Második szabály, semleges.** (/home/neon/marveen/docs/rules/teszt.md)
""",
        expect_ok=True,
    )

    # Mutant A: the tokens are DROPPED from rule 1's line entirely, with no replacement anywhere.
    # The OLD whole-file check would also have caught this one (token missing from the whole
    # file) -- kept as a baseline sanity check, not the new behaviour this selftest exists for.
    case(
        'mutant A: tokens dropped from rule 1, not present anywhere -- RED',
        """## Szabály-index

- **Teszt szabályok** -- egy index-sor minden pontra:
  - **1.** **Első szabály, jelentés formája.** (/home/neon/marveen/docs/rules/teszt.md)
  - **2.** **Második szabály, semleges.** (/home/neon/marveen/docs/rules/teszt.md)
""",
        expect_ok=False,
    )

    # Mutant B (the actual regression this follow-up closes): the tokens are MOVED off rule 1's
    # own line onto rule 2's line instead. The literal strings `Gate-SHA:`, `Pair-FE:`, `Pair-BE:`
    # are still present SOMEWHERE in the new file -- the old whole-file-membership check would
    # have read this as fine. The per-rule-line check must not.
    case(
        'mutant B: tokens moved from rule 1 onto rule 2 (still present in the file) -- RED',
        """## Szabály-index

- **Teszt szabályok** -- egy index-sor minden pontra:
  - **1.** **Első szabály, jelentés formája.** (/home/neon/marveen/docs/rules/teszt.md)
  - **2.** **Második szabály, semleges.** `Gate-SHA: <sha>`, `Pair-FE: <id>`/`Pair-BE: <id>`. (/home/neon/marveen/docs/rules/teszt.md)
""",
        expect_ok=False,
    )

    print(f"\nclaude-md-index-shrink-check.selftest: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
