#!/usr/bin/env bash
# bump-upstream-version.sh -- keeps package.json's MAIN X.Y.Z in step with the highest
# Szotasz/marveen `vX.Y.Z` tag already merged into the branch being landed (card 165350f1).
#
# Context: bump-fork-version.sh (the +mikrob.N counter) explicitly documents that X.Y.Z is "bumped
# only by an upstream-sync merge, a SEPARATE flow this script never touches" -- but that flow was
# never built, so every upstream-sync landing (Köteg N cards) left X.Y.Z frozen at whatever it was
# when the fork diverged, even as upstream tags with a higher X.Y.Z became ancestors of develop.
# Measured 2026-10-14 (card 165350f1): package.json said 1.36.0 while v1.40.0 (tagged 2026-09-29)
# was already an ancestor of origin/develop -- four upstream releases behind what the fork had
# actually merged.
#
# The fork's own +mikrob.N suffix is left exactly as-is on a bump (not reset): it counts fork-own
# landings cumulatively, and bump-fork-version.sh is the only thing that increments it.
#
# Usage (sourced, from an upstream-sync landing's merge-result worktree, BEFORE the final commit --
# the same point in the flow where a fork-own landing calls bump_fork_version):
#   . bump-upstream-version.sh
#   bump_upstream_version "$wt"   # prints the new "X.Y.Z+mikrob.N" on a bump, or "unchanged:<ver>"
#                                  # when no ancestor tag's X.Y.Z exceeds package.json's current one
#
# Usage (direct, selftest only):
#   bump-upstream-version.sh --selftest

set -uo pipefail

# X.Y.Z, optionally with the fork's own +mikrob.N suffix (which this script never writes, only
# carries through unchanged) -- deliberately narrow, same "refuse rather than guess" stance as
# bump-fork-version.sh's _BFV_RE.
_BUV_RE='^([0-9]+)\.([0-9]+)\.([0-9]+)(\+mikrob\.[0-9]+)?$'
_BUV_TAG_RE='^v([0-9]+)\.([0-9]+)\.([0-9]+)$'

# _buv_highest_ancestor_tag <worktree> -- the vX.Y.Z tag with the greatest X.Y.Z (compared
# numerically, not as a string -- "v1.10.0" must beat "v1.9.0") among tags that are both shaped
# like vX.Y.Z and an ancestor of the worktree's current HEAD. Prints nothing (not an error) if no
# such tag exists.
_buv_highest_ancestor_tag() {
  local wt="$1" tag best="" best_key="" key
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    [[ "$tag" =~ $_BUV_TAG_RE ]] || continue
    git -C "$wt" merge-base --is-ancestor "$tag" HEAD 2>/dev/null || continue
    key=$(printf '%05d.%05d.%05d' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
    if [ -z "$best_key" ] || [[ "$key" > "$best_key" ]]; then
      best_key="$key"; best="$tag"
    fi
  done < <(git -C "$wt" tag -l 'v*')
  printf '%s' "$best"
}

# bump_upstream_version <worktree-path>
# Reads package.json's "version" field FRESH from disk, same "never a cached value from an earlier
# point in the caller's script" reasoning as bump_fork_version.
bump_upstream_version() {
  local wt="$1" pkg lock cur cur_x cur_y cur_z suffix tag tx ty tz new_ver lock_ver
  pkg="$wt/package.json"
  lock="$wt/package-lock.json"
  [ -f "$pkg" ] || { echo "bump_upstream_version: $pkg not found" >&2; return 1; }

  cur="$(grep -m1 '"version"[[:space:]]*:' "$pkg" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
  [[ "$cur" =~ $_BUV_RE ]] || {
    echo "bump_upstream_version: package.json version '$cur' does not match X.Y.Z[+mikrob.N] -- refusing to guess" >&2
    return 1
  }
  cur_x="${BASH_REMATCH[1]}"; cur_y="${BASH_REMATCH[2]}"; cur_z="${BASH_REMATCH[3]}"
  suffix="${BASH_REMATCH[4]:-}"

  tag="$(_buv_highest_ancestor_tag "$wt")"
  if [ -z "$tag" ]; then
    echo "unchanged:$cur"
    return 0
  fi
  [[ "$tag" =~ $_BUV_TAG_RE ]] || { echo "bump_upstream_version: unexpected tag shape '$tag'" >&2; return 1; }
  tx="${BASH_REMATCH[1]}"; ty="${BASH_REMATCH[2]}"; tz="${BASH_REMATCH[3]}"

  if (( 10#$tx > 10#$cur_x )) \
    || { (( 10#$tx == 10#$cur_x )) && (( 10#$ty > 10#$cur_y )); } \
    || { (( 10#$tx == 10#$cur_x )) && (( 10#$ty == 10#$cur_y )) && (( 10#$tz > 10#$cur_z )); }; then
    new_ver="${tx}.${ty}.${tz}${suffix}"
    sed -i -E "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/s//\"version\": \"${new_ver}\"/" "$pkg"
    if [ -f "$lock" ]; then
      lock_ver="${tx}.${ty}.${tz}"
      sed -i -E "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/s//\"version\": \"${lock_ver}\"/" "$lock"
      awk -v want="\"version\": \"${lock_ver}\"" '
        BEGIN { hit = 0 }
        hit == 1 && /"version"[[:space:]]*:/ { sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, want); hit = 2 }
        { print }
        hit == 0 && /"version"[[:space:]]*:/ { hit = 1 }
      ' "$lock" > "$lock.tmp" && mv "$lock.tmp" "$lock"
    fi
    echo "$new_ver"
  else
    echo "unchanged:$cur"
  fi
}

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }

  mk_repo() {
    local dir="$1" pkg_ver="$2"
    rm -rf "$dir"; mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" config user.email "t@t.t"
    git -C "$dir" config user.name "t"
    printf '{\n  "name": "test",\n  "version": "%s",\n  "private": true\n}\n' "$pkg_ver" >"$dir/package.json"
    printf '{\n  "name": "test",\n  "version": "%s",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "test",\n      "version": "%s"\n    },\n    "node_modules/dep": {\n      "version": "9.9.9"\n    }\n  }\n}\n' "$pkg_ver" "$pkg_ver" >"$dir/package-lock.json"
    git -C "$dir" add -A
    git -C "$dir" commit -q -m init
  }

  # Normal case: three ancestor tags, highest (numerically, not string-sorted) wins.
  D="$TMP/normal"; mk_repo "$D" "1.0.0+mikrob.5"
  git -C "$D" tag v1.0.0
  echo x >"$D/f1"; git -C "$D" add f1; git -C "$D" commit -q -m c1
  git -C "$D" tag v1.9.0
  echo y >"$D/f2"; git -C "$D" add f2; git -C "$D" commit -q -m c2
  git -C "$D" tag v1.10.0
  out="$(bump_upstream_version "$D")"
  t "bumps X.Y.Z to the highest ancestor tag (numeric, not string order)" "$out" "1.10.0+mikrob.5"
  t "mikrob.N suffix preserved, not reset" "$(python3 -c "import json;print(json.load(open('$D/package.json'))['version'])")" "1.10.0+mikrob.5"
  t "package-lock.json root re-synced, no suffix" "$(python3 -c "import json;print(json.load(open('$D/package-lock.json'))['version'])")" "1.10.0"
  t "package-lock.json packages[''] re-synced" "$(python3 -c "import json;print(json.load(open('$D/package-lock.json'))['packages']['']['version'])")" "1.10.0"
  t "an unrelated dependency's own version is untouched" "$(python3 -c "import json;print(json.load(open('$D/package-lock.json'))['packages']['node_modules/dep']['version'])")" "9.9.9"

  # A tag that exists in the repo but is NOT an ancestor of HEAD (e.g. a future upstream release
  # not yet merged) must be ignored.
  D="$TMP/not-ancestor"; mk_repo "$D" "1.0.0+mikrob.1"
  git -C "$D" tag v1.0.0
  git -C "$D" checkout -q -b other
  echo z >"$D/f3"; git -C "$D" add f3; git -C "$D" commit -q -m c3
  git -C "$D" tag v9.9.9
  git -C "$D" checkout -q master 2>/dev/null || git -C "$D" checkout -q main
  out="$(bump_upstream_version "$D")"
  t "a tag not reachable from HEAD is ignored" "$out" "unchanged:1.0.0+mikrob.1"

  # package.json already at (or above) the highest ancestor tag -> no-op, no file write.
  D="$TMP/already-current"; mk_repo "$D" "1.2.0+mikrob.3"
  git -C "$D" tag v1.2.0
  before="$(cat "$D/package.json")"
  out="$(bump_upstream_version "$D")"
  t "already at the ancestor tag's X.Y.Z -> unchanged" "$out" "unchanged:1.2.0+mikrob.3"
  t "unchanged means literally untouched on disk" "$(cat "$D/package.json")" "$before"

  # No vX.Y.Z-shaped tags at all.
  D="$TMP/no-tags"; mk_repo "$D" "1.0.0+mikrob.1"
  out="$(bump_upstream_version "$D")"
  t "no matching tags -> unchanged" "$out" "unchanged:1.0.0+mikrob.1"

  # No +mikrob.N suffix at all is also valid input (plain upstream checkout) and must be preserved
  # as absent, not have one invented.
  D="$TMP/no-suffix"; mk_repo "$D" "1.0.0"
  git -C "$D" tag v1.5.0
  out="$(bump_upstream_version "$D")"
  t "bump with no pre-existing +mikrob.N suffix does not invent one" "$out" "1.5.0"

  # Malformed version must refuse, not guess.
  D="$TMP/malformed"; mk_repo "$D" "not-a-version"
  if out="$(bump_upstream_version "$D" 2>/dev/null)"; then
    echo "  FAIL malformed version must refuse, not guess: got [$out]"; fail=1
  else
    echo "  ok   malformed version refused, not guessed at"
  fi

  D="$TMP/missing-file"; rm -rf "$D"; mkdir -p "$D"
  if out="$(bump_upstream_version "$D" 2>/dev/null)"; then
    echo "  FAIL missing package.json must refuse: got [$out]"; fail=1
  else
    echo "  ok   missing package.json refused"
  fi

  echo "bump-upstream-version selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi
