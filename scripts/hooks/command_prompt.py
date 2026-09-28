"""Is this UserPromptSubmit prompt an owner slash command from Telegram?

One definition for every hook that must agree on it. marveen-commands.py
blocks such a prompt (exit 2) when the dashboard answers it, so the model
never sees that turn. The hooks running ALONGSIDE it must not consume state
into it: inbox-drain.py marked an inter-agent message "delivered" and printed
it into a prompt the command hook then blocked, and the message was gone
(measured on the test bot, 2026-09-23: a custom /osszefoglalo prompt, agent
message #10, never reached the model). A drain skips these prompts; the next
prompt, or the inbox nudge watcher, delivers.
"""
import re

CHANNEL_RX = re.compile(r'<channel\s+([^>]*)>(.*?)</channel>', re.DOTALL)
COMMAND_RX = re.compile(r'^/([A-Za-z][A-Za-z0-9_]{0,31})(?:@[A-Za-z0-9_]+)?(?:\s|$)')
TELEGRAM_SOURCE_RX = re.compile(r'\bsource="[^"]*telegram[^"]*"', re.IGNORECASE)


def attr(attrs, name):
    m = re.search(r'\b' + name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def command_block(prompt):
    """(attrs, body) when the prompt is exactly one Telegram <channel> block
    whose body is a single-line /word command with a chat_id; else None.

    "Exactly one block" used to mean only count(matches) == 1 -- which a
    prompt that QUOTES a channel block inside surrounding text (an
    inter-agent message, a REVIEW comment) also satisfies. That let anyone
    who could get text into an agent's prompt forge the owner's chat_id and
    trigger a command, with the whole turn silently swallowed by the hook's
    exit 2 (Cybersec NO-GO, card d79a69b5, M1). The block must now span the
    ENTIRE (whitespace-trimmed) prompt, not just appear somewhere in it.
    """
    stripped = (prompt or "").strip()
    matches = list(CHANNEL_RX.finditer(stripped))
    if len(matches) != 1:
        return None
    m = matches[0]
    if m.start() != 0 or m.end() != len(stripped):
        return None
    attrs, body = m.group(1), m.group(2).strip()
    if not COMMAND_RX.match(body) or "\n" in body:
        return None
    if not TELEGRAM_SOURCE_RX.search(attrs):
        return None
    if not attr(attrs, "chat_id"):
        return None
    return attrs, body
