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
link_node_modules() {
  local wt="$1" d rel n=0
  while IFS= read -r d; do
    rel="${d#$MAIN/}"
    [ -e "$wt/$rel" ] && continue
    mkdir -p "$wt/$(dirname "$rel")" && ln -s "$d" "$wt/$rel" && n=$((n+1))
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
