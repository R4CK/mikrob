---
name: senior-engineer-modes
description: Seven senior-engineer operating modes (build MVP, audit codebase, debug production, optimize performance, refactor to clean architecture, architect backend, build frontend components). Each mode has a matching subagent in ~/.claude/agents/. Use to pick the right engineering persona for a coding task, or to dispatch the matching agent. Triggers on engineering work like "build an app", "audit the code", "debug this", "make it faster", "refactor", "design the backend", "build a UI component".
---
# Senior Engineer Modes

Seven reusable senior-engineer personas, each backed by a dedicated subagent. For a substantial engineering task, pick the matching mode and either (a) adopt its framing directly, or (b) dispatch its subagent via the Agent tool with the listed `subagent_type`.

## Mode -> Agent map

| # | When the task is... | subagent_type | Don't |
|---|---------------------|---------------|-------|
| 1 | Build a new product/app/MVP from scratch | `fullstack-mvp-builder` | over-build; ship minimal-but-scalable |
| 2 | Audit / understand an existing codebase | `codebase-auditor` | change functionality (analyze only) |
| 3 | Hard bug / live prod issue / outage | `production-debugger` | guess; fix symptom not cause |
| 4 | Slow / memory-heavy / won't scale | `performance-optimizer` | change behavior; premature micro-opt |
| 5 | Messy code -> clean architecture | `clean-architecture-refactorer` | change behavior; one giant rewrite |
| 6 | Design/build scalable backend/infra | `backend-architect` | clever over proven; skip the data model |
| 7 | Build production UI components / design system | `frontend-component-engineer` | swap the project's UI stack |

## Eljárás
1. Classify the task into one of the 7 modes (use the table). If it spans several, pick the dominant one or chain them (e.g. audit -> refactor, debug -> verify).
2. For focused work in this session: adopt the mode's framing (full prompts in `references/prompts.md`).
3. To parallelize or isolate: dispatch the subagent, e.g. `Agent(subagent_type="production-debugger", prompt="...the bug + repro...")`. Agents that mutate files in parallel should run with `isolation: "worktree"`.
4. After modes 1/4/5/6/7 (code-producing), run `/code-review` and `/verify` before declaring done. Mode 2/3 are analysis-first; apply fixes only when asked.

## Buktatók
- These agents are global (`~/.claude/agents/`), available to every fleet agent, not just MikroB.
- `codebase-auditor` is read-only (tools: Read/Grep/Glob/Bash) by design. Don't expect it to write patches.
- Modes 2 and 5 explicitly must NOT change product behavior. If a task needs both analysis and behavior change, split it.
- These overlap with the global `code-review`, `simplify`, and `verify` skills. Those are quality-gate skills; these are the build/analyze personas. Use them together, not instead.

## Ellenőrzés
- `ls ~/.claude/agents/` shows all 7 .md files.
- `Agent(subagent_type="<name>", ...)` resolves without "unknown agent type".
