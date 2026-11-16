#!/usr/bin/env python3
"""PreToolUse hook: steer noisy commands (installs/builds/test runs/progress-bar tools) through
scripts/noisy-run.sh instead of letting the raw transcript land in an agent's context verbatim.

Peti request (2026-08-23, Telegram image "ASK FOR THE HOOK"): catch install/build/test/anything
with a progress bar, keep only errors/failures/the final summary, leave everything else -- short
commands included -- completely alone.

REWRITE MODE (card fc3a6a39, 2026-10-10)
Earlier revisions of this file claimed the PreToolUse hook schema has no way to substitute a
different command string. That claim was stale: the current hooks docs (code.claude.com/docs/en/hooks)
document `hookSpecificOutput.updatedInput`, which DOES replace the executed input -- verified live
before building this, not from memory. `NOISY_GUARD_MODE=rewrite` (default stays `block`, the
original behavior) makes the hook transparently substitute the wrapped `noisy-run.sh` invocation via
`updatedInput` instead of blocking: the agent's original Bash call just runs filtered, no extra
block/retry round-trip. `updatedInput` replaces the WHOLE tool_input object, so every other field
(not just `command`) is carried through unchanged. `permissionDecision` is NEVER set by this hook
(card ff43b10e, RedHat NO-GO) -- the rewrite only changes WHAT runs, never whether it is allowed to
run; the normal permission flow, including any deny rule, still evaluates the result on its own.
Rewrite ONLY fires when the command's first word is the noisy program itself: any leading wrapper
(sudo/doas/pkexec/su -c, time, rtk) or `VAR=val` prefix or shell metacharacter falls back to
block-and-suggest instead, unchanged from today's behavior, so a deny rule anchored on the real
program name always sees the command the agent actually typed.

WHAT COUNTS AS NOISY
npm/pnpm/yarn install|ci|add|update and `npm run build`; test runners (npx vitest/jest/playwright,
`npm test`, `go test`, `cargo test`, `pytest`, `mvn test`); builds (`go build`, `cargo build`, `tsc`
without --noEmit, webpack/vite build, `docker build`, `docker compose up`); package managers
(`apt-get install`, `pip install`). Anything NOT on this list is left alone regardless of length --
this guard does not guess from output length, only from the command shape, per Peti's "if a command
is short, I still want the whole thing."

ESCAPE HATCHES
- Already wrapped through noisy-run.sh: skipped (avoids an infinite block loop).
- `NOISY_RUN_ALLOW_RAW=1 <cmd>`: explicit, greppable, one-off bypass for when the agent genuinely
  needs the raw interleaved output (e.g. debugging why a build hangs).

WHAT THIS IS NOT. Like its siblings, a regex over the command STRING: a seatbelt, not a security
boundary. Any guard error FAILS OPEN.
"""
import json
import os
import re
import sys

ALLOW_ENV = "NOISY_RUN_ALLOW_RAW"
MODE_ENV = "NOISY_GUARD_MODE"

_ENV_PREFIX = r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)*"
# `rtk` (card f5fc0227 pilot) sits in the SAME wrapper position as sudo/time: `rtk npm test` is still
# npm test underneath, just proxied through rtk's own output filter -- and rtk's filter is a SEPARATE
# concern from the noisy-run.sh + CPU semaphore this guard exists to route through (rule 17). Measured
# by QA (comment 4259, gate on f5fc0227): `rtk npm test` ran a full unbounded vitest suite on the
# shared repo, past this guard, with no warning -- the old `_CMD` only recognized sudo/time as
# wrapper prefixes, so the npm/test pattern below never got a chance to match past the leading `rtk `.
_CMD = r"(?:^|[\n;&|(])\s*" + _ENV_PREFIX + r"(?:sudo\s+)?(?:time\s+)?(?:rtk\s+)?"

_MUTATING_NPM = r"(?:ci|install|i|add|update|up|upgrade|dedupe|rebuild)"
NOISY_PATTERNS = [
    re.compile(_CMD + r"(?:npm|pnpm|yarn)\s+(?:[-\w]+\s+)*?" + _MUTATING_NPM + r"\b"),
    re.compile(_CMD + r"(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test)\b"),
    re.compile(_CMD + r"npx\s+(?:[-\w@/.]+\s+)*?(?:vitest|jest|playwright|mocha|ava)\b"),
    re.compile(_CMD + r"(?:go)\s+(?:build|test)\b"),
    re.compile(_CMD + r"cargo\s+(?:build|test)\b"),
    re.compile(_CMD + r"(?:python3?\s+-m\s+)?pytest\b"),
    re.compile(_CMD + r"mvn\s+(?:[-\w]+\s+)*?(?:install|test|package|verify)\b"),
    re.compile(_CMD + r"(?:\.\/)?gradlew?\s+(?:[-\w]+\s+)*?(?:build|test)\b"),
    re.compile(_CMD + r"tsc\b(?![^\n;&|]*--noEmit\b[^\n;&|]*$)(?=[^\n;&|]*(?:$|[\n;&|]))"),
    re.compile(_CMD + r"(?:webpack|vite)\s+(?:[-\w]+\s+)*?build\b"),
    re.compile(_CMD + r"docker\s+build\b"),
    re.compile(_CMD + r"docker[- ]compose\s+(?:[-\w]+\s+)*?up\b"),
    re.compile(_CMD + r"apt(?:-get)?\s+(?:[-\w]+\s+)*?install\b"),
    re.compile(_CMD + r"pip3?\s+install\b"),
]

_WRAPPER_RX = re.compile(
    r"(?:^|[\n;&|(])\s*(?:bash|sh|zsh)\s+-c\s+(['\"])(.*?)\1|(?:^|[\n;&|(])\s*eval\s+(['\"])(.*?)\3",
    re.S,
)
_HEREDOC_RX = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*?^\s*\2\s*$", re.S | re.M)
_QUOTED_RX = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)


def _unwrapped_variants(cmd):
    out = [cmd]
    for m in _WRAPPER_RX.finditer(cmd):
        inner = m.group(2) if m.group(2) is not None else m.group(4)
        if inner:
            out.append(inner)
    return out


def _strip_heredoc_bodies(cmd):
    return _HEREDOC_RX.sub("<<HEREDOC-BODY-STRIPPED", cmd)


def _strip_quoted_literals(cmd):
    return _QUOTED_RX.sub(lambda m: "''" if m.group(0)[0] == "'" else '""', cmd)


# A mention of the wrapper is NOT the same as the wrapper OWNING the command (Cybersec, 2026-08-23).
# The old check was `if "noisy-run.sh" in raw` over the WHOLE line, so any line that merely named the
# file -- an echo, a grep argument, a quoted sentence, or the guard's own printed suggestion in its
# compound form -- disarmed the guard for every other command on that line. Exemption is now decided
# per simple command. A nested context ($( ), backticks, <( )) starts a new segment on purpose: its
# contents are expanded by the OUTER shell, so a wrapper earlier on the line does not cover them.
_SEG_SPLIT_RX = re.compile(r"\|\||&&|\$\(|<\(|>\(|[;\n|&()`]")
_WRAPPER_SEG_RX = re.compile(
    r"^\s*" + _ENV_PREFIX + r"(?:sudo\s+)?(?:time\s+)?(?:(?:bash|sh|zsh)\s+)?\S*noisy-run\.sh\b"
)


def _segments(cmd):
    return _SEG_SPLIT_RX.split(cmd)


def _owned_by_wrapper(seg):
    return _WRAPPER_SEG_RX.match(seg) is not None


# noisy-run.sh execs its argv directly ("$@"), so it can only wrap ONE simple command. Pasting a
# compound line after it hands the wrapper the first segment and leaves the rest -- the noisy part --
# running raw in the outer shell (Cybersec, 2026-08-23: measured on this guard's own suggestion).
# A command carrying shell metacharacters therefore has to travel as a single argument.
_METACHAR_RX = re.compile(r"[|&;<>\n()`]|\$\(")

# Leading `VAR=val` assignment(s) before the real command. Built with `+` (one-or-more), not
# reused from _ENV_PREFIX's `*` (zero-or-more) -- a `*` here would match every command at position
# zero (zero assignments is still a match), making the check a no-op.
_LEADING_ENV_RX = re.compile(r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)+")


# RedHat NO-GO (card ff43b10e, comment 32154) + MikroB addendum (comment 32155, dispatch 19523/
# 19536): rewrite may ONLY happen when the first word of the command is the noisy program itself.
# ANY leading wrapper -- sudo/doas/pkexec/su -c (privilege escalation), time, rtk -- disqualifies
# the rewrite, same as a leading `VAR=val` or a shell metacharacter: it falls back to
# block-and-suggest exactly like today, UNCHANGED from before this fix (this only narrows which
# matched commands may be REWRITTEN, it does not change which commands are matched/blocked at
# all). The concrete exploit: `sudo npm install` matched _CMD's own optional `sudo` prefix, so it
# got rewritten into `bash .../noisy-run.sh sudo npm install` -- a line starting with `bash`, not
# `sudo`, which a start-anchored deny rule like Bash(sudo:*) can no longer see.
#
# RedHat LOW (card 214ca312, ff43b10e follow-up): `bash -c '<noisy cmd>'` / `sh -c ...` /
# `zsh -c ...` sat outside this list, so it was still REWRITTEN -- the same class of hole as
# sudo, one layer removed. `_unwrapped_variants()` matches NOISY_PATTERNS against the string
# INSIDE the quotes (so the guard still recognizes the noisy command hiding in there), but
# `_rewrite_is_safe()` checks the RAW, outer command, whose first word is `bash`/`sh`/`zsh`, not
# the noisy program -- so it passed the "first word is the noisy program itself" rule on a
# technicality. Added here so it falls back to block-and-suggest like every other wrapper.
_WRAPPER_DISQUALIFIES_REWRITE_RX = re.compile(
    r"^\s*(?:sudo|doas|pkexec|time|rtk)\b|^\s*su\s+-c\b|^\s*(?:bash|sh|zsh)\s+-c\b"
)


def _rewrite_is_safe(raw):
    """WhiteHat F1/F2 (card fc3a6a39 follow-up, ff43b10e): rewrite mode may ONLY substitute a
    command that `noisy-run.sh` can run as a plain argv list, unmodified in meaning, with the
    SAME string the permission engine evaluated its deny/ask rules against.

    F1 (blocking): wrapping a compound/multi-segment command into `bash -c '<raw>'` buries every
    embedded simple command inside one quoted string argument. A deny rule (e.g. BASH_EGRESS_DENY
    on wget/nc/telnet) that recognizes a program by how a command STARTS no longer sees it -- the
    rewritten line starts with `bash .../noisy-run.sh bash -c '...'`, not with the denied program.
    This is fine for the block-and-suggest path (a human reads the suggestion, decides, retypes
    it) but not for a mode that substitutes it silently. A command with any shell metacharacter
    therefore never gets the rewrite; it falls back to block-and-suggest exactly like today.

    F2: `"$@"` is a bare exec, not a shell -- `noisy-run.sh FOO=bar npm test` passes "FOO=bar" as
    argv[0] (a literal program name, not an environment assignment for npm), which fails with
    "command not found" (rc 127) instead of ever running npm. A leading `VAR=val` prefix therefore
    also falls back to block-and-suggest, where the printed suggestion is read and retyped by a
    real shell that DOES parse the assignment.

    RedHat NO-GO (comment 32154) + MikroB addendum (comment 32155/19536): a leading wrapper token
    (sudo/doas/pkexec/su -c/time/rtk) ALSO falls back to block-and-suggest -- see
    `_WRAPPER_DISQUALIFIES_REWRITE_RX` above. The rewrite may only fire when the command's first
    word is the noisy program itself.
    """
    return (
        not _METACHAR_RX.search(raw)
        and not _LEADING_ENV_RX.match(raw)
        and not _WRAPPER_DISQUALIFIES_REWRITE_RX.match(raw)
    )


def _suggest(here, raw):
    if _METACHAR_RX.search(raw):
        return f"bash {here}/noisy-run.sh bash -c '{raw.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'"
    return f"bash {here}/noisy-run.sh {raw}"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    raw = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        sys.exit(0)

    try:
        cmd = _strip_heredoc_bodies(raw)
        for variant in (_strip_quoted_literals(v) for v in _unwrapped_variants(cmd)):
            for seg in _segments(variant):
                # Both escape hatches are per simple command, for the same reason: naming one
                # somewhere else on the line says nothing about THIS command.
                if _owned_by_wrapper(seg) or f"{ALLOW_ENV}=1" in seg:
                    continue
                for rx in NOISY_PATTERNS:
                    if rx.search(seg):
                        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                        wrapped = _suggest(here, raw)
                        if os.environ.get(MODE_ENV) == "rewrite" and _rewrite_is_safe(raw):
                            # MikroB decision (comment 32155, RedHat NO-GO): never raise
                            # permission on a rewrite -- permissionDecision stays UNSET, so the
                            # normal permission flow (including any deny rule) still evaluates
                            # the rewritten command on its own merits.
                            updated_input = dict(ti)
                            updated_input["command"] = wrapped
                            print(json.dumps({
                                "hookSpecificOutput": {
                                    "hookEventName": "PreToolUse",
                                    "updatedInput": updated_input,
                                }
                            }))
                            sys.exit(0)
                        sys.stderr.write(
                            "NOISY-COMMAND-GUARD: ez a parancs jellemzoen sok, keves "
                            "informaciotartalmu kimenetet ad (install/build/teszt/progress-bar). "
                            "Ne futtasd nyersen -- fusd a szuron keresztul, ami csak a "
                            "hiba/fail/warn sorokat es a vegso osszefoglalot adja vissza, a "
                            "teljes log egy fajlba megy:\n\n"
                            f"  {wrapped}\n\n"
                            "Ha tenyleg a nyers, interlevelt kimenet kell (pl. build-hang "
                            f"debug), egyszeri korre: {ALLOW_ENV}=1 {raw}"
                        )
                        sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open

    sys.exit(0)


if __name__ == "__main__":
    main()
