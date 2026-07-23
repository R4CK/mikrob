# AST codemod: migrate tests after a sync→async change (TS Compiler API)

Regex migration corrupts tamper-evident/audit tests. Use a type-checker-driven codemod
that iterates to a fixpoint. Plain CJS: `node scripts/async-audit-codemod.cjs <tsconfig>`.

## Why not regex
Edge cases regex botches, each a real corruption of a security test:
- optional chaining: `await FN()?.x` must become `(await FN())?.x`
- multiline `expect(\n () => FN(),\n).toThrow` → `.rejects`
- index/member access after an async call: `X.getChain()[0]` → `(await X.getChain())[0]`
- helper-async propagation: a `const build = () => {..await..}` helper + all its callers
Miss one and a tamper-evident assertion silently stops testing what it claims.

## Program + scope
- Build from the tsconfig that **INCLUDES tests** (a root tsconfig that excludes
  `**/*.test.ts` yields 0 edits — the files aren't in the program). Pass it as argv.
- `TARGET` = a filename regex for just the affected test files.

## Three passes, then apply end-to-start, iterate to fixpoint
1. **toThrow → rejects:** find `expect(() => EXPR).toThrow(args)` where `EXPR` is
   thenable → `await expect(EXPR).rejects.toThrow(args)`. Mark the enclosing fn async.
   Remember the converted arrow so pass 2 skips awaiting inside it.
2. **await thenable calls:** for each `CallExpression` whose type `isThenable`, not
   already awaited, not inside a converted throw-arrow, and **not the arg of
   `expect(...).rejects/.resolves`** (skip — else double-await): insert `await`. If the
   call is the object of a `.prop` / `[i]` / call / `!`, wrap as `(await CALL)`. Mark the
   enclosing fn async.
3. **mark fns async:** for every function collected in 1–2 that isn't already async,
   insert `async ` at its start (arrow/expr/decl/method).

Apply edits sorted by start DESC; skip any edit that overlaps a later-applied one
(drops nested edits safely). Re-run the whole thing until an iteration makes 0 edits.

## Helper predicates
- `isThenable(type)` — same as the linter (checks `.then`, unions).
- `enclosingFn(node)` — walk parents to the first function/arrow/method.
- `isExpectRejectsArg(node)` — node is the arg of `expect(node)` whose parent is
  `.rejects`/`.resolves` → skip (the promise is handed to expect intentionally).

## Gotchas
- After the source refactor, also fix the SOURCE floats the codemod can't (it only
  touches tests): run the no-floating linter on source (see `no-floating-linter.md`).
- Some test files live in a package whose tsconfig excludes tests entirely and can't be
  reached by any codemod program — migrate those few by hand (small, and hand-migration
  of a security test is auditable).
- A non-null-index like `client.added[0].x` under `noUncheckedIndexedAccess` needs a `!`
  (`client.added[0]!.x`) — assert length the line before, then non-null.
