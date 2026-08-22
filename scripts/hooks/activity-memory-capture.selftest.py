#!/usr/bin/env python3
"""Selftest for activity-memory-capture.py -- verifies redaction and noise filter.

Card 4829ccff §3 (success criterion c): known secret-shaped fixtures ALL redacted;
clean commands pass through unchanged.

Exit 0 = all pass. Exit 1 = one or more failures (printed to stderr).
"""

import sys
import os
import re
import json

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

# Card 34f1ca0c: the filter answers THREE ways now, not two -- 'memory', 'log' or None. Every
# case below was here before and is still asserted; what changed is that the routine ones now
# name 'log' instead of a bare True, so this file states WHERE each call goes rather than only
# whether it was kept. A case silently dropping to None would be a coverage loss, so None is
# spelled out too.
def should(tool_name, command=None, *, expected) -> None:
    ti = {'command': command} if command else {}
    result = amc._destination(tool_name, ti, {})
    if result != expected:
        cmd_short = repr(command)[:40]
        FAILURES.append(f'FAIL [filter]: _destination({tool_name!r}, {cmd_short}) = {result!r}, expected {expected!r}')


# Read-only tools -- dropped entirely, not even logged
should('Read', expected=None)
should('Grep', expected=None)
should('Glob', expected=None)
should('WebFetch', expected=None)
should('WebSearch', expected=None)

# Read-only bash -- likewise dropped
should('Bash', 'ls -la', expected=None)
should('Bash', 'cat store/.dashboard-token', expected=None)
should('Bash', 'git status', expected=None)
should('Bash', 'git log --oneline -5', expected=None)
should('Bash', 'git diff HEAD', expected=None)
should('Bash', 'grep -r "foo" .', expected=None)
should('Bash', 'sqlite3 store/db.sqlite "SELECT * FROM memories"', expected=None)

# MEMORABLE bash -- a later session asks about these by name, so they earn a memory row
should('Bash', 'git commit -m "feat: add thing"', expected='memory')
should('Bash', 'git push origin develop', expected='memory')
should('Bash', 'systemctl restart mikrob-channels', expected='memory')
should('Bash', 'pnpm install', expected='memory')

# ROUTINE bash -- state-changing, still recorded, but to the local log rather than the memory
# index. THIS IS THE CARD'S CHANGE (34f1ca0c): both shapes below are this fleet's own API idiom,
# and the system each one talks to (kanban, memories) already holds the authoritative record.
# Measured before the change: 791 of 898 captured rows were exactly these two shapes.
should('Bash', "printf 'Authorization: Bearer %s\\n' \"$(cat store/.dashboard-token)\" | curl -H @- -s -X POST http://localhost:3420/api/kanban/abc123/move -H 'Content-Type: application/json' -d '{\"status\":\"done\"}'", expected='log')
should('Bash', 'curl -H "Authorization: Bearer tok" -X DELETE http://localhost:3420/api/memories/5', expected='log')

# Write/Edit -- the diff is the authoritative record of a file change, so a memory row adds
# nothing a later session could not read from git. Kept as a local trace.
should('Write', expected='log')
should('Edit', expected='log')

# Agent / Workflow -- low volume and genuinely worth recalling: who was asked to do what.
should('Agent', expected='memory')
should('Workflow', expected='memory')

# Errored call should not be recorded
err_result = amc._destination('Bash', {'command': 'git commit -m "x"'}, {'is_error': True})
if err_result is not None:
    FAILURES.append(f'FAIL [filter]: errored tool call should be dropped, got {err_result!r}')

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
# Card 34f1ca0c -- the noise this hook used to write into the hot tier
# ---------------------------------------------------------------------------

# THE EXACT SHAPE THAT FLOODED IT, taken verbatim from a captured row. It is state-changing, so
# it is still recorded -- but into the log, and never into the searchable memory index.
NOISE = (
    'export SP=/tmp/claude-1000/-home-neon-x/scratchpad; '
    'python3 -c "import json"; '
    'curl -s -H @$SP/hdr.txt -X POST "http://localhost:3420/api/kanban/34f1ca0c/move" '
    '-H \'Content-Type: application/json\' -d \'{"status":"in_progress"}\''
)
if amc._destination('Bash', {'command': NOISE}, {}) != 'log':
    FAILURES.append('FAIL [noise]: the flooding shape must go to the log, not the memory index')

# A scratchpad temp file is not a memory either.
if amc._destination('Write', {'file_path': '/tmp/claude-1000/x/scratchpad/msg.txt'}, {}) != 'log':
    FAILURES.append('FAIL [noise]: a scratchpad Write must go to the log, not the memory index')

# A multi-line command must never reach a summary with its newlines intact: a one-line row
# carrying embedded newlines is precisely the "raw dump" this card removed.
s = amc._build_summary('Bash', {'command': 'cd /some/dir\nsome-unrecognised-tool --flag\nmore'}, {})
if '\n' in s:
    FAILURES.append(f'FAIL [summary]: newline survived into a summary: {s!r}')

# The log appender must write a parseable JSONL line and must never raise.
import tempfile  # noqa: E402

_real_root = amc._project_root
try:
    with tempfile.TemporaryDirectory() as _tmp:
        amc._project_root = lambda: _tmp  # type: ignore[assignment]
        amc._append_activity_log('backend', 'Bash', 'git commit -m "x"')
        _log = os.path.join(_tmp, 'store', 'activity-log', 'backend.jsonl')
        if not os.path.exists(_log):
            FAILURES.append('FAIL [log]: the activity log file was not created')
        else:
            _line = json.loads(open(_log, encoding='utf-8').read().strip())
            if _line.get('summary') != 'git commit -m "x"' or _line.get('tool') != 'Bash':
                FAILURES.append(f'FAIL [log]: unexpected log line: {_line!r}')
finally:
    amc._project_root = _real_root  # type: ignore[assignment]

# An unwritable destination must be swallowed, never raised at the agent.
try:
    amc._project_root = lambda: '/proc/nonexistent-and-unwritable'  # type: ignore[assignment]
    amc._append_activity_log('backend', 'Bash', 'x')
except Exception as exc:  # pragma: no cover -- the point is that this branch is unreachable
    FAILURES.append(f'FAIL [log]: appender raised instead of failing quietly: {exc!r}')
finally:
    amc._project_root = _real_root  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

if FAILURES:
    for f in FAILURES:
        print(f, file=sys.stderr)
    sys.exit(1)

print(f'OK: all {30 - len(FAILURES)} checks passed (0 failures)')
sys.exit(0)
