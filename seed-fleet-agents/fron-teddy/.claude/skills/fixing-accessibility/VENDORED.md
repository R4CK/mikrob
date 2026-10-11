# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/ibelick/ui-skills.git |
| subdir | skills/fixing-accessibility |
| vendored commit | `ebf5f26cd275b1412be8a2c8784c4f8da628e7c2` |
| commit date | 2026-09-30T20:03:03+02:00 |
| vendored at | 2026-10-10T08:34:25+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | /home/neon/marveen/store/adopted/ibelick__ui-skills |

> **Usage restriction:** Fron Ted only (frontend-scoped). ADAPT per card e39b6fd7/f557353a, Peti approval Telegram 10372 (2026-10-04). Pure-prose checklist, zero deps/scripts, skill-security-auditor PASS.

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/ibelick/ui-skills.git --name fixing-accessibility --subdir skills/fixing-accessibility --ref ebf5f26cd275b1412be8a2c8784c4f8da628e7c2 --note "Fron Ted only (frontend-scoped). ADAPT per card e39b6fd7/f557353a, Peti approval Telegram 10372 (2026-10-04). Pure-prose checklist, zero deps/scripts, skill-security-auditor PASS." --dest /home/neon/marveen-agent-worktrees/fron-ted/seed-fleet-agents/fron-ted/.claude/skills
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
