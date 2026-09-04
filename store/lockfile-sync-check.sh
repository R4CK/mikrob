#!/usr/bin/env bash
# lockfile-sync-check.sh -- does this commit's pnpm-lock.yaml still match its package.json files?
# (card b8c1ff36)
#
# THE DEFECT THIS CATCHES, twice in one day (cards 8d673233 and af7441a3, both mine): a workspace
# dependency was declared in a package.json and pnpm-lock.yaml was not regenerated. Both cards passed
# every gate and BOTH blocked the deploy.
#
# WHY NO EXISTING CHECK COULD SEE IT, and why this is structural rather than carelessness: every
# local check -- tsc, vitest, the linters, the landing script's typecheck -- resolves imports through
# an ALREADY INSTALLED node_modules (in an agent worktree that is a symlink into the shared clone).
# The lockfile is a file none of them read. Only a clean install reads it, and the first clean install
# happens at DEPLOY time. So the miss is invisible until it is expensive.
#
# THE CHECK: reconstruct the dependency inputs FROM THE COMMIT into an empty temp directory and run
# `pnpm install --frozen-lockfile` there. ~0.5s on this repo (measured by backend: 487ms for 36
# package.json files), and it fails with exactly the message the deploy failed with.
#
# FROM THE COMMIT, not the working tree, and that is the point: `git archive` is what makes this
# answer "would this SHA install?" rather than "does my dirty checkout happen to install?". A gate
# reads a sha; so does this.
#
# NO node_modules IS COPIED, deliberately. The temp tree has none, so pnpm cannot resolve through a
# pre-installed one -- and just as importantly, this check physically CANNOT write into the shared
# clone's node_modules the way a naive "just run an install to see" would. An installer that touches
# the tree every agent is reading is the incident this fleet already had.
#
# Usage:
#   lockfile-sync-check.sh --repo <path> [--ref <ref>] [--base <ref>]
#   lockfile-sync-check.sh --selftest
#
#     --base   when given, the check is SKIPPED unless some package.json changed in base..ref.
#              Cheap by default: most cards touch no manifest at all.
#
# Exit: 0 in sync (or not applicable) | 1 OUT OF SYNC | 2 bad usage | 3 harness fault
#
# "Not applicable" covers three things, all exit 0: no package.json changed in base..ref; the
# ref carries no pnpm-lock.yaml (not a pnpm repo); and an in-sync lockfile. The middle one was
# added by card fe06da0c after it reported OUT OF SYNC on every marveen landing.
#
# 3 IS SEPARATE FROM 1 ON PURPOSE. "pnpm is missing" and "the lockfile is stale" are different facts
# and callers treat them differently: a landing may refuse on 1 but must not refuse on 3, or a broken
# toolchain silently becomes a policy that blocks every landing.
set -uo pipefail

REPO=""; REF="HEAD"; BASE=""
if [ "${1:-}" = "--selftest" ]; then SELFTEST=1; else SELFTEST=0; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --selftest) shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The manifest paths a pnpm workspace install actually reads. `.npmrc` matters (registry/auth
# settings can change resolution) and is optional; the two yaml files are not optional in this repo
# but are copied defensively so the script stays usable in a plain single-package repo too.
manifest_paths() {
  local repo="$1" ref="$2"
  {
    git -C "$repo" ls-tree -r --name-only "$ref" 2>/dev/null \
      | grep -E '(^|/)package\.json$' | grep -vE '(^|/)node_modules/'
    for f in pnpm-lock.yaml pnpm-workspace.yaml .npmrc; do
      git -C "$repo" cat-file -e "$ref:$f" 2>/dev/null && echo "$f"
    done
  } | sort -u
}

# True when base..ref touches at least one package.json. Used to skip the check entirely on the
# majority of cards -- a guard that runs on everything gets switched off.
touches_manifest() {
  local repo="$1" base="$2" ref="$3"
  git -C "$repo" diff --name-only "$base" "$ref" 2>/dev/null \
    | grep -qE '(^|/)package\.json$'
}

if [ "$SELFTEST" -eq 1 ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  git -C "$tmp" init -q .
  mkdir -p "$tmp/apps/web" "$tmp/packages/core" "$tmp/node_modules/evil"
  echo '{}' > "$tmp/package.json"
  echo '{}' > "$tmp/apps/web/package.json"
  echo '{}' > "$tmp/packages/core/package.json"
  echo '{}' > "$tmp/node_modules/evil/package.json"
  echo 'lockfileVersion: 9' > "$tmp/pnpm-lock.yaml"
  echo 'packages: ["apps/*"]' > "$tmp/pnpm-workspace.yaml"
  git -C "$tmp" add -A >/dev/null 2>&1
  git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm base >/dev/null 2>&1

  got="$(manifest_paths "$tmp" HEAD | tr '\n' ' ')"
  t "collects EVERY workspace package.json, not just the root" \
    "$(manifest_paths "$tmp" HEAD | grep -c 'package\.json')" "3"
  t "never collects a package.json under node_modules" \
    "$(manifest_paths "$tmp" HEAD | grep -c 'node_modules')" "0"
  t "collects the lockfile" "$(echo "$got" | grep -c 'pnpm-lock.yaml')" "1"
  t "collects the workspace file" "$(echo "$got" | grep -c 'pnpm-workspace.yaml')" "1"
  t "an absent .npmrc is simply not collected" "$(echo "$got" | grep -c '.npmrc')" "0"

  echo 'x' > "$tmp/README.md"
  git -C "$tmp" add -A >/dev/null 2>&1
  git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm readme >/dev/null 2>&1
  touches_manifest "$tmp" HEAD~1 HEAD && r=yes || r=no
  t "a commit touching no manifest is NOT applicable" "$r" "no"

  echo '{"name":"x"}' > "$tmp/apps/web/package.json"
  git -C "$tmp" add -A >/dev/null 2>&1
  git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm manifest >/dev/null 2>&1
  touches_manifest "$tmp" HEAD~1 HEAD && r=yes || r=no
  t "a commit touching a NESTED package.json IS applicable" "$r" "yes"

  # The cases above exercise the helpers; these two drive the WHOLE script, because the defect
  # this closes lived in the main flow and no helper could have shown it (card fe06da0c).
  npmrepo="$(mktemp -d)"
  git -C "$npmrepo" init -q .
  printf '{"name":"x","version":"1.0.0"}\n' > "$npmrepo/package.json"
  printf '{"name":"x","version":"1.0.0","lockfileVersion":3}\n' > "$npmrepo/package-lock.json"
  git -C "$npmrepo" add -A >/dev/null 2>&1
  git -C "$npmrepo" -c user.email=t@t -c user.name=t commit -qm base >/dev/null 2>&1
  out="$("$0" --repo "$npmrepo" --ref HEAD 2>&1)"; rc=$?
  t "an npm repo (no pnpm-lock.yaml) is NOT APPLICABLE, never OUT OF SYNC" "$rc" "0"
  t "and it says why" "$(printf '%s' "$out" | grep -c 'not applicable')" "1"

  # ...but a branch that DELETES the lockfile is still a real finding, given a base to compare to.
  pnpmrepo="$(mktemp -d)"
  git -C "$pnpmrepo" init -q .
  printf '{"name":"x","version":"1.0.0"}\n' > "$pnpmrepo/package.json"
  echo 'lockfileVersion: 9' > "$pnpmrepo/pnpm-lock.yaml"
  git -C "$pnpmrepo" add -A >/dev/null 2>&1
  git -C "$pnpmrepo" -c user.email=t@t -c user.name=t commit -qm base >/dev/null 2>&1
  rm "$pnpmrepo/pnpm-lock.yaml"
  printf '{"name":"x","version":"1.0.1"}\n' > "$pnpmrepo/package.json"
  git -C "$pnpmrepo" add -A >/dev/null 2>&1
  git -C "$pnpmrepo" -c user.email=t@t -c user.name=t commit -qm drop >/dev/null 2>&1
  out="$("$0" --repo "$pnpmrepo" --ref HEAD --base HEAD~1 2>&1)"; rc=$?
  t "deleting a lockfile the base HAD is OUT OF SYNC, not 'not applicable'" "$rc" "1"
  t "and it names the deletion" "$(printf '%s' "$out" | grep -c 'DELETED')" "1"
  rm -rf "$npmrepo" "$pnpmrepo"

  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

[ -n "$REPO" ] || { echo "usage: lockfile-sync-check.sh --repo <path> [--ref <ref>] [--base <ref>]" >&2; exit 2; }
[ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || { echo "not a git repo: $REPO" >&2; exit 2; }
git -C "$REPO" rev-parse --verify "$REF" >/dev/null 2>&1 || { echo "no such ref: $REF" >&2; exit 2; }

if [ -n "$BASE" ]; then
  git -C "$REPO" rev-parse --verify "$BASE" >/dev/null 2>&1 || { echo "no such base ref: $BASE" >&2; exit 2; }
  if ! touches_manifest "$REPO" "$BASE" "$REF"; then
    echo "lockfile-sync: not applicable (no package.json changed in $BASE..$REF)"
    exit 0
  fi
fi

# NOT APPLICABLE when the ref carries no pnpm-lock.yaml (card fe06da0c). This check is pnpm-only,
# and marveen is an npm repo (package-lock.json, no pnpm-lock.yaml) -- so every marveen landing that
# touched package.json got `[fail] lockfile-out-of-sync -- a package.json changed without
# regenerating pnpm-lock.yaml`, whose real cause was ERR_PNPM_NO_LOCKFILE: "pnpm-lock.yaml is
# absent". marveen-land.sh bumps package.json on EVERY landing, so the finding fired on every one of
# them. Measured 2026-09-04 on origin/develop: exit 1, that exact message.
#
# This is the script's own stated principle applied one step further. Its header separates exit 3
# from exit 1 because "pnpm is missing" and "the lockfile is stale" are different facts; "this repo
# does not use pnpm at all" is a third, and it is not a fact about the card either. A recurring
# false [fail] is worse than no check: it is the noise a REAL drift would hide in, which is exactly
# what Cybersec flagged.
#
# The deletion case is kept honest: with --base, a ref that DROPPED a lockfile the base had is a
# real finding, not "not applicable". Without --base there is nothing to compare against, so the
# absence can only be read as "not a pnpm repo".
if ! git -C "$REPO" cat-file -e "$REF:pnpm-lock.yaml" 2>/dev/null; then
  if [ -n "$BASE" ] && git -C "$REPO" cat-file -e "$BASE:pnpm-lock.yaml" 2>/dev/null; then
    echo "lockfile-sync: OUT OF SYNC at $REF -- pnpm-lock.yaml was DELETED (present at $BASE)"
    exit 1
  fi
  echo "lockfile-sync: not applicable (no pnpm-lock.yaml at $REF -- this repo does not use pnpm)"
  exit 0
fi

command -v pnpm >/dev/null 2>&1 || { echo "lockfile-sync: HARNESS FAULT -- pnpm is not on PATH" >&2; exit 3; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILES="$(manifest_paths "$REPO" "$REF")"
[ -n "$FILES" ] || { echo "lockfile-sync: HARNESS FAULT -- no package.json found at $REF" >&2; exit 3; }
# shellcheck disable=SC2086
if ! git -C "$REPO" archive "$REF" -- $FILES 2>/dev/null | tar -x -C "$WORK" 2>/dev/null; then
  echo "lockfile-sync: HARNESS FAULT -- could not export the manifests from $REF" >&2
  exit 3
fi

OUT="$(cd "$WORK" && pnpm install --frozen-lockfile --ignore-scripts 2>&1)"
RC=$?
if [ "$RC" -eq 0 ]; then
  echo "lockfile-sync: OK -- $(echo "$FILES" | grep -c 'package\.json') manifest(s) at $REF match pnpm-lock.yaml"
  exit 0
fi

# A frozen-lockfile MISMATCH is what this exists to find; anything else (network, corrupt store,
# a pnpm version that cannot read the lockfile) is a harness fault and must not read as a verdict.
if printf '%s' "$OUT" | grep -qiE 'frozen-lockfile|lockfile is not up to date|specifiers in the lockfile'; then
  echo "lockfile-sync: OUT OF SYNC at $REF -- a package.json changed without regenerating pnpm-lock.yaml"
  printf '%s\n' "$OUT" | tail -12
  exit 1
fi
echo "lockfile-sync: HARNESS FAULT -- pnpm failed for a reason that is not a lockfile mismatch" >&2
printf '%s\n' "$OUT" | tail -12 >&2
exit 3
