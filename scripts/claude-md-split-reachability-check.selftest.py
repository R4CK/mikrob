#!/usr/bin/env python3
"""Self-test for scripts/claude-md-split-reachability-check.py (card cc72cb3e).

Runs RedHat's own 10 mutants (comment 30478, numbered A1-A10) plus the pre-existing in-place
weakening control, each against a throwaway sandbox copy of the REAL CLAUDE.md + docs/rules
(never the real files), and asserts the checker exits non-zero on every one of them and 0 on
the unmutated control.

Run: python3 scripts/claude-md-split-reachability-check.selftest.py
Exit: 0 = all pass, 1 = a failure.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
CHECKER = HERE / "claude-md-split-reachability-check.py"
REAL_CLAUDE_MD = REPO_ROOT / "CLAUDE.md"
REAL_RULES_DIR = REPO_ROOT / "docs" / "rules"
OLD_REF = "61a258e38"

pass_count = 0
fail_count = 0


def ok(msg: str) -> None:
    global pass_count
    print(f"  [ok ] {msg}")
    pass_count += 1


def bad(msg: str, detail: str = "") -> None:
    global fail_count
    print(f"  [FAIL] {msg}")
    if detail:
        print(f"     {detail}")
    fail_count += 1


def run_checker(claude_md: Path, rules_dir: Path) -> tuple[int, str]:
    r = subprocess.run(
        [sys.executable, str(CHECKER), OLD_REF, str(claude_md), str(rules_dir)],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    return r.returncode, r.stdout + r.stderr


def sandbox():
    d = Path(tempfile.mkdtemp())
    claude_md = d / "CLAUDE.md"
    rules_dir = d / "rules"
    shutil.copy(REAL_CLAUDE_MD, claude_md)
    shutil.copytree(REAL_RULES_DIR, rules_dir)
    return d, claude_md, rules_dir


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text, f"{label}: pattern not found: {old!r}"
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def case(label: str, mutate, expect_red: bool = True) -> None:
    d, claude_md, rules_dir = sandbox()
    try:
        mutate(claude_md, rules_dir)
        rc, out = run_checker(claude_md, rules_dir)
        red = rc != 0
        if red == expect_red:
            ok(f"{label}: {'RED' if red else 'GREEN'} as expected")
        else:
            bad(f"{label}: expected {'RED' if expect_red else 'GREEN'}, got {'RED' if red else 'GREEN'}", out[-800:])
    finally:
        shutil.rmtree(d)


# --- control: unmutated real files must pass clean --------------------------------------------
case("control: unmutated", lambda c, r: None, expect_red=False)

# --- control: in-place weakening (the ORIGINAL conservation check's own target) ---------------
def mut_control_weaken(claude_md: Path, rules_dir: Path) -> None:
    replace_once(
        rules_dir / "munkavegzesi-szabalyok.md",
        "a készítő SOHA nem ellenőrzi a sajátját",
        "a készítő ritkán ellenőrzi a sajátját",
        "control-weaken",
    )
case("control: in-place weakening of an old line", mut_control_weaken)

# --- A1: a contradicting exception appended INTO rule 4's index bullet lead -------------------
def mut_a1(claude_md: Path, rules_dir: Path) -> None:
    replace_once(
        claude_md,
        "- **4.** **Készterméket csak NEM a készítő ellenőrizhet -- KOCKÁZAT-ALAPÚ gate-tiering (Peti szabály 2026-07-05).**",
        "- **4.** **Készterméket csak NEM a készítő ellenőrizhet -- KOCKÁZAT-ALAPÚ gate-tiering (Peti szabály 2026-07-05) KIVÉVE sürgős esetben.**",
        "A1",
    )
case("A1: contradicting exception appended into rule-4's index lead", mut_a1)

# --- A2: a conditional sentence prepended to rule 15's index bullet lead ----------------------
def mut_a2(claude_md: Path, rules_dir: Path) -> None:
    replace_once(
        claude_md,
        "- **15.** **SOHA ne írj `cd <könyvtár>",
        "- **15.** **Csak mopsionra: SOHA ne írj `cd <könyvtár>",
        "A2",
    )
case("A2: qualifying sentence prepended into rule-15's index lead", mut_a2)

# --- A3: rule 15's whole bullet line wrapped in an HTML comment (hidden from a rendered read) --
def mut_a3(claude_md: Path, rules_dir: Path) -> None:
    text = claude_md.read_text(encoding="utf-8")
    marker = "  - **15.** **SOHA ne írj"
    start = text.index(marker)
    end = text.index("\n", start)
    line = text[start:end]
    claude_md.write_text(text[:start] + f"<!-- {line} -->" + text[end:], encoding="utf-8")
case("A3: rule-15's bullet wrapped in an HTML comment", mut_a3)

# --- A4: rule 15's text moved to an UNLINKED docs/rules file -----------------------------------
def mut_a4(claude_md: Path, rules_dir: Path) -> None:
    f = rules_dir / "munkavegzesi-szabalyok.md"
    text = f.read_text(encoding="utf-8")
    marker = "15. **SOHA ne írj `cd <könyvtár> && grep|sed|cat|head|tail|find|git log ...` alakot Bash-hívásban (kártyák a1b2a1de + 6b32a478).**"
    assert marker in text, "A4: rule-15 marker not found in munkavegzesi-szabalyok.md"
    start = text.index(marker)
    end = text.index("\n", start)
    moved = text[start:end]
    f.write_text(text[:start] + text[end:], encoding="utf-8")
    (rules_dir / "zz-archive.md").write_text(moved + "\n", encoding="utf-8")
case("A4: rule-15 moved to an unlinked docs/rules file", mut_a4)

# --- A5: the approval-rule index bullet INVERTED (says approval is NOT needed) -----------------
def mut_a5(claude_md: Path, rules_dir: Path) -> None:
    replace_once(
        claude_md,
        "Küldés kifelé (email, külső poszt, harmadik félnek menő üzenet), törlés, pénzköltés, és bármi visszafordíthatatlan: Peti jóváhagyása kell",
        "Küldés kifelé (email, külső poszt, harmadik félnek menő üzenet), törlés, pénzköltés, és bármi visszafordíthatatlan: Peti jóváhagyása NEM kell",
        "A5",
    )
case("A5: approval-rule index bullet inverted", mut_a5)

# --- A6: the whole rule-22 index bullet DELETED --------------------------------------------------
def mut_a6(claude_md: Path, rules_dir: Path) -> None:
    text = claude_md.read_text(encoding="utf-8")
    marker = "  - **22.** **WSL megosztott home-könyvtár takarítása"
    start = text.index(marker)
    end = text.index("\n", start) + 1
    claude_md.write_text(text[:start] + text[end:], encoding="utf-8")
case("A6: rule-22 index bullet deleted outright", mut_a6)

# --- A7: a protocol token corrupted down to 0 occurrences ---------------------------------------
def mut_a7(claude_md: Path, rules_dir: Path) -> None:
    replace_once(claude_md, "DEFAULT-DENY", "DEFAULT DENY", "A7")
case("A7: protocol token (DEFAULT-DENY, its only occurrence) corrupted", mut_a7)

# --- A8: a bullet's link points at a file that does not exist -----------------------------------
def mut_a8(claude_md: Path, rules_dir: Path) -> None:
    replace_once(
        claude_md,
        "(/home/neon/marveen/docs/rules/munkavegzesi-szabalyok.md)\n  - **1b.**",
        "(/home/neon/marveen/docs/rules/munkavegzesi-szabalyok-NONEXISTENT.md)\n  - **1b.**",
        "A8",
    )
case("A8: a bullet link points at a nonexistent file", mut_a8)

# --- A9: a relative link put back instead of the repo-root-absolute convention ------------------
def mut_a9(claude_md: Path, rules_dir: Path) -> None:
    replace_once(
        claude_md,
        "(/home/neon/marveen/docs/rules/munkavegzesi-szabalyok.md)\n  - **1b.**",
        "(docs/rules/munkavegzesi-szabalyok.md)\n  - **1b.**",
        "A9",
    )
case("A9: a relative docs/rules link put back", mut_a9)

# --- A10: rule 14's whole bullet line wrapped in a fenced code block -----------------------------
def mut_a10(claude_md: Path, rules_dir: Path) -> None:
    text = claude_md.read_text(encoding="utf-8")
    marker = "  - **14.** **ZAJOS PARANCS-KIMENET"
    start = text.index(marker)
    end = text.index("\n", start)
    line = text[start:end]
    claude_md.write_text(text[:start] + f"```\n{line}\n```" + text[end:], encoding="utf-8")
case("A10: rule-14's bullet wrapped in a fenced code block", mut_a10)

print()
print(f"claude-md-split-reachability-check.selftest: {pass_count} passed, {fail_count} failed")
sys.exit(1 if fail_count else 0)
