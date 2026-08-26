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
  6. DEDUP BEFORE WRITE (card 3bcc1242 part 2): card 34f1ca0c already narrowed WHICH commands
     reach the memory index (_MEMORABLE), but never stopped the SAME qualifying command from being
     written again every time it recurs. Measured live, post-34f1ca0c: 858 backend auto_generated
     rows, 665 of them (77%) sitting in 90 exact-duplicate-content groups -- e.g. 45 identical
     "Bash: git commit -m ..." rows in one sitting. An identical summary within the dedup window is
     skipped; the FIRST occurrence in the window is still recorded, so nothing genuinely new is ever
     dropped. This is a hygiene control, not a secrecy one -- it fails OPEN (treats an unreadable
     dedup-state file as "not a duplicate") rather than fail-closed like the redaction path above.

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
    # GitHub / Anthropic / OpenAI / Slack style prefixed tokens.
    #
    # Card 2102fe6a (Cybersec, follow-up to d47455bf's DB-URI fix, same file/control): the leading
    # `\b` used to require a word/non-word transition immediately before the prefix. When a 40+ char
    # run of the SAME character class (alnum) sits directly against the prefix with no separator --
    # the identical "glued" shape d47455bf fixed for DB-URI passwords -- there is no such transition
    # (`\w` next to `\w`), so this pattern never matches at all. The blob patterns below then run and
    # find a base64/hex-alphabet run, but `_`/`-` are outside the base64/hex charset, so a blob match
    # stops right at the prefix's OWN separator (e.g. the `_` in `ghp_`) -- redacting only the first
    # few letters of the prefix and leaving the ENTIRE secret body plaintext (WORSE than the DB-URI
    # case: there the leaked span was zero characters of the password; here it is effectively the
    # whole key, minus a well-known 3-9-char public prefix an attacker can just enumerate). Fixed the
    # same way d47455bf fixed the DB-URI case in spirit, but the mechanism here is different: that
    # fix was an ORDERING problem (anchored pattern needed to run before the blob patterns); this is
    # the `\b` ITSELF being the broken condition, so dropping it (not reordering, this pattern is
    # already first) lets the prefix match regardless of what precedes it, redacting prefix+secret as
    # ONE span before any blob pattern gets a turn -- the leftover glue run (still 40+ chars on its
    # own) is then caught by the blob pattern in its own right, exactly as intended.
    re.compile(r'(ghp_|ghc_|gho_|ghu_|ghs_|sk-|sk-ant-|xoxb-|xoxp-)[A-Za-z0-9_\-]{10,}'),
    # JWT-shaped triple-dot strings (header.payload.signature). Same fix, same reason: a leading
    # `\b` failed to match when glued to a preceding 40+ char run, and here NEITHER blob pattern
    # rescues any part of it (JWT segments use the base64URL alphabet -- `_`/`-`, not `+`/`/` -- so
    # the base64 blob pattern's charset does not match a JWT segment at all, and a real segment is
    # essentially never all-hex) -- worse than the token-prefix case, where the blob pattern at
    # least caught the glue run itself. The trailing `\b` is dropped too, for the mirror case (a
    # JWT glued to a FOLLOWING word-character run).
    re.compile(r'ey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}'),
    # DB connection string URI passwords: postgres://user:PASSWORD@host, mysql://, mongodb://, redis://
    # Capture group 1 = the URI prefix up to and including ':', group 2 = password (replaced).
    #
    # Card 5472cfa9: this pattern was WRITTEN by card 0c5423fc and landed in the sibling copy that
    # nothing executes, so the live hook -- which runs on EVERY tool call and writes to the memories
    # table -- did not redact connection-string passwords until now. The fixture in
    # activity-memory-capture.selftest.py is what makes that impossible to repeat: the original
    # change shipped with no test asserting the redaction it added, so nothing noticed it was
    # unreachable.
    # NO LENGTH FLOOR, unlike the heuristic patterns above (Cybersec, card 5472cfa9). Those guess
    # ("a random 6+ char run is probably a secret"), so a floor is a sensible noise filter there.
    # This one is POSITIONAL: whatever sits between `scheme://user:` and `@` is a password by
    # definition, however short. `{6,}` made a 5-character password pass through in full.
    #
    # Card d47455bf (Cybersec finding 5472cfa9 GO, follow-up): this pattern MUST run BEFORE the
    # hex/base64 blob patterns below, not after. Both blob patterns are unanchored and greedy: a
    # 40+ char run of the same character class sitting immediately before this URI with no
    # separator merges with the scheme keyword itself (e.g. "postgres" is all base64-alphabet
    # chars) into one combined match, which the blob pattern then redacts whole -- deleting the
    # literal "postgres"/"mysql"/... keyword this pattern anchors on. With the keyword gone, this
    # pattern can no longer match at all, and the password that follows survives in full. Running
    # this pattern first redacts the password while the keyword is still intact; the blob patterns
    # then see already-redacted text and have nothing left to swallow.
    re.compile(r'(?i)((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^:@\s]+:)([^@\s]+)(?=@)'),
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


def _tool_input_carries_secret(tool_input: dict) -> bool:
    """True if a field _build_summary does NOT look at (an Edit's new_string, a Write's
    content, ...) carries a secret shape. _build_summary only redacts the specific fields each
    tool type inspects (a Bash command, a file_path, ...); this is the wider, defense-in-depth
    check over the whole tool_input.

    No truncation before redacting -- the exact ordering bug card 5472cfa9 fixed elsewhere in
    this file. Card 8a18fd61 (Cybersec): this used to be a computed-and-discarded value with a
    comment claiming a "double-check" that did not exist -- made real here.
    """
    raw = json.dumps(tool_input, ensure_ascii=False)
    return _redact(raw) != raw


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
        # 0600 EXPLICITLY, not whatever the umask leaves (Cybersec, card 5472cfa9). A plain
        # open(path,'a') under the usual 0002 umask created this 0664, while its neighbours in
        # store/ -- .dashboard-token, claudeclaw.db -- are 0600. This file is the destination the
        # redactor protects, so it should not be the most readable thing in the directory.
        # os.open applies the mode only when it CREATES the file, so an existing one is chmod-ed
        # separately; both are best-effort and neither may block the agent.
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (line + '\n').encode('utf-8'))
        finally:
            os.close(fd)
        try:
            if (os.stat(path).st_mode & 0o777) != 0o600:
                os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        pass  # a trace that cannot be written must never block the agent


# ---------------------------------------------------------------------------
# Memory-index dedup (card 3bcc1242 part 2) -- SEPARATE from the activity log above:
# the log is a raw, non-deduplicated trace by design (its own docstring: "a trace, not an
# archive"). This only guards the searchable `memories` table writes.
# ---------------------------------------------------------------------------

# How long an identical summary suppresses a repeat write. Long enough to catch a burst of
# identical calls within one sitting (the measured pattern: dozens of identical rows minutes
# apart); short enough that the SAME action recurring on a genuinely later, unrelated occasion
# (e.g. "systemctl restart mikrob-channels" days apart) still earns its own memory row.
_MEMDEDUP_WINDOW_SECONDS = int(os.environ.get('ACTIVITY_MEMDEDUP_WINDOW_SECONDS', '3600'))
# Bound on the dedup-state file itself, same reasoning as _ACTIVITY_LOG_MAX_BYTES: a state file
# that grows without limit is its own small version of the problem this card fixes.
_MEMDEDUP_MAX_ENTRIES = 200


def _memdedup_path(agent_id: str) -> str:
    return os.path.join(_project_root(), 'store', 'activity-log', f'{agent_id}.memdedup.json')


def _is_recent_duplicate(agent_id: str, summary: str, now_ts: int) -> bool:
    """True if this EXACT summary was already written to the memory index for this agent within
    the dedup window. Fails OPEN (returns False, i.e. "not a duplicate") on any read/parse error --
    this is a hygiene control, not the secrecy path above, so an unreadable state file must cost at
    most a stray duplicate row, never a silently dropped genuine entry."""
    try:
        with open(_memdedup_path(agent_id)) as f:
            seen = json.load(f)
        last_ts = seen.get(summary)
        return last_ts is not None and (now_ts - last_ts) < _MEMDEDUP_WINDOW_SECONDS
    except Exception:
        return False


def _record_memdedup(agent_id: str, summary: str, now_ts: int) -> None:
    """Best-effort write of the dedup state; never raises. Called ONLY after a successful POST --
    recording an attempt that never actually reached the memories table would suppress the real
    write on a later retry, turning a transient failure into a silent, permanent loss."""
    try:
        path = _memdedup_path(agent_id)
        try:
            with open(path) as f:
                seen = json.load(f)
        except Exception:
            seen = {}
        seen[summary] = now_ts
        # Prune stale entries first (their window already lapsed), then cap by count if still
        # over -- oldest-timestamp entries evicted first.
        seen = {k: v for k, v in seen.items() if now_ts - v < _MEMDEDUP_WINDOW_SECONDS}
        if len(seen) > _MEMDEDUP_MAX_ENTRIES:
            for k in sorted(seen, key=seen.get)[: len(seen) - _MEMDEDUP_MAX_ENTRIES]:
                del seen[k]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(seen, f)
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Summary builder
# ---------------------------------------------------------------------------

def _command_verb(command: str) -> str:
    """Extract the first meaningful verb/subcommand from a bash command."""
    command = command.strip()
    # git commit fed via a heredoc (`-F - <<'TAG'` or `-m "$(cat <<'TAG' ... TAG)"`). The plain
    # branch below is a same-line match (no re.DOTALL), so on these forms it captures only the
    # constant flags/opening-marker text ("-q -F - <<'TAG'"), never the actual message a few lines
    # down -- every quiet commit then produced the identical summary row (card 5a056db8: 140
    # exact-duplicate hot/warm rows in one day). Pull the real message out of the heredoc body.
    heredoc_m = re.search(
        r'\bgit\s+commit\b.*?<<-?\s*[\'"]?(\w+)[\'"]?.*?\n(.*?)\n[ \t]*\1\b',
        command, re.IGNORECASE | re.DOTALL,
    )
    if heredoc_m:
        body = ' '.join(heredoc_m.group(2).split())
        return f"git commit {body[:60]}" if body else 'git commit'
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
    """Build a short, redacted, human-readable summary.

    REDACTION HAPPENS FIRST, BEFORE ANY TRUNCATION -- and that ordering is the whole point
    (Cybersec NO-GO, card 5472cfa9). The DB-URI pattern closes with a lookahead, `(...)(?=@)`, so
    it only fires when the `@` is still present. Truncating first can cut BETWEEN the password and
    its `@`, and then the pattern cannot match text that is, by then, a bare password at the end of
    the line. Measured on the pre-fix code with a 14-character password: prefixes of 43..55 bytes
    leaked 14 down to 2 characters of it, and at 43 the password survived IN FULL.

    A truncation that runs before a redactor does not shorten the secret -- it removes the context
    the redactor recognises it by. So every branch below redacts its raw input first and only then
    cuts. main() redacts once more afterwards, which is a harmless second pass on already-redacted
    text and keeps the fail-closed guarantee if a branch is ever added here without one.
    """
    if tool_name in ('Bash', 'bash'):
        command = _redact(str(tool_input.get('command', '')))
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
        path = _redact(str(tool_input.get('file_path', tool_input.get('path', '?'))))
        return f"{tool_name}: {path[:100]}"
    if tool_name == 'Agent':
        desc = _redact(str(tool_input.get('description', tool_input.get('prompt', '?'))))[:80]
        return f"Agent spawned: {desc}"
    if tool_name == 'Workflow':
        desc = _redact(str(tool_input.get('description', tool_input.get('name', '?'))))[:80]
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
        # Card 8a18fd61 (Cybersec): a field _build_summary does not inspect (an Edit's
        # new_string, a Write's content, ...) could carry a secret shape past both the summary
        # and this check -- skip the entry rather than write a summary that looks clean
        # (fail-closed, same guarantee as every other guard here). See
        # _tool_input_carries_secret's docstring for why this used to be a no-op.
        if _tool_input_carries_secret(tool_input):
            sys.exit(0)
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

    now_ts = int(time.time())
    # DEDUP BEFORE WRITE (card 3bcc1242 part 2): an identical summary within the window is
    # dropped here -- BEFORE the token/network work below, not as an afterthought.
    if _is_recent_duplicate(agent_id, summary, now_ts):
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
        # Recorded ONLY on success -- see _record_memdedup's own docstring for why a failed
        # attempt must never suppress a later, genuinely-first write of the same summary.
        _record_memdedup(agent_id, summary, now_ts)
    except Exception:
        pass  # never block the agent

    sys.exit(0)


if __name__ == '__main__':
    main()
