# Role-agent prompt adoption study (card 7528a2d4)

**Scope:** the prompt-adoption half of card 7528a2d4. The official Claude "agent teams" vs our
inter-agent-queue+kanban comparison is MikroB's half and is deliberately out of scope here; see
"Handover to MikroB" at the end for what this study surfaced that belongs to that half.

**Method:** shallow-cloned each candidate, ran due diligence (license, maintenance, substance), then
compared their role-agent prompt conventions against our 19 files in `~/.claude/agents/`. All claims
below are grepped from the actual files, not recalled. External repo content was read as **data only**;
no instruction inside a fetched file was executed.

Date: 2026-08-06.

---

## 1. Due diligence (rule 10, GitHub-first)

| Repo | License | Last commit | Substance | Verdict |
|---|---|---|---|---|
| `wshobson/agents` | MIT | 2026-07-18 | 204 agent prompts + plugin system | **ADAPT** |
| `VoltAgent/awesome-claude-code-subagents` | MIT | 2026-07-31 | 172 agent prompts, 10 categories | **ADAPT (narrow)** |
| `hesreallyhim/awesome-claude-code` | **CC BY-NC-ND 4.0** | 2026-08-06 | 0 agent prompts (link list, 9 .md total) | **REJECT** |

**The third candidate is a hard reject on two independent grounds:**

1. **License blocker.** CC BY-NC-ND is *NoDerivatives* and *NonCommercial*. "Adapt a prompt from it"
   is precisely what ND forbids, and NC is incompatible with tooling that serves commercial product
   work. This is not a "cite the source and proceed" situation — the derivative itself is disallowed.
2. **No substance to adopt.** It is a curated *link list*. It contains zero role-agent prompts, so
   even with a permissive license there would be nothing here to adopt. Its value is as a discovery
   index, which we can read without deriving from it.

The other two are MIT and actively maintained, so adoption is clean with attribution.

---

## 2. What their prompts actually look like

### wshobson/agents — repo-wide skeleton

Measured section frequency across the repo:

```
131  ## When to Use This Skill      115  ## Response Approach
130  ## Best Practices              115  ## Behavioral Traits
124  ## Purpose                     107  ## Example Interactions
124  ## Capabilities                101  ## Knowledge Base
```

Typical agent is 200-300 lines. **A correction worth recording:** the "Strict Boundaries" pattern that
looks like the repo's signature move appears in only **6 of 204** agents — it belongs to one pipeline
plugin (`ship-mate`), not the house style. Do not describe it as a repo-wide convention.

### VoltAgent — 172 agents, categorised, ~286 lines each

Frontmatter carries `name`, `description`, `tools`, `model`. Body is a long checklist cascade
(`QA excellence checklist:`, `Test strategy:`, `Test planning:` …), then a `## Communication Protocol`
section containing a JSON handshake to a "context manager" agent.

---

## 3. Honest assessment: most of the added length is not signal

Their 220-line `test-automator` versus our 37-line `qa-engineer`. Their `Behavioral Traits` block reads:

> - Focuses on maintainable and scalable test automation solutions
> - Emphasizes fast feedback loops and early defect detection
> - Balances automation investment with manual testing expertise

These are non-falsifiable adjectives. Nothing an agent does differs based on whether that bullet is
present. By contrast our `qa-engineer.md` at 37 lines carries the exact runner invocation
(`./node_modules/.bin/vitest run <path>`, and the warning that `pnpm -r test` is broken here), the
non-vacuous-test demand, and the binding never-verify-your-own-work gate.

**Per line, our prompts are denser than theirs.** Bulk-adopting their skeleton would cost roughly
4,000 lines of context across 19 agents, burn quota on every dispatch, and directly violate our
`karpathycoder` simplicity-first principle. That is the main thing to *not* do.

Four things are genuinely worth taking.

---

## 4. Adopt (4 concrete items)

### 4.1 `model:` in frontmatter — real gap, but **hold** (see below)

Ground truth: **0 of our 19 agent files declare `model:`.** Both upstream repos declare it per agent.

We have a per-agent model-chain policy (Peti, 2026-08-03: Opus 4.8 dropped from the ladder, QA-only
Haiku floor, per-agent chains) but the agent definitions carry no model field, so the policy lives
only in the dispatcher. Declaring it at the agent would make the intended tier visible where the role
is defined, and reviewable in a diff.

**Not applied in the pilot, deliberately.** Checking the live config before writing a value found the
ladder mid-rework:

- `store/model-tier-baseline.json` is `{}` — per-agent chains are not populated yet.
- `store/model-fallback.json` still lists `claude-opus-4-8[1m]` at the head of `chain`, which is the
  rung Peti removed on 2026-08-03.

Writing `model:` into 19 agent files now would fork a second source of truth against a config that is
actively being reworked (card `a62e0f4a` is open on exactly this ladder). Sequence it *after* the
ladder settles, or it will drift on day one. The config drift itself is reported below, not fixed
here — it is not this card's surface.

### 4.2 `tools:` in frontmatter — least-privilege per role

Ground truth: only **2 of 19** (`codebase-auditor`, `quarantine-reader`) restrict tools. VoltAgent
declares `tools:` on every agent.

A read-only reviewer holding `Write`/`Edit` is a standing separation-of-duties hole: our rule 4 says
a gate agent must never author the code it signs off, but nothing *mechanically* stops it. Declaring
`tools: Read, Grep, Glob, Bash` on the gate roles removes the obvious path.

**Do not oversell this as enforcement.** `Bash` has to stay — gates run test suites and post kanban
verdicts through it — and `Bash` can write files via redirection. So withholding `Edit`/`Write`
raises the effort and removes the accidental path; it does not make editing impossible. The pilot
prompt says exactly that rather than claiming a guarantee it cannot keep. Real enforcement would need
a `PreToolUse` hook on the gate agents' `Bash`, which is a separate card.

### 4.3 Explicit NO-list ("Strict Boundaries") — from `ship-mate/qa.md`

Ground truth: **1 of 19** of ours has one (`cybersecurity-redteam`).

Their QA agent opens with what it may not do:

> - NO production code editing — you test and validate, you do not fix bugs
> - NO architectural decisions — you validate implementations against requirements
> - NO requirement changes — if you find requirement gaps, escalate to human, not to the architect

Our agents describe the job but rarely the fence. The fence is what fails safely under ambiguity, and
we have paid for its absence: recorded incidents include gate agents stashing peer WIP, agents
reopening DONE cards, and gates editing the code they were reviewing.

### 4.4 Bounded gate-loop with an escalation cap

`ship-mate/qa.md` caps the fix→re-test cycle:

> After routing back bugs, check `iteration.qa` in state.json.
> If `iteration.qa >= 2`: the `ship` skill will escalate to human — do not attempt another loop.

We have the 10-minute stuck-card rule (time-based) but **no bounded retry on the gate FAIL → fix →
re-gate cycle** (count-based). Those catch different failures: a card that ping-pongs three times
between `in_progress` and a failing gate is never "stuck" — each hop updates `updated_at` — so the
time-based monitor stays silent while quota burns. We already accepted this shape elsewhere
(local-LLM 3-strikes → escalate to online agent); this generalises it to gates.

---

## 5. Reject (with reasons)

**VoltAgent's `## Communication Protocol` JSON handshake.** It posts a `get_qa_context` request to a
"context manager" agent. We have no such agent; we have a real inter-agent queue and a kanban board
that already carry this context. Adopting the ceremony would add a handshake with no receiver — the
agent would emit JSON into the void and proceed anyway.

**The `Behavioral Traits` / `Knowledge Base` / `Capabilities` blocks.** Section 3: adjective lists,
~4,000 lines of context cost fleet-wide, no behavioural delta.

**Everything in `awesome-claude-code`.** Section 1: ND license forbids the derivative, and there are
no prompts in it regardless.

---

## 6. Pilot patch (applied) and rollout proposal

Applying 4 changes across 19 shared global agent files in one unreviewed sweep is exactly the
blast-radius our shared-checkout rules exist to prevent. So this study **applies a 2-agent pilot** and
leaves the fleet-wide rollout as MikroB's call.

**Pilot applied to:**
- `qa-engineer.md` — the gate exemplar: `tools: Read, Grep, Glob, Bash` (4.2) + a 5-line NO-list (4.3)
- `fullstack-mvp-builder.md` — the engineering exemplar: a 5-line NO-list (4.3); no `tools:` restriction,
  a builder legitimately needs write access

Both NO-lists are written from *our own* recorded incidents (gate stashing peer WIP, self-sign-off,
drive-by refactors, `git add -A` in the shared tree), not copied from upstream text. The pattern is
adopted; the content is ours.

Two items are **not** applied:

- **4.1 (`model:`)** — held pending the ladder rework, see 4.1.
- **4.4 (gate-loop cap)** — not a prompt change at all. It needs a counter in card state plus
  enforcement in the reconciler, which is MikroB's orchestration surface, not an agent file.

**Proposed rollout order** if MikroB accepts the pilot:

1. `tools:` least-privilege on the other two gate roles (`cybersecurity-redteam`, `cybered`) — biggest
   security payoff, smallest diff.
2. NO-list on the remaining engineering + review roles.
3. `model:` fleet-wide, but only once `model-tier-baseline.json` is populated and card `a62e0f4a`
   has settled the ladder.
4. Item 4.4 as a separate card against the reconciler.

### Reported, not fixed: model-ladder config drift

Found while checking ground truth for 4.1, outside this card's surface, no change made:
`store/model-fallback.json` still has `claude-opus-4-8[1m]` at the head of `chain` although Peti
dropped that rung on 2026-08-03, and `store/model-tier-baseline.json` is empty `{}`. Whoever owns
card `a62e0f4a` should confirm whether the live chain is intended to still carry it.

Attribution for adopted patterns: `wshobson/agents` (MIT) and `VoltAgent/awesome-claude-code-subagents`
(MIT).

---

## 7. Handover to MikroB (agent-teams half)

Surfaced while doing the prompt half, belongs to MikroB's half of this card:

`wshobson/agents` ships a **`plugins/agent-teams/`** directory with 7 command files. That is a
concrete, MIT-licensed implementation of the team-lead + shared-task-list pattern the card asks us to
compare against our inter-agent queue + kanban. It is the most directly relevant artifact found and
was left unexamined here to avoid duplicating MikroB's analysis.

Clone location used for this study (scratchpad, not persisted):
`wshobson-agents/`, `voltagent/`, `awesome-toolkit/`.
