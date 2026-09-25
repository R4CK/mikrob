#!/usr/bin/env python3
"""Measure rule-17 compliance from the REAL command corpus (agent session transcripts).

Question: since the CleanCore suite semaphore landed, how many FULL CleanCore suite runs
went through store/cleancore-suite-run.sh, and how many invoked vitest directly?

Read-only. Counts INVOCATIONS, not mentions -- a substring match on "vitest" also hits
`pgrep -f vitest`, `cat vitest.config.ts` and Hungarian prose inside a heredoc.
"""
import json
import glob
import os
import re
import datetime
import collections

PROJ = "/home/neon/marveen/agents/backend/.claude-config/projects"
# The rule was ANNOUNCED 2026-09-04, but store/cleancore-suite-run.sh was only CREATED at
# 2026-09-04T20:41:22Z (ce3ec4d6) and fixed fleet-wide at 2026-09-04T22:52:20Z (78d182a6).
# Splitting on the announcement counts as "bypass" every run made while the tool did not
# exist yet -- so split on AVAILABILITY instead.
TOOL_EXISTS = datetime.datetime(2026, 9, 4, 20, 41, 22, tzinfo=datetime.timezone.utc)

HEREDOC = re.compile(r"<<-?\s*'?\"?(\w+)'?\"?\n.*?\n\1", re.S)

# vitest actually INVOKED: an executable token, then the `run` subcommand.
INVOKE = re.compile(r"(?:^|[;&|]\s*|\s)(?:\S*/)?vitest(?:\.mjs)?\s+run\b")
SEMAPHORE = re.compile(r"cleancore-suite-run\.sh")

# A targeted run passes POSITIONAL filters to vitest; a full run passes only flags.
# vitest treats every positional arg after `run` as a filename/name filter, so
# `vitest run proof-storage-adapters.test` is targeted even with no path and no .test.ts.
VALUE_FLAGS = {"--reporter", "--maxWorkers", "--minWorkers", "--root", "--project",
               "--pool", "--config", "--testTimeout", "--hookTimeout", "-t", "--shard"}
STOP = {"|", "||", "&&", ";", ">", ">>", "2>&1", "&"}


def has_positional(cmd):
    m = re.search(r"(?:^|[;&|]\s*|\s)(?:\S*/)?vitest(?:\.mjs)?\s+run\b", cmd)
    if not m:
        return False
    toks = cmd[m.end():].split()
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in STOP or t.startswith(">") or t.startswith("2>"):
            break
        if t.startswith("-"):
            if t in VALUE_FLAGS:
                i += 2
                continue
            i += 1
            continue
        return True  # a positional filter
    return False


CC_PATH = re.compile(r"/mnt/h/LM_Studio_Workdir/CleanCore")
OTHER_PROJECT = re.compile(r"/mnt/h/LM_Studio_Workdir/(?!CleanCore)(\w+)")


def strip_heredocs(cmd):
    """Prose inside a heredoc is data being written, never a command being run."""
    return HEREDOC.sub("", cmd)


def target_repo(cmd, cwd):
    """The command's OWN explicit path wins over cwd -- an agent sitting in its CleanCore
    worktree can still run another project's suite (measured: Ingatlan)."""
    other = OTHER_PROJECT.search(cmd)
    if other and not CC_PATH.search(cmd):
        return other.group(1)
    if CC_PATH.search(cmd):
        return "CleanCore"
    if CC_PATH.search(cwd or ""):
        return "CleanCore"
    return "?"


def classify(cmd):
    if SEMAPHORE.search(cmd):
        return "semaphore"
    if not INVOKE.search(cmd):
        return None  # a mention, not a run
    if has_positional(cmd):
        return "targeted"
    return "full"


def walk():
    for d in sorted(glob.glob(os.path.join(PROJ, "*/"))):
        agent = os.path.basename(d.rstrip("/")).replace("-home-neon-marveen-agents-", "")
        for f in glob.glob(os.path.join(d, "*.jsonl")):
            try:
                fh = open(f, encoding="utf-8", errors="replace")
            except OSError:
                continue
            with fh:
                for line in fh:
                    if "vitest" not in line and "cleancore-suite-run" not in line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    content = (rec.get("message") or {}).get("content")
                    if not isinstance(content, list):
                        continue
                    for b in content:
                        if not isinstance(b, dict) or b.get("type") != "tool_use":
                            continue
                        if b.get("name") != "Bash":
                            continue
                        raw = (b.get("input") or {}).get("command") or ""
                        yield rec.get("timestamp") or "", agent, rec.get("cwd") or "", raw


def main():
    buckets = collections.Counter()
    per_agent = collections.defaultdict(collections.Counter)
    offenders = []
    mentions = 0
    total = 0

    for ts, agent, cwd, raw in walk():
        total += 1
        cmd = strip_heredocs(raw)
        kind = classify(cmd)
        if kind is None:
            mentions += 1
            continue
        if target_repo(cmd, cwd) != "CleanCore":
            continue
        try:
            when = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except Exception:
            when = None
        window = "utana" if (when and when >= TOOL_EXISTS) else "elotte"
        buckets[(window, kind)] += 1
        if window == "utana":
            per_agent[agent][kind] += 1
            if kind == "full":
                offenders.append((ts, agent, " ".join(cmd.split())[:160]))

    print(f"Bash-parancs vitest/suite-run emlitessel: {total}")
    print(f"  ebbol PUSZTA EMLITES (nem futtatas, kiszurve): {mentions}")

    print("\n=== CleanCore TELJES/celzott futtatasok, a szkript LETEZESE elott vs utan ===")
    for w in ("elotte", "utana"):
        print(f"  {w:7s}: " + "  ".join(f"{k}={buckets[(w,k)]}" for k in ("semaphore", "full", "targeted")))

    print("\n=== Teljes-suite MEGKERULES, MIUTAN a szkript letezett (a dontes alapja) ===")
    for ts, agent, cmd in offenders:
        print(f"  {ts} | {agent}\n      {cmd}")
    if not offenders:
        print("  nincs")

    print("\n=== Agensenkent, a szkript letezese ota ===")
    for agent, c in sorted(per_agent.items()):
        print(f"  {agent}: " + " ".join(f"{k}={v}" for k, v in sorted(c.items())))


if __name__ == "__main__":
    main()
