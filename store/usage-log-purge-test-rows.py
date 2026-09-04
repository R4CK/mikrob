#!/usr/bin/env python3
"""Remove synthetic test rows from the LIVE local-LLM usage ledger (card 4c5c540c).

WHY A SCRIPT AND NOT A ONE-OFF COMMAND. The rows arrive from any checkout that has not yet
picked up the test-state isolation (src/__tests__/setup/isolate-local-llm-state.ts), so a
straggler landing that was already in flight can add more after a cleanup. This is re-runnable
and reports honestly when there is nothing to do.

WHAT IT DELETES, AND WHY NOT WHAT THE CARD SAID. The card names "test-agent/test-model" rows.
Filtering on the AGENT column is the wrong cut for the symptom: the Overview swimlane groups by
MODEL, and the ledger also carries rows written by the real `queue` caller against the fake
`test-model`. Deleting only agent=test-agent leaves the fake model on the chart, which is the
thing Peti asked to be rid of. So the filter is model == "test-model" -- verified to be a name no
real model uses (the ledger holds exactly three model names).

WHAT IT MUST NOT DELETE. Several REAL callers contain the substring "test": backend-selftest,
backend2-functest, backend2-test, mikrob-hybrid-test, mikrob-selftest, and a bare `test` caller
whose rows use the real qwen model. A `grep -v test` would have destroyed all of them. The match
is therefore an exact, field-anchored equality on one column, never a substring on the line.

CONCURRENCY. store/local-llm.sh appends with a plain `>>` and no lock, so rows can arrive while
this runs. We read a fixed prefix (the size at start), filter only that, then re-attach any bytes
that landed after it, so a concurrent write is preserved rather than silently dropped.
"""
import argparse
import os
import shutil
import sys
import time

FAKE_MODEL = "test-model"
MODEL_COL = 3  # 0-based: ts, caller, task, model, ...


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default="/home/neon/marveen/store/local-llm-usage.log")
    ap.add_argument("--apply", action="store_true", help="actually rewrite (default: report only)")
    args = ap.parse_args()
    path = args.path

    if not os.path.exists(path):
        print(f"usage-log-purge: {path} does not exist -- nothing to do")
        return 0

    st = os.stat(path)
    size0, mode = st.st_size, st.st_mode & 0o777
    with open(path, "rb") as fh:
        prefix = fh.read(size0)

    lines = prefix.split(b"\n")
    trailing_newline = lines and lines[-1] == b""
    if trailing_newline:
        lines = lines[:-1]

    keep, drop = [], 0
    for line in lines:
        cols = line.split(b"\t")
        if len(cols) > MODEL_COL and cols[MODEL_COL] == FAKE_MODEL.encode():
            drop += 1
        else:
            keep.append(line)

    print(f"usage-log-purge: {path}")
    print(f"  rows total   : {len(lines)}")
    print(f"  rows to drop : {drop}   (model == {FAKE_MODEL!r})")
    print(f"  rows to keep : {len(keep)}")
    if drop == 0:
        print("  nothing to do")
        return 0
    if not args.apply:
        print("  DRY RUN -- pass --apply to rewrite (a timestamped backup is made first)")
        return 0

    backup = f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)
    print(f"  backup       : {backup}")

    # Anything appended while we were working. Read it BEFORE the rename, from the same path,
    # so a row written a millisecond ago survives the cleanup instead of being the price of it.
    with open(path, "rb") as fh:
        fh.seek(size0)
        tail = fh.read()
    if tail:
        print(f"  concurrent   : {len(tail)} byte(s) appended during the run, preserved")

    body = b"\n".join(keep)
    if keep:
        body += b"\n"
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "wb") as fh:
        fh.write(body)
        fh.write(tail)
    os.chmod(tmp, mode)  # keep whatever the ledger had; do not hand it the umask default
    os.replace(tmp, path)

    after = sum(
        1
        for line in open(path, "rb").read().split(b"\n")
        if line and len(line.split(b"\t")) > MODEL_COL and line.split(b"\t")[MODEL_COL] == FAKE_MODEL.encode()
    )
    total_after = sum(1 for line in open(path, "rb").read().split(b"\n") if line)
    print(f"  rewritten    : {total_after} row(s) remain, {after} still matching (expect 0)")
    if after != 0:
        print("  WARNING: matching rows remain -- a writer added more during the rewrite; re-run.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
