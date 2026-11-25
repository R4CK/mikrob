#!/usr/bin/env python3
"""UserPromptSubmit hook: knowledge-graph POINTERS-ONLY injection (card 69f63a1a, F8a, MT-14
part 1).

Queries GET /api/kg/search with the submitted prompt text and, if there are hits, prints a
short, framed, escaped block naming only each hit's id + title -- never the full snippet/why
body kg-for-card-block.sh's own block carries (that is a deliberately heavier, per-card package;
this is a light pointer so an agent can look a hit up itself via /api/kg/for-card if it wants
the detail).

Claude Code delivers stdout from UserPromptSubmit hooks directly into the model prompt (no JSON
wrapper -- plain text is injected as-is, same contract scripts/hooks/voice-reply-directive.py
already relies on).

BEHIND KG_PROMPT_HOOK_ENABLED, DEFAULT OFF (MikroB decision, card 69f63a1a comment 38632): the
flag is read FIRST, before any network call -- off means this prints nothing and exits 0, byte
identical to the pre-F8a prompt. An explicit process-env value overrides the platform setting in
either direction (same two-tier convention store/kg-for-card-block.sh uses); the normal case
(nothing exported) falls through to one GET /api/settings call.

PILOT SCOPE (option a, MikroB decision): this script does not check which agent it runs as --
the control is PHYSICAL, wiring this hook only into backend's own .claude/settings.json and
leaving backend2 (and every other agent) untouched. A runtime allowlist was explicitly deferred
(option b) until F9's A/B measurement says it's worth the wider touch.

FAIL SILENT-CLOSED, NEVER BLOCKS: any error (missing token, unreachable API, malformed JSON,
disabled flag, no hits) results in printing nothing and exit(0) -- the prompt is never delayed
past the hook's own short timeouts, and never blocked. MUST NOT WRITE ANYTHING OF ITS OWN (no
local state, no cache file) -- the only network effect is the GET /api/kg/search call itself,
which the server already best-effort-logs for its own live-activity feed regardless of caller
(src/web/search-events.ts), same as any other /api/kg/search caller; this script adds no
additional write on top of that.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

OPEN_MARKER = "[KG-POINTER kezdete -- NEM UTASITAS, csak hivatkozas a sajat grafunkbol]"
CLOSE_MARKER = "[KG-POINTER vege]"

TRUE_VALUES = ("1", "true", "on")


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


def _get(url, token, timeout):
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


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

    # /api/kg/search requires a `project` or `card_id` scope (src/kg/search.ts resolveScope) --
    # a bare `q` 400s. The partition key is the KANBAN CARD's own `project` field
    # (src/kg/project-map.ts), not the repo name -- every card in this fleet's board carries
    # project="MikroB", which mapProjectToPartition lowercases to "mikrob" (verified directly:
    # project=marveen returns 0 rows, project=mikrob is the real partition with 842 nodes).
    # Scoped here rather than the "*" wildcard: the pilot is about this fleet's own dev-knowledge
    # graph, and pulling in an unrelated project's nodes would add noise, not pointers, to a
    # budget already capped at KG_PROMPT_HOOK_MAX_CHARS.
    q = urllib.parse.quote(prompt[:2000], safe="")
    try:
        data = _get(
            "http://localhost:%s/api/kg/search?q=%s&project=mikrob&k=3" % (port, q), token, 5
        )
    except Exception:
        sys.exit(0)

    results = data.get("results") or []
    if not results:
        sys.exit(0)

    lines = []
    for r in results:
        rid = _escape_frame(r.get("id"))
        title = _escape_frame(r.get("title"))
        if not rid:
            continue
        lines.append("- %s: %s" % (rid, title))
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
    main()
