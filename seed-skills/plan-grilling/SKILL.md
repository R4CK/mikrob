---
name: plan-grilling
description: Relentlessly interrogate a plan, design, or decision BEFORE committing to it — surface every unresolved branch, hidden assumption, failure mode, and "what happens when X" until the plan holds up or the gaps are explicit. Use before dispatching non-trivial work, before an architecture/design decision, before a risky change, or whenever a plan "sounds fine" but hasn't been stress-tested. Triggers: "grill this plan", "poke holes in this", "is this plan solid", "stress-test the design", "before we build this", "grilling", "kérdezz ki", "élesítsd a tervet", "hol bukik ez".
---

# Plan grilling

Adapted from the community `grilling` skill (mattpocock/skills, MIT). Project-agnostic.
The point: a plan that survives hard questioning is worth building; one that
doesn't just failed cheaply, on paper, instead of expensively, in code.

## When to use
- BEFORE dispatching a non-trivial task or committing to a design/architecture decision.
- When a plan "sounds reasonable" but nobody has walked its failure paths.
- Before a risky, hard-to-reverse, or outward-facing change.
- When choosing between options and the trade-offs are hand-wavy.
- NOT for trivial, well-understood, easily-reversible work — grilling has a cost; spend it where a wrong plan is expensive.

## Procedure
Interrogate the plan across these axes. Do NOT accept the first answer — for each
"it'll be fine", ask "how do you KNOW, and what happens if it isn't?". Keep going
until every branch is either resolved or explicitly logged as an accepted risk.

1. **Goal & success**: What EXACTLY are we trying to achieve? How will we know it worked (concrete, observable)? What does "done" mean, measurably?
2. **Assumptions**: List every assumption the plan rests on. For each: is it verified or believed? What breaks if it's false? Which is the load-bearing one?
3. **Unhappy paths**: For each step, "what happens when it fails / is empty / is huge / is concurrent / is malicious / times out / is offline?" A plan that only covers the happy path is not a plan.
4. **Boundaries & scope**: What's explicitly in vs out? Where does this touch other systems / other people's work (shared files, shared state, trust boundaries)? Who else is affected?
5. **Reversibility & blast radius**: If this is wrong, how do we find out, and how do we undo it? What's the worst case if it ships broken?
6. **Alternatives**: What's the simplest thing that could work? Why not that? What did we reject and why? Is the extra complexity earning its keep?
7. **Verification**: How do we PROVE it works (not "it looks right")? What's the test, the repro, the number? A green test alone is not proof — what does it actually exercise?
8. **The one question**: "What's the thing most likely to make this fail that we haven't talked about yet?" Ask it last, force an honest answer.

## Output
A short verdict: (a) the plan's load-bearing assumptions + which are verified,
(b) the unresolved branches / accepted risks, (c) GO / GO-WITH-CHANGES / RETHINK,
(d) the single most-likely failure and its mitigation. If it's GO-WITH-CHANGES,
list the exact changes. Don't soften — the value is in the hole you find.

## Pitfalls
- Don't grill trivial work — it wastes effort and reads as obstruction.
- Don't accept "should be fine" — convert every one into a concrete "when X, then Y".
- Don't grill forever — the goal is a decision, not paralysis. Two passes usually surface the real gap; log the residual risk and move.
- If the plan writes to or deletes from a table, check the ACTUAL runtime-role privileges (GRANT/REVOKE migrations) and FK `ON DELETE` rules for that table before approving — not just the schema shape. A plan can look sound at the code/schema level and still be blocked by a REVOKE the runtime role hit in an unrelated earlier migration, or by a `RESTRICT`/WORM constraint on a child table. Found live 2026-08-20 (CleanCore card 328c2fac): a GO-WITH-CHANGES verdict approved a DELETE-based reap that the runtime role (`cleancore_app`) had no privilege to perform (three separate REVOKE migrations), and would have hit a WORM-protected audit table besides. Caught only because the builder re-checked grants before writing code, not by the grilling itself. `grep -rn "REVOKE\|ON DELETE" <migrations-dir>` for every table the plan touches is now part of the checklist, not optional.

## Validation
The plan is grilled enough when you can state, in one line each: the goal-check,
the load-bearing assumption (and whether it's verified), the worst-case + undo,
and the single most-likely failure. If you can't, keep going.
