# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/addyosmani/agent-skills |
| subdir | skills/interview-me |
| vendored commit | `bcab6a1b8503100e8618c3b4e32cc78de43de769` |
| commit date | 2026-09-22T21:05:38-07:00 |
| vendored at | 2026-10-10T15:57:59+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | {{INSTALL_DIR}}/store/adopted/addyosmani__agent-skills |



## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/addyosmani/agent-skills --name interview-me --subdir skills/interview-me --ref bcab6a1b
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
