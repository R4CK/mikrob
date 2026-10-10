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
Exactly one line on stdout:
  ""              -- unset: field absent (or config file truly absent, ENOENT) -> fleet-token path
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
            with open(cfg_path, "r", encoding="utf-8") as f:
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
        return ""

    if not isinstance(config, dict) or OAUTH_TOKEN_FILE_KEY not in config:
        return ""

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
        "   or: oauth_token_file_check.py --bad-content-characters <path>",
        file=sys.stderr,
    )
    sys.exit(2)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--same-as-fleet-token":
        sys.exit(0 if same_as_fleet_token(sys.argv[2], sys.argv[3]) else 1)
    elif len(sys.argv) == 3 and sys.argv[1] == "--bad-content-characters":
        sys.exit(0 if has_bad_content_characters(sys.argv[2]) else 1)
    elif len(sys.argv) == 2 and not sys.argv[1].startswith("--"):
        print(resolve(sys.argv[1]))
    else:
        _usage()
