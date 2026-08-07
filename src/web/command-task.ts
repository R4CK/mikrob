import { execFileAsync } from "./exec-async.js"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { STORE_DIR, TELEGRAM_BOT_TOKEN } from "../config.js"
import { resolveOwnerChatId } from "../owner-chat.js"
import { atomicWriteFileSync } from "./atomic-write.js"
import { logger } from "../logger.js"
import { sendTelegramMessage } from "./telegram.js"
import { appendTaskRun } from "../db.js"
import type { ScheduledTask } from "./scheduled-tasks-io.js"

// command-type scheduled tasks run a raw shell command directly (no LLM
// agent, no tmux session) and alert on Telegram after N consecutive
// failures. This keeps infra heartbeats inside the one system that gets
// backed up (the Marveen store) instead of a separate crontab.

const HEALTH_PATH = join(STORE_DIR, "command-task-health.json")

export interface CommandHealth {
  fails: number
  alerted: boolean
  lastStatus: "ok" | "fail" | "unknown"
  lastRun: number
}
type HealthMap = Record<string, CommandHealth>

let healthMap: HealthMap | null = null
function load(): HealthMap {
  if (healthMap) return healthMap
  try { healthMap = JSON.parse(readFileSync(HEALTH_PATH, "utf-8")) as HealthMap }
  catch { healthMap = {} }
  return healthMap
}
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap ?? {}, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}

export type CommandAction = "none" | "alert" | "recover"

// Pure decision function so the failure/recovery policy is unit-testable
// without spawning processes. success=true zeroes the streak; an alert
// fires exactly once when the streak first reaches failThreshold; a
// recover fires once when a previously-alerted task succeeds again.
export function evaluateCommandResult(
  prev: CommandHealth | undefined,
  success: boolean,
  failThreshold: number,
  now: number,
): { next: CommandHealth; action: CommandAction } {
  const wasAlerted = prev?.alerted ?? false
  const fails = success ? 0 : (prev?.fails ?? 0) + 1
  let action: CommandAction = "none"
  let alerted = wasAlerted
  if (success) {
    if (wasAlerted) { action = "recover"; alerted = false }
  } else if (fails >= failThreshold && !wasAlerted) {
    action = "alert"; alerted = true
  }
  return {
    next: { fails, alerted, lastStatus: success ? "ok" : "fail", lastRun: now },
    action,
  }
}

// MUST stay async. This used to call the SYNCHRONOUS spawn API, which blocks the
// WHOLE Node event loop -- the HTTP server included -- until the child exits. One
// command task (context-compact-dry) runs a script that curls this very dashboard
// to refresh token usage, so that request could never be served while the loop sat
// blocked in the child: a guaranteed self-deadlock for the child's full curl budget.
// Observed 2026-08-07: dashboard silent 09:00:05.247 -> 09:01:05.342, exactly the
// script's `curl -m 60`, ended by this task's own "command task ran" line.
// Same defect class as the external-cron path fixed in 4ddad4d; this was the
// in-process sibling, and strictly worse because the deadlock is guaranteed.
async function runCommand(cmd: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  // execFileAsync, not a raw execFile: Node's own `timeout` SIGTERMs only the direct
  // child, so a command task whose script backgrounds work (or redirects, making bash
  // fork) leaves orphans running while the caller is told "timeout" -- work then piles
  // up invisibly, which is what the outage actually looked like. The helper kills the
  // process GROUP instead (card 423b8274, Cybersec 8304 item 2).
  const r = await execFileAsync("bash", ["-lc", cmd], { timeoutMs, maxBuffer: 1024 * 1024 })
  if (r.timedOut) return { ok: false, detail: `timeout ${timeoutMs}ms` }
  if (r.status === 0) return { ok: true, detail: "exit 0" }
  if (r.status === null) return { ok: false, detail: r.stderr.trim().slice(0, 200) || "spawn failed" }
  const tail = r.stderr.trim().slice(0, 200)
  return { ok: false, detail: `exit ${r.status}${tail ? ": " + tail : ""}` }
}

export async function runCommandTask(task: ScheduledTask, now: number): Promise<void> {
  if (!task.command) {
    logger.warn({ task: task.name }, "command task has no command, skipping")
    return
  }
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : 10_000
  const failThreshold = task.failThreshold && task.failThreshold > 0 ? task.failThreshold : 2
  const map = load()
  const { ok, detail } = await runCommand(task.command, timeoutMs)
  const { next, action } = evaluateCommandResult(map[task.name], ok, failThreshold, now)
  map[task.name] = next
  persist()
  try { appendTaskRun(task.name, task.agent || "system") } catch { /* non-fatal */ }
  logger.info({ task: task.name, ok, detail, fails: next.fails, action }, "command task ran")

  if (action === "none") return
  const ownerChat = resolveOwnerChatId()
  if (!TELEGRAM_BOT_TOKEN || !ownerChat) {
    logger.warn({ task: task.name }, "command task alert suppressed: missing token, or no owner chat (ALLOWED_CHAT_ID unset/placeholder and no paired channel)")
    return
  }
  const label = task.description || task.name
  const text = action === "alert"
    ? `\u{1F534} Hiba: ${label} nem v\u00e1laszol (${next.fails}. egym\u00e1s ut\u00e1ni hiba). R\u00e9szlet: ${detail}`
    : `\u{1F7E2} Helyre\u00e1llt: ${label} ism\u00e9t OK.`
  sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, text)
    .then(() => logger.info({ task: task.name, action }, "command task alert sent"))
    .catch((err) => logger.warn({ err, task: task.name }, "command task alert send failed"))
}
