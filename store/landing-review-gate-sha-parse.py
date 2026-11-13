#!/usr/bin/env python3
"""Read a card's comments (JSON on stdin) and print the Gate-SHA(s) from its LATEST REVIEW.

Card 507e8167: marveen-land.sh's --card mode trusted a local `card/<id>` ref's content to decide
"already fully landed" (branch tip is an ancestor of origin/develop) without ever checking that the
ref actually points at the commit the card's own REVIEW claims to be landing. A stale/leftover
`card/<id>` ref pointing at an old, unrelated, already-landed commit satisfied that ancestor check
and the landing silently no-opped -- reported "already landed" on a card whose real gated commit
was never pushed.

CYBERSEC NO-GO 29485, round 2: the first version of this file rolled its own "find the latest
REVIEW" parser (first line starts with `REVIEW`), which misses the live convention entirely --
rule 4b/4c put `Gate-SHA:` on the REVIEW comment's first line, not the word REVIEW, so on live
cards (0120d19a, 4f3c0287, 8b9c2d40) the parser returned NONE, and on others (07f1fe6e, acffb1d6)
it matched a stale comment whose first line happened to start with REVIEW and missed the real,
Gate-SHA-first one. "Do not write a third parser" (MikroB's instruction): gate-closure-check.py's
own `declared_shas()` already solves exactly this -- it is the function `--expect`'s default reads
from, already handles both comment orders via `_LEAD_SKIP`, already skips generated-author drafts,
already honours a `VISSZAVONVA:`/`RETRACTED:` marker -- so this file imports and calls it instead
of re-deriving any of that.

Usage:  landing-review-gate-sha-parse.py < comments.json
Prints exactly one line: OK|<sha>[,<sha>...]   or   NONE|<reason>
"""
import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_GCC_PATH = os.path.join(_HERE, "gate-closure-check.py")


def _load_gate_closure_check():
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)  # gate-closure-check.py's own `import gate_author_role` needs this
    spec = importlib.util.spec_from_file_location("gate_closure_check", _GCC_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    try:
        doc = json.load(sys.stdin)
    except Exception as exc:
        print(f"NONE|unreadable: {exc}")
        return 0
    comments = doc.get("comments", doc) if isinstance(doc, dict) else doc
    if not isinstance(comments, list):
        print("NONE|unexpected response shape")
        return 0

    try:
        gcc = _load_gate_closure_check()
        shas = gcc.declared_shas(comments)
    except Exception as exc:
        print(f"NONE|gate-closure-check.py import/call failed: {exc}")
        return 0

    if shas:
        print("OK|" + ",".join(shas))
    else:
        print("NONE|no REVIEW comment with a Gate-SHA line found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
