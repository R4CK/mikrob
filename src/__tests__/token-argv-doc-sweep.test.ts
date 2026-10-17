import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// QA FAIL on card 0dab76a3 (comment 14540): the doc sweep for the
// `-H "Authorization: Bearer $(cat ...)"` argv-token anti-pattern (readable
// from /proc/<pid>/cmdline by any local process, CLAUDE.md's own standing
// rule) missed 2 tracked, actually-invoked files
// (scheduled-tasks/dream-engine/SKILL.md, scheduled-tasks/memoria-heartbeat/
// SKILL.md) because the sweep was run once by hand and not re-checked
// structurally.
//
// QA FAIL round 2 (comment 14570): the structural guard above was itself too
// narrow -- it only matched the literal `$(cat` spelling, so
// docs/scheduled-tasks.md's `-H "Authorization: Bearer $TOKEN"` (token read
// from a VARIABLE set earlier via `TOKEN=$(cat ...)`, not inline) was
// invisible to it even though the risk (token in argv, readable via
// /proc/<pid>/cmdline) is identical. Widened per MikroB's dispatch (comment
// 14571) to catch ANY `-H "Authorization: Bearer <anything>"` argv shape --
// variable, `$(...)`, or a bare literal -- not just the one spelling. The
// sanctioned `printf '...' | curl -H @-` form never matches: its `-H` is
// followed by `@-`, never by a quoted `Authorization: Bearer` string (the
// header text lives in printf's OWN argument, piped to curl's stdin, never
// curl's argv).
//
// seed-fleet-agents/ is EXCLUDED from the pathspec on purpose: those files are
// vendored (templated per agent, 722 tracked files) third-party pentest
// reference docs demonstrating standard curl syntax against EXTERNAL,
// authorized target APIs (ffuf/JWT/BOLA testing skills) -- rewriting a
// red-team cheat-sheet's example command to `-H @-` would not protect this
// system's own dashboard token (the thing this sweep actually cares about)
// and would corrupt reference material that is correct as written for ITS
// stated purpose.
//
// Every remaining tracked .md/.sh hit is either the known-safe set below
// (DECISIONS.md history, a comment NAMING the anti-pattern to explain why it
// is forbidden, or store/sync-agent-templates.sh's own fixtures/docstring for
// the rewriter that fixes this exact shape in the gitignored agents/ copies)
// or a NEW, unreviewed occurrence that must fail this test until triaged.
const ROOT = join(__dirname, '..', '..')

const AUTH_ARGV_PATTERN = '-H[[:space:]]*["\']Authorization:[[:space:]]*Bearer'

// path -> allowed line numbers (git grep -nE output, 1-indexed)
const ALLOWLIST: Record<string, number[]> = {
  'DECISIONS.md': [1164, 4931, 14889, 15034, 15076, 15747, 20372], // historical decision entries about this exact fix
  'README.md': [216], // fork-fejlesztés bullet NAMING the anti-pattern it fixed, not an invocation (shifted to 216 by card d06a325d's urgent/STOP-delivery bullet landing above it)
  'docs/memoria-szuro-hamis-pozitiv-negativ-meres.md': [223], // doc table example row with a placeholder "X" token, not an invocation
  'scripts/agent-msg-get.sh': [30], // comment naming the anti-pattern, not an invocation (shifted by the PORT chain, card d06a325d/#1869)
  'scripts/install-prod-tree-guard-hook.sh': [204, 269], // comment naming the anti-pattern, not an invocation
  'store/kanban-comment-lib.sh': [45], // comment naming the anti-pattern, not an invocation
  'store/mopsion-suite-run.sh': [255], // comment naming the anti-pattern, not an invocation (line shifted again by card c0408a1c's M1/M2/D1/D2 fix)
  'store/sync-agent-templates.sh': [112, 131, 140, 215, 406, 416, 444, 465, 480, 488, 519], // the rewriter's own docstring + test fixtures
  'store/szotasz-marveen-daily-check.sh': [24], // comment naming the anti-pattern, not an invocation
}

describe('token-argv doc sweep (card 0dab76a3)', () => {
  it('no NEW tracked .md/.sh file invokes curl with Bearer-in-argv, in any spelling', () => {
    const out = execFileSync(
      'git',
      ['grep', '-nE', '-e', AUTH_ARGV_PATTERN, '--', '*.md', '*.sh', ':!seed-fleet-agents/*'],
      { cwd: ROOT, encoding: 'utf-8' },
    )
    const unexpected: string[] = []
    for (const line of out.trim().split('\n')) {
      if (!line) continue
      const m = line.match(/^([^:]+):(\d+):/)
      if (!m) {
        unexpected.push(line)
        continue
      }
      const [, file, lineNoStr] = m
      const lineNo = Number(lineNoStr)
      if (!(ALLOWLIST[file!] ?? []).includes(lineNo)) {
        unexpected.push(line)
      }
    }
    expect(unexpected, 'new argv-token curl invocation(s) found -- fix to printf | curl -H @-, or add to ALLOWLIST if genuinely safe (comment/history/fixture)').toEqual([])
  })

  // Negative control (card 165350f1 self-check -- the previous round's regex silently missed a
  // real, live occurrence and nothing caught that it had gone blind): the pattern must actually
  // catch the exact shape docs/scheduled-tasks.md carried before this fix, on a synthetic sample,
  // so a future narrowing of AUTH_ARGV_PATTERN cannot silently stop matching the variable form again.
  it('the pattern itself still catches the $TOKEN-variable form, and still ignores the sanctioned form', () => {
    const tmp = execFileSync('mktemp', ['-d'], { encoding: 'utf-8' }).trim()
    try {
      writeFileSync(
        join(tmp, 'offender.sh'),
        'TOKEN=$(cat store/.dashboard-token)\ncurl -s -H "Authorization: Bearer $TOKEN" http://x\n',
      )
      writeFileSync(
        join(tmp, 'safe.sh'),
        'printf \'Authorization: Bearer %s\\n\' "$(cat store/.dashboard-token)" | curl -s -H @- http://x\n',
      )
      const offenderOut = execFileSync('grep', ['-nE', '-e', AUTH_ARGV_PATTERN, join(tmp, 'offender.sh')], {
        encoding: 'utf-8',
      })
      expect(offenderOut).toContain('Authorization: Bearer $TOKEN')
      expect(() =>
        execFileSync('grep', ['-nE', '-e', AUTH_ARGV_PATTERN, join(tmp, 'safe.sh')], { encoding: 'utf-8' }),
      ).toThrow() // grep exits 1 (no match) -- execFileSync throws, which is the expected "clean" result
    } finally {
      execFileSync('rm', ['-rf', tmp])
    }
  })
})
