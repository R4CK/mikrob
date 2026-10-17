#!/usr/bin/env bash
# MT-09 (card 9e2c33c2): re-checks knowledge-graph anchors on the files a landing touched,
# marking fresh/drifted/gone (EK-MT-8). Called from marveen-land.sh (and, when wired, a product
# land script) right after a successful push.
#
# BEHIND KG_ENABLED, DEFAULT OFF (section 6 of the MODULTERV): with KG_ENABLED unset or anything
# other than "on", this script exits 0 immediately and prints nothing -- the calling land script's
# behavior stays byte-identical to before this card.
#
# Shared across repos on purpose: the knowledge-graph database and its dist/ live in the marveen
# checkout (--main-dist), but --repo-dir is whatever repo was actually landed (marveen's own
# worktree for a marveen card, the mopsion main clone for a mopsion card) -- the anchors table
# itself carries a `repo` column precisely so one store can hold anchors into several repos.
set -euo pipefail

if [ "${KG_ENABLED:-off}" != "on" ]; then
  exit 0
fi

usage() {
  echo "usage: kg-check-landing.sh --repo <name> --repo-dir <path> --base <sha> --sha <sha> [--actor <actor>] [--main-dist <dist-dir>]" >&2
  exit 2
}

REPO=""
REPO_DIR=""
BASE=""
SHA=""
ACTOR="kg-check-landing"
MAIN_DIST="$(cd "$(dirname "$0")/.." && pwd)/dist"
KG_DB_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    --actor) ACTOR="$2"; shift 2 ;;
    --main-dist) MAIN_DIST="$2"; shift 2 ;;
    # Test-only override: kgDbPath() in src/kg/store.ts defaults to the production STORE_DIR with
    # no env-var hook, so a selftest that wants its own disposable db file MUST have an explicit
    # way to point this script at one -- otherwise "testing the landing hook" means writing real
    # rows into the live knowledge-graph.db. Left empty (the default), the real store is used.
    --kg-db-dir) KG_DB_DIR="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$REPO" ] && [ -n "$REPO_DIR" ] && [ -n "$BASE" ] && [ -n "$SHA" ] || usage

# Non-fatal by construction, same as the blast-radius/graphify steps this runs alongside: a
# staleness-check problem must never fail a landing that already passed its real gates.
if [ ! -f "$MAIN_DIST/kg/anchor-staleness.js" ] || [ ! -f "$MAIN_DIST/kg/store.js" ]; then
  echo "kg-check-landing: $MAIN_DIST/kg not built yet -- skipping (non-fatal)"
  exit 0
fi

CHANGED="$(git -C "$REPO_DIR" diff --name-only "$BASE..$SHA" -- || true)"
if [ -z "$CHANGED" ]; then
  exit 0
fi

REPO="$REPO" REPO_DIR="$REPO_DIR" SHA="$SHA" ACTOR="$ACTOR" MAIN_DIST="$MAIN_DIST" CHANGED="$CHANGED" \
  KG_DB_DIR="$KG_DB_DIR" \
  node - <<'NODE'
const { execFileSync } = await import('node:child_process')

const { openKgDb, kgDbPath } = await import(process.env.MAIN_DIST + '/kg/store.js')
const { checkLandingAnchors } = await import(process.env.MAIN_DIST + '/kg/anchor-staleness.js')
const kgDbDirOverride = process.env.KG_DB_DIR || undefined

const changedPaths = (process.env.CHANGED || '').split('\n').filter(Boolean)

function gitShow(sha, path) {
  try {
    return execFileSync('git', ['-C', process.env.REPO_DIR, 'show', `${sha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 50,
    })
  } catch {
    return null
  }
}

const db = openKgDb(kgDbPath(kgDbDirOverride))
try {
  const report = checkLandingAnchors(db, {
    repo: process.env.REPO,
    changedPaths,
    sha: process.env.SHA,
    gitShow,
    actor: process.env.ACTOR,
  })
  console.log(
    `kg-check-landing: checked=${report.checked} unchanged=${report.unchanged} ` +
      `drifted=${report.drifted} gone=${report.gone} stale-nodes=${report.nodesMarkedStale}`,
  )
} finally {
  db.close()
}
NODE
