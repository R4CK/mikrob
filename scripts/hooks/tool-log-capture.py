#!/usr/bin/env python3
"""PostToolUse + PostToolUseFailure hook: log every tool call to /api/tool-log
for the activity dashboard.

TWO EVENTS, ONE SCRIPT (TOOLLOGVAKSIKER921, measured 2026-09-21 on Claude Code
2.1.278): a tool call that FAILS does not fire PostToolUse at all. It fires
PostToolUseFailure, whose payload carries an `error` string and `is_interrupt`
and has NO `tool_response`. A hook registered under PostToolUse alone therefore
never sees a failure -- it is not that failures were logged as success=1, they
were not logged at all (2948/2948 rows success=1 in the whole history, while
two exit-1 calls from the same session had no row). The `success` column is
derived from `hook_event_name` first: PostToolUseFailure -> 0. The older
`tool_response.is_error` check is kept as a second signal for tool families
that report an error inside a successful PostToolUse payload; a plain Bash
success payload has only stdout/stderr/interrupted/isImage/noOutputExpected.

REGISTRATION IS PER-AGENT, WITH ONE EXCEPTION THAT IS NOT A LEAK TO FIX BY
MOVING FILES. This hook is shipped in templates/settings.json.template, which
ensureAgentHooks merges into the file agentSettingsPath(name) returns. For a
sub-agent that is the agent's OWN settings.json
(agents/<name>/.claude/settings.json). For MAIN_AGENT_ID that function returns
~/.claude/settings.json (agent-scaffold.ts), and web.ts starts the scaffold
loop with the main agent -- so on the owner's machine this entry DOES sit in
the global settings file, and every Claude Code session started there loads it,
including the owner's own sessions. That is the current, measured behaviour:
skill-usage-capture.py already rides the same PostToolUse path in that same
file. Do not read the per-agent placement as a filter on who gets logged.

What the per-agent placement does buy is scope on OTHER machines and for
sub-agents: a session that never loads a given agent's settings.json never
reaches this hook under that agent's name. If the owner's own sessions must be
kept out of tool_call_log, the filter belongs IN this hook (identity is already
resolved below, so the check is cheap) and needs a test -- moving the entry
between settings files will not do it, because the main agent's settings file
IS the global one.

Identity comes from ledger_lib.agent_id_from_payload (LEDGERCWD828 / #1100):
the session transcript path first, then MARVEEN_AGENT_ID, then cwd. The
transcript path is fixed when the session starts, so an agent that later cds
into another repo (devy working in molyo) still logs under its own name --
measured 2026-08-29, both branches.
"""
import sys
import os
import json
import re
import random
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port() -> str:
    # Config-driven: WEB_PORT env, else .env file, default 3420.
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_project_root(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except OSError:
        return ''


# Label words a secret value is commonly introduced by, shared across the quoted/unquoted/
# spaced-flag patterns below. Also matches a generic `*_KEY`/`*_SECRET`/`*_TOKEN`/`*_PASSWORD`
# env-var-style name (e.g. MY_SECRET_KEY), which the old label-only match missed because
# "secret" there is not a standalone word, it's a suffix segment (TOOLLOGREDACT924 lesson).
_LABEL = r'(?:token|secret|password|api[_\-]?key|apikey|auth|credential|[A-Za-z0-9]+_(?:key|secret|token|password))'

# Patterns that could reveal secrets if stored verbatim. Each pattern names a `val` group: the
# span that gets replaced with [REDACTED]. Everything else in the match is kept verbatim.
_SECRET_PATTERNS = [
    # Bearer / Basic authorization header values.
    re.compile(r'(?i)(?:bearer|basic)\s+(?P<val>[A-Za-z0-9+/=_\-\.]{8,})'),
    # label=value / label: value, value optionally single- or double-quoted. Quoted first so an
    # unquoted scan of the same text never partially matches inside the quotes first.
    re.compile(rf'(?i){_LABEL}\s*[=:]\s*(?P<q>["\'])(?P<val>(?:(?!(?P=q)).){{3,}})(?P=q)'),
    re.compile(rf'(?i){_LABEL}\s*[=:]\s*(?P<val>[^\s,\'";&|]{{6,}})'),
    # A CLI flag that takes its value SPACE-separated, no `=`/`:` (`--password x`, `-p x`).
    # Scoped to a `-`/`--` flag spelling (not bare prose) to avoid flagging ordinary English
    # sentences that happen to contain one of these words followed by a long word. Quoted and
    # unquoted are true ALTERNATIVES (not one pattern with an optional quote group): a
    # back-reference to an UNSET group (the quote, when absent) matches the empty string, which
    # makes `(?!(?P=q))` an always-failing lookahead and silently drops the whole branch --
    # caught by this file's own selftest (the unquoted spaced-flag case went from red to still
    # red on the first attempt at this pattern).
    re.compile(rf'(?i)--?{_LABEL}\s+'
               rf'(?:(?P<q>["\'])(?P<val1>(?:(?!(?P=q)).){{3,}})(?P=q)|(?P<val2>[^\s,\'";&|]{{6,}}))'),
    # GitHub/Anthropic/OpenAI style tokens.
    re.compile(r'(?P<val>\b(?:ghp_|sk-|sk-ant-|xoxb-|xoxp-)[A-Za-z0-9_\-]{10,})'),
    # A bare JWT: three dot-separated base64url segments, no label required.
    re.compile(r'(?P<val>\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\b)'),
    # URL-embedded credentials: scheme://user:PASSWORD@host -- only the password is redacted,
    # the username and `@` stay so the shape of the command remains legible. Any RFC 3986 scheme
    # (postgres://, redis://, amqp://, mongodb+srv://, not just http(s)); the user may be EMPTY
    # (redis://:pass@host is the normal redis form, so `+` would have required a char that is
    # not there); and the password is matched LAZILY up to the LAST unencoded `@` before the
    # host (a lookahead requires no further `@` before the next `/`/whitespace/end), so a
    # password that itself contains `@` is not cut short at the first one.
    re.compile(r'[A-Za-z][A-Za-z0-9+.\-]*://[^\s/:@]*:(?P<val>[^\s/]+?)@(?=[^@\s/]*(?:/|\s|$))'),
    # Raw hex blobs >= 32 chars (likely hashed secrets).
    re.compile(r'(?P<val>\b[0-9a-fA-F]{32,}\b)'),
]


def _redact(text: str) -> str:
    """Replace potential secret values with [REDACTED]. Only the sensitive group of each match
    is replaced; everything else (label, separator, quotes, URL scheme/user/@) is kept verbatim.
    The CLI-flag pattern has TWO candidate groups (val1 quoted, val2 unquoted) because they are
    true alternatives, not one optional-quote pattern (see that pattern's own comment) -- redact
    picks whichever one actually matched."""
    for pat in _SECRET_PATTERNS:
        out = []
        pos = 0
        for m in pat.finditer(text):
            gd = m.groupdict()
            name = 'val' if 'val' in gd else next(k for k in ('val1', 'val2') if gd.get(k) is not None)
            s, e = m.span(name)
            out.append(text[pos:s])
            out.append('[REDACTED]')
            pos = e
        out.append(text[pos:])
        text = ''.join(out)
    return text


def _input_summary(tool_input: dict, tool_name: str) -> str:
    """Build a short human-readable summary of the tool input, secrets redacted."""
    if not tool_input:
        return ''
    if tool_name in ('Bash', 'bash'):
        return _redact(str(tool_input.get('command', ''))[:400])[:200]
    if tool_name in ('Read', 'Write', 'Edit'):
        return str(tool_input.get('file_path', ''))[:200]
    if tool_name in ('WebFetch', 'WebSearch'):
        return _redact(str(tool_input.get('url', tool_input.get('query', '')))[:400])[:200]
    # Generic fallback: first string value found
    for v in tool_input.values():
        if isinstance(v, str):
            return _redact(v[:400])[:200]
    return ''


def _success_from_payload(payload: dict) -> bool:
    """False for a PostToolUseFailure event, or for a PostToolUse payload whose
    tool_response carries is_error; True otherwise. The event name is the
    primary signal -- a failed Bash call never reaches PostToolUse."""
    if payload.get('hook_event_name') == 'PostToolUseFailure':
        return False
    tr = payload.get('tool_response')
    if isinstance(tr, dict) and tr.get('is_error'):
        return False
    return True


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    session_id = payload.get('session_id') or ''
    tool_name = payload.get('tool_name') or ''
    tool_input = payload.get('tool_input') or {}
    cwd = payload.get('cwd') or ''
    # CC provides tool_use_id (stable per-call ID shared with PreToolUse) and
    # duration_ms (native wall-clock measurement, more accurate than hook-side
    # timestamps because it excludes hook overhead).
    tool_use_id = payload.get('tool_use_id') or None
    duration_ms = payload.get('duration_ms')
    if not isinstance(duration_ms, int):
        duration_ms = None
    success = _success_from_payload(payload)

    if not session_id or not tool_name:
        sys.exit(0)

    token = _dashboard_token()
    if not token:
        sys.exit(0)

    port = _web_port()
    base_url = f'http://localhost:{port}/api'

    body = json.dumps({
        'session_id': session_id,
        'tool_name': tool_name,
        'input_summary': _input_summary(tool_input, tool_name),
        'success': success,
        'agent_id': ledger_lib.agent_id_from_payload(payload),
        # trace_id holds the CC-native tool_use_id: stable, unique per call,
        # present in both Pre and PostToolUse payloads (empirically verified).
        # No PreToolUse hook needed -- CC already gives us the correlation key
        # and the latency measurement in one place.
        'trace_id': tool_use_id,
        'duration_ms': duration_ms,
    }).encode()

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {token}',
    }

    try:
        urllib.request.urlopen(
            urllib.request.Request(f'{base_url}/tool-log', data=body, headers=headers, method='POST'),
            timeout=3,
        )
    except Exception:
        pass  # never block the agent

    # Prune old entries with ~1% probability to keep the table from growing indefinitely.
    if random.random() < 0.01:
        try:
            urllib.request.urlopen(
                urllib.request.Request(
                    f'{base_url}/tool-log/prune',
                    data=b'{}',
                    headers=headers,
                    method='POST',
                ),
                timeout=3,
            )
        except Exception:
            pass

    sys.exit(0)


if __name__ == '__main__':
    main()
