#!/usr/bin/env python3
"""Credential-shape guard for session transcripts, scratchpads and logs (card 500f0e3c).

WHY THIS EXISTS. A long-lived Claude setup token once sat as a plaintext export in a shell rc
file; a later measurement found the value in three session transcripts (.jsonl under
~/.claude/projects), several file-history snapshots and a scratchpad backup. Every one of those is a
local file under the same UID, but a transcript share or a bug report would carry the token out.
Nothing looked at those places, so the copies lived until someone happened to grep.

WHAT IT DOES. Walks the places where tool output ends up -- session transcripts, file-history,
scratchpad directories, store/*.log -- and counts well-known credential SHAPES per file.

IT NEVER PRINTS A VALUE. Output is `path / pattern name / count`, nothing else. This is structural,
not a convention: matched bytes are only ever passed to len() and the example-value test, never
decoded, formatted or logged. The self-test asserts that a planted token does not appear anywhere in
stdout, stderr, the state file or the alert message.

IT MUST NOT BE BLIND. A guard that reports zero looks the same on a clean tree and on a broken
regex. Before every scan the guard plants one known-positive per pattern (assembled at run time, so
the file itself carries no credential shape) and refuses to run (exit 3) if any is missed.

SCOPE, DELIBERATELY NARROW.
  * Read-only. Cleanup is a human procedure (docs/transcript-secret-guard.md): masking a shared
    transcript is not something a daily job should do unattended.
  * Files that are SUPPOSED to hold a credential (.env, .credentials.json, *.token, the OAuth token
    file) are never opened. Reporting them would be noise, and reading them would be the opposite
    of the point.
  * Masked placeholders (`sk-ant-oat01-[MASKED-...]`) and truncated displays do not match: every
    pattern needs a run of real token characters directly after the prefix.

ALERTING. `--alert` sends ONE Telegram notice through scripts/notify.sh, only when a (file, pattern)
pair is NEW or its count GREW since the last alert (state file). A finding that stays unresolved
does not re-alert daily; a cleaned finding is forgotten, so a reappearance alerts again. If the
notice cannot be sent the state is NOT advanced (exit 5), so the next run tries again.

Usage:
  transcript-secret-guard.py [--alert|--alert-dryrun] [--root DIR]... [--state FILE]
                             [--extra-patterns FILE] [--notify-cmd CMD] [--quiet]
Exit: 0 clean (or only already-alerted findings with --alert), 4 findings, 3 guard blind,
      2 usage error, 5 alert could not be sent.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time

# --- patterns -----------------------------------------------------------------------------------
# Bytes regexes: transcripts are JSON text, but a scratchpad can hold anything and we never want a
# decode error to hide a hit. Each needs real token characters right after the prefix, so masked
# placeholders and `sk-ant-oat01-...` style truncations are not findings.
_RAW: list[tuple[str, str]] = [
    ("anthropic-setup-token", r"sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}"),
    ("anthropic-api-key", r"sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}"),
    ("github-token", r"gh[pousr]_[A-Za-z0-9]{36,}"),
    ("github-fine-grained-pat", r"github_pat_[A-Za-z0-9_]{50,}"),
    ("telegram-bot-token", r"(?<![0-9A-Za-z])[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])"),
    ("aws-access-key-id", r"(?<![0-9A-Z])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])"),
    ("openai-api-key", r"(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9]{40,}"),
    ("slack-token", r"xox[baprs]-[0-9A-Za-z-]{10,}"),
    ("google-api-key", r"AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])"),
    ("stripe-live-secret", r"sk_live_[0-9A-Za-z]{24,}"),
    # Header alone is documentation noise in transcripts (skills quote it); require a base64 body.
    (
        "private-key-block",
        r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----(?:\\n|\s){0,4}[A-Za-z0-9+/]{60,}",
    ),
]
PATTERNS: list[tuple[str, "re.Pattern[bytes]"]] = [(n, re.compile(p.encode())) for n, p in _RAW]

# Vendor-published example values only (allowing them leaks nothing real).
EXAMPLE_VALUES = frozenset({b"AKIAIOSFODNN7" + b"EXAMPLE"})

# Files that are meant to hold a credential: never opened.
NEVER_OPEN_NAMES = frozenset({".env", ".credentials.json", ".claude-oauth-token", ".dashboard-token"})
NEVER_OPEN_SUFFIXES = (".token",)
SKIP_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".mp3", ".mp4", ".mov", ".zip",
    ".gz", ".tgz", ".bz2", ".xz", ".woff", ".woff2", ".ttf", ".sqlite", ".db",
)

CHUNK = int(os.environ.get("TRANSCRIPT_GUARD_CHUNK", 4 * 1024 * 1024))  # env override: tests only
OVERLAP = 600  # longest shape we match is far below this; keeps a hit that straddles a chunk edge

EXIT_OK, EXIT_USAGE, EXIT_BLIND, EXIT_FINDINGS, EXIT_ALERT_FAILED = 0, 2, 3, 4, 5


def _canaries() -> list[tuple[str, bytes]]:
    """One known-positive per built-in pattern, assembled here so no credential shape is on disk."""
    a36 = b"A" * 36
    return [
        ("anthropic-setup-token", b"sk-ant-" + b"oat01-" + b"Q" * 40),
        ("anthropic-api-key", b"sk-ant-" + b"api03-" + b"Q" * 40),
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


def default_roots(home: str, install_dir: str) -> list[str]:
    roots = [
        os.path.join(home, ".claude", "projects"),
        os.path.join(home, ".claude", "file-history"),
        f"/tmp/claude-{os.getuid()}",
    ]
    for base in glob.glob(os.path.join(install_dir, "agents", "*", ".claude-config")):
        roots.append(os.path.join(base, "projects"))
        roots.append(os.path.join(base, "file-history"))
    return roots


def iter_files(roots: list[str], install_dir: str, stats: dict[str, int]):
    """Yield (path, dev_ino). Roots and files are de-duplicated by inode, because the per-agent
    .claude-config/projects entries point at the same directory as ~/.claude/projects."""
    seen_dirs: set[str] = set()
    seen_files: set[tuple[int, int]] = set()
    all_roots = [r for r in roots if os.path.isdir(r)]
    log_dir = os.path.join(install_dir, "store")
    if os.path.isdir(log_dir):
        for name in sorted(os.listdir(log_dir)):
            if name.endswith(".log"):
                all_roots.append(os.path.join(log_dir, name))
    for root in all_roots:
        real = os.path.realpath(root)
        if real in seen_dirs:
            continue
        seen_dirs.add(real)
        if os.path.isfile(real):
            walker = [(os.path.dirname(real), [], [os.path.basename(real)])]
        else:
            walker = os.walk(real, followlinks=False)  # symlinked dirs are listed but not entered
        for dirpath, dirnames, filenames in walker:
            for name in filenames:
                full = os.path.join(dirpath, name)
                low = name.lower()
                if (
                    os.path.islink(full)
                    or name in NEVER_OPEN_NAMES
                    or low.endswith(NEVER_OPEN_SUFFIXES)
                    or low.endswith(SKIP_SUFFIXES)
                ):
                    stats["skipped"] += 1
                    continue
                try:
                    st = os.stat(full)
                except OSError:
                    stats["skipped"] += 1
                    continue
                key = (st.st_dev, st.st_ino)
                if key in seen_files:
                    continue
                seen_files.add(key)
                yield full


def scan_file(path: str, patterns: list[tuple[str, "re.Pattern[bytes]"]]) -> tuple[dict[str, int], int]:
    """Return ({pattern name: count}, bytes read). Matched bytes never leave this function.

    Chunk edges: each pass sees the last OVERLAP bytes of the previous one. A match that touches
    the end of a non-final buffer is DEFERRED (the next chunk may extend it -- the token classes
    are greedy), and a match that ended strictly before the overlap was already counted. Together
    that counts every match exactly once, wherever the edge falls.
    """
    counts: dict[str, int] = {}
    total = 0
    tail = b""
    with open(path, "rb") as fh:
        cur = fh.read(CHUNK)
        while cur:
            nxt = fh.read(CHUNK)
            eof = not nxt
            total += len(cur)
            buf = tail + cur
            fresh_from = len(tail)
            for name, rx in patterns:
                for m in rx.finditer(buf):
                    if m.end() < fresh_from:
                        continue  # ended inside the overlap: counted in the previous pass
                    if not eof and m.end() == len(buf):
                        continue  # may continue into the next chunk: counted when re-found there
                    if m.group(0) in EXAMPLE_VALUES:
                        continue
                    counts[name] = counts.get(name, 0) + 1
            tail = buf[-OVERLAP:]
            cur = nxt
    return counts, total


def run_scan(roots: list[str], install_dir: str, patterns):
    findings: list[tuple[str, str, int]] = []
    scanned = errors = nbytes = 0
    stats = {"skipped": 0}
    for path in iter_files(roots, install_dir, stats):
        try:
            counts, n = scan_file(path, patterns)
        except OSError:
            errors += 1
            continue
        scanned += 1
        nbytes += n
        for name, c in sorted(counts.items()):
            findings.append((path, name, c))
    return findings, {"files_scanned": scanned, "bytes": nbytes, "skipped": stats["skipped"], "errors": errors}


# --- alerting -----------------------------------------------------------------------------------
def load_state(path: str) -> dict[str, int]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        alerted = data.get("alerted", {})
        return {str(k): int(v) for k, v in alerted.items()}
    except (OSError, ValueError, AttributeError, TypeError):
        return {}


def save_state(path: str, alerted: dict[str, int]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"alerted": alerted, "updated_at": int(time.time())}, fh, sort_keys=True)
    os.replace(tmp, path)


def build_message(new_items: list[tuple[str, str, int]], total_files: int) -> str:
    """Names and counts only. No value can reach this string: findings carry none."""
    kinds = sorted({n for _, n, _ in new_items})
    return (
        f"Projekt: Flotta: titok-őr: {len({p for p, _, _ in new_items})} fájlban új vagy nőtt "
        f"hitelesítő-találat ({', '.join(kinds)}); összesen {total_files} érintett fájl. "
        "Érték nincs az üzenetben. Fájllista: python3 store/transcript-secret-guard.py. "
        "Tisztítás: docs/transcript-secret-guard.md (előbb rotáció, utána maszkolás)."
    )


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="transcript-secret-guard.py", add_help=True)
    ap.add_argument("--root", action="append", default=[], help="extra directory to scan (repeatable)")
    ap.add_argument("--only-roots", action="store_true", help="scan only the --root dirs (tests)")
    ap.add_argument("--home", default=os.path.expanduser("~"))
    ap.add_argument("--state", default=None)
    ap.add_argument("--extra-patterns", default=os.environ.get("TRANSCRIPT_GUARD_EXTRA") or None)
    ap.add_argument("--alert", action="store_true")
    ap.add_argument("--alert-dryrun", action="store_true")
    ap.add_argument("--notify-cmd", default=None)
    ap.add_argument("--quiet", action="store_true", help="print only the summary line")
    args = ap.parse_args(argv)

    install_dir = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    state_path = args.state or os.path.join(install_dir, "store", ".transcript-secret-guard-state.json")
    notify_cmd = args.notify_cmd or os.path.join(install_dir, "scripts", "notify.sh")

    patterns = list(PATTERNS)
    if args.extra_patterns:
        try:
            patterns += load_extra_patterns(args.extra_patterns)
        except (OSError, ValueError) as exc:
            sys.stderr.write(f"transcript-secret-guard: cannot load extra patterns: {exc}\n")
            return EXIT_USAGE

    blind = self_check(PATTERNS)
    if blind:
        sys.stderr.write(f"transcript-secret-guard: BLIND, built-in patterns miss their canary: {', '.join(blind)}\n")
        return EXIT_BLIND

    roots = list(args.root) if args.only_roots else default_roots(args.home, install_dir) + list(args.root)
    t0 = time.time()
    findings, stats = run_scan(roots, install_dir if not args.only_roots else "/nonexistent", patterns)
    dur = time.time() - t0

    if not args.quiet:
        for path, name, count in findings:
            print(f"FINDING\t{path}\t{name}\tcount={count}")
    files_hit = len({p for p, _, _ in findings})
    print(
        f"SUMMARY\tfiles_scanned={stats['files_scanned']}\tbytes={stats['bytes']}\t"
        f"skipped={stats['skipped']}\terrors={stats['errors']}\tfiles_with_findings={files_hit}\t"
        f"findings={len(findings)}\tseconds={dur:.1f}"
    )

    rc = EXIT_FINDINGS if findings else EXIT_OK
    if not (args.alert or args.alert_dryrun):
        return rc

    previous = load_state(state_path)
    current = {f"{p}|{n}": c for p, n, c in findings}
    new_items = [(p, n, c) for p, n, c in findings if c > previous.get(f"{p}|{n}", 0)]
    if not new_items:
        # Forget cleaned findings so a reappearance alerts again; nothing to send now.
        if not args.alert_dryrun and current != previous:
            save_state(state_path, current)
        return EXIT_OK
    msg = build_message(new_items, files_hit)
    if args.alert_dryrun:
        print(f"ALERT_DRYRUN\t{msg}")
        return EXIT_FINDINGS
    try:
        sent = subprocess.run([notify_cmd, msg], capture_output=True, timeout=60)
        ok = sent.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    if not ok:
        sys.stderr.write("transcript-secret-guard: alert could not be sent; state not advanced\n")
        return EXIT_ALERT_FAILED
    save_state(state_path, current)
    return EXIT_FINDINGS


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
