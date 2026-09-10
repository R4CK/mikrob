#!/usr/bin/env python3
"""
nmr-git-evidence.selftest.py -- does the two-repo evidence check hold its two dangerous edges?
(card 4916687a)

The edges are not symmetric, and the cases are ordered by what each error costs:

  A MISSED citation reproduces the exact defect this card is about: a finished, landed card filed
  as "nothing behind it", which is how three already-done cards reached an agent's dispatch queue
  on 2026-09-10. Case 1 and case 2 are that.

  An INVENTED citation is worse in the other direction: it says work exists for a card where none
  does, which can get a genuinely unstarted card waved through. A kanban id is 8 hex characters and
  so is an abbreviated sha, so this is not hypothetical -- it is a hazard this fleet has already
  been bitten by ("kanban ids are read as commit shas"). Cases 3 and 4.

  And case 5 is the structural one: with the CleanCore history unreadable, the tool must REFUSE
  rather than report zeros, because a confident "no evidence" computed from a repo it never opened
  is precisely the original bug.

Every case builds throwaway git repos; nothing here reads the live checkouts.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE / "nmr-git-evidence.py"

PASS = 0
FAIL = 0


def ok(name):
    global PASS
    PASS += 1
    print(f"  ok   {name}")


def bad(name, detail=""):
    global FAIL
    FAIL += 1
    print(f"  FAIL {name}\n     {detail}")


def make_repo(path: Path, commits: list[str]) -> list[str]:
    """Create a repo with one commit per message. Returns the shas, newest last."""
    path.mkdir(parents=True, exist_ok=True)
    env = {**os.environ,
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    subprocess.run(["git", "init", "-q", str(path)], check=True, env=env)
    shas = []
    for i, msg in enumerate(commits):
        (path / f"f{i}.txt").write_text(str(i), encoding="utf-8")
        subprocess.run(["git", "-C", str(path), "add", "-A"], check=True, env=env)
        subprocess.run(["git", "-C", str(path), "commit", "-q", "-m", msg], check=True, env=env)
        shas.append(subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"],
                                   capture_output=True, text=True, check=True, env=env).stdout.strip())
    return shas


def run_tool(mv: Path, cc: Path, ids: list[str], jsonl: Path):
    env = {**os.environ,
           "NMR_MARVEEN_REPO": str(mv),
           "CLEANCORE_MAIN": str(cc),
           "NMR_STRICT_RECHECK": "/nonexistent-strict-recheck.jsonl"}
    proc = subprocess.run(
        [sys.executable, str(TOOL), "--ids", ",".join(ids), "--jsonl", str(jsonl)],
        capture_output=True, text=True, env=env, timeout=300)
    rows = {}
    if jsonl.exists():
        for line in jsonl.read_text(encoding="utf-8").splitlines():
            if line.strip():
                o = json.loads(line)
                rows[o["id"]] = o
    return proc, rows


def main() -> int:
    print("nmr-git-evidence selftest")
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        mv = td / "marveen"
        cc = td / "cleancore"
        out = td / "out.jsonl"

        # marveen cites one card; CleanCore cites another. The original bug was seeing only the first.
        make_repo(mv, ["fix(x): something unrelated", "fix(y): tidy up (card aaaaaaaa)"])
        make_repo(cc, ["feat(z): external anchor for the chain (card bbbbbbbb)",
                       "chore: no card named here at all"])

        # 1. A citation that lives ONLY in CleanCore must be found. This is the whole card.
        proc, rows = run_tool(mv, cc, ["bbbbbbbb"], out)
        r = rows.get("bbbbbbbb", {})
        if r.get("verdict") == "cited_strict" and r.get("repos") == ["cleancore"]:
            ok("a CleanCore-only citation is found (the original defect)")
        else:
            bad("a CleanCore-only citation is found", f"{r}\n{proc.stdout[-300:]}")

        # 2. ...and the marveen side keeps working, so this is a widening, not a swap.
        proc, rows = run_tool(mv, cc, ["aaaaaaaa"], out)
        r = rows.get("aaaaaaaa", {})
        if r.get("verdict") == "cited_strict" and r.get("repos") == ["marveen"]:
            ok("a marveen-only citation still works (no regression)")
        else:
            bad("a marveen-only citation still works", str(r))

        # 3. A card id nobody names is uncited -- the tool must not manufacture evidence.
        proc, rows = run_tool(mv, cc, ["cccccccc"], out)
        if rows.get("cccccccc", {}).get("verdict") == "uncited":
            ok("an id no commit names is reported uncited")
        else:
            bad("an id no commit names is reported uncited", str(rows.get("cccccccc")))

        # 4. THE ABBREVIATED-SHA TRAP, which is the one that actually bites. A FULL 40-char sha in
        #    the text is harmless: `\b<8 hex>\b` cannot match inside it, because the sha continues
        #    past the eighth character and there is no word boundary there. The dangerous shape is
        #    the one people really write -- an ABBREVIATED sha standing alone as a word
        #    ("revert to a1b2c3d4") -- which has boundaries on both sides and is indistinguishable
        #    from a card id by shape alone. Only the sha-prefix set separates them.
        #
        #    (An earlier version of this case quoted the full sha and passed with the exclusion
        #    mutated away -- vacuous. Mutation testing caught it; the case now fails without the
        #    exclusion, which is the property it is supposed to prove.)
        mv2 = td / "marveen2"
        mv2_shas = make_repo(mv2, ["chore: the commit that will be referred to later"])
        prefix = mv2_shas[-1][:8]
        subprocess.run(["git", "-C", str(mv2), "commit", "-q", "--allow-empty",
                        "-m", f"chore: revert to {prefix} after the bad landing"],
                       check=True, env={**os.environ,
                                        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})
        proc, rows = run_tool(mv2, cc, [prefix], out)
        v = rows.get(prefix, {}).get("verdict")
        if v == "uncited":
            ok("an abbreviated sha standing alone is NOT read as a card citation")
        else:
            bad("an abbreviated sha is not read as a card citation",
                f"verdict={v} rows={rows.get(prefix)}")

        # 5. A bare word-boundary id that is NOT a sha stays in its own weaker bucket -- reported,
        #    never silently merged into the confident one.
        mv3 = td / "marveen3"
        make_repo(mv3, ["chore: mentions dddddddd in passing without the word card"])
        proc, rows = run_tool(mv3, cc, ["dddddddd"], out)
        if rows.get("dddddddd", {}).get("verdict") == "cited_loose":
            ok("a bare id mention is classified loose, not strict")
        else:
            bad("a bare id mention is classified loose", str(rows.get("dddddddd")))

        # 6. STRUCTURAL: with CleanCore unreadable the tool must REFUSE (exit 3), not report zeros.
        #    Reporting "no evidence" from a repo you never opened IS the bug being fixed.
        env = {**os.environ, "NMR_MARVEEN_REPO": str(mv),
               "CLEANCORE_MAIN": str(td / "does-not-exist"),
               "NMR_STRICT_RECHECK": "/nonexistent.jsonl"}
        proc = subprocess.run([sys.executable, str(TOOL), "--ids", "bbbbbbbb"],
                              capture_output=True, text=True, env=env, timeout=300)
        if proc.returncode == 3 and "REFUSING" in (proc.stderr + proc.stdout):
            ok("an unreadable CleanCore repo REFUSES rather than reporting zeros")
        else:
            bad("an unreadable CleanCore repo refuses",
                f"exit={proc.returncode} err={proc.stderr[-200:]}")

    print(f"\nselftest: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
