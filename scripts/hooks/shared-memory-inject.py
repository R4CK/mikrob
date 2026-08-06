#!/usr/bin/env python3
"""SessionStart hook: auto-inject the SHARED-tier memory into a fleet agent's
context at session start / resume / clear, so every agent always works with the
correct cross-agent context WITHOUT having to remember to query the API (pull).

Peti 2026-07-19: fleet agents can READ shared memory but only via manual curl,
which an LLM does not do reliably every session -> push it instead. The `shared`
tier is the cross-agent channel (verified: same set visible to every agent).

Mirrors taskstate-replay.py: read stdin payload -> fetch -> print SessionStart
additionalContext. ALWAYS exits 0 (never breaks session start / fail-safe).
Thin + config-driven (dashboard port from .env, token from store/.dashboard-token).
The base system stays updatable: this file is tracked in the fork; it touches no
upstream file and holds no secret (token read at runtime).
"""
import sys
import os
import json
import urllib.request


def _project_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port():
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


def _token():
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except Exception:
        return ""


def _agent_id_from_cwd(cwd):
    if not cwd:
        return None
    parts = os.path.normpath(cwd).split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    agent = _agent_id_from_cwd(payload.get("cwd")) or "fleet"
    token = _token()
    if not token:
        sys.exit(0)  # no token -> no-op (fail-safe)

    api = "http://localhost:%s/api" % _web_port()
    url = "%s/memories?agent=%s&category=shared" % (api, agent)
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.load(r)
    except Exception:
        sys.exit(0)  # dashboard unavailable -> no-op (fail-safe)

    mems = data if isinstance(data, list) else data.get("memories", data.get("data", []))

    lines = []
    for m in (mems or []):
        c = (m.get("content") or "").strip()
        if c:
            kw = (m.get("keywords") or "").strip()
            lines.append("- " + c + (("  [%s]" % kw) if kw else ""))

    sections = []

    # Proactive local-LLM offload directive (Peti 2026-07-24): when the offload
    # flag is active, EVERY fleet agent is reminded, at every session start, to
    # actively hand mechanical code pieces to the local model -- structural
    # enforcement so it does not decay to a soft, forgotten directive. Fail-safe:
    # any error just skips the note. See memory proactive-offload-active-below-weekly.
    try:
        flag_path = os.path.join(_project_root(), "store", "local-llm-offload-active.json")
        with open(flag_path) as f:
            flag = json.load(f)
        if flag.get("active") is True:
            sections.append(
                "LOKÁLIS-LLM OFFLOAD AKTÍV (Peti direktíva — KÖTELEZŐ, minden ügynökre). "
                "A Claude-token kímélésére a MECHANIKUS, jól-körülhatárolt kód-darabokat "
                "AKTÍVAN add ki a helyi modellnek, ne írd inline: pure függvény exact "
                "specből, regex, type/interface, DTO-készlet, data-transform, unit-teszt "
                "scaffold, validator, boilerplate, docstring, i18n draft. Hívás (ABSZOLÚT "
                "út, bármely cwd-ből):\n"
                "  " + _project_root() + "/store/local-llm-rag.sh --task code --caller <neved> --context \"...\" \"<pontos szignatúra + return only the code>\"\n"
                "NE offloadold: authz/izoláció/architektúra/multi-file-wiring/security-döntés. "
                "Kezelés: strip a ```fence-eket, OLVASD el, integráld, futtass tsc+lint+tesztet "
                "— TE felelsz a helyességért. Draft-only (local-llm-draft), a gate visszaellenőrzi, "
                "sose auto-done. AGRESSZÍVEN offloadolj: kártyánként TÖBB és NAGYOBB darabot; "
                "egy nulla-offloaddal lezárt kártya elszalasztott token-spórolás. A ≤20% (éjszaka "
                "≤30%) draft-hibaarány elfogadható — a rossz darabot eldobod, a többi nyeresége marad."
            )
    except Exception:
        pass  # no flag / unreadable -> no offload note

    if lines:
        sections.append(
            "KÖZÖS MEMÓRIA (shared tier — a flotta közös kontextusa, automatikusan "
            "behúzva). Ezek a tények/szabályok MINDEN ügynökre vonatkoznak; a munkádat "
            "ezekkel ÖSSZHANGBAN végezd. Ha egy döntéshez több kontextus kell, kérdezd a "
            "memória-API-t (/api/memories?agent=<neved>&q=...&category=shared):\n\n"
            + "\n".join(lines)
        )

    if not sections:
        sys.exit(0)  # nothing to inject -> no-op

    inject = "\n\n".join(sections)

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": inject,
        }
    }, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(0)


if __name__ == "__main__":
    main()
