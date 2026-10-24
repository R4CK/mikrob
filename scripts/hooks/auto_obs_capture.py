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
import re
import shutil
import subprocess
import sys
import time
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
    _redact,
    _web_port,
)

_EDIT_TOOLS = frozenset({'Write', 'Edit', 'MultiEdit', 'NotebookEdit'})
_FLAG_FILE = os.path.join(_project_root(), 'store', 'auto-obs-capture-agents.json')
_GIT_BIN = shutil.which('git') or 'git'

# WhiteHat NO-GO F1 MEDIUM (card f88289d6, comment 24012): file_path is the tool's own raw
# argument -- an attacker who controls a Write/Edit call controls this value. No length/type/
# control-char bound, no secret redaction. Fix: reject anything that is not a plain, bounded,
# single-line string outright (file_path=None, never a truncated value), then redact the
# survivors through the sibling hook's own secret-shape patterns.
# RedHat NO-GO F (card f88289d6, comment 24233): the ORIGINAL class excluded \x09/\x0a/\x0d
# (tab/LF/CR) from the control-char set, so a SHORT newline-carrying path passed through
# unfiltered -- only the 512-char length cap happened to reject the one newline case this
# hook's own selftest tried (a 20KB payload). \x00-\x1f now covers the whole C0 range.
_MAX_FILE_PATH_LEN = 512
_CONTROL_OR_LINEBREAK_RX = re.compile('[\x00-\x1f\x7f\u0085\u2028\u2029]')

# WhiteHat NO-GO F2 LOW: no dedup -- every qualifying call writes its own cold row. Reuses the
# sibling hook's dedup shape (card 3bcc1242 part 2) but in this hook's OWN state file: the two
# hooks write structurally different records (prose summary vs. fixed-field JSON), so sharing one
# dedup file would make one hook's key collide with the other's unrelated content.
_DEDUP_WINDOW_SECONDS = int(os.environ.get('AUTO_OBS_DEDUP_WINDOW_SECONDS', '3600'))
_DEDUP_MAX_ENTRIES = 200


def _sanitize_file_path(value):
    """None for anything that is not a plain, bounded, single-line string; the known secret
    shapes are redacted out of what remains. Never returns a truncated/partial value -- a value
    that fails any check is dropped whole, not shortened (shortening a reject can still leak the
    start of a secret)."""
    if not isinstance(value, str):
        return None
    if len(value) > _MAX_FILE_PATH_LEN:
        return None
    if _CONTROL_OR_LINEBREAK_RX.search(value):
        return None
    try:
        return _redact(value)
    except Exception:
        return None


def _dedup_path(agent_id: str) -> str:
    return os.path.join(_project_root(), 'store', 'activity-log', f'{agent_id}.autoobsdedup.json')


def _is_recent_duplicate(agent_id: str, key: str, now_ts: float) -> bool:
    """Fails OPEN (False) on any read error -- this is a hygiene control, not the secrecy path
    above, so an unreadable state file costs at most a stray duplicate row."""
    try:
        with open(_dedup_path(agent_id)) as f:
            seen = json.load(f)
        last_ts = seen.get(key)
        return last_ts is not None and (now_ts - last_ts) < _DEDUP_WINDOW_SECONDS
    except Exception:
        return False


def _record_dedup(agent_id: str, key: str, now_ts: float) -> None:
    """Best-effort; called only after a successful POST (recording an attempt that never
    reached the memories table would suppress the real write on a later retry)."""
    try:
        path = _dedup_path(agent_id)
        try:
            with open(path) as f:
                seen = json.load(f)
        except Exception:
            seen = {}
        seen[key] = now_ts
        seen = {k: v for k, v in seen.items() if now_ts - v < _DEDUP_WINDOW_SECONDS}
        if len(seen) > _DEDUP_MAX_ENTRIES:
            for k in sorted(seen, key=seen.get)[: len(seen) - _DEDUP_MAX_ENTRIES]:
                del seen[k]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump(seen, f)
    except Exception:
        pass


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
    raw = tool_input.get('file_path')
    if raw is None:
        raw = tool_input.get('path')
    return _sanitize_file_path(raw)


def _commit_sha(cwd: str):
    if not cwd:
        return None
    try:
        out = subprocess.run(
            [_GIT_BIN, '-C', cwd, 'rev-parse', '--short', 'HEAD'],
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
        dedup_key = json.dumps(record, sort_keys=True)
        now_ts = time.time()
        if _is_recent_duplicate(agent_id, dedup_key, now_ts):
            sys.exit(0)
        _post_observation(agent_id, record)
        _record_dedup(agent_id, dedup_key, now_ts)
    except Exception:
        pass

    sys.exit(0)


if __name__ == '__main__':
    main()
