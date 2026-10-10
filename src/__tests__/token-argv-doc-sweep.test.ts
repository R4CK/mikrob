import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// QA FAIL on card 0dab76a3 (comment 14540): the doc sweep for the
// `-H "Authorization: Bearer $(cat ...)"` argv-token anti-pattern (readable
// from /proc/<pid>/cmdline by any local process, CLAUDE.md's own standing
// rule) missed 2 tracked, actually-invoked files
// (scheduled-tasks/dream-engine/SKILL.md, scheduled-tasks/memoria-heartbeat/
// SKILL.md) because the sweep was run once by hand and not re-checked
// structurally. This test is that structural guard: every tracked .md/.sh
// hit is either the known-safe set below (DECISIONS.md history, a comment
// NAMING the anti-pattern to explain why it is forbidden, or
// store/sync-agent-templates.sh's own fixtures/docstring for the rewriter
// that fixes this exact shape in the gitignored agents/ copies) or a NEW,
// unreviewed occurrence that must fail this test until triaged.
const ROOT = join(__dirname, '..', '..')

// path -> allowed line numbers (git grep -n output, 1-indexed)
const ALLOWLIST: Record<string, number[]> = {
  'DECISIONS.md': [1164, 4931, 15034, 15076], // historical decision entries about this exact fix
  'scripts/supabase-q.sh': [50], // comment naming the anti-pattern, not an invocation
  'store/kanban-comment-lib.sh': [45], // comment naming the anti-pattern, not an invocation
  'store/mopsion-suite-run.sh': [202], // comment naming the anti-pattern, not an invocation
  'store/sync-agent-templates.sh': [112, 406, 416, 480, 488, 519, 536], // the rewriter's own docstring + test fixtures
}

describe('token-argv doc sweep (card 0dab76a3)', () => {
  it('no NEW tracked .md/.sh file invokes curl with the token in argv', () => {
    const out = execFileSync('git', ['grep', '-n', 'Authorization: Bearer \\$(cat', '--', '*.md', '*.sh'], {
      cwd: ROOT,
      encoding: 'utf-8',
    })
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
})
