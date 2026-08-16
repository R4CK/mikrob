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

// Coreutils the fake curl/sh/brew stubs need (cat, chmod) to build a simulated post-install
// tailscale binary. NOT the full real PATH -- specifically NOT /usr/bin or /bin wholesale, whose
// real `tailscale` would silently defeat the "not installed" scenarios this suite exists to
// exercise. `cat > file <<EOF` still creates/truncates the target even if `cat` itself can't be
// found (the redirection is set up by the shell before the command lookup), so a missing `cat`
// used to fail SILENTLY -- an empty file, not an error -- rather than loudly.
const COREUTILS_DIR = mkdtempSync(join(tmpdir(), 'tailscale-step-coreutils-'))
for (const tool of ['cat', 'chmod']) {
  const real = spawnSync('command', ['-v', tool], { encoding: 'utf-8', shell: '/bin/sh' }).stdout.trim()
  if (real) symlinkSync(real, join(COREUTILS_DIR, tool))
}

function sandbox(stepSource: string, opts: { fakeTailscaleOnPath?: boolean; statusExitCode?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-step-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })

  // Every invocation of tailscale/sudo is appended (args included) to invocations.log, so a test
  // can assert on what actually RAN, not on stray text in stdout (a command's own args don't get
  // echoed to stdout unless the command itself prints them).
  const invocationLog = join(dir, 'invocations.log')
  writeFileSync(
    join(bin, 'sudo'),
    `#!/bin/bash\necho "sudo $*" >> "${invocationLog}"\n"$@"\n`,
  )
  chmodSync(join(bin, 'sudo'), 0o755)

  if (opts.fakeTailscaleOnPath) {
    writeFileSync(
      join(bin, 'tailscale'),
      `#!/bin/bash\necho "tailscale $*" >> "${invocationLog}"\nif [ "$1" = "status" ]; then exit ${opts.statusExitCode ?? 0}; fi\nexit 0\n`,
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

// Absolute path so spawnSync's own executable lookup doesn't depend on the scoped PATH below.
const BASH = spawnSync('command', ['-v', 'bash'], { encoding: 'utf-8', shell: '/bin/sh' }).stdout.trim() || '/usr/bin/bash'

function run(
  script: string,
  bin: string,
  opts: { stdin?: string; extraBin?: string; extraEnv?: Record<string, string> } = {},
) {
  // Deliberately NO /usr/bin or /bin here: this host has a real tailscale binary installed
  // system-wide, and letting it leak onto PATH would silently defeat the "not installed" cases.
  // bash's own needs (read, echo, source, printf, [[ ]]) are all builtins -- no external PATH
  // dependency for the sentinel-bounded step itself.
  const path = [opts.extraBin, bin, COREUTILS_DIR].filter(Boolean).join(':')
  return spawnSync(BASH, [script], {
    encoding: 'utf-8',
    input: opts.stdin ?? '\n',
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
    const { bin, script, invocationLog } = sandbox(stepSource, { fakeTailscaleOnPath: false })
    // fake curl (linux path) always succeeds; fake brew (macos path) always exits 0. Critically,
    // the tailscale binary does NOT exist on PATH until the fake `sh`/`brew` "installer" creates
    // it as a side effect -- so `command -v tailscale` at the TOP of the step still correctly
    // reports "not installed" and the accept-and-install branch actually runs (a pre-placed fake
    // binary made an earlier version of this test pass vacuously via the already-installed
    // branch, whose "mar telepitve" message also matches /telepitve/).
    const extraBinDir = mkdtempSync(join(tmpdir(), 'fake-tools-'))
    writeFileSync(join(extraBinDir, 'curl'), '#!/bin/bash\necho "exit 0"\n')
    chmodSync(join(extraBinDir, 'curl'), 0o755)
    const installedTailscaleStub = `#!/bin/bash
echo "tailscale $*" >> "$INVOCATION_LOG"
if [ "$1" = "status" ]; then exit 0; fi
exit 0
`
    writeFileSync(
      join(extraBinDir, 'sh'),
      `#!/bin/bash\ncat > "$EXTRA_BIN_DIR/tailscale" <<'TS'\n${installedTailscaleStub}TS\nchmod +x "$EXTRA_BIN_DIR/tailscale"\nexit 0\n`,
    )
    chmodSync(join(extraBinDir, 'sh'), 0o755)
    writeFileSync(
      join(extraBinDir, 'brew'),
      `#!/bin/bash\nif [ "$1" = "install" ]; then\ncat > "$EXTRA_BIN_DIR/tailscale" <<'TS'\n${installedTailscaleStub}TS\nchmod +x "$EXTRA_BIN_DIR/tailscale"\nfi\nexit 0\n`,
    )
    chmodSync(join(extraBinDir, 'brew'), 0o755)
    const r = run(script, bin, {
      stdin: `${acceptAnswer}\n`,
      extraBin: extraBinDir,
      extraEnv: { EXTRA_BIN_DIR: extraBinDir, INVOCATION_LOG: invocationLog },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toMatch(/mar telepitve/)
    expect(r.stdout).toMatch(/telepitve/)
    // `tailscale status` (a read-only check, printing the login hint) is expected; `tailscale up`
    // and `sudo` (which would trigger/require a login) are not.
    expect(invocations(invocationLog)).not.toContain('tailscale up')
    expect(invocations(invocationLog).filter(l => l.startsWith('sudo'))).toEqual([])
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
    const { bin, script, invocationLog } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 1 })
    const r = run(script, bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Foderacio-oldalon/)
    expect(invocations(invocationLog)).not.toContain('tailscale up')
  })

  it('installed AND already logged in -> no login hint printed', () => {
    const { bin, script } = sandbox(stepSource, { fakeTailscaleOnPath: true, statusExitCode: 0 })
    const r = run(script, bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toMatch(/Foderacio-oldalon/)
  })
})
