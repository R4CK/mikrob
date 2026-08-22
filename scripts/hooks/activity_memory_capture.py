#!/usr/bin/env python3
"""PostToolUse hook: capture stateful/output tool calls as auto-generated activity memories.

Prototype for ONE agent (backend) -- card 4829ccff. NOT in the fleet-wide template.

Design rules (enforced here, not aspirationally):
  1. FILTER FIRST: only state-changing Bash calls pass; read/explore calls are dropped.
  2. REDACT BEFORE WRITE: secrets stripped from every field before any write; fail-closed
     (if redaction itself raises, the entry is skipped silently).
  3. NO LLM IN THE HOT PATH: all filtering and redaction is deterministic regex.
  4. auto_generated=1 + keywords "auto-activity" -- never overlaps with PreCompact warm/cold.
  5. Never blocks the agent (sys.exit(0) on any error).

Success criteria (card 4829ccff §5):
  (a) hook fires reliably on every tool call -- measurable via /api/tool-log (already logged there).
  (b) noise filter passes non-trivial but not 100% of calls.
  (c) redaction blocks ALL known secret shapes from the fixture set below.
"""

import os
import re
import sys
import json
import time
import urllib.request

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port() -> str:
    port = os.environ.get('WEB_PORT')
    if not port:
        try:
            with open(os.path.join(_project_root(), '.env')) as f:
                for line in f:
                    if line.startswith('WEB_PORT='):
                        port = line.split('=', 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or '3420'


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_project_root(), 'store', '.dashboard-token')) as f:
            return f.read().strip()
    except OSError:
        return ''


def _agent_id_from_cwd(cwd: str) -> str:
    """Derive agent_id from the working directory path."""
    if not cwd:
        return 'unknown'
    parts = cwd.rstrip('/').split('/')
    if 'agents' in parts:
        idx = parts.index('agents')
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return 'unknown'


# ---------------------------------------------------------------------------
# Secret redaction -- fail-closed means: if this raises, we skip the entry
# ---------------------------------------------------------------------------

_SECRET_PATTERNS = [
    # Authorization: Bearer <token>
    re.compile(r'(?i)(bearer\s+)[A-Za-z0-9+/=_\-\.]{8,}'),
    # key=value / key: value secret-shaped pairs
    re.compile(r'(?i)((?:token|secret|password|api[_\-]?key|apikey|auth|credential|private[_\-]?key)\s*[=:]\s*)[^\s,\'";&|]{6,}'),
    # GitHub / Anthropic / OpenAI / Slack style prefixed tokens
    re.compile(r'\b(ghp_|ghc_|gho_|ghu_|ghs_|sk-|sk-ant-|xoxb-|xoxp-)[A-Za-z0-9_\-]{10,}'),
    # JWT-shaped triple-dot strings (header.payload.signature)
    re.compile(r'\bey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b'),
    # Long hex blobs >= 40 chars (SHA-family hashes, raw tokens)
    re.compile(r'\b[0-9a-fA-F]{40,}\b'),
    # Long base64-only blobs >= 40 chars
    re.compile(r'(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])'),
    # DB connection string URI passwords: postgres://user:PASSWORD@host, mysql://, mongodb://, redis://
    # Capture group 1 = the URI prefix up to and including ':', group 2 = password (replaced).
    #
    # Card 5472cfa9: this pattern was WRITTEN by card 0c5423fc and landed in the sibling copy that
    # nothing executes, so the live hook -- which runs on EVERY tool call and writes to the memories
    # table -- did not redact connection-string passwords until now. The fixture in
    # activity-memory-capture.selftest.py is what makes that impossible to repeat: the original
    # change shipped with no test asserting the redaction it added, so nothing noticed it was
    # unreachable.
    re.compile(r'(?i)((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^:@\s]+:)([^@\s]{6,})(?=@)'),
]


def _redact(text: str) -> str:
    """Deterministic secret redaction. Raises on non-string input (fail-closed guard)."""
    if not isinstance(text, str):
        raise TypeError(f'expected str, got {type(text)}')
    for pat in _SECRET_PATTERNS:
        if pat.groups:
            text = pat.sub(
                lambda m: (m.group(1) if m.lastindex and m.lastindex >= 1 else '') + '[REDACTED]',
                text,
            )
        else:
            text = pat.sub('[REDACTED]', text)
    return text


# ---------------------------------------------------------------------------
# Noise filter -- deterministic, no LLM
# ---------------------------------------------------------------------------

# Bash commands that are ALWAYS read-only / exploration -- drop without inspecting further.
_READ_ONLY_COMMANDS = re.compile(
    r'^\s*(?:'
    r'ls\b|cat\b|head\b|tail\b|less\b|more\b|file\b'
    r'|grep\b|find\b|locate\b|which\b|whereis\b'
    r'|echo\b|printf\b(?!\s+.*curl)'   # echo/printf UNLESS piped to curl
    r'|git\s+(?:status|log|diff|show|branch|remote|fetch\b(?!\s+&&))'
    r'|sqlite3\b.*\bSELECT\b'
    r'|curl\b.*\s-(?:s|H|G|X GET)\b(?!.*-X\s*(?:POST|PUT|DELETE|PATCH))'  # curl GET
    r'|npm\s+(?:ls|list|outdated|audit)\b'
    r'|pnpm\s+(?:ls|list|outdated|audit)\b'
    r'|python3?\s+(?:-c\s+[\'"]?import|.*test)'
    r')',
    re.IGNORECASE | re.DOTALL,
)

# Bash commands worth a MEMORY row (card 34f1ca0c). Deliberately narrower than "state-changing":
# a memory is something a later session should RECALL, and the hot tier's job is the active task and
# pending decisions -- not a transcript. Everything else state-changing still gets recorded, but to
# the local activity log instead of the searchable memory index (see _append_activity_log).
#
# WHAT CAME OUT, AND WHY. The two removed branches were `curl -X POST ... localhost` and
# `printf ... curl ... localhost`. Those are this fleet's own API idiom -- every kanban comment,
# every memory save, every inter-agent message -- so they fired constantly, and each one produced a
# row saying a request was made to a system that ALREADY keeps the authoritative record (the kanban
# card, the memory row, the message queue). Measured 2026-08-22: 109 of the hot tier's 145 rows were
# this hook's output, and 463 auto-activity rows carried only 142 distinct summaries.
_MEMORABLE = re.compile(
    r'(?:'
    # git writes -- a commit/push/merge is a durable event a later session asks about by name
    r'\bgit\s+(?:commit|push|merge|rebase|tag|reset|checkout\b(?!\s*--))\b'
    # systemctl state changes -- service up/down is real infrastructure state
    r'|\bsystemctl\s+(?:start|stop|restart|reload|enable|disable)\b'
    # npm/pnpm install -- a dependency change outlives the session that made it
    r'|\b(?:npm|pnpm)\s+(?:install|ci|add|remove|uninstall)\b'
    r')',
    re.IGNORECASE | re.DOTALL,
)

# Tools other than Bash that are always read-only -- skip immediately.
_READ_ONLY_TOOLS = frozenset({
    'Read', 'Grep', 'Glob', 'LS', 'Explore',
    'WebFetch', 'WebSearch', 'ListAgents',
    'TaskGet', 'TaskList', 'TaskOutput',
})


def _destination(tool_name: str, tool_input: dict, tool_response: dict) -> str | None:
    """Where this tool call belongs: 'memory', 'log', or None (drop it).

    ONE decision point, on purpose (card 34f1ca0c). The previous shape answered a single
    yes/no question -- "record this?" -- and every yes went to the searchable memory index,
    which is how routine API chatter ended up occupying most of the hot tier. Splitting the
    answer keeps the record without paying the memory-index cost for it.
    """
    if tool_name in _READ_ONLY_TOOLS:
        return None
    # Skip if the tool errored -- partial / failed actions are not evidence
    if isinstance(tool_response, dict) and tool_response.get('is_error'):
        return None
    if tool_name in ('Bash', 'bash'):
        command = str(tool_input.get('command', ''))
        if _READ_ONLY_COMMANDS.search(command):
            return None
        if _MEMORABLE.search(command):
            return 'memory'
        # Unknown/routine bash: keep the trace, but out of the memory index. backend's calls do
        # NOT reach tool_call_log (measured 2026-08-22: that table holds mikrob's rows only), so
        # dropping outright would lose the record rather than relocate it.
        return 'log'
    # A file edit's authoritative record is the diff, not a memory row. Keep the trace locally.
    if tool_name in ('Write', 'Edit', 'NotebookEdit'):
        return 'log'
    # Delegation is low-volume and genuinely worth recalling -- who was asked to do what.
    if tool_name in ('Agent', 'Workflow'):
        return 'memory'
    return None


# ---------------------------------------------------------------------------
# Local activity log -- the non-searchable destination
# ---------------------------------------------------------------------------

# Bound: the log is a trace, not an archive. Past this the file is rotated to a single
# `.1` sibling (overwritten), so the pair can never exceed roughly twice this.
_ACTIVITY_LOG_MAX_BYTES = 5 * 1024 * 1024


def _append_activity_log(agent_id: str, tool_name: str, summary: str) -> None:
    """Append one REDACTED line to the agent's local activity log. Never raises.

    Deliberately a plain JSONL file rather than a table: it must not be searchable and must
    not be embedded -- those two costs are exactly what this card removed from the memory
    index -- while staying greppable when someone is reconstructing what happened.
    """
    try:
        directory = os.path.join(_project_root(), 'store', 'activity-log')
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, f'{agent_id}.jsonl')
        try:
            if os.path.getsize(path) > _ACTIVITY_LOG_MAX_BYTES:
                os.replace(path, path + '.1')
        except FileNotFoundError:
            pass
        line = json.dumps(
            {'at': int(time.time()), 'tool': tool_name, 'summary': summary},
            ensure_ascii=False,
        )
        with open(path, 'a', encoding='utf-8') as handle:
            handle.write(line + '\n')
    except Exception:
        pass  # a trace that cannot be written must never block the agent


# ---------------------------------------------------------------------------
# Summary builder
# ---------------------------------------------------------------------------

def _command_verb(command: str) -> str:
    """Extract the first meaningful verb/subcommand from a bash command."""
    command = command.strip()
    # git commit -> "git commit <sha-or-msg snippet>"
    m = re.search(r'\bgit\s+(commit|push|merge|rebase|tag|reset)\b(?:\s+(.{0,60}))?', command, re.IGNORECASE)
    if m:
        return f"git {m.group(1)}" + (f" {m.group(2).strip()[:40]}" if m.group(2) else '')
    # curl mutation
    m = re.search(r'curl\b.*-X\s*(POST|PUT|DELETE|PATCH)\s+([^\s\'"]+)', command, re.IGNORECASE)
    if m:
        return f"curl {m.group(1)} {m.group(2)[:60]}"
    # systemctl
    m = re.search(r'systemctl\s+(\w+)\s+(\S+)', command, re.IGNORECASE)
    if m:
        return f"systemctl {m.group(1)} {m.group(2)}"
    # npm/pnpm
    m = re.search(r'(?:npm|pnpm)\s+(install|ci|add|remove|uninstall)\b(?:\s+(\S+))?', command, re.IGNORECASE)
    if m:
        return f"{m.group(0)[:60]}"
    # Last resort: the command itself, WHITESPACE-COLLAPSED. A multi-line shell block cut at
    # byte 80 is what produced the unreadable dumps this card is about, and embedded newlines in
    # a one-line summary make it worse still, so the text is flattened before it is cut.
    return ' '.join(command.split())[:80]


def _build_summary(tool_name: str, tool_input: dict, tool_response: dict) -> str:
    """Build a short, redacted, human-readable summary."""
    if tool_name in ('Bash', 'bash'):
        command = str(tool_input.get('command', ''))
        verb = _command_verb(command)
        # For git commit: grab the SHA from the response if available
        response_text = ''
        if isinstance(tool_response, dict):
            content = tool_response.get('content', '')
            if isinstance(content, list):
                content = ' '.join(c.get('text', '') if isinstance(c, dict) else str(c) for c in content)
            response_text = str(content)[:300]
        # Extract git commit SHA from output if present
        sha_match = re.search(r'\b([0-9a-f]{7,40})\b', response_text)
        sha_note = f" -> {sha_match.group(1)[:12]}" if sha_match and 'git commit' in verb.lower() else ''
        return f"Bash: {verb}{sha_note}"
    if tool_name in ('Write', 'Edit', 'NotebookEdit'):
        path = tool_input.get('file_path', tool_input.get('path', '?'))
        return f"{tool_name}: {str(path)[:100]}"
    if tool_name == 'Agent':
        desc = str(tool_input.get('description', tool_input.get('prompt', '?')))[:80]
        return f"Agent spawned: {desc}"
    if tool_name == 'Workflow':
        desc = str(tool_input.get('description', tool_input.get('name', '?')))[:80]
        return f"Workflow: {desc}"
    return f"{tool_name}: (no summary)"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get('tool_name') or ''
    tool_input = payload.get('tool_input') or {}
    tool_response = payload.get('tool_response') or {}
    cwd = payload.get('cwd') or ''

    if not tool_name:
        sys.exit(0)

    destination = _destination(tool_name, tool_input, tool_response)
    if destination is None:
        sys.exit(0)

    agent_id = _agent_id_from_cwd(cwd)
    # Only record for backend agent in this prototype (card 4829ccff §5).
    if agent_id != 'backend':
        sys.exit(0)

    # Build and redact the summary -- fail-closed: any exception skips the entry.
    try:
        summary_raw = _build_summary(tool_name, tool_input, tool_response)
        summary = _redact(summary_raw)
        # Double-check: full tool_input text also scanned for secrets that slipped through
        input_text = _redact(json.dumps(tool_input, ensure_ascii=False)[:600])
        if len(summary) > 300:
            summary = summary[:297] + '...'
    except Exception:
        sys.exit(0)  # fail-closed: skip rather than write unredacted content

    # ROUTINE TRAFFIC STOPS HERE. The trace is kept, the memory index is not touched, and no
    # token is needed -- which also means the common path no longer depends on the dashboard
    # being up. Note this runs AFTER redaction, never on the raw command.
    if destination == 'log':
        _append_activity_log(agent_id, tool_name, summary)
        sys.exit(0)

    token = _dashboard_token()
    if not token:
        sys.exit(0)

    port = _web_port()
    body = json.dumps({
        'agent_id': agent_id,
        'content': summary,
        'category': 'hot',       # activity entries are transient; PreCompact will promote if noteworthy
        'keywords': 'auto-activity, activity-log',
        'auto_generated': 1,
    }).encode('utf-8')

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {token}',
    }

    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f'http://localhost:{port}/api/memories',
                data=body,
                headers=headers,
                method='POST',
            ),
            timeout=3,
        )
    except Exception:
        pass  # never block the agent

    sys.exit(0)


if __name__ == '__main__':
    main()
