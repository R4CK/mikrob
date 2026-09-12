#!/usr/bin/env bash
# Selftest for cleancore-bundle-check.sh (card 0a907846).
#
# The FILE-SCAN half runs on a constructed corpus and is instant. The BUILD half is deliberately NOT
# simulated: the whole argument for this guard is that only the real bundler can see the defect, so a
# fake would test the opposite of the point. It is proven instead against two real shas, recorded
# here with their measured outcome, and re-runnable with CC_BUNDLE_SELFTEST_REAL=1 (~3 minutes).
#
#   46356720  (card e4e83c32 merged)              -> @cleancore/superadmin :: "randomBytes" is not
#                                                    exported by "__vite-browser-external"
#   e80945dc  (main immediately before it)        -> EMPTY
#
# Both were run on 2026-09-12 while writing this. The second one matters as much as the first: a
# guard only ever seen refusing is indistinguishable from one that refuses everything.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/cleancore-bundle-check.sh"
CC="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
fail=0
ok()   { echo "  ok: $1"; }
bad()  { echo "  FAIL: $1"; fail=1; }

# --- bundle_relevant, on a throwaway repo so the cases cannot drift with the real history ---------
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ccbundle-XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
(
  set -e
  git init -q -b main "$tmp/r"; cd "$tmp/r"
  git config user.email s@s; git config user.name s
  mkdir -p apps/api/src apps/web/src apps/superadmin/src packages/core/src infra
  echo x > apps/api/src/a.ts; echo x > infra/compose.yml
  git add -A; git commit -qm base
  BASE=$(git rev-parse HEAD); echo "$BASE" > "$tmp/base"
  echo y >> apps/api/src/a.ts; echo y >> infra/compose.yml; git commit -qam "api+infra only"
  git rev-parse HEAD > "$tmp/apionly"
  echo y > apps/web/src/w.ts; git add -A; git commit -qm "touches web"
  git rev-parse HEAD > "$tmp/web"
  git checkout -q "$BASE" -b pkgonly
  echo y > packages/core/src/p.ts; git add -A; git commit -qm "touches packages"
  git rev-parse HEAD > "$tmp/pkg"
) >/dev/null 2>&1 || { echo "selftest: FAIL -- could not build the throwaway repo"; exit 1; }
B="$(cat "$tmp/base")"
bundle_relevant "$tmp/r" "$B" "$(cat "$tmp/apionly")" && bad "api+infra-only range must NOT be relevant" || ok "api+infra-only range is skipped"
bundle_relevant "$tmp/r" "$B" "$(cat "$tmp/web")"     && ok "a range touching apps/web is relevant"    || bad "apps/web range must be relevant"
bundle_relevant "$tmp/r" "$B" "$(cat "$tmp/pkg")"     && ok "a range touching packages/ is relevant"   || bad "packages/ range must be relevant -- this is the founding case's own path"

# --- bundle_failures, against the two real shas (opt-in: it runs two real bundlers) ---------------
if [ "${CC_BUNDLE_SELFTEST_REAL:-0}" = 1 ]; then
  wt="/home/neon/cc-bundle-selftest-$$"
  for probe in "46356720:expect-fail" "e80945dc:expect-pass"; do
    sha="${probe%%:*}"; want="${probe##*:}"
    rm -rf "$wt"; git -C "$CC" worktree add --detach -q "$wt" "$sha" || { bad "cannot check out $sha"; continue; }
    "$HERE/agent-worktree.sh" >/dev/null 2>&1 || true
    out="$(bundle_failures "$wt")"
    git -C "$CC" worktree remove --force "$wt" >/dev/null 2>&1
    if [ "$want" = expect-fail ]; then
      [ -n "$out" ] && ok "$sha reports a failure: ${out%% ::*}" || bad "$sha built, but it is the founding BREAKAGE"
    else
      [ -z "$out" ] && ok "$sha builds clean" || bad "$sha must build -- guard would refuse healthy work: $out"
    fi
  done
else
  echo "  (build half skipped -- CC_BUNDLE_SELFTEST_REAL=1 to run it against 46356720 / e80945dc, ~3 min)"
fi

[ "$fail" = 0 ] && echo "selftest: PASS" || { echo "selftest: FAIL"; exit 1; }
