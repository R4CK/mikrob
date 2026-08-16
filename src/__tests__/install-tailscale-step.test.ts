// Card 0985ac83: install-linux.sh + install-macos.sh gained an opt-in Tailscale install step
// (default: no, matching the existing Whisper block's UX). Both installers are monolithic,
// sequential, thousands-of-lines scripts that do real system mutations (apt-get, sudo, brew) --
// running either one wholesale in a test is neither safe nor fast. Instead this extracts ONLY the
// new step (bounded by TAILSCALE-STEP-BEGIN/END sentinels in the real files) and runs THAT exact
// source, unmodified, in a sandbox with the real install-lang.sh sourced for _t() and a stubbed
// PATH (fake tailscale/curl/brew), so the assertions exercise the shipped logic, not a
// reimplementation of it.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
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

function sandbox(stepSource: string, opts: { fakeTailscaleOnPath?: boolean; statusExitCode?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-step-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })

  if (opts.fakeTailscaleOnPath) {
    writeFileSync(
      join(bin, 'tailscale'),
      `#!/bin/bash\nif [ "$1" = "status" ]; then exit ${opts.statusExitCode ?? 0}; fi\nexit 0\n`,
    )
    chmodSync(join(bin, 'tailscale'), 0o755)
  }

  const script = join(dir, 'run.sh')
  writeFileSync(script, SCAFFOLD + '\n' + stepSource + '\n')
  chmodSync(script, 0o755)
  return { dir, bin, script }
}

function run(script: string, bin: string, opts: { stdin?: string; extraBin?: string } = {}) {
  // Deliberately NO /usr/bin or /bin here: this host has a real tailscale binary installed
  // system-wide, and letting it leak onto PATH would silently defeat the "not installed" cases.
  // bash's own needs (read, echo, source, printf, [[ ]]) are all builtins -- no external PATH
  // dependency for the sentinel-bounded step itself.
  const path = [opts.extraBin, bin].filter(Boolean).join(':')
  return spawnSync('bash', [script], {
    encoding: 'utf-8',
    input: opts.stdin ?? '\n',
    env: { PATH: path, HOME: process.env.HOME ?? '', LANG_FILE_PATH: LANG_FILE, MARVEEN_LANG: 'hu' },
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
  ['install-linux.sh', LINUX_INSTALLER, 'i'],
  ['install-macos.sh', MACOS_INSTALLER, 'i'],
])('Tailscale opt-in step (card 0985ac83) -- %s', (_name, installerPath, acceptAnswer) => {
  const stepSource = extractStep(readFileSync(installerPath, 'utf-8'))

  it('already installed -> skips the prompt entirely, no curl/brew invoked', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 0 })
    const r = run(script, bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mar telepitve/)
    expect(r.stdout).not.toMatch(/Szeretned telepiteni|Would you like to install/)
  })

  it('not installed, user DECLINES (empty input, default n) -> skipped, no install attempted', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: false })
    const r = run(script, bin, { stdin: '\n' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Kihagyva/)
  })

  it('not installed, user ACCEPTS, install succeeds -> success message, no forced login attempted', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: false })
    // fake curl (linux path) always succeeds piping a no-op script; fake brew (macos path)
    // always exits 0. Neither creates a real tailscale binary -- proves the step never
    // shells out to `tailscale up`/`sudo` regardless of install outcome.
    const extraBinDir = mkdtempSync(join(tmpdir(), 'fake-tools-'))
    writeFileSync(join(extraBinDir, 'curl'), '#!/bin/bash\necho "exit 0"\n')
    chmodSync(join(extraBinDir, 'curl'), 0o755)
    writeFileSync(join(extraBinDir, 'sh'), '#!/bin/bash\nexit 0\n')
    chmodSync(join(extraBinDir, 'sh'), 0o755)
    writeFileSync(join(extraBinDir, 'brew'), '#!/bin/bash\nexit 0\n')
    chmodSync(join(extraBinDir, 'brew'), 0o755)
    const r = run(script, bin, { stdin: `${acceptAnswer}\n`, extraBin: extraBinDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/telepitve/)
    expect(r.stdout).not.toContain('tailscale up')
    expect(r.stdout).not.toContain('sudo')
  })

  it('not installed, user ACCEPTS, install FAILS -> non-fatal warn, script still exits 0', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: false })
    const extraBinDir = mkdtempSync(join(tmpdir(), 'fake-tools-fail-'))
    writeFileSync(join(extraBinDir, 'curl'), '#!/bin/bash\nexit 1\n')
    chmodSync(join(extraBinDir, 'curl'), 0o755)
    writeFileSync(join(extraBinDir, 'brew'), '#!/bin/bash\nexit 1\n')
    chmodSync(join(extraBinDir, 'brew'), 0o755)
    const r = run(script, bin, { stdin: `${acceptAnswer}\n`, extraBin: extraBinDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/sikertelen/)
  })

  it('installed but NOT logged in -> points to the dashboard, does not invoke tailscale up itself', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 1 })
    const r = run(script, bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Foderacio-oldalon/)
    expect(r.stdout).not.toContain('tailscale up')
  })

  it('installed AND already logged in -> no login hint printed', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 0 })
    const r = run(script, bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toMatch(/Foderacio-oldalon/)
  })
})
