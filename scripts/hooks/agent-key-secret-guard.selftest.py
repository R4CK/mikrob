#!/usr/bin/env python3
"""Self-test for agent-key-secret-guard.py (card 9c7ad372, WhiteHat2 O5).

Run:  python3 scripts/hooks/agent-key-secret-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.
"""
import json
import subprocess
import sys
from pathlib import Path

GUARD = Path(__file__).with_name("agent-key-secret-guard.py")

BLOCK = "block"
ALLOW = "allow"


def verdict(cmd, cwd, env=None):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd})
    full_env = {}
    if env:
        full_env.update(env)
    full_env["PATH"] = "/usr/bin:/bin"
    p = subprocess.run(
        [sys.executable, str(GUARD)], input=payload, capture_output=True, text=True, env=full_env,
    )
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


def main():
    cases = [
        # ---- self (backend) acting on ANOTHER agent's key: BLOCK ----------------------------
        (BLOCK, "cat agents/qa/.dashboard-agent-key", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (BLOCK, "head -c 40 /home/neon/marveen/agents/cybersec/.dashboard-agent-key", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (BLOCK, "npm run dashboard-user -- agent-key:mint qa", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (BLOCK, "npm run dashboard-user -- agent-key:mint qa --rotate", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (BLOCK, "npm run dashboard-user -- agent-key:revoke cybered", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (BLOCK, "bash store/agent-key-provision.sh cybersec2 --rotate", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        # self resolved from cwd when the env var is absent
        (BLOCK, "cat agents/qa/.dashboard-agent-key", "/home/neon/marveen/agents/backend", {}),
        # ---- self acting on ITS OWN key: ALLOW -----------------------------------------------
        (ALLOW, "cat agents/backend/.dashboard-agent-key", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (ALLOW, "npm run dashboard-user -- agent-key:mint backend", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (ALLOW, "bash store/agent-key-provision.sh backend --rotate", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        # ---- self cannot be determined (no env, cwd gives no clue): fail OPEN (operator path) --
        (ALLOW, "cat agents/qa/.dashboard-agent-key", "/home/neon/marveen", {}),
        (ALLOW, "npm run dashboard-user -- agent-key:mint qa", "/tmp", {}),
        # ---- the explicit, deliberate escape hatch -------------------------------------------
        (ALLOW, "MARVEEN_ALLOW_AGENT_KEY=1 cat agents/qa/.dashboard-agent-key", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        # ---- unrelated commands ---------------------------------------------------------------
        (ALLOW, "grep -rn agent-key src/db.ts", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (ALLOW, "ls agents/", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
        (ALLOW, "echo 'do not mint agent-key:mint for qa'", "/home/neon/marveen", {"MARVEEN_AGENT_ID": "backend"}),
    ]

    failures = []
    for expected, cmd, cwd, env in cases:
        got, msg = verdict(cmd, cwd, env)
        ok = got == expected
        if not ok:
            failures.append((cmd, cwd, expected, got, msg))
        print(f"  [{'ok ' if ok else 'FAIL'}] {expected:5} {cmd!r} (cwd={cwd}, env={env})")

    print()
    if failures:
        print(f"{len(failures)} FAILED:")
        for cmd, cwd, exp, got, msg in failures:
            print(f"  - {cmd!r} (cwd={cwd}): expected {exp}, got {got}. stderr={msg[:160]}")
        return 1
    print(f"All {len(cases)} cases pass.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
