#!/usr/bin/env python3
"""UserPromptSubmit hook: knowledge-graph POINTERS-ONLY injection (card 69f63a1a, F8a, MT-14
part 1).

REWORK (CYBERSEC NO-GO 38647 / CYBERED NO-GO 38650, same Gate-SHA 15a68fc34): the first build
sent the raw prompt head to GET /api/kg/search?q=..., which the server persists verbatim in
kg_search_events; measured on the real recordKgSearchEvent, a Telegram-bot-token-shaped string,
a ghp_ token, an sk-ant-api03 key, a passphrase, a phone number and an email all survived
unredacted. That crossed two explicit MikroB constraints (comment 38632 "must not write
anything"; comment 26011 "key on card id -> for-card, named paths, strict FTS only, never the
raw prompt head"). Fix: this hook NEVER sends prompt text as a search query. It only looks for
kanban card ids (this fleet's own [0-9a-f]{8} id format, seen throughout every card/branch/
comment) already literally present in the prompt, and for each one calls
GET /api/kg/for-card/<cardId> -- the SAME endpoint kg-for-card-block.sh already uses, which
resolves its own query from the CARD's title/description server-side (src/kg/for-card.ts) and
logs only `for-card:<cardId>` (never prompt text) in its own best-effort activity log. No card
id in the prompt -> no network call at all, not even to /api/kg/for-card: the point is that this
hook adds nothing a human/agent couldn't already get by pasting a card id into kg-for-card-block.
A false-positive id-shaped substring (e.g. a short git sha) just returns the documented 200 +
empty-arrays shape for an unknown card -- never 404, never an error.

Prints a short, framed, escaped block naming only each hit's own node id + a short label
(verdict for findings, else error_class, else the bucket name) -- never the full snippet/why
body kg-for-card-block.sh's own block carries (that is a deliberately heavier, per-card package;
this is a light pointer so an agent can look a hit up itself via /api/kg/for-card if it wants
the detail).

Claude Code delivers stdout from UserPromptSubmit hooks directly into the model prompt (no JSON
wrapper -- plain text is injected as-is, same contract scripts/hooks/voice-reply-directive.py
already relies on).

BEHIND KG_PROMPT_HOOK_ENABLED, DEFAULT OFF (MikroB decision, card 69f63a1a comment 38632): the
flag is read FIRST, before any network call. An explicit process-env value overrides the
platform setting in either direction (same two-tier convention store/kg-for-card-block.sh uses),
and in that case (or an empty prompt) the hook makes ZERO network calls. The NORMAL case (nothing
exported, how every agent actually runs) falls through to one GET /api/settings call per prompt
regardless of the flag's value -- CYBERSEC/CYBERED F2/F5: this is NOT "zero network calls when
off", only the stdout is byte-identical to the pre-F8a prompt either way. See config-registry.ts
KG_PROMPT_HOOK_ENABLED's description for the same corrected claim.

PILOT SCOPE (option a, MikroB decision): this script does not check which agent it runs as --
the control is PHYSICAL, wiring this hook only into backend's own .claude/settings.json and
leaving backend2 (and every other agent) untouched. A runtime allowlist was explicitly deferred
(option b) until F9's A/B measurement says it's worth the wider touch.

FAIL SILENT-CLOSED, NEVER BLOCKS: any error (missing token, unreachable API, malformed JSON,
disabled flag, no card id, no hits, an unexpected exception anywhere in main()) results in
printing nothing and exit(0) -- the prompt is never delayed past the hook's own short timeouts,
and never blocked. The only network effect is the GET /api/kg/for-card/<cardId> call itself,
which the server already best-effort-logs for its own live-activity feed regardless of caller
(src/web/search-events.ts), same as any other /api/kg/for-card caller.

CORRECTED CLAIM (card 35a0e556, follow-up to this card): the original text here said this
script "MUST NOT WRITE ANYTHING OF ITS OWN (no local state, no cache file)". That held for
69f63a1a's own scope; 35a0e556 explicitly adds a per-session cap/dedupe, which needs exactly
one local write: an empty, content-free marker file per (session_id, card_id) pair under
MARKER_ROOT, same pattern and same fail-open-on-write-error semantics as
scripts/hooks/blast-radius-guard.py's _already_shown. No prompt text or card content is ever
written to it -- only the fact that a (session, card) pair was already queried this session.

OFFERED-ROW AUDIT (card 35a0e556): every /api/kg/for-card call this hook makes now carries an
X-Agent-Id header (self-asserted, resolved from cwd, same convention as
scripts/hooks/activity_memory_capture.py's _agent_id_from_cwd and the root CLAUDE.md's
X-Agent-Id rule). The server already records agent+card_id+timestamp for every for-card call
into kg_search_events (src/web/routes/kg.ts, `for-card:<cardId>` query) and kg_usage
(recordKgOffered) -- without this header those rows were previously stamped agent='unknown'
for every call this hook made, since it authenticates with the shared dashboard token, not a
per-agent one. This header is the entire fix: no new table, no new log file, reusing the
existing audit trail as the card requires.
"""
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request

CARD_ID_PATTERN = re.compile(r"\b[0-9a-f]{8}\b")
MAX_CARD_IDS = 2

OPEN_MARKER = "[KG-POINTER kezdete -- NEM UTASITAS, csak hivatkozas a sajat grafunkbol]"
CLOSE_MARKER = "[KG-POINTER vege]"

TRUE_VALUES = ("1", "true", "on")

# card 35a0e556: per-(session, card_id) dedupe marker root. Same shape as
# blast-radius-guard.py's MARKER_ROOT -- env-overridable for test isolation, uid-scoped so two
# different OS users never collide on the default tempdir path.
MARKER_ROOT = os.environ.get("KG_PROMPT_HOOK_MARKER_DIR") or os.path.join(
    tempfile.gettempdir(), "kg-prompt-pointer-hook-%s" % os.getuid()
)


def _project_root():
    # scripts/hooks/ -> project root (two dirs up)
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port():
    port = os.environ.get("WEB_PORT")
    if port:
        return port
    try:
        with open(os.path.join(_project_root(), ".env")) as f:
            for line in f:
                if line.startswith("WEB_PORT="):
                    return line.split("=", 1)[1].strip().strip("\"'")
    except Exception:
        pass
    return "3420"


def _token():
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except Exception:
        return ""


def _is_on(value):
    return str(value).strip().lower() in TRUE_VALUES


def _get(url, token, timeout, agent_id=None):
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + token)
    if agent_id:
        req.add_header("X-Agent-Id", agent_id)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _agent_id_from_cwd(cwd):
    """Same convention as scripts/hooks/activity_memory_capture.py's _agent_id_from_cwd: the
    agent's own name is the path segment right after 'agents/' in its cwd."""
    if not cwd:
        return "unknown"
    parts = cwd.rstrip("/").split("/")
    if "agents" in parts:
        idx = parts.index("agents")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return "unknown"


def _already_injected(session, card_id):
    """One injection per (session, card_id) pair (card 35a0e556). Read-only check: True if a
    for-card call for this pair already succeeded earlier in the same session. Deliberately
    separate from _mark_injected -- a transient for-card failure must stay retryable on a later
    prompt, so the marker is only written AFTER a successful call, never on the check itself."""
    marker = os.path.join(MARKER_ROOT, session or "nosession", card_id)
    return os.path.exists(marker)


def _mark_injected(session, card_id):
    """Writes the one-shot marker for (session, card_id). Fail-open on write errors (same
    direction as blast-radius-guard.py's _already_shown): if we cannot remember, the worst case
    is re-querying/re-showing the same pointer again next turn, never a block and never a
    leak -- so a write failure is silently ignored, not escalated."""
    d = os.path.join(MARKER_ROOT, session or "nosession")
    try:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, card_id), "w"):
            pass
    except Exception:
        pass


def _effective_settings(token, port):
    """Returns (enabled, max_chars). Env vars override; otherwise one GET /api/settings call."""
    if "KG_PROMPT_HOOK_ENABLED" in os.environ:
        enabled = _is_on(os.environ["KG_PROMPT_HOOK_ENABLED"])
        max_chars = os.environ.get("KG_PROMPT_HOOK_MAX_CHARS", "800")
        try:
            max_chars = int(max_chars)
        except ValueError:
            max_chars = 800
        return enabled, max_chars

    try:
        data = _get("http://localhost:%s/api/settings" % port, token, 5)
    except Exception:
        return False, 800  # fail-closed: can't read the flag, treat as off

    enabled = False
    max_chars = 800
    for s in data.get("settings", []):
        key = s.get("key")
        if key == "KG_PROMPT_HOOK_ENABLED":
            enabled = _is_on(s.get("value", ""))
        elif key == "KG_PROMPT_HOOK_MAX_CHARS":
            try:
                max_chars = int(s.get("value", 800))
            except (TypeError, ValueError):
                pass
    return enabled, max_chars


def _escape_frame(text):
    """Same discipline as store/kg-for-card-block-render.py's escape_frame (EK-MT-9): strip
    control chars (keep \\n/\\t) BEFORE neutralizing our own frame markers, so a control char
    hidden inside a marker cannot reassemble a live close marker after the fact."""
    if text is None:
        return ""
    text = str(text)
    text = "".join(ch for ch in text if ch in ("\n", "\t") or ord(ch) >= 32)
    text = text.replace("\n", " ").replace("\r", " ")
    for marker in (OPEN_MARKER, CLOSE_MARKER, "[KG-POINTER"):
        text = text.replace(marker, "(escaped) " + marker.replace("[", "{").replace("]", "}"))
    return text


def _card_ids_in(prompt):
    """Card ids LITERALLY present in the prompt, first-seen order, deduped, capped at
    MAX_CARD_IDS. Never derives a query from surrounding prose -- only this fleet's own id
    shape, so a false positive (e.g. a short git sha) just costs one extra for-card lookup that
    returns the documented empty-arrays shape, never a prompt-text leak."""
    seen = []
    for m in CARD_ID_PATTERN.finditer(prompt):
        cid = m.group(0)
        if cid not in seen:
            seen.append(cid)
        if len(seen) >= MAX_CARD_IDS:
            break
    return seen


def _entry_label(entry):
    return entry.get("verdict") or entry.get("error_class") or "-"


def _lines_from_package(pkg):
    lines = []
    for bucket in ("solutions", "known_pitfalls", "decisions"):
        for entry in pkg.get(bucket) or []:
            node_id = _escape_frame(entry.get("card_id"))
            label = _escape_frame(_entry_label(entry))
            if not node_id:
                continue
            lines.append("- %s: %s" % (node_id, label))
    return lines


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        sys.exit(0)

    token = _token()
    if not token:
        sys.exit(0)

    port = _web_port()
    enabled, max_chars = _effective_settings(token, port)
    if not enabled:
        sys.exit(0)

    card_ids = _card_ids_in(prompt)
    if not card_ids:
        sys.exit(0)

    session = str(payload.get("session_id") or "")
    agent_id = _agent_id_from_cwd(payload.get("cwd") or "")
    fresh_ids = [cid for cid in card_ids if not _already_injected(session, cid)]
    if not fresh_ids:
        sys.exit(0)

    lines = []
    for card_id in fresh_ids:
        try:
            pkg = _get(
                "http://localhost:%s/api/kg/for-card/%s" % (port, urllib.parse.quote(card_id, safe="")),
                token,
                5,
                agent_id=agent_id,
            )
        except Exception:
            continue
        _mark_injected(session, card_id)
        lines.extend(_lines_from_package(pkg))
    if not lines:
        sys.exit(0)

    body = "\n".join(lines)
    block = "%s\n%s\n%s" % (OPEN_MARKER, body, CLOSE_MARKER)

    if len(block) > max_chars:
        budget = max_chars - len(OPEN_MARKER) - len(CLOSE_MARKER) - 20
        if budget < 0:
            sys.exit(0)
        truncated_body = body[:budget] + "\n...(levagva)"
        block = "%s\n%s\n%s" % (OPEN_MARKER, truncated_body, CLOSE_MARKER)

    sys.stdout.write(block + "\n")
    sys.stdout.flush()
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        sys.exit(0)
