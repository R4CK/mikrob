---
name: code-comprehension
description: Build an accurate, evidence-based mental model of unfamiliar code at the deepest level — control flow, data flow, invariants, state, side effects, dependencies, and the "why". Use BEFORE changing, reviewing, debugging, or explaining any non-trivial code you did not just write. Triggers on "understand this code", "how does this work", "trace this", "what does this module do", "map the data flow", "értsd meg a kódot", "hogyan működik".
---
# Code Comprehension (deep understanding)

## When to use
Before ANY change/review/debug of code you don't fully own in your head, and whenever a
question needs a precise answer about existing behavior. Never answer "how does X work"
from a filename or a guess — read the code and cite it (`path:line`).

## The method: read for a model, not for lines
Build these five layers, in order. Each answer must be backed by a specific `path:line`.

1. **Boundary & purpose** — What is this unit's public surface (exports, routes, CLI, events)
   and its single responsibility? Who calls in, what does it call out to? Read the entry
   points and the `index`/barrel first, then the types/interfaces — the type signatures are
   the contract and usually the fastest route to the model.
2. **Control flow** — Trace the real execution paths, including the unhappy ones: early
   returns, guards, error branches, retries, loops, async/await ordering, event handlers.
   For each branch ask "what triggers this?" Note terminal states and where control leaves.
3. **Data flow** — Follow the important values from source (input/DB/network) to sink
   (output/DB/render). Where is each value validated, transformed, derived, persisted? A
   value that is *derived* server-side vs *trusted from the caller* is the single most
   security-relevant distinction — mark it.
4. **State & invariants** — What state exists (fields, module vars, DB rows, caches) and
   what must always be true about it (the invariants)? Tenant-scope, uniqueness, monotonic
   counters, "null means closed", ordering. Find where each invariant is enforced — and
   look for the path that *doesn't* enforce it.
5. **Dependencies & seams** — What does it depend on (DB, crypto, network, clock, other
   modules) and how are those injected/mocked? The seams tell you what's pure vs effectful
   and where behavior can be substituted.

## Procedure
1. `git ls-files` / glob the area; read the barrel/index + type definitions first.
2. Grep for the entry symbols and follow call edges out (callees) and in (callers:
   `git grep -n <symbol>`). Breadth first, then depth on the hot path.
3. Write the model down as you go (a short outline: purpose, key types, control paths,
   invariants, deps). If you can't write one sentence per layer, you don't understand it yet.
4. Confirm the model against reality: run the smallest test that exercises the path, or read
   the existing test's assertions — tests encode the intended contract (but a green test can
   still hide a MAJOR; treat tests as intent, not proof).

## Pitfalls
- **Guessing from names.** `validateUser` may not validate; read the body.
- **Skipping the unhappy paths.** The bug and the security hole live in the branch you didn't
  trace — the missing `else`, the un-awaited promise, the error swallowed by a bare catch.
- **Trusting comments/docs over code.** They drift. The code is ground truth; if a comment
  contradicts it, note the discrepancy, don't repeat the comment.
- **Confusing "derived" with "trusted".** If a value that gates a decision comes from the
  request body rather than being recomputed/looked-up server-side, that's a finding, not a detail.
- **Stopping at one layer.** A control-flow map without the data-flow/invariant layers misses
  why the code is shaped the way it is.

## Verification (did you actually understand it?)
- You can state the unit's responsibility in one sentence and name its invariants.
- You can name every external effect (DB/network/crypto/clock/fs) and where it's injected.
- You can point to the exact line that enforces each invariant — and say what happens on the
  path that bypasses it.
- Your model predicts the output of a concrete input; verify by running it.

Related: [[function-explanation]] (zoom into one function), [[refactoring-support]] (change it
safely once understood), [[defensive-security-analysis]] (the security lens on the same code).
