#!/usr/bin/env python3
"""Card 08eb6402: does a full-suite run's recorded evidence still describe what a mopsion
landing is about to push?

WHY THIS EXISTS (measured, card 6eed8678/08eb6402). 777f69b1 (2026-09-12, card ac24bf98) landed
55/56 on apps/api/src/superadmin-router.test.ts while origin/main immediately before it was
56/56 -- a textbook green-baseline/red-branch case mopsion-land.sh never caught, because in
source it runs zero vitest/suite-run calls (only typecheck + format + bundle + seam). The QA PASS
on that sha re-verified a DIFFERENT, previously-flagged (tsc-cast) finding, not a fresh full
suite. Running the ~70-minute full suite INLINE at every landing was explicitly rejected
(MikroB, card 08eb6402 comment 5934): it would serialise landings against the 2-slot semaphore
(rule 17). So the fix is evidence-based, not execution-based: a gate that already ran the full
suite on the sha it reviewed records `Suite-SHA: <sha> <result>` in its verdict comment (the
`Gate-SHA:` convention's sibling, rule 4b), and mopsion-land.sh asks THIS FILE whether that
evidence still describes the tree it is about to push -- a git diff, not a suite run.

WHY THE EVIDENCED SHA CAN DIFFER FROM THE MERGE SHA AND STILL BE VALID (MikroB kikötés 1/3). A
gate cannot suite-test a merge that does not exist yet, so it necessarily records evidence
against the PRE-MERGE branch tip it reviewed. This file's job is exactly the gap that leaves
open: is the actual merge RESULT still content-equivalent to what the evidence covers? If the
merge was clean (no concurrent origin-side change, no conflict-resolution edit touching anything
the suite actually exercises), the answer is yes and the evidence is still good. If not -- new
content the suite never saw -- REFUSE, fail-closed, the same direction gate-closure-check.py
already takes for a stale Gate-SHA.

REUSES gate-closure-check.py's OWN content-equivalence machinery (`_content_on_branch`, the
per-landing-churn tolerance in `_SHARED_CHURN`, the cross-repo clone resolver in
`_clone_and_ref_holding`) rather than a second, independently-drifting heuristic -- the same
byte-identical-or-every-added-line-present test already proven across 557 Gate-SHA closures. A
side effect worth stating: because the comparison is a full content diff (not scoped away from
tests or scripts), a branch that touches the suite runner itself, a vitest config, or weakens a
test between the evidenced sha and the merge result shows up as a real (non-churn) difference and
is correctly refused -- covering MikroB kikötés 2 (protection against suite-script manipulation)
without marveen-land.sh's costlier dual-copy re-execution.

OUTPUT (one line, stdout):
    PRESENT|<evidenced_sha>|<result text>   evidence covers the merge result; safe to land
    MISSING                                 no Suite-SHA line in any comment
    STALE|<evidenced_sha>|<detail>          evidence exists but the merge result has since
                                             diverged beyond the known-harmless class -- REFUSE
    UNRESOLVED|<evidenced_sha>|<why>        could not be checked (unknown clone, bad sha, git
                                             failure) -- REFUSE; "could not check" is not "checked
                                             and fine" (same stance gate-closure-check.py takes)

USAGE: comments JSON (a bare list, or {"comments": [...]}) on stdin, the merge sha as argv[1].
    printf 'Authorization: Bearer %s\\n' "$(cat store/.dashboard-token)" | curl -H @- -s \\
      "http://localhost:3420/api/kanban/<id>/comments" \\
      | python3 store/suite-sha-check.py <merge_sha>
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load_gate_closure_check():
    spec = importlib.util.spec_from_file_location(
        "gate_closure_check", _HERE / "gate-closure-check.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


gcc = _load_gate_closure_check()

# Mirrors _GATE_SHA_LINE exactly (rule 4b's sibling convention), one keyword swapped.
_SUITE_SHA_LINE = re.compile(r"^\s*Suite-SHA\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)


def suite_sha_of(content):
    """(sha, result_text) for the FIRST hex token on a comment's Suite-SHA line(s), or None.

    Reuses the SAME path/parent-marker filtering `_line_shas` applies to Gate-SHA, so a branch
    name or a `sha^` ancestor reference on the line cannot be mistaken for the cited commit.
    """
    if not isinstance(content, str):
        return None
    for line in _SUITE_SHA_LINE.findall(content):
        blanked = gcc._PARENT_MARKED_SHA.sub(lambda m: " " * len(m.group(0)), line)
        toks = blanked.split()
        for i, tok in enumerate(toks):
            if gcc._is_path_token(tok):
                continue
            m = gcc._SHA_TOKEN.search(tok)
            if m:
                sha = m.group(0).lower()
                rest = " ".join(toks[i + 1 :]).strip()
                return sha, (rest or line.strip())
    return None


def latest_suite_sha(comments):
    """The (sha, result) from the chronologically LATEST comment carrying a Suite-SHA line, from
    ANY gate -- this proves the CODE was fully suite-tested, not which gate's turn it was. Falls
    back to list order when `created_at` is absent, matching how the board already orders
    comments when it returns them.
    """
    best = None
    best_ts = None
    best_idx = -1
    for idx, c in enumerate(comments):
        if not isinstance(c, dict):
            continue
        found = suite_sha_of(c.get("content"))
        if not found:
            continue
        ts = c.get("created_at")
        if best is None or idx >= best_idx:
            if ts is None or best_ts is None or ts >= best_ts:
                best, best_ts, best_idx = found, ts, idx
    return best


def check(comments, merge_sha):
    found = latest_suite_sha(comments)
    if not found:
        return "MISSING"
    sha, result = found
    holder = gcc._clone_and_ref_holding(sha)
    if not holder:
        return "UNRESOLVED|%s|not found in any known clone" % sha
    clone, _ref = holder
    if not gcc._git(clone, "cat-file", "-e", merge_sha + "^{commit}")[0]:
        return "UNRESOLVED|%s|merge sha %s does not resolve in %s" % (sha, merge_sha, clone)
    kind, detail = gcc._content_on_branch(clone, merge_sha, sha)
    if kind == "same":
        return "PRESENT|%s|%s" % (sha, result)
    if kind == "differs":
        return "STALE|%s|%s" % (sha, detail)
    return "UNRESOLVED|%s|%s" % (sha, detail)


def _load_comments(raw):
    data = json.loads(raw)
    if isinstance(data, dict):
        data = data.get("comments", [])
    if not isinstance(data, list):
        raise ValueError("expected a list of comments (or {\"comments\": [...]})")
    return data


def main():
    if len(sys.argv) != 2:
        print("usage: suite-sha-check.py <merge_sha>  (comments JSON on stdin)", file=sys.stderr)
        return 2
    merge_sha = sys.argv[1].strip()
    if not re.match(r"^[0-9a-fA-F]{7,40}$", merge_sha):
        print("UNRESOLVED|-|merge sha argument %r is not a hex commit id" % merge_sha)
        return 0
    try:
        comments = _load_comments(sys.stdin.read())
    except (ValueError, json.JSONDecodeError) as exc:
        print("UNRESOLVED|-|could not read comments JSON from stdin: %s" % exc)
        return 0
    print(check(comments, merge_sha))
    return 0


if __name__ == "__main__":
    sys.exit(main())
