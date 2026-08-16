import { readdirSync, lstatSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

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
