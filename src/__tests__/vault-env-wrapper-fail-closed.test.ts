// Card 42fadae5: vault-env-wrapper.sh used to `exec` the wrapped command no matter what came
// back from vault-resolve.mjs. vault-resolve.mjs silently drops any secret_id it can't find
// (`if (value !== null) { write }`, no stderr, no exit code change) -- so if a vault: reference
// stayed unresolved, the env var kept the LITERAL "vault:<id>" string, and the wrapped server
// still started and sent that literal out as a credential. Not a value leak (the placeholder
// isn't a secret), but a fail-open: a broken vault reference goes to the network instead of
// stopping the process.
//
// This exercises the REAL scripts/vault-env-wrapper.sh end to end (spawnSync, not a text
// match), against a fixture vault-resolve.mjs that mirrors vault-resolve.mjs's own silent-drop
// contract with fixture data -- no real vault DB needed. The control case is the point: the same
// harness run against the ORIGINAL (pre-fix) wrapper source must show the vulnerability actually
// firing (exit 0, wrapped command reached, literal placeholder in its env) before it shows the
// fix blocking it.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WRAPPER = join(ROOT, 'scripts', 'vault-env-wrapper.sh')

// The wrapper's own source before card 42fadae5 -- unconditional `exec "$@"` after the resolve
// loop, no check that every requested name actually came back resolved.
const PRE_FIX_WRAPPER = `#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "vault-env-wrapper: node not found" >&2
  exit 1
fi

REFS=""
for var in $(env | grep '=vault:' | cut -d= -f1); do
  val="\${!var}"
  secret_id="\${val#vault:}"
  REFS="\${REFS}\${var}=\${secret_id}"$'\\n'
done

if [ -n "$REFS" ]; then
  RESOLVED=$(printf '%s' "$REFS" | "$NODE" "$PROJECT_ROOT/scripts/vault-resolve.mjs")
  while IFS='=' read -r key value; do
    [ -n "$key" ] && export "$key"="$value"
  done <<< "$RESOLVED"
fi

exec "$@"
`

// Fixture resolver: mirrors the real vault-resolve.mjs's own contract (read "VAR=id" lines,
// write "VAR=value" only for a KNOWN id, silently drop unknown ones) against fixture data
// instead of a real vault DB.
const FIXTURE_RESOLVER = `#!/usr/bin/env node
const KNOWN = { 'known-id': 'resolved-value-abc' }
let data = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', c => { data += c })
process.stdin.on('end', () => {
  for (const line of data.trim().split('\\n')) {
    if (!line.trim()) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const envVar = line.slice(0, eq)
    const secretId = line.slice(eq + 1)
    const value = Object.prototype.hasOwnProperty.call(KNOWN, secretId) ? KNOWN[secretId] : null
    if (value !== null) process.stdout.write(envVar + '=' + value + '\\n')
  }
})
`

function sandbox(wrapperSource: string): { dir: string; wrapper: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vault-wrapper-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const wrapper = join(dir, 'scripts', 'vault-env-wrapper.sh')
  writeFileSync(wrapper, wrapperSource)
  chmodSync(wrapper, 0o755)
  writeFileSync(join(dir, 'scripts', 'vault-resolve.mjs'), FIXTURE_RESOLVER)
  return { dir, wrapper }
}

function run(wrapper: string, extraEnv: Record<string, string>) {
  return spawnSync(
    'bash',
    [wrapper, 'bash', '-c', 'echo WRAPPED_COMMAND_RAN; echo "FOO_TOKEN=$FOO_TOKEN"; echo "BAR_TOKEN=$BAR_TOKEN"'],
    {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extraEnv },
    },
  )
}

describe('vault-env-wrapper.sh is syntactically valid', () => {
  it('bash -n passes', () => {
    const r = spawnSync('bash', ['-n', WRAPPER], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
  })
})

describe('vault-env-wrapper.sh fails closed on an unresolved vault: reference (card 42fadae5)', () => {
  it('a single resolved reference: wrapped command runs, gets the real value', () => {
    const { wrapper } = sandbox(readFileSync(WRAPPER, 'utf-8'))
    const r = run(wrapper, { FOO_TOKEN: 'vault:known-id' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('WRAPPED_COMMAND_RAN')
    expect(r.stdout).toContain('FOO_TOKEN=resolved-value-abc')
  })

  it('a single UNRESOLVED reference: refuses to start, names the var + secret id, no value leaked', () => {
    const { wrapper } = sandbox(readFileSync(WRAPPER, 'utf-8'))
    const r = run(wrapper, { BAR_TOKEN: 'vault:missing-id' })
    expect(r.status).not.toBe(0)
    expect(r.stdout).not.toContain('WRAPPED_COMMAND_RAN')
    expect(r.stderr).toContain('BAR_TOKEN')
    expect(r.stderr).toContain('missing-id')
  })

  it('MIXED: one resolved + one unresolved still refuses to start (the fail-open case)', () => {
    const { wrapper } = sandbox(readFileSync(WRAPPER, 'utf-8'))
    const r = run(wrapper, { FOO_TOKEN: 'vault:known-id', BAR_TOKEN: 'vault:missing-id' })
    expect(r.status).not.toBe(0)
    expect(r.stdout).not.toContain('WRAPPED_COMMAND_RAN')
    expect(r.stderr).toContain('BAR_TOKEN')
  })

  it('CONTROL: the pre-fix wrapper source actually exhibits the bug this test guards against', () => {
    const { wrapper } = sandbox(PRE_FIX_WRAPPER)
    const r = run(wrapper, { FOO_TOKEN: 'vault:known-id', BAR_TOKEN: 'vault:missing-id' })
    expect(r.status, 'pre-fix wrapper unexpectedly refused to start').toBe(0)
    expect(r.stdout).toContain('WRAPPED_COMMAND_RAN')
    // this is the fail-open: the literal placeholder went out as if it were a real value
    expect(r.stdout).toContain('BAR_TOKEN=vault:missing-id')
  })
})
