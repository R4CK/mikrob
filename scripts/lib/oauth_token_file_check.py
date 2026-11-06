"""oauth_token_file_check.py -- the watchdog.sh respawn path's ONE check for the per-agent
oauthTokenFile setting, mirroring src/web/agent-oauth-token-file.ts's config-read and
field-resolution semantics (resolveOauthTokenFileSetting / readAgentConfigForOauthDecision).

Card bc32d233 (006b506b Cybersec delta-GO ea46eecf, findings G1-G4) on top of card 006b506b's
original watchdog.sh F5 fix: that fix taught the launcher to RESPECT the field (fail-closed on a
present-but-unusable FILE), but its own config-read was a bare `except Exception: print('')` --
every read failure (unreadable config, a directory in its place, malformed JSON that still names
the key, a non-string/blank/null value) silently became "no field", which is exactly the
fail-OPEN this module exists to prevent (G1, MEDIUM). This script replaces that inline read with
the same ENOENT-vs-everything-else distinction the TS module makes, taking the agent directory as
an argv (never interpolated into Python source -- the shell-injection class G3 flagged, a quoted
path breaking out of an f-string-built `python3 -c "..."` call) and never printing the token value
itself (only path/verdict), the same posture agent-oauth-token-file.ts keeps.

Usage: oauth_token_file_check.py <agent-dir> <fleet-token-path>
Exactly one line on stdout, ALWAYS (never a crash/traceback -- card bc32d233, RedHat/QA2 delta-GO
follow-up: watchdog.sh's case-statement treats anything that is not exactly "UNSET" or "SET:*" or
"REFUSE:*" as a checker failure and refuses, so this script must never produce empty/partial/
multi-line output or a non-zero exit for a condition it can anticipate):
  "UNSET"         -- field absent (or config file truly absent, ENOENT) -> fleet-token path.
                     An explicit sentinel, not "", so an empty string can never be confused with
                     a checker that printed nothing because it crashed.
  "REFUSE:<why>"  -- present but unusable at the CONFIG level -> watchdog.sh must refuse the restart
  "SET:<path>"    -- validated path; watchdog.sh still runs its own FILE-level checks on <path>
                     (isolation dir, symlink/missing, mode, fleet-file identity, setup-token
                     prefix, content shape) before exporting it -- this script only resolves what
                     the config SAYS, not whether the file it names is actually usable.
"""
import json
import os
import re
import sys

OAUTH_TOKEN_FILE_KEY = "oauthTokenFile"
KEY_QUOTED = '"' + OAUTH_TOKEN_FILE_KEY + '"'
# Mirrors agent-oauth-token-file.ts's TOKEN_FILE_PATH_ALLOWED: absolute, whitelisted characters
# only, because the launcher inlines the path between single quotes in the export line.
TOKEN_FILE_PATH_ALLOWED = re.compile(r"^/[A-Za-z0-9_./-]+$")


def ends_in_truncated_key_name(raw: str) -> bool:
    trimmed = raw.rstrip()
    for n in range(2, len(KEY_QUOTED)):
        if trimmed.endswith(KEY_QUOTED[:n]):
            return True
    return False


def resolve(agent_dir: str) -> str:
    cfg_path = os.path.join(agent_dir, "agent-config.json")

    # lstat (not stat): mirrors readAgentConfigForOauthDecision -- ENOENT from lstat itself means
    # truly absent (unset, same as every other config field's "{}" default). ANY other lstat/read
    # failure (permission denied, a directory in its place, a dangling symlink whose target read
    # fails) means present-but-unusable, which must REFUSE, not silently fall back to "unset".
    try:
        os.lstat(cfg_path)
        exists = True
    except FileNotFoundError:
        exists = False
    except OSError:
        return "REFUSE:config-unreadable"

    if not exists:
        raw = "{}"
    else:
        try:
            # errors="replace" (card bc32d233, RedHat/QA2 delta-GO follow-up, 2026-10-10):
            # a config file with invalid UTF-8 bytes used to raise UnicodeDecodeError here,
            # UNCAUGHT (this try only catches OSError) -- the whole script crashed with a
            # traceback on stderr, nothing on stdout, and watchdog.sh's `2>/dev/null` swallowed
            # the stderr while its case-statement fell through an empty CONFIG_VERDICT to the
            # unconditional fleet-token fallback. Decoding with replacement characters instead
            # (matching the TS reference's readFileSync('utf-8') behavior, which never throws
            # on invalid bytes) means a byte-corrupt config is read, not crashed on, and falls
            # through to the EXISTING json.loads/key-presence logic below like any other file.
            with open(cfg_path, "r", encoding="utf-8", errors="replace") as f:
                raw = f.read()
        except OSError:
            return "REFUSE:config-unreadable"

        # QA FAIL (card bc32d233, 2026-10-10): a truly empty, whitespace-only, or NUL-containing
        # config file (the realistic result of a crash mid non-atomic write) named neither test nor
        # key below -- json.loads raises, but KEY_QUOTED is absent and the file does not end in a
        # truncated key name, so this fell through to "" (unset) -> the FLEET token, exactly the
        # fail-open class G1 exists to close, just on whole-file instead of field-level corruption.
        # Mirrors readAgentConfigForOauthDecision's OWN pre-json.loads check, same order: raw-text
        # degeneracy is checked BEFORE parsing, never inferred from the parse failure.
        if raw.strip() == "" or "\0" in raw:
            return "REFUSE:config-unreadable"

    try:
        config = json.loads(raw)
    except Exception:
        # Mirrors resolveOauthTokenFileSetting's unparseable-JSON branch: a broken file that still
        # NAMES the key (whole or truncated mid-key) refuses; one that never mentions it is unset,
        # same as every other reader's "{}" fallback.
        if KEY_QUOTED in raw or ends_in_truncated_key_name(raw):
            return "REFUSE:config-unparseable"
        return "UNSET"

    if not isinstance(config, dict) or OAUTH_TOKEN_FILE_KEY not in config:
        return "UNSET"

    value = config[OAUTH_TOKEN_FILE_KEY]
    if not isinstance(value, str):
        return "REFUSE:not-a-string"
    path = value.strip()
    if not path:
        return "REFUSE:blank"
    if not path.startswith("/"):
        return "REFUSE:not-absolute"
    if not TOKEN_FILE_PATH_ALLOWED.match(path):
        return "REFUSE:path-bad-characters"
    if any(segment == ".." for segment in path.split("/")):
        return "REFUSE:path-parent-traversal"
    return "SET:" + path


def same_as_fleet_token(own_path: str, fleet_token_path: str) -> bool:
    """Mirrors checkOauthTokenFile's content-equality check: a COPY of the fleet token under
    another name (different inode, identical bytes) is still the fleet token. Trailing newlines
    stripped on both sides, matching exportedValue()'s treatment of what `$(cat file)` hands the
    shell. Never prints either value -- a boolean only."""
    try:
        with open(own_path, "r", encoding="utf-8") as f:
            own = f.read().rstrip("\n")
    except OSError:
        return False
    try:
        with open(fleet_token_path, "r", encoding="utf-8") as f:
            fleet = f.read().rstrip("\n")
    except OSError:
        return False  # no fleet file: nothing to be a copy of
    return own == fleet and own != ""


_VALID_AUTH_MODES = ("shared", "own_team", "api")


def needs_fleet_oauth(agent_dir: str) -> bool:
    """Mirrors needsFleetOauthFor (src/web/agent-process.ts): `isClaude && authMode != 'api' &&
    !isOwnTeam && !customProviderId`, with isClaude = !customProviderId && model.startswith
    ('claude-') and isOwnTeam = isClaude && authMode == 'own_team' -- the single predicate card
    3ae2411d asks the watchdog's unconditional fleet-token fallback to also honor, so a
    BYO/customProvider agent (or one on its own /login via authMode 'own_team') never gets the
    fleet's CLAUDE_CODE_OAUTH_TOKEN exported on a watchdog-triggered restart either.

    Card bc32d233's own-token-file config-read already distinguishes ENOENT (truly absent) from
    any other read/parse failure; this predicate deliberately does NOT -- a config this guard
    cannot read cleanly defaults to the CURRENT, pre-existing behaviour (export the fleet token),
    same posture as every other field reader in this fork's agent-config.ts (a bare `except:
    fall through` to the default). customProviderId is the actual security boundary this card
    exists to close (an agent with one must NEVER get the fleet token, full stop); authMode is a
    narrower, already-opt-in exclusion on top of that. A config this guard cannot parse at all
    has no customProvider value to find either, so this only ever affects the SAME agents the
    pre-existing code already exported the fleet token to -- it does not newly refuse anyone.

    The `model` field is read directly rather than replicating agent-config.ts's full alias/
    model-profile resolution (resolveAgentModelFromConfig): per readAgentModel's own contract
    comment, "for every config that names a `model` -- which is all of them today -- this
    returns byte-identically what it returned before"; an absent field defaults to isClaude=True
    (the fleet's own DISTRIBUTION_DEFAULT_AGENT_MODEL is 'claude-opus-5'), matching today's
    behaviour for the common case of an agent with no `model` key at all.
    """
    config_path = os.path.join(agent_dir, "agent-config.json")
    try:
        with open(config_path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read()
        config = json.loads(raw)
        if not isinstance(config, dict):
            config = {}
    except FileNotFoundError:
        config = {}
    except OSError:
        return True  # unreadable config: same as the pre-existing unconditional fallback
    except Exception:
        return True  # unparseable config: same as the pre-existing unconditional fallback

    custom_provider = config.get("customProvider")
    has_custom_provider = isinstance(custom_provider, str) and custom_provider.strip() != ""

    model = config.get("model")
    model_str = model if isinstance(model, str) and model.strip() else "claude-opus-5"
    is_claude = (not has_custom_provider) and model_str.startswith("claude-")

    auth_mode = config.get("authMode")
    if auth_mode not in _VALID_AUTH_MODES:
        auth_mode = "shared"

    is_own_team = is_claude and auth_mode == "own_team"
    return is_claude and auth_mode != "api" and (not is_own_team) and (not has_custom_provider)


def has_bad_content_characters(path: str) -> bool:
    """Mirrors checkOauthTokenFile's content-bad-characters check: a setup-token never contains
    whitespace or control characters; one that does would reach the environment verbatim and fail
    as a login, not here."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().rstrip("\n")
    except OSError:
        return False
    return bool(re.search(r"[\s\x00-\x1f\x7f]", value))


def _usage() -> None:
    print(
        "usage: oauth_token_file_check.py <agent-dir>\n"
        "   or: oauth_token_file_check.py --same-as-fleet-token <own-path> <fleet-token-path>\n"
        "   or: oauth_token_file_check.py --bad-content-characters <path>\n"
        "   or: oauth_token_file_check.py --needs-fleet-oauth <agent-dir>",
        file=sys.stderr,
    )
    sys.exit(2)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--same-as-fleet-token":
        sys.exit(0 if same_as_fleet_token(sys.argv[2], sys.argv[3]) else 1)
    elif len(sys.argv) == 3 and sys.argv[1] == "--bad-content-characters":
        sys.exit(0 if has_bad_content_characters(sys.argv[2]) else 1)
    elif len(sys.argv) == 3 and sys.argv[1] == "--needs-fleet-oauth":
        try:
            sys.exit(0 if needs_fleet_oauth(sys.argv[2]) else 1)
        except Exception:
            sys.exit(0)  # same unconditional-fallback posture as an unreadable config, above
    elif len(sys.argv) == 2 and not sys.argv[1].startswith("--"):
        # Belt-and-suspenders (card bc32d233): resolve() is written to never raise for any
        # condition it anticipates, but an exception from a cause nobody anticipated (OOM, a
        # future regression) must still produce exactly one valid line rather than a crash --
        # the docstring's whole contract. watchdog.sh's case-statement already treats any
        # other output as REFUSE:checker-failed; this is what makes that the case-statement's
        # unreachable branch rather than the thing it actually has to defend against.
        try:
            print(resolve(sys.argv[1]))
        except Exception:
            print("REFUSE:checker-failed")
    else:
        _usage()
