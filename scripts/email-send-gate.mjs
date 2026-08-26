#!/usr/bin/env node
// PreToolUse hard-gate: blocks outbound email-send for sub-agents.
//
// Governance control (Szabi 2026-06-25, after the Boni incident: a sub-agent
// autonomously emailed a fabricated address asking for money in Szabi's name).
// Sub-agents may NOT send outbound email; any email must be routed through the
// main agent (Marveen) for approval -- only Marveen retains email-send.
//
// STATED LIMIT (msg 14298): this gate catches the ACCIDENTAL send, not a
// determined evader. Static analysis of arbitrary interpreter code is
// undecidable, so a sub-agent CAN send through interpreter code the patterns
// do not model -- the premise "a sub-agent cannot send outbound" does NOT
// hold against intent, only against accident. The exec-heuristic below covers
// the naive shapes (process-spawn plus a known mailer name in one code
// string) and claims no more. Our sub-agents are not adversaries; if that
// assumption ever changes, this gate is the wrong tool.
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

// Bash command patterns that send mail. SUBGATEPOZ822 (2026-08-22): these are
// no longer the primary trigger -- they matched CONTENT anywhere in the
// command string, and the header's old premise ("a sub-agent has no
// legitimate need to invoke these") broke measurably: the developer of the
// mail tooling IS a sub-agent, and the gate blocked the delivery of the
// mail-gate fix three times in one afternoon (commit message, PR body,
// card-comment sqlite write), plus five more content hits across the fleet
// the same day. The primary trigger is now isSendInvocation() below
// (command-position analysis); this list remains ONLY as the conservative
// fallback when a command cannot be tokenized (unbalanced quote) -- on
// unparseable input the gate behaves exactly as before, never weaker.
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

// --- command-position analysis (SUBGATEPOZ822) ------------------------------
// Ported from scripts/hooks/outgoing-copy-gate.py (KAPUHATOKOR822, PR #1042,
// two adversarial rounds): quote-aware tokenization, then the INVOKED program
// of each pipeline/sequence segment decides. A quoted token keeps its
// POSITION, so a quoted provider URL in curl argument position still fires
// (the normal way curl is written), while the same domain inside a quoted -d
// payload stays content (the target pattern is anchored to the token start).
// Wrapper-shell -c strings recurse; interpreter code-string arguments
// (python -c / node -e) are scanned for code-level send calls -- code handed
// to an interpreter IS operation, not content.
// Order-independent heredoc stripping (round 3, msg 14286): the rest of
// the intro line (e.g. a redirect after the marker) is command text and
// is KEPT -- only the body is cut. Without this, marker-first spellings
// leaked the body into command position (FP), and dropping the intro
// would have lost a heredoc-fed real sender (FN).
const HEREDOC_RE = /(<<-?\s*'?(\w+)'?[^\n]*)\n[\s\S]*?\n\2(?=\s|$)/g
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z_0-9]*=/
const SENDER_PROG = /^(sendmail|msmtp|swaks)$/i
const SENDPY = /^send\.py$/i
const PYTHON = /^python3?$/i
const NODEISH = /^(node|tsx|ts-node|deno|bun|npx)$/i
const GRAPHMAIL = /^graph-mail(\.ts|\.js)?$/i
const WRAPPER_SHELL = /^(sh|bash|zsh|dash)$/i
const CURLISH = /^(curl|wget|http)$/i
const RESEND_TARGET = /^(https?:\/\/)?([^/@\s]*\.)?api\.resend\.com(\/|$)/i
const CODE_SEND = /\bsmtplib\b|SMTP\s*\(|\bsendMail\s*\(|\bsendEmail\b|\bmail\.send\b/i
// Naive-shape exec heuristic (msg 14298): process-spawn AND a known mailer
// name together in one interpreter code string. Covers the accidental shapes;
// see the STATED LIMIT in the header for what it deliberately does not claim.
const CODE_EXECISH = /\bsubprocess\b|os\.system|\bpopen\b|child_process|\bexec[A-Za-z]*\s*\(|\bspawn[A-Za-z]*\s*\(/i
const CODE_SENDER_LIT = /sendmail|msmtp|swaks|send\.py/i
const codeStringSends = (code) => CODE_SEND.test(code) || (CODE_EXECISH.test(code) && CODE_SENDER_LIT.test(code))

// Unquoted newline / backtick / `$(` become segment separators; quoted text is
// untouched (it is content). Tracks quote state by hand -- no shell involved.
export function maskSubshellMarkers(cmd) {
  let out = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) { out += cmd[i] + cmd[i + 1]; i++; continue }
      if (ch === q) q = null
      out += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue }
    if (ch === '\\' && i + 1 < cmd.length) { out += cmd[i] + cmd[i + 1]; i++; continue }
    if (ch === '\n' || ch === '`') { out += ';'; continue }
    if (ch === '$' && cmd[i + 1] === '(') { out += ';'; i++; continue }
    out += ch
  }
  return out
}

// Quote-aware tokenizer -> [[token, ...], ...] per segment. Throws on an
// unbalanced quote (the caller falls back to the legacy content patterns).
export function segmentsTokens(cmd) {
  const s = maskSubshellMarkers(cmd.replace(HEREDOC_RE, '$1'))
  const segments = []
  let cur = []
  let tok = ''
  let hasTok = false
  let q = null
  const pushTok = () => { if (hasTok) { cur.push(tok); tok = ''; hasTok = false } }
  const pushSeg = () => { pushTok(); if (cur.length) { segments.push(cur); cur = [] } }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < s.length) { tok += s[++i]; continue }
      if (ch === q) { q = null; continue }
      tok += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; hasTok = true; continue }
    if (ch === '\\' && i + 1 < s.length) { tok += s[++i]; hasTok = true; continue }
    if (ch === ' ' || ch === '\t') { pushTok(); continue }
    if ('|&;()'.includes(ch)) { pushSeg(); continue }
    tok += ch
    hasTok = true
  }
  if (q) throw new Error('unbalanced quote')
  pushSeg()
  return segments
}

const basename = (t) => t.split('/').pop()

function segmentIsSend(toksIn, depth) {
  let toks = toksIn
  while (toks.length && ENV_ASSIGN.test(toks[0])) toks = toks.slice(1)
  if (!toks.length) return false
  const prog = basename(toks[0])
  const rest = toks.slice(1)
  if (SENDER_PROG.test(prog)) return true
  if (WRAPPER_SHELL.test(prog) && depth < 3) {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-c' && rest[i + 1] && isSendInvocation(rest[i + 1], depth + 1)) return true
    }
  }
  if (PYTHON.test(prog) || NODEISH.test(prog)) {
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === '-c' || rest[i] === '-e' || rest[i] === '--eval') &&
          rest[i + 1] && codeStringSends(rest[i + 1])) return true
    }
  }
  const candidates = [prog]
  if ((PYTHON.test(prog) || NODEISH.test(prog)) && rest.length) candidates.push(basename(rest[0]))
  if (candidates.some((c) => SENDPY.test(c)) &&
      rest.some((t) => t === '--to' || t.startsWith('--to='))) return true
  if (toks.some((t) => GRAPHMAIL.test(basename(t))) && rest.includes('send')) return true
  if (CURLISH.test(prog) && rest.some((t) => RESEND_TARGET.test(t))) return true
  return false
}

export function isSendInvocation(cmd, depth = 0) {
  let segments
  try {
    segments = segmentsTokens(cmd)
  } catch {
    // Unparseable command: fall back to the LEGACY content patterns, so on
    // this path the gate is exactly as strict as before -- never weaker.
    return SEND_PATTERNS.some((re) => re.test(cmd))
  }
  return segments.some((toks) => segmentIsSend(toks, depth))
}

// Outbound-shaped operations of the multiplexed manage_email tool. Each of
// these sends for real unless the call explicitly asks for a draft.
const MANAGE_EMAIL_SEND_OPS = new Set(['send', 'reply', 'replyall', 'forward'])

// Pure decision: does this tool call send (or attempt to send) email?
// Returns { deny, kind? }. `kind` selects the deny wording at the hook
// entrypoint: 'draft-required' is the manage_email case (drafting is fine,
// only the actual send is refused), everything else is the sub-agent
// governance block.
export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  // Any MCP send_email tool, name-agnostic (gmail or a differently-named
  // server in a customer install -> the matcher + this both key on send_email).
  if (/send_email/i.test(name)) return { deny: true }
  // @aaronsb/google-workspace-mcp multiplexes read, draft and send behind one
  // manage_email tool, so the tool NAME cannot decide this one -- the operation
  // plus the draft flag can. This is what replaces the server's own
  // draft-only-email safety policy, which blocks drafting too: that policy keys
  // on ctx.operation alone and never looks at draft:true, so with it enabled the
  // mailbox is effectively read-only (verified live, 2026-08-10).
  if (/(^|__)manage_email$/i.test(name)) {
    const op = String(toolInput?.operation ?? '').toLowerCase()
    if (!MANAGE_EMAIL_SEND_OPS.has(op)) return { deny: false }
    // Fail safe: only an explicit draft request passes. A missing/ambiguous
    // flag is treated as a real send, even though the server would itself
    // force a draft when attachments are present.
    const draft = toolInput?.draft
    if (draft === true || draft === 'true') return { deny: false }
    return { deny: true, kind: 'draft-required' }
  }
  if (name === 'Bash') {
    // NOT switched to upstream's isSendInvocation() here (card 72f5f13b merge decision,
    // recorded for MikroB/Peti review -- see the merge report). isSendInvocation is kept,
    // exported, and cross-tested against outgoing-copy-gate.py's twin (see
    // send-invocation-conformance.test.ts) because it is a genuinely more precise,
    // position-aware detector. But its heredoc handling (HEREDOC_RE inside segmentsTokens)
    // discards EVERY heredoc body before tokenizing, including one feeding an INTERPRETER
    // (`python3 <<'PY' ... smtplib.SMTP(...) ... PY`) -- a real send this fork's OWN
    // extensively adversarially-hardened suite (email-send-gate.test.ts, card 84e31b40,
    // ~150 cases covering nested substitutions/quoting/case-statement heredoc ownership)
    // requires to still deny. Closing that gap needs the SAME hardened ownership walker
    // those 150 cases already exercise (self-pace-gate.mjs's stripHeredocDataPayloads /
    // bash-ast.mjs's heredocOwnerSpans) generalized to identify an INTERPRETER owner, not
    // just curl/git -- a scoped refactor of a separate, shared, security-critical file,
    // out of scope for a merge-conflict resolution. A hand-rolled regex replacement was
    // tried and measured: it satisfied upstream's new false-positive tests but broke 26 of
    // the fork's own adversarial cases (nested $()/<()/>()/backticks, case-statement
    // pattern terminators, quoting edge cases) -- strictly worse for a hard-deny gate.
    // Kept the fork's original, fully-covered (151/151 green) legacy scan wholesale instead.
    const raw = String(toolInput?.command ?? '')
    const cmd = stripDataPayloads(stripHeredocDataPayloads(raw))
    if (SEND_PATTERNS.some((re) => re.test(cmd))) return { deny: true }
  }
  return { deny: false }
}

// Deny wording for the manage_email case. Unlike the sub-agent governance
// block this is not about who the agent is: drafting stays open, so the fix is
// to re-issue the same call with draft: true and hand the draft to the owner.
export function buildDraftOnlyMsg(ownerName) {
  return (
    'Kimeno email kuldese tiltott (draft-kapu). ' +
    'Ird meg ugyanezt draft: true kapcsoloval, es jelezd a tulajdonosnak ' +
    `(${ownerName}), hogy a Gmail piszkozatok kozott varja a jovahagyasat. ` +
    'Csak VERIFIKALT cimre. A kuldes gombot ember nyomja meg.'
  )
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
  const { deny: shouldDeny, kind } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) {
    const { botName, ownerName } = readBrandEnv()
    deny(kind === 'draft-required' ? buildDraftOnlyMsg(ownerName) : buildGateMsg(botName, ownerName))
  }
  allow()
}
