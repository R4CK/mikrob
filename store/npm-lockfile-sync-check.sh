#!/usr/bin/env bash
# npm-lockfile-sync-check.sh -- does this commit's package-lock.json still match its package.json?
# (card c3f052ad)
#
# THE GAP THIS FILLS. Card fe06da0c found that store/lockfile-sync-check.sh is pnpm-only, and that
# on marveen -- an npm repo with no pnpm-lock.yaml -- it was reporting ERR_PNPM_NO_LOCKFILE as
# "OUT OF SYNC" on every landing. That false [fail] is fixed, but fixing it left marveen with NO
# lockfile check at all: a real drift (a dependency declared in package.json without regenerating
# the lock) would still reach the deploy unseen, which is exactly the incident class that produced
# the pnpm check in the first place (cards 8d673233 and af7441a3, twice in one day).
#
# WHY A STRUCTURAL COMPARISON AND NOT `npm ci`. The pnpm check runs a real frozen install, which it
# can do in ~0.5s. `npm ci` resolves against the registry, so the npm equivalent would need the
# network on every landing and would fail for reasons that are not facts about the card -- exactly
# the "harness fault reported as a verdict" this family of scripts refuses to do. lockfileVersion 3
# makes the comparison unnecessary anyway: `packages[""]` carries a copy of the root package.json's
# dependency blocks, so drift is a pure data question, answerable offline and deterministically.
#
# WHAT IS COMPARED, AND WHAT IS DELIBERATELY NOT. Only the four dependency blocks
# (dependencies, devDependencies, optionalDependencies, peerDependencies), name for name and
# specifier for specifier.
#
# The `version` FIELDS ARE NEVER COMPARED, and that is load-bearing rather than an oversight:
# marveen-land.sh bumps package.json to `X.Y.Z+mikrob.N` on every landing while
# bump-fork-version.sh deliberately keeps the lockfile at plain `X.Y.Z` (npm expects the suffix-free
# form there). Comparing versions would recreate the every-landing false [fail] that card fe06da0c
# just removed. There is a test pinning this, so a future "improvement" cannot quietly reintroduce
# the noise.
#
# FROM THE COMMIT, not the working tree -- same reason as the pnpm check: a gate reads a sha, so
# does this. `git show <ref>:<path>`.
#
# Usage:
#   npm-lockfile-sync-check.sh --repo <path> [--ref <ref>] [--base <ref>]
#   npm-lockfile-sync-check.sh --selftest
#
#     --base   when given, the check is SKIPPED unless some package.json changed in base..ref.
#
# Exit: 0 in sync (or not applicable) | 1 OUT OF SYNC | 2 bad usage | 3 harness fault
#
# 3 IS SEPARATE FROM 1, same contract as the pnpm sibling: "this lockfile shape is one I cannot
# read" and "the lockfile is stale" are different facts, and a landing must refuse on 1 but never
# on 3. Concretely, exit 3 covers a lockfileVersion below 3 (no `packages[""]` mirror to compare)
# and a package.json declaring `workspaces` (this check reads the ROOT manifest only, so on a
# workspace repo it would silently under-check -- saying so is better than a comfortable 0).
set -uo pipefail

REPO=""; REF="HEAD"; BASE=""; SELFTEST=0
[ "${1:-}" = "--selftest" ] && SELFTEST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --selftest) shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The comparison itself, kept in one place so the selftest drives the SAME code the landing does.
# Prints a human-readable verdict; exit 0 in sync / not applicable, 1 drift, 3 unreadable shape.
# The two documents travel as FILES, not environment variables. Measured the first time this ran
# against the real repo: marveen's package-lock.json is ~480 entries, and putting it in the
# environment gave `/usr/bin/python3: Argument list too long` (E2BIG) -- exit 126, which is neither
# a verdict nor one of this script's documented codes. The selftest missed it because its fixtures
# are three-line literals; there is now a case with a realistically large lockfile.
compare_manifests() {
  local pkg_json="$1" lock_json="$2" ref="$3"
  local tmpd; tmpd="$(mktemp -d)" || { echo "npm-lockfile-sync: HARNESS FAULT -- mktemp failed" >&2; return 3; }
  printf '%s' "$pkg_json"  >"$tmpd/package.json"
  printf '%s' "$lock_json" >"$tmpd/package-lock.json"
  PKG_FILE="$tmpd/package.json" LOCK_FILE="$tmpd/package-lock.json" REFNAME="$ref" python3 - <<'PY'
import json, os, sys

try:
    pkg = json.load(open(os.environ['PKG_FILE'], encoding='utf-8'))
    lock = json.load(open(os.environ['LOCK_FILE'], encoding='utf-8'))
except Exception as e:
    print(f'npm-lockfile-sync: HARNESS FAULT -- unparseable manifest: {e}', file=sys.stderr)
    sys.exit(3)

ref = os.environ['REFNAME']

if pkg.get('workspaces'):
    print('npm-lockfile-sync: HARNESS FAULT -- package.json declares workspaces; this check reads '
          'the root manifest only and would under-check', file=sys.stderr)
    sys.exit(3)

if lock.get('lockfileVersion', 0) < 3 or '' not in (lock.get('packages') or {}):
    print(f'npm-lockfile-sync: HARNESS FAULT -- lockfileVersion '
          f'{lock.get("lockfileVersion")!r} has no packages[""] mirror to compare', file=sys.stderr)
    sys.exit(3)

root = lock['packages']['']
BLOCKS = ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')
problems = []
for block in BLOCKS:
    declared = pkg.get(block) or {}
    locked = root.get(block) or {}
    added = sorted(n for n in declared if n not in locked)
    removed = sorted(n for n in locked if n not in declared)
    changed = sorted(n for n in declared if n in locked and declared[n] != locked[n])
    if added:
        problems.append(f'{block}: were added to package.json but not the lockfile: {", ".join(added)}')
    if removed:
        problems.append(f'{block}: were removed from package.json but are still in the lockfile: {", ".join(removed)}')
    for n in changed:
        problems.append(f'{block}: specifiers differ for {n} (package.json {declared[n]!r} vs lockfile {locked[n]!r})')

if problems:
    print(f'npm-lockfile-sync: OUT OF SYNC at {ref} -- package.json and package-lock.json disagree')
    for p in problems:
        print(f'  {p}')
    sys.exit(1)

n = sum(len(pkg.get(b) or {}) for b in BLOCKS)
print(f'npm-lockfile-sync: OK -- {n} declared dependency/dependencies at {ref} match package-lock.json')
sys.exit(0)
PY
  local rc=$?
  rm -rf "$tmpd"
  return $rc
}

if [ "$SELFTEST" -eq 1 ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }

  mk() { printf '%s' "$1"; }

  # in sync
  compare_manifests '{"dependencies":{"a":"^1.0.0"},"devDependencies":{"b":"^2.0.0"}}' \
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"a":"^1.0.0"},"devDependencies":{"b":"^2.0.0"}}}}' T >/dev/null 2>&1
  t "matching dependency blocks are in sync" "$?" "0"

  # THE DEFECT: a dependency declared but not locked
  compare_manifests '{"dependencies":{"a":"^1.0.0","new-dep":"^3.0.0"}}' \
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"a":"^1.0.0"}}}}' T >/dev/null 2>&1
  t "a dependency added to package.json but not the lockfile is DRIFT" "$?" "1"

  out="$(compare_manifests '{"dependencies":{"a":"^1.0.0","new-dep":"^3.0.0"}}' \
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"a":"^1.0.0"}}}}' T 2>&1)"
  t "and it NAMES the package" "$(printf '%s' "$out" | grep -c 'new-dep')" "1"

  # removed, and specifier-changed
  compare_manifests '{"dependencies":{}}' \
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"gone":"^1.0.0"}}}}' T >/dev/null 2>&1
  t "a dependency removed from package.json but left in the lockfile is DRIFT" "$?" "1"

  compare_manifests '{"dependencies":{"a":"^2.0.0"}}' \
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"a":"^1.0.0"}}}}' T >/dev/null 2>&1
  t "a changed specifier is DRIFT" "$?" "1"

  # THE FALSE POSITIVE THIS MUST NEVER HAVE (card fe06da0c): version fields differ BY DESIGN.
  compare_manifests '{"version":"1.34.1+mikrob.57","dependencies":{"a":"^1.0.0"}}' \
    '{"lockfileVersion":3,"version":"1.34.1","packages":{"":{"version":"1.34.1","dependencies":{"a":"^1.0.0"}}}}' T >/dev/null 2>&1
  t "the +mikrob.N version suffix is NOT drift -- bump-fork-version.sh keeps them different on purpose" "$?" "0"

  # unreadable shapes are harness faults, never verdicts
  compare_manifests '{"dependencies":{}}' '{"lockfileVersion":1,"dependencies":{}}' T >/dev/null 2>&1
  t "lockfileVersion 1 has no packages[\"\"] mirror -> HARNESS FAULT, not a verdict" "$?" "3"

  compare_manifests '{"workspaces":["packages/*"],"dependencies":{}}' \
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{}}}}' T >/dev/null 2>&1
  t "a workspace repo is a HARNESS FAULT (root-only check would under-check)" "$?" "3"

  compare_manifests 'not json' '{"lockfileVersion":3,"packages":{"":{}}}' T >/dev/null 2>&1
  t "unparseable input is a HARNESS FAULT" "$?" "3"

  # SIZE, not just shape: the first live run died with E2BIG because the documents travelled in
  # the environment. Every fixture above is a three-line literal, so none of them could show it.
  big_lock="$(python3 -c "
import json
pkgs = {'': {'dependencies': {'a': '^1.0.0'}}}
for i in range(2000):
    pkgs['node_modules/dep%d' % i] = {'version': '1.0.%d' % i, 'resolved': 'https://registry.npmjs.org/dep%d/-/dep%d-1.0.%d.tgz' % (i, i, i), 'integrity': 'sha512-' + 'x' * 80}
print(json.dumps({'lockfileVersion': 3, 'packages': pkgs}))
")"
  compare_manifests '{"dependencies":{"a":"^1.0.0"}}' "$big_lock" T >/dev/null 2>&1
  t "a realistically large lockfile does not blow the argument limit" "$?" "0"

  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

[ -n "$REPO" ] || { echo "usage: npm-lockfile-sync-check.sh --repo <path> [--ref <ref>] [--base <ref>]" >&2; exit 2; }
[ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || { echo "not a git repo: $REPO" >&2; exit 2; }
git -C "$REPO" rev-parse --verify "$REF" >/dev/null 2>&1 || { echo "no such ref: $REF" >&2; exit 2; }

if [ -n "$BASE" ]; then
  git -C "$REPO" rev-parse --verify "$BASE" >/dev/null 2>&1 || { echo "no such base ref: $BASE" >&2; exit 2; }
  if ! git -C "$REPO" diff --name-only "$BASE" "$REF" 2>/dev/null | grep -qE '(^|/)package\.json$'; then
    echo "npm-lockfile-sync: not applicable (no package.json changed in $BASE..$REF)"
    exit 0
  fi
fi

# Not an npm repo -> not applicable, exactly as the pnpm sibling treats a missing pnpm-lock.yaml.
if ! git -C "$REPO" cat-file -e "$REF:package-lock.json" 2>/dev/null; then
  echo "npm-lockfile-sync: not applicable (no package-lock.json at $REF -- this repo does not use npm)"
  exit 0
fi
if ! git -C "$REPO" cat-file -e "$REF:package.json" 2>/dev/null; then
  echo "npm-lockfile-sync: HARNESS FAULT -- no package.json at $REF" >&2
  exit 3
fi

PKG_JSON="$(git -C "$REPO" show "$REF:package.json" 2>/dev/null)"
LOCK_JSON="$(git -C "$REPO" show "$REF:package-lock.json" 2>/dev/null)"
compare_manifests "$PKG_JSON" "$LOCK_JSON" "$REF"
