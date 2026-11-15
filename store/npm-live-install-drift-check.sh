#!/usr/bin/env bash
# npm-live-install-drift-check.sh -- does the INSTALLED node_modules on disk still match this
# repo's package-lock.json? (card dd051a9f)
#
# THE GAP THIS FILLS. store/npm-lockfile-sync-check.sh answers a different question: is
# package-lock.json itself stale relative to package.json's declared dependencies (a commit-level,
# git-object check). It says nothing about whether the files actually sitting in node_modules/ on
# a given disk match that lockfile. Those two can drift independently: marveen-land.sh's
# sync_live_install() fast-forwards the LIVE checkout's package.json/package-lock.json on every
# landing, but on PURPOSE never runs `npm ci` there (card 5d365589 N3 -- an unattended install
# against whatever the live service happens to be doing at that moment is its own risk). The
# fast-forward prints a "run npm ci by hand" line, but marveen-land.sh runs backgrounded
# (`nohup ... > log 2>&1 &`, measured ~348 times -- see land-run-journal.sh), so that line lands in
# a log file nobody is tailing. Measured incident (cards 970a90c3/a4a6a5e5 landing, flagged twice
# by fullstack at msg 11383/11399 before anyone noticed from the log): the live node_modules served
# the OLD dependency set for an unknown period after the lockfile had already moved on.
#
# WHAT IS COMPARED, AND WHAT IS NOT. npm writes node_modules/.package-lock.json to reflect what it
# ACTUALLY installed last -- not a static manifest, a fact about the disk. Comparing it to the
# repo's package-lock.json (both lockfileVersion 3, both carrying a `packages` map) answers the real
# question directly, offline, with no registry call: for every package.json-declared dependency
# (non-optional) in package-lock.json, is its EXACT version present in node_modules/.package-lock.json
# too? Optional (platform-specific) entries are skipped on purpose: a Linux x64 box never installs
# the darwin/win32 binaries, and flagging that as drift would make every run read as drift.
#
# Usage:
#   npm-live-install-drift-check.sh --repo <path>
#   npm-live-install-drift-check.sh --selftest
#
# Exit: 0 IN SYNC | 1 DRIFT (node_modules needs a reinstall) | 2 bad usage | 3 harness fault
# (lockfileVersion < 3, or node_modules/.package-lock.json missing/unreadable -- a fact the script
# cannot check, not a verdict that it is in sync).
set -uo pipefail

REPO=""; SELFTEST=0
[ "${1:-}" = "--selftest" ] && SELFTEST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --selftest) shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The comparison itself, kept in one function so the selftest drives the exact same code the
# heartbeat does. Takes the two lockfile CONTENTS as strings (so the selftest can feed fixtures
# without touching disk), returns the verdict on stdout/exit code.
#
# Content travels via FILES, not environment variables (same fix npm-lockfile-sync-check.sh needed
# for the same reason): marveen's package-lock.json is large enough that putting it in the
# environment hits `/usr/bin/python3: Argument list too long` (E2BIG, exit 126) -- measured here,
# not guessed, which is exactly the "harness fault reported as something else" this script exists
# to avoid in its own verdict.
compare_lockfiles() {
  local repo_lock="$1" installed_lock="$2"
  local tmpd; tmpd="$(mktemp -d)" || { echo "npm-live-install-drift: HARNESS FAULT -- mktemp failed" >&2; return 3; }
  printf '%s' "$repo_lock" >"$tmpd/repo-lock.json"
  printf '%s' "$installed_lock" >"$tmpd/installed-lock.json"
  REPO_LOCK_FILE="$tmpd/repo-lock.json" INSTALLED_LOCK_FILE="$tmpd/installed-lock.json" python3 - <<'PY'
import json, os, sys

try:
    repo_lock = json.load(open(os.environ['REPO_LOCK_FILE'], encoding='utf-8'))
except Exception as e:
    print(f'npm-live-install-drift: HARNESS FAULT -- unparseable package-lock.json: {e}', file=sys.stderr)
    sys.exit(3)

if repo_lock.get('lockfileVersion', 0) < 3 or 'packages' not in repo_lock:
    print(f'npm-live-install-drift: HARNESS FAULT -- lockfileVersion '
          f'{repo_lock.get("lockfileVersion")!r} has no packages map to compare', file=sys.stderr)
    sys.exit(3)

raw = open(os.environ['INSTALLED_LOCK_FILE'], encoding='utf-8').read()
if not raw.strip():
    print('npm-live-install-drift: HARNESS FAULT -- node_modules/.package-lock.json missing or '
          'empty (never installed, or not an npm-managed node_modules)', file=sys.stderr)
    sys.exit(3)
try:
    installed = json.loads(raw)
except Exception as e:
    print(f'npm-live-install-drift: HARNESS FAULT -- unparseable node_modules/.package-lock.json: '
          f'{e}', file=sys.stderr)
    sys.exit(3)

installed_packages = installed.get('packages') or {}
missing = []
mismatched = []
for path, info in repo_lock['packages'].items():
    if path == '' or info.get('optional'):
        continue
    want = info.get('version')
    have_info = installed_packages.get(path)
    if have_info is None:
        missing.append((path, want))
        continue
    have = have_info.get('version')
    if have != want:
        mismatched.append((path, want, have))

if missing or mismatched:
    print('npm-live-install-drift: DRIFT -- installed node_modules does not match package-lock.json '
          f'({len(missing)} missing, {len(mismatched)} version-mismatched)')
    for path, want in missing[:10]:
        print(f'  MISSING {path} (want {want})')
    for path, want, have in mismatched[:10]:
        print(f'  MISMATCH {path}: installed {have}, lockfile wants {want}')
    sys.exit(1)

n = len(repo_lock['packages']) - 1
print(f'npm-live-install-drift: IN SYNC -- {n} non-root package entries, installed matches lockfile')
sys.exit(0)
PY
  local rc=$?
  rm -rf "$tmpd"
  return $rc
}

if [ "$SELFTEST" = "1" ]; then
  pass=0; fail=0
  ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
  bad() { printf '  FAIL %s\n       %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

  BASE_LOCK='{"lockfileVersion":3,"packages":{"":{},"node_modules/foo":{"version":"1.0.0"},"node_modules/opt-thing":{"version":"2.0.0","optional":true}}}'

  out="$(compare_lockfiles "$BASE_LOCK" '{"lockfileVersion":3,"packages":{"":{},"node_modules/foo":{"version":"1.0.0"}}}')"; rc=$?
  [ "$rc" = 0 ] && echo "$out" | grep -q 'IN SYNC' \
    && ok "matching version, optional dep absent -> IN SYNC" \
    || bad "matching case did not report IN SYNC" "rc=$rc out=$out"

  out="$(compare_lockfiles "$BASE_LOCK" '{"lockfileVersion":3,"packages":{"":{},"node_modules/foo":{"version":"0.9.0"}}}')"; rc=$?
  [ "$rc" = 1 ] && echo "$out" | grep -q 'MISMATCH node_modules/foo: installed 0.9.0, lockfile wants 1.0.0' \
    && ok "version mismatch -> DRIFT, names both versions" \
    || bad "mismatch case did not report DRIFT correctly" "rc=$rc out=$out"

  out="$(compare_lockfiles "$BASE_LOCK" '{"lockfileVersion":3,"packages":{"":{}}}')"; rc=$?
  [ "$rc" = 1 ] && echo "$out" | grep -q 'MISSING node_modules/foo' \
    && ok "non-optional package absent from installed lock -> DRIFT" \
    || bad "missing-package case did not report DRIFT" "rc=$rc out=$out"

  out="$(compare_lockfiles '{"lockfileVersion":2,"packages":{}}' '{"lockfileVersion":3,"packages":{}}' 2>&1)"; rc=$?
  [ "$rc" = 3 ] && echo "$out" | grep -q 'HARNESS FAULT' \
    && ok "repo lockfileVersion < 3 -> HARNESS FAULT, not a verdict" \
    || bad "old lockfileVersion did not fault" "rc=$rc out=$out"

  out="$(compare_lockfiles "$BASE_LOCK" '' 2>&1)"; rc=$?
  [ "$rc" = 3 ] && echo "$out" | grep -q 'HARNESS FAULT' \
    && ok "missing/empty node_modules/.package-lock.json -> HARNESS FAULT, not DRIFT" \
    || bad "empty installed lock did not fault" "rc=$rc out=$out"

  out="$(compare_lockfiles "$BASE_LOCK" 'not json' 2>&1)"; rc=$?
  [ "$rc" = 3 ] && echo "$out" | grep -q 'HARNESS FAULT' \
    && ok "unparseable node_modules/.package-lock.json -> HARNESS FAULT" \
    || bad "unparseable installed lock did not fault" "rc=$rc out=$out"

  echo
  echo "npm-live-install-drift-check.selftest: $pass passed, $fail failed"
  [ "$fail" = 0 ]
  exit $?
fi

if [ -z "$REPO" ]; then
  echo "usage: npm-live-install-drift-check.sh --repo <path>" >&2
  exit 2
fi

repo_lock_content="$(cat "$REPO/package-lock.json" 2>/dev/null)"
if [ -z "$repo_lock_content" ]; then
  echo "npm-live-install-drift: HARNESS FAULT -- cannot read $REPO/package-lock.json" >&2
  exit 3
fi
installed_lock_content="$(cat "$REPO/node_modules/.package-lock.json" 2>/dev/null)"

compare_lockfiles "$repo_lock_content" "$installed_lock_content"
exit $?
