#!/usr/bin/env python3
"""Static scan for card 0aba66b8 (CYBERED NO-GO on 8c291307): flag any shell script that assigns
a var from `mktemp`, writes an `Authorization:` header into it, and uses it in a `curl -H @...`,
but has no `trap ... EXIT` (direct, or via a named cleanup function) that removes that same var.

Bash runs the EXIT trap on termination by an untrapped fatal signal (e.g. SIGTERM) too, not only
on normal exit -- that is the whole safety argument for the stdin-free "trap cleanup EXIT" pattern
used across this repo. A var with no such trap anywhere survives a kill mid-run with the real
Bearer token still sitting on disk.

Usage: token-header-no-tempfile-scan.py <dir> [<dir> ...]
Prints one "scanned: <n>" line (candidate var count, so the caller can assert non-vacuity),
then one "FLAGGED: <path> <var>" line per file+var with no matching EXIT-trap cleanup.
"""
import re
import sys
import os

MKTEMP_VAR_RE = re.compile(r'(\w+)=\"?\$?\(?\s*`?\s*mktemp\b')
AUTH_RE = re.compile(r'Authorization:')
HEADER_USE_TMPL = r'-H\s+@\"?\$\{{?{0}\b'
TRAP_EXIT_QUOTED_RE = re.compile(r'trap\s+([\'"])(.*?)\1\s+EXIT\b', re.DOTALL)
TRAP_EXIT_BARE_RE = re.compile(r'trap\s+(\w+)\s+EXIT\b')
FUNC_DEF_TMPL = r'\b{0}\s*\(\)\s*\{{(.*?)\}}'


def file_candidates(src):
    return sorted(set(MKTEMP_VAR_RE.findall(src)))


def has_auth_use(src, var):
    uses_as_header = re.search(HEADER_USE_TMPL.format(re.escape(var)), src)
    return bool(uses_as_header) and bool(AUTH_RE.search(src))


def exit_trap_cleans(src, var):
    var_ref_re = re.compile(r'\$\{?' + re.escape(var) + r'\b')
    for _, cmd in TRAP_EXIT_QUOTED_RE.findall(src):
        if var_ref_re.search(cmd):
            return True
    for fn_name in TRAP_EXIT_BARE_RE.findall(src):
        body_match = re.search(FUNC_DEF_TMPL.format(re.escape(fn_name)), src, re.DOTALL)
        if body_match and var_ref_re.search(body_match.group(1)):
            return True
    return False


def scan_dir(d):
    results = []
    scanned = 0
    for name in sorted(os.listdir(d)):
        if not name.endswith('.sh'):
            continue
        path = os.path.join(d, name)
        try:
            src = open(path, encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        for var in file_candidates(src):
            if not has_auth_use(src, var):
                continue
            scanned += 1
            if not exit_trap_cleans(src, var):
                results.append((path, var))
    return scanned, results


def main():
    dirs = sys.argv[1:]
    if not dirs:
        print("usage: token-header-no-tempfile-scan.py <dir> [<dir> ...]", file=sys.stderr)
        return 2
    total_scanned = 0
    all_flagged = []
    for d in dirs:
        scanned, flagged = scan_dir(d)
        total_scanned += scanned
        all_flagged.extend(flagged)
    print(f"scanned: {total_scanned}")
    for path, var in all_flagged:
        print(f"FLAGGED: {path} {var}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
