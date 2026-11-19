#!/usr/bin/env python3
"""Self-test for scripts/claude-md-split-reachability-check.py (card cc72cb3e).

Runs RedHat's own 10 mutants (comment 30478, numbered A1-A10) plus the pre-existing in-place
weakening control, each against a throwaway sandbox copy of the REAL CLAUDE.md + docs/rules
(never the real files), and asserts the checker exits non-zero on every one of them and 0 on
the unmutated control.

Run: python3 scripts/claude-md-split-reachability-check.selftest.py
Exit: 0 = all pass, 1 = a failure.
"""
import re
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


def establish_clean_baseline(claude_md: Path, rules_dir: Path) -> None:
    """Accept whatever the REAL corpus already needs accepted against OLD_REF (card cc72cb3e:
    5c55ed281 reworded two lines on develop -- 75% -> 50% compaction threshold -- before this
    checker was wired into any gate, so nothing ever ran --update-baseline for them) before a
    test applies its OWN mutation on top. Without this, a test's bootstrap `--yes` alone always
    refused (the real corpus has permanent legitimate rewords against the frozen OLD_REF), and
    the single-hash regex a test uses to pick up ITS OWN new candidate grabbed one of these
    instead. Content-dynamic (reads whatever --accept/--allow-removal lines the refusal itself
    prints), never hardcodes today's specific hashes, so a FUTURE legitimate historical edit
    needs no change here either.
    """
    for _ in range(10):
        r = subprocess.run(
            [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir), "--yes"],
            capture_output=True, text=True, cwd=str(REPO_ROOT),
        )
        if r.returncode == 0:
            return
        combined = r.stdout + r.stderr
        accepts = re.findall(r"^\s+--accept (\S+)\s+#", combined, re.M)
        removals = re.findall(r"^\s+--allow-removal (\S+)\s+#", combined, re.M)
        if not accepts and not removals:
            raise RuntimeError(f"establish_clean_baseline: refused with no usable hash: {combined}")
        args = [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir), "--yes"]
        for h in accepts:
            args += ["--accept", h]
        for h in removals:
            args += ["--allow-removal", h]
        r2 = subprocess.run(args, capture_output=True, text=True, cwd=str(REPO_ROOT))
        if r2.returncode == 0:
            return
    raise RuntimeError("establish_clean_baseline: did not converge after 10 rounds")


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
    establish_clean_baseline(claude_md, rules_dir)
    # Reword BOTH the rule file and CLAUDE.md's own index bullet for rule 4, identically -- the
    # same invariant the rule-21/live-drift fix (card cc72cb3e rebase) closed: the bullet and its
    # linked rule file's full text must stay verbatim-consistent, or check_index_structure's
    # per-bullet check (now reading rules_dir's own copy, not a hardcoded live path) rightly
    # flags it. This test is only about the CONSERVATION reword workflow, so both copies move
    # together; staying out of sync is exactly the real-world bug rule-21 had, tested elsewhere.
    replace_once(
        rules_dir / "munkavegzesi-szabalyok.md",
        "a készítő SOHA nem ellenőrzi a sajátját",
        "a készítő a kockázat-alapú tiering szerint ritkán ellenőrzi a sajátját (szándékos reword a selftesthez)",
        "update-baseline-reword",
    )
    replace_once(
        claude_md,
        "a készítő SOHA nem ellenőrzi a sajátját",
        "a készítő a kockázat-alapú tiering szerint ritkán ellenőrzi a sajátját (szándékos reword a selftesthez)",
        "update-baseline-reword-index",
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

    # QA2 FAIL 31319: --yes alone must NOT bless a REWORD -- only --accept <hash> can.
    rc_yes_only = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir), "--yes"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    after_yes_only = baseline_file.read_text(encoding="utf-8") if baseline_file.exists() else None
    if rc_yes_only.returncode != 0 and after_yes_only == before:
        ok("31319: --yes alone REFUSES a REWORD with no --accept <hash>, writes nothing")
    else:
        bad("31319: --yes alone blessed a REWORD with no --accept", rc_yes_only.stdout + rc_yes_only.stderr)

    # ALL printed hashes, not just one: establish_clean_baseline's two already-accepted real
    # rewords are STILL candidates on every --update-baseline run (it recomputes the full set
    # against OLD_REF each time, it does not merge with the previous baseline), so this
    # mutation's own hash is one of three, not the only one.
    combined_refusal = rc_yes_only.stdout + rc_yes_only.stderr
    reword_hashes = re.findall(r"^\s+--accept (\S+)\s+#", combined_refusal, re.M)
    if not reword_hashes:
        bad("31319: the refusal did not print a usable --accept hash", combined_refusal)
    else:
        accept_args = []
        for h in reword_hashes:
            accept_args += ["--accept", h]
        rc_yes = subprocess.run(
            [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir),
             "--yes", *accept_args],
            capture_output=True, text=True, cwd=str(REPO_ROOT),
        )
        rc2, out2 = run_checker(claude_md, rules_dir)
        if rc_yes.returncode == 0 and rc2 == 0:
            ok("--update-baseline --yes --accept <hash> records the reworded line; checker green again")
        else:
            bad("checker still red after --update-baseline --yes --accept <hash>", out2[-800:])
finally:
    shutil.rmtree(d)

# --- QA2 FAIL 31319: a meaning-INVERTING edit classifies as REWORD by similarity (it keeps most
# of the sentence) exactly like a harmless wording tweak -- --yes alone must refuse it the same
# as any other reword, and it must only go through when its OWN printed hash is named. ----------
d, claude_md, rules_dir = sandbox()
try:
    establish_clean_baseline(claude_md, rules_dir)
    replace_once(
        rules_dir / "szemelyiseg.md",
        'Soha ne mondd: "Természetesen!", "Remek kérdés!", "Szívesen segítek", "Mint mesterséges intelligencia".',
        'Néha mondhatod: "Természetesen!", "Remek kérdés!", "Szívesen segítek", "Mint mesterséges intelligencia".',
        "31319-inversion",
    )
    rc, out = run_checker(claude_md, rules_dir)
    if rc != 0:
        ok("31319: the inverted ('Soha ne' -> 'Neha') line turns the checker red")
    else:
        bad("31319: the inversion did not turn the checker red", out[-500:])

    baseline_file = rules_dir / ".reachability-baseline.json"
    before = baseline_file.read_text(encoding="utf-8") if baseline_file.exists() else None
    rc_yes_only = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir), "--yes"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    after = baseline_file.read_text(encoding="utf-8") if baseline_file.exists() else None
    if rc_yes_only.returncode != 0 and after == before:
        ok("31319: --yes alone REFUSES the inversion (classified REWORD like any other)")
    else:
        bad("31319: --yes alone silently accepted the inversion", rc_yes_only.stdout + rc_yes_only.stderr)

    combined_refusal = rc_yes_only.stdout + rc_yes_only.stderr
    reword_hashes = re.findall(r"^\s+--accept (\S+)\s+#", combined_refusal, re.M)
    if not reword_hashes:
        bad("31319: the inversion refusal did not print a usable --accept hash", combined_refusal)
    else:
        accept_args = []
        for h in reword_hashes:
            accept_args += ["--accept", h]
        rc_allowed = subprocess.run(
            [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir),
             "--yes", *accept_args],
            capture_output=True, text=True, cwd=str(REPO_ROOT),
        )
        rc2, out2 = run_checker(claude_md, rules_dir)
        if rc_allowed.returncode == 0 and rc2 == 0:
            ok("31319: the EXACT printed hash via --accept lets the inversion through, checker green after")
        else:
            bad("31319: supplying the printed --accept hash did not clear the inversion", out2[-800:])
finally:
    shutil.rmtree(d)

# --- RedHat NO-GO (re-gate on 6f5045341), U2: --update-baseline must not silently bless a
# REMOVED binding line the way it blesses a REWORD -- delete the line outright (no replacement
# anywhere in the corpus), confirm --update-baseline refuses without --allow-removal, confirm
# the printed hash works when supplied. -------------------------------------------------------
d, claude_md, rules_dir = sandbox()
try:
    establish_clean_baseline(claude_md, rules_dir)
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

    # the hash(es) the refusal itself printed, from its per-line summary bullets (not the
    # generic "<hash>" placeholder in the instructional sentence above them). Also pick up any
    # --accept lines: the two pre-existing real rewords (establish_clean_baseline) are STILL
    # candidates on this run too, since --update-baseline recomputes the full set every time.
    combined_blocked = rc_blocked.stdout + rc_blocked.stderr
    removal_hashes = re.findall(r"^\s+--allow-removal (\S+)\s+#", combined_blocked, re.M)
    reword_hashes = re.findall(r"^\s+--accept (\S+)\s+#", combined_blocked, re.M)
    if not removal_hashes:
        bad("U2: the refusal did not print a usable --allow-removal hash", combined_blocked)
    else:
        extra_args = []
        for h in removal_hashes:
            extra_args += ["--allow-removal", h]
        for h in reword_hashes:
            extra_args += ["--accept", h]
        rc_allowed = subprocess.run(
            [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir),
             "--yes", *extra_args],
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
    establish_clean_baseline(claude_md, rules_dir)

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

    # The two pre-existing real rewords (establish_clean_baseline) are STILL candidates on
    # this run too -- --update-baseline recomputes the full set every time, it does not merge
    # with what is already on disk.
    reword_hashes = re.findall(r"^\s+--accept (\S+)\s+#", combined, re.M)
    extra_args = ["--allow-pin-change", "19"]
    for h in reword_hashes:
        extra_args += ["--accept", h]
    rc_allowed = subprocess.run(
        [sys.executable, str(CHECKER), "--update-baseline", OLD_REF, str(claude_md), str(rules_dir),
         "--yes", *extra_args],
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
