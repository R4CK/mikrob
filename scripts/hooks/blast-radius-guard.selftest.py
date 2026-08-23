#!/usr/bin/env python3
"""Selftest for blast-radius-guard.py -- drives the hook as Claude Code does.

Every case feeds one JSON payload on stdin and asserts the exit code, because
the exit code IS the behaviour: 2 blocks, 0 passes. Asserting on internals
would not tell us whether the guard actually fires.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "blast-radius-guard.py"
ROOT = Path(__file__).resolve().parent.parent.parent
CC = Path("/mnt/h/LM_Studio_Workdir/CleanCore")

HUB = CC / "apps/api/src/pg-client.ts"       # 173 importers, measured
LEAF = CC / "apps/web/src/features/public-scan/PublicScanPage.tsx"  # 2 importers


def run(payload: dict, env_extra: dict | None = None) -> tuple[int, str]:
    env = dict(os.environ)
    env["BLAST_RADIUS_STORE"] = str(ROOT / "store")
    env.update(env_extra or {})
    out = subprocess.run(
        (sys.executable, str(HOOK)), input=json.dumps(payload),
        capture_output=True, text=True, env=env, timeout=120,
    )
    return out.returncode, out.stderr


def _fixture(root: Path, behind: int = 0, sha: str | None = None) -> Path:
    """A throwaway git repo with a hand-built graph: two files, both hubs.

    helper.ts and helper.test.ts each have 30 importers, so the ONLY thing that
    can distinguish them in the guard is the test-file rule. Without a fixture
    like this the rule is unreachable on real data and its test is vacuous.
    """
    import sqlite3
    import subprocess as sp
    (root / "src").mkdir(parents=True)
    for name in ("helper.ts", "helper.test.ts"):
        (root / "src" / name).write_text("export const x = 1\n", encoding="utf-8")
    sp.run(("git", "init", "-q", str(root)), check=True)
    sp.run(("git", "-C", str(root), "add", "-A"), check=True)
    sp.run(("git", "-C", str(root), "-c", "user.email=a@b", "-c", "user.name=t",
            "commit", "-qm", "fixture"), check=True)
    head = sp.run(("git", "-C", str(root), "rev-parse", "HEAD"),
                  capture_output=True, text=True, check=True).stdout.strip()
    # Move HEAD on by `behind` commits AFTER recording the sha the graph will
    # claim, so the fixture is stale by a known amount. Without this the
    # staleness gate could only be tested when some real repo happened to be
    # behind -- and the land scripts now refresh those, so it would almost never
    # arm. A gate that only tests itself by luck is not tested.
    for i in range(behind):
        (root / "src" / f"later{i}.ts").write_text("export const y = 1\n", encoding="utf-8")
        sp.run(("git", "-C", str(root), "add", "-A"), check=True)
        sp.run(("git", "-C", str(root), "-c", "user.email=a@b", "-c", "user.name=t",
                "commit", "-qm", f"later{i}"), check=True)

    db_dir = root / ".code-review-graph"
    db_dir.mkdir()
    conn = sqlite3.connect(db_dir / "graph.db")
    conn.executescript(
        "CREATE TABLE edges(kind TEXT, source_qualified TEXT, target_qualified TEXT, file_path TEXT);"
        "CREATE TABLE nodes(id INTEGER, file_path TEXT);"
        "CREATE TABLE flows(id INTEGER, name TEXT);"
        "CREATE TABLE flow_memberships(flow_id INTEGER, node_id INTEGER);"
        "CREATE TABLE metadata(key TEXT, value TEXT);"
    )
    conn.execute("INSERT INTO metadata VALUES ('git_head_sha',?)", (sha or head,))
    for i, name in enumerate(("helper.ts", "helper.test.ts")):
        tgt = str(root / "src" / name)
        conn.execute("INSERT INTO nodes VALUES (?,?)", (i, tgt))
        for j in range(30):
            src = str(root / "src" / f"c{i}_{j}.ts")
            conn.execute("INSERT INTO edges VALUES ('IMPORTS_FROM',?,?,?)", (src, tgt, src))
    conn.commit()
    conn.close()
    return root


def main() -> int:
    if not CC.exists():
        print("SKIP: CleanCore clone not present")
        return 0
    fails: list[str] = []

    def check(name: str, cond: bool) -> None:
        if not cond:
            fails.append(name)

    with tempfile.TemporaryDirectory() as td:
        marker = {"BLAST_RADIUS_MARKER_DIR": td}

        def edit(path, session="s1", tool="Edit", extra=None):
            e = dict(marker)
            e.update(extra or {})
            return run({"tool_name": tool, "session_id": session,
                        "tool_input": {"file_path": str(path)}}, e)

        rc, err = edit(HUB)
        check("hub file is blocked on first edit", rc == 2)
        check("the block names the file", "pg-client.ts" in err)
        check("the block shows a measured importer count", "importers: 17" in err)

        rc2, _ = edit(HUB)
        check("second edit of the same file passes", rc2 == 0)

        rc3, _ = edit(HUB, session="s2")
        check("a different session is blocked again", rc3 == 2)

        rc4, _ = edit(LEAF)
        check("a leaf file is never blocked", rc4 == 0)

        # Test-file exclusion. NOT testable against CleanCore: measured
        # 2026-08-23, no .test.ts file there has a single importer, so every
        # such payload exits on the threshold and the exclusion is never
        # reached -- an assertion using a real test file passes even with the
        # exclusion deleted (mutation-confirmed). Hence a hermetic fixture
        # where the test file genuinely IS a hub.
        fx = _fixture(Path(td) / "fx")
        rc5, _ = edit(fx / "src/helper.test.ts", session="s3")
        check("a hub TEST file is not blocked", rc5 == 0)
        rc5b, err5b = edit(fx / "src/helper.ts", session="s3b")
        check("its non-test sibling in the same fixture IS blocked", rc5b == 2)
        check("so the silence above came from the test-file rule",
              "importers: 30" in err5b)

        rc6, _ = edit(HUB, session="s4", tool="Read")
        check("a non-editing tool is ignored", rc6 == 0)

        rc7, _ = edit(HUB, session="s5", extra={"BLAST_RADIUS_GUARD": "off"})
        check("kill switch disables the guard", rc7 == 0)

        rc8, _ = edit(HUB, session="s6", extra={"BLAST_RADIUS_THRESHOLD": "100000"})
        check("threshold above every file disables blocking", rc8 == 0)

        # Staleness gate, on a fixture that is stale by construction (5 commits).
        # Only the max-behind threshold differs between the two runs, so the
        # difference in outcome can only come from the staleness check.
        sfx = _fixture(Path(td) / "stale", behind=5)
        rc9a, _ = edit(sfx / "src/helper.ts", session="s7a",
                       extra={"BLAST_RADIUS_MAX_BEHIND": "4"})
        check("a graph staler than the limit does not block", rc9a == 0)
        rc9b, err9b = edit(sfx / "src/helper.ts", session="s7b",
                           extra={"BLAST_RADIUS_MAX_BEHIND": "5"})
        check("the same file DOES block once the graph counts as fresh enough",
              rc9b == 2)
        check("so the silence above came from staleness, not from a low count",
              "importers: 30" in err9b)

        # Freshness UNKNOWN, the other arm of the same gate: the graph records a
        # sha this repo has never heard of (a pruned or rebased-away commit), so
        # "how far behind" has no answer. Must fail open, not block on a number
        # it cannot compute.
        ufx = _fixture(Path(td) / "unknown", sha="0" * 40)
        rc9c, _ = edit(ufx / "src/helper.ts", session="s7c")
        check("an ungaugeable graph does not block", rc9c == 0)

        # A recorded sha that cannot BE a sha (Cybersec F-3a). It reaches a git rev-list token, so
        # a value of the wrong shape is refused before it gets there rather than fail-opening by
        # accident further down.
        bfx = _fixture(Path(td) / "badsha", sha="--not-a-sha")
        rc9d, _ = edit(bfx / "src/helper.ts", session="s7d")
        check("a malformed recorded sha does not block", rc9d == 0)

        # Marker store unusable (Cybersec F-2, reproduced live by them): the guard must fail open
        # AND SAY SO. Silent, permanent, arrangeable de-enforcement is the actual problem; being
        # fail-open is the documented design.
        broken = Path(td) / "markers-is-a-file"
        broken.write_text("not a directory", encoding="utf-8")
        rc9e, err9e = edit(HUB, session="s7e", extra={"BLAST_RADIUS_MARKER_DIR": str(broken)})
        check("an unusable marker store does not block", rc9e == 0)
        check("...and the guard says why instead of going quiet",
              "nem tudom megjegyezni" in err9e)

        # The DEFAULT marker root, which every other case here hides behind an override. The fix
        # for F-2 lives in that default, so without this the whole suite stays green after a revert
        # to the shared world-writable path (mutation-confirmed).
        import re as _re
        # CODE only. The comment above that default explains the old shared path BY NAME, so a
        # substring check over the whole file fails on the explanation rather than on the code --
        # the same trap this repo hit today in graph-tooling-selftests.test.ts.
        src = "\n".join(l for l in HOOK.read_text(encoding="utf-8").splitlines()
                         if not l.lstrip().startswith("#"))
        check("the default marker root is not a fixed shared /tmp path",
              "/tmp/blast-radius-guard" not in src)
        check("the default marker root is per-user under the platform temp dir",
              bool(_re.search(r"tempfile\.gettempdir\(\)[^\n]*getuid\(\)", src)))

        rc10, _ = edit(CC / "apps/api/src/does-not-exist.ts", session="s8")
        check("a file that does not exist yet is not blocked", rc10 == 0)

        rc11, _ = edit(Path("/home/neon/marveen/store/fleet-test.sh"), session="s9")
        check("a non-source extension is ignored", rc11 == 0)

        rc12, _ = run({"tool_name": "Edit", "tool_input": "not-a-dict"}, marker)
        check("a malformed payload fails open", rc12 == 0)

        rc13, _ = run({"tool_name": "Edit", "session_id": "s10",
                       "tool_input": {"file_path": str(HUB)}},
                      {**marker, "BLAST_RADIUS_STORE": "/nonexistent"})
        check("a missing measurement library fails open", rc13 == 0)

        # The worktree path is where agents actually edit: it must block there too.
        wt = Path("/mnt/h/LM_Studio_Workdir/CleanCore-worktrees/backend2/apps/api/src/pg-client.ts")
        if wt.exists():
            rc14, err14 = edit(wt, session="s11")
            check("an agent worktree path is blocked as well", rc14 == 2)
            check("the worktree report carries the real count", "importers: 17" in err14)

    for f in fails:
        print(f"FAIL: {f}")
    total = 25 + (2 if Path("/mnt/h/LM_Studio_Workdir/CleanCore-worktrees/backend2/apps/api/src/pg-client.ts").exists() else 0)
    print(f"blast-radius-guard selftest: {total - len(fails)}/{total} passed"
)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
