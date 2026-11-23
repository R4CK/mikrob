#!/usr/bin/env bash
# npm-ci-advisory-check.sh -- decides whether sync_live_install's "run npm ci by hand" advisory
# should fire (card 426adb21).
#
# Measured 2026-11-20: the advisory used to fire on ANY diff in package.json/package-lock.json
# across the fast-forward -- including the fork-own version bump (bump-fork-version.sh), which
# touches package.json's "version" field on EVERY landing. Four landings in one day (e5c13c0e,
# 11c6cab4, ebe20efe, 1c8f6d25) printed the advisory with package-lock.json byte-identical and
# package.json differing only in "version" -- one agent ran npm ci on the live install because of
# it (11c6cab4), risky if another agent's fleet-test.sh is reading that same node_modules at the
# time. Reproduced again on c4590365 (merge 1f2744597, base d5374f947): empty diff on both files
# for the merge itself, advisory still fired off the separate version-bump commit.
#
# Rule (card 426adb21 "Kesz, ha"): advise when package-lock.json changed AT ALL, or when
# package.json changed in any field OTHER than the top-level "version" string. A pure
# +mikrob.N (or X.Y.Z) bump with an unchanged lockfile is exactly the case bump_fork_version
# produces on most landings (see bump-fork-version.sh: the lockfile's own version lines only move
# when X.Y.Z itself changes, not on an N-only bump) -- that case must NOT advise.
#
# Usage (sourced, the normal path -- see marveen-land.sh sync_live_install):
#   . npm-ci-advisory-check.sh
#   if npm_ci_advisory_needed "$MAIN" "$before" "$after"; then ...; fi
#
# Usage (direct, selftest only):
#   npm-ci-advisory-check.sh --selftest

set -uo pipefail

# npm_ci_advisory_needed <repo> <before-sha> <after-sha>
# Returns 0 (true, advise) or 1 (false, no advisory needed).
npm_ci_advisory_needed() {
  local repo="$1" before="$2" after="$3"

  # Any lockfile change at all -- including a lockfile-only version-field move -- advises, per the
  # card's literal acceptance criterion ("any lockfile change -> advisory"). This also covers the
  # case bump_fork_version produces when X.Y.Z itself moves (upstream-sync bump): the lockfile's
  # version lines change together with package.json's, and that is deliberately NOT exempted here.
  if ! git -C "$repo" diff --quiet "$before" "$after" -- package-lock.json 2>/dev/null; then
    return 0
  fi

  # package.json unchanged -> nothing to advise on.
  if git -C "$repo" diff --quiet "$before" "$after" -- package.json 2>/dev/null; then
    return 1
  fi

  # package.json changed and the lockfile did not -- advise only if something OTHER than the
  # top-level "version" field moved. Parses both blobs as JSON rather than pattern-matching the
  # diff text (guards-that-pin-behaviour: a comment or a reordered key must not fool this), and
  # fails CLOSED (advise) on anything unparsable -- a malformed package.json is itself a reason to
  # look, not a reason to stay quiet.
  if python3 -I -c '
import sys, json, subprocess

def load(repo, ref, path):
    try:
        out = subprocess.run(["git", "-C", repo, "show", f"{ref}:{path}"],
                              capture_output=True, check=True)
        data = json.loads(out.stdout)
    except Exception:
        return None
    return data if isinstance(data, dict) else None

repo, before, after = sys.argv[1], sys.argv[2], sys.argv[3]
b = load(repo, before, "package.json")
a = load(repo, after, "package.json")
if b is None or a is None:
    sys.exit(0)  # unparsable -- fail closed, advise
b.pop("version", None)
a.pop("version", None)
sys.exit(0 if b != a else 1)
' "$repo" "$before" "$after"; then
    return 0
  fi
  return 1
}

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  R="$TMP/repo"
  git init -q "$R"
  git -C "$R" config user.email s@s
  git -C "$R" config user.name s

  t() {
    n=$((n+1))
    local label="$1" expect="$2" got="$3"
    [ "$got" = "$expect" ] || { echo "  FAIL $label: got [$got] want [$expect]"; fail=1; }
  }

  check() {
    local before="$1" after="$2"
    if npm_ci_advisory_needed "$R" "$before" "$after"; then echo advise; else echo no-advise; fi
  }

  # Case 1 (card's own acceptance criterion): version-only bump -> no advisory.
  printf '{\n  "name": "t",\n  "version": "1.0.0+mikrob.1",\n  "dependencies": {"x": "1.0.0"}\n}\n' > "$R/package.json"
  printf '{\n  "name": "t",\n  "version": "1.0.0",\n  "packages": {"": {"name": "t", "version": "1.0.0"}}\n}\n' > "$R/package-lock.json"
  git -C "$R" add -A && git -C "$R" commit -qm c1
  BASE="$(git -C "$R" rev-parse HEAD)"

  printf '{\n  "name": "t",\n  "version": "1.0.0+mikrob.2",\n  "dependencies": {"x": "1.0.0"}\n}\n' > "$R/package.json"
  git -C "$R" add -A && git -C "$R" commit -qm c2
  VERSION_ONLY="$(git -C "$R" rev-parse HEAD)"
  t "version-only bump" no-advise "$(check "$BASE" "$VERSION_ONLY")"

  # Case 2 (card's own acceptance criterion): dependency change in package.json -> advisory.
  git -C "$R" checkout -q "$BASE"
  printf '{\n  "name": "t",\n  "version": "1.0.0+mikrob.1",\n  "dependencies": {"x": "1.0.0", "y": "2.0.0"}\n}\n' > "$R/package.json"
  git -C "$R" add -A && git -C "$R" commit -qm c3
  DEP_CHANGE="$(git -C "$R" rev-parse HEAD)"
  t "dependency change (package.json)" advise "$(check "$BASE" "$DEP_CHANGE")"

  # Case 3: lockfile change alone (package.json untouched) -> advisory.
  git -C "$R" checkout -q "$BASE"
  printf '{\n  "name": "t",\n  "version": "1.0.0",\n  "packages": {"": {"name": "t", "version": "1.0.0"}}, "extra": 1\n}\n' > "$R/package-lock.json"
  git -C "$R" add -A && git -C "$R" commit -qm c4
  LOCK_ONLY="$(git -C "$R" rev-parse HEAD)"
  t "lockfile-only change" advise "$(check "$BASE" "$LOCK_ONLY")"

  # Case 4: scripts field changed (not a dependency, still not "version") -> advisory.
  git -C "$R" checkout -q "$BASE"
  printf '{\n  "name": "t",\n  "version": "1.0.0+mikrob.1",\n  "dependencies": {"x": "1.0.0"}, "scripts": {"build": "x"}\n}\n' > "$R/package.json"
  git -C "$R" add -A && git -C "$R" commit -qm c5
  SCRIPTS_CHANGE="$(git -C "$R" rev-parse HEAD)"
  t "scripts field change" advise "$(check "$BASE" "$SCRIPTS_CHANGE")"

  # Case 5: no change at all -> no advisory (control).
  t "no change (control)" no-advise "$(check "$BASE" "$BASE")"

  echo "selftest: $n checks, $fail failed"
  exit "$fail"
fi
