#!/usr/bin/env python3
"""PreToolUse hook: make the blast-radius rule real before editing a hub file.

CLAUDE.md "Kodminosegi alapelvek" rule 10 says: before touching a file that many
other modules import, run the code-review-graph impact analysis so the caller set
is VISIBLE before the edit, not after the tests go red. Until now that was prose
with no enforcement -- and the tool it names was measurably unused (the marveen
graph sat 975 commits stale from adoption day; CleanCore had no graph at all).

This guard turns the rule into one enforced beat:

  first Edit/Write of a given hub file in a session -> BLOCKED once, with the
  measured radius printed. The retry goes through.

So the radius is guaranteed to have been seen, without standing between an agent
and its work. Not a permanent block: a second attempt on the same file passes.

Deliberately fail-open. Any missing graph, unparsed file, unreadable payload,
import error or timeout -> exit 0. A guard bug must never stop the fleet.
Kill switch: BLAST_RADIUS_GUARD=off. Threshold: BLAST_RADIUS_THRESHOLD (default 25).

Not enforced for: test files, non-source extensions, files the graph does not
know (new files have no callers yet), and graphs too stale to be trusted
(BLAST_RADIUS_MAX_BEHIND commits, default 200) -- a stale graph must produce
silence, never a confident wrong number.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

# Resolved from THIS file so the hook and the measurement always come from the
# same tree (shared clone in production, an agent worktree under selftest).
STORE = Path(os.environ.get("BLAST_RADIUS_STORE")
             or (Path(__file__).resolve().parent.parent.parent / "store"))
MARKER_ROOT = Path(os.environ.get("BLAST_RADIUS_MARKER_DIR", "/tmp/blast-radius-guard"))
SOURCE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"}
DEFAULT_MAX_BEHIND = 200


def _lib():
    sys.path.insert(0, str(STORE))
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "blast_radius_check", STORE / "blast-radius-check.py")
    if spec is None or spec.loader is None:
        raise ImportError("blast-radius-check.py not loadable")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _target(payload: dict) -> str | None:
    ti = payload.get("tool_input")
    if not isinstance(ti, dict):
        return None
    fp = ti.get("file_path") or ti.get("path") or ti.get("notebook_path")
    return fp if isinstance(fp, str) and fp else None


def _is_source(path: str) -> bool:
    p = Path(path)
    if p.suffix not in SOURCE_EXT:
        return False
    name = p.name
    return ".test." not in name and ".spec." not in name


def _max_behind() -> int:
    try:
        v = int(os.environ.get("BLAST_RADIUS_MAX_BEHIND", ""))
        return v if v >= 0 else DEFAULT_MAX_BEHIND
    except Exception:
        return DEFAULT_MAX_BEHIND


def _already_shown(session: str, root: Path, rel: str) -> bool:
    """One block per (session, file). Returns True if the radius was already shown."""
    key = hashlib.sha256(f"{root}\0{rel}".encode()).hexdigest()[:32]
    d = MARKER_ROOT / (session or "nosession")
    marker = d / key
    if marker.exists():
        return True
    try:
        d.mkdir(parents=True, exist_ok=True)
        marker.write_text("", encoding="utf-8")
    except Exception:
        # Cannot remember -> do not block, or we would block every single edit.
        return True
    return False


def main() -> None:
    if (os.environ.get("BLAST_RADIUS_GUARD") or "").lower() in ("off", "0", "false"):
        sys.exit(0)
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") not in ("Edit", "Write", "MultiEdit"):
        sys.exit(0)

    path = _target(payload)
    if not path or not _is_source(path):
        sys.exit(0)
    if not Path(path).exists():
        sys.exit(0)  # brand new file: nothing imports it yet

    try:
        lib = _lib()
        root = lib.main_clone_root(path)
        if root is None:
            sys.exit(0)
        rel = lib.repo_relative(path)
        if rel is None:
            sys.exit(0)
        db = lib.graph_db_for(root)
        if not db.exists():
            sys.exit(0)

        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        meta = lib.graph_meta(conn)
        st = lib.staleness(root, meta)
        behind = st.get("behind")
        if behind is None or behind > _max_behind():
            conn.close()
            sys.exit(0)
        res = lib.measure(conn, root, rel)
        conn.close()

        thr = lib.threshold()
        if not res["in_graph"] or res["importers"] < thr:
            sys.exit(0)
        if _already_shown(str(payload.get("session_id") or ""), root, rel):
            sys.exit(0)
        report = lib.render(res, thr)
    except Exception:
        sys.exit(0)

    sys.stderr.write(
        "BLAST-RADIUS-GUARD: ez egy megosztott/core fajl. A CLAUDE.md Kodminosegi "
        "alapelvek 10. pontja szerint a hivok koret a szerkesztes ELOTT kell latni.\n"
        f"{report}\n"
        "Ez az egyszeri blokk maga a kikenyszerites: a radiusz most lathato, a "
        "kovetkezo probalkozas ugyanezen a fajlon atmegy. Mielott ujraprobalod, "
        "gondold vegig, melyik hivo torhet el -- es ha melyebb kepet akarsz:\n"
        f"  python3 {STORE}/blast-radius-check.py {path}\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
