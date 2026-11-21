// FLEETVENV923: the fleet's shared Python virtualenv, resolved ONCE, for every
// launcher. When `<dir>/bin` exists it goes first on the agent launch PATH, so a
// skill's plain `python3` and the venv's own CLIs (markitdown, ...) resolve to
// the venv without per-skill interpreter paths.
//
// Kept small on purpose (node builtins + the .env grammar only): the dashboard
// launchers reach it through config.ts, and scripts/channels.sh reaches the SAME
// functions through scripts/fleet-venv-prefix.mjs -> dist/fleet-venv.js. Before
// that, channels.sh parsed .env with grep/cut on its own and disagreed with the
// TypeScript side on quoted values, on an empty value and on a Settings-page
// override (#1626 review), so a normal boot and a recovery respawn of the same
// main session could get different PATHs.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { parseEnvContent } from './env-parse.js'

export const FLEET_PYTHON_VENV_KEY = 'FLEET_PYTHON_VENV'

/**
 * The venv directory, in the settings-store order: a non-empty value in
 * store/config-overrides.json (the Settings page) wins, then .env, then the
 * default, which is EMPTY = off (the upstream ships no install-specific
 * directory; an install that has a venv sets the key). A leading `~` means
 * `home`. `envDir` is where .env lives (config.ts passes env.ts's own choice).
 */
export function resolveFleetVenvDir(projectRoot: string, home: string = homedir(), envDir: string = projectRoot): string {
  let raw = ''
  const override = readOverride(projectRoot)
  if (override !== undefined) {
    raw = override
  } else {
    try {
      raw = parseEnvContent(readFileSync(join(envDir, '.env'), 'utf-8'), [FLEET_PYTHON_VENV_KEY])[FLEET_PYTHON_VENV_KEY] ?? ''
    } catch {
      raw = ''
    }
  }
  return raw.startsWith('~') ? join(home, raw.slice(1)) : raw
}

// Same rule as config.ts cfg(): only a non-null, non-empty override counts.
function readOverride(projectRoot: string): string | undefined {
  try {
    const p = join(projectRoot, 'store', 'config-overrides.json')
    if (!existsSync(p)) return undefined
    const ov = (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>)[FLEET_PYTHON_VENV_KEY]
    return ov !== undefined && ov !== null && String(ov).length > 0 ? String(ov) : undefined
  } catch {
    return undefined
  }
}

/**
 * The `<venv>/bin:` PATH prefix, or '' when the setting is off or `<venv>/bin`
 * does not exist. `refused` = the path is relative, carries a shell-active character (`"`,
 * `$`, backtick, backslash) that the double-quoted `export PATH="..."` of a
 * launch command would re-interpret, or fails the use-time integrity check
 * (see `useTimeIntegrityReason`): skipped rather than escaped/trusted, because
 * a fleet venv in that state is either a config mistake or a hijack attempt.
 * `reason` names which check failed, for a descriptive log line at the call
 * site (card 29803f39: a plain boolean told the operator nothing). `exists`
 * is the test seam for the bin/ existence check only -- the integrity check
 * below always reads the real filesystem, since uid/mode/symlink state is
 * exactly what a seam would let a test fake past.
 */
export function fleetVenvBin(venvDir: string, exists: (p: string) => boolean = existsSync): { prefix: string; refused: boolean; reason?: string } {
  if (!venvDir) return { prefix: '', refused: false }
  // Absolute only (after ~ expansion): a relative `venv` would resolve against
  // each launch command's own `cd`, i.e. a different directory per agent, and
  // the shell side rejects it anyway (#1626 review). Refused, not guessed.
  if (!isAbsolute(venvDir)) return { prefix: '', refused: true, reason: 'the path is not absolute' }
  const bin = join(venvDir, 'bin')
  if (!exists(bin)) return { prefix: '', refused: false }
  if (/["$`\\]/.test(bin)) return { prefix: '', refused: true, reason: 'the path contains a shell-active character (", $, `, \\)' }
  const integrityReason = useTimeIntegrityReason(venvDir)
  if (integrityReason) return { prefix: '', refused: true, reason: integrityReason }
  return { prefix: `${bin}:`, refused: false }
}

/**
 * Use-time check (card 29803f39, follow-up to the write-time check in
 * config-registry.ts's validateFleetPythonVenvDir, card 2bf0d884): the
 * write-time check only runs once, when the Settings page saves the value --
 * a directory that was safe then can be chmod'd open, or have its bin/
 * replaced, any time after, and every later launch would still trust it.
 * This re-checks on every launch: realpath resolution, uid ownership of the
 * directory and bin/, no group/other-write bit anywhere from the directory up
 * to the filesystem root (ownership is not required on parents -- only
 * writability, since e.g. `/` is root-owned on every real install -- but a
 * writable parent would let an attacker replace the venv directory itself),
 * and bin/python3 not a symlink pointing outside the venv directory. Returns
 * a reason string on failure, null when the directory passes.
 */
function useTimeIntegrityReason(venvDir: string): string | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid === null) return null // non-POSIX platform: nothing to compare against
  let real: string
  try {
    real = realpathSync(venvDir)
  } catch {
    return `realpath resolution of ${venvDir} failed`
  }
  const bin = join(real, 'bin')
  let dirSt: ReturnType<typeof statSync>
  let binSt: ReturnType<typeof statSync>
  try {
    dirSt = statSync(real)
    binSt = statSync(bin)
  } catch {
    return `${real} or its bin/ could not be stat'd`
  }
  if (dirSt.uid !== uid || binSt.uid !== uid) {
    return `${real} or its bin/ is not owned by the fleet process's own uid`
  }
  if ((binSt.mode & 0o022) !== 0) {
    return `${bin} is group- or other-writable`
  }
  if ((dirSt.mode & 0o022) !== 0) {
    return `${real} is group- or other-writable`
  }
  // Parents only (not the venv directory itself, held to the stricter rule
  // above): a world-writable parent WITH the sticky bit (the standard
  // /tmp, /var/tmp convention) cannot be used to delete or rename an
  // existing entry owned by another uid, so it cannot swap out `real`
  // itself -- only add unrelated new entries alongside it. Without the
  // sticky bit, that protection does not exist.
  let p = dirname(real)
  while (true) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(p)
    } catch {
      return `${p} could not be stat'd`
    }
    const writable = (st.mode & 0o022) !== 0
    const sticky = (st.mode & 0o1000) !== 0
    if (writable && !sticky) {
      return `${p} is group- or other-writable without the sticky bit`
    }
    const parent = dirname(p)
    if (parent === p) break
    p = parent
  }
  const py = join(bin, 'python3')
  try {
    const lst = lstatSync(py)
    if (lst.isSymbolicLink()) {
      const target = realpathSync(py)
      if (target !== py && !target.startsWith(`${real}/`)) {
        return `${py} is a symlink pointing outside the venv directory`
      }
    }
  } catch {
    // bin/python3 missing is not this check's concern.
  }
  return null
}
