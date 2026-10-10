#!/usr/bin/env python3
"""Self-test for noisy-command-guard.py.

Run:  python3 scripts/hooks/noisy-command-guard.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.
"""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

GUARD = Path(__file__).with_name("noisy-command-guard.py")

_spec = importlib.util.spec_from_file_location("noisy_command_guard", GUARD)
_guard_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_guard_mod)

BLOCK = "block"
ALLOW = "allow"


def verdict(cmd):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    p = subprocess.run([sys.executable, str(GUARD)], input=payload, capture_output=True, text=True)
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


def run_with_mode(cmd, mode=None):
    """Runs the guard like verdict(), but under NOISY_GUARD_MODE, returning (returncode, stdout, stderr)."""
    env = dict(os.environ)
    if mode is None:
        env.pop("NOISY_GUARD_MODE", None)
    else:
        env["NOISY_GUARD_MODE"] = mode
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    p = subprocess.run([sys.executable, str(GUARD)], input=payload, capture_output=True, text=True, env=env)
    return p.returncode, p.stdout, p.stderr


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
    # rtk (card f5fc0227 pilot) sits in the same wrapper position as sudo/time -- QA measured
    # (comment 4259) that `rtk npm test` ran a full unbounded vitest suite past this guard, with
    # no warning, because the old _CMD only recognized sudo/time as prefixes.
    ("rtk npm test", BLOCK, "rtk-wrapped raw test must still be caught (card f5fc0227, QA 4259)"),
    ("rtk cargo test", BLOCK, "rtk-wrapped cargo test"),
    ("rtk pytest tests/", BLOCK, "rtk-wrapped pytest"),
    ("rtk npm ls", ALLOW, "rtk-wrapped, but the underlying command is not noisy"),
]


# card fc3a6a39: NOISY_GUARD_MODE=rewrite must never touch a command going through the suite
# semaphore (mopsion-suite-run.sh/cleancore-suite-run.sh), in either mode -- proof, not just
# "the regex list doesn't mention it" reasoning (plan-grilling point 3d/9).
SUITE_SEMAPHORE_CASES = [
    "bash store/mopsion-suite-run.sh backend2",
    "bash store/cleancore-suite-run.sh backend2 -- src/foo.test.ts",
]


def check_rewrite_mode():
    """Returns a list of failure strings (empty = all passed)."""
    failures = []

    # (a) default mode (env unset) is byte-identical to today's block behavior -- additive, not a
    # regression (plan-grilling point 7a).
    for cmd, expected, why in CASES:
        rc_default, _out_default, err_default = run_with_mode(cmd, mode=None)
        rc_block, _out_block, err_block = run_with_mode(cmd, mode="block")
        if (rc_default, err_default) != (rc_block, err_block):
            failures.append(f"default mode != explicit block mode for {cmd!r} ({why})")

    # (b) rewrite mode: a noisy command gets permissionDecision=allow + updatedInput.command
    # wrapped through noisy-run.sh, exit 0, no stderr block.
    rc, out, err = run_with_mode("npm install", mode="rewrite")
    if rc != 0:
        failures.append(f"rewrite mode exited {rc} (expected 0) for 'npm install', stderr={err[:200]!r}")
    else:
        try:
            payload = json.loads(out)
        except json.JSONDecodeError:
            failures.append(f"rewrite mode stdout is not valid JSON: {out[:200]!r}")
        else:
            hso = payload.get("hookSpecificOutput", {})
            if hso.get("permissionDecision") != "allow":
                failures.append(f"rewrite mode permissionDecision != allow: {hso!r}")
            updated = hso.get("updatedInput", {})
            if "noisy-run.sh" not in (updated.get("command") or ""):
                failures.append(f"rewrite mode updatedInput.command does not route through noisy-run.sh: {updated!r}")
            if updated.get("command") == "npm install":
                failures.append("rewrite mode updatedInput.command is unchanged -- not actually rewritten")

    # (c) rewrite mode on a non-noisy command: still allow, but no rewrite (no stdout JSON) --
    # mirrors today's silent-allow for unrelated commands.
    rc, out, err = run_with_mode("git status", mode="rewrite")
    if rc != 0 or out.strip():
        failures.append(f"rewrite mode on non-noisy command should be silent allow, got rc={rc} out={out[:200]!r}")

    # (d) suite-semaphore commands are NEVER rewritten/blocked, in either mode.
    for cmd in SUITE_SEMAPHORE_CASES:
        for mode in (None, "block", "rewrite"):
            rc, out, err = run_with_mode(cmd, mode=mode)
            if rc != 0 or out.strip() or err.strip():
                failures.append(
                    f"suite-semaphore command {cmd!r} was touched under mode={mode!r} "
                    f"(rc={rc}, out={out[:120]!r}, err={err[:120]!r})"
                )

    return failures


def check_rewrite_quoting_roundtrip():
    """Execution-level check (not just string-shape) that _suggest()'s escaping for commands with
    shell metacharacters reproduces the ORIGINAL command's real behavior when the wrapped form is
    actually run through bash -- plan-grilling point 7c/9 (the single most-likely failure: a wrong
    escape changes what the agent's command actually DOES, which is worse than today's
    block-and-suggest, where the agent retypes the command itself)."""
    adversarial = [
        "echo it's fine; echo done",
        "echo `date +ok`; true",
        "echo $(whoami); echo ok",
        "printf 'a\\nb\\n'; echo tail",
    ]
    prefix = "bash /tmp/irrelevant-noisy-guard-test/noisy-run.sh "
    failures = []
    for raw in adversarial:
        wrapped = _guard_mod._suggest("/tmp/irrelevant-noisy-guard-test", raw)
        if not wrapped.startswith(prefix):
            failures.append(f"{raw!r}: _suggest did not take the metachar/bash-c branch: {wrapped!r}")
            continue
        inner = wrapped[len(prefix):]  # "bash -c '<escaped-raw>'"
        direct = subprocess.run(["bash", "-c", raw], capture_output=True, text=True).stdout
        roundtrip = subprocess.run(["bash", "-c", inner], capture_output=True, text=True).stdout
        if direct != roundtrip:
            failures.append(f"{raw!r}: round-trip mismatch -- direct={direct!r} roundtrip={roundtrip!r}")
    return failures


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

    rewrite_failures = check_rewrite_mode()
    for f in rewrite_failures:
        print(f"FAIL (rewrite-mode) {f}")
    if not rewrite_failures:
        print("OK   rewrite-mode: default==block, JSON shape, non-noisy silent-allow, suite-semaphore untouched")

    roundtrip_failures = check_rewrite_quoting_roundtrip()
    for f in roundtrip_failures:
        print(f"FAIL (quoting-roundtrip) {f}")
    if not roundtrip_failures:
        print("OK   rewrite-mode quoting round-trip (execution-level, 4 adversarial commands)")

    all_failures = rewrite_failures + roundtrip_failures
    if all_failures:
        print(f"\n{len(all_failures)} rewrite-mode/round-trip FAILURES (plus {len(failures)} base-case failures)")
        sys.exit(1)

    print(f"\nAll {len(CASES)} base cases + rewrite-mode + quoting round-trip checks passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
