import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Card b536501e (Cybersec finding on the 5d151091 gate). store/local-llm.sh and local-llm-rag.sh are
// version-controlled, so a runnable copy of each sits in every agent worktree -- and both used to
// read the dashboard's state from their OWN directory. A model the operator switched off in the
// dashboard would therefore keep running when the call came from a worktree copy, because the state
// file simply is not there and "no file" correctly means "nothing disabled".
//
// The behavioural test is the LAST one here: a disabled model, invoked through the WORKTREE copy,
// must be refused. Everything above it pins the resolver that makes that possible, including the two
// cases that return the same directory for opposite reasons.

const HERE = dirname(fileURLToPath(import.meta.url))
const STORE = join(HERE, '..', '..', 'store')
const HELPER = join(STORE, 'local-llm-state-dir.sh')

let root = ''
let main = ''
let wt = ''

/** Builds a main clone + a git worktree of it, each with a copy of the scripts under store/. */
function scaffold(): void {
  root = mkdtempSync(join(tmpdir(), 'llm-state-'))
  main = join(root, 'install')
  wt = join(root, 'worktrees', 'agentx')
  mkdirSync(join(main, 'store'), { recursive: true })
  mkdirSync(join(main, '.git', 'worktrees', 'agentx'), { recursive: true })
  mkdirSync(join(wt, 'store'), { recursive: true })
  for (const f of ['local-llm-state-dir.sh', 'local-llm.sh']) {
    copyFileSync(join(STORE, f), join(main, 'store', f))
    copyFileSync(join(STORE, f), join(wt, 'store', f))
  }
  // What makes it a worktree rather than a clone: .git is a FILE naming the main clone's gitdir.
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'agentx')}\n`)
}

/** Runs the resolver in isolation and returns the directory it chose plus the origin it reported. */
function resolve(scriptDir: string, env: Record<string, string> = {}): { dir: string; origin: string } {
  const out = execFileSync(
    'bash',
    [
      '-c',
      // Called directly, NOT through $(...): the resolver SETS its two variables, and a command
      // substitution would run it in a subshell where both die -- the defect this interface avoids.
      `. "${HELPER}"; resolve_local_llm_state_dir "$1"; printf '%s\\n%s\\n' "$LOCAL_LLM_STATE_RESOLVED" "$LOCAL_LLM_STATE_ORIGIN"`,
      'bash',
      scriptDir,
    ],
    { encoding: 'utf-8', env: { ...process.env, LOCAL_LLM_STATE_DIR: '', ...env } },
  )
  const [dir = '', origin = ''] = out.trim().split('\n')
  return { dir, origin }
}

beforeEach(scaffold)
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('resolve_local_llm_state_dir', () => {
  it('in the INSTALL, state is the script\'s own store -- and the origin says so', () => {
    expect(resolve(join(main, 'store'))).toEqual({ dir: join(main, 'store'), origin: 'install' })
  })

  it('THE FINDING: from a WORKTREE copy it resolves to the INSTALL store, not its own', () => {
    expect(resolve(join(wt, 'store'))).toEqual({ dir: join(main, 'store'), origin: 'worktree' })
  })

  it('LOCAL_LLM_STATE_DIR wins outright, from either location', () => {
    const forced = join(root, 'elsewhere')
    for (const from of [join(main, 'store'), join(wt, 'store')]) {
      expect(resolve(from, { LOCAL_LLM_STATE_DIR: forced })).toEqual({ dir: forced, origin: 'env' })
    }
  })

  it('a trailing slash on the override does not produce a doubled separator', () => {
    const forced = join(root, 'elsewhere')
    expect(resolve(join(wt, 'store'), { LOCAL_LLM_STATE_DIR: forced + '/' }).dir).toBe(forced)
  })

  it('a loose copy in no checkout at all reports UNKNOWN, not install', () => {
    // The whole reason origin exists: this returns the SAME directory as the install case, for the
    // opposite reason. A path comparison would call it fine; only the origin can tell them apart.
    const loose = join(root, 'loose', 'store')
    mkdirSync(loose, { recursive: true })
    const r = resolve(loose)
    expect(r.dir).toBe(loose)
    expect(r.origin).toBe('unknown')
  })

  it('a .git file that does not point into a worktrees dir is UNKNOWN, never silently install', () => {
    const odd = join(root, 'odd')
    mkdirSync(join(odd, 'store'), { recursive: true })
    writeFileSync(join(odd, '.git'), 'gitdir: /somewhere/else\n')
    expect(resolve(join(odd, 'store')).origin).toBe('unknown')
  })
})

describe('announce_local_llm_state_dir', () => {
  const announce = (origin: string, here: string, state: string): string => {
    const out = execFileSync(
      'bash',
      [
        '-c',
        `. "${HELPER}"; LOCAL_LLM_STATE_ORIGIN="$1" announce_local_llm_state_dir who "$2" "$3" 2>&1 || true`,
        'bash',
        origin,
        here,
        state,
      ],
      { encoding: 'utf-8' },
    )
    return out.trim()
  }

  it('says nothing in the install -- the ordinary case must not become noise', () => {
    expect(announce('install', '/a/store', '/a/store')).toBe('')
  })

  it('names the install store when running from a worktree copy', () => {
    const msg = announce('worktree', '/wt/store', '/install/store')
    expect(msg).toContain('/install/store')
    expect(msg).toContain('/wt/store')
  })

  it('WARNS on unknown -- the case that would otherwise bypass a switch in silence', () => {
    const msg = announce('unknown', '/loose/store', '/loose/store')
    expect(msg).toContain('WARNING')
    expect(msg).toMatch(/kill switch|switches/i)
  })
})

describe('the kill switch reaches a call made from a worktree copy', () => {
  it('THE CARD: a model disabled in the INSTALL is refused by the WORKTREE copy, exit 9', () => {
    writeFileSync(
      join(main, 'store', 'local-llm-model-disabled.json'),
      JSON.stringify({ disabledModels: { 'switched-off:latest': 1788500000000 } }),
    )
    let status = 0
    let stderr = ''
    try {
      execFileSync('bash', [join(wt, 'store', 'local-llm.sh'), '--model', 'switched-off', 'hi'], {
        encoding: 'utf-8',
        env: { ...process.env, LOCAL_LLM_STATE_DIR: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      status = e.status ?? 0
      stderr = e.stderr ?? ''
    }
    // 9 is the fleet's "this task belongs online" code. Before this card the call fell through to
    // Ollama instead, because the worktree copy read its own (absent) state file.
    expect(status).toBe(9)
    expect(stderr).toContain('DISABLED')
  })

  it('an ENABLED model is not refused by the same path -- the guard is not a blanket stop', () => {
    writeFileSync(
      join(main, 'store', 'local-llm-model-disabled.json'),
      JSON.stringify({ disabledModels: { 'something-else:latest': 1788500000000 } }),
    )
    let status = 0
    try {
      execFileSync('bash', [join(wt, 'store', 'local-llm.sh'), '--model', 'still-on', 'hi'], {
        encoding: 'utf-8',
        env: { ...process.env, LOCAL_LLM_STATE_DIR: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      status = (err as { status?: number }).status ?? 0
    }
    // Whatever happens next (Ollama up or down) it must NOT be the kill-switch refusal.
    expect(status).not.toBe(9)
  })
})
