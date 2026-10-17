#!/usr/bin/env bash
# Selftest for kg-check-landing.sh (MT-09, card 9e2c33c2, EK-MT-8). Exercises the real dist/
# build and a real disposable git repo (git show, not an injected fixture) end to end, so the
# wiring the TS unit tests cannot see -- argv parsing, env handoff, the actual `git show` call --
# gets covered too.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAIN="$(cd "$HERE/.." && pwd)"
SCRIPT="$HERE/kg-check-landing.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }

TD="$(mktemp -d)"
cleanup() { rm -rf "$TD"; }
trap cleanup EXIT

# --- fixture repo ---------------------------------------------------------
REPO="$TD/repo"
mkdir -p "$REPO/src"
git -C "$TD" init -q "$REPO" 2>/dev/null || true
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.com
git -C "$REPO" config user.name test
printf 'function f() {\n  return 1\n}\n' > "$REPO/src/f.ts"
git -C "$REPO" add src/f.ts
git -C "$REPO" commit -q -m v1
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"

# --- fixture kg db ---------------------------------------------------------
# dist/ is real ESM ("type":"module" in package.json) -- require() cannot load it, so every
# inline node snippet below uses dynamic import() via `node -`, the same pattern
# kg-check-landing.sh itself and store/local-llm-rag.sh already use.
KG_DIR="$TD/store"
mkdir -p "$KG_DIR"
MAIN_DIST="$MAIN/dist" KG_DIR="$KG_DIR" BASE_SHA="$BASE_SHA" node - <<'NODE'
const { openKgDb, kgDbPath, upsertNode, upsertAnchor } = await import(process.env.MAIN_DIST + '/kg/store.js')
const { sha256Hex } = await import(process.env.MAIN_DIST + '/kg/anchor-staleness.js')
const db = openKgDb(kgDbPath(process.env.KG_DIR))
upsertNode(db, { id: 'sol:1', type: 'solution', project: 'marveen', title: 'fix', source_ref: 'kanban_comments:1', extractor: 'manual' })
upsertAnchor(db, {
  node_id: 'sol:1', repo: 'marveen', path: 'src/f.ts', line_start: 1, line_end: 3,
  sha: process.env.BASE_SHA, content_hash: sha256Hex('function f() {\n  return 1\n}'),
})
db.close()
NODE

# --- commit the drift-causing change BEFORE the off-gate check, so the off-case below is run
# against a REAL changed range (base != sha, with an anchor on the changed path) -- a gate that
# is actually bypassed, not a no-op that would print nothing anyway because nothing changed. ---
printf 'function f() {\n  return 2\n}\n' > "$REPO/src/f.ts"
git -C "$REPO" add src/f.ts
git -C "$REPO" commit -q -m v2
NEW_SHA="$(git -C "$REPO" rev-parse HEAD)"

# --- case 1: KG_ENABLED off (default) is a byte-identical no-op, even though base != sha and
# there IS a real drift to report -- this is what actually exercises the gate, not just the
# vacuous "nothing changed" case. ---
OUT1="$(KG_ENABLED=off "$SCRIPT" --repo marveen --repo-dir "$REPO" --base "$BASE_SHA" --sha "$NEW_SHA" --kg-db-dir "$KG_DIR" --main-dist "$MAIN/dist" 2>&1)"
if [ -z "$OUT1" ]; then ok "KG_ENABLED=off prints nothing even with a real drift to report"; else bad "KG_ENABLED=off printed: $OUT1"; fi

OUT1B="$("$SCRIPT" --repo marveen --repo-dir "$REPO" --base "$BASE_SHA" --sha "$NEW_SHA" --kg-db-dir "$KG_DIR" --main-dist "$MAIN/dist" 2>&1)"
if [ -z "$OUT1B" ]; then ok "KG_ENABLED unset prints nothing (default off)"; else bad "unset KG_ENABLED printed: $OUT1B"; fi

# --- case 2: with the gate open, the same landing marks the anchor drifted ---
OUT2="$(KG_ENABLED=on "$SCRIPT" --repo marveen --repo-dir "$REPO" --base "$BASE_SHA" --sha "$NEW_SHA" --kg-db-dir "$KG_DIR" --main-dist "$MAIN/dist" 2>&1)"
echo "$OUT2"
case "$OUT2" in
  *"drifted=1"*) ok "KG_ENABLED=on reports drifted=1 on a real git repo + real dist" ;;
  *) bad "expected drifted=1 in output, got: $OUT2" ;;
esac

RESULT="$(MAIN_DIST="$MAIN/dist" KG_DIR="$KG_DIR" node - <<'NODE'
const { openKgDb, kgDbPath, getAnchorsForPath, getNode } = await import(process.env.MAIN_DIST + '/kg/store.js')
const db = openKgDb(kgDbPath(process.env.KG_DIR))
const anchorState = getAnchorsForPath(db, 'marveen', 'src/f.ts')[0].state
const nodeStatus = getNode(db, 'sol:1').status
console.log(JSON.stringify({ anchorState, nodeStatus }))
db.close()
NODE
)"
STATE="$(node -e "console.log(JSON.parse(process.argv[1]).anchorState)" "$RESULT")"
NODE_STATUS="$(node -e "console.log(JSON.parse(process.argv[1]).nodeStatus)" "$RESULT")"
if [ "$STATE" = "drifted" ]; then ok "anchor row state is 'drifted' in the db"; else bad "anchor state is '$STATE', expected 'drifted'"; fi
if [ "$NODE_STATUS" = "stale" ]; then ok "owning node status is 'stale' in the db"; else bad "node status is '$NODE_STATUS', expected 'stale'"; fi

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
