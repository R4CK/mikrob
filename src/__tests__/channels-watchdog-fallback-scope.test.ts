// channels.sh's watchdog fallback (for plugin builds that never write bot.pid) must be scoped to
// THIS session's own process tree, not the whole host (card 4c34f201, upstream blob d0ca55bd).
//
// THE BUG. The fallback used to be a host-wide `ps eww -e | grep CLAUDE_PLUGIN_ROOT=.../<provider>`,
// which matches ANY agent's plugin process on a multi-agent host -- not only this session's own.
// Measured upstream (kanban c0390130, 2026-08-19): 14 telegram plugin processes ran under other
// agents while one agent's own channel was dead from 07:40 to 08:30, and the fallback read
// permanently true throughout, so the watchdog never noticed and nobody was told. Measured on this
// fork (2026-09-06): 2 matching processes already present on this host, so the exposure is live
// here, not theoretical.
//
// THE FIX narrows to `pgrep -P "$_watchdog_claude_pid" bun`, the same technique the post-init
// unlock's Check 1 already uses (`pgrep -P "$CLAUDE_PID" bun`, this file's line ~825) -- proven on
// this fork already, just unapplied on this one branch. Measured on this host that the plugin's bun
// process is a direct child of the claude pane process, so the narrowing cannot start a false
// restart-loop here.
//
// THESE TESTS RUN THE REAL SNIPPET, extracted verbatim out of channels.sh (the same technique
// channels-reap-scope.test.ts uses for its awk program), against REAL process trees -- a fake `tmux`
// binary reports a chosen pane_pid, and a script literally named `bun` supplies a process whose comm
// name pgrep can match (Linux sets a shebang script's comm to the SCRIPT's basename, not the
// interpreter's -- `exec -a bun sleep 5` does NOT produce a process named "bun" to pgrep, only a
// changed argv[0], which cost one failed attempt building this file before switching to a real file
// named `bun`). No `/usr/bin/pgrep` stubbing needed: the real one runs against a real, disposable
// process tree.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const channelsSh = readFileSync(join(REPO_ROOT, 'scripts', 'channels.sh'), 'utf-8')

/** Pulls the exact watchdog fallback block out of channels.sh, the same extraction technique
 * channels-reap-scope.test.ts uses for its awk program -- the test runs the REAL bash, not a
 * hand-copied restatement of it that could drift from the shipped file. */
function extractFallbackBlock(): string {
  const startNeedle = 'if [ "$_plugin_alive" != "true" ]; then\n    _watchdog_claude_pid='
  const start = channelsSh.indexOf(startNeedle)
  if (start < 0) throw new Error('watchdog fallback block not found in channels.sh')
  const end = channelsSh.indexOf('\n  fi\n', start)
  if (end < 0) throw new Error('closing fi of the watchdog fallback block not found')
  return channelsSh.slice(start, end + '\n  fi'.length)
}

const dir = join(tmpdir(), `channels-watchdog-fallback-scope-${process.pid}`)
const children: ChildProcess[] = []

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

/** A real, disposable process tree: `holderPid` (returned) has a direct child whose comm is
 * literally `bun` (a real file named `bun`, not an argv[0] trick -- see the module doc). */
function spawnFakePaneWithBunChild(): number {
  mkdirSync(dir, { recursive: true })
  const bunScript = join(dir, 'bun')
  writeFileSync(bunScript, '#!/bin/sh\nsleep 5\n')
  chmodSync(bunScript, 0o755)
  const holder = spawn('bash', ['-c', `'${bunScript}' & wait`])
  children.push(holder)
  return holder.pid!
}

/** A real process tree with NO bun child at all under the given holder. */
function spawnFakePaneWithoutBunChild(): number {
  const holder = spawn('bash', ['-c', 'sleep 5'])
  children.push(holder)
  return holder.pid!
}

/** A fake `tmux` that answers `list-panes -t <session> -F '#{pane_pid}'` with a fixed pid,
 * regardless of the session name -- the extracted snippet only cares about the printed value. */
function stubTmux(panePid: number | ''): string {
  const p = join(dir, 'tmux-stub')
  writeFileSync(p, `#!/bin/sh\necho '${panePid}'\n`)
  chmodSync(p, 0o755)
  return p
}

function runFallback(tmuxPath: string): boolean {
  const script = `
_plugin_alive=false
SESSION="unit-test-session"
TMUX="${tmuxPath}"
${extractFallbackBlock()}
printf '%s' "$_plugin_alive"
`
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf-8' })
  return out === 'true'
}

describe('channels.sh watchdog fallback is scoped to this session\'s own process tree (card 4c34f201)', () => {
  it('THE FIX: a bun process under OUR OWN pane_pid counts as alive', () => {
    mkdirSync(dir, { recursive: true })
    const panePid = spawnFakePaneWithBunChild()
    // Give the fake bun a moment to actually be forked before pgrep looks for it.
    execFileSync('sleep', ['0.3'])
    expect(runFallback(stubTmux(panePid))).toBe(true)
  })

  it('THE BUG THIS FIXES: a bun process under a DIFFERENT process (another agent) does NOT count', () => {
    mkdirSync(dir, { recursive: true })
    const foreignBunHolder = spawnFakePaneWithBunChild()
    execFileSync('sleep', ['0.3'])
    // Our own claimed pane_pid is a SEPARATE, real process with no bun child at all.
    const ourPanePid = spawnFakePaneWithoutBunChild()
    expect(runFallback(stubTmux(ourPanePid))).toBe(false)
    // The foreign process really did have a bun child (control on the fixture itself, not the
    // guard) -- otherwise this case would pass just as well on a guard that never finds anything.
    expect(execFileSync('bash', ['-c', `/usr/bin/pgrep -P ${foreignBunHolder} bun || true`], { encoding: 'utf-8' }).trim()).not.toBe('')
  })

  it('CONTROL: no bun anywhere, and tmux resolves no pane -> not alive', () => {
    mkdirSync(dir, { recursive: true })
    expect(runFallback(stubTmux(''))).toBe(false)
  })

  it('CONTROL: our own pane_pid resolves but has no bun child -> not alive', () => {
    mkdirSync(dir, { recursive: true })
    const panePid = spawnFakePaneWithoutBunChild()
    expect(runFallback(stubTmux(panePid))).toBe(false)
  })

  it('does not read CLAUDE_PLUGIN_ROOT or the process environment at all any more', () => {
    // The whole point of the fix is that env content from ANY process must not decide this branch.
    expect(extractFallbackBlock()).not.toMatch(/CLAUDE_PLUGIN_ROOT/)
    expect(extractFallbackBlock()).not.toMatch(/ps eww/)
  })
})
