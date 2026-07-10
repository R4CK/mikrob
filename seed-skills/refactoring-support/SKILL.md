---
name: refactoring-support
description: Safely restructure code WITHOUT changing its observable behavior — establish a test/characterization safety net, find seams, apply small reversible steps, and verify behavior preservation after each. Use when improving structure, reducing complexity/duplication, extracting units, or untangling code that must keep working. Triggers on "refactor", "clean up", "restructure", "reduce complexity", "extract", "rendezd át", "tisztítsd meg", "ne változzon a viselkedés".
---
# Refactoring Support (behavior-preserving change)

## When to use
Any structural change whose #1 requirement is "behavior stays identical": extract
function/module, rename, deduplicate, split a big file, simplify conditionals, replace magic
numbers, introduce a seam. If you are *changing behavior*, that is a feature/bugfix, not a
refactor — do not hide it inside one. (For the design/mechanics catalogue, pair with the
`coderefactor` skill; this skill is the SAFETY discipline around it.)

## The prime directive
**Observable behavior before == observable behavior after.** Same outputs, same side effects,
same error behavior, same public API — for every input, including the edge cases. Everything
below exists to prove that.

## Procedure (small, reversible, verified)
1. **Understand first.** You cannot safely refactor what you don't model — run
   [[code-comprehension]] / [[function-explanation]] on the target. Name the contract and
   invariants you must preserve.
2. **Build the safety net BEFORE touching structure.**
   - If tests cover the behavior, run them green first (that's your baseline).
   - If not, write **characterization tests** that pin the CURRENT behavior (including quirks
     you don't like — capture reality, not the ideal). Cover the edges and error paths, not
     just the happy path. This net is what makes the refactor safe.
3. **Find the seam.** Identify where you can cut with the least coupling (a pure function to
   extract, a dependency to inject, a boundary to introduce). Prefer seams that isolate
   effects from logic.
4. **One small step at a time.** Apply a single named refactoring (extract, inline, rename,
   move, introduce parameter object...). Keep the diff minimal and mechanical. Avoid
   drive-by changes — a refactor commit contains ONLY structure changes.
5. **Verify after EVERY step.** Re-run the net (and typecheck/lint). Green -> commit that step.
   Red -> revert that step (don't debug forward on top of a broken refactor). Small steps make
   the revert cheap and the cause obvious.
6. **Repeat**, then do a final behavior check end-to-end (drive the real flow, not only unit
   tests) and a diff review for accidental semantic changes.

## Behavior-preservation checklist (the traps)
- **Evaluation order & short-circuiting** changed by reordering conditions.
- **Off-by-one / boundary** shifts when extracting loops or slices.
- **`null`/`undefined`/empty** handling dropped by "simplifying" a guard (the missing `else`).
- **Exception type/timing** changed — a caller may depend on *which* error, or on it throwing
  vs returning.
- **Mutation vs copy** — extracting a helper that now mutates (or stops mutating) a shared
  object; `readonly`/immutability assumptions.
- **Async ordering / concurrency** — awaits reordered, parallelism introduced, races opened.
- **Floating point / rounding / locale** — moving a computation can change precision or format.
- **Number/precision & derived values** — a re-expressed formula must give bit-identical results.

## Pitfalls
- **Refactor + behavior change in one commit** — impossible to review or bisect; separate them.
- **No safety net** — "it's obviously equivalent" is how regressions ship. Pin behavior first.
- **Big-bang rewrite** labeled as refactor — prefer the strangler/incremental path with the net.
- **Trusting green unit tests alone** — also exercise the real flow once at the end.

## Verification
- The safety net existed and stayed green through every step (baseline captured before step 1).
- The public API/contract and every invariant are unchanged; the diff is structure-only.
- End-to-end behavior re-checked once at the end; no error-type/timing/ordering drift.

Related: [[code-comprehension]], [[function-explanation]], and the `coderefactor` skill for the
refactoring catalogue.
