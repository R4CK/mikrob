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
// POSITION-BASED ANALYSIS BLIND SPOT (Cybersec M-1, card c7401c5f, comment #16876, 2026-08-27):
// isSendInvocation() below decides from a command's TOKEN POSITIONS (which program is invoked,
// where), not from tracing what a value ultimately resolves to. That is a known, accepted
// weakening versus the OLD unconditional content-scan (SEND_PATTERNS matched anywhere in the
// string) for three shapes, none introduced by this file's current composition -- all inherited
// from the earlier SUBGATEPOZ822 switch to position analysis and merely made visible/measured here:
//   1. A variable-resolved argv0:      X=sendmail; $X user@host < body
//   2. An eval'd string:               eval "sendmail user@host"
//   3. printf piped into a shell:      printf 'sendmail a@b' | bash
// All three are DENY under the old content-scan and allow here, because nothing in the command's
// own tokens names the sender directly -- resolving them needs actual variable/eval simulation,
// which this gate does not do (see the STATED LIMIT below: static analysis of arbitrary code is
// undecidable). This is why the elsewhere-stated "the gate behaves exactly as before, never
// weaker" claim (SEND_PATTERNS comment, and isSendInvocation's own unparseable-fallback comment)
// is true ONLY on those two specific paths -- the SEND_PATTERNS fallback for unparseable input,
// and the fallback used when a command cannot be tokenized -- and must NOT be read as a claim
// about this file's overall posture. Accepted because: the position-based switch removed a much
// larger, measured false-positive cost (see SUBGATEPOZ822 below) and these three shapes require
// deliberate evasion, not an accidental send -- consistent with the STATED LIMIT already below.
// Recorded in DECISIONS.md per project convention.
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
// The heredoc walker is IMPORTED, not reimplemented (card 84e31b40, generalized by card c7401c5f
// via heredocOwnerRecords). It is the same parsing problem this gate faces, it is already hardened
// by a Cybersec NO-GO (card 4638c14c: a decoy `-d @-` in ANOTHER binary's argv used to launder an
// interpreter heredoc), and its safety argument transfers unchanged -- see the heredoc composition
// section below. A second copy of ~60 lines of security-critical shell parsing is the shape where a
// fix lands in one twin and the other silently keeps the hole.
import {
  heredocOwnerRecords,
  heredocIsStdinDataSink,
  CURL_LEADING_RX,
  GIT_LEADING_RX,
} from './self-pace-gate.mjs'

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
// A bare network call verb (`fetch(`, `axios.post(`, ...) is not enough on its own -- same reasoning
// as CODE_EXECISH/CODE_SENDER_LIT above (msg 14298): a call verb AND a known provider host together
// is what a real provider-API send looks like from JS/Python with no smtplib/sendMail() wrapper
// (card c7401c5f, closing the gap RESEND_TARGET already covers for curl argv position but not for a
// heredoc-fed script's own body).
const CODE_NETWORK_CALL = /\bfetch\s*\(|\baxios\b[^\n]*\(|\brequests\.(?:post|get)\s*\(|\burlopen\s*\(|\bXMLHttpRequest\b/i
const CODE_PROVIDER_HOST = /api\.resend\.com/i
const heredocScriptSends = (body) =>
  codeStringSends(body) || (CODE_NETWORK_CALL.test(body) && CODE_PROVIDER_HOST.test(body))

// --- heredoc composition (card c7401c5f) ------------------------------------
// isSendInvocation's own tokenizer (segmentsTokens, below) strips EVERY heredoc body wholesale via
// HEREDOC_RE before tokenizing -- necessary, because a heredoc body is not shell syntax and would
// desync the tokenizer, but it also means a heredoc feeding an INTERPRETER's stdin as its script
// (`python3 <<'PY' ... smtplib ... PY`, no -c/-e) goes completely unscanned by position analysis
// alone. This closes that gap by composing with the SAME hardened ownership walker
// self-pace-gate.mjs's stripHeredocDataPayloads already exercises through ~150 adversarial cases
// (heredocOwnerRecords, card c7401c5f) -- not a second parser -- to find which heredocs are owned by
// what, and applies a scan policy over the owner span rather than a blank/keep decision.
//
// DEFAULT IS SCAN, same as the legacy content-scan this replaces: an owner span this gate cannot
// positively prove inert stays scanned. That default matters for a shape stripHeredocDataPayloads's
// own curl/git-only exemption never had to answer -- an UNRECOGNISED leading word standing in front
// of the real interpreter (`coproc CO python3 curl -d @- <<'PY'`, F-9's L-R5; `coproc deploy-prod
// curl -d @- <<'PY'`, F-1-round-10's N-R2) is not curl, not git, and its own argv[0] is not a known
// interpreter either -- but bash still hands the heredoc to that exact simple command, and this gate
// cannot prove "CO"/"deploy-prod" do not exist and are not going to relay it somewhere dangerous.
// Only two things are carved OUT of that default:
//   1. curl/git in their proven-safe stdin shape (heredocIsStdinDataSink) -- MEASURED to never
//      execute what they are given (curl transmits `-d` as HTTP bytes, git stores `-F` as a
//      message). Everything else curl/git-LEADING (e.g. `curl --config -`, which reads the body as
//      OPTIONS it then acts on) is NOT this shape and stays scanned.
//   2. A narrow, explicit allowlist of consumers proven to never execute OR act on what they read
//      (HEREDOC_INERT_CONSUMER_RX below) -- `cat <<EOF > file` (copies bytes, never runs them),
//      `gh <<EOF` (issue/PR body text, never code). This is what removes the false positives this
//      card exists to remove; an unrecognised binary is NOT on this list and stays scanned, same
//      discipline as heredocIsStdinDataSink's own deliberately narrow list (see
//      stdin-consumer-list-narrowness.test.ts's header).
//
// A SCANNED heredoc then gets one of two checks, not the same one for both, because they answer
// different questions:
//   - Owner is a genuine interpreter, recognised DIRECTLY in leading position (HEREDOC_INTERPRETER_RX
//     anchored) -- it executes the body as CODE, so the narrower code-shaped check applies
//     (heredocScriptSends, shared with -c/-e above): this is what keeps a heredoc that only MENTIONS
//     a sender in a string/comment from false-denying (the conformance suite's fp-python-heredoc
//     case: `python3 - <<'PYEOF'` whose body is `print('python3 ... send.py --to a@b.hu')`).
//   - Everything else that stays scanned (curl-non-exempt, git-non-exempt, an unrecognised argv[0])
//     gets the full legacy SEND_PATTERNS scan, same as the content-scan this composition replaces --
//     there is no interpreter-vs-content distinction to draw for an owner this gate cannot identify
//     as code-executing in the first place.
// End-of-token assertion, NOT `\b`: `\b` only requires a word/non-word transition, so it is satisfied
// the instant a listed name is a PREFIX of a longer identifier (`cat-relay`, `gh-copilot`, `node.exe`
// all match `\b` right after `cat`/`gh`/`node`). Cybersec NO-GO on card c7401c5f (comment #16876,
// differential battery vs commit 42bfd8b9): 6 inert-list + 10 interpreter-list false ALLOWs measured
// this way, including the entire `gh-<name>` class (the OFFICIAL GitHub CLI extension-naming
// convention -- `gh extension install owner/gh-foo` installs a directly-executable third-party binary
// literally named `gh-foo`). The lookahead below requires the match to end at end-of-string or a real
// shell metacharacter/whitespace -- i.e. the recognised name must be a COMPLETE shell token, exactly
// the discipline CURL_LEADING_RX/GIT_LEADING_RX (self-pace-gate.mjs) already apply with `\b` for names
// that never take a numeric/dotted suffix; these two names do (`node20`, `python3.11`), so the
// interpreter alternation also gets an explicit optional version suffix instead of relying on `\b`.
const HEREDOC_TOKEN_END = String.raw`(?=$|[\s<>|&;])`
const HEREDOC_INTERPRETER_RX = new RegExp(
  String.raw`^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:[./][\w./-]*/)?` +
    String.raw`(?:python(?:\d+(?:\.\d+)*)?|node(?:\d+)?|tsx|ts-node|deno|bun|npx|sh|bash|zsh|dash)` +
    HEREDOC_TOKEN_END,
  'i',
)
const HEREDOC_INERT_CONSUMER_RX = new RegExp(
  String.raw`^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:[./][\w./-]*/)?(?:cat|gh)` +
    HEREDOC_TOKEN_END,
  'i',
)

function heredocOwnerNeedsScan(ownerSpan) {
  if (CURL_LEADING_RX.test(ownerSpan) || GIT_LEADING_RX.test(ownerSpan)) {
    return !heredocIsStdinDataSink(ownerSpan)
  }
  return !HEREDOC_INERT_CONSUMER_RX.test(ownerSpan)
}

function heredocBodyMatchesSend(ownerSpan, body) {
  if (HEREDOC_INTERPRETER_RX.test(ownerSpan)) return heredocScriptSends(body)
  return SEND_PATTERNS.some((re) => re.test(body))
}

function heredocFeedsSend(cmd) {
  return heredocOwnerRecords(cmd).some(
    (r) => heredocOwnerNeedsScan(r.ownerSpan) && heredocBodyMatchesSend(r.ownerSpan, r.body),
  )
}

// Bash performs $(...) / backtick command substitution BEFORE the enclosing program ever sees the
// argument -- so a `-d` payload or an unquoted-tag heredoc body that merely LOOKS like inert data can
// still hide a real invocation (card 84e31b40's own reasoning: `curl -d "$(sendmail user@host)" url`
// really does invoke sendmail, regardless of what curl does with the substituted result). Extracted
// and recursed through isSendInvocation, the same treatment -c/-e code strings and wrapper-shell -c
// arguments already get above, just reached through a different bash construct. Deliberately kept
// OUT of segmentsTokens/maskSubshellMarkers (shared, parity-tested against outgoing-copy-gate.py's
// twin via send-invocation-conformance.test.ts) rather than folded in there -- no case in the shared
// conformance list exercises a substitution, so this stays a gateDecision-level composition, not a
// change to the cross-language contract.
function extractSubstitutions(cmd) {
  const src = String(cmd ?? '')
  const out = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === "'") { const j = src.indexOf("'", i + 1); i = j === -1 ? src.length : j + 1; continue }
    if (ch === '`') {
      const j = src.indexOf('`', i + 1)
      if (j === -1) break
      out.push(src.slice(i + 1, j))
      i = j + 1
      continue
    }
    if (ch === '$' && src[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      while (j < src.length && depth > 0) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === "'") { const k = src.indexOf("'", j + 1); j = k === -1 ? src.length : k + 1; continue }
        // BLOCKING (Cybersec NO-GO, card c7401c5f, comment #16876): a `)` inside a double-quoted
        // string was counted as depth-closing, so `echo "$(echo "a)b"; sendmail a@b)"` prematurely
        // ended the substitution at the `)` inside the nested "a)b" literal -- everything AFTER it
        // (the real sender) never got recursed into by substitutionSends(). Same fix shape as the
        // single-quote branch immediately above: inside a double-quoted run, `(`/`)` are not depth.
        if (src[j] === '"') { const k = src.indexOf('"', j + 1); j = k === -1 ? src.length : k + 1; continue }
        if (src[j] === '(') depth++
        else if (src[j] === ')') depth--
        j++
      }
      out.push(src.slice(i + 2, depth === 0 ? j - 1 : j))
      i = j
      continue
    }
    i++
  }
  return out
}

function substitutionSends(cmd, depth) {
  if (depth >= 3) return false
  return extractSubstitutions(cmd).some((inner) => isSendInvocation(inner, depth + 1))
}

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
  // heredocFeedsSend and substitutionSends both run over the RAW cmd (heredoc bodies and
  // $(...)/backtick content intact), independently of the position-based segments above (which
  // never see inside a heredoc body, and never expand a substitution -- see each helper's header).
  return (
    segments.some((toks) => segmentIsSend(toks, depth)) ||
    heredocFeedsSend(cmd) ||
    substitutionSends(cmd, depth)
  )
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
    // Card 72f5f13b merge decision -> resolved by card c7401c5f. Upstream's isSendInvocation() is
    // a genuinely more precise, position-aware detector (cross-tested against outgoing-copy-gate.py's
    // twin, see send-invocation-conformance.test.ts) and reduces real false positives (a git commit
    // message or a kanban-comment payload that merely NAMES a mailer no longer denies). But wiring it
    // in as a naive swap for the fork's legacy SEND_PATTERNS content-scan was a REPLACEMENT, not a
    // COMPOSITION: its heredoc handling (HEREDOC_RE inside segmentsTokens) discards EVERY heredoc body
    // before tokenizing, including one feeding an INTERPRETER (`python3 <<'PY' ... smtplib.SMTP(...)
    // ... PY`) -- a real send this fork's OWN extensively adversarially-hardened suite
    // (email-send-gate.test.ts, card 84e31b40, ~150 cases covering nested substitutions/quoting/
    // case-statement heredoc ownership) requires to still deny. isSendInvocation now composes with
    // that same ownership answer instead (heredocFeedsSend above, built on self-pace-gate.mjs's
    // heredocOwnerRecords -- the SAME hardened walker those 150 cases exercise, generalized to
    // classify an INTERPRETER owner rather than reimplemented) so this call is now the position-based
    // detector ALONE, with the heredoc-code-execution gap closed by composition rather than left open
    // or patched with a second, conflicting regex pass.
    if (isSendInvocation(String(toolInput?.command ?? ''))) return { deny: true }
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
