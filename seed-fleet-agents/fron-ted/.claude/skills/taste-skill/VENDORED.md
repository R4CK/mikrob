# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field           | value                                                                     |
| --------------- | -------------------------------------------------------------------------------------- |
| source repo     | https://github.com/Leonxlnx/taste-skill                                                |
| subdir          | skills/taste-skill                                                                     |
| vendored commit | `ccbc15639c97057cbfcf32ecebc38ef716e4bb37`                                             |
| commit date     | 2026-08-24T23:23:56+08:00                                                              |
| vendored at     | 2026-08-24 (adopted into the fleet; backfilled into this seed-fleet-agents copy 2026-09-25, card a6abb230) |
| licence         | MIT -- see UPSTREAM-LICENSE next to this file (Leonxlnx, 2026)                         |
| watch clone     | /home/neon/marveen/store/adopted/Leonxlnx__taste-skill                               |

> **Usage restriction:** none beyond MIT attribution. Scope per the live SKILL.md frontmatter
> (`fleet-scope`): landing pages, portfolios, redesigns -- NOT dashboards, data tables, multi-step
> product UI, or trivial component tweaks.

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/Leonxlnx/taste-skill --name taste-skill --subdir skills/taste-skill
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands). This file did not exist before card 85521c7e F2 (Cybersec
finding: taste-skill spread without VENDORED.md/licence and outside vendored-skill-integrity.py's
scan scope, gap closed in the same commit).
