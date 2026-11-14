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

# --- QA1 (31269): delete rule 14's bullet, duplicate rule 13's in its place -- the raw bullet-
# count floor is unchanged (one removed, one added), so only per-rule-number tracking catches it.
def mut_qa1(claude_md: Path, rules_dir: Path) -> None:
    text = claude_md.read_text(encoding="utf-8")
    marker14 = "  - **14.** **ZAJOS PARANCS-KIMENET"
    start = text.index(marker14)
    end = text.index("\n", start) + 1
    rule14_line = text[start:end]
    marker13 = "  - **13.** **Üzleti adat"
    start13 = text.index(marker13)
    end13 = text.index("\n", start13) + 1
    rule13_line = text[start13:end13]
    text = text[:start] + rule13_line + text[end:]  # replace rule 14's bullet with a copy of 13's
    claude_md.write_text(text, encoding="utf-8")
case("QA1: rule-14 bullet deleted, rule-13 bullet duplicated in its place (count unchanged)", mut_qa1)

# --- duplicate heading (RedHat gap): the Munkavegzesi section heading appears twice ---------------
def mut_dup_heading(claude_md: Path, rules_dir: Path) -> None:
    text = claude_md.read_text(encoding="utf-8")
    marker = "- **Munkavégzési szabályok (csapat-workflow)**"
    idx = text.index(marker)
    end = text.index("\n", idx) + 1
    heading_line = text[idx:end]
    claude_md.write_text(text[:end] + heading_line + text[end:], encoding="utf-8")
case("duplicate section heading (Munkavegzesi szabalyok appears twice)", mut_dup_heading)

# --- inverted allowlisted bullet (RedHat gap): 19 and 8a skip the verbatim check entirely ---------
def mut_pinned_19(claude_md: Path, rules_dir: Path) -> None:
    replace_once(
        claude_md,
        "- **19.** **Tisztázó kérdés, ha a feladat lényege vagy célja nem tiszta",
        "- **19.** **SOHA ne kérdezz, ha a feladat lényege vagy célja nem tiszta",
        "pinned-19",
    )
case("inverted allowlisted bullet 19 (bypasses the verbatim check, caught by the pin instead)", mut_pinned_19)

def mut_pinned_8a(claude_md: Path, rules_dir: Path) -> None:
    replace_once(
        claude_md,
        "- **8a.** **A párosítás LÉTREJÖTTE legyen strukturális és lekérdezhető",
        "- **8a.** **A párosítás LÉTREJÖTTE NEM kell legyen strukturális és lekérdezhető",
        "pinned-8a",
    )
case("inverted allowlisted bullet 8a (bypasses the verbatim check, caught by the pin instead)", mut_pinned_8a)

# --- missing baseline entry: a pinned bullet with nothing recorded yet must also be RED, not
# silently skipped (a fresh checkout before the first --update-baseline run) --------------------
def mut_no_baseline(claude_md: Path, rules_dir: Path) -> None:
    (rules_dir / ".reachability-baseline.json").unlink(missing_ok=True)
case("no baseline file at all (pinned bullets have nothing to compare against)", mut_no_baseline)

# --- --update-baseline (MikroB hold 31268): the one-command path for an INTENTIONAL rewording
# of a line that existed in the pre-split monolith -- must turn a legitimate edit back to GREEN,
# and must refuse to write anything without --yes.
d, claude_md, rules_dir = sandbox()
try:
    replace_once(
        rules_dir / "munkavegzesi-szabalyok.md",
        "a készítő SOHA nem ellenőrzi a sajátját",
        "a készítő a kockázat-alapú tiering szerint ritkán ellenőrzi a sajátját (szándékos reword a selftesthez)",
        "update-baseline-reword",
    )
    rc, out = run_checker(claude_md, rules_dir)
    if rc != 0:
        ok("a reworded binding line turns the checker red before --update-baseline")
    else:
        bad("the reworded line did not turn the checker red", out[-500:])

    rc_noyes = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir)],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    baseline_file = rules_dir / ".reachability-baseline.json"
    before = baseline_file.read_text(encoding="utf-8")
    after_noyes = baseline_file.read_text(encoding="utf-8") if baseline_file.exists() else None
    if rc_noyes.returncode != 0 and after_noyes == before:
        ok("--update-baseline without --yes writes nothing and exits non-zero")
    else:
        bad("--update-baseline without --yes still wrote the baseline file", rc_noyes.stdout + rc_noyes.stderr)

    rc_yes = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir), "--yes"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    rc2, out2 = run_checker(claude_md, rules_dir)
    if rc_yes.returncode == 0 and rc2 == 0:
        ok("--update-baseline --yes records the reworded line; the checker is green again")
    else:
        bad("checker still red after --update-baseline --yes", out2[-800:])
finally:
    shutil.rmtree(d)

# --- RedHat NO-GO (re-gate on 6f5045341), U2: --update-baseline must not silently bless a
# REMOVED binding line the way it blesses a REWORD -- delete the line outright (no replacement
# anywhere in the corpus), confirm --update-baseline refuses without --allow-removal, confirm
# the printed hash works when supplied. -------------------------------------------------------
d, claude_md, rules_dir = sandbox()
try:
    removed_line = '- Nincs AI klisé. Soha ne mondd: "Természetesen!", "Remek kérdés!", "Szívesen segítek", "Mint mesterséges intelligencia".'
    path = rules_dir / "szemelyiseg.md"
    text = path.read_text(encoding="utf-8")
    assert removed_line in text, "U2 setup: removed_line not found verbatim in szemelyiseg.md"
    path.write_text(text.replace(removed_line + "\n", "", 1), encoding="utf-8")

    rc, out = run_checker(claude_md, rules_dir)
    if rc != 0:
        ok("U2: an outright-removed binding line turns the checker red")
    else:
        bad("U2: removing the line did not turn the checker red", out[-500:])

    baseline_file = rules_dir / ".reachability-baseline.json"
    baseline_before = baseline_file.read_text(encoding="utf-8") if baseline_file.exists() else None
    rc_blocked = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir), "--yes"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    baseline_after = baseline_file.read_text(encoding="utf-8") if baseline_file.exists() else None
    if rc_blocked.returncode != 0 and baseline_after == baseline_before:
        ok("U2: --update-baseline --yes alone REFUSES a line with no similar replacement (no --allow-removal)")
    else:
        bad("U2: --yes alone blessed a removed line with no --allow-removal", rc_blocked.stdout + rc_blocked.stderr)

    # the hash the refusal itself printed, from its per-line summary bullet (not the generic
    # "<hash>" placeholder in the instructional sentence above it)
    m = __import__("re").search(r"^\s+--allow-removal (\S+)\s+#", rc_blocked.stdout + rc_blocked.stderr, __import__("re").M)
    if not m:
        bad("U2: the refusal did not print a usable --allow-removal hash", rc_blocked.stdout + rc_blocked.stderr)
    else:
        h = m.group(1)
        rc_allowed = subprocess.run(
            [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir),
             "--yes", "--allow-removal", h],
            capture_output=True, text=True, cwd=str(REPO_ROOT),
        )
        rc2, out2 = run_checker(claude_md, rules_dir)
        if rc_allowed.returncode == 0 and rc2 == 0:
            ok("U2: the EXACT printed hash via --allow-removal lets the removal through, checker green after")
        else:
            bad("U2: supplying the printed hash did not clear the removal", out2[-800:])
finally:
    shutil.rmtree(d)

# --- RedHat NO-GO, U3: --update-baseline must not silently RE-PIN a CHANGED bullet (19/8a) --
# print old vs new and refuse without --allow-pin-change, even though nothing is "missing" in
# the conservation sense (the bullet's own file untouched, only the CLAUDE.md index text changed).
d, claude_md, rules_dir = sandbox()
try:
    # Establish a baseline FIRST (pins the real, un-inverted text) -- the thing U3 is about is a
    # CHANGE relative to an existing recorded pin, not the first-ever recording of one.
    rc_first = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir), "--yes"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    if rc_first.returncode != 0:
        bad("U3 setup: could not establish an initial baseline", rc_first.stdout + rc_first.stderr)

    replace_once(
        claude_md,
        "- **19.** **Tisztázó kérdés, ha a feladat lényege vagy célja nem tiszta",
        "- **19.** **SOHA ne kérdezz, ha a feladat lényege vagy célja nem tiszta",
        "U3-invert-19",
    )
    rc, out = run_checker(claude_md, rules_dir)
    if rc != 0 and "pinned bullet 19" in out:
        ok("U3: inverting pinned bullet 19 (with an existing baseline) turns the checker red")
    else:
        bad("U3: inverting bullet 19 did not turn the checker red on the pinned-bullet check", out[-500:])

    baseline_before = (rules_dir / ".reachability-baseline.json").read_text(encoding="utf-8")
    rc_blocked = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir), "--yes"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    baseline_after = (rules_dir / ".reachability-baseline.json").read_text(encoding="utf-8")
    combined = rc_blocked.stdout + rc_blocked.stderr
    if rc_blocked.returncode != 0 and baseline_after == baseline_before and "OLD:" in combined and "NEW:" in combined:
        ok("U3: --yes alone REFUSES to re-pin a changed bullet, and prints OLD/NEW text")
    else:
        bad("U3: --yes alone silently re-pinned the inverted bullet, or did not show the diff", combined)

    rc_allowed = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir),
         "--yes", "--allow-pin-change", "19"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    rc2, out2 = run_checker(claude_md, rules_dir)
    if rc_allowed.returncode == 0 and rc2 == 0:
        ok("U3: --allow-pin-change 19 lets the re-pin through, checker green after")
    else:
        bad("U3: --allow-pin-change 19 did not clear the pin change", out2[-800:])
finally:
    shutil.rmtree(d)

print()
print(f"claude-md-split-reachability-check.selftest: {pass_count} passed, {fail_count} failed")
sys.exit(1 if fail_count else 0)
