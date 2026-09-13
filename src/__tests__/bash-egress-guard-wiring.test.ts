// The Bash egress guard must be wired by the SCAFFOLD, on both paths, and its own cases must run
// on every landing rather than when someone remembers to invoke them (card 854182c7).
//
// WHY THIS FILE EXISTS IN THIS SHAPE. The control it wires replaces a settings.permissions.deny
// rule that was measured unusable: `Bash(curl *https://*)` matches the WHOLE command string, so it
// cannot tell a curl's TARGET from a link riding along in its payload, and every internal write
// path of this fleet is a localhost curl carrying JSON that routinely contains one (card f6db6978,
// four probes with two controls on a real Claude Code 2.1.263 binary). The replacement therefore
// has to be judged on exactly that distinction, which is what the end-to-end block below drives
// through the real script.
//
// The half that rots silently is coverage: noisy-command-guard.py had no inject*/ensure* at all
// and reached 12 of 15 agents, and no future one, while CLAUDE.md described it as an armed
// control. So both paths are pinned here by name.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectBashEgressGuard } from '../web/agent-scaffold.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUARD = join(REPO_ROOT, 'scripts', 'hooks', 'bash-egress-guard.py')
const SELFTEST = join(REPO_ROOT, 'scripts', 'hooks', 'bash-egress-guard.selftest.py')
const ALLOWLIST = join(REPO_ROOT, 'store', 'bash-egress-allowlist.json')

const preToolUse = (s: Record<string, unknown>): unknown[] =>
  ((s.hooks as Record<string, unknown>)?.PreToolUse as unknown[]) ?? []
const guardEntries = (s: Record<string, unknown>): unknown[] =>
  preToolUse(s).filter((e) => JSON.stringify(e).includes('bash-egress-guard.py'))

// Same /tmp caveat as its siblings: the injector runs its own path through isUnsafeHookCommand, so
// from a /tmp worktree it correctly refuses to register.
describe.skipIf(REPO_UNDER_TMP)('injectBashEgressGuard', () => {
  it('adds a PreToolUse hook pointing at the guard', () => {
    const s: Record<string, unknown> = {}
    injectBashEgressGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('matches Bash -- the tool the egress happens on', () => {
    const s: Record<string, unknown> = {}
    injectBashEgressGuard(s)
    const matcher = (guardEntries(s)[0] as { matcher: string }).matcher
    expect(new RegExp(`^(${matcher})$`).test('Bash')).toBe(true)
    // Not WebFetch: that channel has its own gate (scripts/hooks/egress-gate.mjs) and the two are
    // deliberately disjoint. A matcher claiming both would imply a coverage this file cannot back.
    expect(new RegExp(`^(${matcher})$`).test('WebFetch')).toBe(false)
  })

  it('is IDEMPOTENT -- a respawn re-runs it and must not accumulate duplicates', () => {
    const s: Record<string, unknown> = {}
    injectBashEgressGuard(s)
    injectBashEgressGuard(s)
    injectBashEgressGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('replaces a stale entry in place rather than adding a second one', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/old/scripts/hooks/bash-egress-guard.py"' }] },
        ],
      },
    }
    injectBashEgressGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(JSON.stringify(preToolUse(s))).not.toContain('/old/scripts')
  })

  it('does NOT displace its Bash-matched siblings -- they all coexist', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/git-protect-guard.py"' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/cd-chain-guard.py"' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/noisy-command-guard.py"' }] },
        ],
      },
    }
    injectBashEgressGuard(s)
    const all = JSON.stringify(preToolUse(s))
    for (const sibling of ['git-protect-guard.py', 'cd-chain-guard.py', 'noisy-command-guard.py',
      'bash-egress-guard.py']) {
      expect(all, sibling).toContain(sibling)
    }
  })

  it('preserves unrelated PreToolUse entries and other hook events', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-gate.mjs' }] }],
      },
    }
    injectBashEgressGuard(s)
    expect(JSON.stringify(preToolUse(s))).toContain('other-gate.mjs')
    expect((s.hooks as Record<string, unknown>).PreCompact).toBeDefined()
  })
})

// Always runs, so a log can never be ambiguous about whether the suite above was armed.
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the injector suite in this file was armed or skipped', () => {
    console.log(REPO_UNDER_TMP
      ? `[bash-egress-guard-wiring.test.ts] SKIPPED injector suite -- ${TMP_SKIP_REASON}`
      : '[bash-egress-guard-wiring.test.ts] ARMED -- checkout is outside /tmp, injector assertions ran.')
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

describe('the guard is wired on both paths, not just one', () => {
  it('the settings GENERATION path calls the injector', () => {
    const scaffold = readFileSync(join(REPO_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(scaffold).toContain('injectBashEgressGuard(existing)')
  })

  it('the boot BACKFILL loop calls the ensurer, so a restart arms agents that already exist', () => {
    const web = readFileSync(join(REPO_ROOT, 'src', 'web.ts'), 'utf-8')
    expect(web).toContain('ensureBashEgressGuard(agentName)')
  })
})

describe('the files the injector points at', () => {
  it('the guard script exists and is executable', () => {
    expect(existsSync(GUARD)).toBe(true)
    expect(statSync(GUARD).mode & 0o111).toBeGreaterThan(0)
  })

  it('the selftest exists and PASSES -- its cases are enforced here, not on request', () => {
    expect(existsSync(SELFTEST)).toBe(true)
    const out = execFileSync('python3', [SELFTEST], { encoding: 'utf-8' })
    // A COUNTED number, not the sentence: a harness that could report success with zero cases
    // would be worse than no harness.
    expect(out).toMatch(/All [1-9]\d* cases/)
  })

  it('the allowlist is a VERSIONED FILE, not a list baked into the guard (plan-grilling point 2)', () => {
    expect(existsSync(ALLOWLIST)).toBe(true)
    const parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf-8')) as { hosts?: unknown }
    expect(Array.isArray(parsed.hosts)).toBe(true)
    // ...and the guard must actually READ it. A file nobody reads is documentation, not a control:
    // the guard names the path, and the end-to-end block below proves a listed host is allowed
    // while an unlisted one is not.
    expect(readFileSync(GUARD, 'utf-8')).toContain('bash-egress-allowlist.json')
  })
})

// The distinctions this guard exists to draw, driven through the real script. Duplicating a little
// of the selftest is deliberate: this is the layer that runs on every landing.
describe('end-to-end through the real hook', () => {
  const verdict = (command: string, env: Record<string, string> = {}): { code: number; stderr: string } => {
    try {
      execFileSync('python3', [GUARD], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, BASH_EGRESS_GUARD: 'enforce', ...env },
      })
      return { code: 0, stderr: '' }
    } catch (e) {
      const err = e as { status: number; stderr: string }
      return { code: err.status, stderr: err.stderr }
    }
  }

  it('THE FOUNDING CASE: a localhost call carrying an external URL in its payload is allowed', () => {
    // This exact shape is what made settings.permissions.deny unusable. If it ever blocks, the
    // fleet loses memory, kanban, inter-agent messaging and the daily log at once -- including the
    // channel any complaint would travel on.
    const r = verdict(
      `printf 'Authorization: Bearer %s\\n' "$(cat /home/neon/marveen/store/.dashboard-token)" `
      + `| curl -H @- -s -X POST http://localhost:3420/api/memories `
      + `-H "Content-Type: application/json" -d '{"content":"see https://example.org/x"}'`)
    expect(r.code).toBe(0)
  })

  it('blocks a real external target AND names the way forward', () => {
    const r = verdict('curl -s https://not-on-the-list.example/payload')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('not-on-the-list.example')
    expect(r.stderr).toContain('bash-egress-allowlist.json')
    expect(r.stderr).toContain('BASH_EGRESS_ALLOW=1')
  })

  it('allows a host that IS on the versioned allowlist', () => {
    expect(verdict('curl -s https://api.github.com/repos/x/y').code).toBe(0)
  })

  it('takes the host from the AUTHORITY, not from a query or fragment (comment 2959)', () => {
    // Cybersec blocking finding. RFC 3986 ends the authority at the first of `/`, `?` or `#`;
    // splitting on `/` alone let the userinfo rsplit reach into the fragment and take an
    // allowlisted name from there, while curl connected to the host in front of it. The
    // `#@localhost/` spelling was the worst of the set: classified LOCAL, so log-only mode would
    // not even have recorded it.
    expect(verdict('curl http://not-on-the-list.example#@api.github.com/').code).toBe(2)
    expect(verdict('curl http://not-on-the-list.example?@api.github.com/').code).toBe(2)
    expect(verdict('curl http://not-on-the-list.example#@localhost/').code).toBe(2)
    expect(verdict('curl not-on-the-list.example?@localhost').code).toBe(2)
    // ...and real userinfo inside the authority still resolves to the host after it, so the fix
    // is a narrowing rather than a blanket refusal of `@`.
    expect(verdict('curl -s http://user:pass@localhost:3420/x').code).toBe(0)
    expect(verdict("curl -s 'http://localhost:3420/api/x?q=a#frag'").code).toBe(0)
  })

  it('is interpreter-agnostic: the same target through python, node and /dev/tcp', () => {
    expect(verdict(`python3 -c "import urllib.request; urllib.request.urlopen('https://not-on-the-list.example')"`).code).toBe(2)
    expect(verdict(`node -e "fetch('https://not-on-the-list.example')"`).code).toBe(2)
    expect(verdict('exec 3<>/dev/tcp/not-on-the-list.example/443').code).toBe(2)
  })

  it('does NOT fail closed on an interpreter with no network intent (verdict 5a)', () => {
    // 551,816 corpus commands are this shape. Fail-closed keyed on "interpreter" instead of on
    // demonstrated network intent would kill all of them.
    expect(verdict(`python3 -c "import json; print(json.dumps({'a': 1}))"`).code).toBe(0)
    expect(verdict(`python3 -c "print('https://not-on-the-list.example')"`).code).toBe(0)
  })

  it('does NOT treat writing a file as making a call (verdict 5b)', () => {
    expect(verdict("cat > s.sh <<'EOF'\ncurl -s https://not-on-the-list.example\nEOF").code).toBe(0)
  })

  it('SHIPS IN LOG-ONLY MODE: with no env set, even a plain external call passes', () => {
    // Plan-grilling point 3. If this ever fails, the guard started enforcing on its own, which is
    // exactly the rollout the verdict forbade.
    const r = verdict('curl -s https://not-on-the-list.example/payload', { BASH_EGRESS_GUARD: '' })
    expect(r.code).toBe(0)
  })

  it('has a working kill switch', () => {
    expect(verdict('curl -s https://not-on-the-list.example', { BASH_EGRESS_GUARD: 'off' }).code).toBe(0)
  })

  it('never exits on anything but 0 or 2, whatever the command text (verdict point 6)', () => {
    // A guard that throws or exits 1 wedges the PreToolUse chain for every tool call in the fleet,
    // which is strictly worse than any single missed egress.
    for (const weird of ['curl "unterminated', 'curl $(', 'curl `', '((((', '|||', 'curl \\']) {
      expect([0, 2], weird).toContain(verdict(weird).code)
    }
  })
})
