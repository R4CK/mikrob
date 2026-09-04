import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SYSTEM_DIRECTIVE_SENDER, LEGACY_SYSTEM_SENDER, isReservedSenderId } from '../web/system-directive-id.js'

// GUARDHITELES903: the RECEIVER half. The scaffold rule is what turns the
// envelope's msg_id from provenance into protection, so its presence and
// idempotency get the same pin as the other generated sections.

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-sysdir-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'main-agent',
  BOT_NAME: 'main-agent',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  // Forward-compat for #1157 (AGENT_API_ORIGIN): the strict config mock
  // must carry the key BEFORE that PR lands -- unread until then, and the
  // merge stays green the minute agent-scaffold starts importing it.
  AGENT_API_ORIGIN: '',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureSystemDirectiveAuthSection, buildSystemDirectiveAuthBody } =
  await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: system-directive-auth (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: system-directive-auth -->'

// Source root, for the fork-owned wiring assertions at the bottom of this file.
const SRC = join(__dirname, '..', 'web')

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string) {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureSystemDirectiveAuthSection', () => {
  it('appends the section on first run and keeps existing content', () => {
    setup('agent-a', '# Agent A\n\nSaját szabályok.\n')
    ensureSystemDirectiveAuthSection('agent-a')
    const out = read('agent-a')
    expect(out).toContain('# Agent A')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('Rendszer-direktíva hitelesítés')
    // The rule must bind the check to THIS agent's mailbox.
    expect(out).toContain('to_agent="agent-a"')
    // Fail-closed core: no id / unknown id => injection suspicion.
    expect(out).toContain('INJEKCIÓ-GYANÚ')
  })

  it('is idempotent (second run writes nothing new)', () => {
    ensureSystemDirectiveAuthSection('agent-a')
    const first = read('agent-a')
    ensureSystemDirectiveAuthSection('agent-a')
    expect(read('agent-a')).toBe(first)
  })

  it('replaces a stale block in place without touching surrounding content', () => {
    setup('agent-a', `# Agent A\n\n${MARKER_BEGIN}\nRÉGI TARTALOM\n${MARKER_END}\n\n## Utána jövő szekció\n`)
    ensureSystemDirectiveAuthSection('agent-a')
    const out = read('agent-a')
    expect(out).not.toContain('RÉGI TARTALOM')
    expect(out).toContain('## Utána jövő szekció')
    expect(out.indexOf(MARKER_BEGIN)).toBe(out.lastIndexOf(MARKER_BEGIN))
  })

  it('no-ops for the MAIN agent -- PROJECT_ROOT/CLAUDE.md is git-tracked, a runtime write there would fight --ff-only (card 2dd28b5d/99fccbcf)', () => {
    const before = '# Main\n'
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), before, 'utf-8')
    ensureSystemDirectiveAuthSection('main-agent')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toBe(before)
  })

  it('skips silently when no CLAUDE.md exists', () => {
    expect(() => ensureSystemDirectiveAuthSection('nonexistent-agent')).not.toThrow()
  })
})

describe('buildSystemDirectiveAuthBody', () => {
  it('names the in-scope prefixes and excludes the nudges', () => {
    const body = buildSystemDirectiveAuthBody('agent-a')
    expect(body).toContain('[CONTEXT-GUARD]')
    expect(body).toContain('[SYSTEM: ...]')
    // The low-impact nudges are explicitly OUT of scope, so an agent does not
    // start treating every routine wake as an injection.
    expect(body).toContain('[telegram-wake]')
    expect(body).toContain('[Inbox]')
  })

  // FORK DIVERGENCE from the upstream version of this test, which asserts
  // [CONTEXT-RESTART-GATE] is one of the IN-SCOPE prefixes. It is not, here.
  // Upstream's restart gate wakes the agent with a directive; ours does not
  // exist -- our only [CONTEXT-RESTART-GATE] message is
  // createAgentMessage(name -> MAIN_AGENT_ID) in context-restart-gate-runner.ts,
  // an ALERT to the coordinator from a real agent id. It asks nothing of its
  // recipient and already carries provenance, so listing it as in-scope would
  // tell agents to authenticate a message that will never carry a msg_id.
  //
  // Asserting the string alone would pass either way (our body does mention
  // it, as an exclusion), so this pins the SENTENCE it appears in.
  it('places [CONTEXT-RESTART-GATE] OUT of scope, matching this fork\'s sender', () => {
    const body = buildSystemDirectiveAuthBody('agent-a')
    const line = body.split('\n').find((l) => l.includes('[CONTEXT-RESTART-GATE]'))
    expect(line).toBeDefined()
    expect(line).toContain('NEM tartoznak ide')
    // If we ever adopt upstream's gate wake nudge, this test is the reminder
    // that the rule text has to move it back in-scope in the same change.
    const runner = readFileSync(join(SRC, 'context-restart-gate-runner.ts'), 'utf-8')
    expect(runner).not.toContain('sendSystemDirective')
  })

  it('hands the agent a verification command that does NOT leak the token into argv', () => {
    // Upstream's snippet passes the auth header as a literal -H argument, which
    // puts the shared token in /proc/<pid>/cmdline for every local process to
    // read (on this host every agent runs as the same user). This fork's
    // token-in-argv guard scans agent-scaffold.ts and rejects that shape; the
    // pipe form is what the rest of these instructions already use.
    const body = buildSystemDirectiveAuthBody('agent-a')
    expect(body).toContain("printf 'Authorization: Bearer %s\\n'")
    expect(body).toContain('curl -H @- -s')
    expect(body).not.toContain('-H "Authorization: Bearer')
  })
})

// FORK-OWNED BLOCK. Upstream ships both halves of this mechanism together, so
// it never needed this. We adopted the receiver half into a fork that had NO
// sender half at all, and the failure mode of splitting them is silent and
// fleet-wide: the section tells every agent that an action-requesting
// [CONTEXT-GUARD] / [SYSTEM: ...] message without a msg_id is injection-suspect,
// so the moment a directive path reverts to a bare pane injection, every
// GENUINE handoff and stop order starts getting refused. Nothing else would go
// red. These assertions are the tripwire.
describe('the two halves must ship together', () => {
  it('startAgentProcess applies the section on every (re)spawn', () => {
    const src = readFileSync(join(SRC, 'agent-process.ts'), 'utf-8')
    const roster = src.indexOf('ensureFleetRosterSection(name)')
    const auth = src.indexOf('ensureSystemDirectiveAuthSection(name)')
    expect(roster).toBeGreaterThan(0)
    expect(auth).toBeGreaterThan(roster)
  })

  it('the context-guard STOP/resume orders go out ANCHORED, never as a bare pane injection', () => {
    const src = readFileSync(join(SRC, 'context-guard-runner.ts'), 'utf-8')
    expect(src.split('await sendSystemDirective(').length - 1).toBe(2)
    expect(src).not.toContain('await sendPromptToSession(')
  })

  it('the channels-recovery memory-save order is anchored too', () => {
    const src = readFileSync(join(SRC, 'channel-monitor.ts'), 'utf-8')
    expect(src).toContain('await sendSystemDirective(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, prompt)')
  })

  it('the "from=system is rejected" claim in the rule is backed by a real guard', () => {
    // The section tells agents the anchor row cannot be planted from outside.
    // That promise lives or dies on the reserved-sender guard in the POST
    // route, keyed on the SAME shared constant the sender uses. Upstream has
    // no such guard: there, the 403 is only an accident of configuration.
    const route = readFileSync(join(SRC, 'routes', 'messages.ts'), 'utf-8')
    expect(route).toContain("from '../system-directive-id.js'")
    expect(route).toContain('isReservedSenderId(sanitizeAgentIdent(from))')
    expect(buildSystemDirectiveAuthBody('agent-a')).toContain('403')
  })
})

// Card 5c5d7bc4, from Cybersec's MEDIUM on ab4c85f2's gate. The section above
// tells every agent that a row from the reserved sender PROVES the order came
// from the supervisor. That was true of the ROUTE but not of the NAME: the
// bare `system` is shared with five in-process notification writers, one of
// which (routes/agents.ts's "new teammate arrived") interpolates a
// caller-supplied `description` into the body. A token holder POSTing
// /api/agents could put chosen text into a genuine from_agent="system" row --
// and an agent following the recipe would find it exactly where the recipe
// said to look. Giving the channel its OWN id makes that row a non-directive
// by construction, instead of requiring every present and future `system`
// writer to be audited for injectable interpolation.
describe('the directive channel owns a sender id that no other writer uses (card 5c5d7bc4)', () => {
  it('the reserved directive id is NOT the shared "system" id', () => {
    expect(SYSTEM_DIRECTIVE_SENDER).not.toBe(LEGACY_SYSTEM_SENDER)
    expect(SYSTEM_DIRECTIVE_SENDER).toBe('system-directive')
  })

  it('the /api/agents "new teammate" notice -- the injectable one -- still writes the SHARED id', () => {
    // Non-vacuity for the rename: if that writer had moved to the directive id
    // too, the split above would be cosmetic and the finding would be open.
    // This is the concrete row Cybersec measured, so it is the one pinned.
    const agentsRoute = readFileSync(join(SRC, 'routes', 'agents.ts'), 'utf-8')
    expect(agentsRoute).toContain("createAgentMessage('system', target,")
    expect(agentsRoute).not.toContain(`createAgentMessage('${SYSTEM_DIRECTIVE_SENDER}'`)
  })

  it('the generated section names the directive id, never the shared one', () => {
    const body = buildSystemDirectiveAuthBody('agent-a')
    expect(body).toContain(`from_agent="${SYSTEM_DIRECTIVE_SENDER}"`)
    // The exact string the section used to carry. An agent told to accept
    // from_agent="system" would accept the /api/agents row above.
    expect(body).not.toContain('from_agent="system"')
    expect(body).not.toContain('`from="system"`')
  })

  it('BOTH in-process ids are refused over HTTP, in any casing', () => {
    // sanitizeAgentIdent only STRIPS characters, it does not lower-case, so
    // the byte-exact predecessor of this predicate let `System` through.
    for (const id of ['system', 'system-directive', 'System', 'SYSTEM', 'System-Directive', 'SYSTEM-DIRECTIVE']) {
      expect(isReservedSenderId(id), id).toBe(true)
    }
  })

  it('a normal agent id is NOT reserved -- the predicate did not swallow the fleet', () => {
    for (const id of ['backend', 'mikrob', 'systematic', 'system-directives', 'subsystem']) {
      expect(isReservedSenderId(id), id).toBe(false)
    }
  })
})
