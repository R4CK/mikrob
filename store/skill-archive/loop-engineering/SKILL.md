---
name: loop-engineering
description: Design a task as a self-running LOOP (trigger -> execute -> verify -> stop) instead of a one-shot prompt, so agents drive work to a finalized, verified end-state with capped iterations and a token/cost budget. Use whenever a task has a verifiable end condition and could run unattended: multi-iteration builds, "keep going until X passes", scheduled/background work, self-prompting fleets, research-until-complete. Composes with karpathycoder (goal-driven execution), project-workflow (gates), and the memory tiers. Triggers on "/loop", "loop engineering", "run until", "keep building until", "self-prompt", "design a loop", "csinálj belőle loopot", "fusson magától amíg".
---

# Loop Engineering

## Purpose
A prompt is an *instruction* (what to do). A loop is a *final condition* (when to stop). The shift: stop hand-iterating (prompt -> respond -> you iterate -> repeat) and instead design a loop that returns a finalized, verified result. "I don't prompt anymore, I write loops that prompt the agent." This skill makes that discipline explicit and wires it into the existing orchestrator, gates, memory, and Karpathy discipline so a loop cannot run away, cannot declare victory without proof, and cannot burn unbounded budget.

## When to use
- The task has a **verifiable end-state** (tests green + coverage, a metric threshold, "N items processed", a report that passes a critic).
- Work benefits from running **unattended / on an interval** (scheduled tasks, background builds, research sweeps).
- You catch yourself planning to manually re-prompt "continue" several times — that IS a loop; write it as one.
- Relax for genuinely one-shot work (a single answer, a trivial edit). A loop with no iteration is just overhead.

## The six parts of a loop (design ALL of them before starting)
Map every loop to these. If a part is missing, the loop is unsafe.

1. **Trigger** — how it starts and re-fires: an interval (cron / scheduled-task), an event (PR comment, CI fail, inbound message), or self-paced (agent schedules its own next wake). Prefer event-driven over polling; when you must poll, match the interval to how fast the watched state actually changes.
2. **Execution** — the agent reads current state (kanban / memory / files / logs), acts, and writes output. No human in the inner loop.
3. **Verifier** — a check that grades the output, ideally a **separate** agent/model from the one that produced it (author never grades own work — see project-workflow gates). Tests / build / screenshot / a critic pass. This is the loop's truth source.
4. **Stop rules** — BOTH success AND failure must stop, plus a hard cap. Be explicit: `success = <verifiable condition>`, `failure = <give-up condition>`, `cap = N iterations OR $/token budget OR deadline`. A loop with only a success condition is a runaway.
5. **Memory** — a durable progress record (markdown file / memory tier / kanban %) updated every iteration, so the loop can resume after a restart and roll back a bad step. Never keep loop state only in context — a compaction or crash loses it.
6. **Briefing (CLAUDE.md / skills)** — the frozen instructions read at the start of every iteration (stack, rules, preferences). Keep it short; every line costs tokens on every turn.

Canonical shape:
```
TRIGGER  -> every 15min / on PR comment / on CI fail / self-paced wake
EXECUTE  -> agent reads state, does the task, writes output
VERIFY   -> separate agent/gate grades output against the end-state
MEMORY   -> progress record updated each iteration (resumable + rollback)
STOP     -> success condition met  OR  failure condition  OR  cap (iters/$/deadline)
BRIEF    -> CLAUDE.md + named skills loaded on each start
```

## Writing the loop condition (the actual /loop prompt)
Three parts: **end state - scope - stop rule.**
`/loop [verifiable end-state or time], only touching [scope], stop after [X iterations / $ / deadline], use [named skills], verify each checkpoint with a [separate verifier], keep a memory file of all work.`

Example: `/loop until all auth tests pass and coverage > 80%, only touching the auth module, stop after 10 iterations, verify each round with an independent QA pass, log progress to a memory file.`

Contrast the instruction vs the loop:
- Prompt: "Fix the failing tests in the auth module."
- Loop: "Keep working until all auth tests pass AND coverage > 80%, capped at 10 iterations, QA-verified each round."

## Compose with the rest of the system
This skill is the *wrapper*; it does not replace the others, it sequences them.

- **karpathycoder** is the per-iteration discipline. Its principle 4 (Goal-Driven Execution: "define verifiable success criteria, then loop until met") IS the loop's stop rule. Run the Karpathy 4-principle pass *inside* each Execution step so every iteration stays minimal, surgical, assumption-checked. Loop-engineering decides *when to stop*; Karpathy decides *how each turn is done*.
- **project-workflow gates** are the Verifier. For fleet/product work the stop condition is not "tests green" alone (green tests have hidden real bugs) — it is the independent gate sign-off (QA + risk-tiered security). The loop's `success` = gates PASS/GO, not the author's own claim.
- **Memory tiers + daily log** are the loop's Memory part. Progress -> hot tier / kanban %; lessons and the loop's own design -> cold. A resumable loop reads its progress record on each Trigger.
- **Scheduled tasks** are the Trigger for unattended loops (the orchestrator, stuck-monitor, quota monitors are already loops of this exact shape). New recurring work = a new scheduled-task, not a manual re-prompt.
- **Native tooling**: Claude Code `/loop` (interval or self-paced), `ScheduleWakeup` (dynamic self-pacing), and Workflow `budget` (hard token ceiling + loop-until-budget) are the concrete primitives. Subagents each get a fresh context window — use them for the Verifier so it is genuinely independent.

## Pro tips
- Start with the **stop rule** (`/goal`) before writing the loop — if you can't state a verifiable end-state, you have a prompt, not a loop.
- **Match effort**: high reasoning by default, xHigh/Max for hard verify/judge checkpoints; low for cheap mechanical iterations.
- **Always cap** iterations AND budget AND (for time-bound work) a deadline. Three independent brakes.
- **Compact early** before long sessions; a loop that runs for hours will hit context limits mid-iteration otherwise.
- **Not just code**: writing, research, audits, migrations all loop well (find -> verify -> until-dry).
- Spend the saved time on the **deliverable and the verifier**, not on babysitting iterations.

## Pitfalls
- **Success-only stop rule** = runaway loop. Every loop needs a failure condition and a hard cap too.
- **Author grades own work** = false "done". The Verifier must be independent (separate agent / gate). A green test suite is evidence, not proof.
- **Loop state only in context** = lost on compaction/restart. Always persist progress to memory/kanban so the loop is resumable.
- **Polling when you could be event-driven** = wasted budget. Re-fire on the real signal; if polling, size the interval to the watched state's real change rate.
- **Briefing bloat** = every extra CLAUDE.md/skill line is paid on every iteration. Keep the frozen instructions lean.
- **No budget** = surprise cost. State $/token cap up front; guard loops on `budget.remaining()` where the primitive supports it.

## Verification
- Before running: the loop has all 6 parts named, and an explicit `success / failure / cap` triple.
- During: the progress record moves every iteration; if it stalls past the stuck threshold, the loop is wedged — re-dispatch or fail it.
- After: the Verifier (independent) confirms the end-state; the memory record and (for product work) the gate sign-off are the proof, not the producing agent's say-so.
