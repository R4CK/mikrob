// Per-agent setup-token file: agent-config.json "oauthTokenFile" (upstream
// 2fb86ef2, #1511, adapted on card 06b48bd0 -- the fork has no customProvider
// launch-env wiring yet (card f1800242 is still planned), so the conflict
// check below takes a single isClaude flag instead of upstream's separate
// isCustomProvider/isClaudeModel pair; re-add the split if/when f1800242 lands.
//
// An agent with this field authenticates from ITS OWN long-lived setup-token
// file instead of the fleet file (store/.claude-oauth-token). The launcher
// exports it with exactly the fleet token's shape,
//   export CLAUDE_CODE_OAUTH_TOKEN="$(cat '<file>')" &&
// so the secret is read by the shell at launch and never enters the JS-built
// command string or `ps`.
//
// FAIL-CLOSED. "Unset" means one thing only: the key is absent. A key that is
// present but unusable -- malformed path, missing file, wrong owner, a mode
// wider than 0600, empty or non-setup-token content, the fleet file itself or a
// copy of it, or a setting the field cannot take effect under -- refuses the
// start. It never degrades to the fleet token: an agent that was given its own
// token and silently ran on the fleet's would spend exactly the quota the field
// exists to protect, and nothing would show it.
//
// Only the path and a fingerprint (first 8 hex chars of the token's sha256)
// ever leave this module. The token value does not, not even inside a
// rejection detail.

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import type { AuthMode } from './agent-config.js'

// WhiteHat F1 follow-up (card 006b506b, on 06b48bd0): the launcher used to feed this module's
// decision via `readFileOr(path, '{}')` -- a helper EVERY other config reader in this fleet uses,
// because for them a missing/unreadable file correctly means "no config, use defaults". For THIS
// field that equivalence is wrong: an agent-config.json that EXISTS but cannot be read (permission
// denied, a transient I/O error, anything other than "truly absent") silently became '{}', which
// resolveOauthTokenFileSetting reads as 'unset' -- so a configured agent started on the FLEET token
// with no signal anywhere that its own-token setting was never actually consulted. Measured: the
// 54-case suite stayed fully green with the read swapped for an always-'{}' stub. A real ENOENT (no
// file at all) is the ONLY read outcome equivalent to "no field, use the fleet token" -- everything
// else must refuse, the same fail-closed stance the rest of this module already takes for a
// present-but-unusable value.
export type AgentConfigRead = { ok: true; raw: string } | { ok: false; reason: 'unreadable' }

export function readAgentConfigForOauthDecision(path: string): AgentConfigRead {
  try {
    return { ok: true, raw: readFileSync(path, 'utf-8') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, raw: '{}' }
    return { ok: false, reason: 'unreadable' }
  }
}

export const OAUTH_TOKEN_FILE_KEY = 'oauthTokenFile'
export const SETUP_TOKEN_PREFIX = 'sk-ant-oat'

// Absolute path, whitelisted characters only: the launcher inlines the path
// between single quotes, so a quote or any shell-significant character must
// not be able to reach it (same whitelist philosophy as claudeConfigDir,
// agent-config.ts). No tilde: the shell would re-expand it at launch.
const TOKEN_FILE_PATH_ALLOWED = /^\/[A-Za-z0-9_./-]+$/

export type OauthTokenFileSetting =
  | { state: 'unset' }
  | { state: 'invalid'; reason: string }
  | { state: 'set'; path: string }

// Pure: raw agent-config.json text -> the field's state.
export function resolveOauthTokenFileSetting(rawConfigJson: string): OauthTokenFileSetting {
  let config: unknown
  try {
    config = JSON.parse(rawConfigJson)
  } catch {
    // Every other reader treats an unparseable config as {}. Here that would
    // mean "unset", i.e. the fleet token -- so a broken file that mentions the
    // key refuses instead.
    return rawConfigJson.includes(`"${OAUTH_TOKEN_FILE_KEY}"`)
      ? { state: 'invalid', reason: 'config-unparseable' }
      : { state: 'unset' }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { state: 'unset' }
  if (!Object.prototype.hasOwnProperty.call(config, OAUTH_TOKEN_FILE_KEY)) return { state: 'unset' }
  const value = (config as Record<string, unknown>)[OAUTH_TOKEN_FILE_KEY]
  if (typeof value !== 'string') return { state: 'invalid', reason: 'not-a-string' }
  const path = value.trim()
  if (!path) return { state: 'invalid', reason: 'blank' }
  if (!path.startsWith('/')) return { state: 'invalid', reason: 'not-absolute' }
  if (!TOKEN_FILE_PATH_ALLOWED.test(path)) return { state: 'invalid', reason: 'path-bad-characters' }
  if (path.split('/').some((segment) => segment === '..')) return { state: 'invalid', reason: 'path-parent-traversal' }
  return { state: 'set', path }
}

// WhiteHat F4 follow-up (card 006b506b, on 06b48bd0): nothing stopped two DIFFERENT agents from
// naming the SAME oauthTokenFile path. Both would then authenticate as the same Claude identity,
// sharing its quota and its blast radius -- precisely what a per-agent token exists to prevent (the
// root CLAUDE.md's standing rule: an agent never runs on another agent's credential). The field has
// no write-API path to gate at write time (manual agent-config.json edit only, see the launcher
// wiring test "the API cannot write the field"), so this is checked at launch instead, against
// every OTHER currently-known agent's own config.
export function findOauthTokenFileCollision(
  path: string,
  thisAgentName: string,
  otherAgents: readonly { name: string; configRead: AgentConfigRead }[],
): string | null {
  for (const other of otherAgents) {
    if (other.name === thisAgentName) continue
    if (!other.configRead.ok) continue // an unreadable OTHER agent's config is that agent's own problem
    const setting = resolveOauthTokenFileSetting(other.configRead.raw)
    if (setting.state === 'set' && setting.path === path) return other.name
  }
  return null
}

// Pure: a setting the field cannot take effect under is a conflict, and a
// conflict refuses the start -- ignoring the field would leave the operator
// believing the agent runs on its own token when it does not.
export function oauthTokenFileConflict(input: {
  isMainAgent: boolean
  isRemote: boolean
  isClaudeModel: boolean
  authMode: AuthMode
  hasExplicitConfigDir: boolean
  hasClaudePlan: boolean
}): string | null {
  // The main agent launches through scripts/channels.sh, not this launcher.
  if (input.isMainAgent) return 'main-agent'
  // A remote agent's session runs on another host; a local path means nothing there.
  if (input.isRemote) return 'remote-agent'
  // A setup-token is a Claude OAuth credential. A non-Claude model (Ollama,
  // DeepSeek, OpenRouter, ...) authenticates with its own key/vault entry, and
  // the launcher never exports an OAuth token for it, so the field cannot take
  // effect there, and ignoring it would leave the operator believing the agent
  // runs on its own token.
  if (!input.isClaudeModel) return 'non-claude-model'
  // own_team authenticates from its own /login; api from its own API key.
  if (input.authMode === 'own_team') return 'auth-mode-own_team'
  if (input.authMode === 'api') return 'auth-mode-api'
  // An explicit config dir (or a named plan) carries its own login, and Claude
  // Code prefers an on-disk credential over the CLAUDE_CODE_OAUTH_TOKEN env var,
  // so the exported token would not be the one in use.
  if (input.hasExplicitConfigDir || input.hasClaudePlan) return 'explicit-config-dir'
  return null
}

export type OauthTokenFileCheck =
  | { ok: true; path: string; fingerprint: string }
  | { ok: false; path: string; reason: string; detail: string }

// What `"$(cat file)"` hands the process: the content minus trailing newlines.
function exportedValue(raw: string): string {
  return raw.replace(/\n+$/, '')
}

export function tokenFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)
}

// Validates the token file itself. `uid` is the launching user's uid, or null
// on a platform without POSIX ownership (the check cannot be made -> refuse).
export function checkOauthTokenFile(
  path: string,
  opts: { uid: number | null; fleetTokenPath: string },
): OauthTokenFileCheck {
  const refuse = (reason: string, detail = ''): OauthTokenFileCheck => ({ ok: false, path, reason, detail })
  let st
  try {
    st = lstatSync(path)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? refuse('missing') : refuse('unreadable')
  }
  // lstat, not stat: a symlink could point at the fleet file or at another
  // agent's token, and neither is this agent's own file.
  if (!st.isFile()) return refuse('not-regular-file')
  // The same inode as the fleet file (the path itself, or a hard link to it).
  try {
    const fleet = statSync(opts.fleetTokenPath)
    if (fleet.ino === st.ino && fleet.dev === st.dev) return refuse('is-fleet-file')
  } catch { /* no fleet file: nothing to be identical to */ }
  if (opts.uid === null) return refuse('unsupported-platform', 'no POSIX owner check on this platform')
  if (st.uid !== opts.uid) return refuse('wrong-owner', `owner uid ${st.uid}, launcher uid ${opts.uid}`)
  // "0600 or stricter": no owner-execute bit and nothing for group or other.
  if ((st.mode & 0o177) !== 0) return refuse('mode-too-open', `mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}`)
  let value: string
  try {
    value = exportedValue(readFileSync(path, 'utf-8'))
  } catch {
    return refuse('unreadable')
  }
  if (!value) return refuse('empty')
  if (!value.startsWith(SETUP_TOKEN_PREFIX)) return refuse('bad-prefix', `does not start with ${SETUP_TOKEN_PREFIX}`)
  // A setup-token never contains whitespace or control characters; one that
  // does would reach the environment verbatim and fail as a login, not here.
  if (/[\s\x00-\x1f\x7f]/.test(value)) return refuse('content-bad-characters')
  // A copy of the fleet token under another name is the fleet token.
  try {
    if (exportedValue(readFileSync(opts.fleetTokenPath, 'utf-8')) === value) return refuse('same-as-fleet-token')
  } catch { /* no fleet file: nothing to be a copy of */ }
  return { ok: true, path, fingerprint: tokenFingerprint(value) }
}

// WhiteHat F3 follow-up (card 006b506b, on 06b48bd0): checkOauthTokenFile runs once, at decide
// time, early in the launcher. The actual secret is read much later -- by a SEPARATE shell process
// (`$(cat '<path>')`), after config-dir isolation and other I/O -- so there is a real check-then-use
// window in which the file could be swapped (a symlink repoint, a replaced file keeping the same
// owner/mode). This cannot be closed to zero without handing the shell a file descriptor instead
// of a path, which the module's own design deliberately avoids (see the file header: the secret
// must never enter the JS-built command string). What CAN be done: re-run the SAME validation
// immediately before the launch command is built, right next to the actual use, and refuse if
// anything -- including the CONTENT, via the fingerprint -- no longer matches what was decided.
// That shrinks the exploitable window from "the whole launcher" to "between this call and the
// shell's own cat", which is as tight as a path-based design gets.
export type OauthTokenReverifyResult = { ok: true } | { ok: false; reason: string; detail: string }

export function reverifyOauthTokenFile(
  path: string,
  expectedFingerprint: string,
  opts: { uid: number | null; fleetTokenPath: string },
): OauthTokenReverifyResult {
  const check = checkOauthTokenFile(path, opts)
  if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail }
  if (check.fingerprint !== expectedFingerprint) {
    return { ok: false, reason: 'content-changed-since-check', detail: '' }
  }
  return { ok: true }
}

// The launch-command fragment: the fleet token's shape, with this file.
export function ownOauthTokenExport(path: string): string {
  return `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${path}')" && `
}

export type OwnOauthTokenDecision =
  | { kind: 'unset' }
  | { kind: 'ok'; path: string; fingerprint: string }
  | { kind: 'refused'; path: string | null; reason: string; detail: string }

// The whole decision from its inputs, so it is testable without an agent dir.
export function decideOwnOauthToken(input: {
  configRead: AgentConfigRead
  isMainAgent: boolean
  isRemote: boolean
  isClaudeModel: boolean
  authMode: AuthMode
  hasExplicitConfigDir: boolean
  hasClaudePlan: boolean
  fleetTokenPath: string
  uid: number | null
}): OwnOauthTokenDecision {
  // Fail-closed on the READ itself, before the field is even parsed: an unreadable
  // agent-config.json might contain "oauthTokenFile", and there is no way to tell from here --
  // unlike resolveOauthTokenFileSetting's own unparseable-JSON branch, which still gets to look at
  // the bytes it DID receive.
  if (!input.configRead.ok) return { kind: 'refused', path: null, reason: 'config-unreadable', detail: '' }
  const setting = resolveOauthTokenFileSetting(input.configRead.raw)
  if (setting.state === 'unset') return { kind: 'unset' }
  if (setting.state === 'invalid') return { kind: 'refused', path: null, reason: setting.reason, detail: '' }
  const conflict = oauthTokenFileConflict(input)
  if (conflict) return { kind: 'refused', path: setting.path, reason: conflict, detail: '' }
  const check = checkOauthTokenFile(setting.path, { uid: input.uid, fleetTokenPath: input.fleetTokenPath })
  if (!check.ok) return { kind: 'refused', path: check.path, reason: check.reason, detail: check.detail }
  return { kind: 'ok', path: check.path, fingerprint: check.fingerprint }
}

// Pure: does the launch env actually carry the decided own token? The launcher
// derives its "own token exported" log line from THIS, not from the decision,
// and refuses the start when an 'ok' decision did not reach the export -- so a
// wiring slip can neither run the agent on the fleet token nor log that it did
// not. 'unset' and 'refused' never carry an own export, so they never mismatch.
export function ownOauthExportMissing(decision: OwnOauthTokenDecision, oauthTokenEnv: string): boolean {
  if (decision.kind !== 'ok') return false
  return oauthTokenEnv !== ownOauthTokenExport(decision.path)
}

// Pure: the ONE verdict the launcher acts on after the last write to
// oauthTokenEnv, for both the refusal and the "own token" log line. Its only
// inputs are the decision and the actual launch env, so the log cannot claim
// the own token unless the env carries exactly the own export, and an 'ok'
// decision that did not reach the env can only end in a refusal.
export type OwnOauthLaunchVerdict =
  | { kind: 'not-own' }
  | { kind: 'refuse'; path: string }
  | { kind: 'own'; path: string; fingerprint: string }

export function ownOauthLaunchVerdict(decision: OwnOauthTokenDecision, oauthTokenEnv: string): OwnOauthLaunchVerdict {
  if (decision.kind !== 'ok') return { kind: 'not-own' }
  if (ownOauthExportMissing(decision, oauthTokenEnv)) return { kind: 'refuse', path: decision.path }
  return { kind: 'own', path: decision.path, fingerprint: decision.fingerprint }
}
