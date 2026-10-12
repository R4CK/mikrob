import { readdirSync, lstatSync, statSync, existsSync, openSync, writeSync, closeSync, constants, realpathSync } from 'node:fs'
import { join, resolve, sep, dirname, basename } from 'node:path'

// NFD + combining-mark strip so Hungarian input like "etrendiro" decays
// to "etrendiro" instead of silently losing every accented character
// and producing "trendr".
export function sanitizeAgentName(raw: string): string {
  return raw.trim().toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

// Same rules as sanitizeAgentName -- used for skill names to prevent path traversal.
export function sanitizeSkillName(raw: string): string {
  return sanitizeAgentName(raw)
}

export function sanitizeScheduleName(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Joins segments and verifies the resolved path stays inside `base`. Throws on escape.
export function safeJoin(base: string, ...parts: string[]): string {
  const resolvedBase = resolve(base)
  const target = resolve(base, ...parts)
  if (target !== resolvedBase && !target.startsWith(resolvedBase + sep)) {
    throw new Error(`Path traversal rejected: ${parts.join('/')}`)
  }
  return target
}

// Card 25aaada5 (WhiteHat F1 on 3d186397's safeJoin fix): safeJoin proves the RESOLVED STRING
// stays inside base -- it says nothing about whether an existing filesystem entry at that exact
// path is itself a symlink pointing somewhere else. Measured: a symlink already sitting at
// `approved/<name>` (planted by anything with write access to the agent's own state directory --
// the same UID the shared fleet bearer runs as, e.g. a prompt-injected sub-agent) makes a plain
// writeFileSync() silently write through it to the symlink's target, outside `approved/`
// entirely, even though the PATH STRING passed safeJoin. O_NOFOLLOW on the open() makes that
// open fail (ELOOP) instead of following the link, so the caller sees a thrown error and the
// write never happens -- fail-closed, matching the traversal rejection's own posture.
//
// Delta (RedHat NO-GO 16934, B1): O_NOFOLLOW only protects the LAST path component. If
// `approved/` ITSELF, or an intermediate component (the `sub` in `sub/id`), is a symlink, the
// open() still walks through it to resolve the parent directory before ever looking at the
// final NOFOLLOW check -- measured: approved/ as a symlink to an external directory let a
// write land there, unattended auto-approve included.
//
// Delta #2 (RedHat NO-GO 17101, B1'): a plain realpathSync(dirname)-then-open is two separate
// syscalls with a window between them -- if the directory is swapped (real dir -> symlink) in
// that window, the check passes against the OLD (real) directory but the open() walks the NEW
// (symlinked) one. Measured by RedHat with a child process toggling `approved/` in a tight loop:
// ~7% of 120000 calls landed outside the sandbox. Fix (RedHat's own "stronger form"): open the
// PARENT DIRECTORY itself with O_NOFOLLOW (which atomically refuses if the last component is a
// symlink), confirm via /proc/self/fd/<fd> that the fd really is the directory we expect, then
// open the marker file BY PATH THROUGH THAT SAME FD (/proc/self/fd/<fd>/<name>) -- an fd, once
// obtained, keeps referring to the same directory inode no matter what happens to the path
// afterward, closing the TOCTOU window entirely (0/120000 in RedHat's repro). Falls back to the
// single-syscall realpath check on a platform without /proc/self/fd (stated explicitly, per
// RedHat's note, rather than silently losing the hardening there).
const HAS_PROC_SELF_FD = existsSync('/proc/self/fd')

export function writeFileNoFollowSync(path: string, content: string): void {
  const dir = dirname(path)
  const name = basename(path)
  const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

  if (!HAS_PROC_SELF_FD) {
    const realDir = realpathSync(dir)
    if (realDir !== resolve(dir)) {
      throw new Error(`writeFileNoFollowSync: refusing to write through a symlinked directory (${dir} -> ${realDir})`)
    }
    const fd = openSync(path, writeFlags, 0o666)
    try {
      writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
    return
  }

  const dirFd = openSync(dir, constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const realDir = realpathSync(`/proc/self/fd/${dirFd}`)
    if (realDir !== resolve(dir)) {
      throw new Error(`writeFileNoFollowSync: refusing to write through a symlinked directory (${dir} -> ${realDir})`)
    }
    const fd = openSync(`/proc/self/fd/${dirFd}/${name}`, writeFlags, 0o666)
    try {
      writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
  } finally {
    closeSync(dirFd)
  }
}

// Card 25aaada5 B2 (MikroB 16759, WhiteHat2 F1 on 3d186397): safeJoin only proves the resolved
// path stays INSIDE approvedDir -- it does not reject shapes that resolve inside it but are
// still unusable as a filename: the empty string, '.', a component containing '/' or '\' (e.g.
// 'sub/id' -- walks into a subdirectory, or 'x/..' -- resolves to approvedDir itself, EISDIR on
// open), an embedded NUL byte, or an unreasonably long name. Each of these passed safeJoin,
// then failed at some OTHER layer (EISDIR, a NUL rejected deep inside writeFileSync, kernel
// ENAMETOOLONG) -- always AFTER the allowFrom mutation had already run, because that failure
// surfaced through the route's generic try/catch rather than being rejected up front. No
// per-channel-provider senderId format (telegram/slack/discord/googlechat/teams) is confirmed
// anywhere in this codebase, so this is deliberately a denylist of the specific pathological
// shapes measured, not a guessed positive format that could reject some other provider's
// legitimate id.
//
// Delta (RedHat NO-GO 17101, N2): the length cap was 200 UTF-16 code units, but the filesystem's
// own name-length limit is 255 BYTES -- a string of 86 three-byte characters is 258 bytes (over
// the real limit) while reading as only 86 code units (well under 200), so it passed this check
// and then failed deeper (ENAMETOOLONG), after the mutation, the exact pattern this whole
// denylist exists to avoid. Checking Buffer.byteLength against the real 255-byte limit closes
// that gap. The denylist also only rejected NUL, not any other control character (tab, newline,
// leading space) -- widened to the full C0 control range plus DEL.
export function isPlausibleChannelSenderId(senderId: string): boolean {
  if (typeof senderId !== 'string' || senderId.length === 0) return false
  if (Buffer.byteLength(senderId, 'utf8') > 255) return false
  if (senderId === '.' || senderId === '..') return false
  if (senderId.includes('/') || senderId.includes('\\')) return false
  if (/[\x00-\x1f\x7f]/.test(senderId)) return false
  return true
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// A symlink inside an extracted archive can point outside baseDir -- a skill file
// import that follows it would read/write arbitrary paths. Rejects any entry that
// is itself a symlink or contains one anywhere inside it (recursively), so a
// partial fix in one caller can't leave the other with an unprotected copy (card
// bb0ae7fa: this walk previously existed twice, byte-identical, in
// routes/skills.ts and routes/agents-skills.ts).
function containsSymlink(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return true
    if (st.isDirectory() && containsSymlink(p)) return true
  }
  return false
}

export function findSymlinkTaintedEntries(baseDir: string, entries: string[]): string[] {
  const tainted: string[] = []
  for (const entry of entries) {
    const p = join(baseDir, entry)
    try {
      if (lstatSync(p).isSymbolicLink() || (statSync(p).isDirectory() && containsSymlink(p))) {
        tainted.push(entry)
      }
    } catch { /* ignored */ }
  }
  return tainted
}
