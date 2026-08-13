---
name: async-refactor-fail-open-guard
description: Convert a synchronous audit/authz/persistence path to async (adding a DB/IO adapter behind an existing sync port) WITHOUT opening a silent fail-open hole. Use when an authz check, audit-log write, or durable persistence becomes Promise-returning. Covers the floating-promise fail-open class (tsc does not catch it), durable-before-ack, a zero-dep no-floating-promises linter with a self-test, sync-sibling decoupling, and AST-codemod test migration.
---

# Async refactor without a fail-open hole

## When to use
- You are making a **synchronous effectful path async**: an audit-log append, an
  authorization check, or a persistence method gains a real DB/IO/network adapter
  behind an already-existing synchronous port, so its interface changes to return
  `Promise`.
- Triggers: "make the store async", "wire the DB adapter behind the port",
  "durable-before-ack", an authz/audit method that now returns a Promise, a
  sync→async seam change that ripples through many callers + tests.
- NOT for: a brand-new async module written async from day one (no floating-callers
  to fix), or a pure in-memory refactor with no effectful port.

## The core hazard (why this skill exists)
When `authorize(...)` / `audit(...)` / `persist(...)` becomes async, every caller that
used it as a **statement** now FLOATS a promise:

```ts
authorizeSuperadmin(actor, action)   // was sync: threw on denial, blocked execution
// -> now async: the denial REJECTION escapes unhandled, execution CONTINUES == fail-open
```

`tsc` does **not** flag a floating promise. A single missed `await` on an async authz
call is a **silent auth bypass**; a floating async audit/persist is a **lost record**.
This class is invisible to the type-checker and routinely survives a green test suite.

## Procedure

### 1. Propagate async transitively (source first)
- Change the port interface methods to return `Promise`. Then, driven by the
  type-checker, `await` every call site and mark each enclosing function `async`,
  recursively up the call graph, to a fixpoint.
- **Do NOT over-convert a PURE function** (arrays-in, value-out, no IO) to async just
  because it sits near the seam. Keep pure verification/derivation functions
  synchronous — they take the already-awaited values as arguments.

### 2. Durable-before-ack (the non-negotiable ordering)
- The caller must **not** observe a record as committed before it is durably
  persisted. `await` the durable write BEFORE returning / acking:
  ```ts
  await watermark.advance(next)      // stage
  await store.appendState(entry)     // durable commit -- only now is it acked
  ```
- Grep the whole subsystem for a bare `audit(` / `persist(` / `advance(` **statement**
  (no `await`, no `void`, no `.catch`) — each is a durability/fail-open bug.

### 3. A no-floating-promises guard is MANDATORY (not optional)
Because tsc misses this class, add a lint that does not:
- If `eslint` + `typescript-eslint` (`no-floating-promises`) already exist, enable the
  rule for the audit/authz source and move on.
- If ESLint is NOT in the repo and adding it would write a **shared lockfile** (common
  in a multi-agent / monorepo checkout), do NOT add it. `typescript` is almost always
  already a dependency and is the exact engine that rule runs on — implement a small
  **zero-dep TS-Compiler-API linter** instead (see `references/no-floating-linter.md`).
  It builds the program, and for every `ExpressionStatement` whose value type is
  thenable and is not `await`/`void`/`.catch`/`.finally`-handled, reports a finding.
- **Prove it bites (self-test):** ship a fixture with a *deliberately floating* authz
  call AND a correctly-awaited twin; the linter must flag exactly the floating one.
  Bake the self-test into the linter's own CLI so `lint:floating` fails loudly if the
  linter ever stops detecting the bug. This is the "prove a floating authz → FAIL"
  evidence a reviewer will ask for.
- **Run it as a standalone CI gate, NOT inside the parallel test suite.** A full
  TS-program build spawned inside a parallel test worker starves the runner's
  worker-RPC and flakes (a 5s infra timeout unrelated to your test timeout). Keep only
  a fast fixture-level unit assertion in the suite, if any; enforce the whole-source
  scan from a separate `lint` script.

### 4. Decouple a synchronous sibling — don't cascade async everywhere
If a **sibling** path shares the port TYPE but is synchronous **by design** (e.g. a
login-audit trail that records fail-closed FIRST, then delivers best-effort alerts, all
in one synchronous call), do NOT force async through its whole flow just because the
platform path went async. Give the sibling its **own synchronous port**
(`SyncXStore` with the same contract, sync `get`/`advance`) and a sync in-memory
factory. This keeps the fail-closed synchronous contract intact and contains the blast
radius. Threading async through an entire login/handler flow is a much larger, riskier
change than a one-interface decoupling.

### 5. Migrate the tests with an AST codemod, NOT regex
A large sync→async change breaks hundreds of test call-sites (await the now-async calls,
`expect(() => p).toThrow` → `await expect(p).rejects.toThrow`, mark `it`-callbacks
async). **Regex migration corrupts tamper-evident / audit tests** (optional chaining,
multiline `expect`, index access after an async call, helper-async propagation) — real
risk of a silently-wrong audit test. Write a TS-Compiler-API codemod that is
type-checker driven and iterates to a fixpoint (see `references/async-test-codemod.md`).
Scope it with a filename regex; skip `expect(promise).rejects` args so you don't
double-await. A test file the root tsconfig EXCLUDES won't be in the program — point the
codemod at the tsconfig that INCLUDES tests.

### 6. Durability tests (the DoD proof)
Add tests that make the durable write misbehave and assert the ack never happens:
- durable write **throws** → the op REJECTS and the record is NOT in the chain / not
  acked (chain empty, anchor/watermark absent).
- durable write **delays** (gate it behind a manually-released promise) → the op does
  not resolve, and the record is not observable, until the durable write completes.

## Pitfalls
- **Two dependency versions in the tree** (e.g. your top-level `ioredis` vs a library's
  own nested copy) produce a **structural type-skew** on a shared interface even though
  they are wire-compatible at runtime. Proper fix: dedupe to one version in the lock
  (often the operator's job on a shared lock). Stopgap: a narrow `as unknown as T` cast
  at the single seam with a `FIXME(lock-dedupe)` comment — never a blanket `any`.
- **`async function f(): Promise<Awaited<T>> { return withX(...) }`** where `withX`
  returns `T`: tsc rejects `T` as not assignable to `Awaited<T>`. Use `return await
  withX(...)` so the value is unwrapped to `Awaited<T>`.
- **A generic gate that wraps sync throws**: make the wrapper `async` so a synchronous
  `throw` (bad session / step-up) becomes a **rejection**, giving `.rejects` a single
  uniform error channel across every endpoint.
- **A `.cjs` linter imported by a `.ts` test** needs a sibling `.d.cts` declaration or
  tsc errors TS7016 (implicit any).

## Verification checklist
- [ ] Root + per-project `tsc --noEmit` clean (including the tsconfig that covers tests).
- [ ] Full affected suite green; new durability tests included and able to fail.
- [ ] no-floating-promises linter exits 0 over the audit/authz source AND its self-test
      proves it flags a deliberately floating authz (non-zero on the fixture).
- [ ] Grep shows zero bare async authz/audit/persist STATEMENTS (all awaited/void/caught).
- [ ] Durable-before-ack: the ack path awaits the durable write; a throwing/slow write
      never yields an observable record.
- [ ] Synchronous fail-closed siblings kept sync via their own sync port (no needless
      async cascade).
- [ ] Prettier clean; commit only your own files by explicit pathspec (shared checkout).
- [ ] Card → `waiting` + REVIEW; QA + Cybersec gate (never self-sign-off).
