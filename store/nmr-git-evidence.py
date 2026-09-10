#!/usr/bin/env python3
"""
nmr-git-evidence.py -- re-derive the git-evidence half of the needs_manual_review triage, over BOTH
repos this fleet works in (card 4916687a).

WHAT WENT WRONG. strict-recheck-20260909 decided `own_id_in_git` from a single `git log --all` --
the one in the repo the script happened to run in (marveen). CleanCore was never opened. Every
CleanCore card therefore scored "no git evidence" no matter how finished and landed its work was,
and 991 cards were filed needs_manual_review on that basis. Measured before this script existed:
of 772 cards recorded own_id_in_git=False, 523 are cited by a commit; 520 of those 523 are
CleanCore-only. The marveen side was near-perfect (3 misses) -- one missing repo, not a bad matcher.

WHY IT MATTERS: three cards taken in normal dispatch order on 2026-09-10 (f923328d, 41aef3f0,
fdb6e49d) were all already-done, landed, tested work, each costing a multi-minute investigation to
establish. fdb6e49d is the clean case: its commit literally says "card fdb6e49d".

TWO FAILURE MODES THIS FILE IS BUILT AGAINST, both already paid for by this fleet:

 1. LOOSE SUBSTRING MATCHING. The sibling triage batches (036a0913 / 7da45e54 / 73ba1567) matched
    verdict text by substring with no ordering and read a 100-char truncated title instead of the
    description; QA measured a 53% error rate on the closed cards. So citations here are matched by
    an EXPLICIT pattern ("card <id>", "kartya <id>", "(<id>"), not by "the id appears somewhere".

 2. A CARD ID READ AS A COMMIT SHA. A kanban id is 8 hex characters and so is an abbreviated sha,
    so a bare-hex search reports a card as "cited" when the text merely contains a sha that starts
    with those digits -- including the commit's OWN sha. Both are excluded explicitly below.

REPORTS, DOES NOT DECIDE. Output is additive categories, never a filter: `cited_strict` (explicit
citation), `cited_loose` (word-boundary id that is NOT a sha prefix -- weaker, needs a human), and
`uncited`. That split is the point. The fleet's own rule after a related false-positive fight is
that a report should CLASSIFY rather than SUPPRESS, because a filter tuned to kill false positives
kills real findings with them. "Cited" also never means "done" -- it means work exists that names
this card, which is precisely the question strict-recheck got wrong.

Writes nothing to the kanban DB, same as nmr-rederive.py.

  nmr-git-evidence.py                 # human summary + per-batch diff against strict-recheck
  nmr-git-evidence.py --jsonl <path>  # also write one JSON object per card
  nmr-git-evidence.py --ids a1b2c3d4,...   # check specific ids instead of the batch files
"""
import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

import os

# Overridable so the selftest can point at throwaway repos. Defaults are the live checkouts; the
# CleanCore default matches CLEANCORE_MAIN's documented value, and honouring the env var means an
# install that moved the clone is not silently reported as "no evidence" -- the failure this file
# exists to end.
MARVEEN = Path(os.environ.get("NMR_MARVEEN_REPO", "/home/neon/marveen"))
CLEANCORE = Path(os.environ.get("CLEANCORE_MAIN", "/mnt/h/LM_Studio_Workdir/CleanCore"))
BATCH_DIR = Path(os.environ.get("NMR_BATCH_DIR", str(MARVEEN / "store" / "review-batches")))
BATCHES = [
    ("036a0913", "nmr-backend2.jsonl"),
    ("7da45e54", "nmr-backend3.jsonl"),
    ("73ba1567", "nmr-fullstack.jsonl"),
]
STRICT_RECHECK = Path(os.environ.get("NMR_STRICT_RECHECK", str(MARVEEN / "store" / "strict-recheck-20260909.jsonl")))

CARD_ID_RE = re.compile(r"^[0-9a-f]{8}$")

# An explicit citation: the ways commits in this fleet actually name a card. Anchored on a keyword
# or an opening bracket/comma so that a bare hex token cannot satisfy it.
STRICT_CITE = r"(?:(?:cards?|k[aá]rty[aá]k?|kartya)\s+{id}\b)|(?:[(\[,]\s*{id}\b)"
# Weaker: the id stands alone as a word. Kept as its OWN category, never merged into the strict one.
LOOSE_CITE = r"\b{id}\b"


def git_dump(repo: Path) -> list[tuple[str, str]]:
    """(sha, message) for every commit on every ref. Empty list if the repo is unreadable, which is
    reported rather than silently treated as 'no evidence' -- the exact conflation this card is about."""
    if not (repo / ".git").exists() and not repo.joinpath(".git").is_file():
        print(f"WARNING: {repo} does not look like a git repo -- skipping", file=sys.stderr)
        return []
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "log", "--all", "--format=%H%x1f%s%n%b%x1e"],
            capture_output=True, text=True, timeout=900, check=True,
        ).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print(f"WARNING: git log failed in {repo}: {exc}", file=sys.stderr)
        return []
    commits = []
    for rec in out.split("\x1e"):
        rec = rec.strip()
        if not rec:
            continue
        sha, _, msg = rec.partition("\x1f")
        commits.append((sha.strip(), msg))
    return commits


def build_sha_prefix_set(commits: list[tuple[str, str]]) -> set[str]:
    """Every commit's own 8-char sha prefix. A card id equal to one of these is assumed to be a sha
    mention, not a card citation -- the conservative direction: it can hide a real citation, but it
    cannot invent one, and an invented citation is what would send a finished card back to be
    rebuilt (or a missing one to be closed)."""
    return {sha[:8].lower() for sha, _ in commits if sha}


def scan(commits, sha_prefixes, card_id):
    """Return (strict_hits, loose_hits) as lists of (sha, subject-ish)."""
    strict_re = re.compile(STRICT_CITE.format(id=card_id), re.IGNORECASE)
    loose_re = re.compile(LOOSE_CITE.format(id=card_id), re.IGNORECASE)
    strict_hits, loose_hits = [], []
    for sha, msg in commits:
        if card_id not in msg.lower():
            continue
        subject = msg.splitlines()[0] if msg.splitlines() else ""
        if strict_re.search(msg):
            strict_hits.append((sha, subject))
        elif loose_re.search(msg):
            # The id appears as a word but not as a citation. If it is also some commit's sha
            # prefix, the far likelier reading is "a sha was mentioned".
            if card_id in sha_prefixes:
                continue
            loose_hits.append((sha, subject))
    return strict_hits, loose_hits


def load_batches(ids_arg):
    if ids_arg:
        return [("--ids", [i.strip().lower() for i in ids_arg.split(",") if i.strip()])]
    batches = []
    for card, fname in BATCHES:
        path = BATCH_DIR / fname
        if not path.exists():
            print(f"WARNING: missing batch file {path}", file=sys.stderr)
            continue
        ids = []
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            cid = (obj.get("id") or obj.get("card_id") or "").lower()
            if CARD_ID_RE.match(cid):
                ids.append(cid)
        batches.append((f"{card} ({fname})", ids))
    return batches


def load_strict_recheck():
    """card_id -> own_id_in_git, so the report can state the DIFF rather than just a new number."""
    prior = {}
    if not STRICT_RECHECK.exists():
        return prior
    for line in STRICT_RECHECK.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        cid = (obj.get("id") or obj.get("card_id") or "").lower()
        if cid:
            prior[cid] = obj.get("own_id_in_git")
    return prior


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jsonl", help="write one JSON object per card to this path")
    ap.add_argument("--ids", help="comma-separated card ids instead of the batch files")
    args = ap.parse_args()

    mv = git_dump(MARVEEN)
    cc = git_dump(CLEANCORE)
    print(f"git history read: marveen={len(mv)} commits, cleancore={len(cc)} commits")
    if not cc:
        print("REFUSING to report: the CleanCore history is exactly what strict-recheck was missing;", file=sys.stderr)
        print("running without it would reproduce the defect this card exists to fix.", file=sys.stderr)
        return 3
    mv_pref, cc_pref = build_sha_prefix_set(mv), build_sha_prefix_set(cc)
    prior = load_strict_recheck()

    rows = []
    for label, ids in load_batches(args.ids):
        tally = Counter()
        flipped = []
        for cid in ids:
            m_s, m_l = scan(mv, mv_pref, cid)
            c_s, c_l = scan(cc, cc_pref, cid)
            if m_s or c_s:
                verdict = "cited_strict"
            elif m_l or c_l:
                verdict = "cited_loose"
            else:
                verdict = "uncited"
            where = []
            if m_s or m_l:
                where.append("marveen")
            if c_s or c_l:
                where.append("cleancore")
            tally[verdict] += 1
            if where:
                tally["where:" + "+".join(where)] += 1
            was = prior.get(cid)
            if verdict == "cited_strict" and was is False:
                flipped.append((cid, (c_s or m_s)[0]))
            rows.append({
                "id": cid,
                "batch": label,
                "verdict": verdict,
                "repos": where,
                "strict_hits": [{"repo": "marveen", "sha": s, "subject": j} for s, j in m_s]
                               + [{"repo": "cleancore", "sha": s, "subject": j} for s, j in c_s],
                "loose_hits": [{"repo": "marveen", "sha": s, "subject": j} for s, j in m_l]
                              + [{"repo": "cleancore", "sha": s, "subject": j} for s, j in c_l],
                "strict_recheck_own_id_in_git": was,
            })

        print(f"\n=== {label}: {len(ids)} cards")
        for k in ("cited_strict", "cited_loose", "uncited"):
            print(f"    {k:14} {tally[k]}")
        for k in sorted(t for t in tally if t.startswith("where:")):
            print(f"    {k:14} {tally[k]}")
        print(f"    -> {len(flipped)} card(s) strict-recheck called 'no git evidence' that ARE explicitly cited")
        for cid, (sha, subj) in flipped[:5]:
            print(f"       {cid}  {sha[:10]}  {subj[:64]}")
        if len(flipped) > 5:
            print(f"       ... and {len(flipped) - 5} more")

    total = Counter(r["verdict"] for r in rows)
    wrong = sum(1 for r in rows if r["verdict"] == "cited_strict" and r["strict_recheck_own_id_in_git"] is False)
    print(f"\n=== TOTAL {len(rows)} cards: "
          f"cited_strict={total['cited_strict']} cited_loose={total['cited_loose']} uncited={total['uncited']}")
    print(f"=== {wrong} were filed 'no git evidence' by strict-recheck but are explicitly cited by a commit.")
    print("    'cited' means work exists that names the card -- NOT that the card is done. That stays a per-card question.")

    if args.jsonl:
        Path(args.jsonl).write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
        print(f"wrote {len(rows)} rows -> {args.jsonl}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
