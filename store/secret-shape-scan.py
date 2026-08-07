#!/usr/bin/env python3
"""Shape-based secret pre-filter for the repomix pack path (card 2f781b49).

WHY THIS EXISTS. repomix's bundled Security Check (secretlint preset-recommend) covers AWS by
KEYWORD ANCHOR, not by shape, and Cybersec measured two consequences on the pinned 1.18.0:

  * an AWS ACCESS KEY ID is never detected -- not bare, and not even named
    (`aws_access_key_id = <key>`); the preset's AWS anchor only ever fires on the SECRET key;
  * the secret-key rule itself ends in `\\b`, while its 40-char class contains `/`, `+` and `=`.
    A secret whose LAST character is one of those has no word boundary after it, so it silently
    passes. Measured with five files differing only in the final character: the ones ending in a
    letter or a digit were caught, the `/`, `+` and `=` ones were not. For AWS-generated secrets
    that is a ~3% silent miss (2/64), not a chosen bypass -- you do not pick your own key.

So a clean repomix Security Check says something about DEFAULTS; it is not evidence that a tree
carries no AWS credential. This module closes the shape half, and `store/repomix.sh` runs it
BEFORE handing the tree to repomix.

DELIBERATELY NARROW SUPPRESSION. The fleet's own `scripts/hooks/secret-write-guard.py` skips a
match when a placeholder word appears within +-20 characters of it. Cybersec measured that this is
switchable FROM CONTENT: a real key followed by `// <div>`, `# not an EXAMPLE` or `# ...` is let
through, while the same key with the same marker 60 characters away is blocked. That is tolerable
for a guard on OUR OWN writes; it is NOT tolerable here, because this path scans THIRD-PARTY trees
whose text we do not write -- and `<[^>]+>` alone would be triggered by any nearby JSX/HTML tag.
Here a match is skipped only when the MATCHED SPAN ITSELF is a documented example value.

SCOPE MUST MATCH THE PACK. A pre-filter is only sound if it sees what repomix sees. Measured:
repomix skips binary files and does not follow symlinked directories. This scanner skips in the
SAME direction (skip, never scan-and-miss), so the two blind spots coincide rather than diverge.
If repomix ever starts packing binaries or following symlinks, this alignment breaks and the
comment above is where to start.

NOT the write-guard's patterns by import: the write-guard is a governance hook that constrains
Cybersec's own writes, so Cybersec does not edit it. The patterns are duplicated here ON PURPOSE
for now, and migrating the hook to import from this module is a separate card for another author.

Usage:  secret-shape-scan.py <path>      # exit 0 = clean, 4 = findings (listed on stderr)
"""
from __future__ import annotations

import os
import re
import sys

# --- patterns -----------------------------------------------------------------------------------
# Shape-based: they do not depend on a nearby keyword, which is exactly the property the repomix
# preset lacks for AWS. The AWS id prefix list is the full documented set, not just AKIA/ASIA.
AWS_ID_PREFIXES = "AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|APKA|A3T"

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("AWS access key id", re.compile(r"\b(?:" + AWS_ID_PREFIXES + r")[0-9A-Z]{16}\b")),
    # The secret key stays keyword-anchored (40 base64 chars alone is too generic to assert on),
    # but the terminator is an explicit boundary set instead of `\b` -- that single character is
    # what the preset gets wrong, so re-using `\b` here would reproduce the bug we are fixing.
    (
        "AWS secret access key",
        re.compile(
            r"(?i)aws[_\-.]?secret[_\-.]?access[_\-.]?key\W{0,4}[\"']?([A-Za-z0-9/+=]{40})(?=[\"'\s,;)\]}]|$)"
        ),
    ),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("OpenAI API key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{40,}")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}")),
    ("Slack token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Stripe live secret key", re.compile(r"\bsk_live_[0-9A-Za-z]{24,}")),
]

# Exact, documented example values only -- NOT a proximity window. Anything added here must be a
# value a vendor publishes as an example, so that allowing it leaks nothing real.
EXAMPLE_VALUES = frozenset(
    {
        "AKIAIOSFODNN7" + "EXAMPLE",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY",
    }
)

SKIP_DIRS = {".git", "node_modules"}
_READ_CAP = 4 * 1024 * 1024


def _is_binary(path: str) -> bool:
    """Match repomix's own exclusion: a NUL byte in the head means binary, so skip it."""
    try:
        with open(path, "rb") as fh:
            return b"\0" in fh.read(8192)
    except OSError:
        return True


def scan_tree(root: str) -> list[tuple[str, str, str]]:
    """Return [(relative path, pattern name, matched span)] for every shape hit."""
    findings: list[tuple[str, str, str]] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [
            d for d in dirnames if d not in SKIP_DIRS and not os.path.islink(os.path.join(dirpath, d))
        ]
        for name in filenames:
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or _is_binary(full):
                continue
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read(_READ_CAP)
            except OSError:
                continue
            for label, rx in PATTERNS:
                for m in rx.finditer(text):
                    span = m.group(1) if m.groups() else m.group(0)
                    if span in EXAMPLE_VALUES:
                        continue
                    findings.append((os.path.relpath(full, root), label, span))
                    break  # one hit per pattern per file is enough to refuse
    return findings


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: secret-shape-scan.py <path>\n")
        return 2
    root = argv[1]
    if not os.path.isdir(root):
        sys.stderr.write(f"secret-shape-scan.py: not a directory: {root}\n")
        return 2
    findings = scan_tree(root)
    if not findings:
        return 0
    sys.stderr.write(
        "secret-shape-scan.py: REFUSED -- shape-based scan found credential-shaped content that\n"
        "repomix's keyword-anchored Security Check would NOT have caught:\n"
    )
    for rel, label, span in findings:
        # Never echo the value: a refusal message that prints the secret defeats its own purpose.
        sys.stderr.write(f"  {rel}: {label} ({len(span)} chars, not shown)\n")
    return 4


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
