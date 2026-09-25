# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/anthropics/skills |
| subdir | skills/webapp-testing |
| vendored commit | `f17010c9bb483898c1d9c9f42dde2b3a98889434` |
| commit date | 2026-08-07T13:14:14-04:00 |
| vendored at | 2026-08-13T16:10:18+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `skills/webapp-testing/LICENSE.txt`) |
| watch clone | /home/neon/marveen/store/adopted/anthropics__skills |

> **Usage restriction:** Apache-2.0 (per-skill LICENSE.txt). scripts/with_server.py subprocess.Popen(shell=True) az OPERATOR altal atadott --server stringre: soha ne adj neki nem-megbizhato bemenetet. Elofeltetel: python playwright csomag + chromium (jelenleg NINCS telepitve). Atfedes: a flottanak van mcp__playwright__* MCP-je is; ez a scriptelt, ismetelheto ut (with_server.py szerver-lifecycle).

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/anthropics/skills --name webapp-testing --subdir skills/webapp-testing
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
