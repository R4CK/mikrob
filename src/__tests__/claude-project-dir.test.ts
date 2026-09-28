import { describe, it, expect } from 'vitest'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'

// Card d79a69b5 (upstream 26ac8c83, UTKODOLODIVERG922): every character outside
// [a-zA-Z0-9-] becomes ONE '-', including the leading '/'. Examples measured on
// real Claude Code 2.1.278 output (2026-09-22), reused verbatim as the regression
// pin -- the whole point of this encoder is that nobody re-derives the rule.
describe('encodeClaudeProjectDir', () => {
  it('replaces every non-alphanumeric-or-dash character with one dash, including the leading slash', () => {
    expect(encodeClaudeProjectDir('/home/u/work')).toBe('-home-u-work')
  })

  it('matches the measured Claude Code 2.1.278 encoding for a path with spaces, punctuation and symbols', () => {
    expect(encodeClaudeProjectDir('/scratchpad/enc_probe dir+plus@at.v2~x'))
      .toBe('-scratchpad-enc-probe-dir-plus-at-v2-x')
  })

  it('matches the measured encoding for a path with underscores, spaces and accented letters (one dash per code point, no run-collapsing)', () => {
    expect(encodeClaudeProjectDir('/scratchpad/enc__two  sp.éÁ-Z9'))
      .toBe('-scratchpad-enc--two--sp----Z9')
  })

  it('leaves existing dashes and alphanumerics untouched', () => {
    expect(encodeClaudeProjectDir('/home/u/agent-worktree-42')).toBe('-home-u-agent-worktree-42')
  })
})
