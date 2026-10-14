# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/mukul975/Anthropic-Cybersecurity-Skills |
| subdir | skills/performing-api-rate-limiting-bypass |
| vendored commit | `54a798831d2266a3ca61ce68a7acb80b81160d57` |
| commit date | 2026-08-31T04:32:42Z |
| vendored at | 2026-09-26T06:48:18+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `skills/performing-api-rate-limiting-bypass/LICENSE`) |
| watch clone | /home/neon/marveen/store/adopted/mukul975__Anthropic-Cybersecurity-Skills |

> **Usage restriction:** Authorized targets only: this team's own product/infra (Cybersec/Cybered role scope). Active probes run only against an explicitly authorized target. Re-vendor only via an explicit --ref after a new content review (card da47b612). ACTIVE, high-volume tool: never against a shared/production target without explicit approval.

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/mukul975/Anthropic-Cybersecurity-Skills --name performing-api-rate-limiting-bypass --subdir skills/performing-api-rate-limiting-bypass --ref 54a798831d2266a3ca61ce68a7acb80b81160d57 --note "Authorized targets only: this team's own product/infra (Cybersec/Cybered role scope). Active probes run only against an explicitly authorized target. Re-vendor only via an explicit --ref after a new content review (card da47b612). ACTIVE, high-volume tool: never against a shared/production target without explicit approval." --dest seed-fleet-agents/cybersec/.claude/skills
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
