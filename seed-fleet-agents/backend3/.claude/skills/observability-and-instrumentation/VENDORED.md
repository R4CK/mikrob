# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/addyosmani/agent-skills |
| subdir | skills/observability-and-instrumentation |
| vendored commit | `1c760d643497e9da289300e5eb2f5aca861503f7` |
| commit date | 2026-09-04T08:45:55+02:00 |
| vendored at | 2026-09-04T09:39:31+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | /home/neon/marveen/store/adopted/addyosmani__agent-skills |

> **Usage restriction:** Adopted 2026-09-04 (catch-up review, see constraint-driven-development note). Marginal gap: observability-engineer is an AGENT persona to dispatch to, but no lightweight skill existed for another agent to self-apply when adding logging/metrics/tracing in place. POST-VENDOR FIX APPLIED (same treatment as doubt-driven-development's orchestration-patterns.md): upstream's SKILL.md links `../../references/observability-checklist.md`, which only resolves in upstream's own repo layout (references/ sits two levels above skills/<name>/); our flattened `~/.claude/skills/<name>/` layout cannot satisfy that path. Fixed by copying `references/observability-checklist.md` from the repo root into this skill's own `references/` subdir and rewriting the SKILL.md link to the flat `references/observability-checklist.md`. **A re-vendor will overwrite both the copied file and the link rewrite — redo this fix after any re-vendor.**

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/addyosmani/agent-skills --name observability-and-instrumentation --subdir skills/observability-and-instrumentation --note "Adopted 2026-09-04 (catch-up review, see constraint-driven-development note). Marginal gap: observability-engineer is an AGENT persona to dispatch to, but no lightweight skill existed for another agent to self-apply when adding logging/metrics/tracing in place. Needs references/observability-checklist.md flattened in (repo-root ../../references/, same treatment as doubt-driven-development's orchestration-patterns.md)."
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
