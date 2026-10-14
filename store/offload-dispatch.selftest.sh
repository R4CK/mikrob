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
  {"id":"loneCard","title":"[FE] Onallo kartya gyerek nelkul","description":"Nincs bontva.","status":"planned","assignee":"fron-ted","project":"MikroB","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]},
  {"id":"decompCard","title":"[marveen][INFRA][SEC] Architektura donteshez teszt es i18n is kell","description":"A kontraktus (architektura) modosul. Kell hozza unit test es a hu/de i18n string forditasok is.","status":"planned","assignee":"backend2","project":"MikroB","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]},
  {"id":"singleRealChild","title":"[BE] Egy valos gyerekkel rendelkezo Feladat","description":"Ez a szulokartya, van egy valodi nyitott gyereke.","status":"planned","assignee":"backend","project":"MikroB","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]},
  {"id":"onlyChildOfSingle","title":"lepes 1: unit test irasa","description":"Ird meg a tesztet.","status":"planned","assignee":"backend","project":"MikroB","parent_id":"singleRealChild","sort_order":1,"archived_at":null,"labels":[]}
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

# --- STALE-IN-PROGRESS SKIP (card eeebd2b5) --------------------------------------------------------
# dispatched_at is a real epoch-seconds timestamp, so the fixture must be generated at test-run time
# rather than hardcoded (mirrors the attempts_op TTL test's pattern of stamping a live timestamp
# further below). freshCard is in_progress, dispatched 100s ago (well under the 600s default) --
# still drafted. staleCard is in_progress, dispatched 700s ago -- excluded. undatedCard is
# in_progress with no dispatched_at at all (never claimed by fireKanbanDispatch) -- included, since
# "unknown" must fail toward drafting, not toward silently starving a leaf forever. stalePlannedCard
# carries the SAME 700s-old dispatched_at as staleCard, but status=planned -- the rule is scoped to
# in_progress only, so this one is unaffected and still drafted.
python3 -c "
import json, time
now = int(time.time())
cards = [
    {'id':'freshCard','title':'friss in_progress','description':'meg csak most kezdte','status':'in_progress','assignee':'backend','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[],'dispatched_at':now-100},
    {'id':'staleCard','title':'regota fut mar','description':'az online agens mar regen dolgozik rajta','status':'in_progress','assignee':'backend','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[],'dispatched_at':now-700},
    {'id':'undatedCard','title':'sosem lett dispatchelve jelezve','description':'nincs dispatched_at','status':'in_progress','assignee':'backend','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[],'dispatched_at':None},
    {'id':'stalePlannedCard','title':'regi datum de meg planned','description':'a szabaly csak in_progress-re vonatkozik','status':'planned','assignee':'backend','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[],'dispatched_at':now-700},
]
json.dump(cards, open('$TMPDIR/fixture-stale.json', 'w'))
"
fresh_out="$(CARD=freshCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale.json" | python3 -c 'import json,sys; print(",".join(l["id"] for l in json.load(sys.stdin)))')"
check "an in_progress leaf dispatched 100s ago (below the 600s default) is still drafted" "$fresh_out" "freshCard"

stale_out="$(CARD=staleCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale.json")"
check "THE POINT OF THE CARD: an in_progress leaf dispatched 700s ago (past the 600s default) is excluded, not drafted" "$stale_out" "[]"

undated_out="$(CARD=undatedCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale.json" | python3 -c 'import json,sys; print(",".join(l["id"] for l in json.load(sys.stdin)))')"
check "an in_progress leaf with no dispatched_at at all fails toward drafting, not toward starving" "$undated_out" "undatedCard"

stale_planned_out="$(CARD=stalePlannedCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale.json" | python3 -c 'import json,sys; print(",".join(l["id"] for l in json.load(sys.stdin)))')"
check "CONTROL: the same 700s-old dispatched_at on a PLANNED (not in_progress) leaf does not skip it" "$stale_planned_out" "stalePlannedCard"

configurable_out="$(CARD=freshCard OFFLOAD_STALE_IN_PROGRESS_SECONDS=50 bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale.json")"
check "OFFLOAD_STALE_IN_PROGRESS_SECONDS is CONFIGURABLE: lowering it to 50s excludes the same 100s-old leaf that passed above" "$configurable_out" "[]"

# MUTATION-STYLE CONTROL: without the fix, staleCard would resolve exactly like freshCard (both
# in_progress with no children) -- proving the skip is the thing doing the work, not something else
# in the fixture shape.
mutation_off="$(CARD=staleCard OFFLOAD_STALE_IN_PROGRESS_SECONDS=99999999 bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale.json" | python3 -c 'import json,sys; print(",".join(l["id"] for l in json.load(sys.stdin)))')"
check "MUTATION: an absurdly high threshold un-skips staleCard, proving the exclusion is threshold-driven" "$mutation_off" "staleCard"

# NON-INTEGER ENV GUARD (card f8e7f7cb, Cybersec F1 LOW on eeebd2b5, Gate-SHA bdb35dfa). Before the
# fix, a non-integer value crashed resolve_leaves()'s python with an uncaught ValueError before any
# leaf resolved, and the caller's stderr redirect hid it -- so a card with NO staleness at all
# (freshCard) ALSO resolved to zero leaves. Checking freshCard (not staleCard) is the point: it
# proves the fallback restores normal resolution, not just that staleCard stays excluded (which an
# "everything resolves to []" crash would also show).
invalid_env_out="$(CARD=freshCard OFFLOAD_STALE_IN_PROGRESS_SECONDS=10m bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale.json" | python3 -c 'import json,sys; print(",".join(l["id"] for l in json.load(sys.stdin)))')"
check "a non-integer OFFLOAD_STALE_IN_PROGRESS_SECONDS falls back to the 600s default instead of silently zeroing every leaf" "$invalid_env_out" "freshCard"

# --- decompose wrapper (card 501c489f, MikroB verdikt komment 6007) -------------------------------
# ISOLATION (d39fc5e7 QA finding): card_decompose_candidates() reads DECOMPOSE_STOP_STATE_FILE to
# check which types are currently disabled. If the live store/decompose-type-disabled.json has all
# four types disabled (e.g. from a MikroB mitigation), the decompose tests all fail because
# card_decompose_candidates() returns nothing. Fix: point to a clean temp file for the whole block
# so the test is independent of live operational state.
export DECOMPOSE_STOP_STATE_FILE="$TMPDIR/decompose-type-disabled-test.json"
printf '{}' > "$DECOMPOSE_STOP_STATE_FILE"

decompose_ids() { CARD="$1" bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; print(",".join(sorted(l["id"] for l in json.load(sys.stdin))))'; }
decompose_field() { CARD="$1" bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" | python3 -c "import json,sys; print(json.load(sys.stdin)[0].get('$2',''))"; }

decomp_ids="$(decompose_ids decompCard)"
check "decompCard (no real children, mechanical text) -> synthetic leaves REPLACE the whole-card fallback" \
  "$decomp_ids" "decompCard~i18n-keys,decompCard~test-scaffold"

decomp_synth_flag="$(decompose_field decompCard synthetic)"
check "synthetic leaf carries synthetic=true" "$decomp_synth_flag" "True"

decomp_no_wholecard="$(CARD=decompCard bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; print("decompCard" in [l["id"] for l in json.load(sys.stdin)])')"
check "REQUIREMENT 2: the decision part (the whole-card leaf itself) is NEVER among the leaves -- it never goes local" \
  "$decomp_no_wholecard" "False"

# SAFETY (requirement 2): the synthetic leaf's OWN "description" (what try_leaf folds into `task`,
# the ONLY thing local-llm-rag.sh's routeTask classifier ever sees -- --context is prompt grounding,
# invisible to routing) must carry the PARENT card's real description text, not just the generic
# template sentence. Without this, routeTask would classify on template boilerplate and never see
# risk signal that lives in the parent's description rather than its title.
decomp_desc_carries_parent="$(CARD=decompCard bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(all("i18n string forditasok" in l["description"] for l in d))')"
check "SAFETY: every synthetic leaf description carries the PARENT description text (routeTask sees the real risk signal)" \
  "$decomp_desc_carries_parent" "True"

# CONTROL: no mechanical shape in the text -> the wrapper is a no-op, byte-identical to resolve_leaves alone.
lone_via_wrapper="$(decompose_ids loneCard)"
check "CONTROL: loneCard (no mechanical shape) -> unchanged fallback, same as --test-resolve" "$lone_via_wrapper" "loneCard"

# CONTROL: a card with a REAL single open child must NOT be decomposed -- only the "no children at
# all" fallback shape qualifies, even though onlyChildOfSingle's own text ("unit test irasa") would
# obviously match the test-scaffold template if it were mistakenly run through it.
single_ids="$(decompose_ids singleRealChild)"
check "CONTROL: a real single open child is resolved as-is, never synthetically decomposed" "$single_ids" "onlyChildOfSingle"

# KILL-SWITCH / MUTATION (ELLENORZES, verdikt komment 6007: "a bontas kikapcsolasaval a teszt pirosra valt"):
off_ids="$(CARD=decompCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=3 CARD_DECOMPOSE=off bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; print(",".join(sorted(l["id"] for l in json.load(sys.stdin))))')"
check "MUTATION: CARD_DECOMPOSE=off -> the exact fixture that decomposed above now falls back to the whole card" "$off_ids" "decompCard"

# GPU-BUDGET CAP (requirement 3, "javaslat: max 3"): a fixture whose text matches all four template
# types, capped by OFFLOAD_DECOMPOSE_MAX_PER_CARD.
cat > "$TMPDIR/fixture-allfour.json" <<'EOF'
[{"id":"allFourCard","title":"[BE] Teszt, i18n, readme es interface egyszerre","description":"Kell unit test, i18n forditas, readme frissites es egy TypeScript interface type definition is.","status":"planned","assignee":"backend2","project":"MikroB","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]}]
EOF
all4_count="$(CARD=allFourCard bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-allfour.json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "GPU-BUDGET CAP: 4 template types match, OFFLOAD_DECOMPOSE_MAX_PER_CARD default(3) caps it" "$all4_count" "3"
cap5_count="$(CARD=allFourCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=1 bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-allfour.json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "GPU-BUDGET CAP is CONFIGURABLE: OFFLOAD_DECOMPOSE_MAX_PER_CARD=1 caps to 1, not a hardcoded 3" "$cap5_count" "1"

# --- attempts_op state machine -------------------------------------------------------------------
AF="$TMPDIR/attempts.json"
op() { bash "$DISPATCH" --test-attempts-op "$1" "$2" --file "$AF"; }

st() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])'; }
at() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["attempts"])'; }

r="$(op check leafX)"
check "a never-seen leaf checks as pending/0" "$(st "$r")|$(at "$r")" "pending|0"

# THRESHOLD 3 -> 2 (card 501c489f, MikroB verdikt komment 6007, requirement 6): the 2nd consecutive
# transient failure now flips to exhausted, not the 3rd.
op transient-fail leafX >/dev/null
r="$(op transient-fail leafX)"
check "2nd consecutive transient failure flips status to exhausted" "$(st "$r")|$(at "$r")" "exhausted|2"

r="$(op check leafX)"
check "a fresh exhausted entry stays exhausted on re-check (no premature TTL reset)" "$(st "$r")" "exhausted"

r="$(op categorical-online leafY)"
check "router-said-online jumps straight to exhausted in ONE call, not 2" "$(st "$r")|$(at "$r")" "exhausted|2"

# The threshold itself is CONFIGURABLE (OFFLOAD_LEAF_MAX_ATTEMPTS), not a hardcoded literal -- a
# non-default value must actually change the behaviour, or the env var is decorative.
r="$(OFFLOAD_LEAF_MAX_ATTEMPTS=4 bash "$DISPATCH" --test-attempts-op transient-fail leafConfigurable --file "$TMPDIR/attempts-cfg.json")"
check "OFFLOAD_LEAF_MAX_ATTEMPTS=4: 1st transient failure stays pending (below the raised ceiling)" "$(st "$r")|$(at "$r")" "pending|1"

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

# --- the VRAM gate is WIRED, and wired BEFORE the sweep (card f9bad591) ------------------------
# WHAT THIS IS AND IS NOT. This is a source pin, not a behaviour test: it cannot prove the sweep
# stops, only that the call is still there and still ahead of the loop. The BEHAVIOUR of the same
# guard is pinned properly in card-build-route.selftest.sh (four cases, both mutants measured red),
# and every leaf here goes through local-llm-rag.sh, which asks the same guard. What this stops is
# the silent deletion -- the failure mode where a guard quietly stops being called and every test
# stays green because none of them ever looked.
#
# Matched on COMMENT-STRIPPED source and on the CALL EXPRESSION, not the bare filename: a comment
# naming the script would otherwise keep this pin green after the call itself was removed.
vram_pin="$(python3 - "$DISPATCH" <<'PYEOF'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
code = re.sub(r"(?m)^\s*#.*$", "", src)
call = re.search(r'bash\s+"\$VRAM_GUARD"', code)
loop = re.search(r"^while IFS=", code, re.M)
print("MISSING" if not call else ("AFTER-LOOP" if loop and call.start() > loop.start() else "OK"))
PYEOF
)"
check "offload-dispatch.sh calls the VRAM guard, ahead of the sweep loop" "$vram_pin" "OK"

# --- graph_repo_for resolves 'mopsion' the same as 'CleanCore' (card 1b02ed3a) -----------------
# A real behaviour check, not a source-pin: graph_repo_for is pure (no side effects beyond a `cd`
# in a subshell), so it is sourced directly out of the live script rather than duplicated here --
# duplicated logic is exactly how this class of miss (a case arm added in one place, not the other)
# happens in the first place.
graph_repo_pin="$(
  # Set HERE explicitly so graph_repo_for's MikroB arm (which calls git -C "$HERE") resolves
  # the repo root correctly regardless of the caller's cwd (d39fc5e7 QA isolation finding).
  HERE="$(dirname "$(realpath "$DISPATCH")")"
  source <(sed -n '/^graph_repo_for() {/,/^}/p' "$DISPATCH")
  cc="$(graph_repo_for CleanCore)"
  mo="$(graph_repo_for mopsion)"
  mk="$(graph_repo_for MikroB)"
  if [[ -z "$cc" || -z "$mo" ]]; then
    echo "EMPTY"
  elif [[ "$cc" != "$mo" ]]; then
    echo "MISMATCH"
  elif [[ -z "$mk" ]]; then
    echo "MIKROB-BROKEN"
  else
    echo "OK"
  fi
)"
check "graph_repo_for('mopsion') resolves to the SAME repo as graph_repo_for('CleanCore')" "$graph_repo_pin" "OK"

# --- the INSTALLED gate is WIRED, ahead of the per-card lock (card 3906d77b follow-up, Peti
# Telegram 8928) ---------------------------------------------------------------------------------
# Same source-pin discipline as the VRAM gate above: proves the call is still there and still
# ahead of the lock, not that the branch behaves correctly (that is B below).
installed_pin="$(python3 - "$DISPATCH" <<'PYEOF'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
code = re.sub(r"(?m)^\s*#.*$", "", src)
call = re.search(r'bash\s+"\$INSTALLED"', code)
lock = re.search(r'flock\s+-n\s+8', code)
print("MISSING" if not call else ("AFTER-LOCK" if lock and call.start() > lock.start() else "OK"))
PYEOF
)"
check "offload-dispatch.sh calls the installed-gate, ahead of the per-card lock" "$installed_pin" "OK"

# --- B. NOT INSTALLED -> exit 0, nothing drafted, never even takes the per-card lock ------------
# A genuine behaviour test (not a source pin): with OFFLOAD_INSTALLED pointing at a stub that says
# "not installed", the real script is invoked with an ordinary card id. If the gate really runs
# BEFORE the lock/curl calls, this returns immediately with no network and no lock file activity --
# if it did not, the call would hang or error looking for a real dashboard token/API.
NOT_INSTALLED_STUB="$TMPDIR/installed-no.sh"
printf '#!/usr/bin/env bash\necho "not-installed: no ollama binary"\nexit 1\n' > "$NOT_INSTALLED_STUB"
chmod +x "$NOT_INSTALLED_STUB"
not_installed_err="$(OFFLOAD_INSTALLED="$NOT_INSTALLED_STUB" \
  timeout 10 bash "$DISPATCH" "selftest-not-installed-$$" 2>&1 1>/dev/null)"; not_installed_rc=$?
check "not-installed -> exit 0 (never blocks dispatch)" "$not_installed_rc" "0"
if [[ "$not_installed_err" == *"local-llm: not installed, branch skipped"* ]]; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  echo "FAIL: not-installed -> stderr names the reason"
  echo "  got: $not_installed_err"
fi

# --- C. ONLINE verdict with an advisory envelope -> the draft is kept, not thrown away ---------------
# local-llm-rag.sh exits 9 on an ONLINE verdict but still prints a JSON envelope with the 7B draft.
# try_leaf used to discard that stdout on rc=9 (9 of 11 dispatches drafted nothing, 2026-09-24).
adv_env='{"advisory":true,"trust":"unverified-local-draft","route":"online","reason":"deterministic-multi-decision","spec":"S","draft":"function f() { return 1 }"}'
adv_out="$(printf '%s' "$adv_env" | bash "$DISPATCH" --test-advisory-draft)"
if [[ "$adv_out" == *"function f() { return 1 }"* && "$adv_out" == *"ONLINE-VERDIKT (deterministic-multi-decision)"* && "$adv_out" == *"TELJES, FUGGETLEN ONLINE FELULVIZSGALAT"* ]]; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1)); echo "FAIL: advisory envelope -> draft body with the full-review header"; echo "  got: $adv_out"
fi
check "empty advisory draft -> nothing (old no-draft path)" \
  "$(printf '%s' '{"advisory":true,"draft":"   "}' | bash "$DISPATCH" --test-advisory-draft)" ""
check "non-advisory JSON -> nothing" \
  "$(printf '%s' '{"advisory":false,"draft":"x"}' | bash "$DISPATCH" --test-advisory-draft)" ""
check "plain text stdout (not an envelope) -> nothing" \
  "$(printf '%s' 'advisory draft here' | bash "$DISPATCH" --test-advisory-draft)" ""
check "empty stdout -> nothing" "$(printf '' | bash "$DISPATCH" --test-advisory-draft)" ""
wired="$(grep -c 'adv_draft="$(printf '"'"'%s'"'"' "$out" | advisory_draft)"' "$DISPATCH")"
check "try_leaf's rc=9 branch uses advisory_draft on the RAG stdout" "$wired" "1"

# --- D. DRAFT COMMENT BODY: mandatory-full-review wording for synthetic (decomposed) drafts
# (requirement 2, verdikt komment 6007) --------------------------------------------------------
synth_body="$(bash "$DISPATCH" --test-draft-comment-body "Parent title" "draft body" true)"
if [[ "$synth_body" == *"KOTELEZO A TELJES, FUGGETLEN ONLINE FELULVIZSGALAT"* ]]; then
  PASS=$((PASS+1)); echo "OK   synthetic=true draft carries the mandatory-full-review wording"
else
  FAIL=$((FAIL+1)); echo "FAIL synthetic=true draft missing the mandatory-full-review wording"; echo "  got: $synth_body"
fi

# NEGATIVE CONTROL: a REAL (non-synthetic) leaf's draft must NOT carry the stronger wording -- an
# always-on header would not be a signal, and this is what proves the flag actually gates something.
real_body_explicit="$(bash "$DISPATCH" --test-draft-comment-body "Parent title" "draft body" false)"
real_body_default="$(bash "$DISPATCH" --test-draft-comment-body "Parent title" "draft body")"
if [[ "$real_body_explicit" != *"KOTELEZO A TELJES, FUGGETLEN ONLINE FELULVIZSGALAT"* && "$real_body_default" != *"KOTELEZO A TELJES, FUGGETLEN ONLINE FELULVIZSGALAT"* ]]; then
  PASS=$((PASS+1)); echo "OK   CONTROL: a real (non-synthetic) leaf's draft does not carry the stronger wording"
else
  FAIL=$((FAIL+1)); echo "FAIL CONTROL: a real leaf's draft unexpectedly carries the synthetic-only wording"
fi

# post_draft_comment forwards $4 (synthetic) to draft_comment_body -- a source pin, not a behaviour
# test (the behaviour is pinned above): proves the wiring cannot silently drop the 4th argument.
forward_pin="$(grep -c 'body="\$(draft_comment_body "\$leaf_title" "\$content" "\$synthetic")"' "$DISPATCH")"
check "post_draft_comment forwards its synthetic argument to draft_comment_body" "$forward_pin" "1"

# --- E. QUALITY GATE (card d39fc5e7, requirement 2) -----------------------------------------------
# --test-quality-gate is the exact function try_leaf() calls before posting any draft -- real
# behaviour coverage lives in draft-quality-gate.selftest.py; this pins the shell-level wiring
# (stdin/argv plumbing into the python helper) so a change to either side cannot silently drift.
qg_fail="$(bash "$DISPATCH" --test-quality-gate "x" "write a vitest test for parseWindow" "")"
check "quality gate: a too-short draft fails through the shell wiring" "${qg_fail%%$'\t'*}" "FAIL"

qg_ok="$(bash "$DISPATCH" --test-quality-gate "import { describe, it, expect } from 'vitest'
describe('x', () => { it('y', () => { expect(1).toBe(1) }) })" "write a vitest test for parseWindow" "")"
check "quality gate: a real, sufficiently-long, non-repeating draft passes through the shell wiring" "$qg_ok" "OK"

# try_leaf() must call BOTH new gates before a draft can be posted -- source pins, same pattern as
# forward_pin above (a missing call here is a silent regression no behaviour test on this file can
# catch, since both gates default to "real" paths that only misbehave when actually wired wrong).
sample_pin="$(grep -c 'sample="\$(decompose_sample_context "\$dtype" "\$task" "\$repo")"' "$DISPATCH")"
check "try_leaf calls decompose_sample_context for synthetic leaves" "$sample_pin" "1"
quality_pin_1="$(grep -c 'qverdict="\$(draft_quality_ok "\$out" "\$task" "\$repo")"' "$DISPATCH")"
check "try_leaf calls draft_quality_ok on the success path" "$quality_pin_1" "1"
quality_pin_2="$(grep -c 'qverdict2="\$(draft_quality_ok "\$adv_draft" "\$task" "\$repo")"' "$DISPATCH")"
check "try_leaf calls draft_quality_ok on the advisory path" "$quality_pin_2" "1"

# a NO-SAMPLE leaf must be marked exhausted via the new "no-sample" attempts_op case, not retried
# forever on a repo tree that will not change between sweep ticks.
no_sample_entry="$(bash "$DISPATCH" --test-attempts-op no-sample noSampleLeaf --file "$TMPDIR/attempts-nosample.json")"
check "attempts_op no-sample marks the leaf exhausted" "$(printf '%s' "$no_sample_entry" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" "exhausted"
check "attempts_op no-sample records the reason" "$(printf '%s' "$no_sample_entry" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reason"])')" "no-sample"

# --- E. DRAFT FILE SINK (card 21fbc293, Gemini-orch 2/4): OFFLOAD_DRAFT_SINK=file redirects the
# draft body to disk instead of the kanban comment ----------------------------------------------
DRAFTS_TMPDIR="$TMPDIR/drafts"

check "sanitize_path_component keeps a plain hex-like id unchanged" \
  "$(bash "$DISPATCH" --test-sanitize-path-component "21fbc293")" "21fbc293"
check "sanitize_path_component neutralizes a path-traversal attempt (../../etc/passwd)" \
  "$(bash "$DISPATCH" --test-sanitize-path-component "../../etc/passwd")" "______etc_passwd"
check "sanitize_path_component neutralizes an absolute path" \
  "$(bash "$DISPATCH" --test-sanitize-path-component "/etc/passwd")" "_etc_passwd"
check "sanitize_path_component keeps the synthetic leaf '~type' suffix shape readable (only '~' folds)" \
  "$(bash "$DISPATCH" --test-sanitize-path-component "realCard~test-scaffold")" "realCard_test-scaffold"

write_out="$(OFFLOAD_DRAFTS_DIR="$DRAFTS_TMPDIR" bash "$DISPATCH" --test-write-draft-to-file "cardAbc" "cardAbc" "the draft body text")"
check "write_draft_to_file's printed path is relative, not absolute" "${write_out:0:1}" "d"
# The printed path is relative to DRAFTS_DIR's OWN parent (dirname "$DRAFTS_TMPDIR" == "$TMPDIR"
# here), not to $HERE -- this is what makes the path correct regardless of where
# OFFLOAD_DRAFTS_DIR actually points (see write_draft_to_file's own comment).
written_abs="$(dirname "$DRAFTS_TMPDIR")/${write_out}"
check "write_draft_to_file actually wrote the file at the path it printed" "$([[ -f "$written_abs" ]] && echo yes || echo no)" "yes"
check "the written file's content is exactly the body passed in" "$(cat "$written_abs" 2>/dev/null)" "the draft body text"
check "the written file lands under drafts/<sanitized cardId>/, not loose in drafts/" "$(dirname "$written_abs")" "$DRAFTS_TMPDIR/cardAbc"
rm -rf "$DRAFTS_TMPDIR"

# PATH-TRAVERSAL: a malicious card id must not escape DRAFTS_TMPDIR, even though write_draft_to_file
# itself never validates emptiness of the sanitized result.
evil_out="$(OFFLOAD_DRAFTS_DIR="$DRAFTS_TMPDIR" bash "$DISPATCH" --test-write-draft-to-file "../../../tmp/evil" "../../../tmp/evil" "pwned")"
evil_abs="$(dirname "$DRAFTS_TMPDIR")/${evil_out}"
check "a path-traversal card id cannot escape DRAFTS_DIR (file lands inside it, sanitized)" \
  "$(python3 -c "import os,sys; p=sys.argv[1]; d=sys.argv[2]; print('inside' if os.path.commonpath([os.path.abspath(p), os.path.abspath(d)]) == os.path.abspath(d) else 'escaped')" "$evil_abs" "$DRAFTS_TMPDIR")" "inside"
check "/tmp/evil was NOT created outside the sandbox by the traversal attempt" "$([[ -e /tmp/evil ]] && echo exists || echo absent)" "absent"
rm -rf "$DRAFTS_TMPDIR"

# REFERENCING COMMENT: carries the path and the same mandatory Draft-Review marker requirement
# (card 1338e68b) as the normal full-content draft comment, but never the draft text itself.
ref_body="$(bash "$DISPATCH" --test-draft-file-ref-comment-body "Parent title" "drafts/cardAbc/123-cardAbc.md" false)"
check "the file-ref comment names the draft path" "$(printf '%s' "$ref_body" | grep -c 'drafts/cardAbc/123-cardAbc.md')" "1"
check "the file-ref comment still carries the mandatory Draft-Review marker instruction" \
  "$(printf '%s' "$ref_body" | grep -c "Draft-Review:")" "1"
check "the file-ref comment does NOT embed a literal draft body (only the path)" \
  "$(printf '%s' "$ref_body" | grep -c 'the draft body text')" "0"
ref_body_synth="$(bash "$DISPATCH" --test-draft-file-ref-comment-body "Parent title" "drafts/cardAbc/123-cardAbc.md" true)"
check "the file-ref comment also carries the mandatory-full-review wording when synthetic=true" \
  "$(printf '%s' "$ref_body_synth" | grep -c 'KOTELEZO A TELJES, FUGGETLEN ONLINE FELULVIZSGALAT')" "1"

# WIRING: post_draft_comment must actually branch on OFFLOAD_DRAFT_SINK, not just have the helper
# functions exist unused (a source pin, same pattern as forward_pin above).
sink_branch_pin="$(grep -c 'if \[\[ "\${OFFLOAD_DRAFT_SINK:-comment}" == "file" \]\]; then' "$DISPATCH")"
check "post_draft_comment branches on OFFLOAD_DRAFT_SINK" "$sink_branch_pin" "1"

# DEFAULT-UNCHANGED REGRESSION (MUTATION-RELEVANT CONTROL): with the sink unset, post_draft_comment
# must still produce the EXACT same body draft_comment_body alone would -- i.e. the file-sink branch
# must be opt-in, not accidentally always-on. We cannot call post_draft_comment directly (it needs a
# live $hdr_file/$DASH), so this pins the two text constructors agree when the sink is not "file":
# draft_comment_body's own contract (tested in section D above) is what post_draft_comment falls
# back to, and this is exactly what the "OFFLOAD_DRAFT_SINK:-comment" default (not "file") encodes.
check "the OFFLOAD_DRAFT_SINK default literal is 'comment' (file sink is opt-in only)" \
  "$(grep -c 'OFFLOAD_DRAFT_SINK:-comment' "$DISPATCH")" "1"

echo
echo "offload-dispatch.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
