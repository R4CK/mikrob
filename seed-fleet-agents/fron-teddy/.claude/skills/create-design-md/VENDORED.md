# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/ibelick/ui-skills.git |
| subdir | skills/create-design-md |
| vendored commit | `ebf5f26cd275b1412be8a2c8784c4f8da628e7c2` |
| commit date | 2026-09-30T20:03:03+02:00 |
| vendored at | 2026-10-24T18:02:57+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | /home/neon/marveen/store/adopted/ibelick__ui-skills |

> **Usage restriction:** Fron Ted + Fron Teddy (frontend-scoped). Card 784e3809, Peti request Telegram 12196 (2026-10-24). skill-security-auditor WARN+mitigated: the skill body's 4 'npx @google/design.md <spec|lint|export|diff>' invocations (a real, Proprietary-licensed npm CLI the skill's stated purpose legitimately needs) were unpinned -- pinned to @0.4.0 (the current published version, confirmed via npm view) as a local, documented deviation from upstream, closing the unpinned-resolution supply-chain risk (46ad2933 class) without changing the skill's function. Re-pin on next re-vendor if upstream publishes a newer version.

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/ibelick/ui-skills.git --name create-design-md --subdir skills/create-design-md --ref ebf5f26cd275b1412be8a2c8784c4f8da628e7c2 --note "Fron Ted + Fron Teddy (frontend-scoped). Card 784e3809, Peti request Telegram 12196 (2026-10-24). skill-security-auditor WARN+mitigated: the skill body's 4 'npx @google/design.md <spec|lint|export|diff>' invocations (a real, Proprietary-licensed npm CLI the skill's stated purpose legitimately needs) were unpinned -- pinned to @0.4.0 (the current published version, confirmed via npm view) as a local, documented deviation from upstream, closing the unpinned-resolution supply-chain risk (46ad2933 class) without changing the skill's function. Re-pin on next re-vendor if upstream publishes a newer version." --dest /home/neon/marveen-agent-worktrees/fron-ted/seed-fleet-agents/fron-teddy/.claude/skills
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
