import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOOK_NODE_BIN,
  pythonHookCommand,
  injectOutgoingCopyGate,
  injectGitProtectGuard,
  injectNpmProtectGuard,
  injectSymlinkedNodeModulesGuard,
  injectBlastRadiusGuard,
  injectPentestToolInstallGuard,
  injectCdChainGuard,
  injectNoisyCommandGuard,
  ensureCdChainGuard,
} from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

// THE DEFECT (card d2b881ab): hookCommand's own header states that exit 127 is "exactly the
// non-blocking status this whole file exists to stop", and checks the NODE interpreter before
// using it. All fourteen PYTHON guards were wired as a bare `python3 "<script>"`. If python3 ever
// leaves the PATH -- a pyenv shim, a package upgrade, a different spawn environment -- every one of
// them exits 127, Claude Code reads that as non-blocking, and EVERY python guard goes silently
// quiet. No error, no log, the tool calls pass.
//
// These tests EXECUTE the wired command rather than pattern-match it. A string assertion would have
// stayed green through the whole defect: measured on this repo, the existing 72 hook-wiring tests
// all passed with the bare form AND with the fixed form, because none of them pinned the shape.

/** Run a wired hook command through `sh -c` with an interpreter-free PATH; return its exit code.
 *
 *  `/bin/sh` is spelled ABSOLUTELY on purpose. The first cut spawned bare `sh` with the emptied
 *  PATH, so the SPAWN failed and `status` came back null -- the harness was measuring its own
 *  environment instead of the guard, and every case failed for a reason that had nothing to do
 *  with the code under test. The child still gets no usable PATH, which is the condition we mean. */
function exitCodeWithoutPython(command: string): number {
  try {
    execFileSync('/bin/sh', ['-c', command], {
      env: { PATH: '/nonexistent-for-this-test' },
      stdio: 'pipe',
    })
    return 0
  } catch (err) {
    const status = (err as { status: number | null }).status
    if (status === null || status === undefined) {
      throw new Error(`harness fault: /bin/sh did not run the command (signal or spawn failure)`)
    }
    return status
  }
}

function ptuCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, unknown>
  const ptu = (hooks.PreToolUse ?? []) as { hooks: { command: string }[] }[]
  return ptu.flatMap((e) => e.hooks.map((h) => h.command))
}

const INJECTORS: Array<[string, (s: Record<string, unknown>) => void]> = [
  ['git-protect-guard', injectGitProtectGuard],
  ['npm-protect-guard', injectNpmProtectGuard],
  ['symlinked-node-modules-guard', injectSymlinkedNodeModulesGuard],
  ['blast-radius-guard', injectBlastRadiusGuard],
  ['pentest-tool-install-guard', injectPentestToolInstallGuard],
  ['cd-chain-guard', injectCdChainGuard],
  ['noisy-command-guard', injectNoisyCommandGuard],
  ['outgoing-copy-gate', injectOutgoingCopyGate],
]

describe('a missing python3 must BLOCK, not exit 127 (card d2b881ab)', () => {
  it('THE MEASUREMENT: the wired command exits 2, and the OLD bare form exits 127', () => {
    const script = join('/some/dir', 'guard.py')
    expect(exitCodeWithoutPython(pythonHookCommand(script))).toBe(2)
    // The control that makes the number above mean something. Without it, `toBe(2)` could pass for
    // reasons having nothing to do with the interpreter probe.
    expect(exitCodeWithoutPython(`python3 "${script}"`)).toBe(127)
  })

  it('says WHAT is missing, that it BLOCKS, and the way out', () => {
    const cmd = pythonHookCommand('/some/dir/guard.py')
    expect(cmd).toMatch(/^command -v python3 /)
    expect(cmd).toContain('exit 2')
    expect(cmd).toContain('python3 nincs a PATH-on')
    expect(cmd).toContain('BLOKKOL')
    expect(cmd).toContain('telepitsd a python3-at')
  })

  it('still quotes the script path -- a home dir with a space must not split', () => {
    expect(pythonHookCommand('/Users/a b/guard.py')).toContain('python3 "/Users/a b/guard.py"')
  })
})

describe('every python guard is wired through the checked interpreter', () => {
  for (const [name, inject] of INJECTORS) {
    it(`${name} blocks (exit 2) with no python3 on PATH`, () => {
      const settings: Record<string, unknown> = {}
      inject(settings)
      const cmds = ptuCommands(settings).filter((c) => c.includes(`${name}.py`))
      expect(cmds.length).toBeGreaterThan(0)
      for (const c of cmds) {
        expect(exitCodeWithoutPython(c)).toBe(2)
        // Measured on the INJECTED command, not on source text: a bare wiring is the defect.
        expect(c).not.toMatch(/^python3 /)
      }
    })
  }
})

describe('the outgoing-copy-gate is a .py file and must not be handed to NODE (card d2b881ab)', () => {
  it('its wired command probes python3 and never names the node interpreter', () => {
    // THE SECOND, WORSE SHAPE: this gate built its command with hookCommand(), which prepends the
    // NODE binary -- to a .py file. `"<node>" ".../outgoing-copy-gate.py" --telegram-bash`
    // SyntaxErrors and exits 1, so the gate was a guaranteed no-op. Latent only because the kill
    // switch ships off: the day someone enables it, a switch that believes it turns on a
    // protection turns on nothing. That is worse than an absent guard -- it is false assurance.
    const settings: Record<string, unknown> = {}
    injectOutgoingCopyGate(settings)
    const cmd = ptuCommands(settings).find((c) => c.includes('outgoing-copy-gate.py'))
    expect(cmd).toBeDefined()
    expect(cmd).toContain('command -v python3')
    expect(cmd).not.toContain(HOOK_NODE_BIN)
  })
})

describe('the BUILDER must agree with the script EXTENSION, everywhere (card d2b881ab)', () => {
  // WHY A SOURCE SCAN AND NOT A BEHAVIOUR TEST. hookCommand's own header promises that a single
  // builder keeps "the injectors and every wired-already comparison byte-identical, so they cannot
  // drift". Moving injectOutgoingCopyGate to the python builder and leaving ensureGovernanceGate-
  // Commands' comparison on the node builder broke that promise, and the damage was in the
  // COMPARISON, not the wired command: the wired form was correct, so every test that inspected it
  // stayed green, while the repair pass could no longer recognise its own work. It never settled
  // (needCopyAdd true on every pass) and the OFF direction stopped removing anything. The
  // outgoing-copy-gate role-wiring tests caught it, but only for THAT gate -- this pins the class.
  //
  // Matched on the RAW file, not a comment-stripped copy: this is an ABSENCE claim, and stripping
  // is the direction that can hide a real occurrence. A comment merely DISCUSSING the wrong pairing
  // costs a false red, which is the safe way to be wrong here. The pattern needs an actual call
  // form, so the prose above (and in agent-scaffold.ts) does not trip it.
  const CALL = /(?<![A-Za-z0-9_$])(python)?[Hh]ookCommand\((?:[^()]|\([^()]*\))*\)/g
  const PY_SCRIPT = /['"][^'"]*\.py['"]/
  const JS_SCRIPT = /['"][^'"]*\.(?:mjs|cjs|js)['"]/

  function mispairedBuilders(src: string): string[] {
    const bad: string[] = []
    for (const m of src.matchAll(CALL)) {
      const call = m[0]
      const isPythonBuilder = call.startsWith('python')
      if (isPythonBuilder && JS_SCRIPT.test(call)) bad.push(`python builder on a JS script: ${call}`)
      if (!isPythonBuilder && PY_SCRIPT.test(call)) bad.push(`node builder on a .py script: ${call}`)
    }
    return bad
  }

  const scaffoldSrc = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf8')

  it('no .py path is handed to hookCommand, and no .mjs path to pythonHookCommand', () => {
    expect(mispairedBuilders(scaffoldSrc)).toEqual([])
  })

  it('CONTROL: the scan actually bites -- a reverted site is reported', () => {
    // A scan that finds nothing looks identical to a scan that CANNOT find anything. Both
    // directions are exercised against the real source, mutated in memory.
    const revertedComparison = scaffoldSrc.replace('const copyCmd = pythonHookCommand(', 'const copyCmd = hookCommand(')
    expect(revertedComparison).not.toBe(scaffoldSrc)
    expect(mispairedBuilders(revertedComparison)).toHaveLength(1)

    const revertedInjector = scaffoldSrc.replace('const base = pythonHookCommand(', 'const base = hookCommand(')
    expect(revertedInjector).not.toBe(scaffoldSrc)
    expect(mispairedBuilders(revertedInjector)).toHaveLength(1)

    const jsOnPython = scaffoldSrc.replace(
      "hookCommand(join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs'))",
      "pythonHookCommand(join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs'))",
    )
    expect(jsOnPython).not.toBe(scaffoldSrc)
    expect(mispairedBuilders(jsOnPython).length).toBeGreaterThan(0)
  })

  it('and it is looking at a real corpus -- the file does contain builder calls', () => {
    // Guards against the scan silently passing because the regex matched nothing at all.
    expect([...scaffoldSrc.matchAll(CALL)].length).toBeGreaterThan(10)
  })
})

describe('CONTROL: the staleness guard keeps its DELIBERATE fail-open form', () => {
  it('is left alone, because a removed script must not block there', () => {
    // Not every python wiring in this file is the same decision. The staleness guard is
    // `bash -c '[ -f <script> ] && exec python3 <script>; exit 0'` -- fail-open BY DESIGN when the
    // script is gone. A missing interpreter behaving non-blocking is consistent with that stated
    // intent, so it is out of scope here. Pinned so a later sweep does not "finish the job" and
    // silently revoke a working decision.
    const src = require('node:fs').readFileSync(
      join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf8',
    ) as string
    expect(src).toContain("exec python3 ${_stalenessScript}; exit 0")
  })
})

// DoD 3: the fix must reach agents that are ALREADY wired, not only newly provisioned ones. The
// mechanism is the same one the node side uses, but "it should work by construction" is exactly the
// claim that deserves a test rather than a paragraph.
const MIGRATION_AGENT = 'pythonhook-migration-test-agent'
const migrationDir = join(PROJECT_ROOT, 'agents', MIGRATION_AGENT)

afterEach(() => {
  rmSync(migrationDir, { recursive: true, force: true })
})

describe.skipIf(REPO_UNDER_TMP)(`an ALREADY-wired agent is migrated off the bare form${TMP_SKIP_REASON}`, () => {
  it('replaces the legacy bare python3 entry rather than adding a second one', () => {
    const settingsPath = join(migrationDir, '.claude', 'settings.json')
    mkdirSync(join(migrationDir, '.claude'), { recursive: true })
    const legacy = `python3 "${join(PROJECT_ROOT, 'scripts', 'hooks', 'cd-chain-guard.py')}"`
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: legacy, timeout: 10 }] }] },
    }, null, 2))

    expect(ensureCdChainGuard(MIGRATION_AGENT)).toBe(true)

    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    const cmds = ptuCommands(after).filter((c) => c.includes('cd-chain-guard.py'))
    // Exactly one entry: the injector filters prior entries naming the same script before appending.
    // A duplicate would leave the fail-open wiring live alongside the fixed one.
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toContain('command -v python3')
    expect(cmds[0]).not.toBe(legacy)
    expect(exitCodeWithoutPython(cmds[0])).toBe(2)
  })

  it('is idempotent: a second call reports no change', () => {
    const settingsPath = join(migrationDir, '.claude', 'settings.json')
    mkdirSync(join(migrationDir, '.claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2))
    expect(ensureCdChainGuard(MIGRATION_AGENT)).toBe(true)
    expect(ensureCdChainGuard(MIGRATION_AGENT)).toBe(false)
  })
})
