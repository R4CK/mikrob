#!/usr/bin/env python3
"""PreToolUse hook: block writing a LITERAL secret value into a file.

An agent that pastes a real credential into source (a leaked private key, an AWS
access key, an Anthropic/OpenAI/GitHub/Slack token) is one `git add` away from
committing it. This guard inspects the CONTENT an agent is about to Write/Edit and
blocks (exit 2) only on a HIGH-CONFIDENCE literal secret -- a key block or a
provider token with an unmistakable prefix. It is deliberately narrow:

  - It matches secret VALUES, never references. `cat store/.dashboard-token`,
    `Bearer $(...)`, `process.env.X`, a `.env.example` placeholder -> NOT a match.
  - Anything it cannot parse -> FAIL-OPEN (exit 0). A guard that crashes must
    never wedge the fleet, so every error path allows the write.

Only Write / Edit / MultiEdit carry file content; other tools are ignored. On a
match it prints the offending pattern name to stderr (shown to the agent) and
exits 2 so the write is denied and the agent can route the secret to a real
secret store or reference it by env/id instead.
"""
import sys
import os
import re
import json

# High-confidence literal-secret signatures. Each is specific enough that a match
# is almost never a false positive. Order/name is what the agent sees on block.
PATTERNS = [
    ("private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("AWS access key id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("OpenAI API key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{40,}")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}")),
    ("Slack token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Stripe live secret key", re.compile(r"\bsk_live_[0-9A-Za-z]{24,}")),
]

# Placeholder / example values that legitimately look secret-ish.
#
# THIS IS DELIBERATELY NARROW (card 746ea4e4). The previous version searched a +-20 character WINDOW
# around the match, so anything nearby could wave a REAL key through: Cybersec measured a bare key
# blocked, the same key ALLOWED once "EXAMPLE" or even a `<div>` sat within 20 characters, and blocked
# again at 60. `<[^>]+>` was the worst of it -- in any TSX/HTML file a tag within 20 characters of a
# string is ordinary, so this leaked by ACCIDENT, not only by someone gaming it.
#
# That is the same shape as a secret scanner that lets the scanned CONTENT switch the control off.
# The rule now looks ONLY at the matched span itself, two ways:
#
#   1. the span is an exact, published example value (vendors mint these precisely so docs can show
#      a key without it being one), or
#   2. the span CONTAINS a placeholder marker -- `AKIAXXXXXXXXXXXXXXXX` is self-evidently not a key.
#
# Neighbouring text no longer votes. A real key next to the word EXAMPLE is now blocked, which is
# the point: the only thing that can prove a key is fake is the key.

# Exact published example values, compared case-insensitively against the whole matched span.
KNOWN_EXAMPLE_SECRETS = frozenset(
    v.lower()
    for v in (
        # AWS's own documentation keys (IAM user guide / CLI docs).
        "AKIAIOSFODNN7EXAMPLE",
        "ASIAIOSFODNN7EXAMPLE",
        "AKIAI44QH8DHBEXAMPLE",
    )
)

# Filler markers that must appear INSIDE the matched secret, not merely near it. Deliberately only
# the self-evident ones: a span containing XXXX or PLACEHOLDER or YOUR_ is nobody's live credential.
#
# EXAMPLE is NOT here, even though vendors put it in their published keys -- those go through the
# exact list above instead. A mutation showed why: with EXAMPLE as an in-span marker, deleting the
# whole KNOWN_EXAMPLE_SECRETS list changed nothing and every test still passed, i.e. the list was
# dead code pretending to be a control. Keeping the precise rule precise makes it load-bearing, and
# "EXAMPLE appears somewhere in these 20 characters" is the loosest of the markers anyway.
PLACEHOLDER_IN_SPAN_RX = re.compile(r"(?:XXXX|PLACEHOLDER|YOUR[_-]?)", re.IGNORECASE)


def _is_placeholder(span):
    """True only if the SPAN itself proves it is not a live credential."""
    return span.lower() in KNOWN_EXAMPLE_SECRETS or bool(PLACEHOLDER_IN_SPAN_RX.search(span))


def _content_from(tool_name, tool_input):
    """Extract the text this tool would write into a file, or '' if none."""
    if not isinstance(tool_input, dict):
        return ""
    parts = []
    # Write
    if isinstance(tool_input.get("content"), str):
        parts.append(tool_input["content"])
    # Edit: the replacement is what lands on disk
    if isinstance(tool_input.get("new_string"), str):
        parts.append(tool_input["new_string"])
    # MultiEdit
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        for e in edits:
            if isinstance(e, dict) and isinstance(e.get("new_string"), str):
                parts.append(e["new_string"])
    return "\n".join(parts)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unparseable -> fail open

    tool = payload.get("tool_name") or ""
    if tool not in ("Write", "Edit", "MultiEdit"):
        sys.exit(0)

    try:
        content = _content_from(tool, payload.get("tool_input"))
    except Exception:
        sys.exit(0)
    if not content:
        sys.exit(0)

    for name, rx in PATTERNS:
        # EVERY match, not just the first (card 57112049). rx.search() stopped at match #1, so a
        # decoy placeholder placed ABOVE a real key meant the real key was never examined and the
        # write went through -- Cybersec reproduced it 3/3. The pattern only clears if ALL of its
        # matches are placeholders; one real key among them blocks.
        matches = [m.group(0) for m in rx.finditer(content)]
        if not matches:
            continue
        real = [s for s in matches if not _is_placeholder(s)]
        # Each span judged on itself -- surrounding text cannot vouch for it (card 746ea4e4).
        if not real:
            continue
        span = real[0]
        sys.stderr.write(
            "SECRET-WRITE-GUARD: a beirni kivant tartalom valodinak tuno titkot "
            f"tartalmaz ({name}). A muvelet blokkolva. Ne irj literal kredencialt "
            "fajlba: hasznalj kornyezeti valtozot / secret store-t, vagy hivatkozz "
            "id-vel (pl. $(cat store/.dashboard-token)). Ha ez szandekos teszt-adat, "
            "tedd .env.example-be placeholderrel."
        )
        sys.exit(2)  # block

    sys.exit(0)


if __name__ == "__main__":
    main()
