import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

// Card 2f05b3e3, step 0 (MikroB comment 13602, WhiteHat L1 on 54f3f2cd gate, msg 9815): the
// 54f3f2cd DECISIONS.md exception for 6 vitest/vite advisories (tinypool prototype-pollution,
// vitest UI-server arbitrary-file CVSS 9.8, vite path-traversal/CORS-missing dev-server holes)
// rests on two unreachability facts that nothing currently enforces:
//   (1) no npm script invokes `vitest --ui` / `vitest --api` (the UI/API HTTP server is what
//       makes GHSA-5xrq-8626-4rwp exploitable -- `vitest run` alone never opens it);
//   (2) no vite dev server exists (no vite.config.ts/js at the repo root, no script runs the
//       vite CLI directly) -- vite is only vitest's transform engine here, never a listening
//       dev server, which is the precondition for the vite/esbuild path-traversal and
//       missing-CORS advisories.
// A future script addition (e.g. a debugging convenience `"ui": "vitest --ui"`) would silently
// reopen a CVSS 9.8 hole with no advisory-exception review. This guard fails loudly if either
// fact stops being true, BEFORE the vitest major bump (this card's main step) is attempted.

// AST-based, not scanner-based (RedHat I1b, card c4ef7da5, d4675258 comment 14181 follow-up):
// the prior fix (ts.createScanner, a bare lexer) tokenizes string/template literals as single
// tokens, which closed the founding exploit, but a bare scanner does not know, on its own, where
// a regex literal or a template-literal tail begins -- without an explicit `reScanSlashToken`/
// `reScanTemplateToken` call at each `/` or post-`${...}` `}`, it falls back to treating `/` as a
// division operator and the template tail as ordinary code. A `/*`-shaped sequence sitting inside
// a regex literal, or in the template text right after a `${...}` substitution, was therefore
// still read as a real comment and could swallow a genuine `ui: true` written later in the file
// (measured: 9 of 24 corpus shapes still hid a live `ui: true` after the scanner fix, down from
// 12 before it -- a real improvement, but not closed). A full parse (`ts.createSourceFile`)
// disambiguates regex and template literals the same way the TypeScript compiler itself does, so
// it is not subject to this class of gap. This function no longer strips comments and re-matches
// text at all; it walks the real AST and looks only at actual property-assignment nodes, so a
// comment-shaped sequence anywhere in a string/regex/template literal is never treated as trivia
// in the first place, regardless of what precedes it in the file. This closes the `ui`/`api`
// comment-evasion class; it does not, and is not meant to, defend against a value `ui`/`api`
// property that uses a non-literal expression (`!0`, a referenced const, a spread object) -- RedHat's
// own finding treats that as a separate, non-comment question out of this card's scope.
function findLiveServerFlags(src: string): string[] {
  const sourceFile = ts.createSourceFile('vitest.config.ts', src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const hits: string[] = []
  const propertyKeyText = (name: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text
    return undefined
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyKeyText(node.name)
      if (key === 'ui' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        hits.push('ui: true')
      }
      if (key === 'api' && node.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
        hits.push('api: set')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return hits
}

const repoRoot = join(process.cwd())
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('no vitest --ui/--api server, no vite dev server (card 2f05b3e3 step 0)', () => {
  it('no package.json script invokes `vitest --ui` or `vitest --api`', () => {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, `script "${name}": ${cmd}`).not.toMatch(/\bvitest\b[^&|;]*\B--ui\b/)
      expect(cmd, `script "${name}": ${cmd}`).not.toMatch(/\bvitest\b[^&|;]*\B--api\b/)
    }
  })

  it('no package.json script runs the vite CLI directly (dev server or `vite serve`)', () => {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      // Word-boundary on "vite" so "vitest" and "vite-node" do not false-positive.
      expect(cmd, `script "${name}": ${cmd}`).not.toMatch(/(^|[\s&|;])vite(\s|$)/)
    }
  })

  it('no vite.config.ts/js exists at the repo root (no dev-server config to start one from)', () => {
    expect(existsSync(join(repoRoot, 'vite.config.ts'))).toBe(false)
    expect(existsSync(join(repoRoot, 'vite.config.js'))).toBe(false)
    expect(existsSync(join(repoRoot, 'vite.config.mts'))).toBe(false)
  })

  it('vitest.config.ts does not enable the UI/API server (`ui: true` or `api:` set)', () => {
    const src = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8')
    expect(findLiveServerFlags(src)).toEqual([])
  })

  it('the `test` script is a one-shot `vitest run`, not watch mode (which the UI flag pairs with)', () => {
    expect(pkg.scripts.test).toBe('vitest run')
  })

  it('findLiveServerFlags does not let a comment-shaped sequence hide a real `ui: true` (I1/I1b regression corpus)', () => {
    const founding = `export default defineConfig({\n  test: {\n    comment: "/* not closed",\n    ui: true,\n  }\n})\n/* real trailing comment */\n`
    const nestedTemplate = 'export default defineConfig({ test: { tag: `${`${x}`}//`, ui: true } })\n/* trailing */\n'
    const lineSeparator = 'export default defineConfig({ test: { tag: "// still code", ui: true } })\n'
    // RedHat I1b (card c4ef7da5, d4675258 comment 14181): a bare scanner does not know it is
    // inside a regex literal or a post-`${...}` template tail without an explicit re-scan call,
    // so a `/*`/`//`-shaped sequence there was still read as a real comment and could hide a
    // live `ui: true` written later in the file.
    const regexLiteralThenRealComment = 'export default defineConfig({ test: { tag: /[/*]/, ui: true } })\n/* real */\n'
    const regexLiteralSameLine = 'export default defineConfig({ test: { tag: /a\\/\\//, ui: true } })\n'
    const templateTailThenRealComment = 'export default defineConfig({ test: { tag: `${1}/*`, ui: true } })\n/* real */\n'
    const templateTailSameLine = 'export default defineConfig({ test: { tag: `${1}//`, ui: true } })\n'

    for (const src of [
      founding,
      nestedTemplate,
      lineSeparator,
      regexLiteralThenRealComment,
      regexLiteralSameLine,
      templateTailThenRealComment,
      templateTailSameLine,
    ]) {
      expect(findLiveServerFlags(src), src).toContain('ui: true')
    }
  })

  it('findLiveServerFlags does not false-positive on `ui`/`api` spelled inside comments or strings, or `api: false`', () => {
    const onlyInComment = 'export default defineConfig({ test: { /* ui: true */ reporters: [] } })\n'
    const onlyInString = 'export default defineConfig({ test: { tag: "ui: true, api: 1" } })\n'
    const apiExplicitlyOff = 'export default defineConfig({ test: { api: false } })\n'
    for (const src of [onlyInComment, onlyInString, apiExplicitlyOff]) {
      expect(findLiveServerFlags(src), src).toEqual([])
    }
  })
})
