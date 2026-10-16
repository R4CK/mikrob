#!/usr/bin/env python3
"""PreToolUse hook: stop an agent from minting/reading ANOTHER agent's dashboard device key
(card 9c7ad372 O5, WhiteHat2 GO comment 17107 on 2bfa4c67).

THE GAP. The structured gate-verdict record (card 2bfa4c67) trusts an `agent:<id>` device key as
proof the caller IS that gate -- but every agent process runs as the SAME UID, and the mint path
(`dashboard-user -- agent-key:mint <id>`, wrapped by `store/agent-key-provision.sh <id>`) and the
minted key files themselves (`agents/<id>/.dashboard-agent-key`, 0600) are both readable/runnable
by any of them. "Hitelesitett" therefore means "not forgeable over the network with the shared
token", not "UID-isolated" -- a compromised builder can still mint or read a DIFFERENT gate's key
locally and write a verdict record as that gate. This guard narrows that: it is not a UID boundary
(nothing at the OS level is), it is a speed bump on the OBVIOUS command shapes an agent session
would type to cross it, matching the npm-protect-guard.py / git-protect-guard.py philosophy in
this codebase -- a seatbelt, not a kernel-enforced control.

WHAT THIS BLOCKS, for the calling agent's OWN identity (self) only:
  - reading/copying a DIFFERENT agent's `.dashboard-agent-key` file (any command whose arguments
    reference `agents/<other>/.dashboard-agent-key`);
  - `dashboard-user -- agent-key:mint|rotate|revoke <other>` or
    `agent-key-provision.sh <other> [--rotate|--revoke]`, for a <other> that is not self.

Self-identity comes from MARVEEN_AGENT_ID / CLAUDE_AGENT_ID (same precedence as
bash-egress-guard.py's _resolve_agent), falling back to a `.../agents/<name>(/|$)` match in the
tool call's cwd. If self cannot be determined at all, this FAILS OPEN (same convention as every
guard in this directory: a guard that cannot tell must not block the operator/MikroB, who run
these same commands legitimately for OTHER agents during provisioning).

ESCAPE HATCH: `MARVEEN_ALLOW_AGENT_KEY=1 <command>` (inline, one-shot, greppable).

WHAT THIS IS NOT: a regex over the command string, like its siblings. No defense against variable
indirection, a command written to a file and then run, or reading the sqlite `device_keys` table
directly (that path is covered by the server-side role-allowlist in kanban-verdicts.ts, not by a
shell-command guard). Any guard error FAILS OPEN.
"""
import json
import os
import re
import sys

ALLOW_ENV = "MARVEEN_ALLOW_AGENT_KEY"

_AGENT_ID_RX = r"[a-z][a-z0-9-]{0,31}"

# `agents/<id>/.dashboard-agent-key`, with or without a leading path, relative or absolute.
_KEY_FILE_RX = re.compile(r"agents/(" + _AGENT_ID_RX + r")/\.dashboard-agent-key\b")

# `dashboard-user -- agent-key:mint|rotate|revoke <id>` (any `npm run ... --` prefix form) and the
# wrapper script `agent-key-provision.sh <id>`.
_MINT_CLI_RX = re.compile(
    r"\bagent-key:(?:mint|revoke)\b[^\n;&|]*?\s(" + _AGENT_ID_RX + r")\b"
)
_PROVISION_SH_RX = re.compile(
    r"\bagent-key-provision\.sh\s+(" + _AGENT_ID_RX + r")\b"
)

_CWD_AGENT_RX = re.compile(r"(?:^|/)agents/(" + _AGENT_ID_RX + r")(?:/|$)")

_QUOTED_RX = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)


def _strip_quoted_literals(cmd):
    """A path/flag mentioned inside a quoted STRING (an echo, a commit message, a comment written
    to a file) is data, not a command this guard needs to act on -- same exemption
    npm-protect-guard.py applies, and for the same reason: `echo 'mint agent-key for qa'` is prose,
    not a mint."""
    return _QUOTED_RX.sub(lambda m: "''" if m.group(0)[0] == "'" else '""', cmd)


def _self_agent(payload, cwd):
    agent = os.environ.get("MARVEEN_AGENT_ID") or os.environ.get("CLAUDE_AGENT_ID")
    if agent:
        return agent.strip().lower()
    m = _CWD_AGENT_RX.search(cwd or "")
    if m:
        return m.group(1)
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    raw = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(raw, str):
        sys.exit(0)
    if "agent-key" not in raw and "dashboard-agent-key" not in raw:
        sys.exit(0)
    if f"{ALLOW_ENV}=1" in raw:
        sys.exit(0)

    cwd = payload.get("cwd") or os.getcwd()

    try:
        self_agent = _self_agent(payload, cwd)
        if not self_agent:
            sys.exit(0)  # cannot determine self -> fail open (operator/MikroB path)

        scrubbed = _strip_quoted_literals(raw)
        targets = set()
        for rx in (_KEY_FILE_RX, _MINT_CLI_RX, _PROVISION_SH_RX):
            targets.update(m.group(1).lower() for m in rx.finditer(scrubbed))

        other = sorted(t for t in targets if t != self_agent)
        if other:
            sys.stderr.write(
                "AGENT-KEY-SECRET-GUARD: ez a parancs egy MASIK ugynok "
                f"({', '.join(other)}) agent:<id> dashboard-kulcsat olvasna vagy "
                f"adna ki, a sajat ugynok-azonossagod ({self_agent}) alatt futva. "
                "A strukturalt gate-verdikt rekord (kartya 2bfa4c67) ezt a kulcsot "
                "hasznalja 'hitelesitett' szerzokent -- egy masik gate kulcsahoz "
                "valo hozzaferes ures gate-verdiktet hamisithatna. Ha ez tenyleg "
                "provisioning/operator-muvelet (pl. MikroB uj kulcsot oszt ki), "
                f"egyszeri korre: {ALLOW_ENV}=1 <parancs>."
            )
            sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open

    sys.exit(0)


if __name__ == "__main__":
    main()
