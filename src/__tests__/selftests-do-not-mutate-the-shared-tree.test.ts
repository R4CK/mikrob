// Card 9b224eec: a selftest must not move, delete or overwrite a file INSIDE the shared checkout.
//
// THE DEFECT, measured by backend2 on a real landing attempt. load-guard-bookkeeping.selftest.sh
// case 12 proved "a missing load-guard-excluded.sh must SPEAK" by doing exactly that -- `mv` the
// real file aside, run, put it back one case later. Between those two moments the file was not in
// the tree, and the tree is shared with every other vitest worker.
// store-shell-scripts-syntax-sweep.test.ts lists store/*.sh at COLLECT time and `bash -n`s them at
// TEST time; a run that straddled the gap died with exit 127 on a file that exists. 13009 of 957347
// existence polls saw it absent (~1.4%), and the same branch that had landed 776/776 green failed
// 775/776 on that one file. Intermittent, so it reads as "some unrelated flaky test".
//
// The cure is not "be careful with mv": it is that a selftest needing a file to be ABSENT should
// build a sandbox that never had it. Copying OUT of the tree is fine and common; writing INTO it is
// the hazard, because that is the copy everyone else is reading.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const STORE = join(import.meta.dirname, '..', '..', 'store')
const FILES = readdirSync(STORE).filter((f) => f.endsWith('.selftest.sh'))

/** Destructive commands whose TARGET resolves inside the checkout.
 *
 *  VARIABLES ARE RESOLVED, NOT IGNORED, and that is the whole reason this works. My first version
 *  of this scan looked for `$HERE` on the command line itself and reported a clean sweep -- while
 *  the founding case read `REAL_EXCLUDED="$HERE/..."` on one line and `mv "$REAL_EXCLUDED" ...` on
 *  another. It could not see the bug it was written for. Running it against the pre-fix file is what
 *  exposed that, and the regression case below keeps it honest.
 */
function treeMutations(src: string): string[] {
  const body = src.replace(/^\s*#.*$/gm, '')
  const treeVars = new Set(
    [...body.matchAll(/^\s*([A-Z_][A-Z0-9_]*)="\$(?:HERE|SCRIPT_DIR|ROOT)\//gm)].map((m) => m[1]!),
  )
  const hits: string[] = []
  for (const m of body.matchAll(/^\s*(mv|rm|ln|truncate|chmod)\b([^\n]*)$/gm)) {
    const args = m[2]!
    const direct = /\$(HERE|SCRIPT_DIR|ROOT)\b/.test(args)
    const viaVar = [...treeVars].some((v) => new RegExp(`\\$\\{?${v}\\}?\\b`).test(args))
    if (direct || viaVar) hits.push(m[0]!.trim())
  }
  return hits
}

describe('no selftest mutates the shared checkout', () => {
  it('the measure is not vacuous -- selftests are found', () => {
    expect(FILES.length).toBeGreaterThan(5)
  })

  it.each(FILES)('%s', (f) => {
    const hits = treeMutations(readFileSync(join(STORE, f), 'utf-8'))
    expect(
      hits,
      'this moves/removes a file inside the shared tree. Every other vitest worker reads that same ' +
        'tree, so the window is a false red somewhere else (card 9b224eec: ~1.4% of polls saw the ' +
        'file absent). If a case needs a file to be ABSENT, copy what it needs into a temp sandbox ' +
        'and leave that one file out -- see case 12 of load-guard-bookkeeping.selftest.sh.',
    ).toEqual([])
  })

  // `cp` INTO a sandbox is the cure, not the disease: it reads the tree and writes elsewhere. If
  // this ever flags, the scan has started punishing the fix it exists to encourage.
  it('copying OUT of the tree is not flagged', () => {
    expect(treeMutations('RUN="$HERE/x.sh"\ncp "$RUN" "$TMP/sandbox/"')).toEqual([])
  })

  it('REGRESSION: the founding case IS caught, through a variable', () => {
    // The exact shape that caused the flake. Without this the scan can silently go blind again.
    const founding = 'REAL_EXCLUDED="$HERE/load-guard-excluded.sh"\nmv "$REAL_EXCLUDED" "$MOVED"'
    expect(treeMutations(founding)).toHaveLength(1)
  })
})
