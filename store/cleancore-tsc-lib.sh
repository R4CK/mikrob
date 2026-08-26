#!/usr/bin/env bash
# Shared CleanCore measurement helpers, sourced by cleancore-land.sh and cleancore-pregate.sh.
#
# WHY A LIBRARY AND NOT A COPY. These four functions each encode a trap that cost a card, and a
# copied trap gets fixed in one place and left in the other. Keeping one definition is the point.
#
# Requires: MAIN (path to the main clone) set by the caller. TSC_TIMEOUT optional.

TSC_TIMEOUT="${TSC_TIMEOUT:-900}"

# The fast projects the root `typecheck` script runs, in its order. apps/web is separate and
# deliberately conditional -- it is minutes slow. apps/superadmin measured ~15s (card be30a5f7,
# added after 9 pre-existing errors there were fixed and it had never been gated at all before) --
# fast enough for this bucket, not the apps/web one.
TSC_PROJECTS="tsconfig.json packages/control-plane/tsconfig.test.json packages/modules/workforce/tsconfig.test.json apps/api/tsconfig.json apps/superadmin/tsconfig.json"

# NEVER call `npm run typecheck` from a worktree. Its last step is
# `pnpm --filter @cleancore/web typecheck`, and pnpm's dep-status check shells out to `pnpm install`,
# which asks to REMOVE the modules directory. In these worktrees node_modules is a SYMLINK into the
# shared main clone, so a purge that proceeds deletes every agent's dependencies mid-work. Only the
# missing TTY stopped it when it was hit for real (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY), and
# pnpm's own advice -- "set CI=true" -- would have made it proceed silently. tsc runs directly.
#
# CARD 87e5ad4d, THE ONE-SYMLINK-PER-DIRECTORY TRAP. The loop below used to symlink each node_modules
# DIRECTORY wholesale (`ln -s "$d" "$wt/$rel"`) -- cheap, and correct for ordinary dependencies. But
# pnpm's own workspace links live INSIDE those directories (e.g. node_modules/@cleancore/core is
# itself a symlink pnpm created, RELATIVE to its own location, to ../../../packages/core). A relative
# symlink resolves relative to where it PHYSICALLY sits, not to how it was reached -- and wholesale
# directory symlinking means it physically still sits inside $MAIN, so it keeps resolving into
# $MAIN/packages/core even when reached through $wt. A typecheck of $wt then silently reads
# $MAIN's OLD copy of any workspace package for every import that resolves through a nested pnpm
# link rather than through tsconfig's own "paths" mapping. Measured live on card 87e5ad4d: a merge
# that added `hasForbiddenIdentityChars` to packages/core/src/text-guard.ts landed a REFUSED
# typecheck ("has no exported member") from apps/superadmin's project -- its tsconfig.json has no
# "@cleancore/core" paths entry, so control-plane files pulled into that compilation fall through to
# node_modules resolution, hit packages/control-plane/node_modules/@cleancore/core, and that symlink,
# --traceResolution confirmed, resolved to $MAIN/packages/core/src/index.ts (the version WITHOUT the
# new export) instead of $wt's merged copy. A manual repro of the exact same merge, checked with only
# `tsc -p packages/control-plane/tsconfig.test.json` (which DOES have the "paths" entry), showed zero
# errors -- the bug is invisible unless the specific project that lacks the mapping is the one that
# runs, which is exactly why it was never noticed before landing this card.
#
# THE FIX walks one level into each node_modules directory instead of symlinking it as one unit. Every
# ordinary entry is still a plain symlink to $MAIN (no behavior change, no extra installs). Only
# scoped `@cleancore/*` entries are inspected: if the entry's real path lands under $MAIN/packages or
# $MAIN/apps AND the worktree has its own copy of that same relative path, the new symlink points at
# $wt's copy instead -- so a typecheck of $wt actually typechecks $wt, however the import got there.
# A workspace package the worktree does NOT touch (nothing changed under it, so no local copy is
# expected here) still falls back to $MAIN, unchanged from before.
link_node_modules() {
  local wt="$1" d rel n=0 entry base pkg pkgname real wtrel
  while IFS= read -r d; do
    rel="${d#$MAIN/}"
    [ -e "$wt/$rel" ] && continue
    mkdir -p "$wt/$rel"
    for entry in "$d"/* "$d"/.[!.]*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      base="$(basename "$entry")"
      if [ "$base" != "@cleancore" ] || [ ! -d "$entry" ]; then
        ln -s "$entry" "$wt/$rel/$base"
        continue
      fi
      mkdir -p "$wt/$rel/@cleancore"
      for pkg in "$entry"/*; do
        [ -e "$pkg" ] || continue
        pkgname="$(basename "$pkg")"
        real="$(readlink -f "$pkg" 2>/dev/null || true)"
        case "$real" in
          "$MAIN"/packages/*|"$MAIN"/apps/*)
            wtrel="${real#$MAIN/}"
            if [ -e "$wt/$wtrel" ]; then
              ln -s "$wt/$wtrel" "$wt/$rel/@cleancore/$pkgname"
            else
              ln -s "$pkg" "$wt/$rel/@cleancore/$pkgname"
            fi
            ;;
          *) ln -s "$pkg" "$wt/$rel/@cleancore/$pkgname" ;;
        esac
      done
    done
    n=$((n+1))
  done < <(find "$MAIN" -maxdepth 4 -type d -name node_modules -not -path "*/node_modules/*" 2>/dev/null)
  echo "  linked $n node_modules into $(basename "$wt")"
}

# Normalise a tsc line so it survives code moving up or down: keep the file and the error, drop the
# (line,col). Without this every pre-existing error below an inserted hunk reads as "new".
norm_errors() { sed -E 's/\(([0-9]+),([0-9]+)\)//' | grep -E 'error TS[0-9]+' | sort -u; }

# Prints normalised error lines on stdout. A non-zero exit with NO `error TS` line is a broken
# harness (missing deps, wrong binary, timeout), not a clean project -- reported as such rather than
# counted as zero errors, which is exactly how a vacuous `npx tsc` once read green.
typecheck_errors() {
  local wt="$1" want_web="${2:-0}" p out rc
  for p in $TSC_PROJECTS; do
    out="$(cd "$wt" && timeout "$TSC_TIMEOUT" node_modules/.bin/tsc --noEmit -p "$p" 2>&1)"; rc=$?
    printf '%s\n' "$out" | norm_errors
    if [ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -q 'error TS'; then
      echo "HARNESS-FAULT in $p: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
    fi
  done
  if [ "$want_web" = 1 ]; then
    out="$(cd "$wt/apps/web" && timeout "$TSC_TIMEOUT" ../../node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1)"; rc=$?
    printf '%s\n' "$out" | norm_errors
    if [ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -q 'error TS'; then
      echo "HARNESS-FAULT in apps/web: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
    fi
  fi
}

# Prints the FULL NAME of every failing test, one per line, sorted.
#
# The whole suite, not the branch's own test files. Measured on the real queue: all six cards passed
# their own touched tests, INCLUDING card 9c47038a at 31/31 -- whose route-shadowing.test.ts is red
# at its own gated sha. It passed because that file is not one it edits; it merely breaks it. A
# "touched test files" check would have waved through the card it was proposed for.
#
# A run that produces no summary line at all is a harness fault, not a green suite -- vitest failing
# to start looks identical to "nothing failed" if you only grep for FAIL.
test_failures() {
  local wt="$1" out
  out="$(cd "$wt" && timeout "$TSC_TIMEOUT" node_modules/.bin/vitest run apps/api 2>&1)"
  if ! printf '%s' "$out" | grep -qE '^ +Tests +'; then
    echo "HARNESS-FAULT in vitest: $(printf '%s' "$out" | tail -3 | tr '\n' ' ' | cut -c1-200)"
    return
  fi
  printf '%s\n' "$out" | grep -E '^ FAIL ' | sed -E 's/^ FAIL +\|[^|]*\| +//' | sort -u
}

# Selftest for link_node_modules (card 87e5ad4d). Runs ONLY on direct execution
# (`bash cleancore-tsc-lib.sh --selftest`), never on source -- BASH_SOURCE[0] stays this file's own
# path either way, but $0 is the sourcing script's path when sourced, so the two differ only when
# this file is the one actually invoked.
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  FAKE_MAIN="$tmp/main"; FAKE_WT="$tmp/wt"

  # A workspace package (@cleancore/core) the worktree HAS its own copy of, reached through a nested
  # pnpm symlink inside a package's node_modules -- the exact shape that misread stale content on
  # card 87e5ad4d.
  mkdir -p "$FAKE_MAIN/packages/core/src" "$FAKE_MAIN/packages/control-plane/node_modules/@cleancore" \
           "$FAKE_MAIN/node_modules/typescript" \
           "$FAKE_WT/packages/core/src" "$FAKE_WT/packages/control-plane"
  echo OLD > "$FAKE_MAIN/packages/core/src/index.ts"
  echo NEW > "$FAKE_WT/packages/core/src/index.ts"
  ln -s ../../../core "$FAKE_MAIN/packages/control-plane/node_modules/@cleancore/core"

  # A second workspace package (@cleancore/evidence) the worktree does NOT touch -- must still
  # resolve, unchanged, to $MAIN.
  mkdir -p "$FAKE_MAIN/packages/evidence/src"
  echo UNCHANGED > "$FAKE_MAIN/packages/evidence/src/index.ts"
  ln -s ../../../evidence "$FAKE_MAIN/packages/control-plane/node_modules/@cleancore/evidence"

  saved_main="$MAIN"; MAIN="$FAKE_MAIN"
  out="$(link_node_modules "$FAKE_WT")"
  MAIN="$saved_main"

  t "reports the linked directory count" "$out" "  linked 2 node_modules into $(basename "$FAKE_WT")"
  t "a workspace package the worktree touched reads the WORKTREE copy, not MAIN's stale one" \
    "$(cat "$FAKE_WT/packages/control-plane/node_modules/@cleancore/core/src/index.ts" 2>/dev/null)" \
    "NEW"
  t "a workspace package the worktree did NOT touch still falls back to MAIN" \
    "$(cat "$FAKE_WT/packages/control-plane/node_modules/@cleancore/evidence/src/index.ts" 2>/dev/null)" \
    "UNCHANGED"
  t "an ordinary (non-workspace) dependency is still a plain passthrough symlink" \
    "$(readlink -f "$FAKE_WT/node_modules/typescript")" \
    "$(readlink -f "$FAKE_MAIN/node_modules/typescript")"

  echo "cleancore-tsc-lib selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi
