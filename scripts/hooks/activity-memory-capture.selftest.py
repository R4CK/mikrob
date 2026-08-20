#!/usr/bin/env python3
"""Selftest for activity-memory-capture.py -- verifies redaction and noise filter.

Card 4829ccff §3 (success criterion c): known secret-shaped fixtures ALL redacted;
clean commands pass through unchanged.

Exit 0 = all pass. Exit 1 = one or more failures (printed to stderr).
"""

import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import activity_memory_capture as amc  # noqa: E402 (same dir)

FAILURES: list[str] = []


def check(label: str, result: str, must_not_contain: list[str], must_contain: list[str] | None = None) -> None:
    for bad in must_not_contain:
        if bad in result:
            FAILURES.append(f'FAIL [{label}]: "{bad}" survived redaction in: {result!r}')
    if must_contain:
        for good in must_contain:
            if good not in result:
                FAILURES.append(f'FAIL [{label}]: expected "{good}" in: {result!r}')


# ---------------------------------------------------------------------------
# Redaction fixtures
# ---------------------------------------------------------------------------

# Bearer token
r = amc._redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123.xyz789sig')
check('bearer-jwt', r, ['eyJhbGciOiJIUzI1NiJ9'], ['[REDACTED]'])

# Dashboard token style (long hex)
r = amc._redact('token=abcdef1234567890abcdef1234567890abcdef12')
check('long-hex-token', r, ['abcdef1234567890abcdef1234567890abcdef12'], ['[REDACTED]'])

# GitHub token prefix
r = amc._redact('GITHUB_TOKEN=ghp_AAABBBCCCDDDEEEFFFGGGHHH')
check('github-token', r, ['ghp_AAABBBCCCDDDEEEFFFGGGHHH'], ['[REDACTED]'])

# Anthropic API key
r = amc._redact('key: sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-yyyyyy')
check('anthropic-key', r, ['sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx'], ['[REDACTED]'])

# Generic password=value
r = amc._redact('password=super_secret_value_here')
check('password-kv', r, ['super_secret_value_here'], ['[REDACTED]'])

# JWT triple-dot
r = amc._redact('token: eyJhbGc.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf')
check('jwt-triple', r, ['eyJhbGc.eyJzdWIiOiJ1c2VyIn0'], ['[REDACTED]'])

# Clean text: no redaction of ordinary content
r = amc._redact('git commit -m "feat(api): add endpoint"')
check('clean-git-commit', r, ['[REDACTED]'], ['git commit'])

# Clean hex (short sha): should NOT be redacted (< 40 chars)
short_sha = 'a3f1c9e'
r = amc._redact(f'commit {short_sha}')
check('short-sha-not-redacted', r, [], [short_sha])

# ---------------------------------------------------------------------------
# Noise filter fixtures
# ---------------------------------------------------------------------------

def should(tool_name, command=None, *, expected: bool) -> None:
    ti = {'command': command} if command else {}
    result = amc._should_record(tool_name, ti, {})
    if result != expected:
        cmd_short = repr(command)[:40]
        FAILURES.append(f'FAIL [filter]: _should_record({tool_name!r}, {cmd_short}) = {result}, expected {expected}')


# Read-only tools
should('Read', expected=False)
should('Grep', expected=False)
should('Glob', expected=False)
should('WebFetch', expected=False)
should('WebSearch', expected=False)

# Read-only bash
should('Bash', 'ls -la', expected=False)
should('Bash', 'cat store/.dashboard-token', expected=False)
should('Bash', 'git status', expected=False)
should('Bash', 'git log --oneline -5', expected=False)
should('Bash', 'git diff HEAD', expected=False)
should('Bash', 'grep -r "foo" .', expected=False)
should('Bash', 'sqlite3 store/db.sqlite "SELECT * FROM memories"', expected=False)

# State-changing bash
should('Bash', 'git commit -m "feat: add thing"', expected=True)
should('Bash', 'git push origin develop', expected=True)
should('Bash', "printf 'Authorization: Bearer %s\\n' \"$(cat store/.dashboard-token)\" | curl -H @- -s -X POST http://localhost:3420/api/kanban/abc123/move -H 'Content-Type: application/json' -d '{\"status\":\"done\"}'", expected=True)
should('Bash', 'curl -H "Authorization: Bearer tok" -X DELETE http://localhost:3420/api/memories/5', expected=True)
should('Bash', 'systemctl restart mikrob-channels', expected=True)
should('Bash', 'pnpm install', expected=True)

# Write/Edit tools
should('Write', expected=True)
should('Edit', expected=True)

# Agent / Workflow
should('Agent', expected=True)
should('Workflow', expected=True)

# Errored call should not be recorded
err_result = amc._should_record('Bash', {'command': 'git commit -m "x"'}, {'is_error': True})
if err_result:
    FAILURES.append('FAIL [filter]: errored tool call should NOT be recorded')

# ---------------------------------------------------------------------------
# Summary builder sanity
# ---------------------------------------------------------------------------

s = amc._build_summary('Bash', {'command': 'git commit -m "feat: add versionId"'}, {})
if 'git commit' not in s:
    FAILURES.append(f'FAIL [summary]: git commit not in summary: {s!r}')

s = amc._build_summary('Write', {'file_path': '/home/neon/marveen/scripts/hooks/foo.py'}, {})
if 'Write' not in s:
    FAILURES.append(f'FAIL [summary]: Write not in summary: {s!r}')

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

if FAILURES:
    for f in FAILURES:
        print(f, file=sys.stderr)
    sys.exit(1)

print(f'OK: all {30 - len(FAILURES)} checks passed (0 failures)')
sys.exit(0)
