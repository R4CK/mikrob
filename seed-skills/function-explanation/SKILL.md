---
name: function-explanation
description: Explain a single function/method at the deepest level — its exact contract (inputs, outputs, preconditions, postconditions), every side effect, all edge cases and failure modes, complexity, and its place in the call graph. Use when asked what a function does, whether it's correct, or before relying on/modifying it. Triggers on "explain this function", "what does this do", "is this correct", "mit csinál ez a függvény", "magyarázd el".
---
# Function Explanation (deep, contract-level)

## When to use
When a specific function must be understood precisely: to call it correctly, to change it
safely, to review it, or to answer "what does this do / is this right". Explain from the
CODE, not the name or docstring.

## Produce this, every time
1. **One-line intent** — what it is *for*, in caller's terms.
2. **Signature & contract:**
   - **Inputs** — each parameter: type, meaning, allowed range, who supplies it (trusted
     caller vs untrusted input). Note defaults and optionality.
   - **Preconditions** — what must hold on entry (non-null, sorted, authenticated, tenant
     matches). Are they checked or assumed? An assumed precondition is a latent bug/exploit.
   - **Output** — return type/shape and what each variant means; sentinel/`null`/`throw`
     semantics.
   - **Postconditions & invariants** — what is guaranteed true after (and what state changed).
3. **Side effects** — EVERYTHING beyond the return value: DB writes, network/IO, filesystem,
   mutation of arguments or shared state, logging, clock/random reads, thrown errors. "Pure"
   is a claim you must verify, not assume.
4. **Edge cases & failure modes** — empty/zero/negative, boundary values, unicode/control
   chars, huge input, concurrency/re-entrancy, partial failure, exceptions from callees. For
   each: what actually happens? Fail-closed or fail-open?
5. **Complexity** — time/space in Big-O on the real hot path; note N+1, nested scans, or
   unbounded growth.
6. **Call graph** — key callees (what it delegates to) and notable callers (`git grep`), so
   the blast radius of a change is visible.

## Procedure
1. Read the whole body once for shape; then line-by-line for the contract.
2. Resolve every callee enough to know its effects and failure modes (a function is only as
   pure/safe as what it calls).
3. Trace each parameter to where it's used; trace the return to where callers consume it.
4. Enumerate branches; for each, state the concrete condition and outcome. The branch you're
   tempted to skip is the one that matters.
5. Validate with a concrete example: pick inputs, predict output+effects, then run/read a
   test to confirm.

## Pitfalls
- **Describing the happy path only.** The contract is defined by its edges and failures.
- **Trusting the name/docstring.** `getX` may write; `isValid` may have a bypass. Verify.
- **Missing hidden effects** — mutated argument objects, module-level state, lazy caches,
  thrown errors as control flow.
- **Ignoring the actor/authorization source** — if the function makes an authz/ownership
  decision from a caller-supplied id instead of the session/context, say so loudly (classic
  SoD/self-approval bypass).
- **Hand-waving complexity** — "fast enough" is not an analysis; give the Big-O and the input
  that makes it bite.

## Verification
- Every parameter and every return variant is accounted for.
- Every side effect is named; "pure" was checked against the callees, not assumed.
- Each branch has a stated condition and outcome, including the error branches.
- A concrete input/output/effect example is given and matches a run or a test assertion.

Related: [[code-comprehension]] (the module around it), [[refactoring-support]] (change it
without breaking the contract), [[defensive-security-analysis]] (attack the contract).
