#!/usr/bin/env python3
"""Self-test for noisy-command-guard.py.

Run:  python3 scripts/hooks/noisy-command-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.
"""
import json
import subprocess
import sys
from pathlib import Path

GUARD = Path(__file__).with_name("noisy-command-guard.py")

BLOCK = "block"
ALLOW = "allow"


def verdict(cmd):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    p = subprocess.run([sys.executable, str(GUARD)], input=payload, capture_output=True, text=True)
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


CASES = [
    # (command, expected, why)
    ("npm install", BLOCK, "raw install"),
    ("npm ci", BLOCK, "raw ci"),
    ("npm run build", BLOCK, "raw build"),
    ("npm test", BLOCK, "raw test"),
    ("pnpm install", BLOCK, "pnpm install"),
    ("yarn add left-pad", BLOCK, "yarn add"),
    ("npx vitest run", BLOCK, "vitest via npx"),
    ("go build ./...", BLOCK, "go build"),
    ("go test ./...", BLOCK, "go test"),
    ("cargo build --release", BLOCK, "cargo build"),
    ("pytest tests/", BLOCK, "pytest"),
    ("docker build -t x .", BLOCK, "docker build"),
    ("docker compose up -d", BLOCK, "docker compose up"),
    ("apt-get install -y curl", BLOCK, "apt-get install"),
    ("pip install requests", BLOCK, "pip install"),
    ("tsc", BLOCK, "raw tsc"),
    ("tsc --noEmit", ALLOW, "type-check only, not noisy"),
    ("npm run lint", ALLOW, "not build/test"),
    ("npm ls", ALLOW, "not mutating/noisy"),
    ("git status", ALLOW, "unrelated short command"),
    ("ls -la", ALLOW, "unrelated short command"),
    ("echo hello", ALLOW, "trivial"),
    ("NOISY_RUN_ALLOW_RAW=1 npm install", ALLOW, "explicit escape hatch"),
    ("bash /home/neon/marveen/scripts/noisy-run.sh npm install", ALLOW,
     "already routed through the filter, do not re-block"),
]


def main():
    failures = []
    for cmd, expected, why in CASES:
        got, stderr = verdict(cmd)
        ok = got == expected
        print(f"{'OK  ' if ok else 'FAIL'} {expected:5s} <- {got:5s}  {cmd!r}  ({why})")
        if not ok:
            failures.append((cmd, expected, got, stderr))

    if failures:
        print(f"\n{len(failures)}/{len(CASES)} FAILED")
        for cmd, expected, got, stderr in failures:
            print(f"  {cmd!r}: expected {expected}, got {got}\n    stderr: {stderr[:200]}")
        sys.exit(1)

    print(f"\nAll {len(CASES)} cases passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
