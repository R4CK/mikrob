# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/addyosmani/agent-skills |
| subdir | skills/doubt-driven-development |
| vendored commit | `7829ffd90d973b6325f5f12f1b1226dcace74443` |
| commit date | 2026-07-26T14:51:12+02:00 |
| vendored at | 2026-08-26T16:13:33+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | /home/neon/marveen-agent-worktrees/backend/store/adopted/addyosmani__agent-skills |

> **Usage restriction:** Pinned to the FIRST commit that introduced this skill upstream (2026-07-26), not the current tip: upstream's own later fix (91d4d07, resolve references/ links from the skill directory) rewrites the in-skill reference to ../../references/orchestration-patterns.md, which only resolves in upstream's own repo layout (references/ sits two levels above skills/<name>/). Our flattened ~/.claude/skills/<name>/ layout cannot satisfy that path form either way, so re-vendoring to the fixed commit would not actually fix anything without also restructuring the install layout. The missing references/orchestration-patterns.md was copied in locally instead (self-contained, matching this pinned commit's own relative form -- no ../../) -- see card 25c35be7.

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/addyosmani/agent-skills --name doubt-driven-development --subdir skills/doubt-driven-development --ref 7829ffd90d973b6325f5f12f1b1226dcace74443 --note "Pinned to the FIRST commit that introduced this skill upstream (2026-07-26), not the current tip: upstream's own later fix (91d4d07, resolve references/ links from the skill directory) rewrites the in-skill reference to ../../references/orchestration-patterns.md, which only resolves in upstream's own repo layout (references/ sits two levels above skills/<name>/). Our flattened ~/.claude/skills/<name>/ layout cannot satisfy that path form either way, so re-vendoring to the fixed commit would not actually fix anything without also restructuring the install layout. The missing references/orchestration-patterns.md was copied in locally instead (self-contained, matching this pinned commit's own relative form -- no ../../) -- see card 25c35be7."
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
