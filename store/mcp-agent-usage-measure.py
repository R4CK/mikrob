#!/usr/bin/env python3
"""mcp-agent-usage-measure.py -- per-agent MCP tool_use counts from transcripts (card c69a8da2).

Measures how many times each agent's OWN transcripts actually called an mcp__<server>__* tool,
feeding the allowlist decision in store/mcp-agent-allowlist.json.

Pitfall this avoids (found live while writing this): `agents/<agent>/.claude-config/projects` is,
for most agents on this install, a SYMLINK to the shared `~/.claude/projects` root (see root
CLAUDE.md "Skill-utvonal csapda"). Globbing `agents/<agent>/.claude-config/projects/*/*.jsonl`
naively reads EVERY agent's transcripts through that shared root and double/triple counts the
same files once per agent. The actual separation happens one level down: each agent's own
transcripts live under a SLUG subdirectory keyed by its cwd
(`-home-neon-marveen-agents-<agent>`), even when the parent `projects` directory itself is shared.
An agent with a genuinely ISOLATED config (the realpath of its own `projects` dir is NOT the
shared root) keeps every subdirectory under its own root instead.

Usage: python3 -I store/mcp-agent-usage-measure.py [agent ...]
No args: measures the fixed default agent roster (every non-main-agent role in this fleet).
"""
import json
import glob
import re
import collections
import os
import sys

DEFAULT_AGENTS = [
    "backend", "backend2", "backend3", "cybered", "cybersec", "cybersec2", "elemzo",
    "fron-ted", "fron-teddy", "jogasz", "marketing", "penzugy", "qa", "qa2", "teszter",
    "videooo", "fullstack",
]

SHARED_ROOT = os.path.realpath(os.path.expanduser("~/.claude/projects"))
MARVEEN_MAIN = os.environ.get("MARVEEN_MAIN", "/home/neon/marveen")


def measure(agent: str) -> tuple[collections.Counter, int, bool]:
    proj_root = f"{MARVEEN_MAIN}/agents/{agent}/.claude-config/projects"
    real_root = os.path.realpath(proj_root)
    shared = real_root == SHARED_ROOT
    if shared:
        slug = f"-home-neon-marveen-agents-{agent}"
        candidate_dirs = [os.path.join(real_root, slug)]
    else:
        candidate_dirs = glob.glob(os.path.join(real_root, "*"))

    counts: collections.Counter = collections.Counter()
    files_seen = 0
    for d in candidate_dirs:
        for fp in glob.glob(os.path.join(d, "*.jsonl")):
            files_seen += 1
            try:
                with open(fp, "r", errors="ignore") as f:
                    for line in f:
                        if '"tool_use"' not in line:
                            continue
                        try:
                            obj = json.loads(line)
                        except Exception:
                            continue
                        content = obj.get("message", {}).get("content", [])
                        if not isinstance(content, list):
                            continue
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "tool_use":
                                name = block.get("name", "")
                                if isinstance(name, str) and name.startswith("mcp__"):
                                    m = re.match(r"^mcp__([a-zA-Z0-9_-]+)__", name)
                                    if m:
                                        counts[m.group(1)] += 1
            except Exception:
                pass
    return counts, files_seen, shared


def main() -> None:
    agents = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_AGENTS
    for agent in agents:
        counts, files_seen, shared = measure(agent)
        tag = "shared-root" if shared else "isolated"
        parts = " ".join(f"{k}:{v}" for k, v in counts.most_common()) if counts else "(none)"
        print(f"{agent} [{tag}, files={files_seen}] -> {parts}")


if __name__ == "__main__":
    main()
