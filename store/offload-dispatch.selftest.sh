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

# --- decompose wrapper (card 501c489f, MikroB verdikt komment 6007) -------------------------------
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

echo
echo "offload-dispatch.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
