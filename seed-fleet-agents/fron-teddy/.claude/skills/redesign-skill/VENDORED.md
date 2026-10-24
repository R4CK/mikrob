# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/Leonxlnx/taste-skill |
| subdir | skills/redesign-skill |
| vendored commit | `d237dd399d57524945c0c81327da5da19f7a468d` |
| commit date | 2026-10-11T23:56:48+02:00 |
| vendored at | 2026-10-24T18:40:22+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | /home/neon/marveen/store/adopted/Leonxlnx__taste-skill |

> **Usage restriction:** Fron Ted + Fron Teddy (frontend-scoped). Card 47fa9fc9, Peti Telegram 12215/12216 (2026-10-24). Upgrades existing websites/apps to premium quality without breaking functionality, framework-agnostic. Zero deps/scripts, skill-security-auditor PASS. CAUTION (matches the existing taste-skill CleanCore/mopsion note): the skill's placeholder-image guidance (picsum.photos/Unsplash/Pexels URLs) is NOT applicable where CSP img-src is self+data only -- use a data: URI or a local /assets file instead. Pinned to d237dd39 (last upstream commit where this dir existed; repo collapsed to a single taste-skill dir afterward, see VENDORED.md).

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/Leonxlnx/taste-skill --name redesign-skill --subdir skills/redesign-skill --ref d237dd399d57524945c0c81327da5da19f7a468d --note "Fron Ted + Fron Teddy (frontend-scoped). Card 47fa9fc9, Peti Telegram 12215/12216 (2026-10-24). Upgrades existing websites/apps to premium quality without breaking functionality, framework-agnostic. Zero deps/scripts, skill-security-auditor PASS. CAUTION (matches the existing taste-skill CleanCore/mopsion note): the skill's placeholder-image guidance (picsum.photos/Unsplash/Pexels URLs) is NOT applicable where CSP img-src is self+data only -- use a data: URI or a local /assets file instead. Pinned to d237dd39 (last upstream commit where this dir existed; repo collapsed to a single taste-skill dir afterward, see VENDORED.md)." --dest /home/neon/marveen-agent-worktrees/fron-ted/seed-fleet-agents/fron-teddy/.claude/skills
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
