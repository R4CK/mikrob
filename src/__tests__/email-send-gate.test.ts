import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/email-send-gate.mjs'
import { injectEmailSendGate, agentGetsEmailGate } from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

// The PreToolUse gate decision: which tool calls count as outbound email-send.
describe('gateDecision', () => {
  it('blocks any MCP send_email tool (name-agnostic)', () => {
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__send_email', {}).deny).toBe(true)
    // a differently-named gmail server in a customer install is still gated
    expect(gateDecision('mcp__some_other_gmail__send_email', {}).deny).toBe(true)
  })

  it('allows email READ/draft tools (only sending is gated)', () => {
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__search_emails', {}).deny).toBe(false)
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__read_email', {}).deny).toBe(false)
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__draft_email', {}).deny).toBe(false)
  })

  it('blocks Bash mail-send commands', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('python3 scripts/support-mail/send.py --to x@y.hu').deny).toBe(true)
    expect(bash('curl -s -X POST https://api.resend.com/emails -d @body.json').deny).toBe(true)
    expect(bash('echo hi | sendmail user@host').deny).toBe(true)
    expect(bash('swaks --to a@b.c --server smtp').deny).toBe(true)
  })

  it('blocks the graph-mail.ts CLI send path (PR #668) and direct sendMail() calls', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('tsx scripts/graph-mail.ts send --to a@b.hu --subject x --body y').deny).toBe(true)
    expect(bash('npx tsx scripts/graph-mail.ts send --to a@b.hu --subject x --body y').deny).toBe(true)
    expect(bash(`node -e "require('./src/graph-mail.js').sendMail({to:'a@b.hu'})"`).deny).toBe(true)
    // read-only graph-mail subcommands are NOT send-shaped, so they pass through
    // this gate untouched (they still can't do anything a sub-agent shouldn't:
    // verify/list only read the scoped mailbox)
    expect(bash('tsx scripts/graph-mail.ts verify').deny).toBe(false)
    expect(bash('tsx scripts/graph-mail.ts list --unread').deny).toBe(false)
  })

  it('allows ordinary Bash that does not send mail', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('git status').deny).toBe(false)
    expect(bash('npm run build').deny).toBe(false)
    expect(bash('curl -s http://localhost:3420/api/messages').deny).toBe(false)
    // mentioning "resend" without an email/send verb nearby is not gated
    expect(bash('grep resend src/foo.ts').deny).toBe(false)
  })
})

// Card 132fc28c, incident msg 8641: a kanban-comment POST to an UNRELATED endpoint
// (localhost:3420/api/kanban, not an email API) carried prose discussing whether the
// PRODUCT should send a registration email; the text mentioned "Resend" (the email
// provider) near "email"/"send" and matched SEND_PATTERNS's proximity regex, blocking
// the comment as if it were an actual send. The gate must key on the ACTION (a real
// email-API/SMTP call), not on text content that merely discusses email.
describe('gateDecision: data-payload false-positive guard (card 132fc28c)', () => {
  it('ALLOWS a kanban-comment POST whose JSON body discusses sending a registration email via Resend', () => {
    const cmd =
      `curl -s -X POST http://localhost:3420/api/kanban/06f81738/comments -d ` +
      `'{"author":"backend","content":"Kell-e a termeknek Resend-en keresztul regisztracios aktivacios emailt kuldenie?"}'`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(false)
  })

  it('ALLOWS the same content in a double-quoted payload without substitution', () => {
    const cmd =
      `curl -s -X POST http://localhost:3420/api/kanban/06f81738/comments -d ` +
      `"{\\"content\\":\\"resend api key kell a regisztracios email kuldeshez\\"}"`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(false)
  })

  it('KEEPS a payload that can command-substitute ($(...)) -- not blanked, still scannable', () => {
    const cmd = `curl -d "$(sendmail user@host)" http://localhost:3420/api/kanban`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('STILL denies a REAL send to api.resend.com -- the URL lives outside the payload', () => {
    const cmd = `curl -s -X POST https://api.resend.com/emails -d '{"to":"a@b.hu"}'`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('STILL denies sendmail/msmtp/swaks even when a DIFFERENT curl -d payload is present in the same command', () => {
    const cmd = `curl -d '{"note":"resend the invoice email"}' http://localhost:3420/x ; sendmail user@host`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('a -d @file (file reference, no inline text) is untouched -- nothing to blank either way', () => {
    expect(gateDecision('Bash', { command: 'curl -s -X POST https://api.resend.com/emails -d @body.json' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: 'curl -s -X POST http://localhost:3420/api/kanban/x/comments -d @comment.json' }).deny).toBe(false)
  })
})

// The main-exempt guard: every sub-agent is gated, the main agent never is.
// Mirrors security-profile-resolution.test.ts -- pure, keyed on the configured
// MAIN_AGENT_ID (not a hardcoded name), so a customer install exempts its own owner.
describe('agentGetsEmailGate', () => {
  it('gates every sub-agent', () => {
    expect(agentGetsEmailGate('samu')).toBe(true)
    expect(agentGetsEmailGate('boni')).toBe(true)
    expect(agentGetsEmailGate('zara')).toBe(true)
  })

  it('NEVER gates the main agent (it retains email-send)', () => {
    expect(agentGetsEmailGate(MAIN_AGENT_ID)).toBe(false)
  })
})

// The settings.json wiring that installs the hook for a sub-agent.
describe.skipIf(REPO_UNDER_TMP)('injectEmailSendGate', () => {
  it('adds the PreToolUse email-gate hook', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    expect(hooks).toHaveLength(1)
    expect(hooks[0].matcher).toBe('Bash|send_email')
    const inner = (hooks[0].hooks as Array<{ command: string }>)[0]
    expect(inner.command).toContain('email-send-gate.mjs')
  })

  it('is idempotent (no duplicate entries on re-apply / respawn)', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    injectEmailSendGate(s)
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(hooks).toHaveLength(1)
  })

  it('preserves existing hooks (e.g. PreCompact) and other PreToolUse entries', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }],
        PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'other.sh' }] }],
      },
    }
    injectEmailSendGate(s)
    const hooks = s.hooks as Record<string, unknown>
    expect((hooks.PreCompact as unknown[]).length).toBe(1)
    const pre = hooks.PreToolUse as Array<Record<string, unknown>>
    // the unrelated WebFetch entry is kept, the email-gate is appended
    expect(pre).toHaveLength(2)
    expect(pre.some((e) => JSON.stringify(e).includes('email-send-gate.mjs'))).toBe(true)
    expect(pre.some((e) => e.matcher === 'WebFetch')).toBe(true)
  })
})

// Always runs: a CI log must never be ambiguous about whether the tmp-sensitive suites above were
// armed or skipped (card 252e36d3 -- 13 phantom "failures" were once tracked as a real red baseline).
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the hook-registration suites in this file were armed or skipped', () => {
    if (REPO_UNDER_TMP) {
      console.log(`[${'email-send-gate.test.ts'}] SKIPPED hook-registration suites -- ${TMP_SKIP_REASON}`)
    } else {
      console.log(`[${'email-send-gate.test.ts'}] ARMED -- checkout is outside /tmp, hook-registration assertions ran.`)
    }
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})
