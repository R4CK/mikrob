// Card 2bfbf805 (Cybersec NO-GO follow-up, gate-scan a68c5ce8): a tracked file with a shebang must
// be tracked EXECUTABLE. Ported from CleanCore's apps/api/src/shebang-files-executable.test.ts
// (card 95e73c8e) after this exact bug class bit marveen too -- store/load-guard-sigstop.sh,
// -sigstop-target.sh, -sigstop-apply.sh and -bookkeeping.sh were all committed as mode 100644.
// load-guard-daemon.sh invokes them DIRECTLY (not `bash script.sh`), and its own calls are wrapped
// `|| true` for resilience -- so the exec-bit failure (exit 126, Permission denied) was silently
// swallowed on every real tick. The daemon reported "status=0/SUCCESS" while --sigstop and
// --bookkeeping never actually ran at all. A live smoke test that only checks the daemon's own
// exit code cannot catch this; only a real invocation (or this structural index check) can.
//
// WHY NOBODY SAW IT LOCALLY. The exec bit lives in the tree, not the checkout, and a WSL2/DrvFs
// mount can report every file as `-rwxrwxrwx` with `core.fileMode=false` so git ignores what the
// filesystem says -- everything LOOKS executable and runs locally; only a real checkout (or `git
// ls-files -s`, which reads the INDEX mode, not the filesystem) sees 100644. `chmod +x` alone does
// not fix it there either -- the index has to be told directly: `git update-index --chmod=+x <f>`.
//
// A SHEBANG IS THE RULE, not a hand-kept list of filenames: deriving it from the index means a
// script added tomorrow is covered on the day it lands.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface TrackedFile {
  readonly mode: string
  readonly path: string
}

/** Every tracked file with its index mode. `-z` because a repo path may legally contain a newline. */
function trackedFiles(): TrackedFile[] {
  const raw = execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd: REPO,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw
    .toString('utf-8')
    .split('\0')
    .filter((e) => e.length > 0)
    .map((entry) => {
      // `<mode> <sha> <stage>\t<path>`
      const tab = entry.indexOf('\t')
      return { mode: entry.slice(0, entry.indexOf(' ')), path: entry.slice(tab + 1) }
    })
}

/** Does the file START with `#!`? Read as bytes and checked at offset 0: a shebang anywhere else is
 *  not a shebang, and a `#!` inside a markdown code sample must not count. */
function hasShebang(path: string): boolean {
  try {
    const fd = readFileSync(join(REPO, path))
    return fd[0] === 0x23 && fd[1] === 0x21
  } catch {
    return false // in the index but not on disk; not this guard's business
  }
}

const TRACKED = trackedFiles()
const SHEBANG = TRACKED.filter((f) => hasShebang(f.path))

describe('every tracked shebang file is executable (card 2bfbf805, ported from CleanCore 95e73c8e)', () => {
  it('the scan read the index -- it is not asserting over an empty list', () => {
    // The negative control. `[].every()` is true, so a wrong cwd or a broken parse would otherwise
    // report a perfectly executable repo it never looked at.
    expect(TRACKED.length, 'git ls-files returned almost nothing').toBeGreaterThan(100)
    expect(
      SHEBANG.length,
      'not one shebang file found -- the byte check is broken',
    ).toBeGreaterThan(5)
  })

  it('no shebang file is tracked as non-executable', () => {
    const broken = SHEBANG.filter((f) => f.mode !== '100755').map((f) => `${f.path} (${f.mode})`)
    expect(
      broken,
      'These files declare a shebang but are tracked non-executable, so `./<file>` (or a direct, ' +
        'non-`bash`-prefixed invocation, like load-guard-daemon.sh calling its own sibling scripts) ' +
        'is exit 126 on any checkout whose filesystem carries real modes. `chmod +x` alone does not ' +
        'fix it on a DrvFs/core.fileMode=false mount -- tell the index directly:\n' +
        '  git update-index --chmod=+x <files>',
    ).toEqual([])
  })

  it('the load-guard family that load-guard-daemon.sh invokes directly is executable', () => {
    // Named explicitly, not just covered by the derived rule above: these are the exact files that
    // motivated this guard (card 2bfbf805 follow-up) -- pinning them means a future edit that drops
    // one back to 100644 fails HERE, immediately, rather than silently degrading a live daemon tick.
    const modeOf = new Map(TRACKED.map((f) => [f.path, f.mode]))
    for (const script of [
      'store/load-guard-daemon.sh',
      'store/load-guard-cgroup.sh',
      'store/load-guard-sigstop.sh',
      'store/load-guard-sigstop-target.sh',
      'store/load-guard-sigstop-apply.sh',
      'store/load-guard-bookkeeping.sh',
    ]) {
      expect(modeOf.get(script), `${script} is missing or not executable`).toBe('100755')
    }
  })
})
