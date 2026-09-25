#!/usr/bin/env python3
"""Card 08eb6402 (MikroB plan-grilling verdict, card comment 6011 + msg 3736): the MACHINE-WRITTEN
half of the Suite-SHA evidence design -- a suite run records its own result, so a landing never has
to trust a hand-typed comment.

WHY MACHINE-WRITTEN, NOT A GATE'S FREE-TEXT COMMENT (the design this file replaces, msg 3736 point
1). A typed "Suite-SHA: <sha> 786/786 zold" line can be written by anyone, at any time, whether or
not the suite actually ran -- and updating every gate agent's prompt to write it correctly was a
cross-agent dependency this card should not create. Instead `mopsion-suite-run.sh` calls this
script at the end of EVERY run it performs, and only a run that actually executed writes a record.

WHY THE MERGE-COMMIT'S TREE HASH, NOT THE SHA (msg 3736 point 2). A commit sha changes on rebase/
reword even when the tree it produces does not; the tree hash (`git rev-parse <sha>^{tree}`) is the
only identifier that answers "does this landing still describe what the suite actually tested" with
no heuristic, no per-file diff, no harmless-churn allowlist to maintain. Two commits with the same
tree hash are, by construction, byte-identical in every tracked file.

THE BIRPC FALSE-RED (msg 3736/6011 point 4, card c6153a69). A full suite that hits vitest 3.2.6's
hardcoded 60s worker-RPC timeout exits 1 with ZERO failed tests -- indistinguishable from a real
regression by exit code or failure count alone. store/vitest-flake-classify.sh already answers this
(0 = known benign flake, 1 = clean pass or genuine failure, 3 = incomplete run, no summary at all).
This file calls it on EACH leg (main + api-e2e run separately, card cae9fb67) and marks the WHOLE
record `anomaly` if either leg is 0 or 3 -- an anomalous run is neither a pass nor a fail; it needs a
re-run, and a caller that read it as either would be exactly the "green but never really ran" or
"red for a reason nobody investigates" failure this exists to prevent.

STORAGE: one append-only JSONL file (never rewritten, never rotated -- growth is a few hundred bytes
per suite run, at most tens of runs a day). The run's two logs are copied to a durable per-tree-hash
path before mopsion-suite-run.sh's own EXIT trap deletes its `mktemp` originals -- keeping the
`log-útvonal` requirement from being a path to a file that no longer exists an hour later.

USAGE:
  record:  suite-evidence-record.py record --sha S --tree T --agent A \\
             --main-log PATH --main-status N [--e2e-log PATH --e2e-status N] \\
             [--store PATH] [--log-dir PATH]
           Exit 0 always (a broken evidence writer must never fail the suite run itself); prints one
           line: READY|S|T|pass=P fail=F skip=K  or  ANOMALY|S|T|<why>  (FAILED is never printed
           here -- a real failure is still evidence, just evidence of red, so it prints READY too;
           "the check FAILED" is the land-time reader's classification, not the writer's).
  lookup:  suite-evidence-record.py lookup --tree T [--store PATH]
           Prints the LATEST record for that tree hash: PRESENT|<sha>|pass=P fail=F skip=K|<log dir>
           or ANOMALY|<sha>|<why> or FAILED|<sha>|pass=P fail=F skip=K or MISSING. Exit 0 always.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
import os

# Env override, not a CLI flag on every caller: mopsion-suite-run.sh (writer) and mopsion-land.sh /
# mopsion-preland.sh (readers) must agree on the SAME path without each threading a --store flag
# through every call site. A selftest points both writer and reader at one scratch file this way.
DEFAULT_STORE = Path(os.environ.get("SUITE_EVIDENCE_STORE", str(HERE / "mopsion-suite-evidence.jsonl")))
DEFAULT_LOG_DIR = Path(os.environ.get("SUITE_EVIDENCE_LOG_DIR", str(HERE / ".mopsion-suite-logs")))
FLAKE_CLASSIFY = HERE / "vitest-flake-classify.sh"

_SUMMARY = re.compile(
    r"Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*\(\d+\)"
)


def parse_counts(log_path: str) -> tuple[int, int, int] | None:
    """(passed, failed, skipped) from the LAST summary line in the log, or None if no summary
    exists at all -- matching vitest-flake-classify.sh's own "no summary = incomplete" stance,
    not zero-filling a run that never reached a verdict."""
    try:
        text = Path(log_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    matches = list(_SUMMARY.finditer(text))
    if not matches:
        return None
    m = matches[-1]
    failed = int(m.group(1)) if m.group(1) else 0
    passed = int(m.group(2))
    skipped = int(m.group(3)) if m.group(3) else 0
    return passed, failed, skipped


def classify_leg(status: str, log_path: str) -> str:
    """'flake' | 'incomplete' | 'ok' -- see vitest-flake-classify.sh's own exit-code contract."""
    try:
        p = subprocess.run(
            ["bash", str(FLAKE_CLASSIFY), status, log_path],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return "ok"  # the classifier itself failing is not evidence of a flake
    if p.returncode == 0:
        return "flake"
    if p.returncode == 3:
        return "incomplete"
    return "ok"


def persist_log(src: str, tree: str, suffix: str, log_dir: Path) -> str:
    log_dir.mkdir(parents=True, exist_ok=True)
    dest = log_dir / ("%s-%s.log" % (tree, suffix))
    try:
        dest.write_bytes(Path(src).read_bytes())
    except OSError:
        return ""
    return str(dest)


def cmd_record(args) -> int:
    store = Path(args.store or DEFAULT_STORE)
    log_dir = Path(args.log_dir or DEFAULT_LOG_DIR)

    legs = [("main", args.main_log, args.main_status)]
    if args.e2e_log is not None:
        legs.append(("e2e", args.e2e_log, args.e2e_status))

    anomaly_reasons = []
    total_pass = total_fail = total_skip = 0
    any_counts = False
    persisted_logs = {}

    for name, log_path, status in legs:
        if log_path is None:
            continue
        kind = classify_leg(str(status), log_path)
        if kind != "ok":
            anomaly_reasons.append("%s leg: %s (vitest-flake-classify)" % (name, kind))
        counts = parse_counts(log_path)
        if counts is None:
            if kind == "ok":
                anomaly_reasons.append("%s leg: no summary line found, and not the known flake" % name)
        else:
            any_counts = True
            p, f, s = counts
            total_pass += p
            total_fail += f
            total_skip += s
        persisted_logs[name] = persist_log(log_path, args.tree, name, log_dir)

    record = {
        "sha": args.sha,
        "tree": args.tree,
        "agent": args.agent,
        "pass": total_pass,
        "fail": total_fail,
        "skip": total_skip,
        "anomaly": bool(anomaly_reasons),
        "anomaly_reasons": anomaly_reasons,
        "logs": persisted_logs,
        "ts": int(time.time()),
    }
    try:
        store.parent.mkdir(parents=True, exist_ok=True)
        with store.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except OSError as exc:
        # A failed WRITE must not look like a failed SUITE -- print the anomaly and let the caller
        # (mopsion-suite-run.sh) keep its own exit code regardless.
        print("ANOMALY|%s|%s|could not write evidence record: %s" % (args.sha, args.tree, exc))
        return 0

    if anomaly_reasons:
        print("ANOMALY|%s|%s|%s" % (args.sha, args.tree, "; ".join(anomaly_reasons)))
    else:
        print("READY|%s|%s|pass=%d fail=%d skip=%d" % (args.sha, args.tree, total_pass, total_fail, total_skip))
    return 0


def cmd_lookup(args) -> int:
    store = Path(args.store or DEFAULT_STORE)
    if not store.exists():
        print("MISSING")
        return 0
    latest = None
    try:
        with store.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("tree") == args.tree:
                    if latest is None or (rec.get("ts") or 0) >= (latest.get("ts") or 0):
                        latest = rec
    except OSError as exc:
        print("MISSING|could not read evidence store: %s" % exc)
        return 0
    if latest is None:
        print("MISSING")
        return 0
    if latest.get("anomaly"):
        print("ANOMALY|%s|%s" % (latest.get("sha", "-"), "; ".join(latest.get("anomaly_reasons") or [])))
        return 0
    if int(latest.get("fail", 0)) > 0:
        print("FAILED|%s|pass=%s fail=%s skip=%s" % (
            latest.get("sha", "-"), latest.get("pass", 0), latest.get("fail", 0), latest.get("skip", 0)))
        return 0
    print("PRESENT|%s|pass=%s fail=%s skip=%s|%s" % (
        latest.get("sha", "-"), latest.get("pass", 0), latest.get("fail", 0), latest.get("skip", 0),
        ",".join(v for v in (latest.get("logs") or {}).values() if v)))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    rec = sub.add_parser("record")
    rec.add_argument("--sha", required=True)
    rec.add_argument("--tree", required=True)
    rec.add_argument("--agent", required=True)
    rec.add_argument("--main-log", required=True)
    rec.add_argument("--main-status", required=True)
    rec.add_argument("--e2e-log")
    rec.add_argument("--e2e-status")
    rec.add_argument("--store")
    rec.add_argument("--log-dir")
    rec.set_defaults(func=cmd_record)

    look = sub.add_parser("lookup")
    look.add_argument("--tree", required=True)
    look.add_argument("--store")
    look.set_defaults(func=cmd_lookup)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
