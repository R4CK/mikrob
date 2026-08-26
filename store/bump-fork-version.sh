#!/usr/bin/env bash
# bump-fork-version.sh -- automatic package.json/package-lock.json version bump for a fork-own
# landing (DECISIONS.md 2026-08-20 "Fork-sajat verziojelzes: SemVer build-metadata (+mikrob.N)",
# reconfirmed 2026-08-25, automated per Peti request 2026-08-26).
#
# Format: X.Y.Z+mikrob.N -- X.Y.Z is the upstream Szotasz/marveen version (bumped only by an
# upstream-sync merge, a SEPARATE flow this script never touches), N is the fork's own counter
# WITHIN that X.Y.Z, incrementing by 1 on every fork-own landing. marveen-land.sh lands ONLY
# fork-own agent/*/work branches (upstream syncs are a different, manual flow) -- so every call
# into this script from there is by definition a fork-own landing; no upstream-vs-fork detection
# needed here.
#
# package-lock.json (lockfileVersion 3) carries its OWN "version" fields (top-level + the root
# entry at packages[""].version) that npm expects to match package.json's X.Y.Z -- WITHOUT the
# +mikrob.N build-metadata suffix (matching this repo's existing convention: package-lock.json has
# never carried the suffix). Left unbumped, these silently drift from package.json every landing --
# measured live 2026-08-26: package-lock.json still said 1.33.0 while package.json had moved to
# 1.34.0+mikrob.1. This script re-syncs both files' X.Y.Z together as one step so that gap cannot
# reopen.
#
# Usage (sourced, the normal path -- see marveen-land.sh):
#   . bump-fork-version.sh
#   bump_fork_version "$wt"   # prints the new version string on success, non-zero + stderr on failure
#
# Usage (direct, selftest only):
#   bump-fork-version.sh --selftest

set -uo pipefail

# X.Y.Z+mikrob.N, anchored -- deliberately narrow. A version string that does NOT match this shape
# (a manual edit, a future format change, a corrupted file) must FAIL LOUDLY, not be guessed at:
# silently inventing a new N from an unrecognised string is exactly the kind of guess kodminosegi
# elv 1 forbids.
_BFV_RE='^([0-9]+\.[0-9]+\.[0-9]+)\+mikrob\.([0-9]+)$'

# bump_fork_version <worktree-path>
# Reads package.json's "version" field FRESH from disk in the given worktree (never a cached
# value from an earlier point in the caller's script) -- this is what makes a re-merge-and-retry
# after a lost push race (marveen-land.sh's land_with_retry) correct: the worktree is re-created
# from a freshly-fetched origin/$DEFAULT_BRANCH each attempt, so re-reading here always sees
# whatever N the WINNING concurrent landing already bumped to, and bumps one past THAT -- never a
# stale N captured before the race.
bump_fork_version() {
  local wt="$1" pkg lock cur new_n new_ver base_ver
  pkg="$wt/package.json"
  lock="$wt/package-lock.json"
  [ -f "$pkg" ] || { echo "bump_fork_version: $pkg not found" >&2; return 1; }

  cur="$(grep -m1 '"version"[[:space:]]*:' "$pkg" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
  [[ "$cur" =~ $_BFV_RE ]] || {
    echo "bump_fork_version: package.json version '$cur' does not match X.Y.Z+mikrob.N -- refusing to guess" >&2
    return 1
  }
  base_ver="${BASH_REMATCH[1]}"
  new_n=$(( BASH_REMATCH[2] + 1 ))
  new_ver="${base_ver}+mikrob.${new_n}"

  # Targeted, single-line substitution -- NOT a full JSON re-parse/re-serialize, so the rest of
  # both files (formatting, key order) is untouched. Only the FIRST "version" line in each file is
  # the root package's own (package.json has exactly one; package-lock.json's top-level "version"
  # is its first occurrence, and packages[""].version is the second -- both must move together or
  # `npm ci` sees the two files disagree about the root package's own version).
  sed -i -E "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/s//\"version\": \"${new_ver}\"/" "$pkg"

  if [ -f "$lock" ]; then
    # First TWO "version" lines in package-lock.json (lockfileVersion 3) are the top-level field
    # and packages[""].version, in that order -- both the root package's own version, both bumped
    # to base_ver (no +mikrob suffix, matching this file's pre-existing convention). Every
    # dependency's own "version" line comes after these two and is deliberately left untouched.
    sed -i -E "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/s//\"version\": \"${base_ver}\"/" "$lock"
    awk -v want="\"version\": \"${base_ver}\"" '
      BEGIN { hit = 0 }
      hit == 1 && /"version"[[:space:]]*:/ { sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, want); hit = 2 }
      { print }
      hit == 0 && /"version"[[:space:]]*:/ { hit = 1 }
    ' "$lock" > "$lock.tmp" && mv "$lock.tmp" "$lock"
  fi

  echo "$new_ver"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }

  mk_repo() {
    local dir="$1" pkg_ver="$2" lock_ver="$3"
    rm -rf "$dir"; mkdir -p "$dir"
    printf '{\n  "name": "test",\n  "version": "%s",\n  "private": true\n}\n' "$pkg_ver" >"$dir/package.json"
    if [ -n "$lock_ver" ]; then
      printf '{\n  "name": "test",\n  "version": "%s",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "test",\n      "version": "%s"\n    },\n    "node_modules/dep": {\n      "version": "9.9.9"\n    }\n  }\n}\n' "$lock_ver" "$lock_ver" >"$dir/package-lock.json"
    fi
  }

  D="$TMP/normal"; mk_repo "$D" "1.34.0+mikrob.1" "1.33.0"
  out="$(bump_fork_version "$D")"
  t "bumps N, keeps X.Y.Z" "$out" "1.34.0+mikrob.2"
  t "package.json reflects the bump" "$(python3 -c "import json;print(json.load(open('$D/package.json'))['version'])")" "1.34.0+mikrob.2"
  t "package-lock.json top-level re-synced to X.Y.Z (no suffix)" "$(python3 -c "import json;print(json.load(open('$D/package-lock.json'))['version'])")" "1.34.0"
  t "package-lock.json packages[''] re-synced" "$(python3 -c "import json;print(json.load(open('$D/package-lock.json'))['packages']['']['version'])")" "1.34.0"
  t "an unrelated dependency's own version is untouched" "$(python3 -c "import json;print(json.load(open('$D/package-lock.json'))['packages']['node_modules/dep']['version'])")" "9.9.9"

  D="$TMP/higher-n"; mk_repo "$D" "1.34.0+mikrob.9" ""
  out="$(bump_fork_version "$D")"
  t "double-digit N bumps correctly (not string-sort '10' < '9')" "$out" "1.34.0+mikrob.10"

  D="$TMP/no-lockfile"; mk_repo "$D" "1.34.0+mikrob.1" ""
  out="$(bump_fork_version "$D")"
  t "missing package-lock.json is not fatal" "$out" "1.34.0+mikrob.2"

  D="$TMP/malformed"; mk_repo "$D" "1.34.0" ""
  if out="$(bump_fork_version "$D" 2>/dev/null)"; then
    echo "  FAIL malformed version (no +mikrob.N) must refuse, not guess: got [$out]"; fail=1
  else
    echo "  ok   malformed version (no +mikrob.N) refused, not guessed at"
  fi

  D="$TMP/missing-file"; rm -rf "$D"; mkdir -p "$D"
  if out="$(bump_fork_version "$D" 2>/dev/null)"; then
    echo "  FAIL missing package.json must refuse: got [$out]"; fail=1
  else
    echo "  ok   missing package.json refused"
  fi

  # Concurrency scenario (the actual reason for "read fresh, never cache"): simulate land_with_retry
  # re-creating the worktree from a freshly-fetched base where ANOTHER agent's landing already
  # bumped N -- this call must bump past THAT value, not replay a value captured earlier.
  D="$TMP/race-rebase"; mk_repo "$D" "1.34.0+mikrob.1" ""
  bump_fork_version "$D" >/dev/null   # simulates the OTHER agent's already-landed bump
  out="$(bump_fork_version "$D")"     # this worktree re-reads the file fresh, same as a real retry would
  t "reads fresh from disk each call, no stale N" "$out" "1.34.0+mikrob.3"

  echo "bump-fork-version selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi
