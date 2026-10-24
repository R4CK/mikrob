// #1305 (ISSUE1305HOOKSCOPE): the tracked .claude/settings.json is the
// AUTHORITATIVE registration surface for the main agent's fleet hooks. The
// scaffold refuses to write them anywhere else (hook-scope-main-refusal
// pins that), so if an entry silently falls out of this file, nothing
// re-adds it -- the hook just stops firing. This anchor makes such a drop
// loud: the full expected set is spelled out, per event.
//
// Portability is part of the contract: every command must resolve through
// $CLAUDE_PROJECT_DIR (the file ships to every install), and the WebFetch
// egress gate must keep its fail-CLOSED preamble -- the user-global variant
// pinned a machine-local node path, which is exactly what broke in the
// owner's own sessions (#1305) and what a "simplifying" edit would
// reintroduce.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SETTINGS_PATH = join(ROOT, '.claude', 'settings.json')

interface HookEntry { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }
type Hooks = Record<string, HookEntry[]>

const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as { hooks?: Hooks }
const hooks: Hooks = settings.hooks ?? {}

// The full expected registration: event -> one entry per matcher group
// (order-free, duplicates count): the script basename, followed by
// ` @ <matcher>` when the group has a matcher. A change here is a REVIEWED
// decision about what runs in the main session, never a side effect.
//
// Group granularity matters because several scripts are registered under more
// than one matcher (outgoing-copy-gate.py and email-approval-gate.py: one group
// per mail surface and channel). A script-name set stays green when one of
// those groups is deleted or its matcher narrowed, and when a non-gate hook's
// matcher changes; this list does not.
//
// Both channel providers' progress hooks are listed unconditionally. That is
// deliberate: each one is provider-scoped internally and no-ops on the other
// provider's turns, so the cost of the idle set is a process spawn. Only the
// watchdog DAEMON -- which polls on a timer whether or not a turn is in
// flight -- is gated to the active CHANNEL_PROVIDER, by the two
// install-*-progress-hook.sh scripts.
const EXPECTED: Record<string, string[]> = {
  UserPromptSubmit: [
    'ledger-capture.py', 'inbox-drain.py', 'telegram-reply-directive.py',
    'provenance-gate.py', 'memory-lookup-nudge.py', 'staleness-guard.py', 'channel-inbox-drain.py',
    'voice-reply-directive.py', 'telegram_progress.py',
    'marveen-commands.py',
  ],
  PostToolUse: [
    'ledger-outbound.py @ mcp__plugin_telegram_telegram__reply', 'tool-log-capture.py',
    'telegram_progress_reply_clear.py @ telegram.*reply', 'slack_progress_reply_clear.py @ slack.*reply',
    'skill-usage-capture.py @ Skill|Read', 'memory-frontmatter-bash-gate.py @ Bash',
    // The persona guard watches the main agent's own CLAUDE.md/SOUL.md and
    // every agents/*/ pair, and it must fire on EVERY tool call: the first
    // version filtered on the Write/Edit file_path and a python3 heredoc
    // walked straight past it. PostToolUse is the event that cannot be
    // dodged by choosing a different tool.
    'persona-change-notify.py',
  ],
  // A failed tool call fires PostToolUseFailure, never PostToolUse
  // (TOOLLOGVAKSIKER921): without this entry tool_call_log cannot hold a 0.
  // KAPUEGYUT918: a failed Bash call can still have written a memory file.
  PostToolUseFailure: ['tool-log-capture.py', 'memory-frontmatter-bash-gate.py @ Bash'],
  PreToolUse: [
    'outgoing-copy-gate.py @ Bash',
    'outgoing-copy-gate.py @ .*send_email.*',
    'outgoing-copy-gate.py @ .*manage_email.*',
    'outgoing-copy-gate.py @ .*[Gg]mail.*__.*',
    'outgoing-copy-gate.py @ .*__[A-Za-z0-9_-]*[Gg]mail[A-Za-z0-9_-]*__.*',
    'outgoing-copy-gate.py @ .*__[A-Za-z0-9_-]*resend[A-Za-z0-9_-]*__.*',
    'outgoing-copy-gate.py @ .*draft_email.*',
    'outgoing-copy-gate.py @ mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message',
    'outgoing-copy-gate.py @ mcp__plugin_discord_discord__reply|mcp__plugin_discord_discord__edit_message',
    'email-approval-gate.py @ Bash',
    'email-approval-gate.py @ .*send_email.*',
    'email-approval-gate.py @ .*manage_email.*',
    'email-approval-gate.py @ .*[Gg]mail.*__.*',
    'email-approval-gate.py @ .*__[A-Za-z0-9_-]*[Gg]mail[A-Za-z0-9_-]*__.*',
    'email-approval-gate.py @ .*__[A-Za-z0-9_-]*resend[A-Za-z0-9_-]*__.*',
    'email-approval-gate.py @ .*draft_email.*',
    'channel-image-resize.sh @ Read', 'egress-gate.mjs @ WebFetch', 'memory-frontmatter-gate.py @ Write|Edit|MultiEdit',
    'memory-frontmatter-bash-gate.py @ Bash',
    // Card c00d5429 (2026-09-25): the main agent's own session ran with none of the ten
    // security guards every sub-agent's settings.json already carried (a live
    // `cd /etc && grep -c zzz hostname` ran unblocked here, rc=2 direct from the guard).
    'secret-write-guard.py @ Write|Edit|MultiEdit', 'big-file-guard.py @ Write', 'git-protect-guard.py @ Bash',
    'npm-protect-guard.py @ Bash', 'symlinked-node-modules-guard.py @ Bash', 'agent-key-secret-guard.py @ Bash',
    'blast-radius-guard.py @ Edit|Write|MultiEdit', 'cd-chain-guard.py @ Bash', 'bash-egress-guard.py @ Bash',
    'noisy-command-guard.py @ Bash', 'pentest-tool-install-guard.py @ Bash',
  ],
  Stop: [
    'marveen-commands.py', 'telegram-reply-guard.py', 'telegram_progress_clear.py',
    '<no script: touch "$CLAUDE_PROJECT_DIR/store/mikrob-alive.heartbeat">',
  ],
  StopFailure: ['ledger-turn-failure.py'],
  SessionStart: [
    'ledger-replay.py @ startup|resume|clear', 'taskstate-replay.py @ compact|resume|clear',
    'clear-replay.py @ clear', 'marveen-commands.py',
  ],
  SessionEnd: ['clear-capture.py'],
}

function commands(event: string): string[] {
  return (hooks[event] ?? []).flatMap((e) => e.hooks ?? []).map((h) => h.command ?? '')
}

const scriptOf = (command: string) => command.match(/scripts\/hooks\/([^/\s'"]+?\.(?:py|sh|mjs))/)?.[1] ?? ''

function scriptNames(event: string): Set<string> {
  return new Set(commands(event).map(scriptOf).filter(Boolean))
}

// Card c00d5429, Cybersec F1 MEDIUM (komment 6081/6100): the checks above only pin that a
// guard SCRIPT is present, not what MATCHER it is wired to -- Cybersec's own mutations proved
// both a narrowed matcher (secret-write-guard.py: Write|Edit|MultiEdit -> Write, leaving
// Edit/MultiEdit unguarded) and a matcher pointed at a tool name that never fires
// (cd-chain-guard.py: Bash -> a nonexistent tool) leave the existing "script set" test 8/8
// GREEN. Pin the (script, matcher) PAIR for every PreToolUse entry instead.
interface HookPair { script: string; matcher: string }

function preToolUsePairs(): HookPair[] {
  return (hooks.PreToolUse ?? []).flatMap((e) => {
    const matcher = e.matcher ?? ''
    return (e.hooks ?? [])
      .map((h) => h.command ?? '')
      .map((c) => c.match(/scripts\/hooks\/([^/\s'"]+?\.(?:py|sh|mjs))/)?.[1] ?? '')
      .filter(Boolean)
      .map((script) => ({ script, matcher }))
  })
}

function pairKey(p: HookPair): string {
  return `${p.script}::${p.matcher}`
}

// One entry per (script, matcher) pair actually wired in the tracked file today. A script that
// legitimately fires on several matchers (outgoing-copy-gate.py, email-approval-gate.py) gets
// one row per matcher -- collapsing to a script-only set is exactly the blind spot this pins.
const EXPECTED_PRETOOLUSE_PAIRS: HookPair[] = [
  { script: 'outgoing-copy-gate.py', matcher: 'Bash' },
  { script: 'outgoing-copy-gate.py', matcher: '.*send_email.*' },
  { script: 'outgoing-copy-gate.py', matcher: '.*manage_email.*' },
  { script: 'outgoing-copy-gate.py', matcher: '.*[Gg]mail.*__.*' },
  { script: 'outgoing-copy-gate.py', matcher: '.*__[A-Za-z0-9_-]*[Gg]mail[A-Za-z0-9_-]*__.*' },
  { script: 'outgoing-copy-gate.py', matcher: '.*__[A-Za-z0-9_-]*resend[A-Za-z0-9_-]*__.*' },
  { script: 'outgoing-copy-gate.py', matcher: '.*draft_email.*' },
  { script: 'outgoing-copy-gate.py', matcher: 'mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message' },
  { script: 'outgoing-copy-gate.py', matcher: 'mcp__plugin_discord_discord__reply|mcp__plugin_discord_discord__edit_message' },
  { script: 'email-approval-gate.py', matcher: 'Bash' },
  { script: 'email-approval-gate.py', matcher: '.*send_email.*' },
  { script: 'email-approval-gate.py', matcher: '.*manage_email.*' },
  { script: 'email-approval-gate.py', matcher: '.*[Gg]mail.*__.*' },
  { script: 'email-approval-gate.py', matcher: '.*__[A-Za-z0-9_-]*[Gg]mail[A-Za-z0-9_-]*__.*' },
  { script: 'email-approval-gate.py', matcher: '.*__[A-Za-z0-9_-]*resend[A-Za-z0-9_-]*__.*' },
  { script: 'email-approval-gate.py', matcher: '.*draft_email.*' },
  { script: 'channel-image-resize.sh', matcher: 'Read' },
  { script: 'egress-gate.mjs', matcher: 'WebFetch' },
  { script: 'secret-write-guard.py', matcher: 'Write|Edit|MultiEdit' },
  { script: 'big-file-guard.py', matcher: 'Write' },
  { script: 'git-protect-guard.py', matcher: 'Bash' },
  { script: 'npm-protect-guard.py', matcher: 'Bash' },
  { script: 'symlinked-node-modules-guard.py', matcher: 'Bash' },
  { script: 'agent-key-secret-guard.py', matcher: 'Bash' },
  { script: 'blast-radius-guard.py', matcher: 'Edit|Write|MultiEdit' },
  { script: 'cd-chain-guard.py', matcher: 'Bash' },
  { script: 'bash-egress-guard.py', matcher: 'Bash' },
  { script: 'noisy-command-guard.py', matcher: 'Bash' },
  { script: 'pentest-tool-install-guard.py', matcher: 'Bash' },
  { script: 'memory-frontmatter-gate.py', matcher: 'Write|Edit|MultiEdit' },
  { script: 'memory-frontmatter-bash-gate.py', matcher: 'Bash' },
]

// One descriptor per handler, in the EXPECTED form: '<script>' or '<script> @ <matcher>'.
function groupDescriptors(event: string): string[] {
  return (hooks[event] ?? []).flatMap((e) => (e.hooks ?? []).map((h) => {
    const script = scriptOf(h.command ?? '') || `<no script: ${h.command ?? ''}>`
    return e.matcher === undefined ? script : `${script} @ ${e.matcher}`
  }))
}

// The keys this file uses today. A new key (a stray `id` or `description`, a
// handler option nobody reviewed) has to be added here on purpose.
const GROUP_KEYS = new Set(['matcher', 'hooks'])
const HANDLER_KEYS = new Set(['type', 'command', 'timeout'])

describe('tracked .claude/settings.json hook anchor (#1305)', () => {
  it('registers exactly the expected script set per event', () => {
    expect(Object.keys(hooks).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const [event, expected] of Object.entries(EXPECTED)) {
      // Non-script commands (e.g. a bare `touch`) show up only as a `<no script: ...>`
      // descriptor in the richer matcher-group test below; scriptNames() filters them out
      // the same way, via scriptOf()'s empty-match -> falsy -> Boolean filter.
      const names = expected.map((d) => d.split(' @ ')[0]).filter((n) => !n.startsWith('<no script:'))
      expect([...scriptNames(event)].sort(), `event ${event}`).toEqual([...new Set(names)].sort())
    }
  })

  it('registers exactly the expected matcher groups per event (each group, each matcher)', () => {
    for (const [event, expected] of Object.entries(EXPECTED)) {
      expect(groupDescriptors(event).sort(), `event ${event}`).toEqual([...expected].sort())
    }
  })

  it('uses only the reviewed hook keys (matcher group: matcher, hooks; handler: type, command, timeout)', () => {
    for (const [event, entries] of Object.entries(hooks)) {
      entries.forEach((e, i) => {
        for (const k of Object.keys(e)) expect(GROUP_KEYS.has(k), `${event}[${i}] group key ${k}`).toBe(true)
        for (const h of e.hooks ?? []) {
          for (const k of Object.keys(h)) expect(HANDLER_KEYS.has(k), `${event}[${i}] handler key ${k}`).toBe(true)
        }
      })
    }
  })

  it('PreToolUse: exact (script, matcher) pairs -- a guard cannot silently lose or narrow its trigger (Cybersec F1, card c00d5429)', () => {
    const actual = preToolUsePairs().map(pairKey).sort()
    const expected = EXPECTED_PRETOOLUSE_PAIRS.map(pairKey).sort()
    expect(actual).toEqual(expected)
  })

  it('every referenced script exists in scripts/hooks/', () => {
    for (const event of Object.keys(EXPECTED)) {
      for (const name of scriptNames(event)) {
        expect(existsSync(join(ROOT, 'scripts', 'hooks', name)), `missing scripts/hooks/${name}`).toBe(true)
      }
    }
  })

  it('every command is portable: $CLAUDE_PROJECT_DIR, no machine-local paths', () => {
    for (const event of Object.keys(hooks)) {
      for (const cmd of commands(event)) {
        expect(cmd, `event ${event}`).toContain('$CLAUDE_PROJECT_DIR')
        expect(cmd).not.toMatch(/\/(Users|home|opt|var)\//)
      }
    }
  })

  it('the WebFetch egress gate keeps its fail-closed preamble', () => {
    const webfetch = (hooks.PreToolUse ?? []).filter((e) => e.matcher === 'WebFetch')
    expect(webfetch).toHaveLength(1)
    const cmd = webfetch[0].hooks?.[0]?.command ?? ''
    // No node -> BLOCK (exit 2), never fail-open silence.
    expect(cmd).toMatch(/command -v node[^;]*\|\|\s*\{[^}]*exit 2/)
    expect(cmd).toContain('egress-gate.mjs')
  })
})
