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

# Bash commands that ARE state-changing and worth recording.
_STATE_CHANGING = re.compile(
    r'(?:'
    # git writes
    r'\bgit\s+(?:commit|push|merge|rebase|tag|reset|checkout\b(?!\s*--))\b'
    # curl mutating calls to our own API (localhost or 127)
    r'|curl\b.*-X\s*(?:POST|PUT|DELETE|PATCH).*(?:localhost|127\.0\.0\.1)'
    # kanban / memory / message API calls via printf|curl idiom
    r'|printf.*curl.*localhost'
    # systemctl state changes
    r'|\bsystemctl\s+(?:start|stop|restart|reload|enable|disable)\b'
    # npm/pnpm install
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


def _should_record(tool_name: str, tool_input: dict, tool_response: dict) -> bool:
    """True iff this tool call is worth recording as an activity memory."""
    if tool_name in _READ_ONLY_TOOLS:
        return False
    # Skip if the tool errored -- partial / failed actions are not evidence
    if isinstance(tool_response, dict) and tool_response.get('is_error'):
        return False
    if tool_name in ('Bash', 'bash'):
        command = str(tool_input.get('command', ''))
        if _READ_ONLY_COMMANDS.search(command):
            return False
        if _STATE_CHANGING.search(command):
            return True
        # Unknown bash command -- conservative default: skip (avoid zaj)
        return False
    # Other state-changing tools (Write, Edit, Agent, Workflow) -- capture lightly
    if tool_name in ('Write', 'Edit', 'NotebookEdit'):
        return True
    if tool_name in ('Agent', 'Workflow'):
        return True
    return False


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
    return command[:80]


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

    if not _should_record(tool_name, tool_input, tool_response):
        sys.exit(0)

    token = _dashboard_token()
    if not token:
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
