#!/usr/bin/env python3
"""Selftest for activity_memory_capture.py -- verifies redaction and noise filter.

The module under test is the UNDERSCORE one, which is the file agents/*/.claude/settings.json
wires into the PostToolUse hook. A hyphen-named near-twin used to sit beside it; card 0c5423fc's
redaction fix landed in that twin, so it never reached the running code. The twin was deleted in
card 5472cfa9, and src/__tests__/activity-hook-redaction.test.ts now runs this file on every
suite run -- before that, nothing did.

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


CHECKS = 0


def check(label: str, result: str, must_not_contain: list[str], must_contain: list[str] | None = None) -> None:
    global CHECKS
    CHECKS += 1
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

# DB connection-string passwords (card 0c5423fc, ACTUALLY REACHED as of card 5472cfa9).
# This fixture exists because the pattern above it shipped once with no test: it landed in the
# sibling copy nothing executes, and for that whole time `amc` here -- the module the live hook
# runs -- returned the password unchanged. A test that imports the WIRED module is what turns
# "the fix was written" into "the fix runs".
for scheme in ('postgres', 'postgresql', 'mysql', 'mongodb+srv', 'redis'):
    r = amc._redact(f'psql {scheme}://admin:SuperSecret123@db.internal:5432/cleancore')
    check(f'db-uri-{scheme}', r, ['SuperSecret123'], ['[REDACTED]', 'admin'])

# ...and the URI must still be recognisable afterwards: redaction that eats the host too would
# make the log useless without making it safer.
r = amc._redact('DATABASE_URL=postgres://svc:hunter2hunter2@pg.prod.internal:6432/app')
check('db-uri-keeps-context', r, ['hunter2hunter2'], ['pg.prod.internal'])

# A URI with NO password must pass through untouched -- no false positive on an ordinary URL.
r = amc._redact('curl https://cleancore.example.com/api/health')
check('url-without-credential', r, ['[REDACTED]'], ['cleancore.example.com'])

# Card d47455bf (Cybersec finding 5472cfa9 GO, follow-up): a 40+ char run of the same character
# class glued directly onto the URI scheme keyword, with NO separator, used to be swallowed whole
# by the hex/base64 blob patterns BEFORE the DB-URI pattern got a chance to run -- deleting the
# literal "postgres"/"mysql"/... keyword the anchored pattern matches on, so it never fired and the
# password after it survived untouched. Fixed by moving the DB-URI pattern ahead of the blob
# patterns in _SECRET_PATTERNS. All 5 supported schemes must still redact the password here.
for scheme in ('postgres', 'postgresql', 'mysql', 'mongodb+srv', 'redis'):
    glued = 'x' * 40 + f'{scheme}://admin:SuperSecret123@db.internal:5432/cleancore'
    r = amc._redact(glued)
    check(f'db-uri-{scheme}-glued-blob-does-not-swallow-scheme', r, ['SuperSecret123'], ['[REDACTED]', 'admin'])

# Card 2102fe6a (Cybersec, follow-up to d47455bf, SAME file/control, WORSE outcome): the token-prefix
# patterns anchored on a leading `\b`, which fails when the prefix is glued (no separator) to a
# preceding 40+ char alnum run -- the identical shape d47455bf fixed for DB-URI passwords, but here
# the blob patterns only rescue the prefix's first few letters (stopping at the `_`/`-` separator,
# which is outside the base64/hex charset), leaving the ENTIRE secret body plaintext. Fixed by
# dropping the leading `\b` (this pattern is already first in the list, so no reordering needed,
# unlike the DB-URI fix -- the `\b` itself was the broken condition). All 9 supported prefixes.
for prefix in ('ghp_', 'ghc_', 'gho_', 'ghu_', 'ghs_', 'sk-', 'sk-ant-', 'xoxb-', 'xoxp-'):
    secret_body = 'S3cr3tSuffixValue1234567890'
    glued = 'q' * 40 + prefix + secret_body + ' end'
    r = amc._redact(glued)
    check(f'token-prefix-{prefix}-glued-does-not-leak-secret-body', r, [secret_body], ['[REDACTED]'])

# Same fix, JWT pattern: a leading `\b` failed the same way when glued to a preceding run, and here
# NEITHER blob pattern rescues any part of it (JWT segments use base64URL `_`/`-`, not the blob
# patterns' `+`/`/`, and a real segment is essentially never all-hex) -- both leading- and
# trailing-glued shapes covered, since the trailing `\b` was dropped too.
jwt_header = 'eyJhbGciOiJIUzI1NiJ9'
jwt_payload = 'eyJzdWIiOiJ1c2VyIn0'
jwt_sig = 'SflKxwRJSMeKKF2QT4fwpMeJf'
jwt = f'{jwt_header}.{jwt_payload}.{jwt_sig}'
r = amc._redact('q' * 40 + jwt + ' end')
check('jwt-leading-glue-does-not-leak-any-segment', r, [jwt_header, jwt_payload, jwt_sig], ['[REDACTED]'])
r = amc._redact('start ' + jwt + 'q' * 40)
check('jwt-trailing-glue-does-not-leak-any-segment', r, [jwt_header, jwt_payload, jwt_sig], ['[REDACTED]'])

# Negative control: dropping the leading `\b` from the token-prefix and JWT patterns must NOT
# introduce new false positives on ordinary prose. "ey" (the JWT pattern's own opener) is a common
# English substring ("they", "obey", "monkey"); "sk-" and "gh" fragments are similarly short. None
# of these sentences contain a REAL secret shape (no long adjacent alnum run, no two literal dots
# each followed by 10+ alnum chars), so none should be touched.
for sentence in (
    'they obeyed the monkey and went home',
    'the gh-pages branch needs a rebuild',
    'sk-8 was the old skate deck model number',
    'review the ghost-town level design doc',
):
    r = amc._redact(sentence)
    check(f'prose-not-falsely-redacted: {sentence!r}', r, ['[REDACTED]'], [sentence])

# Clean text: no redaction of ordinary content
r = amc._redact('git commit -m "feat(api): add endpoint"')
check('clean-git-commit', r, ['[REDACTED]'], ['git commit'])

# Clean hex (short sha): should NOT be redacted (< 40 chars)
short_sha = 'a3f1c9e'
r = amc._redact(f'commit {short_sha}')
check('short-sha-not-redacted', r, [], [short_sha])

# ---------------------------------------------------------------------------
# Card 8a18fd61: _tool_input_carries_secret -- the wider check over the WHOLE tool_input,
# catching a secret in a field _build_summary does not inspect for that tool type.
# ---------------------------------------------------------------------------

# An Edit's new_string is not one of the fields _build_summary looks at (only file_path) --
# a secret placed there must still be caught by the wider check.
if not amc._tool_input_carries_secret({
    'file_path': '/tmp/x.env',
    'old_string': 'X=1',
    'new_string': 'API_KEY=ghp_AAABBBCCCDDDEEEFFFGGGHHH',
}):
    FAILURES.append('FAIL [wider-check]: secret in an Edit new_string was not caught')

# A Write's content is likewise not inspected by _build_summary.
if not amc._tool_input_carries_secret({
    'file_path': '/tmp/x.env',
    'content': 'password=super_secret_value_here',
}):
    FAILURES.append('FAIL [wider-check]: secret in a Write content was not caught')

# Clean tool_input must not false-positive.
if amc._tool_input_carries_secret({'file_path': '/tmp/x.env', 'content': 'hello world'}):
    FAILURES.append('FAIL [wider-check]: clean tool_input flagged as carrying a secret')

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

# Card 5a056db8: a heredoc-fed quiet commit must summarize the REAL message, not the constant
# flags/opening-marker text -- two different messages through this shape must not collide.
HEREDOC_A = "git commit -q -F - <<'HEREDOC'\nfix(agent): quota resync at 08:12\nHEREDOC"
HEREDOC_B = "git commit -q -F - <<'HEREDOC'\nfix(agent): another totally different message\nHEREDOC"
s_a = amc._build_summary('Bash', {'command': HEREDOC_A}, {})
s_b = amc._build_summary('Bash', {'command': HEREDOC_B}, {})
if s_a == s_b:
    FAILURES.append(f'FAIL [summary]: two distinct heredoc commits produced the same summary: {s_a!r}')
if 'quota resync' not in s_a:
    FAILURES.append(f'FAIL [summary]: heredoc commit message not captured: {s_a!r}')
if '\n' in s_a or '\n' in s_b:
    FAILURES.append(f'FAIL [summary]: newline survived into a heredoc-commit summary: {s_a!r} / {s_b!r}')

# The `-m "$(cat <<'TAG' ... TAG)"` command-substitution form is the SAME shape backend's own
# commits use in this session -- must also resolve to the real message, not the "-m \"$(cat" flags.
CMDSUB = (
    'git commit -m "$(cat <<\'EOF\'\n'
    'feat(legal): add CLEANCORE_CONTACT_EMAIL as the 10th platform company field\n'
    'EOF\n)"'
)
s_cmdsub = amc._build_summary('Bash', {'command': CMDSUB}, {})
if 'CLEANCORE_CONTACT_EMAIL' not in s_cmdsub:
    FAILURES.append(f'FAIL [summary]: command-substitution heredoc message not captured: {s_cmdsub!r}')

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
# Card 3bcc1242 part 2: dedup-before-write on the memory-index path (NOT the log above, which
# stays a raw, non-deduplicated trace by design).
# ---------------------------------------------------------------------------

try:
    with tempfile.TemporaryDirectory() as _tmp:
        amc._project_root = lambda: _tmp  # type: ignore[assignment]

        # A brand-new summary is never a duplicate.
        if amc._is_recent_duplicate('backend', 'Bash: git commit foo', 1_000_000):
            FAILURES.append('FAIL [memdedup]: a never-seen summary was reported as a duplicate')

        # Record it, then the SAME summary shortly after IS a duplicate...
        amc._record_memdedup('backend', 'Bash: git commit foo', 1_000_000)
        if not amc._is_recent_duplicate('backend', 'Bash: git commit foo', 1_000_100):
            FAILURES.append('FAIL [memdedup]: an identical summary inside the window was not caught')

        # ...but a DIFFERENT summary is not affected by it.
        if amc._is_recent_duplicate('backend', 'Bash: git commit bar', 1_000_100):
            FAILURES.append('FAIL [memdedup]: a different summary was wrongly flagged as a duplicate')

        # ...and a DIFFERENT agent's dedup state is independent (separate file per agent_id).
        if amc._is_recent_duplicate('cybersec', 'Bash: git commit foo', 1_000_100):
            FAILURES.append('FAIL [memdedup]: dedup state leaked across agents')

        # Past the window, the same summary is fresh again -- a genuinely later recurrence of the
        # same action must still earn its own row, not be silently eaten forever.
        far_future = 1_000_000 + amc._MEMDEDUP_WINDOW_SECONDS + 1
        if amc._is_recent_duplicate('backend', 'Bash: git commit foo', far_future):
            FAILURES.append('FAIL [memdedup]: a summary outside the window was still reported as a duplicate')
finally:
    amc._project_root = _real_root  # type: ignore[assignment]

# Fail OPEN: an unreadable dedup-state file (as opposed to merely-absent, the case above) must
# never be treated as "everything is a duplicate" -- that would silently drop genuine entries.
try:
    with tempfile.TemporaryDirectory() as _tmp:
        amc._project_root = lambda: _tmp  # type: ignore[assignment]
        _bad_path = amc._memdedup_path('backend')
        os.makedirs(os.path.dirname(_bad_path), exist_ok=True)
        with open(_bad_path, 'w') as f:
            f.write('{not valid json')
        if amc._is_recent_duplicate('backend', 'anything', 2_000_000):
            FAILURES.append('FAIL [memdedup]: a corrupt state file was treated as fail-CLOSED (dropped a genuine entry)')
finally:
    amc._project_root = _real_root  # type: ignore[assignment]

# The state file must be capped, not grow without bound -- same reasoning as the activity log.
try:
    with tempfile.TemporaryDirectory() as _tmp:
        amc._project_root = lambda: _tmp  # type: ignore[assignment]
        for i in range(amc._MEMDEDUP_MAX_ENTRIES + 50):
            amc._record_memdedup('backend', f'summary-{i}', 3_000_000 + i)
        with open(amc._memdedup_path('backend')) as f:
            _stored = json.load(f)
        if len(_stored) > amc._MEMDEDUP_MAX_ENTRIES:
            FAILURES.append(f'FAIL [memdedup]: state file grew past the cap: {len(_stored)} entries')
        # The MOST RECENT entry must survive the prune (oldest-evicted, not newest).
        if f'summary-{amc._MEMDEDUP_MAX_ENTRIES + 49}' not in _stored:
            FAILURES.append('FAIL [memdedup]: the prune evicted the newest entry instead of the oldest')
finally:
    amc._project_root = _real_root  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

if FAILURES:
    for f in FAILURES:
        print(f, file=sys.stderr)
    sys.exit(1)

# COUNTED, not asserted from memory (card 5472cfa9). This line used to read `30 - len(FAILURES)`,
# a literal: it printed "30 checks passed" whatever the file actually contained, so adding or
# deleting checks never changed the number. A self-test that misreports its own coverage is the
# wrong thing to trust while auditing a redaction path.
print(f'OK: all {CHECKS} redaction/filter checks + the inline assertions passed (0 failures)')
sys.exit(0)
