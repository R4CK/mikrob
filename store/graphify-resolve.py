#!/usr/bin/env python3
"""Resolve the code-graph nodes a piece of prose actually names.

Used by the dispatch-time offload path to decide whether a card has any code
context worth giving the local model, WITHOUT guessing. The rule is exact:
a candidate token becomes graph context only if it EQUALS a node label
(case-insensitively). Anything else contributes nothing.

Why exact matching lives here and not in graphify: measured 2026-08-23,
`graphify explain` is FUZZY and case-insensitive -- 'routeTas' returns
routeTask(), and a miss still exits 0 while printing "No node matching ...".
Handing free text straight to it would pull in near-miss nodes and call the
result knowledge. This resolver decides membership itself and only then asks
graphify to explain a node it has already confirmed exists.

    graphify-resolve.py <repo> [--max N] [--text "..."]     text on stdin if omitted
    graphify-resolve.py --selftest

Prints one node label per line, most specific first. Exit 0 with no output when
the text names nothing in the graph -- that is a normal answer, not an error.
Exit 3 on a harness fault (missing graph, unreadable json).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Identifier shapes that are worth looking up. Deliberately excludes bare
# lowercase words: 'main' and 'handle' ARE node labels in most graphs, and every
# English sentence would otherwise resolve to one.
CAMEL = re.compile(r"\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b")          # routeTask
PASCAL = re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b")       # GraphStore
SNAKE = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b")               # route_task
PATHY = re.compile(r"\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|sql|go|rs)\b")

MIN_LEN = 4


def candidates(text: str) -> list[str]:
    """Identifier-shaped tokens from prose, longest first, de-duplicated."""
    found: list[str] = []
    for rx in (PATHY, CAMEL, PASCAL, SNAKE):
        found.extend(rx.findall(text))
    seen: set[str] = set()
    out: list[str] = []
    for tok in sorted(found, key=len, reverse=True):
        low = tok.lower()
        if len(tok) < MIN_LEN or low in seen:
            continue
        seen.add(low)
        out.append(tok)
    return out


def load_graph(repo: Path) -> tuple[dict[str, str], dict[str, tuple[int, int]]]:
    """Return (label -> label, label -> (is_callable, degree)), CODE nodes only.

    Two filters, both chosen from a measurement over the 341 live MikroB cards
    (2026-08-23), not from taste:

    * file_type == "code" only. The graph also holds `document` nodes lifted
      from markdown headings and `concept` nodes from config. Without this
      filter the single most frequent "code context" a card resolved to was the
      CLAUDE.md heading node labelled `MikroB` -- 30 of 341 cards, i.e. every
      card whose title carries the [MikroB] tag.
    * exact case. Case-insensitive lookup let the ordinary word `CleanCore`
      match a SHOUTED constant named CLEANCORE in kanban-landed-guard.ts, on
      10 cards. Requiring the text to name the node exactly costs 12 of 220
      hits and removes that whole class -- people copy identifiers verbatim.

    Result: 208/341 cards resolve, and the most frequent hits are real source
    files (gate-dispatch-check.sh, offload-dispatch.sh, ...). The other 133
    resolve to nothing, which is the correct answer for a card that names no code.
    """
    gj = repo / "graphify-out" / "graph.json"
    if not gj.is_file():
        raise FileNotFoundError(str(gj))
    data = json.loads(gj.read_text(encoding="utf-8"))
    labels: dict[str, str] = {}
    by_id: dict[str, str] = {}
    callable_of: dict[str, int] = {}
    for n in data.get("nodes", []):
        label = str(n.get("label") or "")
        if not label or n.get("file_type") != "code":
            continue
        by_id[str(n.get("id"))] = label
        callable_of[label] = 1 if n.get("_callable") else 0
        # A callable's label carries the trailing "()"; the prose never does.
        bare = label[:-2] if label.endswith("()") else label
        labels.setdefault(bare, label)
    deg: dict[str, int] = {}
    for link in data.get("links", []):
        for end in ("source", "target"):
            lab = by_id.get(str(link.get(end)))
            if lab:
                deg[lab] = deg.get(lab, 0) + 1
    rank = {lab: (callable_of.get(lab, 0), deg.get(lab, 0)) for lab in callable_of}
    return labels, rank


def resolve(text: str, labels: dict[str, str], rank: dict[str, tuple[int, int]], limit: int) -> list[str]:
    """Best nodes first: a FUNCTION beats a file, then higher degree, then a longer token.

    Callable-first is not cosmetic. Ranking by token length alone made
    "fix routeTask in local-llm-router.ts" resolve to the FILE, because its name
    is longer -- and a file node's explanation is a list of the symbols it
    contains, while the function node's is its actual callers and callees. The
    card names both; the sharper anchor is the function.
    """
    hits: list[tuple[int, int, int, str]] = []
    for tok in candidates(text):
        label = labels.get(tok)
        if label is None and "/" in tok:
            # 'src/db.ts' names the node 'db.ts' -- the graph labels files by basename.
            label = labels.get(tok.rsplit("/", 1)[-1])
        if label is None:
            continue
        if any(label == h[3] for h in hits):
            continue
        is_call, deg = rank.get(label, (0, 0))
        hits.append((is_call, deg, len(tok), label))
    hits.sort(key=lambda h: (-h[0], -h[1], -h[2]))
    return [h[3] for h in hits[:limit]]


def selftest() -> int:
    labels = {
        "routeTask": "routeTask()",
        "db.ts": "db.ts",
        "agent-scaffold.ts": "agent-scaffold.ts",
        "GraphStore": "GraphStore",
        "main": "main()",
        "handle": "handle()",
        "route_task": "route_task()",
        "CLEANCORE": "CLEANCORE",
        "aB": "aB()",
    }
    degree = {"routeTask()": (1, 7), "db.ts": (0, 40), "GraphStore": (0, 3),
              "main()": (1, 99), "handle()": (1, 99), "route_task()": (1, 2),
              "agent-scaffold.ts": (0, 5), "CLEANCORE": (0, 1), "aB()": (1, 1)}
    fails: list[str] = []

    def check(name: str, cond: bool) -> None:
        if not cond:
            fails.append(name)

    r = lambda t, n=3: resolve(t, labels, degree, n)  # noqa: E731

    check("an exactly-named function resolves", r("please fix routeTask today") == ["routeTask()"])
    check("a bare English sentence resolves to nothing", r("please fix the handler and check it") == [])
    # The reason bare lowercase is excluded: these ARE labels, and they are also words.
    check("a common word that IS a node label is not resolved",
          r("main handle the request") == [])
    check("a file path resolves by basename", r("edit src/db.ts carefully") == ["db.ts"])
    check("a hyphenated filename resolves", r("see agent-scaffold.ts") == ["agent-scaffold.ts"])
    check("PascalCase resolves", r("the GraphStore class") == ["GraphStore"])
    check("snake_case resolves", r("call route_task now") == ["route_task()"])
    # The whole point: near misses must NOT resolve, because graphify's own
    # explain WOULD match them.
    check("a prefix of a real node does not resolve", r("routeTas is close") == [])
    check("a suffix-extended name does not resolve", r("routeTaskExtra is not it") == [])
    check("an unknown identifier resolves to nothing", r("zzzNotAThing here") == [])
    # Case is part of the match. Measured on the live board: without this,
    # the ordinary word 'CleanCore' resolved to a SHOUTED constant CLEANCORE on
    # 10 cards and called it code context.
    check("a differently-cased spelling does NOT resolve",
          r("the RouteTask helper") == [])
    check("the measured CleanCore/CLEANCORE collision does not resolve",
          r("the CleanCore landing script") == [])
    check("the exact spelling still resolves", r("the routeTask helper") == ["routeTask()"])
    # A function outranks a file even when the file's name is the longer token.
    check("a function outranks a file mentioned in the same text",
          r("routeTask and db.ts")[0] == "routeTask()")
    check("the measured length-ranking regression: file name longer than the function",
          r("fix routeTask in agent-scaffold.ts")[0] == "routeTask()")
    check("the limit is honoured", len(r("routeTask db.ts GraphStore", 2)) == 2)
    check("a duplicate mention is counted once",
          r("routeTask routeTask routeTask") == ["routeTask()"])
    # 'aB' IS in the fixture, so this can only pass because of MIN_LEN.
    # Without the length floor it resolves and the assertion fails.
    check("a too-short token is ignored even when it names a node", r("aB cD") == [])

    # load_graph's own filtering, on a real graph.json. The hand-built dict above
    # cannot exercise it, and it is the most consequential rule here: measured on
    # the live board, the most frequent "code context" without it was the CLAUDE.md
    # heading node labelled MikroB, on 30 of 341 cards.
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        (repo / "graphify-out").mkdir(parents=True)
        (repo / "graphify-out" / "graph.json").write_text(json.dumps({
            "nodes": [
                {"id": "c1", "label": "realThing()", "file_type": "code"},
                {"id": "c2", "label": "other.ts", "file_type": "code"},
                {"id": "d1", "label": "DocHeading", "file_type": "document"},
                {"id": "n1", "label": "someConcept", "file_type": "concept"},
                {"id": "r1", "label": "someRationale", "file_type": "rationale"},
                {"id": "x1", "label": "", "file_type": "code"},
            ],
            "links": [{"source": "c1", "target": "c2"}, {"source": "c2", "target": "c1"}],
        }), encoding="utf-8")
        lbl, deg = load_graph(repo)
        check("load_graph keeps code nodes", lbl.get("realThing") == "realThing()")
        check("load_graph drops document nodes", "DocHeading" not in lbl)
        check("load_graph drops concept nodes", "someConcept" not in lbl)
        check("load_graph drops rationale nodes", "someRationale" not in lbl)
        check("load_graph skips a label-less node", "" not in lbl)
        check("load_graph counts degree from links", deg.get("realThing()") == (0, 2))
        check("a document-only name resolves to nothing",
              resolve("about DocHeading here", lbl, deg, 3) == [])
        check("a code name still resolves",
              resolve("about realThing here", lbl, deg, 3) == ["realThing()"])
        try:
            load_graph(Path(td) / "nope")
            check("a missing graph raises", False)
        except FileNotFoundError:
            check("a missing graph raises", True)

    for f in fails:
        print(f"FAIL: {f}")
    print(f"graphify-resolve selftest: {27 - len(fails)}/27 passed")
    return 1 if fails else 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    limit = 1
    text = None
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--max" and i + 1 < len(argv):
            limit = max(1, int(argv[i + 1])); i += 2; continue
        if a == "--text" and i + 1 < len(argv):
            text = argv[i + 1]; i += 2; continue
        args.append(a); i += 1
    if not args:
        sys.stderr.write("usage: graphify-resolve.py <repo> [--max N] [--text ...]\n")
        return 3
    if text is None:
        text = sys.stdin.read()
    try:
        labels, degree = load_graph(Path(args[0]).resolve())
    except FileNotFoundError as exc:
        sys.stderr.write(f"graphify-resolve: no graph at {exc} (build: store/graphify.sh build {args[0]})\n")
        return 3
    except Exception as exc:
        sys.stderr.write(f"graphify-resolve: unreadable graph: {exc}\n")
        return 3
    for label in resolve(text, labels, degree, limit):
        print(label)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
