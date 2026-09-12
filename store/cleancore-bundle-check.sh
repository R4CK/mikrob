#!/usr/bin/env bash
# cleancore-bundle-check.sh -- does the merge result still produce a BROWSER BUNDLE? (card 0a907846)
#
# THE GAP THIS CLOSES, measured 2026-09-12. origin/main sat for ten hours in a state where the web
# image could not be built, and nothing said so. It surfaced only because a card needed a real
# deploy:
#
#     "pnpm --filter @cleancore/superadmin build" exit 1
#     packages/control-plane/src/node-magic-link-crypto.ts (7:21):
#       "randomBytes" is not exported by "__vite-browser-external"
#
# Card e4e83c32 turned a TYPE-only import of @cleancore/control-plane into a VALUE import. A type
# import disappears at build time; a value import pulls the package entry, which re-exports two
# node-only crypto modules, and `node:crypto` does not exist in a browser bundle. That card carried
# QA + Cybersec + Cybered verdicts, `tsc --noEmit` was clean, and the full suite was green -- all of
# it correct, and none of it able to see the defect, because tests run under NODE where node:crypto
# resolves perfectly. The production bundling step was run by no gate and by no lander.
#
# WHY THE REAL BUILD AND NOT A STATIC RULE. The tempting guard is "a browser app must not value-
# import a node-only module". It cannot see this: the path is app -> package index -> node-only
# module, and no single import line contains it. The bundler answers exactly this question and had
# already answered it. Run the real command once.
#
# DELTA, NOT ABSOLUTE, for the same reason the typecheck next to it is a delta: main can already be
# broken from earlier work, and the branch is not answerable for that. If BOTH main and the merge
# fail to bundle, the landing proceeds and the inherited breakage is printed loudly. If main builds
# and the merge does not, the landing is refused.
#
# SCOPE, so the cost lands where the risk is: the bundles run only when the merge touches apps/web,
# apps/superadmin or packages/. An api-only or infra-only branch cannot break a browser bundle, and
# the check says out loud when it skipped, because a silently narrowed check reads like coverage.
# Measured cost when it does run: superadmin ~7 s, web ~66 s.

# Which pnpm filters the Dockerfile actually builds -- kept in this order deliberately: superadmin is
# the cheap one, so a break there is reported ~60 s sooner.
CC_BUNDLE_FILTERS="${CC_BUNDLE_FILTERS:-@cleancore/superadmin @cleancore/web}"

# bundle_relevant <main-clone> <merge-base> <sha> -> 0 when the bundles should run
bundle_relevant() {
  git -C "$1" diff --name-only "$2..$3" 2>/dev/null \
    | grep -qE '^(apps/web/|apps/superadmin/|packages/)'
}

# bundle_failures <worktree> -> prints one line per filter that failed to build; empty means all built.
# Never prints the whole bundler log: the caller re-runs the named filter to see it. A wall of rollup
# stack frames in a landing report buries the one line that names the module.
bundle_failures() {
  local wt="$1" f out
  for f in $CC_BUNDLE_FILTERS; do
    if ! out="$(cd "$wt" && timeout "${CC_BUNDLE_TIMEOUT:-900}" npx pnpm --filter "$f" build 2>&1)"; then
      # The bundler names the offending module on a line of its own; surface that, not the trace.
      local why
      why="$(printf '%s\n' "$out" | grep -m1 -E 'is not exported by|Could not resolve|\[vite\]: Rollup failed' | sed 's/^[[:space:]]*//')"
      printf '%s :: %s\n' "$f" "${why:-build failed (re-run the filter to see why)}"
    fi
  done
}
