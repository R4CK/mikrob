#!/usr/bin/env python3
"""Credential-shape guard for session transcripts, scratchpads and logs (cards 500f0e3c, 3b5bf8d6).

WHY THIS EXISTS. A long-lived Claude setup token once sat as a plaintext export in a shell rc
file; a later measurement found the value in three session transcripts (.jsonl under
~/.claude/projects), several file-history snapshots and a scratchpad backup. Every one of those is a
local file under the same UID, but a transcript share or a bug report would carry the token out.
Nothing looked at those places, so the copies lived until someone happened to grep.

WHAT IT DOES. Walks the places where tool output ends up -- session transcripts, file-history,
scratchpad directories, the prompt history, store/*.log -- and counts, per file:
  * well-known credential SHAPES (prefixed vendor tokens, PEM private keys), and
  * the exact VALUES of our own secrets (dashboard token, OAuth token, .env secrets), which carry no
    recognisable prefix and which no shape can find.
A copy of a file that is supposed to hold a credential (.env, *.token, .credentials.json) outside
its home is itself a finding; its content is never read.

IT NEVER PRINTS A VALUE. Output is `path / pattern name / count`, nothing else. This is structural,
not a convention: matched bytes are only ever passed to len() and the example-value test, never
decoded, formatted or logged. A path segment that is itself shaped like a credential is replaced by a
short hash, and control characters in paths are escaped, so a hostile file name cannot carry a value
or forge an output line either. The self-test asserts that a planted token does not appear anywhere
in stdout, stderr, the state file or the alert message.

IT MUST NOT BE SILENTLY BLIND. A guard that reports zero looks the same on a clean tree and on a
broken one. Three layers, all exit 3:
  1. Every pattern must match its own canary (regex layer).
  2. The canaries are then run through the real walk -> read -> count pipeline in a private temp
     directory (traversal, chunking and counting layer).
  3. After the scan, an INCOMPLETE run is blind too: nothing scanned, a required root missing or
     empty, a directory or file that could not be read, or a known-secret source that could not be
     loaded. A file that vanishes between listing and open (rotation) is not an error.
Non-regular files (FIFO, socket, device) are never opened, so one cannot stall the run; they are
counted (`special`) and, being a pipe, hold nothing at rest to scan.

SCOPE, DELIBERATELY NARROW.
  * Read-only. Cleanup is a human procedure (docs/transcript-secret-guard.md): masking a shared
    transcript is not something a daily job should do unattended.
  * Files that are SUPPOSED to hold a credential are never opened. Reporting their content would be
    noise, and reading it would be the opposite of the point. Their existence in a scanned root,
    where no such file belongs, is reported.
  * Masked placeholders (`sk-ant-oat01-[MASKED-...]`) and truncated displays do not match: every
    pattern needs a run of real token characters directly after the prefix.
  * It is a net for accidents, not an exfiltration control: an encoded (base64, escaped, zero-width
    split) or line-split credential evades it.

ALERTING. `--alert` sends ONE Telegram notice through scripts/notify.sh, only when a (file, pattern)
pair is NEW or its count GREW since the last alert (state file), or when the guard became blind in a
way it was not blind before. A finding that stays unresolved does not re-alert daily; a cleaned
finding is forgotten, so a reappearance alerts again. If the notice cannot be sent the state is NOT
advanced (exit 5), so the next run tries again. The state also records `last_complete_at`, the last
run that saw everything, for a freshness check.

Usage:
  transcript-secret-guard.py [--alert|--alert-dryrun] [--root DIR]... [--state FILE]
                             [--extra-patterns FILE] [--secrets-base DIR] [--notify-cmd CMD] [--quiet]
Exit: 0 clean (or only already-alerted findings with --alert), 4 findings, 3 guard blind or run
      incomplete, 2 usage error, 5 alert could not be sent.
"""
from __future__ import annotations

import argparse
import bz2
import errno
import glob
import gzip
import hashlib
import json
import lzma
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
import zlib

# --- patterns -----------------------------------------------------------------------------------
# Bytes regexes: transcripts are JSON text, but a scratchpad can hold anything and we never want a
# decode error to hide a hit. Each needs real token characters right after the prefix, so masked
# placeholders and `sk-ant-oat01-...` style truncations are not findings.
_RAW: list[tuple[str, str]] = [
    ("anthropic-setup-token", r"sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}"),
    ("anthropic-api-key", r"sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}"),
    # Prefix per the vendor Admin API docs ("starting with sk-ant-admin"); the body format is not
    # documented there, so the version digits are optional.
    ("anthropic-admin-key", r"sk-ant-admin[0-9]{0,2}-[A-Za-z0-9_-]{20,}"),
    ("github-token", r"gh[pousr]_[A-Za-z0-9]{36,}"),
    ("github-fine-grained-pat", r"github_pat_[A-Za-z0-9_]{50,}"),
    # Also inside an API URL (`/bot<token>/getMe`): "bot" directly before the digits is allowed, in
    # any letter case (`/Bot<token>/`, `/BOT<token>/`).
    (
        "telegram-bot-token",
        r"(?:(?<![0-9A-Za-z])|(?<=[Bb][Oo][Tt]))[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])",
    ),
    ("aws-access-key-id", r"(?<![0-9A-Z])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])"),
    # Project / service-account keys carry '-' and '_' in the body; the legacy form is alphanumeric
    # only. The `svcacct` and `None` prefixes come from third-party sources, not a vendor doc.
    (
        "openai-api-key",
        r"(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|None)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{40,})",
    ),
    ("slack-token", r"xox[baprs]-[0-9A-Za-z-]{10,}"),
    ("google-api-key", r"AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])"),
    ("stripe-live-secret", r"sk_live_[0-9A-Za-z]{24,}"),
    # Header alone is documentation noise in transcripts (skills quote it); require a base64 body.
    # Line breaks may be raw or JSON-escaped (\n, \r\n as backslash sequences).
    (
        "private-key-block",
        r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----"
        r"(?:\\[nr]|\s){0,8}[A-Za-z0-9+/]{60,}",
    ),
]
PATTERNS: list[tuple[str, "re.Pattern[bytes]"]] = [(n, re.compile(p.encode())) for n, p in _RAW]

CRED_COPY = "credential-file-copy"  # existence finding, content is never read

# Vendor-published example values only (allowing them leaks nothing real).
EXAMPLE_VALUES = frozenset({b"AKIAIOSFODNN7" + b"EXAMPLE"})

# Files that are meant to hold a credential: never opened (reported if found where they do not belong).
NEVER_OPEN_NAMES = frozenset({".env", ".credentials.json", ".claude-oauth-token", ".dashboard-token"})
NEVER_OPEN_SUFFIXES = (".token",)
# Media we cannot read as text: skipped, counted.
SKIP_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".mp3", ".mp4", ".mov",
    ".woff", ".woff2", ".ttf",
)
# Single-stream compressed files (rotated logs) are decompressed and scanned like any other file, up
# to ARCHIVE_CAP decompressed bytes each (a compression bomb stops there).
DECOMPRESS_SUFFIXES = (".gz", ".tgz", ".bz2", ".xz")
ARCHIVE_CAP = 256 * 1024 * 1024
# What a byte scan cannot read stays `opaque`: counted, and it makes the run INCOMPLETE (blind), so a
# secret inside it is a page, not a silent zero. A .zip (member index, no single stream), and any
# archive that is corrupt, truncated or over ARCHIVE_CAP.
OPAQUE_SUFFIXES = (".zip",)

MIN_CHUNK = 64
_DEFAULT_CHUNK = 4 * 1024 * 1024


def _chunk_from_env() -> tuple[int, str | None]:
    raw = os.environ.get("TRANSCRIPT_GUARD_CHUNK")  # env override: tests only
    if raw is None:
        return _DEFAULT_CHUNK, None
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_CHUNK, "TRANSCRIPT_GUARD_CHUNK is not an integer"
    if value < MIN_CHUNK:
        return _DEFAULT_CHUNK, f"TRANSCRIPT_GUARD_CHUNK is below {MIN_CHUNK}"
    return value, None


CHUNK, CHUNK_ERROR = _chunk_from_env()
OVERLAP = 600  # trailing context kept between passes: lookbehind context and pattern prefixes
MAX_CARRY = 1024 * 1024  # a match longer than this is counted now instead of carried (memory bound)

# Which values of our own secret files count as "known secrets" (never printed).
MAX_KNOWN = 200
KNOWN_KEY_RX = re.compile(r"TOKEN|SECRET|PASS(?:W(?:OR)?D)?|KEY|CREDENTIAL|SALT|LINK", re.I)
# Printable ASCII without a space: a password with '#', '*' or '$' is as much a secret as a hex token.
# A value is also searched in its JSON-escaped form (up to twice as long), and a match must fit in
# the OVERLAP kept between chunk passes, so the cap is half of it.
MAX_KNOWN_LEN = 256
KNOWN_VALUE_RX = re.compile(rb"[\x21-\x7e]{16,%d}" % MAX_KNOWN_LEN)
ENV_LINE_RX = re.compile(rb"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
# The prefixless dashboard token is the reason the exact-value search exists: no token, no search.
REQUIRED_KNOWN = "known:dashboard-token"

EXIT_OK, EXIT_USAGE, EXIT_BLIND, EXIT_FINDINGS, EXIT_ALERT_FAILED = 0, 2, 3, 4, 5


class NotRegularFile(Exception):
    """The path is a FIFO/socket/device (or was swapped for one): never read."""


def _canaries() -> list[tuple[str, bytes]]:
    """One known-positive per built-in pattern, assembled here so no credential shape is on disk."""
    a36 = b"A" * 36
    return [
        ("anthropic-setup-token", b"sk-ant-" + b"oat01-" + b"Q" * 40),
        ("anthropic-api-key", b"sk-ant-" + b"api03-" + b"Q" * 40),
        ("anthropic-admin-key", b"sk-ant-" + b"admin01-" + b"Q" * 40),
        ("github-token", b"gh" + b"p_" + a36),
        ("github-fine-grained-pat", b"github" + b"_pat_" + b"B" * 60),
        ("telegram-bot-token", b"1234567890" + b":" + b"C" * 35),
        ("aws-access-key-id", b"AK" + b"IA" + b"D" * 16),
        ("openai-api-key", b"sk" + b"-" + b"E" * 48),
        ("slack-token", b"xox" + b"b-" + b"1234567890-abc"),
        ("google-api-key", b"AI" + b"za" + b"F" * 35),
        ("stripe-live-secret", b"sk_" + b"live_" + b"G" * 28),
        ("private-key-block", b"-----BEGIN " + b"PRIVATE KEY-----\\n" + b"H" * 70),
    ]


def self_check(patterns: list[tuple[str, "re.Pattern[bytes]"]]) -> list[str]:
    """Names of built-in patterns that fail to match their own canary (empty list = not blind)."""
    by_name = dict(patterns)
    blind = []
    for name, sample in _canaries():
        rx = by_name.get(name)
        if rx is None or not rx.search(b"x " + sample + b" y"):
            blind.append(name)
    return blind


def load_extra_patterns(path: str) -> list[tuple[str, "re.Pattern[bytes]"]]:
    """`name<TAB>regex` per line. A bad line is a hard error: a silently dropped pattern is blindness."""
    out: list[tuple[str, "re.Pattern[bytes]"]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if "\t" not in line:
                raise ValueError(f"{path}:{lineno}: expected name<TAB>regex")
            name, rx = line.split("\t", 1)
            try:
                out.append((name.strip(), re.compile(rx.encode())))
            except re.error as exc:
                raise ValueError(f"{path}:{lineno}: bad regex ({exc.msg})") from None
    return out


# --- known secrets (exact values of our own credentials) ----------------------------------------
def _acceptable_secret(value: bytes) -> bool:
    """Token-shaped, long enough to be a secret, and not a path or URL (those would match everywhere)."""
    return (
        bool(KNOWN_VALUE_RX.fullmatch(value))
        and not value.startswith((b"/", b".", b"~"))
        and b"://" not in value
    )


SECRETS_MAX_DEPTH = 4
SECRETS_MAX_FILES = 500


def _secret_files(top: str, limits: dict | None = None):
    """(path, path relative to `top`) for every non-directory entry under store/secrets, dotfiles
    included, links NOT followed (a link is yielded so the caller can count it as a skip). Depth and
    count are bounded; hitting a bound is recorded in `limits["truncated"]` (the caller turns it into
    a problem), never silently dropped."""
    limits = limits if limits is not None else {}
    count = 0
    stack = [(top, 0)]
    while stack:
        directory, depth = stack.pop()
        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name)
        except FileNotFoundError:
            continue
        except OSError:
            limits["truncated"] = True
            continue
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                if depth + 1 > SECRETS_MAX_DEPTH:
                    limits["truncated"] = True
                else:
                    stack.append((entry.path, depth + 1))
                continue
            count += 1
            if count > SECRETS_MAX_FILES:
                limits["truncated"] = True
                return
            yield entry.path, os.path.relpath(entry.path, top)


def load_known_secrets(base: str, home: str) -> tuple[list[tuple[str, bytes]], int, int]:
    """Values of the files that are SUPPOSED to hold a credential -> ([(label, value)], problems, skipped).

    The values stay in memory, inside compiled patterns; only the label (a file or env key NAME)
    ever reaches output. A source that exists but cannot be read is a `problem` (blind spot), a
    missing one is normal on installs that do not have it. `skipped` counts secret-named entries whose
    value was not loaded (shorter than 16 characters, non-ASCII, a path or URL): not a blind spot, but
    never silent either.
    """
    found: list[tuple[str, bytes]] = []
    seen: set[bytes] = set()
    problems = 0
    skipped = 0

    def add(label: str, value: bytes) -> None:
        nonlocal problems, skipped
        if value in seen:
            return
        if not _acceptable_secret(value):
            skipped += 1
            return
        if len(found) >= MAX_KNOWN:
            problems += 1
            return
        seen.add(value)
        found.append((label, value))

    def read(path: str) -> bytes | None:
        nonlocal problems
        try:
            with open(path, "rb") as fh:
                return fh.read(1024 * 1024)
        except FileNotFoundError:
            return None
        except OSError:
            problems += 1
            return None

    def read_regular(path: str) -> bytes | None:
        """For a directory whose content we do not control: never block on a FIFO, never follow a link."""
        nonlocal problems
        try:
            fd = _open_regular(path)
        except (NotRegularFile, FileNotFoundError):
            return None
        except OSError:
            problems += 1
            return None
        try:
            with os.fdopen(fd, "rb") as fh:
                return fh.read(1024 * 1024)
        except OSError:
            problems += 1
            return None

    def add_env(data: bytes, prefix: str) -> None:
        for line in data.splitlines():
            m = ENV_LINE_RX.match(line)
            if not m or not KNOWN_KEY_RX.search(m.group(1).decode("ascii", "replace")):
                continue
            value = m.group(2).split(b" #", 1)[0].strip().strip(b"\"'")
            add(prefix + m.group(1).decode("ascii", "replace"), value)

    for name in (".dashboard-token", ".claude-oauth-token", ".vault-key"):
        data = read(os.path.join(base, "store", name))
        if data is not None:
            add("known:" + name.lstrip("."), data.strip())

    env_files = [os.path.join(base, ".env")] + sorted(glob.glob(os.path.join(base, "agents", "*", ".env")))
    for path in env_files:
        data = read(path)
        if data is not None:
            add_env(data, "known:env:")

    # store/secrets/**: files that hold credentials by location, dotfiles and subdirectories included.
    # A KEY=VALUE file is read like .env (secret-named keys only). A single-line file that gave no
    # secret-named value is read as ONE raw value instead: a raw base64 secret ending in '=' is shaped
    # like an empty assignment and would otherwise be dropped as a non-secret key. A link is a
    # problem (read_regular), a FIFO holds no data at rest and is passed over.
    secret_limits: dict = {}
    for path, rel in _secret_files(os.path.join(base, "store", "secrets"), secret_limits):
        data = read_regular(path)
        if data is None:
            continue
        label = "known:secrets:" + _escape(rel)
        before = len(found)
        if any(ENV_LINE_RX.match(line) for line in data.splitlines()):
            add_env(data, label + ":")
        stripped = data.strip()
        if len(found) == before and b"\n" not in stripped and b"\r" not in stripped:
            add(label, stripped)
    if secret_limits.get("truncated"):
        problems += 1  # depth/count bound hit or a directory unreadable: some secret files were not seen

    cred_files = [os.path.join(home, ".claude", ".credentials.json")]
    cred_files += sorted(glob.glob(os.path.join(base, "agents", "*", ".claude-config", ".credentials.json")))
    for path in cred_files:
        data = read(path)
        if data is None:
            continue
        try:
            doc = json.loads(data)
        except ValueError:
            problems += 1
            continue
        stack = [doc]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                for key, val in node.items():
                    if isinstance(val, str) and len(val) >= 20 and KNOWN_KEY_RX.search(str(key)):
                        add("known:credentials-json:" + str(key), val.encode("utf-8", "ignore"))
                    elif isinstance(val, (dict, list)):
                        stack.append(val)
            elif isinstance(node, list):
                stack.extend(v for v in node if isinstance(v, (dict, list)))
    return found, problems, skipped


def make_known_patterns(known: list[tuple[str, bytes]]) -> list[tuple[str, "re.Pattern[bytes]"]]:
    """One exact-value pattern per secret. Transcripts are JSON, which escapes `"` and `\\` inside a
    string, so a value that has either is also searched in its escaped form."""
    out = []
    for label, value in known:
        escaped = value.replace(b"\\", b"\\\\").replace(b'"', b'\\"')
        alts = [re.escape(value)] + ([re.escape(escaped)] if escaped != value else [])
        out.append((label, re.compile(b"|".join(alts))))
    return out


# --- walking ------------------------------------------------------------------------------------
def default_roots(home: str, install_dir: str) -> list[str]:
    roots = [
        os.path.join(home, ".claude", "projects"),
        os.path.join(home, ".claude", "file-history"),
        os.path.join(home, ".claude", "history.jsonl"),
        os.path.join(home, ".claude", "shell-snapshots"),
        os.path.join(home, ".claude", "paste-cache"),
        os.path.join(home, ".claude", "session-env"),
        f"/tmp/claude-{os.getuid()}",
    ]
    for base in glob.glob(os.path.join(install_dir, "agents", "*", ".claude-config")):
        roots.append(os.path.join(base, "projects"))
        roots.append(os.path.join(base, "file-history"))
    return roots


def required_roots(home: str) -> set[str]:
    """Roots whose absence or emptiness means the guard is not looking at what it exists to look at."""
    return {os.path.join(home, ".claude", "projects")}


def _note_error(stats: dict, path: str, exc: BaseException) -> None:
    stats["errors"] += 1
    if len(stats["error_paths"]) < 20:
        code = errno.errorcode.get(getattr(exc, "errno", None) or 0, type(exc).__name__)
        stats["error_paths"].append((path, code))


def new_stats() -> dict:
    return {
        "files_scanned": 0, "bytes": 0, "skipped": 0, "special": 0, "opaque": 0, "vanished": 0,
        "errors": 0, "credfiles": 0, "roots_missing": 0, "roots_empty": 0, "error_paths": [],
    }


def iter_files(roots: list[str], install_dir: str, stats: dict, required=frozenset()):
    """Yield (path, kind) with kind "scan" or "credfile". Roots and files are de-duplicated by inode,
    because the per-agent .claude-config/projects entries point at the same directory as
    ~/.claude/projects."""
    seen_dirs: set[str] = set()
    seen_files: set[tuple[int, int]] = set()
    all_roots: list[str] = []
    for r in roots:
        if os.path.isdir(r) or os.path.isfile(r):
            all_roots.append(r)
        elif r in required:
            stats["roots_missing"] += 1
    log_dir = os.path.join(install_dir, "store")
    if os.path.isdir(log_dir):
        try:
            for name in sorted(os.listdir(log_dir)):
                if ".log" in name:
                    all_roots.append(os.path.join(log_dir, name))
        except OSError as exc:
            _note_error(stats, log_dir, exc)

    def walk_error(exc: OSError) -> None:
        if isinstance(exc, FileNotFoundError):
            stats["vanished"] += 1
        else:
            _note_error(stats, getattr(exc, "filename", None) or "?", exc)

    for root in all_roots:
        real = os.path.realpath(root)
        if real in seen_dirs:
            continue
        seen_dirs.add(real)
        yielded = 0
        if os.path.isfile(real):
            walker = [(os.path.dirname(real), [], [os.path.basename(real)])]
        else:
            walker = os.walk(real, followlinks=False, onerror=walk_error)  # symlinked dirs not entered
        for dirpath, _dirnames, filenames in walker:
            for name in filenames:
                full = os.path.join(dirpath, name)
                try:
                    st = os.lstat(full)
                except FileNotFoundError:
                    stats["vanished"] += 1
                    continue
                except OSError as exc:
                    _note_error(stats, full, exc)
                    continue
                if stat.S_ISLNK(st.st_mode):
                    stats["skipped"] += 1
                    continue
                if not stat.S_ISREG(st.st_mode):
                    stats["special"] += 1  # FIFO/socket/device: nothing at rest, and opening can block
                    continue
                key = (st.st_dev, st.st_ino)
                if key in seen_files:
                    continue
                low = name.lower()
                if name in NEVER_OPEN_NAMES or low.endswith(NEVER_OPEN_SUFFIXES):
                    seen_files.add(key)
                    yielded += 1
                    yield full, "credfile"
                    continue
                if low.endswith(SKIP_SUFFIXES):
                    stats["skipped"] += 1
                    continue
                if low.endswith(OPAQUE_SUFFIXES):
                    stats["opaque"] += 1
                    continue
                seen_files.add(key)
                yielded += 1
                yield full, "scan"
        if root in required and yielded == 0:
            stats["roots_empty"] += 1


def _open_regular(path: str) -> int:
    """Open without blocking and without following a swapped-in symlink; refuse non-regular files."""
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise NotRegularFile(path)
    except BaseException:
        os.close(fd)
        raise
    return fd


class OpaqueArchive(Exception):
    """A compressed file that could not be read to its end (corrupt, truncated, over ARCHIVE_CAP).

    Carries what WAS found before it gave up, so a hit in the readable part is still reported."""

    def __init__(self, counts: dict[str, int], total: int):
        super().__init__("opaque archive")
        self.counts = counts
        self.total = total


class _CappedReader:
    """read(n) over a decompressor, refusing to hand out more than ARCHIVE_CAP bytes in total.

    A broken stream (corrupt, truncated, over the cap) does not raise: it ends the stream and sets
    `error`, so the chunk already decoded is still scanned and the caller decides it is opaque."""

    def __init__(self, fh):
        self._fh = fh
        self._left = ARCHIVE_CAP
        self.error: BaseException | None = None

    def read(self, n: int) -> bytes:
        if self.error is not None:
            return b""
        try:
            # read1: one underlying read, so everything decoded before a break is handed over first
            data = self._fh.read1(min(n, 65536, self._left + 1))
            if len(data) > self._left:
                raise ValueError("archive over cap")
        except (OSError, EOFError, ValueError, zlib.error, lzma.LZMAError) as exc:
            self.error = exc
            return b""
        self._left -= len(data)
        return data


def _decompressor(raw, low: str):
    if low.endswith((".gz", ".tgz")):
        return gzip.GzipFile(fileobj=raw, mode="rb")
    if low.endswith(".bz2"):
        return bz2.BZ2File(raw, "rb")
    return lzma.LZMAFile(raw, "rb")


def scan_file(path: str, patterns: list[tuple[str, "re.Pattern[bytes]"]]) -> tuple[dict[str, int], int]:
    """Return ({pattern name: count}, bytes read). Matched bytes never leave this function.
    A .gz/.tgz/.bz2/.xz is scanned decompressed; one that cannot be read to its end raises
    OpaqueArchive (with the counts found so far).

    Chunk edges: each pass re-scans a carried tail of the previous one. A match that touches the end
    of a non-final buffer is DEFERRED (the next chunk may extend it -- the token classes are greedy)
    and the carry then starts at that match, however long it already is (up to MAX_CARRY; a longer
    one is counted now, the rest has no prefix and cannot match again). A match that ended strictly
    before the carry boundary was already counted. Together that counts every match exactly once,
    wherever the edge falls.
    """
    counts: dict[str, int] = {}
    low = path.lower()
    with os.fdopen(_open_regular(path), "rb") as raw:
        if not low.endswith(DECOMPRESS_SUFFIXES):
            return counts, _scan_stream(raw, patterns, counts, [0])
        total = [0]
        reader = None
        try:
            with _decompressor(raw, low) as dec:
                reader = _CappedReader(dec)
                _scan_stream(reader, patterns, counts, total)
        except (OSError, EOFError, ValueError, zlib.error, lzma.LZMAError) as exc:
            raise OpaqueArchive(counts, total[0]) from exc
        if reader.error is not None:
            raise OpaqueArchive(counts, total[0]) from reader.error
        return counts, total[0]


def _scan_stream(fh, patterns, counts: dict[str, int], total_box: list[int]) -> int:
    """Chunked scan of fh into `counts` (filled in place, so a failure part-way keeps what was found)."""
    carry = b""
    cur = fh.read(CHUNK)
    while cur:
        nxt = fh.read(CHUNK)
        eof = not nxt
        total_box[0] += len(cur)
        buf = carry + cur
        fresh_from = len(carry)
        first_open = None
        for name, rx in patterns:
            for m in rx.finditer(buf):
                if m.end() < fresh_from:
                    continue  # ended inside the carry: counted in the previous pass
                if not eof and m.end() == len(buf) and len(buf) - m.start() <= MAX_CARRY:
                    # may continue into the next chunk: counted when re-found there
                    first_open = m.start() if first_open is None else min(first_open, m.start())
                    continue
                if m.group(0) in EXAMPLE_VALUES:
                    continue
                counts[name] = counts.get(name, 0) + 1
        cut = max(0, len(buf) - OVERLAP)
        if first_open is not None:
            cut = min(cut, first_open)
        carry = buf[cut:]
        cur = nxt
    return total_box[0]


def run_scan(roots: list[str], install_dir: str, patterns, required=frozenset()):
    findings: list[tuple[str, str, int]] = []
    stats = new_stats()
    for path, kind in iter_files(roots, install_dir, stats, required):
        if kind == "credfile":
            stats["credfiles"] += 1
            findings.append((path, CRED_COPY, 1))
            continue
        try:
            counts, n = scan_file(path, patterns)
        except OpaqueArchive as exc:
            stats["opaque"] += 1
            stats["bytes"] += exc.total
            for name, c in sorted(exc.counts.items()):
                findings.append((path, name, c))
            continue
        except NotRegularFile:
            stats["special"] += 1
            continue
        except FileNotFoundError:
            stats["vanished"] += 1  # rotated or cleaned between listing and open: not a blind spot
            continue
        except OSError as exc:
            _note_error(stats, path, exc)
            continue
        stats["files_scanned"] += 1
        stats["bytes"] += n
        for name, c in sorted(counts.items()):
            findings.append((path, name, c))
    return findings, stats


def pipeline_check() -> list[str]:
    """Run the canaries through the REAL walk -> read -> count path in a private temp directory.

    The regex-only check proves the patterns; this proves the traversal, chunking, counting and the
    credential-copy rule are alive. Returns what was missed (empty list = pipeline works)."""
    known = make_known_patterns([("known:__canary__", b"canary-known-" + b"Q" * 30)])
    patterns = list(PATTERNS) + known
    try:
        tmp = tempfile.mkdtemp(prefix="tsg-canary-")
    except OSError:
        return ["pipeline-unavailable"]
    try:
        body = b"".join(b"x " + s + b" y\n" for _n, s in _canaries()) + b"z canary-known-" + b"Q" * 30 + b" z\n"
        with open(os.path.join(tmp, "canary.jsonl"), "wb") as fh:
            fh.write(body)
        with open(os.path.join(tmp, ".env"), "wb"):
            pass
        findings, _stats = run_scan([tmp], "/nonexistent", patterns, frozenset([tmp]))
    except OSError:
        return ["pipeline-unavailable"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    got = {(os.path.basename(p), n): c for p, n, c in findings}
    missed = [n for n, _ in _canaries() if got.get(("canary.jsonl", n)) != 1]
    if got.get(("canary.jsonl", "known:__canary__")) != 1:
        missed.append("known-secret")
    if got.get((".env", CRED_COPY)) != 1:
        missed.append(CRED_COPY)
    if len(findings) != len(_canaries()) + 2:
        missed.append("cross-hit")
    return missed


# --- output hygiene -----------------------------------------------------------------------------
def _escape(text: str) -> str:
    out = []
    for ch in text:
        cat = unicodedata.category(ch)
        if ch == "\\":
            out.append("\\\\")
        elif cat in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"):
            out.append(f"\\x{ord(ch):02x}" if ord(ch) < 0x100 else f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    return "".join(out)


def safe_path(path: str, patterns) -> str:
    """Printable, value-free rendering of a path for stdout, the journal and the state file.

    A segment that a credential pattern touches becomes a short hash. Two views are searched: the
    path as it is (a value that contains '/') and the path with its separators dropped (a token cut
    into directory names assembles itself in the printed path). Control, format and unpaired
    surrogate characters are escaped, so a hostile file name cannot forge an output line."""
    segs = path.split(os.sep)
    raws = [os.fsencode(seg) for seg in segs]
    redact = [False] * len(segs)
    for sep in (os.fsencode(os.sep), b""):
        view = sep.join(raws)
        starts, off = [], 0
        for raw in raws:
            starts.append(off)
            off += len(raw) + len(sep)
        for _n, rx in patterns:
            for m in rx.finditer(view):
                for i, raw in enumerate(raws):
                    if raw and m.start() < starts[i] + len(raw) and m.end() > starts[i]:
                        redact[i] = True
    out = []
    for seg, raw, hit in zip(segs, raws, redact):
        out.append("[SEGMENT-REDACTED:" + hashlib.sha256(raw).hexdigest()[:8] + "]" if hit else _escape(seg))
    return os.sep.join(out)


# --- alerting -----------------------------------------------------------------------------------
def load_state(path: str) -> dict:
    """{"alerted": {key: count}, "blind": "<reasons>", "last_complete_at": int}; tolerant of junk."""
    state = {"alerted": {}, "blind": "", "last_complete_at": 0}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        state["alerted"] = {str(k): int(v) for k, v in data.get("alerted", {}).items()}
        state["blind"] = str(data.get("blind", ""))
        state["last_complete_at"] = int(data.get("last_complete_at", 0))
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return state


def save_state(path: str, alerted: dict[str, int], blind: str, last_complete_at: int) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(
            {"alerted": alerted, "blind": blind, "last_complete_at": last_complete_at, "updated_at": int(time.time())},
            fh, sort_keys=True,
        )
    os.replace(tmp, path)


def build_message(new_items: list[tuple[str, str, int]], total_files: int, reasons=()) -> str:
    """Names and counts only. No value or path can reach this string: findings carry none here."""
    parts = []
    if new_items:
        kinds = sorted({n for _, n, _ in new_items})
        parts.append(
            f"{len({p for p, _, _ in new_items})} fájlban új vagy nőtt hitelesítő-találat "
            f"({', '.join(kinds)}); összesen {total_files} érintett fájl"
        )
    if reasons:
        parts.append(f"az őr nem látott mindent ({', '.join(reasons)}), a napi ellenőrzés hiányos")
    return (
        "Projekt: Flotta: titok-őr: " + "; ".join(parts) + ". Érték és útvonal nincs az üzenetben. "
        "Fájllista: python3 store/transcript-secret-guard.py. "
        "Tisztítás: docs/transcript-secret-guard.md (előbb rotáció, utána maszkolás)."
    )


def incomplete_reasons(stats: dict, known_problems: int, known_missing: bool = False) -> list[str]:
    reasons = []
    if stats["files_scanned"] == 0:
        reasons.append("no-files-scanned")
    if stats["roots_missing"]:
        reasons.append("root-missing")
    if stats["roots_empty"]:
        reasons.append("root-empty")
    if stats["errors"]:
        reasons.append("read-errors")
    if stats["opaque"]:
        reasons.append("opaque-archives")
    if known_problems:
        reasons.append("known-secrets-unreadable")
    if known_missing:
        reasons.append("known-secrets-missing")
    return reasons


def send_notice(notify_cmd: str, msg: str) -> bool:
    try:
        return subprocess.run([notify_cmd, msg], capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def blind_notice(args, state_path: str, notify_cmd: str, reasons: list[str]) -> None:
    """One deduplicated notice for a way of being blind that happens BEFORE the scan (bad config, a
    pattern that misses its canary, a crash). Same state key as the post-scan blindness: the same
    cause does not page twice, a new cause does. Never advances `last_complete_at`."""
    if not (args.alert or args.alert_dryrun):
        return
    key = ",".join(reasons)
    state = load_state(state_path)
    if key == state["blind"]:
        return
    msg = build_message([], 0, reasons)
    if args.alert_dryrun:
        print(f"ALERT_DRYRUN\t{msg}")
        return
    if not send_notice(notify_cmd, msg):
        sys.stderr.write("transcript-secret-guard: blindness notice could not be sent; state not advanced\n")
        return
    try:
        save_state(state_path, state["alerted"], key, state["last_complete_at"])
    except OSError as exc:
        sys.stderr.write(f"transcript-secret-guard: cannot write state ({errno.errorcode.get(exc.errno or 0, 'OSError')})\n")


def check_freshness(args, state_path: str, notify_cmd: str) -> int:
    """Dead-man's switch: has the daily run completed recently? Reads the state file only.

    A guard that is not run at all (timer off, unit killed by its timeout, host asleep) reports nothing,
    so its silence has to be noticed from outside. `unarmed` = no state file yet (no real --alert run has
    completed), which is not an alarm unless --require-state is given."""
    now = int(time.time())
    limit = args.max_age_hours * 3600
    last = 0
    if not os.path.exists(state_path):
        status = "missing" if args.require_state else "unarmed"
    else:
        last = load_state(state_path)["last_complete_at"]
        if last <= 0:
            status = "never"
        elif now - last > limit:
            status = "stale"
        else:
            status = "fresh"
    age = "-" if last <= 0 else f"{(now - last) / 3600:.1f}"
    print(f"FRESHNESS\tstatus={status}\tage_hours={age}\tmax_age_hours={args.max_age_hours}")
    if status in ("fresh", "unarmed"):
        return EXIT_OK
    if args.alert or args.alert_dryrun:
        when = "még nem fejeződött be" if last <= 0 else f"{(now - last) / 3600:.0f} órája fejeződött be utoljára"
        msg = (
            f"Projekt: Flotta: titok-őr: a napi ellenőrzés hiánytalan futása {when} (küszöb: "
            f"{args.max_age_hours} óra, állapot: {status}). Az őr nem fut, nem ér a végére, vagy nem tud riasztani. "
            "Teendő: a unit naplója és docs/transcript-secret-guard.md."
        )
        if args.alert_dryrun:
            print(f"ALERT_DRYRUN\t{msg}")
        elif not send_notice(notify_cmd, msg):
            sys.stderr.write("transcript-secret-guard: freshness notice could not be sent\n")
            return EXIT_ALERT_FAILED
    return EXIT_BLIND


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="transcript-secret-guard.py", add_help=True)
    ap.add_argument("--root", action="append", default=[], help="extra directory to scan (repeatable)")
    ap.add_argument("--only-roots", action="store_true", help="scan only the --root dirs (tests)")
    ap.add_argument("--home", default=os.path.expanduser("~"))
    ap.add_argument("--state", default=None)
    ap.add_argument("--extra-patterns", default=os.environ.get("TRANSCRIPT_GUARD_EXTRA") or None)
    ap.add_argument("--secrets-base", default=None, help="install dir whose secret files are loaded (tests)")
    ap.add_argument("--alert", action="store_true")
    ap.add_argument("--alert-dryrun", action="store_true")
    ap.add_argument("--notify-cmd", default=None)
    ap.add_argument("--quiet", action="store_true", help="print only the summary line")
    ap.add_argument("--check-freshness", action="store_true",
                    help="do not scan: exit 3 if the last complete run is older than --max-age-hours")
    ap.add_argument("--max-age-hours", type=int, default=36)
    ap.add_argument("--require-state", action="store_true",
                    help="with --check-freshness: a missing state file is an alarm, not 'unarmed'")
    args = ap.parse_args(argv)

    install_dir = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    state_path = args.state or os.path.join(install_dir, "store", ".transcript-secret-guard-state.json")
    notify_cmd = args.notify_cmd or os.path.join(install_dir, "scripts", "notify.sh")

    if args.check_freshness:
        return check_freshness(args, state_path, notify_cmd)
    try:
        return scan_main(args, install_dir, state_path, notify_cmd)
    except Exception as exc:  # a crash must look like blindness (and page), never like a quiet failure
        # Type and errno only: an exception message can carry a file name, and a file name can be a token.
        why = type(exc).__name__ + (f"/{errno.errorcode.get(exc.errno or 0, 'E')}" if isinstance(exc, OSError) else "")
        sys.stderr.write(f"transcript-secret-guard: BLIND, unexpected error: {why}\n")
        blind_notice(args, state_path, notify_cmd, ["crash-" + type(exc).__name__])
        return EXIT_BLIND


def scan_main(args, install_dir: str, state_path: str, notify_cmd: str) -> int:
    if CHUNK_ERROR:
        sys.stderr.write(f"transcript-secret-guard: BLIND, {CHUNK_ERROR}\n")
        blind_notice(args, state_path, notify_cmd, ["chunk-env-invalid"])
        return EXIT_BLIND

    patterns = list(PATTERNS)
    if args.extra_patterns:
        try:
            patterns += load_extra_patterns(args.extra_patterns)
        except (OSError, ValueError) as exc:
            sys.stderr.write(f"transcript-secret-guard: cannot load extra patterns: {exc}\n")
            blind_notice(args, state_path, notify_cmd, ["extra-patterns-invalid"])
            return EXIT_USAGE

    blind = self_check(PATTERNS) + pipeline_check()
    if blind:
        sys.stderr.write(f"transcript-secret-guard: BLIND, built-in checks fail: {', '.join(blind)}\n")
        blind_notice(args, state_path, notify_cmd, ["builtin-check:" + "+".join(blind)])
        return EXIT_BLIND

    known, known_problems, known_skipped = load_known_secrets(args.secrets_base or install_dir, args.home)
    known_missing = REQUIRED_KNOWN not in {label for label, _v in known}
    patterns += make_known_patterns(known)

    if args.only_roots:
        roots = list(args.root)
        required = frozenset(args.root)
        scan_install = "/nonexistent"
    else:
        roots = default_roots(args.home, install_dir) + list(args.root)
        required = frozenset(required_roots(args.home)) | frozenset(args.root)
        scan_install = install_dir
    t0 = time.time()
    findings, stats = run_scan(roots, scan_install, patterns, required)
    dur = time.time() - t0
    reasons = incomplete_reasons(stats, known_problems, known_missing)

    shown = [(safe_path(p, patterns), n, c) for p, n, c in findings]
    if not args.quiet:
        for path, name, count in shown:
            print(f"FINDING\t{path}\t{name}\tcount={count}")
    for path, code in stats["error_paths"]:
        sys.stderr.write(f"ERROR\t{safe_path(path, patterns)}\t{code}\n")
    files_hit = len({p for p, _, _ in findings})
    print(
        f"SUMMARY\tfiles_scanned={stats['files_scanned']}\tbytes={stats['bytes']}\t"
        f"skipped={stats['skipped']}\terrors={stats['errors']}\tfiles_with_findings={files_hit}\t"
        f"findings={len(findings)}\tseconds={dur:.1f}\tspecial={stats['special']}\t"
        f"opaque={stats['opaque']}\tvanished={stats['vanished']}\tcredfiles={stats['credfiles']}\t"
        f"known_secrets={len(known)}\tknown_skipped={known_skipped}\tincomplete={','.join(reasons) or '-'}"
    )

    rc = EXIT_BLIND if reasons else (EXIT_FINDINGS if findings else EXIT_OK)
    if not (args.alert or args.alert_dryrun):
        return rc

    state = load_state(state_path)
    previous = state["alerted"]
    current = {f"{p}|{n}": c for p, n, c in shown}
    new_items = [(p, n, c) for p, n, c in shown if c > previous.get(f"{p}|{n}", 0)]
    reason_key = ",".join(reasons)
    blind_new = bool(reasons) and reason_key != state["blind"]
    # An incomplete run did not see everything: keep what was alerted before instead of forgetting it.
    store = {**previous, **current} if reasons else current
    complete_at = state["last_complete_at"] if reasons else int(time.time())

    if not new_items and not blind_new:
        if not args.alert_dryrun:
            save_state(state_path, store, reason_key, complete_at)
        return EXIT_BLIND if reasons else EXIT_OK
    msg = build_message(new_items, files_hit, reasons if blind_new else ())
    if args.alert_dryrun:
        print(f"ALERT_DRYRUN\t{msg}")
        return rc
    if not send_notice(notify_cmd, msg):
        sys.stderr.write("transcript-secret-guard: alert could not be sent; state not advanced\n")
        return EXIT_BLIND if reasons else EXIT_ALERT_FAILED
    save_state(state_path, store, reason_key, complete_at)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
