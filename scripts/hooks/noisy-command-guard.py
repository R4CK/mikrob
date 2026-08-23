#!/usr/bin/env python3
"""PreToolUse hook: steer noisy commands (installs/builds/test runs/progress-bar tools) through
scripts/noisy-run.sh instead of letting the raw transcript land in an agent's context verbatim.

Peti request (2026-08-23, Telegram image "ASK FOR THE HOOK"): catch install/build/test/anything
with a progress bar, keep only errors/failures/the final summary, leave everything else -- short
commands included -- completely alone.

WHY BLOCK-AND-SUGGEST, NOT A SILENT REWRITE
Checked against the real Claude Code hook schema first (all three existing PreToolUse guards in
this repo -- git-protect-guard.py, npm-protect-guard.py, secret-write-guard.py -- confirm it):
a PreToolUse hook can only ALLOW (exit 0) or BLOCK (exit 2, stderr shown to the agent) a tool call.
There is no field to substitute a different command string; Bash always runs exactly what the agent
asked for, or not at all. So "rewrite before it runs" is implemented the only way the platform
allows: block the noisy raw form, and hand back the exact filtered command to run instead. The agent
sees the reason and reruns through scripts/noisy-run.sh, which does the real filtering.

WHAT COUNTS AS NOISY
npm/pnpm/yarn install|ci|add|update and `npm run build`; test runners (npx vitest/jest/playwright,
`npm test`, `go test`, `cargo test`, `pytest`, `mvn test`); builds (`go build`, `cargo build`, `tsc`
without --noEmit, webpack/vite build, `docker build`, `docker compose up`); package managers
(`apt-get install`, `pip install`). Anything NOT on this list is left alone regardless of length --
this guard does not guess from output length, only from the command shape, per Peti's "if a command
is short, I still want the whole thing."

ESCAPE HATCHES
- Already wrapped through noisy-run.sh: skipped (avoids an infinite block loop).
- `NOISY_RUN_ALLOW_RAW=1 <cmd>`: explicit, greppable, one-off bypass for when the agent genuinely
  needs the raw interleaved output (e.g. debugging why a build hangs).

WHAT THIS IS NOT. Like its siblings, a regex over the command STRING: a seatbelt, not a security
boundary. Any guard error FAILS OPEN.
"""
import json
import os
import re
import sys

ALLOW_ENV = "NOISY_RUN_ALLOW_RAW"

_ENV_PREFIX = r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)*"
_CMD = r"(?:^|[\n;&|(])\s*" + _ENV_PREFIX + r"(?:sudo\s+)?(?:time\s+)?"

_MUTATING_NPM = r"(?:ci|install|i|add|update|up|upgrade|dedupe|rebuild)"
NOISY_PATTERNS = [
    re.compile(_CMD + r"(?:npm|pnpm|yarn)\s+(?:[-\w]+\s+)*?" + _MUTATING_NPM + r"\b"),
    re.compile(_CMD + r"(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test)\b"),
    re.compile(_CMD + r"npx\s+(?:[-\w@/.]+\s+)*?(?:vitest|jest|playwright|mocha|ava)\b"),
    re.compile(_CMD + r"(?:go)\s+(?:build|test)\b"),
    re.compile(_CMD + r"cargo\s+(?:build|test)\b"),
    re.compile(_CMD + r"(?:python3?\s+-m\s+)?pytest\b"),
    re.compile(_CMD + r"mvn\s+(?:[-\w]+\s+)*?(?:install|test|package|verify)\b"),
    re.compile(_CMD + r"(?:\.\/)?gradlew?\s+(?:[-\w]+\s+)*?(?:build|test)\b"),
    re.compile(_CMD + r"tsc\b(?![^\n;&|]*--noEmit\b[^\n;&|]*$)(?=[^\n;&|]*(?:$|[\n;&|]))"),
    re.compile(_CMD + r"(?:webpack|vite)\s+(?:[-\w]+\s+)*?build\b"),
    re.compile(_CMD + r"docker\s+build\b"),
    re.compile(_CMD + r"docker[- ]compose\s+(?:[-\w]+\s+)*?up\b"),
    re.compile(_CMD + r"apt(?:-get)?\s+(?:[-\w]+\s+)*?install\b"),
    re.compile(_CMD + r"pip3?\s+install\b"),
]

_WRAPPER_RX = re.compile(
    r"(?:^|[\n;&|(])\s*(?:bash|sh|zsh)\s+-c\s+(['\"])(.*?)\1|(?:^|[\n;&|(])\s*eval\s+(['\"])(.*?)\3",
    re.S,
)
_HEREDOC_RX = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*?^\s*\2\s*$", re.S | re.M)
_QUOTED_RX = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)


def _unwrapped_variants(cmd):
    out = [cmd]
    for m in _WRAPPER_RX.finditer(cmd):
        inner = m.group(2) if m.group(2) is not None else m.group(4)
        if inner:
            out.append(inner)
    return out


def _strip_heredoc_bodies(cmd):
    return _HEREDOC_RX.sub("<<HEREDOC-BODY-STRIPPED", cmd)


def _strip_quoted_literals(cmd):
    return _QUOTED_RX.sub(lambda m: "''" if m.group(0)[0] == "'" else '""', cmd)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    raw = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        sys.exit(0)

    # Already routed through the filter -- do not re-block its own invocation.
    if "noisy-run.sh" in raw:
        sys.exit(0)

    try:
        cmd = _strip_heredoc_bodies(raw)
        for variant in (_strip_quoted_literals(v) for v in _unwrapped_variants(cmd)):
            if f"{ALLOW_ENV}=1" in variant:
                sys.exit(0)
            for rx in NOISY_PATTERNS:
                if rx.search(variant):
                    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                    sys.stderr.write(
                        "NOISY-COMMAND-GUARD: ez a parancs jellemzoen sok, keves informaciotartalmu "
                        "kimenetet ad (install/build/teszt/progress-bar). Ne futtasd nyersen -- fusd "
                        f"a szuron keresztul, ami csak a hiba/fail/warn sorokat es a vegso "
                        f"osszefoglalot adja vissza, a teljes log egy fajlba megy:\n\n"
                        f"  bash {here}/noisy-run.sh {raw}\n\n"
                        f"Ha tenyleg a nyers, interlevelt kimenet kell (pl. build-hang debug), "
                        f"egyszeri korre: {ALLOW_ENV}=1 {raw}"
                    )
                    sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open

    sys.exit(0)


if __name__ == "__main__":
    main()
