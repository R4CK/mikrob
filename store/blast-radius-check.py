#!/usr/bin/env python3
"""Blast-radius check for a shared/core file, backed by the code-review-graph.

CLAUDE.md "Kodminosegi alapelvek" rule 10 already REQUIRES this check before
editing a widely-imported file. Until this script existed the rule had no
callable entry point, so it was prose only. This is the entry point.

    store/blast-radius-check.py <file> [<file>...]
    store/blast-radius-check.py --json <file>...      machine-readable
    store/blast-radius-check.py --selftest            self-check, no repo needed
    store/blast-radius-check.py --refresh <repo>      bring the graph up to HEAD

What it answers, per file:
  - how many OTHER files import it (direct edges, plus workspace-barrel
    re-exports the graph itself cannot see -- see BARREL below)
  - how many files call a symbol defined in it
  - which recorded execution flows pass through it
  - whether the graph is fresh enough for those numbers to mean anything

BARREL: the tree-sitter parser emits NO edge for `export * from './x.js'`, so a
file behind a workspace barrel (packages/<p>/src/index.ts) looks unused in the
graph even when hundreds of files import the package. Measured 2026-08-23:
packages/core/src/text-guard.ts had 2 graph importers while 518 files import
'@cleancore/core'. This script parses the barrel files itself and adds that
count back, labelled separately -- otherwise the number would be a lie.

Exit codes:
  0  measured and reported
  2  no graph for this repo (message names the build command)
  3  harness fault (bad arguments, unreadable db) -- NOT a verdict
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

REGISTRY = Path.home() / ".code-review-graph" / "registry.json"
CRG_PYTHON = "/home/neon/.local/share/pipx/venvs/code-review-graph/bin/python"

# A file at or above this many importers is treated as shared/core.
# 25 is a deliberate compromise measured on CleanCore 2026-08-23: leaf feature
# pages sit at 2-3, real hubs at 40-500. Override with BLAST_RADIUS_THRESHOLD.
DEFAULT_THRESHOLD = 25

_BARREL_RE = re.compile(r"""^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"](\.[^'"]+)['"]""", re.M)


# --------------------------------------------------------------------------
# repo / graph resolution
# --------------------------------------------------------------------------
def _git(cwd: str, *args: str) -> str | None:
    try:
        out = subprocess.run(
            ("git", "-C", cwd, *args),
            capture_output=True, text=True, timeout=15,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip()


def main_clone_root(path: str) -> Path | None:
    """Map any path -- including an agent worktree -- to the MAIN clone root.

    Worktrees share the main clone's git common dir, so its parent is the main
    clone. Without this, every agent worktree would resolve to its own missing
    graph and the check would silently degrade to "no graph".
    """
    p = Path(path).resolve()
    start = str(p if p.is_dir() else p.parent)
    if not Path(start).exists():
        start = str(Path.cwd())
    common = _git(start, "rev-parse", "--git-common-dir")
    if not common:
        return None
    cp = Path(common)
    if not cp.is_absolute():
        cp = (Path(start) / cp).resolve()
    return cp.parent.resolve()


def repo_relative(path: str) -> str | None:
    """Path relative to ITS OWN worktree toplevel.

    An agent worktree lives NEXT TO the main clone (CleanCore-worktrees/<agent>),
    not inside it, so relative_to(main_clone) raises and a naive fallback yields
    a nonsense path that matches nothing in the graph. Measured 2026-08-23: it
    silently reported "not in the graph" for pg-client.ts edited in a worktree,
    i.e. the guard would go quiet exactly where agents actually work.
    """
    p = Path(path).resolve()
    start = str(p if p.is_dir() else p.parent)
    if not Path(start).exists():
        return None
    top = _git(start, "rev-parse", "--show-toplevel")
    if not top:
        return None
    try:
        return str(p.relative_to(Path(top).resolve()))
    except ValueError:
        return None


def graph_db_for(root: Path) -> Path:
    """Resolve the graph db path: registry data_dir first, then in-repo default."""
    try:
        reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
        for entry in reg.get("repos", []):
            if Path(entry.get("path", "")).resolve() == root and entry.get("data_dir"):
                return Path(entry["data_dir"]).resolve() / "graph.db"
    except Exception:
        pass
    return root / ".code-review-graph" / "graph.db"


# --------------------------------------------------------------------------
# barrel re-exports (the graph's blind spot)
# --------------------------------------------------------------------------
def barrel_owner(root: Path, rel: str) -> str | None:
    """Return the package specifier whose barrel re-exports `rel`, if any."""
    m = re.match(r"^(packages/([^/]+))/src/(.+)$", rel)
    if not m:
        return None
    pkg_dir, pkg_name, inner = m.group(1), m.group(2), m.group(3)
    if inner == "index.ts":
        return _pkg_specifier(root, pkg_dir, pkg_name)
    index = root / pkg_dir / "src" / "index.ts"
    try:
        text = index.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    stem = re.sub(r"\.tsx?$", "", inner)
    for target in _BARREL_RE.findall(text):
        t = re.sub(r"\.(js|ts|tsx)$", "", target.lstrip("./"))
        if t == stem:
            return _pkg_specifier(root, pkg_dir, pkg_name)
    return None


def _pkg_specifier(root: Path, pkg_dir: str, pkg_name: str) -> str:
    try:
        pj = json.loads((root / pkg_dir / "package.json").read_text(encoding="utf-8"))
        name = pj.get("name")
        if isinstance(name, str) and name:
            return name
    except Exception:
        pass
    return f"@cleancore/{pkg_name}"


# --------------------------------------------------------------------------
# measurement
# --------------------------------------------------------------------------
def measure(conn: sqlite3.Connection, root: Path, rel: str) -> dict:
    qn = str(root / rel)
    direct = [
        r[0] for r in conn.execute(
            "SELECT DISTINCT source_qualified FROM edges "
            "WHERE kind='IMPORTS_FROM' AND target_qualified=?", (qn,)
        )
    ]
    callers = [
        r[0] for r in conn.execute(
            "SELECT DISTINCT file_path FROM edges "
            "WHERE kind='CALLS' AND target_qualified LIKE ? AND file_path<>?",
            (qn + "::%", qn)
        )
    ]
    spec = barrel_owner(root, rel)
    via_barrel: list[str] = []
    if spec:
        via_barrel = [
            r[0] for r in conn.execute(
                "SELECT DISTINCT source_qualified FROM edges "
                "WHERE kind='IMPORTS_FROM' AND target_qualified=?", (spec,)
            )
        ]
    flows = [
        r[0] for r in conn.execute(
            "SELECT DISTINCT f.name FROM flows f "
            "JOIN flow_memberships m ON m.flow_id=f.id "
            "JOIN nodes n ON n.id=m.node_id WHERE n.file_path=?", (qn,)
        )
    ]
    known = conn.execute(
        "SELECT 1 FROM nodes WHERE file_path=? LIMIT 1", (qn,)
    ).fetchone() is not None

    importers = set(direct) | set(via_barrel)
    importers.discard(qn)
    return {
        "file": rel,
        "in_graph": known,
        "direct_importers": len(set(direct) - {qn}),
        "barrel_specifier": spec,
        "barrel_importers": len(set(via_barrel) - {qn}),
        "importers": len(importers),
        "caller_files": len(set(callers)),
        "flows": sorted(flows),
        "sample": sorted(_relify(root, x) for x in list(importers))[:8],
    }


def _relify(root: Path, p: str) -> str:
    try:
        return str(Path(p).relative_to(root))
    except Exception:
        return p


def graph_meta(conn: sqlite3.Connection) -> dict:
    return {r[0]: r[1] for r in conn.execute("SELECT key, value FROM metadata")}


def staleness(root: Path, meta: dict) -> dict:
    head = _git(str(root), "rev-parse", "HEAD") or ""
    recorded = meta.get("git_head_sha", "")
    if not head or not recorded:
        return {"known": False, "head": head, "graph_sha": recorded, "behind": None}
    if head == recorded:
        return {"known": True, "head": head, "graph_sha": recorded, "behind": 0}
    cnt = _git(str(root), "rev-list", "--count", f"{recorded}..{head}")
    return {
        "known": True, "head": head, "graph_sha": recorded,
        "behind": int(cnt) if (cnt or "").isdigit() else None,
    }


def refresh(root: Path, base: str) -> tuple[bool, str]:
    """Incremental graph update from `base` to HEAD. ~7s for a handful of commits."""
    exe = CRG_PYTHON if os.path.exists(CRG_PYTHON) else sys.executable
    try:
        out = subprocess.run(
            (exe, "-m", "code_review_graph", "update",
             "--repo", str(root), "--base", base, "-q"),
            capture_output=True, text=True, timeout=600,
        )
    except Exception as exc:
        return False, str(exc)
    return out.returncode == 0, (out.stderr or out.stdout).strip()[-400:]


def threshold() -> int:
    raw = os.environ.get("BLAST_RADIUS_THRESHOLD", "")
    try:
        v = int(raw)
        if v > 0:
            return v
    except Exception:
        pass
    return DEFAULT_THRESHOLD


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------
def render(result: dict, thr: int) -> str:
    lines = []
    tag = "SHARED/CORE" if result["importers"] >= thr else "local"
    lines.append(f"  {result['file']}  [{tag}]")
    if not result["in_graph"]:
        lines.append("    not in the graph (new file, or not parsed) -- no radius to report")
        return "\n".join(lines)
    detail = f"    importers: {result['importers']}"
    if result["barrel_importers"]:
        detail += (f"  ({result['direct_importers']} direct + "
                   f"{result['barrel_importers']} via {result['barrel_specifier']})")
    lines.append(detail)
    lines.append(f"    files calling a symbol defined here: {result['caller_files']}")
    if result["flows"]:
        lines.append(f"    execution flows through it: {', '.join(result['flows'][:6])}")
    if result["sample"]:
        lines.append("    e.g. " + ", ".join(result["sample"][:5]))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# selftest
# --------------------------------------------------------------------------
def selftest() -> int:
    import tempfile
    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "packages" / "core" / "src").mkdir(parents=True)
        (root / "packages" / "core" / "package.json").write_text(
            '{"name":"@acme/core"}', encoding="utf-8")
        (root / "packages" / "core" / "src" / "index.ts").write_text(
            "export * from './text-guard.js'\n"
            "export { a } from './named.js'\n", encoding="utf-8")

        check("barrel: star re-export found",
              barrel_owner(root, "packages/core/src/text-guard.ts") == "@acme/core")
        check("barrel: named re-export found",
              barrel_owner(root, "packages/core/src/named.ts") == "@acme/core")
        check("barrel: unlisted module not attributed",
              barrel_owner(root, "packages/core/src/private.ts") is None)
        check("barrel: package name read from package.json, not guessed",
              barrel_owner(root, "packages/core/src/index.ts") == "@acme/core")
        check("barrel: app file is not a barrel member",
              barrel_owner(root, "apps/api/src/server.ts") is None)

        # A .tsx re-exported as .js must still match (extension rewrite).
        (root / "packages" / "core" / "src" / "index.ts").write_text(
            "export * from './widget.js'\n", encoding="utf-8")
        check("barrel: .tsx behind a .js specifier",
              barrel_owner(root, "packages/core/src/widget.tsx") == "@acme/core")

        # measurement against a synthetic graph
        db = root / "g.db"
        conn = sqlite3.connect(db)
        conn.executescript(
            "CREATE TABLE edges(kind TEXT, source_qualified TEXT, target_qualified TEXT, file_path TEXT);"
            "CREATE TABLE nodes(id INTEGER, file_path TEXT);"
            "CREATE TABLE flows(id INTEGER, name TEXT);"
            "CREATE TABLE flow_memberships(flow_id INTEGER, node_id INTEGER);"
            "CREATE TABLE metadata(key TEXT, value TEXT);"
        )
        tgt = str(root / "packages/core/src/widget.tsx")
        conn.execute("INSERT INTO nodes VALUES (1,?)", (tgt,))
        conn.execute("INSERT INTO edges VALUES ('IMPORTS_FROM',?,?,?)",
                     (str(root / "a.ts"), tgt, str(root / "a.ts")))
        conn.execute("INSERT INTO edges VALUES ('IMPORTS_FROM',?,?,?)",
                     (str(root / "b.ts"), "@acme/core", str(root / "b.ts")))
        conn.execute("INSERT INTO edges VALUES ('IMPORTS_FROM',?,?,?)",
                     (str(root / "a.ts"), "@acme/core", str(root / "a.ts")))
        conn.commit()
        r = measure(conn, root, "packages/core/src/widget.tsx")
        check("measure: direct importer counted", r["direct_importers"] == 1)
        check("measure: barrel importers counted", r["barrel_importers"] == 2)
        check("measure: a file importing BOTH is not double counted", r["importers"] == 2)
        check("measure: in_graph true", r["in_graph"] is True)
        r2 = measure(conn, root, "packages/core/src/absent.ts")
        check("measure: unknown file reports in_graph false", r2["in_graph"] is False)

        # self-import must not inflate the count
        conn.execute("INSERT INTO edges VALUES ('IMPORTS_FROM',?,?,?)", (tgt, tgt, tgt))
        conn.commit()
        r3 = measure(conn, root, "packages/core/src/widget.tsx")
        check("measure: self-edge excluded", r3["importers"] == 2)
        conn.close()

    for f in failures:
        print(f"FAIL: {f}")
    print(f"selftest: {13 - len(failures)}/13 passed")
    return 1 if failures else 0


# --------------------------------------------------------------------------
def refresh_only(repo: str) -> int:
    """Bring one repo's graph up to its current HEAD. Called from the land scripts.

    A graph nobody refreshes is exactly the failure this whole card is about: the
    guard goes SILENT past its staleness limit, so it would rot back into prose
    without anyone noticing. Landing is the right moment -- it is when HEAD moves.
    Never fatal to the caller: a graph refresh must not be able to refuse a land.
    """
    root = main_clone_root(repo)
    if root is None:
        print(f"blast-radius: not a git repository, refresh skipped: {repo}")
        return 1
    db = graph_db_for(root)
    if not db.exists():
        print(f"blast-radius: no graph for {root}, refresh skipped")
        return 1
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    st = staleness(root, graph_meta(conn))
    conn.close()
    behind = st.get("behind")
    if behind == 0:
        print(f"blast-radius: graph already current @ {st['graph_sha'][:8]}")
        return 0
    if behind is None:
        print("blast-radius: graph freshness unknown, refresh skipped")
        return 1
    ok, msg = refresh(root, st["graph_sha"])
    if not ok:
        print(f"blast-radius: refresh failed ({behind} commit(s) behind): {msg}")
        return 1
    print(f"blast-radius: graph refreshed, was {behind} commit(s) behind")
    return 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    if "--refresh" in argv:
        rest = [a for a in argv if not a.startswith("-")]
        return refresh_only(rest[0] if rest else str(Path.cwd()))

    as_json = "--json" in argv
    no_refresh = "--no-refresh" in argv
    files = [a for a in argv if not a.startswith("-")]
    if not files:
        sys.stderr.write(__doc__ or "")
        return 3

    root = main_clone_root(files[0])
    if root is None:
        sys.stderr.write(f"blast-radius: not inside a git repository: {files[0]}\n")
        return 3

    db = graph_db_for(root)
    if not db.exists():
        sys.stderr.write(
            f"blast-radius: no graph for {root} (looked at {db}).\n"
            f"Build it once (~3 min for CleanCore):\n"
            f"  {CRG_PYTHON} -m code_review_graph build --repo {root} "
            f"--data-dir {Path.home()}/.code-review-graph/{root.name.lower()}\n"
        )
        return 2

    rels = []
    bad = []
    for f in files:
        rel = repo_relative(f)
        if rel is None:
            bad.append(f)
        else:
            rels.append(rel)
    if bad:
        sys.stderr.write("blast-radius: not inside a git worktree: " + ", ".join(bad) + "\n")
        return 3

    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    except Exception as exc:
        sys.stderr.write(f"blast-radius: cannot open graph: {exc}\n")
        return 3

    meta = graph_meta(conn)
    st = staleness(root, meta)
    if not no_refresh and st.get("behind"):
        conn.close()
        ok, msg = refresh(root, st["graph_sha"])
        if not ok:
            sys.stderr.write(f"blast-radius: incremental refresh failed, using the stale graph: {msg}\n")
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        meta = graph_meta(conn)
        st = staleness(root, meta)

    thr = threshold()
    results = [measure(conn, root, r) for r in rels]
    conn.close()

    if as_json:
        print(json.dumps({"repo": str(root), "graph": st, "threshold": thr,
                          "files": results}, indent=2))
        return 0

    print(f"blast-radius  repo={root}")
    sha = (st.get("graph_sha") or "?")[:8]
    behind = st.get("behind")
    fresh = "current" if behind == 0 else (f"{behind} commit(s) behind HEAD" if behind else "freshness unknown")
    print(f"  graph @ {sha}  ({fresh}), threshold={thr} importers")
    for r in results:
        print(render(r, thr))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
