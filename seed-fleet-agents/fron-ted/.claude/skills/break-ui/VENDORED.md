# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/emilkowalski/skill |
| subdir | skills/break-ui |
| vendored commit | `e8a175de22ae1e49370fc144c1f3bb9aeedf988d` |
| commit date | 2026-10-02T06:43:31-04:00 |
| vendored at | 2026-10-05T20:23:50+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | /home/neon/marveen/store/adopted/emilkowalski__skill |

> **Usage restriction:** Adopted 2026-10-05 (Peti, Telegram 10502) for frontend agents only. MIT, text-only. Web subset: React Native/Expo, Swift and Sonner-specific skills skipped. Project rules (rule 12 error messages, rule 13 responsive/44px touch targets, WCAG) take precedence.

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/emilkowalski/skill --name break-ui --subdir skills/break-ui --ref e8a175de22ae1e49370fc144c1f3bb9aeedf988d --note "Adopted 2026-10-05 (Peti, Telegram 10502) for frontend agents only. MIT, text-only. Web subset: React Native/Expo, Swift and Sonner-specific skills skipped. Project rules (rule 12 error messages, rule 13 responsive/44px touch targets, WCAG) take precedence." --dest /home/neon/marveen/seed-fleet-agents/fron-ted/.claude/skills
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
