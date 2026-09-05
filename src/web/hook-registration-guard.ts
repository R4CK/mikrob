import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'

// Guard + self-heal for hook registration into user-global settings.json.
//
// Incident (2026-07-11): an app instance started from a git worktree (a
// WEB_ONLY smoke instance under .claude/worktrees/agent-XXXX) ran the startup
// hook backfill and registered UserPromptSubmit / SessionStart hooks into the
// USER-GLOBAL ~/.claude/settings.json with absolute paths rooted in its own
// (temporary) PROJECT_ROOT. When the worktree was deleted, python3 exited 2
// ("can't open file") -- and a non-zero UserPromptSubmit hook BLOCKS the
// prompt, so the main agent went deaf to all inbound messages until the stale
// entries were removed by hand.
//
// Two layers:
//   1. shouldRegisterHooks(): skip registration entirely when the running
//      instance is a worktree checkout (its PROJECT_ROOT is temporary) or a
//      WEB_ONLY staging instance (not the install that owns the settings).
//   2. pruneStaleHookEntries(): during normal startup, remove entries THIS
//      app previously wrote whose script file no longer exists. Foreign hook
//      entries (not our script names, not worktree-pathed) are never touched.

// Hook script filenames this app registers into settings.json files
// (templates/settings.json.template, ensureAgentStalenessHook, the
// PreToolUse gates, and the telegram-progress installer). Used to decide
// whether a missing-file hook entry is OURS (prunable) or foreign (kept).
export const KNOWN_HOOK_SCRIPTS: readonly string[] = [
  'taskstate-replay.py',
  'voice-reply-directive.py',
  'staleness-guard.py',
  'email-send-gate.mjs',
  'self-pace-gate.mjs',
  'telegram_progress.py',
  'telegram_progress_clear.py',
  'telegram_progress_watchdog.py',
  'inbox-drain.py',
  'channel-inbox-drain.py',
  'ledger-capture.py',
  // Card 74181db2: this app now registers the outgoing-copy-gate into ROLE agents'
  // settings too (it used to reach only the main agent's, which is written from
  // templates/settings.json.template rather than from here).
  //
  'outgoing-copy-gate.py',
  // Card 83d970fa (QA, on the 0c66be37 gate): the ACKNOWLEDGED_CONFLICTS entry for this file
  // records a UNION with upstream, but the array carried only the fork's half -- the documented
  // decision and the code had drifted apart. This closes ONE of the three; the other two are
  // deliberately NOT here, and the reason is the direction of the failure.
  //
  // Adding a name here makes a settings entry naming it PRUNABLE once its script file is missing.
  // Measured in this checkout: `skill-usage-capture.py` EXISTS (scripts/hooks/, with its own unit
  // tests), so listing it costs nothing today and is right the moment anything registers it.
  // `clear-capture.py` and `clear-replay.py` do NOT exist here -- they arrive with the upstream
  // merge.
  //
  // WHICH INSTALL LISTING THEM EARLY WOULD HURT, stated in the direction pruneStaleHookEntries
  // actually works: it reads the LOCAL settings.json and asks the LOCAL fileExists. An install that
  // HAS the script keeps its entry -- fileExists is true, so the entry is never stale and the
  // pruner does not touch it. The population at risk is the mirror image: HAS the entry, LACKS the
  // file. That is exactly this fork checkout before the merge, where an agent's settings can already
  // carry upstream's entry (they are copied from the shared ~/.claude) while the script is not here
  // yet. Listing the names now would delete that registration BEFORE the script arrives with the
  // merge, and nothing writes it back: this app has no inject*/ensure* for either name, so the union
  // rule would have nothing left to apply to. It applies AT MERGE TIME, when the scripts arrive with
  // it; see the invariant test, which executes this paragraph rather than restating it.
  'skill-usage-capture.py',

  // Card 38c5e758: the nine Bash-matcher gates this app also writes. They were absent for a long
  // time and the earlier comment here called that harmless, on the reasoning that an unlisted
  // entry reads as foreign and is KEPT rather than pruned. Kept is right; harmless is only true
  // for two of the nine, and the measurement says which:
  //
  //   node <missing>.mjs   -> exit 1  -- NOT a blocking status, so the gate silently does nothing
  //   python3 <missing>.py -> exit 2  -- which is exactly the status PreToolUse treats as BLOCK
  //
  // The seven python gates are wired as a bare `python3 "<abs path>"` (unlike the staleness hook,
  // which uses a `[ -f ... ] && exec` fail-open wrapper). So if one of those script files is not
  // where the entry says -- an install moved, a path renamed, settings written by a different
  // checkout -- that agent's EVERY Bash call is blocked, not degraded. And while the name is
  // absent from this list, pruneStaleHookEntries reads the entry as foreign and refuses to touch
  // it, so the block is permanent until somebody edits settings.json by hand.
  //
  // Listing them is therefore what makes the self-heal reach the case that actually hurts: the
  // entry is removed on the next dashboard boot instead of wedging the pane. The existence
  // invariant below (card 83d970fa) covers these automatically -- a name here must name a script
  // that exists, so a future rename cannot leave a prunable ghost behind.
  'egress-gate.mjs',
  'kanban-write-gate.mjs',
  'git-protect-guard.py',
  'npm-protect-guard.py',
  'cd-chain-guard.py',
  'noisy-command-guard.py',
  'blast-radius-guard.py',
  'symlinked-node-modules-guard.py',
  'pentest-tool-install-guard.py',
]

// Path fragment that marks a checkout as an agent worktree. Kept
// separator-agnostic by normalizing before matching.
const WORKTREES_FRAGMENT = '/.claude/worktrees/'

function normalizeSeparators(p: string): string {
  return p.split(sep).join('/')
}

// True when the .git entry at the given root is a FILE (a linked worktree's
// gitdir pointer) rather than a directory (a normal checkout's object store).
// This is the generic worktree signal: in every `git worktree add` checkout,
// .git is a plain file, so PROJECT_ROOT differs from the common dir's toplevel.
function gitEntryIsFile(root: string): boolean {
  try {
    return statSync(join(root, '.git')).isFile()
  } catch {
    return false
  }
}

// Is the resolved project root a git-worktree checkout (and therefore a
// temporary location that must never be baked into user-global settings)?
// The isGitFile dependency is injectable so the decision logic is unit-testable
// without a real filesystem.
export function isWorktreeRoot(
  projectRoot: string,
  deps: { isGitFile?: (root: string) => boolean } = {},
): boolean {
  const normalized = normalizeSeparators(projectRoot)
  if (normalized.includes(WORKTREES_FRAGMENT)) return true
  return (deps.isGitFile ?? gitEntryIsFile)(projectRoot)
}

// Temp-dir prefixes that mark a checkout as transient. A plain `git clone` under
// a temp dir (NOT a git worktree, so isWorktreeRoot misses it) is exactly the
// canary / second-instance case: 2026-07-13 a develop canary started from
// /private/tmp/marveen-work registered hooks into the USER-GLOBAL settings.json
// with /tmp-rooted paths -- the same deaf-agent trap isWorktreeRoot was added to
// prevent, one class wider. A real install never runs from a temp dir, so
// skipping here can never suppress a legitimate owner's registration.
const TEMP_ROOT_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

// Is the project root under a temporary directory (a transient second instance
// -- canary, throwaway clone -- that does not own the user's settings)? The
// tmpDir dependency is injectable so the OS tmpdir is included and the logic is
// unit-testable without touching the environment.
export function isTemporaryRoot(
  projectRoot: string,
  deps: { tmpDir?: string } = {},
): boolean {
  const normalized = normalizeSeparators(projectRoot)
  const prefixes = [...TEMP_ROOT_PREFIXES]
  if (deps.tmpDir) {
    const t = normalizeSeparators(deps.tmpDir).replace(/\/+$/, '') + '/'
    prefixes.push(t)
  }
  return prefixes.some((p) => normalized.startsWith(p))
}

export interface HookRegistrationDecision {
  register: boolean
  reason?: string
}

// Central decision: may this instance register hooks into settings.json?
// Skips worktree checkouts, temp-dir clones (both temporary PROJECT_ROOTs), and
// WEB_ONLY staging instances (not the install that owns the user's settings).
export function shouldRegisterHooks(opts: {
  projectRoot: string
  webOnly: boolean
  isGitFile?: (root: string) => boolean
  tmpDir?: string
}): HookRegistrationDecision {
  if (isWorktreeRoot(opts.projectRoot, { isGitFile: opts.isGitFile })) {
    return { register: false, reason: 'project root is a git worktree checkout (temporary path)' }
  }
  if (isTemporaryRoot(opts.projectRoot, { tmpDir: opts.tmpDir })) {
    return { register: false, reason: 'project root is under a temp dir (transient second instance)' }
  }
  if (opts.webOnly) {
    return { register: false, reason: 'WEB_ONLY staging mode' }
  }
  return { register: true }
}

type CommandHook = { type?: string; command?: string; [k: string]: unknown }
type HookGroup = { hooks?: CommandHook[]; [k: string]: unknown }

// Extract the candidate script paths from a hook command string: tokens that
// end with one of our known hook script names, or that point into a
// .claude/worktrees/ checkout. Anything else in the command is ignored, so a
// foreign hook that merely mentions python3 is never considered ours.
function ourScriptPaths(command: string, knownScripts: readonly string[]): string[] {
  const paths: string[] = []
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^['"]+|['"]+$/g, '')
    if (!token) continue
    const normalized = normalizeSeparators(token)
    const base = normalized.slice(normalized.lastIndexOf('/') + 1)
    if (knownScripts.includes(base) || normalized.includes(WORKTREES_FRAGMENT)) {
      paths.push(token)
    }
  }
  return paths
}

export interface PruneResult {
  changed: boolean
  removed: string[]
}

// Self-heal: remove hook entries this app previously wrote whose script file
// no longer exists on disk. An entry is prunable only when BOTH hold:
//   - its command references a path matching our known hook script names, or
//     a path inside a .claude/worktrees/ checkout, AND
//   - that referenced file is missing.
// Everything else (foreign commands, agent-type hooks, our entries whose file
// still exists) is preserved byte-identically. Mutates `settings` in place;
// the caller persists it (read-modify-write with an atomic write).
export function pruneStaleHookEntries(
  settings: Record<string, unknown>,
  opts: { fileExists: (path: string) => boolean; knownScripts?: readonly string[] },
): PruneResult {
  const knownScripts = opts.knownScripts ?? KNOWN_HOOK_SCRIPTS
  const removed: string[] = []
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { changed: false, removed }
  const hooksRecord = hooks as Record<string, unknown>

  for (const [event, groups] of Object.entries(hooksRecord)) {
    if (!Array.isArray(groups)) continue
    const keptGroups: HookGroup[] = []
    let eventChanged = false
    for (const group of groups as HookGroup[]) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        keptGroups.push(group)
        continue
      }
      const keptHooks = group.hooks.filter((h) => {
        if (!h || typeof h !== 'object' || h.type !== 'command' || typeof h.command !== 'string') return true
        const scriptPaths = ourScriptPaths(h.command, knownScripts)
        if (scriptPaths.length === 0) return true // foreign entry: never touch
        const stale = scriptPaths.some((p) => !opts.fileExists(p))
        if (stale) removed.push(h.command)
        return !stale
      })
      if (keptHooks.length !== group.hooks.length) {
        eventChanged = true
        // Drop the group entirely when pruning emptied it; a matcher with no
        // hooks is dead weight. Groups that keep at least one hook survive.
        if (keptHooks.length > 0) keptGroups.push({ ...group, hooks: keptHooks })
      } else {
        keptGroups.push(group)
      }
    }
    // Collapse EXACT duplicate groups (card bb7276e7). Measured 2026-08-06: 13 of 14 fleet
    // agents plus the main settings.json carried the SAME UserPromptSubmit group twice, so
    // staleness-guard.py and voice-reply-directive.py each ran twice on every prompt. That is
    // not only a wasted subprocess pair per wakeup -- voice-reply-directive WRITES to stdout
    // (the voice transcript + directive), and a UserPromptSubmit hook's stdout is injected into
    // the model context, so a voice message was being injected TWICE.
    //
    // Byte-identical groups only (canonical JSON compare): two groups that differ in matcher,
    // timeout, or order are deliberate configuration and are preserved untouched. Dropping an
    // exact duplicate cannot change behaviour, because running the same command twice with the
    // same input is what we are removing.
    const seen = new Set<string>()
    const deduped: HookGroup[] = []
    for (const group of keptGroups) {
      const key = JSON.stringify(group)
      if (seen.has(key)) {
        eventChanged = true
        for (const h of group?.hooks ?? []) {
          if (h && typeof h === 'object' && typeof h.command === 'string') {
            removed.push(`[duplicate] ${h.command}`)
          }
        }
        continue
      }
      seen.add(key)
      deduped.push(group)
    }

    if (eventChanged) {
      if (deduped.length > 0) hooksRecord[event] = deduped
      else delete hooksRecord[event]
    }
  }
  return { changed: removed.length > 0, removed }
}

// File-level wrapper: parse a settings.json, prune stale entries, and write it
// back atomically when anything changed. Unparseable or missing files are left
// untouched (never destroy a user's settings on a parse error). Returns the
// pruned command strings for logging.
export function pruneStaleHooksFromSettingsFile(settingsPath: string): string[] {
  if (!existsSync(settingsPath)) return []
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return []
  }
  if (!settings || typeof settings !== 'object') return []
  const { changed, removed } = pruneStaleHookEntries(settings, { fileExists: existsSync })
  if (changed) atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return removed
}
