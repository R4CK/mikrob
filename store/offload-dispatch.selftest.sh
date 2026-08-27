#!/usr/bin/env bash
# offload-dispatch.selftest.sh -- HTTP/GPU-free unit tests for the leaf-level offload logic added by
# card 1bf37a35 (plan-grilling GO-WITH-CHANGES). Exercises offload-dispatch.sh's two test hooks
# (--test-resolve, --test-attempts-op), which run the EXACT SAME code the real dispatch path uses (see
# the rationale comment above resolve_leaves() in offload-dispatch.sh) -- a pass here can't drift from
# what actually ships. Does not touch the dashboard API, Ollama, or the real store/offload-attempts.json.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="$HERE/offload-dispatch.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

PASS=0
FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $desc"
    echo "  want: $want"
    echo "  got:  $got"
  fi
}

# --- fixture: a Feladat (parentA) with a real leaf (leaf1, leaf2), a mid-level alfeladat (midB) with
# its own leaf (leaf3, so it's a leaf of THAT parent, not of parentA), a done card and an archived
# card (both excluded), plus a standalone card with no children at all (loneCard). --------------------
cat > "$TMPDIR/fixture.json" <<'EOF'
[
  {"id":"parentA","title":"[BE] Feladat A","description":"Nagy feladat leirasa.","status":"in_progress","assignee":"backend","project":"MikroB","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]},
  {"id":"leaf1","title":"lepes 1: X modul irasa","description":"Ird meg az X modult.","status":"planned","assignee":"backend","project":"MikroB","parent_id":"parentA","sort_order":1,"archived_at":null,"labels":[]},
  {"id":"leaf2","title":"lepes 2: teszt","description":"Irj tesztet.","status":"planned","assignee":"backend","project":"MikroB","parent_id":"parentA","sort_order":2,"archived_at":null,"labels":[]},
  {"id":"midB","title":"alfeladat B: nagyobb resz","description":"Ez egy koztes szint tovabbi gyerekekkel.","status":"planned","assignee":"backend","project":"MikroB","parent_id":"parentA","sort_order":3,"archived_at":null,"labels":[]},
  {"id":"leaf3","title":"lepes 3: B alatt","description":"B alatti valos lepes.","status":"planned","assignee":"backend","project":"MikroB","parent_id":"midB","sort_order":1,"archived_at":null,"labels":[]},
  {"id":"leafDone","title":"lepes done","description":"mar kesz","status":"done","assignee":"backend","project":"MikroB","parent_id":"parentA","sort_order":4,"archived_at":null,"labels":[]},
  {"id":"leafArchived","title":"lepes archived","description":"archivalt","status":"planned","assignee":"backend","project":"MikroB","parent_id":"parentA","sort_order":5,"archived_at":1700000000,"labels":[]},
  {"id":"loneCard","title":"[FE] Onallo kartya gyerek nelkul","description":"Nincs bontva.","status":"planned","assignee":"fron-ted","project":"MikroB","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]}
]
EOF

# --- resolve_leaves ------------------------------------------------------------------------------
ids="$(CARD=parentA bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; print(",".join(sorted(l["id"] for l in json.load(sys.stdin))))')"
check "parentA resolves to its 3 real open leaves (crosses the midB level, skips done/archived)" "$ids" "leaf1,leaf2,leaf3"

leaf3_ctx="$(CARD=parentA bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(l for l in d if l["id"]=="leaf3")["parent_context"])')"
check "leaf3 (grandchild) carries BOTH ancestor levels as context, nearest first" "$leaf3_ctx" "alfeladat B: nagyobb resz
Ez egy koztes szint tovabbi gyerekekkel.
---
[BE] Feladat A
Nagy feladat leirasa."

lone_ids="$(CARD=loneCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; print(",".join(l["id"] for l in json.load(sys.stdin)))')"
check "a card with no children resolves to itself (fallback == old whole-card behavior)" "$lone_ids" "loneCard"

lone_tags="$(CARD=loneCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["tags"])')"
check "leading [TAG] bracket in the title is picked up" "$lone_tags" "FE"

done_out="$(CARD=leafDone bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture.json")"
check "a done card resolves to an empty leaf set (never re-drafted)" "$done_out" "[]"

missing_out="$(CARD=doesnotexist bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture.json")"
check "an unknown card id resolves to an empty leaf set" "$missing_out" "[]"

# --- attempts_op state machine -------------------------------------------------------------------
AF="$TMPDIR/attempts.json"
op() { bash "$DISPATCH" --test-attempts-op "$1" "$2" --file "$AF"; }

st() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])'; }
at() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["attempts"])'; }

r="$(op check leafX)"
check "a never-seen leaf checks as pending/0" "$(st "$r")|$(at "$r")" "pending|0"

op transient-fail leafX >/dev/null
op transient-fail leafX >/dev/null
r="$(op transient-fail leafX)"
check "3rd consecutive transient failure flips status to exhausted" "$(st "$r")|$(at "$r")" "exhausted|3"

r="$(op check leafX)"
check "a fresh exhausted entry stays exhausted on re-check (no premature TTL reset)" "$(st "$r")" "exhausted"

r="$(op categorical-online leafY)"
check "router-said-online jumps straight to exhausted in ONE call, not 3" "$(st "$r")|$(at "$r")" "exhausted|3"

op transient-fail leafZ >/dev/null
r="$(op success leafZ)"
check "a success resets attempts to 0 and marks done" "$(st "$r")|$(at "$r")" "done|0"

python3 -c "
import json, time
d = json.load(open('$AF'))
d['leafX']['updated_at'] = int(time.time()) - 100000
json.dump(d, open('$AF', 'w'))
"
r="$(EXHAUSTED_TTL_SECONDS=86400 op check leafX)"
check "an exhausted entry older than the TTL resets to pending on the next check" "$(st "$r")|$(at "$r")" "pending|0"

# --- concurrency: N parallel transient-fail calls on a fresh leaf must not lose an update -----------
AF2="$TMPDIR/attempts-conc.json"
N=15
for _ in $(seq 1 $N); do
  bash "$DISPATCH" --test-attempts-op transient-fail leafConc --file "$AF2" >/dev/null &
done
wait
final_n="$(python3 -c "import json; print(json.load(open('$AF2'))['leafConc']['attempts'])")"
check "N=$N concurrent writers under flock produce exactly N (no lost update)" "$final_n" "$N"

echo
echo "offload-dispatch.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
