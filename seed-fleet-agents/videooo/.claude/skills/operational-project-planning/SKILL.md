---
name: operational-project-planning
description: Turn an analyzed process (from a video, a demo, a spec, or a described workflow) into a business-grade implementation project plan — scope, WBS, resources, risk matrix, milestones. Use when asked for a project plan, WBS, roadmap, resource estimate, risk analysis, or "how would we build/reproduce this". Triggers on "project plan", "projektterv", "WBS", "utemezes", "eroforras", "kockazat", "milestones", "how to implement this".
---
# Operational project planning

Convert "here is what the process does" into "here is how a team executes it." Ground
every element in the analyzed evidence — no generic filler. If an input is unknown,
state the assumption explicitly rather than inventing a number.

## Procedure

### 1. Scope
One paragraph: the exact expected end product (deliverable), what is IN and what is
explicitly OUT. A reader must be able to tell "done" from "not done."

### 2. WBS (Work Breakdown Structure) — hierarchical
Decompose to at least Phase -> Task -> Subtask (go deeper where the work warrants).
Prefer a Markdown table; each leaf is small enough to estimate and assign.
```
| WBS | Phase / Task / Subtask | Deliverable | Est. effort | Depends on |
| 1   | Phase: Foundation      | ...         | ...         | -          |
| 1.1 | Task: ...              | ...         | ...         | 1          |
| 1.1.1 | Subtask: ...         | ...         | ...         | 1.1        |
```
Sequence by dependency, not by video order (the video may demo out of build order).

### 3. Resources & tooling
- **Human**: roles + seniority + rough person-days (e.g. "1 senior FE, ~4d").
- **Software / infra**: every tool, service, SDK, license shown or implied, with the
  license type and cost tier (free / paid / usage-based). Reuse-first: name existing
  open-source/community solutions before proposing custom build (GitHub-first).
- **Budget**: an indicative range with the assumptions behind it.

### 4. Risk matrix — top 3
```
| # | Risk | Likelihood | Impact | Mitigation |
```
Pick the three that would actually derail delivery (technical, dependency, or scope),
each with a concrete, ownable mitigation — not "monitor closely."

### 5. Milestones & schedule
Indicative, week-based unless told otherwise (Week 1: prep, Week 2: build/test, ...).
Each milestone = a verifiable state ("auth works end-to-end"), tied to WBS items.

## Pitfalls
- **Video order != build order** — a tutorial demos the finished thing first; sequence
  the WBS by real dependencies.
- **Hidden setup** — tutorials skip account/API-key/env setup; surface these as explicit
  Phase-0 tasks and as risks (credential/access blockers).
- **Estimates as facts** — always label effort/budget as estimates with stated assumptions.
- **Generic risks** — "team availability" is filler; find the risks specific to THIS build.

## Verification
- Every WBS leaf traces back to something in the analyzed process (or a stated assumption).
- Scope names a testable end product; milestones are verifiable states, not activities.
- Resource list includes licenses; a reader could budget from it.
- Output in the requester's language.
