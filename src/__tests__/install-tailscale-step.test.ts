// Card 12dc8a5c: install-linux.sh + install-macos.sh Tailscale step is now AUTOMATIC (Peti
// explicit approval 2026-09-10). Previously opt-in (card 0985ac83); the step now always installs
// the binary, and if TAILSCALE_AUTH_KEY is set runs `tailscale up --auth-key` non-interactively
// with a hard-kill backstop (same pattern as a2d8eab1 / tailscale-login.ts).
//
// Both installers are monolithic, sequential, thousands-of-lines scripts that do real system
// mutations -- running either one wholesale in a test is neither safe nor fast. Instead this
// extracts ONLY the new step (bounded by TAILSCALE-STEP-BEGIN/END sentinels) and runs THAT
// exact source, unmodified, in a sandbox with the real install-lang.sh sourced for _t() and
// a stubbed PATH (fake tailscale/curl/brew/sudo), so the assertions exercise the shipped logic.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LINUX_INSTALLER = join(ROOT, 'install-linux.sh')
const MACOS_INSTALLER = join(ROOT, 'install-macos.sh')
const LANG_FILE = join(ROOT, 'install-lang.sh')

function extractStep(source: string): string {
  const begin = source.indexOf('# TAILSCALE-STEP-BEGIN')
  const end = source.indexOf('# TAILSCALE-STEP-END')
  if (begin < 0 || end < 0) throw new Error('TAILSCALE-STEP sentinels not found')
  return source.slice(begin, end + '# TAILSCALE-STEP-END'.length)
}

const SCAFFOLD = `#!/bin/bash
BOLD='\\033[1m'; DIM='\\033[2m'; GREEN='\\033[0;32m'; ORANGE='\\033[0;33m'; NC='\\033[0m'
ok() { echo -e "  \${GREEN}\\xe2\\x9c\\x93\${NC} $*"; }
warn() { echo -e "  \${ORANGE}!\${NC} $*"; }
source "$LANG_FILE_PATH"
`

const COREUTILS_DIR = mkdtempSync(join(tmpdir(), 'tailscale-step-coreutils-'))
for (const tool of ['cat', 'chmod']) {
  const real = spawnSync('command', ['-v', tool], { encoding: 'utf-8', shell: '/bin/sh' }).stdout.trim()
  if (real) symlinkSync(real, join(COREUTILS_DIR, tool))
}

function sandbox(
  stepSource: string,
  opts: {
    fakeTailscaleOnPath?: boolean
    statusExitCode?: number
    tailscaleUpExitCode?: number
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-step-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })

  const invocationLog = join(dir, 'invocations.log')

  writeFileSync(
    join(bin, 'sudo'),
    `#!/bin/bash\necho "sudo $*" >> "${invocationLog}"\n"$@"\n`,
  )
  chmodSync(join(bin, 'sudo'), 0o755)

  if (opts.fakeTailscaleOnPath) {
    const upExit = opts.tailscaleUpExitCode ?? 0
    writeFileSync(
      join(bin, 'tailscale'),
      `#!/bin/bash\necho "tailscale $*" >> "${invocationLog}"\nif [ "$1" = "status" ]; then exit ${opts.statusExitCode ?? 0}; fi\nif [ "$1" = "up" ]; then exit ${upExit}; fi\nexit 0\n`,
    )
    chmodSync(join(bin, 'tailscale'), 0o755)
  }

  const script = join(dir, 'run.sh')
  writeFileSync(script, SCAFFOLD + '\n' + stepSource + '\n')
  chmodSync(script, 0o755)
  return { dir, bin, script, invocationLog }
}

function invocations(logPath: string): string[] {
  try {
    return readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const BASH = spawnSync('command', ['-v', 'bash'], { encoding: 'utf-8', shell: '/bin/sh' }).stdout.trim() || '/usr/bin/bash'

function run(
  script: string,
  bin: string,
  opts: { extraBin?: string; extraEnv?: Record<string, string> } = {},
) {
  const path = [opts.extraBin, bin, COREUTILS_DIR].filter(Boolean).join(':')
  return spawnSync(BASH, [script], {
    encoding: 'utf-8',
    env: {
      PATH: path,
      HOME: process.env.HOME ?? '',
      LANG_FILE_PATH: LANG_FILE,
      MARVEEN_LANG: 'hu',
      ...opts.extraEnv,
    },
  })
}

describe('install-linux.sh / install-macos.sh are syntactically valid', () => {
  it('bash -n passes for both', () => {
    for (const f of [LINUX_INSTALLER, MACOS_INSTALLER]) {
      const r = spawnSync('bash', ['-n', f], { encoding: 'utf-8' })
      expect(r.status, `${f}: ${r.stderr}`).toBe(0)
    }
  })
})

describe.each([
  ['install-linux.sh', LINUX_INSTALLER],
  ['install-macos.sh', MACOS_INSTALLER],
])('Tailscale automatic step (card 12dc8a5c) -- %s', (_name, installerPath) => {
  const stepSource = extractStep(readFileSync(installerPath, 'utf-8'))

  it('already installed and logged in -> skips install, no up invoked', () => {
    const { bin, script, invocationLog } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 0 })
    const r = run(script, bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mar telepitve/)
    const inv = invocations(invocationLog)
    expect(inv.some(l => l.includes('tailscale up'))).toBe(false)
  })

  it('not installed -> auto-installs (no prompt), curl/brew invoked', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: false })
    // fake curl/brew that succeed but don't actually install tailscale (no KEY -> no up attempt)
    const extraBinDir = mkdtempSync(join(tmpdir(), 'fake-tools-auto-'))
    writeFileSync(join(extraBinDir, 'curl'), '#!/bin/bash\nexit 0\n')
    chmodSync(join(extraBinDir, 'curl'), 0o755)
    writeFileSync(join(extraBinDir, 'brew'), '#!/bin/bash\nexit 0\n')
    chmodSync(join(extraBinDir, 'brew'), 0o755)
    const r = run(script, bin, { extraBin: extraBinDir })
    expect(r.status, r.stderr).toBe(0)
    // Should NOT print "Kihagyva" (old opt-in skip message)
    expect(r.stdout).not.toMatch(/Kihagyva/)
    // Should NOT ask the user (no prompt text)
    expect(r.stdout).not.toMatch(/Szeretnéd telepíteni|Would you like to install/)
  })

  it('not installed, install fails -> non-fatal warn, script still exits 0', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: false })
    const extraBinDir = mkdtempSync(join(tmpdir(), 'fake-tools-fail-'))
    writeFileSync(join(extraBinDir, 'curl'), '#!/bin/bash\nexit 1\n')
    chmodSync(join(extraBinDir, 'curl'), 0o755)
    writeFileSync(join(extraBinDir, 'brew'), '#!/bin/bash\nexit 1\n')
    chmodSync(join(extraBinDir, 'brew'), 0o755)
    const r = run(script, bin, { extraBin: extraBinDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/sikertelen/)
  })

  it('installed, not logged in, NO auth-key -> dashboard hint, no tailscale up invoked', () => {
    const { bin, script, invocationLog } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 1 })
    const r = run(script, bin) // no TAILSCALE_AUTH_KEY
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Foderacio-oldalon/)
    const inv = invocations(invocationLog)
    expect(inv.some(l => l.includes('tailscale up'))).toBe(false)
  })

  it('installed, not logged in, WITH auth-key -> tailscale up --auth-key invoked via sudo', () => {
    const { bin, script, invocationLog } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 1, tailscaleUpExitCode: 0 })
    const r = run(script, bin, { extraEnv: { TAILSCALE_AUTH_KEY: 'tskey-auth-test123' } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/bejelentkezve/)
    const inv = invocations(invocationLog)
    // sudo tailscale up --auth-key=... must have been called
    expect(inv.some(l => l.includes('tailscale up') && l.includes('--auth-key='))).toBe(true)
    // dashboard hint must NOT appear (already logged in via key)
    expect(r.stdout).not.toMatch(/Foderacio-oldalon/)
  })

  it('installed, not logged in, WITH auth-key, up FAILS -> non-fatal warn, dashboard fallback hint', () => {
    const { bin, script, invocationLog } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 1, tailscaleUpExitCode: 1 })
    const r = run(script, bin, { extraEnv: { TAILSCALE_AUTH_KEY: 'tskey-auth-test123' } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/sikertelen/)
    expect(r.stdout).toMatch(/Foderacio-oldalon/)
    const inv = invocations(invocationLog)
    expect(inv.some(l => l.includes('tailscale up') && l.includes('--auth-key='))).toBe(true)
  })

  it('installed and already logged in -> no login hint, no up invoked', () => {
    const { bin, script, invocationLog } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 0 })
    const r = run(script, bin, { extraEnv: { TAILSCALE_AUTH_KEY: 'tskey-auth-test123' } })
    expect(r.status, r.stderr).toBe(0)
    // Already logged in: status=0, so the up block is skipped entirely
    expect(r.stdout).not.toMatch(/Foderacio-oldalon/)
    const inv = invocations(invocationLog)
    expect(inv.some(l => l.includes('tailscale up'))).toBe(false)
  })
})
