import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
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
    const src = stripComments(readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8'))
    expect(src).not.toMatch(/\bui\s*:\s*true\b/)
    expect(src).not.toMatch(/\bapi\s*:\s*(true|\d|\{)/)
  })

  it('the `test` script is a one-shot `vitest run`, not watch mode (which the UI flag pairs with)', () => {
    expect(pkg.scripts.test).toBe('vitest run')
  })
})
