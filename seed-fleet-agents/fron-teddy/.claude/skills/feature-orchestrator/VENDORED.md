# VENDORED -- do not edit here

This directory is a VENDORED copy of third-party work. Local edits are lost on the next re-vendor;
change it upstream, or fork it and re-point this entry.

| field | value |
|---|---|
| source repo | https://github.com/ski043/skills |
| subdir | skills/feature-orchestrator |
| vendored commit | `223f95063a935c037f9bc10b9e542afe03ea8305` |
| commit date | 2026-09-24T15:19:04+02:00 |
| vendored at | 2026-10-05T20:24:33+02:00 |
| licence | see UPSTREAM-LICENSE next to this file (upstream: `LICENSE`) |
| watch clone | /home/neon/marveen/store/adopted/ski043__skills |

> **Usage restriction:** Adopted 2026-10-05 (Peti, Telegram 10505), MIT, text-only (agents/openai.yaml is Codex metadata, inert). ADAPTED USE in this fleet: (1) sub-agent roster is FIXED to sonnet/medium for every role (CLAUDE.md rule 18) -- do not ask the user for opus; (2) Session-2 reviewers are self-review only, sign-off stays with the qa/cybersec/cybered gate pool (rule 4); (3) delivery is REVIEW comment + waiting + gates + marveen-land.sh/mopsion-land.sh, not a PR proposal; (4) the Session-1 discussion output feeds writing-prds / module-spec-design and the kanban breakdown (rule 1).

## Re-vendor

```
store/vendor-skill.sh --repo https://github.com/ski043/skills --name feature-orchestrator --subdir skills/feature-orchestrator --ref 223f95063a935c037f9bc10b9e542afe03ea8305 --note "Adopted 2026-10-05 (Peti, Telegram 10505), MIT, text-only (agents/openai.yaml is Codex metadata, inert). ADAPTED USE in this fleet: (1) sub-agent roster is FIXED to sonnet/medium for every role (CLAUDE.md rule 18) -- do not ask the user for opus; (2) Session-2 reviewers are self-review only, sign-off stays with the qa/cybersec/cybered gate pool (rule 4); (3) delivery is REVIEW comment + waiting + gates + marveen-land.sh/mopsion-land.sh, not a PR proposal; (4) the Session-1 discussion output feeds writing-prds / module-spec-design and the kanban breakdown (rule 1)."
```

Upstream changes are DETECTED + FLAGGED by store/git-repo-watcher.sh; they are never auto-applied
here. Re-vendoring is always a deliberate act (supply-chain rule: a skill steers agents, so an
upstream edit is reviewed before it lands).
