import { existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, isAbsolute, basename } from 'node:path'
import { execSync, spawn } from 'node:child_process'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { readFileOr } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

const SETTINGS_PATH = join(PROJECT_ROOT, 'store', 'dashboard-settings.json')
const GITHUB_REPOS_DIR = join(PROJECT_ROOT, 'store', 'github-repos')

interface GitHubRepo {
  url: string
  name: string
  path: string
  installedAt: string
  envVars?: Record<string, string>  // env key -> vault secret id
}

interface DashboardSettings {
  externalProjectPaths?: string[]
  githubRepos?: GitHubRepo[]
}

function read(): DashboardSettings {
  try { return JSON.parse(readFileOr(SETTINGS_PATH, '{}')) }
  catch { return {} }
}

function write(s: DashboardSettings): void {
  atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + '\n')
}

export function getExternalProjectPaths(): string[] {
  return read().externalProjectPaths || []
}

export function addExternalProjectPath(raw: string): { paths: string[], error?: string } {
  if (!raw || !isAbsolute(raw)) return { paths: getExternalProjectPaths(), error: 'Absolute path required' }
  const p = resolve(raw)
  if (!existsSync(p) || !statSync(p).isDirectory()) return { paths: getExternalProjectPaths(), error: 'Directory does not exist' }
  const s = read()
  const list = s.externalProjectPaths || []
  if (list.includes(p)) return { paths: list }
  list.push(p)
  s.externalProjectPaths = list
  write(s)
  return { paths: list }
}

export function removeExternalProjectPath(raw: string): string[] {
  const p = resolve(raw)
  const s = read()
  s.externalProjectPaths = (s.externalProjectPaths || []).filter(x => x !== p)
  write(s)
  return s.externalProjectPaths
}

// --- GitHub repo management ---

const GITHUB_URL_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/

function parseGitHubUrl(url: string): { owner: string, repo: string } | null {
  const m = url.match(GITHUB_URL_RE)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

export function getGitHubRepos(): GitHubRepo[] {
  return read().githubRepos || []
}

export interface GitHubInstallProgress {
  stage: 'cloning' | 'installing' | 'done' | 'error'
  message: string
}

export function detectRequiredEnvVars(repoPath: string): string[] {
  const mcpJsonPath = join(repoPath, '.mcp.json')
  if (!existsSync(mcpJsonPath)) return []
  try {
    const parsed = JSON.parse(readFileOr(mcpJsonPath, '{}'))
    const servers = parsed.mcpServers || {}
    const vars = new Set<string>()
    for (const cfg of Object.values(servers) as any[]) {
      for (const key of Object.keys(cfg?.env || {})) vars.add(key)
    }
    return [...vars]
  } catch { return [] }
}

export async function installGitHubRepo(
  url: string,
  envVars?: Record<string, string>,
  onProgress?: (p: GitHubInstallProgress) => void,
): Promise<{ repo: GitHubRepo, requiredEnvVars?: string[], error?: never } | { repo?: never, requiredEnvVars?: string[], error: string }> {
  const parsed = parseGitHubUrl(url)
  if (!parsed) return { error: 'Invalid GitHub URL' }

  const repoName = `${parsed.owner}--${parsed.repo}`
  const targetDir = join(GITHUB_REPOS_DIR, repoName)

  if (existsSync(targetDir)) {
    const existing = getGitHubRepos().find(r => r.name === repoName)
    if (existing) return { error: `Already installed: ${repoName}` }
    rmSync(targetDir, { recursive: true, force: true })
  }

  mkdirSync(GITHUB_REPOS_DIR, { recursive: true })

  const cloneUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`

  onProgress?.({ stage: 'cloning', message: `Cloning ${parsed.owner}/${parsed.repo}...` })
  try {
    execSync(`git clone --depth 1 ${cloneUrl} ${targetDir}`, {
      timeout: 120000,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
  } catch (err: any) {
    rmSync(targetDir, { recursive: true, force: true })
    return { error: `Clone failed: ${err.stderr || err.message}` }
  }

  const hasPackageJson = existsSync(join(targetDir, 'package.json'))
  if (hasPackageJson) {
    onProgress?.({ stage: 'installing', message: 'Running npm install...' })
    try {
      execSync('npm install --production 2>&1', {
        cwd: targetDir,
        timeout: 180000,
        encoding: 'utf-8',
        stdio: 'pipe',
      })
    } catch (err: any) {
      logger.warn({ err: err.message }, 'npm install failed for GitHub repo, continuing anyway')
    }
  }

  const requiredEnvVars = detectRequiredEnvVars(targetDir)

  const repo: GitHubRepo = {
    url,
    name: repoName,
    path: targetDir,
    installedAt: new Date().toISOString(),
    envVars: envVars || undefined,
  }

  const s = read()
  const repos = s.githubRepos || []
  repos.push(repo)
  s.githubRepos = repos
  const paths = s.externalProjectPaths || []
  if (!paths.includes(targetDir)) {
    paths.push(targetDir)
    s.externalProjectPaths = paths
  }
  write(s)

  onProgress?.({ stage: 'done', message: `Installed ${repoName}` })
  return { repo, requiredEnvVars: requiredEnvVars.length > 0 ? requiredEnvVars : undefined }
}

export function removeGitHubRepo(name: string): { ok: boolean, error?: string } {
  const s = read()
  const repos = s.githubRepos || []
  const idx = repos.findIndex(r => r.name === name)
  if (idx === -1) return { ok: false, error: 'Repo not found' }

  const repo = repos[idx]
  if (existsSync(repo.path)) {
    rmSync(repo.path, { recursive: true, force: true })
  }

  repos.splice(idx, 1)
  s.githubRepos = repos
  s.externalProjectPaths = (s.externalProjectPaths || []).filter(p => p !== repo.path)
  write(s)
  return { ok: true }
}

/**
 * Is this repo registered in store/watched-repos.json as an EXECUTABLE (type=code) adoption?
 *
 * store/git-repo-watcher.sh classifies adoptions: `text` (docs/skills) fast-forwards freely, `code`
 * is DETECTED + FLAGGED for a supply-chain review and never auto-applied. The one-click Update button
 * must honour that same verdict, otherwise the guarantee the watcher provides is trivially bypassed
 * from the dashboard. Unreadable/absent registry -> not flagged (the lifecycle-script fix below is
 * what actually closes the RCE; this is defence in depth on top of it).
 */
function requiresReviewBeforeUpdate(repoPath: string, repoUrl: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileOr(join(PROJECT_ROOT, 'store', 'watched-repos.json'), '[]'))
    if (!Array.isArray(raw)) return false
    const norm = (u: string) => u.replace(/\.git$/, '').replace(/\/+$/, '')
    return raw.some((r: any) => {
      if (!r || typeof r !== 'object') return false
      const sameRepo = (r.local && resolve(String(r.local)) === resolve(repoPath))
        || (r.repo && norm(String(r.repo)) === norm(repoUrl))
      return sameRepo && String(r.type || '').toLowerCase() === 'code'
    })
  } catch {
    return false
  }
}

/**
 * Pull a managed GitHub repo forward. DATA ONLY -- deliberately no dependency install.
 *
 * SECURITY (card 3f576e55, Cybersec NO-GO cm#6148): this used to run `npm install --production`
 * whenever the pulled repo had a package.json. npm executes the package's own
 * preinstall/install/postinstall lifecycle scripts, so a single dashboard click ran ARBITRARY CODE
 * out of a freshly-pulled third-party commit -- reintroducing exactly the risk the read-only registry
 * (a5c13533) and the adoption hook-removal (0e8b0a0b) were built to prevent.
 *
 * The install step is simply GONE rather than sandboxed or flag-guarded: a pull is a data operation,
 * and installing dependencies is a build step. Coupling them made a destructive capability a
 * side-effect of a button. If a pulled repo needs its dependencies refreshed, that is a deliberate,
 * separately-authorised action -- reported via `depsChanged` so the UI can say so instead of silently
 * doing it.
 */
export function updateGitHubRepo(name: string): {
  ok: boolean
  error?: string
  /** True when the repo ships a package.json, i.e. its deps MAY now be stale. Informational only --
   *  this function never installs anything. */
  depsChanged?: boolean
  /** Set when the update was refused because the repo is a flagged executable adoption. */
  reviewRequired?: boolean
} {
  const repos = getGitHubRepos()
  const repo = repos.find(r => r.name === name)
  if (!repo) return { ok: false, error: 'Repo not found' }
  if (!existsSync(repo.path)) return { ok: false, error: 'Directory missing' }

  // Honour the watcher's review-before-update verdict: no blind one-click update of executable code.
  if (requiresReviewBeforeUpdate(repo.path, repo.url)) {
    return {
      ok: false,
      reviewRequired: true,
      error:
        'Ez egy vegrehajthato (type=code) adoptalt repo: az upstream valtozast eloszor at kell nezni '
        + '(supply-chain review), csak utana frissitheto. Egykattintasos frissites itt nem engedelyezett.',
    }
  }

  try {
    execSync('git pull --ff-only 2>&1', { cwd: repo.path, timeout: 60000, encoding: 'utf-8', stdio: 'pipe' })
    // NO npm install here -- see the doc comment. Only REPORT that deps may need attention.
    const depsChanged = existsSync(join(repo.path, 'package.json'))
    return { ok: true, depsChanged }
  } catch (err: any) {
    return { ok: false, error: err.stderr || err.message }
  }
}
