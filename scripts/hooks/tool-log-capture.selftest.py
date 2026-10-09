#!/usr/bin/env python3
"""Selftest for tool-log-capture.py's _redact(). Card 35dc6dbe (upstream TOOLLOGREDACT924,
4811efcb): the redact regex let quoted, spaced-flag, *_KEY-suffixed, Basic-scheme, bare-JWT and
URL-embedded secrets through into tool_call_log unredacted. Each CASE below is one measured gap,
with the input left over from the measurement that found it, and the exact expected output."""
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("tlc", os.path.join(_HERE, "tool-log-capture.py"))
tlc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tlc)

CASES = [
    ('password="supersecretvalue123"', 'password="[REDACTED]"',
     "a double-quoted value stopped the old unquoted-only pattern at the opening quote"),
    ("password='supersecretvalue123'", "password='[REDACTED]'",
     "same gap, single-quoted"),
    ("MY_SECRET_KEY=abcdef1234567890", "MY_SECRET_KEY=[REDACTED]",
     "a *_KEY/*_SECRET/*_TOKEN/*_PASSWORD env-var-style NAME, not a standalone label word"),
    ("DB_PASSWORD: hunter2value", "DB_PASSWORD: [REDACTED]",
     "same *_-suffix class, colon separator"),
    ("curl https://user:supersecretpass@example.com/path",
     "curl https://user:[REDACTED]@example.com/path",
     "a URL-embedded password -- the username and @ stay so the shape is still legible"),
    ("curl --password supersecretvalue123 https://x", "curl --password [REDACTED] https://x",
     "a CLI flag whose value is SPACE-separated, no = or : at all"),
    ("mysql -u root --password mysecretpass123", "mysql -u root --password [REDACTED]",
     "same spaced-flag shape, a different command"),
    ('curl --password "quoted secret value" https://x',
     'curl --password "[REDACTED]" https://x',
     "spaced-flag AND quoted together"),
    ("Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: Basic [REDACTED]",
     "Basic scheme was never in the bearer-only pattern"),
    ("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123.xyz789sig",
     "Authorization: Bearer [REDACTED]",
     "bearer still works after the pattern was generalised to bearer|basic"),
    ("a bare jwt eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrstuv floating around",
     "a bare jwt [REDACTED] floating around",
     "a JWT shape with NO label/header in front of it at all"),
    ("token  :  abcdef1234567890", "token  :  [REDACTED]",
     "pre-existing case: extra whitespace around the separator"),
    ("api_key = my-long-secret-value", "api_key = [REDACTED]",
     "pre-existing case: api_key with spaces around ="),
    ("this auth is broken today", "this auth is broken today",
     "CONTROL: plain prose containing a label word must NOT be redacted -- the spaced-flag "
     "pattern is scoped to a -/-- flag spelling for exactly this reason"),
    ("ssh user@host 'echo hello'", "ssh user@host 'echo hello'",
     "CONTROL: an ordinary user@host with no credential shape stays untouched"),
    ("curl -s http://localhost:3420/api/kanban", "curl -s http://localhost:3420/api/kanban",
     "CONTROL: the fleet's own internal localhost idiom is not touched"),
]


def main():
    failed = []
    for raw, expected, why in CASES:
        got = tlc._redact(raw)
        status = "OK" if got == expected else "FAIL"
        print(f"{status} {raw!r} -> {got!r}  ({why})")
        if status == "FAIL":
            failed.append((raw, expected, got))
    print()
    if failed:
        print(f"{len(failed)} FAILED")
        for raw, expected, got in failed:
            print(f"  {raw!r}: expected {expected!r}, got {got!r}")
        sys.exit(1)
    print(f"All {len(CASES)} cases passed.")


if __name__ == "__main__":
    main()
