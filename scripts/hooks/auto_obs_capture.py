#!/usr/bin/env python3
"""PostToolUse hook: deterministic-metadata-only tool-observation log (claude-mem B, card f88289d6).

Companion to claude-mem (A) (shared-memory-inject.py): where (A) injects curated memory INTO a
session, this writes a tiny OBSERVATION record OUT of each qualifying tool call. Unlike the
existing activity_memory_capture.py (card 4829ccff), which stores a redacted but still
free-text summary, this hook NEVER stores prose, a command string, a diff, or tool output --
only five fixed, structural fields.

Design rules (card f88289d6):
  1. Fields are fixed and exhaustive: tool name, exit code, file path, card ID, commit sha.
     Nothing else is ever written.
     - exit_code is 0/1, derived from tool_response["is_error"]. The PostToolUse payload carries
       no literal process return code for Bash, so a boolean-derived binary is the most honest
       deterministic value available here -- surfaced as an explicit assumption, not hidden.
     - file_path is the tool's own file_path/path argument (Edit/Write/MultiEdit/NotebookEdit
       only); None for Bash.
     - card_id is the caller's current single in_progress card (GET /api/kanban), or None if
       zero or more than one match -- never guessed.
     - commit_sha is `git rev-parse --short HEAD` in the tool's cwd, best-effort, or None.
  2. Own agent scope only: agent_id is always the caller's own id (from cwd); category is never
     'shared'.
  3. Feature flag, default OFF: store/auto-obs-capture-agents.json "enabled_agents" list. A
     missing file, unreadable file, or an agent not on the list is a silent no-op -- same
     fail-safe shape as store/session-memory-inject-agents.json (claude-mem A).
  4. Qualifying filter REUSES activity_memory_capture.py's already-reviewed classification
     (_READ_ONLY_TOOLS, _READ_ONLY_COMMANDS) instead of re-deriving it: a Bash call only
     qualifies if its actual command text is not read-only -- not merely because
     tool_name == "Bash" ("value filter, bare command name is not enough").
  5. Never blocks the agent and never raises past main(): any error anywhere is swallowed,
     sys.exit(0).
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from activity_memory_capture import (  # noqa: E402
    _READ_ONLY_COMMANDS,
    _READ_ONLY_TOOLS,
    _agent_id_from_cwd,
    _dashboard_token,
    _project_root,
    _web_port,
)

_EDIT_TOOLS = frozenset({'Write', 'Edit', 'MultiEdit', 'NotebookEdit'})
_FLAG_FILE = os.path.join(_project_root(), 'store', 'auto-obs-capture-agents.json')


def _enabled_agents() -> set:
    try:
        with open(_FLAG_FILE) as f:
            data = json.load(f)
        return set(data.get('enabled_agents') or [])
    except Exception:
        return set()


def _qualifies(tool_name: str, tool_input: dict) -> bool:
    if tool_name in _READ_ONLY_TOOLS:
        return False
    if tool_name in _EDIT_TOOLS:
        return True
    if tool_name in ('Bash', 'bash'):
        command = str(tool_input.get('command', ''))
        return not _READ_ONLY_COMMANDS.search(command)
    return False


def _exit_code(tool_response: dict) -> int:
    return 1 if isinstance(tool_response, dict) and tool_response.get('is_error') else 0


def _file_path(tool_name: str, tool_input: dict):
    if tool_name not in _EDIT_TOOLS:
        return None
    return tool_input.get('file_path') or tool_input.get('path')


def _commit_sha(cwd: str):
    if not cwd:
        return None
    try:
        out = subprocess.run(
            ['git', '-C', cwd, 'rev-parse', '--short', 'HEAD'],
            capture_output=True, text=True, timeout=2,
        )
        if out.returncode == 0:
            sha = out.stdout.strip()
            return sha or None
    except Exception:
        pass
    return None


def _current_card_id(agent_id: str):
    token = _dashboard_token()
    if not token:
        return None
    url = (
        f'http://localhost:{_web_port()}/api/kanban'
        f'?status=in_progress&assignee={urllib.parse.quote(agent_id)}'
    )
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None
    cards = data.get('cards', data) if isinstance(data, dict) else data
    if not isinstance(cards, list) or len(cards) != 1:
        return None
    return cards[0].get('id')


def _post_observation(agent_id: str, record: dict) -> None:
    token = _dashboard_token()
    if not token:
        return
    body = json.dumps({
        'agent_id': agent_id,
        'content': json.dumps(record, sort_keys=True),
        'category': 'cold',
        'keywords': 'auto-obs',
    }).encode('utf-8')
    req = urllib.request.Request(
        f'http://localhost:{_web_port()}/api/memories',
        data=body,
        method='POST',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
            'X-Agent-Id': agent_id,
        },
    )
    try:
        urllib.request.urlopen(req, timeout=2)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        pass


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

    try:
        agent_id = _agent_id_from_cwd(cwd)
        if agent_id == 'unknown' or agent_id not in _enabled_agents():
            sys.exit(0)

        if not _qualifies(tool_name, tool_input):
            sys.exit(0)

        record = {
            'tool': tool_name,
            'exit_code': _exit_code(tool_response),
            'file_path': _file_path(tool_name, tool_input),
            'card_id': _current_card_id(agent_id),
            'commit_sha': _commit_sha(cwd),
        }
        _post_observation(agent_id, record)
    except Exception:
        pass

    sys.exit(0)


if __name__ == '__main__':
    main()
