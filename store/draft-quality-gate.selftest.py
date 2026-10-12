#!/usr/bin/env python3
"""Unit tests for draft-quality-gate.py (card d39fc5e7, requirement 2). No network, no model call --
imports the module's pure `check()` function directly, plus one end-to-end stdin/stdout pass to pin
the CLI contract real callers (offload-dispatch.sh) depend on.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "draft-quality-gate.py")

spec = importlib.util.spec_from_file_location("draft_quality_gate", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

PASS = 0
FAIL = 0


def check_eq(desc, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL: {desc}\n  want: {want!r}\n  got:  {got!r}")


# --- too-short -------------------------------------------------------------------------------
check_eq(
    "a one-liner shorter than the floor fails as too-short",
    mod.check("ok", "write a test for parseWindow", "") is not None
    and "too-short" in mod.check("ok", "write a test for parseWindow", ""),
    True,
)

# --- repeats-card-text ------------------------------------------------------------------------
task = "Write the unit test scaffolding for the parseWindow helper, covering the default-window branch."
echo_draft = task  # the measured failure mode: the draft is the card text verbatim
reason = mod.check(echo_draft, task, "")
check_eq("a draft that is the card text verbatim fails as repeats-card-text", reason is not None and "repeats-card-text" in reason, True)

real_draft = """```ts
import { describe, it, expect } from 'vitest'
import { parseWindow } from './parseWindow'

describe('parseWindow', () => {
  it('returns the default window when no args are given', () => {
    expect(parseWindow()).toEqual({ start: 0, end: 24 })
  })
})
```"""
check_eq("a real, sufficiently-long, non-repeating draft with no repo check passes", mod.check(real_draft, task, ""), None)

# --- import-check: relative import that does not exist in the repo ----------------------------
with tempfile.TemporaryDirectory() as repo:
    os.makedirs(os.path.join(repo, "src"))
    with open(os.path.join(repo, "src", "parseWindow.ts"), "w") as f:
        f.write("export function parseWindow() { return { start: 0, end: 24 } }\n")
    os.makedirs(os.path.join(repo, "node_modules", "vitest"))

    draft_bad_relative = """```ts
import { describe, it, expect } from 'vitest'
import { parseWindow } from './doesNotExist'

describe('x', () => { it('y', () => { expect(1).toBe(1) }) })
```"""
    reason = mod.check(draft_bad_relative, task, repo)
    check_eq(
        "a relative import to a file that does not exist in the repo fails import-check",
        reason is not None and "does not resolve" in reason,
        True,
    )

    draft_good_relative = """```ts
import { describe, it, expect } from 'vitest'
import { parseWindow } from './parseWindow'

describe('x', () => { it('y', () => { expect(parseWindow()).toBeDefined() }) })
```"""
    check_eq(
        "a relative import to a file that DOES exist anywhere in the repo passes import-check",
        mod.check(draft_good_relative, task, repo),
        None,
    )

    # --- import-check: bare package not in node_modules ------------------------------------
    draft_missing_pkg = """```ts
import request from 'supertest'
const r = request('app')
```"""
    reason = mod.check(draft_missing_pkg, task, repo)
    check_eq(
        "a bare import for a package absent from node_modules fails import-check (measured baseline (a): Express/supertest on a repo that uses raw handlers)",
        reason is not None and "not present in node_modules" in reason,
        True,
    )

    draft_present_pkg = """```ts
import { describe } from 'vitest'
describe('x', () => {})
```"""
    check_eq(
        "a bare import for a package present in node_modules passes import-check",
        mod.check(draft_present_pkg, task, repo),
        None,
    )

    # --- missing/unreadable repo skips the import-check, not a FAIL -------------------------
    check_eq(
        "an unreadable repo path skips the import-check entirely (best-effort, not a failure)",
        mod.check(draft_missing_pkg, task, "/no/such/repo/path"),
        None,
    )

# --- check_secret_leak: key=value, JSON-form, Bearer header, URL credentials ---------------
# These tests go RED when check_secret_leak is removed (mutation-testable, B3 fix d39fc5e7).
check_eq("check_secret_leak: JS key=value is rejected",
    mod.check_secret_leak('const apiKey = "zzzfixture-not-a-real-key-value-xxxxxxxxxxxxxxxx"'), "secret-shaped value in draft (key-name + long opaque string)")
check_eq("check_secret_leak: JSON key: value form is rejected",
    mod.check_secret_leak('  "apiKey": "zzzfixture-json-key-value-xxxxxxxxxxxxxxxxxxxxxxxx"'), "secret-shaped value in draft (key-name + long opaque string)")
check_eq("check_secret_leak: Authorization: Bearer header is rejected",
    mod.check_secret_leak("  const h = 'Authorization: Bearer zzzfixture-bearer-token-xxxxxxxxxxxxxxxx'"), "secret-shaped value in draft (Authorization header or URL with credentials)")
check_eq("check_secret_leak: key=value in a comment is still rejected (B3 fix)",
    mod.check_secret_leak('// apiKey = "zzzfixture-not-a-real-key-value-xxxxxxxxxxxxxxxx"'), "secret-shaped value in draft (key-name + long opaque string)")
check_eq("check_secret_leak: Bearer in a comment is allowed (documentation example)",
    mod.check_secret_leak('// Authorization: Bearer zzzfixture-bearer-token-xxxxxxxxxxxxxxxx'), None)
check_eq("check_secret_leak: clean code returns None",
    mod.check_secret_leak('export function foo() { return 42; }'), None)

# --- builtins never require a repo lookup -------------------------------------------------
draft_builtin = """```ts
import fs from 'node:fs'
import path from 'path'
const x = fs.existsSync(path.join('.', 'x'))
```"""
check_eq("Node builtins (bare and node: prefixed) never fail import-check even with no repo", mod.check(draft_builtin, task, ""), None)

# --- CLI contract: stdin JSON in, "OK"/"FAIL\\t<reason>" out, matching exit code -------------
proc = subprocess.run(
    [sys.executable, SCRIPT],
    input=json.dumps({"draft": real_draft, "task": task, "repo": ""}),
    capture_output=True,
    text=True,
)
check_eq("CLI: a passing draft prints OK on stdout", proc.stdout.strip(), "OK")
check_eq("CLI: a passing draft exits 0", proc.returncode, 0)

proc2 = subprocess.run(
    [sys.executable, SCRIPT],
    input=json.dumps({"draft": "x", "task": task, "repo": ""}),
    capture_output=True,
    text=True,
)
check_eq("CLI: a failing draft's stdout starts with FAIL\\t", proc2.stdout.startswith("FAIL\t"), True)
check_eq("CLI: a failing draft exits 1", proc2.returncode, 1)

proc3 = subprocess.run([sys.executable, SCRIPT], input="not json", capture_output=True, text=True)
check_eq("CLI: unparseable stdin is a FAIL, not a crash", proc3.returncode, 1)

print()
print(f"draft-quality-gate.selftest: {PASS} passed, {FAIL} failed")
sys.exit(0 if FAIL == 0 else 1)
