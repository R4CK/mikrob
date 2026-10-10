# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/mattpocock/skills |
| subdir | skills/engineering/wizard |
| vendored commit | `49dd158d1076134a641b33efb035946536778336` |
| commit date | 2026-10-09T11:56:49+01:00 |
| vendored at | 2026-10-10T09:19:06+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | /home/neon/marveen/store/adopted/mattpocock__skills |

> **Usage restriction:** Interactive bash-wizard generator for human-only provisioning steps (credentials, CI secrets, 3rd-party dashboard walkthroughs, one-off migrations). Card 69699ab7 (fullstack), found during the 88bf07ee mattpocock-productivity clone audit. Genuine gap: no existing fleet skill covers this.

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/mattpocock/skills --name wizard --subdir skills/engineering/wizard --ref 49dd158d1076134a641b33efb035946536778336 --note "Interactive bash-wizard generator for human-only provisioning steps (credentials, CI secrets, 3rd-party dashboard walkthroughs, one-off migrations). Card 69699ab7 (fullstack), found during the 88bf07ee mattpocock-productivity clone audit. Genuine gap: no existing fleet skill covers this." --dest /home/neon/marveen-agent-worktrees/fullstack/seed-skills
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
