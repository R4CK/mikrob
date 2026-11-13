import { logger } from './logger.js'

// envCompatGet -- TS counterpart of store/env-compat-lib.sh's env_compat_get (card 22835648,
// Rename 1/3 of the CleanCore-name retirement, Peti 2026-10-11 Telegram 11045/11048). Single
// source for "read the new env-var name first, fall back to the retired CleanCore name with a
// warning, else a default" -- see that file's header for the full why, including why the
// warning is NOT de-duplicated across repeated calls (a real de-dup needs state that survives
// across the bash side's subshell-per-call shape; the TS side has no such constraint, but is
// kept symmetric with the bash implementation both callers actually share the behaviour of).
export function envCompatGet(newName: string, oldName: string, defaultVal = ''): string {
  const newVal = process.env[newName]
  if (newVal) return newVal
  const oldVal = process.env[oldName]
  if (oldVal) {
    logger.warn({ oldName, newName }, `env-compat: $${oldName} is deprecated, use $${newName} instead (still honoured as a fallback)`)
    return oldVal
  }
  return defaultVal
}
