# Zero-dep no-floating-promises linter (TS Compiler API)

Use when `typescript` is already a dependency but ESLint/`typescript-eslint` is not, and
adding it would write a shared lockfile. This runs the same type-checker analysis the
ESLint rule uses. Plain CJS so it runs as a `node` CI gate.

## Core predicate
For every `ExpressionStatement`, report it if its value type is thenable and it is not
explicitly handled:

```js
const ts = require('typescript')

function isThenable(type) {
  if (!type) return false
  if (type.getProperty && type.getProperty('then')) return true
  return !!(type.isUnion && type.isUnion() && type.types.some(isThenable))
}

function floatingReason(stmt, checker) {
  if (!ts.isExpressionStatement(stmt)) return null
  const expr = stmt.expression
  if (ts.isAwaitExpression(expr) || ts.isVoidExpression(expr)) return null   // awaited / discarded
  if (                                                                        // .catch()/.finally() attach a handler
    ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) &&
    (expr.expression.name.text === 'catch' || expr.expression.name.text === 'finally')
  ) return null
  if (ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) return null       // `x = p` captures it
  if (isThenable(checker.getTypeAtLocation(expr)))
    return 'unhandled promise (missing await / void / .catch)'
  return null
}
```

## Scope + program build
- `IN_SCOPE(rel)`: restrict to your audit/authz source globs; EXCLUDE `*.test.ts`,
  `*.fixture.ts`, `__fixtures__`, `*.d.ts` (tests legitimately hand promises to
  `expect(p).rejects`; fixtures deliberately float).
- `analyzeProject(tsconfigPath)`: `ts.parseJsonConfigFileContent` → `ts.createProgram`
  → walk each in-scope SourceFile with `ts.forEachChild`, collect findings.
- `analyzeFiles(fileNames, opts)`: build a program from explicit files (used by the
  self-test fixture). Default compiler opts: `{ target: ES2022, module: NodeNext,
  moduleResolution: NodeNext, strict: true, noEmit: true, skipLibCheck: true }`.

## Self-test (prove it bites)
Ship `__fixtures__/floating-authz.fixture.ts`:
```ts
async function authorize(actorId) { if (actorId !== 'owner') throw new Error('forbidden') }
async function mutate(actorId, v) {
  authorize(actorId)          // FLOATING -- linter MUST flag this line
  return v
}
export async function mutateSafe(actorId, v) { await authorize(actorId); return v }  // must NOT flag
```
In the CLI `require.main` block, run the self-test FIRST: `analyzeFiles([fixture])` must
return exactly 1 finding (the floating call, not the awaited twin); if not, `exit(2)`
("linter broken"). Then scan the real source; any finding → print + `exit(1)`. Wire as
`"lint:floating": "node scripts/lint-no-floating-promises.cjs"`.

## Gotchas
- A `.cjs` linter imported by a `.ts` test needs a sibling `.d.cts` with typed exports
  (`analyzeFiles`, `analyzeProject`) or tsc errors TS7016.
- Do NOT run the full-project scan inside a parallel test worker — it starves the
  runner's worker-RPC and flakes at ~5s regardless of your test timeout. Keep the whole
  scan in the standalone CLI gate; at most run the fast fixture-level assertion in-suite.
- The linter finds the real bugs: in practice it caught a floating `watermark.advance`
  and a floating `audit()` that manual review had missed.
