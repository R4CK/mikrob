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
and never blocked. MUST NOT WRITE ANYTHING OF ITS OWN (no local state, no cache file) -- the only
network effect is the GET /api/kg/for-card/<cardId> call itself, which the server already
best-effort-logs for its own live-activity feed regardless of caller (src/web/search-events.ts),
same as any other /api/kg/for-card caller; this script adds no additional write on top of that.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

CARD_ID_PATTERN = re.compile(r"\b[0-9a-f]{8}\b")
MAX_CARD_IDS = 2

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

    lines = []
    for card_id in card_ids:
        try:
            pkg = _get(
                "http://localhost:%s/api/kg/for-card/%s" % (port, urllib.parse.quote(card_id, safe="")),
                token,
                5,
            )
        except Exception:
            continue
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
