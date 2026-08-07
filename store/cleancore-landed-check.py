#!/usr/bin/env python3
"""Landed-check sweep for CleanCore kanban cards (card 9cc72f2c).

A card marked DONE on gate verdicts alone can still sit on a commit that never reached
origin/main. That happened three times on 2026-08-07 before anyone checked, and a sweep of the
day's 120 closed CleanCore cards then found 39 more. store/fix-landed-check.sh does this for the
marveen repo; nothing did it for CleanCore, whose cards live in the same kanban DB.

THREE CHECKS, and the third is not optional:

  1. ancestry   git merge-base --is-ancestor <sha> origin/main
  2. patch-id   the same patch under a different sha (a clean cherry-pick)
  3. content    the commit's most distinctive added lines are present on origin/main

Measured on card bf2ba50e: it HAD landed (as b114a7a9), but a conflict was resolved during the
merge, so the patch-id differs and checks 1-2 both say no. Without check 3 the sweep called four
cards unlanded that were fine -- and the remedy for a false positive is reopening finished work.

Cards are also split by ROOT CAUSE, because the fix differs:

  A) the content IS on the shared local main, just never pushed -- one push fixes all of them
  B) it is on NEITHER main, so it lives only on a feature branch and needs its own merge

READ-ONLY by default. `--mark` is what writes to the board, and it is deliberately a separate
decision: a sweep that reopens 39 cards on a heuristic should be something you asked for.

  store/cleancore-landed-check.py                    # today, report only
  store/cleancore-landed-check.py --date 2026-08-07  # a specific day
  store/cleancore-landed-check.py --mark             # also set waiting + [BLOKKOLT-landolasra]
"""
import argparse
import datetime
import json
import re
import subprocess
import urllib.request

REPO = "/mnt/h/LM_Studio_Workdir/CleanCore"
API = "http://127.0.0.1:3420/api/kanban"
TOKEN_PATH = "/home/neon/marveen/store/.dashboard-token"
SHA_RX = re.compile(r"\b([0-9a-f]{7,40})\b")
BLOCKED_PREFIX = "[BLOKKOLT-landolasra]"


def token():
    with open(TOKEN_PATH) as fh:
        return fh.read().strip()


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True)


def api(path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        API + path,
        method=method,
        data=data,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
    )
    try:
        body = urllib.request.urlopen(req, timeout=30).read()
        return json.loads(body) if body[:1] in (b"{", b"[") else body
    except Exception as exc:  # a single card must not kill the sweep
        return {"error": str(exc)}


def commits_of(card_id):
    """Every sha named in the card's comments that is a real commit in this repo."""
    comments = api(f"/{card_id}/comments")
    if isinstance(comments, dict):
        comments = comments.get("comments", [])
    out = []
    for c in comments or []:
        for m in SHA_RX.finditer(c.get("content") or ""):
            if git("cat-file", "-t", m.group(1)).stdout.strip() != "commit":
                continue
            full = git("rev-parse", m.group(1)).stdout.strip()
            if full not in out:
                out.append(full)
    return out[:8]


def landed_by_content(sha):
    """Did the EFFECT reach origin/main, even if the patch was rewritten on the way?"""
    show = git("show", "--format=", "--unified=0", sha).stdout
    added = [l[1:].strip() for l in show.splitlines() if l.startswith("+") and not l.startswith("+++")]
    probes = sorted([a for a in added if len(a) > 45 and re.search(r"[A-Za-z]{4}", a)], key=len, reverse=True)[:6]
    if probes:
        hits = sum(1 for p in probes if git("grep", "-F", "--quiet", p, "origin/main").returncode == 0)
        return f"content {hits}/{len(probes)} added-lines present" if hits >= max(1, len(probes) // 2) else None
    # A pure-deletion commit adds nothing to probe for: check the files are gone instead.
    stat = git("show", "--stat", "--format=", sha).stdout
    files = [l.split("|")[0].strip() for l in stat.splitlines() if "|" in l]
    if files and all(git("cat-file", "-e", f"origin/main:{f}").returncode != 0 for f in files):
        return f"deletion applied ({len(files)} files absent)"
    return None


def classify(card_id):
    shas = commits_of(card_id)
    if not shas:
        return "NINCS-COMMIT", ""
    for s in shas:
        if git("merge-base", "--is-ancestor", s, "origin/main").returncode == 0:
            return "LANDOLT", "ancestor"
    for s in shas:
        pid = subprocess.run(
            f"git -C {REPO} show {s} | git patch-id --stable", shell=True, capture_output=True, text=True
        ).stdout.split()
        if pid and git("cat-file", "-e", pid[0]).returncode == 0:
            return "LANDOLT", "patch-id"
    for s in shas:
        why = landed_by_content(s)
        if why:
            return "LANDOLT", why
    on_local = any(git("merge-base", "--is-ancestor", s, "main").returncode == 0 for s in shas)
    return "NEM-LANDOLT", "A" if on_local else "B"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=str(datetime.date.today()))
    ap.add_argument("--project", default="cleancore")
    ap.add_argument("--mark", action="store_true", help="write to the board (default: report only)")
    args = ap.parse_args()

    git("fetch", "origin", "main", "--quiet")
    day = datetime.date.fromisoformat(args.date)
    cards = api("?status=done")
    cards = cards if isinstance(cards, list) else cards.get("cards", [])
    todays = [
        c
        for c in cards
        if (c.get("project") or "").lower() == args.project
        and datetime.datetime.fromtimestamp(c["updated_at"]).date() == day
    ]
    print(f"{len(todays)} DONE '{args.project}' card(s) closed on {day}; origin/main = {git('rev-parse','--short','origin/main').stdout.strip()}")

    groups = {"LANDOLT": [], "NINCS-COMMIT": [], "A": [], "B": []}
    for c in todays:
        verdict, why = classify(c["id"])
        key = why if verdict == "NEM-LANDOLT" else verdict
        groups[key].append((c["id"], c["title"], why))

    print(f"\n  LANDOLT       {len(groups['LANDOLT']):>3}")
    print(f"  NEM-LANDOLT   {len(groups['A']) + len(groups['B']):>3}  (A: on local main only = {len(groups['A'])}, B: neither main = {len(groups['B'])})")
    print(f"  NINCS-COMMIT  {len(groups['NINCS-COMMIT']):>3}  (no resolvable sha in the REVIEW comments -- often correct for E2E/US and decision cards)")
    for key, label in (("A", "A) on the shared LOCAL main, never pushed -- one push fixes all of these"),
                       ("B", "B) on NEITHER main, only a feature branch -- each needs its own merge")):
        if groups[key]:
            print(f"\n{label}")
            for cid, title, _ in groups[key]:
                print(f"   {cid}  {title[:70]}")

    if not args.mark:
        print("\n(report only -- pass --mark to set waiting + the blocked prefix)")
        return
    for key in ("A", "B"):
        for cid, title, _ in groups[key]:
            if not title.startswith(BLOCKED_PREFIX):
                api(f"/{cid}", "PUT", {"title": f"{BLOCKED_PREFIX} {title}"})
            api(f"/{cid}/move", "POST", {"status": "waiting", "actor": "backend2", "force": True})
    print(f"\nmarked {len(groups['A']) + len(groups['B'])} card(s)")


if __name__ == "__main__":
    main()
