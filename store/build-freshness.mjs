// Is the compiled artifact we are about to trust OLDER than the source it was built from?
// (card a3611ecc, Cybered's finding on the a7accbfb gate)
//
// WHAT WENT WRONG WITHOUT THIS. src/local-llm-router.ts was committed at 09:51, the card sat at 100%
// with a REVIEW, two gates passed it -- and the live path (store/local-llm-rag.sh -> dist/
// local-llm-router.js, built 07:34) went on running the PREVIOUS routing logic. Both gates read the
// source and the tests; neither read the artifact. The missing build was already handled fail-closed
// ("router not built" -> online); the STALE build was accepted in silence.
//
// WHY THE SILENCE IS NOT SURVIVABLE, even though that particular time it helped: the older reading
// was WIDER, so it sent more work online -- the accident fell the safe way. Reverse the sign of the
// change (a tightening, a new security category, a fixed signal list) and the same silence means the
// tightening never reaches the live path while the board says "done".
//
// THIS FILE IS DELIBERATELY NOT COMPILED. A freshness check that lived in dist/ would be part of the
// artifact it is judging: the stale build would run the stale checker. Shipped as .mjs (same as
// store/route-histogram.mjs, store/usage-share.mjs), it cannot go stale, and the signal it reads --
// mtimes of the source tree on disk -- comes from OUTSIDE the build entirely. That is condition 1 of
// the card: no artifact may certify its own freshness.
import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, resolve, relative, sep } from 'node:path'

/** Relative specifiers in emitted JS: `from './x.js'`, `import('../y.js')`, `export * from './z.js'`. */
const REL_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g

/**
 * Every dist module the entry actually pulls in, transitively.
 *
 * SCOPE, and why not the whole of src/: `tsc` compiles the project in one pass, so "is the build
 * stale" could be asked about all 591 source files -- but only the modules the router LOADS can
 * change how it routes, and the closure is measurably cheaper (19 modules / ~2.7ms vs 591 files /
 * ~18ms, measured on this box). This runs on every offload call, so the cost matters (condition 2).
 *
 * Completeness, since a reader will ask what happens to a source file that is not in the dist graph
 * yet: adding an import to a source file also CHANGES that file, and that file is in the closure, so
 * its own mtime trips the check. A new module cannot appear without an existing one referring to it.
 */
function distClosure(entry) {
  const seen = new Set()
  const stack = [resolve(entry)]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let text
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      continue // unreadable member: reported by the caller loop below as undecidable
    }
    for (const m of text.matchAll(REL_IMPORT)) stack.push(resolve(dirname(file), m[1]))
  }
  return [...seen]
}

/** dist/a/b.js -> src/a/b.ts (or .tsx). Returns null when no source counterpart exists. */
function sourceFor(distFile, distRoot, srcRoot) {
  const rel = relative(distRoot, distFile)
  if (rel.startsWith('..') || rel === '') return null
  const base = resolve(srcRoot, rel).replace(/\.js$/, '')
  for (const ext of ['.ts', '.tsx', '.mts']) {
    if (existsSync(base + ext)) return base + ext
  }
  return null
}

/**
 * @returns {{status:'fresh'|'stale'|'unknown', reason:string, checked:number}}
 *   fresh   - every loaded module's artifact is at least as new as its source
 *   stale   - at least one source is NEWER than the artifact built from it
 *   unknown - freshness could not be established (no source tree, unreadable mtime, missing entry)
 *
 * `unknown` is NOT `fresh`. A caller that cannot tell whether the judge is current has not been told
 * that it is (condition 3); on a dist-only deployment that means every call routes online, which is
 * the correct answer for a box that cannot verify what it is running.
 */
export function checkBuildFreshness(entry, opts = {}) {
  const entryPath = resolve(entry)
  const distRoot = resolve(opts.distRoot ?? dirname(entryPath))
  const srcRoot = resolve(opts.srcRoot ?? resolve(distRoot, '..', 'src'))

  if (!existsSync(entryPath)) return { status: 'unknown', reason: `no artifact at ${entryPath}`, checked: 0 }
  if (!existsSync(srcRoot)) {
    return { status: 'unknown', reason: `no source tree at ${srcRoot}, cannot tell whether ${relative(distRoot, entryPath)} is current`, checked: 0 }
  }

  const modules = distClosure(entryPath)
  for (const distFile of modules) {
    const srcFile = sourceFor(distFile, distRoot, srcRoot)
    if (!srcFile) {
      return { status: 'unknown', reason: `no source found for ${shortName(distFile, distRoot)}`, checked: modules.length }
    }
    let distTime, srcTime
    try {
      distTime = statSync(distFile).mtimeMs
      srcTime = statSync(srcFile).mtimeMs
    } catch (e) {
      return { status: 'unknown', reason: `cannot read mtime of ${shortName(distFile, distRoot)} (${e.message})`, checked: modules.length }
    }
    if (srcTime > distTime) {
      const drift = Math.round((srcTime - distTime) / 1000)
      return {
        status: 'stale',
        reason: `src${sep}${relative(srcRoot, srcFile)} is ${drift}s newer than its build -- run \`npm run build\``,
        checked: modules.length,
      }
    }
  }
  return { status: 'fresh', reason: `${modules.length} loaded modules are all newer than their sources`, checked: modules.length }
}

function shortName(file, distRoot) {
  const rel = relative(distRoot, file)
  return rel.startsWith('..') ? file : `dist${sep}${rel}`
}

// CLI, for a human asking the same question the offload path asks on every call:
//   node store/build-freshness.mjs [dist/local-llm-router.js]
// exit 0 = fresh, 1 = stale, 2 = unknown -- so a script can branch on it without parsing prose.
if (import.meta.url === `file://${process.argv[1]}`) {
  const entry = process.argv[2] ?? resolve(dirname(new URL(import.meta.url).pathname), '..', 'dist', 'local-llm-router.js')
  const r = checkBuildFreshness(entry)
  console.log(`${r.status}: ${r.reason}`)
  process.exit(r.status === 'fresh' ? 0 : r.status === 'stale' ? 1 : 2)
}
