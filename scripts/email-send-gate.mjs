#!/usr/bin/env node
// PreToolUse hard-gate: blocks outbound email-send for sub-agents.
//
// Governance control (Szabi 2026-06-25, after the Boni incident: a sub-agent
// autonomously emailed a fabricated address asking for money in Szabi's name).
// Sub-agents may NOT send outbound email; any email must be routed through the
// main agent (Marveen) for approval -- only Marveen retains email-send.
//
// Why a hook and not a permissions deny-list: permissive security profiles
// launch Claude Code with --dangerously-skip-permissions, which BYPASSES the
// settings.json allow/deny list. A PreToolUse hook runs regardless of
// permission mode, so it is the only reliable mode-independent gate.
//
// This file is wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, and re-applied on every spawn (respawn-safe).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { allow, deny, isInvokedDirectly } from './hook-lib.mjs'
// The heredoc walker is IMPORTED, not reimplemented (card 84e31b40). It is the same
// parsing problem this gate faces, it is already hardened by a Cybersec NO-GO (card
// 4638c14c: a decoy `-d @-` in ANOTHER binary's argv used to launder an interpreter
// heredoc), and its safety argument transfers unchanged -- see the call site below.
// A second copy of ~60 lines of security-critical shell parsing is the shape where a
// fix lands in one twin and the other silently keeps the hole.
import { stripHeredocDataPayloads } from './self-pace-gate.mjs'

// Bash command patterns that send mail. Read-only inspection of these tools
// (e.g. cat'ing the send script) may be caught too -- acceptable: a sub-agent
// has no legitimate need to invoke them, and the gate fails safe toward
// blocking only actual send-shaped commands.
const SEND_PATTERNS = [
  /support-mail\/send\.py/i,
  /\bsend\.py\b/i,
  /api\.resend\.com/i,
  /\bresend\b[^\n]*\b(email|send|message)\b/i,
  /\bsendmail\b/i,
  /\bmsmtp\b/i,
  /\bswaks\b/i,
  /\bsmtplib\b|SMTP\s*\(/i,
  /\bmail\.send\b|\bsendEmail\b/i,
  // graph-mail.ts (PR #668, M365/Exchange Online client-credentials mailbox):
  // its CLI is `tsx scripts/graph-mail.ts send ...`, which none of the above
  // patterns catch (no "sendmail"/"mail.send" substring). Also gate any direct
  // call to the exported sendMail() (e.g. a one-off `node -e`/`tsx -e` that
  // imports the module without going through the CLI).
  /\bgraph-mail\b[^\n]*\bsend\b/i,
  /\bsendMail\s*\(/i,
]

// Blank a curl -d/--data LITERAL payload before the SEND_PATTERNS scan (card 132fc28c,
// incident msg 8641): a kanban-comment POST to localhost:3420/api/kanban -- an unrelated
// endpoint, not an email API -- carried prose discussing whether the PRODUCT should send a
// registration activation email; that prose mentioned "Resend" (the email-provider name)
// near "email"/"send" and matched the RESEND_RX below, blocking a comment post as if it were
// an actual outbound send. The gate exists to stop the ACTION (a real email-API/SMTP call),
// not to censor text that happens to discuss email. A `-d @file`/`--data-binary @file`
// argument (a file reference, no inline text) is untouched -- there is nothing to blank, and
// this is exactly the shape the existing api.resend.com regression test already uses, so a
// REAL send to that host stays caught either way. Same literal-only quote handling as
// self-pace-gate.mjs's stripDataPayloads (single-quoted, ANSI-C $'...', double-quoted
// WITHOUT $(...)/backtick -- a substitutable double-quoted payload is left intact so a real
// substitution is not hidden from the scan).
function stripDataPayloads(cmd) {
  return String(cmd ?? '').replace(
    /((?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal payload -> blank the content
    },
  )
}

// Pure decision: does this tool call send (or attempt to send) email?
export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  // Any MCP send_email tool, name-agnostic (gmail or a differently-named
  // server in a customer install -> the matcher + this both key on send_email).
  if (/send_email/i.test(name)) return { deny: true }
  if (name === 'Bash') {
    // Two blanking passes, both DATA-ONLY (card 84e31b40). stripDataPayloads covers an
    // inline `-d '<literal>'`; stripHeredocDataPayloads covers the same payload handed
    // over stdin instead -- `curl ... -d @- <<'JSON'` and `git commit -F - <<'MSG'`.
    // Which of the two shapes an agent happens to pick had become a security decision:
    // identical prose passed one way and was denied the other, and the deny message
    // named neither, so the agent either gave up or started obfuscating.
    //
    // WHY THIS OPENS NO HOLE, and what it deliberately does NOT do. It blanks a heredoc
    // ONLY when that heredoc's own simple command is curl reading it as `-d @-` data (or
    // git reading it as a commit message) -- bytes those binaries transmit or store and
    // never execute. A heredoc feeding an INTERPRETER (`python3 <<'PY' ... smtplib ...`)
    // is left fully scanned, because the interpreter really would run a send hidden
    // there; that is the case the regression tests pin, alongside the `-d @-`-decoy one.
    // A general "exempt heredoc bodies" rule -- the obvious reading of "extend
    // stripDataPayloads to heredocs" -- WOULD open exactly that hole.
    const raw = String(toolInput?.command ?? '')
    const cmd = stripDataPayloads(stripHeredocDataPayloads(raw))
    if (SEND_PATTERNS.some((re) => re.test(cmd))) return { deny: true }
  }
  return { deny: false }
}

// Pure builder for the deny message, so the brand/owner substitution is
// provable without spawning the hook. With the stock defaults (botName
// 'Marveen', ownerName 'Szabolcs') the wording is byte-identical to before.
export function buildGateMsg(botName, ownerName) {
  return (
    'Email-kuldes sub-agentkent tiltott (governance hard-gate). ' +
    `Kuldd a tervezett emailt (CIMZETT + TARGY + TELJES SZOVEG) ${botName}nek inter-agent uzenetben ` +
    `jovahagyasra; a kimeno emailt ${botName} kuldi. Csak VERIFIKALT cimre (soha nem nevbol talalt cim). ` +
    `Soha ne irj ala ${ownerName} nevevel, es soha ne kerj penzt senki neveben. ` +
    'HA EZ NEM KULDES, HANEM PROZA (kanban-komment, riport, commit-uzenet, ami csak EMLITI az ' +
    'email-kuldest): ne obfuszkald a szoveget es ne add fel -- ird a tartalmat fajlba (Write ' +
    'tool), es add at FAJLHIVATKOZASKENT: `curl --data-binary @fajl` vagy `git commit -F fajl`. ' +
    'A gate a fajlhivatkozast nem szkenneli, egy VALODI kuldes viszont igy is fennakad.'
  )
}

// Resolve the brand + owner display names for the deny message. The hook runs
// standalone (no config.ts), so read the install's .env directly, keyed off
// this file's own location (<root>/scripts/email-send-gate.mjs -> <root>/.env).
// Any failure falls back to the stock defaults, so the gate never breaks and a
// bare install keeps the original wording.
export function readBrandEnv(readFile = (p) => readFileSync(p, 'utf-8')) {
  const fallback = { botName: 'Marveen', ownerName: 'Szabolcs' }
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
    const raw = readFile(envPath)
    const pick = (key) => {
      const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
      if (!m) return ''
      return m[1].trim().replace(/^["']|["']$/g, '').trim()
    }
    return {
      botName: pick('BOT_NAME') || fallback.botName,
      ownerName: pick('OWNER_NAME') || fallback.ownerName,
    }
  } catch {
    return fallback
  }
}

// Run as the hook entrypoint only when invoked directly (not when imported by a
// test). Reads the PreToolUse payload from stdin and emits a deny decision for
// email-send tool calls. allow()/deny()/isInvokedDirectly() are shared with the
// other PreToolUse gates -- see hook-lib.mjs.
if (isInvokedDirectly(import.meta.url)) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) {
    const { botName, ownerName } = readBrandEnv()
    deny(buildGateMsg(botName, ownerName))
  }
  allow()
}
