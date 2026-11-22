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
  {"id":"decompCard","title":"[marveen][INFRA] Architektura donteshez teszt es i18n is kell","description":"A kontraktus (architektura) modosul. Kell hozza unit test es a hu/de i18n string forditasok is.","status":"planned","assignee":"backend2","project":"MikroB","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]},
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

# LEADING-ZERO/OCTAL + OVERFLOW GUARD (card 27c54ceb, Cybered GO 32951 on 660e3b66): the old
# ^[0-9]+$ regex accepted 08/09 (bash arithmetic treats a 0-prefixed literal as octal and 08/09
# are invalid octal digits -> the `((...))` comparisons this value feeds would error, not compare),
# 010 (decimal 10 misread as octal 8), and anything >= 2^63 (wraps negative in bash's signed
# 64-bit arithmetic). Each of these must now trip the same documented-default fallback as a
# non-numeric value. 12abc/abc12 additionally pin the regex's own anchors: abc12 only fails
# ^(...)$ because of the ^ anchor (it ends in a valid digit run), 12abc only fails because of the
# $ anchor (it starts with one) -- dropping either anchor would wrongly accept one of these two.
for bad in 08 09 010 9223372036854775808 12abc abc12; do
  stale_bad_out="$(CARD=freshCard OFFLOAD_STALE_IN_PROGRESS_SECONDS="$bad" bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale.json" | python3 -c 'import json,sys; print(",".join(l["id"] for l in json.load(sys.stdin)))')"
  check "OFFLOAD_STALE_IN_PROGRESS_SECONDS='$bad' falls back to the 600s default (freshCard still resolves)" "$stale_bad_out" "freshCard"
done

# S FALLBACK VALUE PINNED (card 27c54ceb, Kesz-ha "S/T fallback values asserted"): the existing
# fresh(100s)/stale(700s) pair above only pins the true default somewhere in [100s, 700s]. This
# boundary pair, with OFFLOAD_STALE_IN_PROGRESS_SECONDS UNSET (the real default path, not an
# explicit override), pins it at exactly 600s.
python3 -c "
import json, time
now = int(time.time())
cards = [
    {'id':'justUnderCard','title':'599s','description':'x','status':'in_progress','assignee':'backend','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[],'dispatched_at':now-599},
    {'id':'justOverCard','title':'601s','description':'x','status':'in_progress','assignee':'backend','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[],'dispatched_at':now-601},
]
json.dump(cards, open('$TMPDIR/fixture-stale-boundary.json', 'w'))
"
just_under_out="$(CARD=justUnderCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale-boundary.json" | python3 -c 'import json,sys; print(",".join(l["id"] for l in json.load(sys.stdin)))')"
check "S PIN: with OFFLOAD_STALE_IN_PROGRESS_SECONDS unset, a leaf dispatched 599s ago (just under the true 600s default) still resolves" "$just_under_out" "justUnderCard"
just_over_out="$(CARD=justOverCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale-boundary.json")"
check "S PIN: with OFFLOAD_STALE_IN_PROGRESS_SECONDS unset, a leaf dispatched 601s ago (just over the true 600s default) is excluded" "$just_over_out" "[]"

# S DEFAULT MUTANT PIN (card 81025eb5, Cybered GO 33203 on 27c54ceb): the 599/601 boundary pair
# above does NOT bracket 600 exactly, so a 600->601 default mutant survives it -- is_stale_in_progress()
# compares with `>=` (offload-dispatch.sh, is_stale_in_progress), so age 599 resolves and age 601 is
# excluded under BOTH the real default (600) and a 601 mutant alike; neither age differs between the
# two. Age EXACTLY 600 is the only value where the two defaults disagree: real 600 -> 600>=600 true ->
# excluded; mutant 601 -> 600>=601 false -> resolves. This is that exact age.
python3 -c "
import json, time
now = int(time.time())
cards = [{'id':'exactCard','title':'600s','description':'x','status':'in_progress','assignee':'backend','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[],'dispatched_at':now-600}]
json.dump(cards, open('$TMPDIR/fixture-stale-exact.json', 'w'))
"
exact_out="$(CARD=exactCard bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale-exact.json")"
check "S DEFAULT MUTANT PIN: with OFFLOAD_STALE_IN_PROGRESS_SECONDS unset, a leaf dispatched EXACTLY 600s ago is excluded (kills a 600->601 default mutant that 599/601 alone cannot)" "$exact_out" "[]"

# S FALLBACK-LITERAL MUTANT PIN (card 81025eb5): the invalid-input loop above (OFFLOAD_STALE_IN_PROGRESS_SECONDS
# falls back to 600 on a bad value) only ever checked a 100s-aged fresh leaf, which stays resolved
# under any fallback >= 101s -- it cannot tell a correct fallback (600) from a mutated one (601).
# Same exact-600-age trick as above, but WITH an invalid env value, so this pins the FALLBACK literal
# itself, not the `:-600` default-expansion literal (two different lines in offload-dispatch.sh).
stale_fallback_exact_out="$(CARD=exactCard OFFLOAD_STALE_IN_PROGRESS_SECONDS=nope bash "$DISPATCH" --test-resolve < "$TMPDIR/fixture-stale-exact.json")"
check "S FALLBACK-LITERAL MUTANT PIN: an invalid OFFLOAD_STALE_IN_PROGRESS_SECONDS falls back to exactly 600s (a 601s-aged leaf would still resolve under a 601 fallback, this one is excluded)" "$stale_fallback_exact_out" "[]"

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

# --- VETO INHERITANCE (card e11167c5, Cybersec F1 on 501c489f; narrowed by Peti 12838 "Tiltas"
# after CYBERSEC GO 26252 F1+F2; round 2 after CYBERSEC GO 26557 F1) ------------------------------
# The veto fires on an INDEPENDENT security-signal check (card-build-route.sh --security-signal:
# money / auth-tenant-scope / sec-label gates, or the route-classify.sh SECURITY verdict) run over
# the full, untruncated text -- NOT on the router's bare FIRST-MATCH ONLINE reason (round 1's
# mistake, CYBERSEC GO 26557 F1: an earlier-stage match like deterministic-multi-decision could mask
# a genuine security word appearing later in the same text). A parent with NO security signal
# anywhere must leave veto_online False, so its fragments keep the ORIGINAL 501c489f behaviour
# (their own local attempt on their own text).
python3 -c "
import json
base = 'A kontraktus (architektura) modosul. Kell hozza unit test es a hu/de i18n string forditasok is. '
filler_unit = 'padding szoveg ide. '
pad_len = 699 - len(base)
filler = (filler_unit * (pad_len // len(filler_unit) + 1))[:pad_len]
desc = base + filler + 'meg egy mondat a vegen.'
cards = [{'id':'vetoCard','title':'[marveen][INFRA] Architektura donteshez teszt es i18n is kell','description':desc,'status':'planned','assignee':'backend2','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[]}]
json.dump(cards, open('$TMPDIR/fixture-veto.json', 'w'))
"
veto_ids="$(CARD=vetoCard bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-veto.json" | python3 -c 'import json,sys; print(",".join(sorted(l["id"] for l in json.load(sys.stdin))))')"
check "vetoCard still decomposes into its synthetic fragments (the veto does not change WHICH fragments exist)" \
  "$veto_ids" "vetoCard~i18n-keys,vetoCard~test-scaffold"

# EXCLUDED REASON #1 (round 2: fixture now carries NO security word anywhere, not even past char
# 600 -- round 1's fixture was contaminated by a [SEC] title tag AND an "authorizat" word, so this
# row was actually exercising the DISCRIMINATING REPRO case under round 1's reason-string check, not
# the pure-multi-decision case it claimed to be). Under this rule a parent whose ONLY ONLINE reason
# is multi-decision must NOT veto: multi-decision parents keep the 501c489f fragment-local-attempt
# behaviour (Peti 9159).
veto_flags="$(CARD=vetoCard bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-veto.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(sorted(str(l.get("veto_online")) for l in d)))')"
check "EXCLUDED REASON (deterministic-multi-decision, no security word anywhere): fragments do NOT inherit a veto" \
  "$veto_flags" "False,False"

# MIXED PARENTS (CYBERSEC GO 26557 F1, cybersec's own measured list): a parent whose text matches
# BOTH an earlier-stage, non-security reason AND a security gate must still veto -- the whole point
# of asking the security question independently of which reason the router would have reported
# first. One row per case cybersec measured as wrongly un-vetoed under round 1.
mixed_case() { # $1 = id, $2 = title, $3 = description -> prints veto_online for the single fragment
  python3 -c "
import json
cards = [{'id':'$1','title':'$2','description':'$3','status':'planned','assignee':'backend2','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[]}]
json.dump(cards, open('$TMPDIR/fixture-mixed-$1.json', 'w'))
"
  CARD="$1" bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-mixed-$1.json" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(sorted(str(l.get("veto_online")) for l in d)))' 2>/dev/null
}
check "MIXED (authz + migration): still vetoes" \
  "$(mixed_case mixedAuthzMigration '[marveen][INFRA] authorizat kerdes' 'Kell egy migracios lepes es authorizat ellenorzes is. Unit test is kell hozza.')" "True"
check "MIXED (authz + architektura): still vetoes" \
  "$(mixed_case mixedAuthzArch '[marveen][INFRA] authorizat kerdes' 'Az architektura modosul, es authorizat ellenorzes is kell hozza. Unit test is kell.')" "True"
check "MIXED (tenant scope + refactor): still vetoes" \
  "$(mixed_case mixedTenantRefactor '[marveen][INFRA] tenant scope kerdes' 'A kodot refaktoralni kell, es tenant scope szerinti szures is kell hozza. Unit test is kell.')" "True"
check "MIXED ([SEC] + schema): still vetoes" \
  "$(mixed_case mixedSecSchema '[marveen][INFRA][SEC] sema valtozas' 'A DB schema modosul, migraciora van szukseg. Unit test is kell hozza.')" "True"
check "MIXED (authz + checksum): still vetoes" \
  "$(mixed_case mixedAuthzChecksum '[marveen][INFRA] authorizat kerdes' 'Egy checksum ellenorzest kell irni, es authorizat kerdes is felmerul. Unit test is kell.')" "True"
check "MIXED (authz + validation): still vetoes" \
  "$(mixed_case mixedAuthzValidation '[marveen][INFRA] authorizat kerdes' 'A kliens altal kuldott erteket validalni kell, es authorizat kerdes is felmerul. Unit test is kell.')" "True"

# EXCLUDED REASON #2: vram-hold (ambient/transient capacity state, Peti 12838/MikroB direction) --
# must not veto and must not permanently lock the fragment out across a transient GPU hold.
cat > "$TMPDIR/vram-hold-stub.sh" <<'STUBEOF'
#!/usr/bin/env bash
echo "stub: simulated vram hold" >&2
exit 1
STUBEOF
chmod +x "$TMPDIR/vram-hold-stub.sh"
vram_flags="$(CARD=decompCard CARD_BUILD_ROUTE_VRAM_GUARD="$TMPDIR/vram-hold-stub.sh" bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(sorted(str(l.get("veto_online")) for l in d)))' 2>/dev/null)"
check "EXCLUDED REASON (vram-hold): fragments do NOT inherit a veto on a transient GPU hold" \
  "$vram_flags" "False,False"

# EXCLUDED REASON #3: not-installed (host-level capacity state, same direction as vram-hold).
cat > "$TMPDIR/not-installed-stub.sh" <<'STUBEOF'
#!/usr/bin/env bash
exit 1
STUBEOF
chmod +x "$TMPDIR/not-installed-stub.sh"
installed_flags="$(CARD=decompCard CARD_BUILD_ROUTE_INSTALLED="$TMPDIR/not-installed-stub.sh" bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(sorted(str(l.get("veto_online")) for l in d)))' 2>/dev/null)"
check "EXCLUDED REASON (not-installed): fragments do NOT inherit a veto when the local runtime is absent" \
  "$installed_flags" "False,False"

# DISCRIMINATING REPRO (CYBERSEC GO 26252 F1, cybersec2's fixture-clean.json approach): the ONLY
# veto source is an authz word past char 600, isolated with 3 one-line router stubs so no OTHER
# deterministic gate or model call can produce the ONLINE verdict. This is the fixture the shipped
# test (above, now EXCLUDED REASON #1) failed to provide -- mutant M-a (veto fed desc[:600]) must
# turn this one red, which the backup/mutate/restore cycle below the full suite exercises.
cat > "$TMPDIR/sec-installed-ok.sh" <<'STUBEOF'
#!/usr/bin/env bash
exit 0
STUBEOF
cat > "$TMPDIR/sec-vram-ok.sh" <<'STUBEOF'
#!/usr/bin/env bash
exit 0
STUBEOF
cat > "$TMPDIR/sec-classify-mechanical.sh" <<'STUBEOF'
#!/usr/bin/env bash
echo MECHANICAL
STUBEOF
cat > "$TMPDIR/sec-llm-easy.sh" <<'STUBEOF'
#!/usr/bin/env bash
echo EASY
STUBEOF
chmod +x "$TMPDIR"/sec-*.sh
python3 -c "
import json
base = 'Kell hozza unit test es a hu/de i18n string forditasok is. '
filler_unit = 'padding szoveg ide. '
pad_len = 650 - len(base)
filler = (filler_unit * (pad_len // len(filler_unit) + 1))[:pad_len]
desc = base + filler + 'authorizat kerdes a vegen.'
assert desc.index('authorizat') > 600, 'fixture must place the signal past the old 600-char cut'
cards = [{'id':'secCleanCard','title':'Egyszeru segedfeladat leirasa','description':desc,'status':'planned','assignee':'backend2','project':'MikroB','parent_id':None,'sort_order':1,'archived_at':None,'labels':[]}]
json.dump(cards, open('$TMPDIR/fixture-sec-clean.json', 'w'))
"
sec_clean_flags="$(CARD=secCleanCard \
  CARD_BUILD_ROUTE_INSTALLED="$TMPDIR/sec-installed-ok.sh" \
  CARD_BUILD_ROUTE_VRAM_GUARD="$TMPDIR/sec-vram-ok.sh" \
  CARD_BUILD_ROUTE_CLASSIFY="$TMPDIR/sec-classify-mechanical.sh" \
  CARD_BUILD_ROUTE_LLM="$TMPDIR/sec-llm-easy.sh" \
  CARD_BUILD_ROUTE_ROUTER_JS=/nonexistent \
  bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-sec-clean.json" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(sorted(str(l.get("veto_online")) for l in d)))' 2>/dev/null)"
check "DISCRIMINATING REPRO (deterministic-auth-tenant-scope, isolated via router stubs): fragments inherit the veto when the ONLY ONLINE source is the authz word past char 600" \
  "$sec_clean_flags" "True,True"

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

# GPU-BUDGET CAP REMOVED (card 6d8ef952, Peti Telegram 13829/13838 "no limitation" -- the
# per-card 3-leaf cap comment 31306 named as a gate to remove): a fixture whose text matches all
# four template types now gets all four, by default, not capped to 3.
cat > "$TMPDIR/fixture-allfour.json" <<'EOF'
[{"id":"allFourCard","title":"[BE] Teszt, i18n, readme es interface egyszerre","description":"Kell unit test, i18n forditas, readme frissites es egy TypeScript interface type definition is.","status":"planned","assignee":"backend2","project":"MikroB","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]}]
EOF
all4_count="$(CARD=allFourCard bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-allfour.json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "NO CAP: 4 template types match, all 4 are returned by default (no limitation)" "$all4_count" "4"
cap5_count="$(CARD=allFourCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=1 bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-allfour.json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD remains settable as an explicit ops-side throttle: =1 caps to 1" "$cap5_count" "1"
zero_count="$(CARD=allFourCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=0 bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-allfour.json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD=0 means unbounded, not zero candidates (head -n 0 pitfall)" "$zero_count" "4"

# NON-INTEGER/NEGATIVE GUARD (card 81025eb5, Cybered GO 33203 on 27c54ceb): OFFLOAD_DECOMPOSE_MAX_PER_CARD
# feeds `head -n "$OFFLOAD_DECOMPOSE_MAX_PER_CARD"` with no guard before this card -- a non-numeric
# value made head error with no output (candidates="" -> silent fallback to the WHOLE card, no
# decomposition at all), and a negative value is head's own "all but the last N lines" syntax,
# which can hand back MORE candidates than the ceiling allows. decompCard (fixture.json, defined
# above) matches exactly 2 template types -- small enough that each of these actually changes the
# observable leaf count, not just the log line.
decompose_stderr="$TMPDIR/decompose-stderr.log"

# "abc": head errors before writing anything -> unguarded, candidates="" -> whole-card fallback
# (1 leaf, decompCard itself). Guarded: falls back to the documented default (3), 2 <= 3, unaffected.
abc_count="$(CARD=decompCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=abc bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" 2>"$decompose_stderr" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD='abc' falls back to the default (0, unbounded): decompCard still decomposes into both leaves" "$abc_count" "2"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD='abc' prints the documented fallback log line" \
  "$(grep -qF "OFFLOAD_DECOMPOSE_MAX_PER_CARD=abc is not an integer -- falling back to the documented default (0, unbounded)" "$decompose_stderr" && echo yes)" "yes"

# FALLBACK LITERAL PIN (card e2406a43, updated for 6d8ef952's "no limitation" default): the 2-leaf
# fixture above cannot distinguish "falls back to 0/unbounded" from "falls back to any cap >= 2" --
# a mutant that changes the fallback literal to a small positive cap would survive undetected. Use
# the 4-template fixture instead: an invalid value must fall back to EXACTLY unbounded (4), not a
# smaller cap.
abc4_count="$(CARD=allFourCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=abc bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-allfour.json" 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "FALLBACK LITERAL PIN: OFFLOAD_DECOMPOSE_MAX_PER_CARD='abc' on a 4-match fixture falls back to unbounded (4)" "$abc4_count" "4"

# "-1": unguarded, head -n -1 on 2 candidate lines prints "all but the last 1" = 1 line, UNDER the
# intended ceiling by accident here but demonstrating the same head-syntax hijack the card warns
# about (on a longer candidate list this direction flips to MORE than the ceiling). Guarded: falls
# back to 0/unbounded -- still both leaves.
neg_count="$(CARD=decompCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=-1 bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" 2>"$decompose_stderr" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD=-1 falls back to the default (0, unbounded): decompCard still decomposes into both leaves, head's own -N syntax does not leak through" "$neg_count" "2"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD=-1 prints the documented fallback log line" \
  "$(grep -qF "OFFLOAD_DECOMPOSE_MAX_PER_CARD=-1 is not an integer -- falling back to the documented default (0, unbounded)" "$decompose_stderr" && echo yes)" "yes"

# ZERO HANDLING -- SEMANTICS CHANGED by card 6d8ef952 (Peti "no limitation" directive): "0" used to
# mean "decompose nothing synthetically" (whole-card, non-synthetic fallback); it is now the
# DEFAULT value and means "unbounded" (see the resolver's own "OFFLOAD_DECOMPOSE_MAX_PER_CARD=0
# (the default) means unbounded" comment above try_leaf). The old "explicit disable" behavior this
# block pinned no longer exists -- there is deliberately no longer a way to force a zero-candidate
# whole-card fallback via this variable. Covered already by the zero_count check near the top of
# this section (0 -> 4, unbounded); kept here only to pin that 0 is still accepted with no fallback
# log line (it is a valid value, not an invalid one falling back to the default).
zero_decompose_stderr="$TMPDIR/decompose-zero-stderr.log"
CARD=allFourCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=0 bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture-allfour.json" >/dev/null 2>"$zero_decompose_stderr"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD=0 is accepted as-is, no fallback log line" \
  "$(grep -qF "OFFLOAD_DECOMPOSE_MAX_PER_CARD=0 is not an integer" "$zero_decompose_stderr" && echo fallback-fired || echo clean)" "clean"

# "08": leading-zero/octal shape, same convention as the MAX_SUBTASKS/TTL/STALE guards -- head
# itself parses "08" as decimal 8 either way, so this fixture cannot show a behavioral difference;
# pinned by log line only, consistent with the sibling guards' own documented limits.
zero8_stderr="$TMPDIR/decompose-zero8-stderr.log"
CARD=decompCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=08 bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" >/dev/null 2>"$zero8_stderr"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD='08' prints the documented fallback log line" \
  "$(grep -qF "OFFLOAD_DECOMPOSE_MAX_PER_CARD=08 is not an integer -- falling back to the documented default (0, unbounded)" "$zero8_stderr" && echo yes)" "yes"

# LOG-LINE FORGERY PIN (CWE-117, card e2406a43 LOW-1, Cybered GO 34272): same reasoning as the
# OFFLOAD_MAX_SUBTASKS pair above -- every PER_CARD value checked so far %q's to itself unchanged,
# so a revert of this guard's %q escaping back to a raw echo would pass every check above untouched.
decompose_nl_stderr="$TMPDIR/decompose-nl-stderr.log"
CARD=decompCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=$'1\nFAKE LOG LINE INJECTED' bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" >/dev/null 2>"$decompose_nl_stderr"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD with an embedded newline: exactly one stderr line (no forged second line)" \
  "$(wc -l < "$decompose_nl_stderr" | tr -d ' ')" "1"

decompose_esc_stderr="$TMPDIR/decompose-esc-stderr.log"
CARD=decompCard OFFLOAD_DECOMPOSE_MAX_PER_CARD=$'\x1b[31mRED' bash "$DISPATCH" --test-resolve-decompose < "$TMPDIR/fixture.json" >/dev/null 2>"$decompose_esc_stderr"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD with a raw ESC byte: exactly one stderr line" \
  "$(wc -l < "$decompose_esc_stderr" | tr -d ' ')" "1"
check "OFFLOAD_DECOMPOSE_MAX_PER_CARD with a raw ESC byte: %q-escaped, no literal ESC byte reaches the log" \
  "$(grep -cP '\x1b' "$decompose_esc_stderr" || true)" "0"

# Valid-value-honoured case already covered above (cap5_count: OFFLOAD_DECOMPOSE_MAX_PER_CARD=1 caps to 1).

# --- attempts_op state machine -------------------------------------------------------------------
# ISOLATION (card a5c827ca): attempts_op() flocks ATTEMPTS_LOCK, which defaults to the real, shared
# store/.offload-attempts.lock -- every --test-attempts-op call below scopes --file to $TMPDIR but
# none of them scoped the lock, so under a concurrent fleet-test run they contended for the same
# flock as a live offload-dispatch.sh sweep on the host. Scope it here, once, for every call below.
export ATTEMPTS_LOCK="$TMPDIR/.offload-attempts.lock"
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

# NON-INTEGER ENV GUARD, sibling env 1/3 (card 660e3b66, same bug class as f8e7f7cb's
# OFFLOAD_STALE_IN_PROGRESS_SECONDS fix). Before the fix, a non-integer EXHAUSTED_TTL_SECONDS
# crashed attempts_op()'s python `int(...)` call with an uncaught ValueError.
python3 -c "
import json, time
d = json.load(open('$AF'))
d['leafX']['updated_at'] = int(time.time()) - 100000
json.dump(d, open('$AF', 'w'))
"
ttl_stderr="$TMPDIR/ttl-stderr.log"
r="$(EXHAUSTED_TTL_SECONDS=30d bash "$DISPATCH" --test-attempts-op check leafX --file "$AF" 2>"$ttl_stderr")"
check "a non-integer EXHAUSTED_TTL_SECONDS falls back to the 86400s default (the old entry still resets to pending)" "$(st "$r")|$(at "$r")" "pending|0"
check "a non-integer EXHAUSTED_TTL_SECONDS prints the documented fallback log line" \
  "$(grep -qF "EXHAUSTED_TTL_SECONDS='30d' is not an integer -- falling back to the documented default (86400s)" "$ttl_stderr" && echo yes)" "yes"

# LEADING-ZERO/OCTAL + OVERFLOW GUARD (card 27c54ceb, Cybered GO 32951 on 660e3b66) -- see the same
# comment on the OFFLOAD_STALE_IN_PROGRESS_SECONDS block above for why each of these must fail.
for bad in 08 09 010 9223372036854775808 12abc abc12; do
  leaf_id="ttlBad_${bad//[^a-zA-Z0-9]/_}"
  bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_id" --file "$AF" >/dev/null
  bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_id" --file "$AF" >/dev/null
  python3 -c "
import json, time
d = json.load(open('$AF'))
d['$leaf_id']['updated_at'] = int(time.time()) - 100000
json.dump(d, open('$AF', 'w'))
"
  r="$(EXHAUSTED_TTL_SECONDS="$bad" bash "$DISPATCH" --test-attempts-op check "$leaf_id" --file "$AF")"
  check "EXHAUSTED_TTL_SECONDS='$bad' falls back to the 86400s default ($leaf_id resets to pending)" "$(st "$r")|$(at "$r")" "pending|0"
done

# T FALLBACK VALUE PINNED (card 27c54ceb, Kesz-ha "S/T fallback values asserted"): the explicit
# EXHAUSTED_TTL_SECONDS=86400 test above and the invalid-env fallback tests only pin the true
# default somewhere under 100000s. This boundary pair, with EXHAUSTED_TTL_SECONDS UNSET (the real
# default path), pins it at exactly 86400s.
leaf_ttl_under="ttlBoundaryUnder"
bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_ttl_under" --file "$AF" >/dev/null
bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_ttl_under" --file "$AF" >/dev/null
python3 -c "
import json, time
d = json.load(open('$AF'))
d['$leaf_ttl_under']['updated_at'] = int(time.time()) - 86399
json.dump(d, open('$AF', 'w'))
"
r="$(bash "$DISPATCH" --test-attempts-op check "$leaf_ttl_under" --file "$AF")"
check "T PIN: with EXHAUSTED_TTL_SECONDS unset, an exhausted entry aged 86399s (just under the true 86400s default) stays exhausted" "$(st "$r")" "exhausted"

leaf_ttl_over="ttlBoundaryOver"
bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_ttl_over" --file "$AF" >/dev/null
bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_ttl_over" --file "$AF" >/dev/null
python3 -c "
import json, time
d = json.load(open('$AF'))
d['$leaf_ttl_over']['updated_at'] = int(time.time()) - 86401
json.dump(d, open('$AF', 'w'))
"
r="$(bash "$DISPATCH" --test-attempts-op check "$leaf_ttl_over" --file "$AF")"
check "T PIN: with EXHAUSTED_TTL_SECONDS unset, an exhausted entry aged 86401s (just over the true 86400s default) resets to pending" "$(st "$r")|$(at "$r")" "pending|0"

# T FALLBACK-LITERAL MUTANT PIN (card 81025eb5, Cybered GO 33203 on 27c54ceb): the invalid-input
# tests above (EXHAUSTED_TTL_SECONDS=30d / bad leading-zero values) only ever check an entry aged
# 100000s past the TTL -- that stays "reset to pending" whether the fallback is the real 86400 or a
# mutated 86401, so they cannot tell the two apart. Re-run the SAME 86401-aged boundary case the T
# PIN above uses, but WITH an invalid env value, so a mutation to the FALLBACK literal (not the
# `:-86400` default-expansion literal) is caught too.
leaf_ttl_fallback_over="ttlFallbackBoundaryOver"
bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_ttl_fallback_over" --file "$AF" >/dev/null
bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_ttl_fallback_over" --file "$AF" >/dev/null
python3 -c "
import json, time
d = json.load(open('$AF'))
d['$leaf_ttl_fallback_over']['updated_at'] = int(time.time()) - 86401
json.dump(d, open('$AF', 'w'))
"
r="$(EXHAUSTED_TTL_SECONDS=notanumber bash "$DISPATCH" --test-attempts-op check "$leaf_ttl_fallback_over" --file "$AF")"
check "T FALLBACK-LITERAL MUTANT PIN: an invalid EXHAUSTED_TTL_SECONDS falls back to exactly 86400s (an 86401s-aged entry resets to pending; a mutated 86401 fallback would keep it exhausted)" "$(st "$r")|$(at "$r")" "pending|0"

# NON-INTEGER ENV GUARD, sibling env 2/3. Before the fix, a non-integer OFFLOAD_LEAF_MAX_ATTEMPTS
# would reach both attempts_op()'s python `int(...)` and the shell retry-ceiling comparison.
attempts_stderr="$TMPDIR/attempts-stderr.log"
AF3="$TMPDIR/attempts-maxattempts.json"
bash "$DISPATCH" --test-attempts-op transient-fail leafMaxAttemptsGuard --file "$AF3" >/dev/null
r="$(OFFLOAD_LEAF_MAX_ATTEMPTS=four bash "$DISPATCH" --test-attempts-op transient-fail leafMaxAttemptsGuard --file "$AF3" 2>"$attempts_stderr")"
check "a non-integer OFFLOAD_LEAF_MAX_ATTEMPTS falls back to the default ceiling (2): 2nd transient failure exhausts" "$(st "$r")|$(at "$r")" "exhausted|2"
check "a non-integer OFFLOAD_LEAF_MAX_ATTEMPTS prints the documented fallback log line" \
  "$(grep -qF "OFFLOAD_LEAF_MAX_ATTEMPTS='four' is not an integer -- falling back to the documented default (2)" "$attempts_stderr" && echo yes)" "yes"

# LEADING-ZERO/OCTAL + OVERFLOW GUARD (card 27c54ceb, Cybered GO 32951 on 660e3b66) -- see the same
# comment on the OFFLOAD_STALE_IN_PROGRESS_SECONDS block above for why each of these must fail.
for bad in 08 09 010 9223372036854775808 12abc abc12; do
  leaf_id="leafMaxAttemptsBad_${bad//[^a-zA-Z0-9]/_}"
  af_bad="$TMPDIR/attempts-maxattempts-$leaf_id.json"
  bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_id" --file "$af_bad" >/dev/null
  r="$(OFFLOAD_LEAF_MAX_ATTEMPTS="$bad" bash "$DISPATCH" --test-attempts-op transient-fail "$leaf_id" --file "$af_bad")"
  check "OFFLOAD_LEAF_MAX_ATTEMPTS='$bad' falls back to the default ceiling (2): 2nd transient failure exhausts" "$(st "$r")|$(at "$r")" "exhausted|2"
done

# NON-INTEGER ENV GUARD, sibling env 3/3.
subtasks_stderr="$TMPDIR/subtasks-stderr.log"
bash "$DISPATCH" --test-attempts-op check leafSubtasksGuard --file "$TMPDIR/attempts-subtasks.json" >/dev/null 2>"$subtasks_stderr"
OFFLOAD_MAX_SUBTASKS=lots bash "$DISPATCH" --test-attempts-op check leafSubtasksGuard --file "$TMPDIR/attempts-subtasks.json" >/dev/null 2>"$subtasks_stderr"
check "a non-integer OFFLOAD_MAX_SUBTASKS prints the documented fallback log line" \
  "$(grep -qF "OFFLOAD_MAX_SUBTASKS=lots is not an integer -- falling back to the documented default (15)" "$subtasks_stderr" && echo yes)" "yes"

# LEADING-ZERO/OCTAL + OVERFLOW GUARD (card 27c54ceb, Cybered GO 32951 on 660e3b66) -- see the same
# comment on the OFFLOAD_STALE_IN_PROGRESS_SECONDS block above for why each of these must fail.
for bad in 08 09 010 9223372036854775808 12abc abc12; do
  bad_stderr="$TMPDIR/subtasks-bad-stderr.log"
  OFFLOAD_MAX_SUBTASKS="$bad" bash "$DISPATCH" --test-attempts-op check leafSubtasksGuard --file "$TMPDIR/attempts-subtasks.json" >/dev/null 2>"$bad_stderr"
  check "OFFLOAD_MAX_SUBTASKS='$bad' prints the documented fallback log line" \
    "$(grep -qF "OFFLOAD_MAX_SUBTASKS=$bad is not an integer -- falling back to the documented default (15)" "$bad_stderr" && echo yes)" "yes"
done

# LOG-LINE FORGERY PIN (CWE-117, card e2406a43 LOW-1, Cybered GO 34272): the leading-zero/overflow
# checks above all pin VALUES that happen to %q to themselves unchanged (no shell-special chars), so
# a mutant that reverts the %q escaping back to a raw echo of $OFFLOAD_MAX_SUBTASKS leaves every one
# of them green -- the fix for the actual log-forgery bug was itself unpinned. These two values are
# hostile: a literal newline (would print as a second, forged log line if echoed raw) and an ANSI/ESC
# sequence (would inject raw terminal escapes into the log if echoed raw). Both fail the integer
# regex the same way any other garbage does, so they hit the identical fallback branch; the only
# question is whether %q renders them as ONE safe, single-line token or lets them through raw.
nl_stderr="$TMPDIR/subtasks-nl-stderr.log"
OFFLOAD_MAX_SUBTASKS=$'1\nFAKE LOG LINE INJECTED' bash "$DISPATCH" --test-attempts-op check leafSubtasksGuard --file "$TMPDIR/attempts-subtasks.json" >/dev/null 2>"$nl_stderr"
check "OFFLOAD_MAX_SUBTASKS with an embedded newline: exactly one stderr line (no forged second line)" \
  "$(wc -l < "$nl_stderr" | tr -d ' ')" "1"

esc_stderr="$TMPDIR/subtasks-esc-stderr.log"
OFFLOAD_MAX_SUBTASKS=$'\x1b[31mRED' bash "$DISPATCH" --test-attempts-op check leafSubtasksGuard --file "$TMPDIR/attempts-subtasks.json" >/dev/null 2>"$esc_stderr"
check "OFFLOAD_MAX_SUBTASKS with a raw ESC byte: exactly one stderr line" \
  "$(wc -l < "$esc_stderr" | tr -d ' ')" "1"
check "OFFLOAD_MAX_SUBTASKS with a raw ESC byte: %q-escaped, no literal ESC byte reaches the log" \
  "$(grep -cP '\x1b' "$esc_stderr" || true)" "0"

# BARE-0 ACCEPTED, NOT REJECTED (card 81025eb5, Cybered GO 33203 on 27c54ceb): the regex is
# `^(0|[1-9][0-9]{0,8})$`, so a bare "0" is a VALID value, not an invalid one -- an explicit
# OFFLOAD_MAX_SUBTASKS=0 (meaning "offload nothing this run") must be honoured, not silently
# rejected and replaced with the 15 fallback.
zero_stderr="$TMPDIR/subtasks-zero-stderr.log"
OFFLOAD_MAX_SUBTASKS=0 bash "$DISPATCH" --test-attempts-op check leafSubtasksGuard --file "$TMPDIR/attempts-subtasks.json" >/dev/null 2>"$zero_stderr"
check "OFFLOAD_MAX_SUBTASKS=0 is accepted as-is, no fallback log line" \
  "$(grep -qF "OFFLOAD_MAX_SUBTASKS=0 is not an integer" "$zero_stderr" && echo fallback-fired || echo clean)" "clean"

# DEFAULT/FALLBACK LITERAL PIN (card e2406a43, follow-up to 81025eb5): the log-line checks above
# only pin the DOCUMENTED NUMBER in the message text, not the actual value OFFLOAD_MAX_SUBTASKS is
# set to -- a mutant that changes the real default/fallback literal (15 -> 16) in BOTH assignments
# survives every check above untouched, since the message's own "(15)" is a separate string literal.
# --test-subtasks-budget-reached exposes the real post-guard value against the exact comparison the
# main loop uses, so this pins the literal's actual runtime effect, not its description.
check "DEFAULT LITERAL PIN: unset OFFLOAD_MAX_SUBTASKS, attempted=14 (< 15) does not reach the budget" \
  "$(bash "$DISPATCH" --test-subtasks-budget-reached 14)" "ok"
check "DEFAULT LITERAL PIN: unset OFFLOAD_MAX_SUBTASKS, attempted=15 (== 15) reaches the budget" \
  "$(bash "$DISPATCH" --test-subtasks-budget-reached 15)" "reached"
check "FALLBACK LITERAL PIN: OFFLOAD_MAX_SUBTASKS=lots (invalid) falls back to 15, attempted=14 does not reach" \
  "$(OFFLOAD_MAX_SUBTASKS=lots bash "$DISPATCH" --test-subtasks-budget-reached 14)" "ok"
check "FALLBACK LITERAL PIN: OFFLOAD_MAX_SUBTASKS=lots (invalid) falls back to 15, attempted=15 reaches" \
  "$(OFFLOAD_MAX_SUBTASKS=lots bash "$DISPATCH" --test-subtasks-budget-reached 15)" "reached"

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
  # Card 22835648: graph_repo_for now calls env_compat_get (MOPSION_MAIN/CLEANCORE_MAIN), a
  # separate function this extraction does not pull in on its own.
  # shellcheck source=./env-compat-lib.sh
  source "$HERE/env-compat-lib.sh"
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

# --- graph_repo_for('MikroB') does not depend on the CALLER's cwd (card 56b14f14) --------------
# `git -C "$HERE" rev-parse --git-common-dir` (no --path-format) answers RELATIVE TO "$HERE", but
# a bare `cd` resolving that answer runs in the CALLER's own shell, against the CALLER's cwd, not
# "$HERE".
#
# QA FAIL round 2 (qa2, comment 26511): the original version of this test set
# HERE="$(dirname "$(realpath "$DISPATCH")")" -- wherever offload-dispatch.sh ITSELF lives. Every
# sanctioned gating path for this repo (gate-worktree-pattern, fleet-test.sh's shared tree,
# agent-worktree-marveen.sh) runs the script from inside a LINKED WORKTREE, and a worktree's .git
# file always stores an ALREADY-ABSOLUTE gitdir pointer -- so `git -C "$HERE" rev-parse
# --git-common-dir` returns an absolute path there regardless of the fix, and the mutant (reverting
# the fix) never goes red under any of those gates. Confirmed by qa2 on two independent worktrees.
#
# Fixed by building a REAL (non-worktree) repo for the test itself: `git init` always gets a real
# .git directory, never a worktree pointer, so the relative-answer bug is reproduced regardless of
# which kind of checkout happens to be running this selftest. HERE is a subdirectory of that repo
# (mirroring "$dir"/store in the real bug), and the caller's shell cwd is a SEPARATE, unrelated repo
# root -- a non-git cwd would also trigger the mutant, but a separate repo root is a stronger check
# (pre-fix, it would have resolved to WRONG caller's repo rather than merely failing).
graph_repo_cwd_pin="$(
  MAIN_REPO="$(mktemp -d)"
  CALLER_REPO="$(mktemp -d)"
  trap 'rm -rf "$MAIN_REPO" "$CALLER_REPO"' EXIT
  MAIN_REPO="$(cd "$MAIN_REPO" && pwd -P)"
  git init -q "$MAIN_REPO"
  mkdir -p "$MAIN_REPO/store"
  git init -q "$CALLER_REPO"
  cd "$CALLER_REPO" || exit 1
  HERE="$MAIN_REPO/store"
  # shellcheck source=./env-compat-lib.sh
  source "$(dirname "$(realpath "$DISPATCH")")/env-compat-lib.sh"
  source <(sed -n '/^graph_repo_for() {/,/^}/p' "$DISPATCH")
  mk="$(graph_repo_for MikroB)"
  [[ "$mk" == "$MAIN_REPO" ]] && echo "OK" || echo "BROKEN:$mk"
)"
check "graph_repo_for('MikroB') resolves correctly from a real (non-worktree) checkout, called from an unrelated repo's cwd" "$graph_repo_cwd_pin" "OK"

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
# WhiteHat2 F2 (21fbc293, comment 18065): a fixed, shared "/tmp/evil" target is not hermetic -- any
# other concurrent selftest/gate run (or a leftover directory from a prior run) can make this check
# false either way. The escape target name is unique per invocation ($$ + $RANDOM) instead.
EVIL_MARKER="evil-selftest-$$-$RANDOM"
EVIL_TARGET="/tmp/$EVIL_MARKER"
evil_out="$(OFFLOAD_DRAFTS_DIR="$DRAFTS_TMPDIR" bash "$DISPATCH" --test-write-draft-to-file "../../../tmp/$EVIL_MARKER" "../../../tmp/$EVIL_MARKER" "pwned")"
evil_abs="$(dirname "$DRAFTS_TMPDIR")/${evil_out}"
check "a path-traversal card id cannot escape DRAFTS_DIR (file lands inside it, sanitized)" \
  "$(python3 -c "import os,sys; p=sys.argv[1]; d=sys.argv[2]; print('inside' if os.path.commonpath([os.path.abspath(p), os.path.abspath(d)]) == os.path.abspath(d) else 'escaped')" "$evil_abs" "$DRAFTS_TMPDIR")" "inside"
check "$EVIL_TARGET was NOT created outside the sandbox by the traversal attempt" "$([[ -e "$EVIL_TARGET" ]] && echo exists || echo absent)" "absent"
rm -rf "$EVIL_TARGET" 2>/dev/null || true
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

# --- HEAVY SECOND-OPINION (card f0b3b674, MikroB plan-grilling GO-WITH-CHANGES C1/C2/C3/C6) -------
# GEMINI_HEAVY_FLAG points this at a scratch path, never at $HERE/... (card 9b224eec: a selftest
# must never create/remove a file inside the shared checkout, even one it restores before exiting --
# every other vitest worker reads that same tree mid-run; selftests-do-not-mutate-the-shared-tree.
# test.ts statically flags exactly an `rm`/`touch`-adjacent anchor on a $HERE-derived variable).
HEAVY_FLAG="$TMPDIR/gemini-heavy-second-opinion-enabled"
export GEMINI_HEAVY_FLAG="$HEAVY_FLAG"

check "gemini_heavy_second_opinion_enabled() defaults OFF (C1, flag file absent)" \
  "$(bash "$DISPATCH" --test-heavy-enabled)" "off"

touch "$HEAVY_FLAG"
check "gemini_heavy_second_opinion_enabled() turns ON when the flag file exists" \
  "$(bash "$DISPATCH" --test-heavy-enabled)" "on"
rm -f "$HEAVY_FLAG"
check "gemini_heavy_second_opinion_enabled() turns back OFF once the flag file is removed" \
  "$(bash "$DISPATCH" --test-heavy-enabled)" "off"
unset GEMINI_HEAVY_FLAG

# reserve_heavy_gemini_slot(): real flock+python3 against a throwaway seged-hivo.py root (same
# isolation pattern as src/__tests__/gemini-ghost-budget.test.ts -- copied, not symlinked, because
# scripts/seged-hivo.py's own ROOT is __file__-based and a symlink would resolve back to the real
# repo and defeat the sandbox).
HEAVY_TD="$(mktemp -d)"
mkdir -p "$HEAVY_TD/scripts" "$HEAVY_TD/store"
cp "$HERE/../scripts/seged-hivo.py" "$HEAVY_TD/scripts/seged-hivo.py"
: > "$HEAVY_TD/store/seged-hivo-naplo.jsonl"
export SEGED_HIVO_HELPERS="$HEAVY_TD/scripts/seged-hivo.py"
export GEMINI_AGY_HOURLY_LOCK="$HEAVY_TD/gemini-agy-call.hourly.lock"
export GEMINI_AGY_HOURLY_LIMIT=5
export GEMINI_AGY_HEAVY_HOURLY_LIMIT=3

r1="$(bash "$DISPATCH" --test-heavy-reserve cardA; echo "rc=$?")"
r2="$(bash "$DISPATCH" --test-heavy-reserve cardB; echo "rc=$?")"
r3="$(bash "$DISPATCH" --test-heavy-reserve cardC; echo "rc=$?")"
r4="$(bash "$DISPATCH" --test-heavy-reserve cardD; echo "rc=$?")"
check "reserve_heavy_gemini_slot: 1st of the sub-cap succeeds" "$r1" "$(printf 'ok\nrc=0')"
check "reserve_heavy_gemini_slot: 2nd of the sub-cap succeeds" "$r2" "$(printf 'ok\nrc=0')"
check "reserve_heavy_gemini_slot: 3rd (== GEMINI_AGY_HEAVY_HOURLY_LIMIT) still succeeds" "$r3" "$(printf 'ok\nrc=0')"
check "reserve_heavy_gemini_slot: C2 sub-cap -- the 4th heavy reservation in the same hour is CAPPED, even though the shared 5/hour total is not exhausted" "$r4" "$(printf 'capped\nrc=1')"
check "reserve_heavy_gemini_slot appends exactly 3 log rows, all tagged seged=agy-heavy" \
  "$(grep -c '"seged": "agy-heavy"' "$HEAVY_TD/store/seged-hivo-naplo.jsonl")" "3"

rm -f "$HEAVY_TD/store/seged-hivo-naplo.jsonl"; : > "$HEAVY_TD/store/seged-hivo-naplo.jsonl"
python3 -c "
import json, datetime
with open('$HEAVY_TD/store/seged-hivo-naplo.jsonl', 'w') as f:
    for i in range(5):
        f.write(json.dumps({'ido': datetime.datetime.now().isoformat(), 'hivas_id': 'shared%d' % i,
                             'seged': 'agy', 'hivo': 'agy-call', 'kartya': 'c', 'feladattipus': 'kod',
                             'status': 'ok'}) + '\n')
"
shared_capped="$(bash "$DISPATCH" --test-heavy-reserve cardE; echo "rc=$?")"
check "reserve_heavy_gemini_slot: C2 shared-window -- capped when 'agy' rows alone already fill the shared 5/hour total (heavy must not add a SEPARATE ceiling)" \
  "$shared_capped" "$(printf 'capped\nrc=1')"

unset SEGED_HIVO_HELPERS GEMINI_AGY_HOURLY_LOCK GEMINI_AGY_HOURLY_LIMIT GEMINI_AGY_HEAVY_HOURLY_LIMIT
rm -rf "$HEAVY_TD"

# try_gemini_second_opinion_for_leaf / gemini_second_opinion_comment_body (C6): distinct header from
# the stop-period draft, carries the mandatory Draft-Review instruction, never implies the online
# agent's work is replaced. No dedicated CLI test hook exists for this body constructor (no side
# effects, no network/token dependency) -- pinned at the source level instead, same tier as the
# "WIRING" source-pins used elsewhere in this file for post_draft_comment's branch.
header_pin="$(grep -c '\[GEMINI DRAFT | second-opinion\]' "$DISPATCH")"
check "the second-opinion draft header is wired into the source exactly once" "$header_pin" "1"
check "gemini_second_opinion_comment_body is defined" "$(grep -c 'gemini_second_opinion_comment_body() {' "$DISPATCH")" "1"
check "gemini_second_opinion_comment_body is called from try_gemini_second_opinion_for_leaf" \
  "$(grep -c 'body="\$(gemini_second_opinion_comment_body' "$DISPATCH")" "1"
never_short_circuits_pin="$(grep -c 'try_gemini_second_opinion_for_leaf "\$leaf_id" "\$leaf_title" "\$task" "\$post_id"$' "$DISPATCH")"
check "the categorical-online call site never uses the result of try_gemini_second_opinion_for_leaf (routing unaffected)" "$never_short_circuits_pin" "1"
goal1_elif_pin="$(grep -c 'elif gemini_heavy_second_opinion_enabled && ! is_gemini_blocked' "$DISPATCH")"
check "GOAL 1 (enable without stop) is wired as an independent elif branch on the fallback-after-exhaustion path" "$goal1_elif_pin" "1"

# --- card 52c13499: mikrob never parks, and one nudge per card not per leaf ------------------------
# (1) /api/agents never lists the channels-agent itself, so agent_is_running("mikrob") always fell
# through to false -- nudge_recipient must not read that as "mikrob PARKOLVA" (7. szabaly: mikrob
# never parks). Simulates the exact buggy running=0 input and checks the PARKOLVA text is gone.
mikrob_parked_sim="$(bash "$DISPATCH" --test-nudge-recipient mikrob 0)"
check "nudge_recipient(mikrob, running=0) never says PARKOLVA (mikrob never parks, rule 7)" \
  "$(printf '%s' "$mikrob_parked_sim" | grep -c PARKOLVA)" "0"
check "nudge_recipient(mikrob, running=0) still routes to mikrob" \
  "$(printf '%s' "$mikrob_parked_sim" | cut -f1)" "mikrob"
# A real agent's parked case must still say so -- the fix is mikrob-specific, not a general relax.
check "nudge_recipient(backend, running=0) still says PARKOLVA for an ordinary agent" \
  "$(bash "$DISPATCH" --test-nudge-recipient backend 0 | grep -c PARKOLVA)" "1"

# (2) card 501c489f's decomposition posted 3 near-identical drafts for ONE real card as 3 separate
# nudges (measured: msg 5131/5133/5134, same card, within a minute). aggregate_nudge_events groups
# nudge_leaf_owner's recorded events by the real card id (the part of a leaf id before "~" for a
# synthetic fragment, the whole id for a real leaf) -- 3 synthetic fragments of one card must collapse
# to exactly 1 group line, carrying the total draft count and every fragment's leaf id.
synth_group="$(printf '8a80ebdb~unit-test\tbackend\tdraft\n8a80ebdb~i18n\tbackend\tdraft\n8a80ebdb~readme\tbackend\tdraft\n' | bash "$DISPATCH" --test-aggregate-nudge-events)"
check "3 synthetic fragments of ONE card aggregate into exactly 1 group line" \
  "$(printf '%s\n' "$synth_group" | wc -l | tr -d ' ')" "1"
check "the one group line carries the card id, draft count 3, and all 3 fragment ids" \
  "$synth_group" "$(printf '8a80ebdb\tbackend\t3\t0\t8a80ebdb~unit-test,8a80ebdb~i18n,8a80ebdb~readme')"

# Two genuinely DISTINCT real cards (no "~", never the same post_id) must stay two separate groups --
# the fix collapses repeats of the SAME card, it must not also merge unrelated cards into one notice.
distinct_group="$(printf 'cardA\tbackend\tdraft\ncardB\tbackend2\texhausted\n' | bash "$DISPATCH" --test-aggregate-nudge-events)"
check "two distinct real cards stay as two separate group lines" \
  "$(printf '%s\n' "$distinct_group" | wc -l | tr -d ' ')" "2"
check "an exhausted-only card's group line carries exhausted_count 1 and draft_count 0" \
  "$(printf '%s\n' "$distinct_group" | awk -F'\t' '$1=="cardB"')" "$(printf 'cardB\tbackend2\t0\t1\tcardB')"

# --- card 4eb3743e: route=freellm (helyi -> freellm -> online) ------------------------------------
# All three cases drive the REAL freellm-call.sh (not a mock) via --test-freellm-attempt /
# --test-capacity-route, HTTP-free: the content gate (gemini-agy-category-check.py + secret/PII
# scan) runs and rejects BEFORE any network attempt, and a missing/invalid switch file fails closed
# before even that -- so a sensitive prompt and a disabled switch never reach the network, exactly
# like the real route. FREELLM_SWITCH / FREELLM_AUTH_TOKEN_FILE are freellm-call.sh's own env
# overrides (not an offload-dispatch.sh invention), pointed at scratch files under $TMPDIR.
echo '{"enabled":true}' > "$TMPDIR/freellm-enabled.json"
echo 'dummy-token' > "$TMPDIR/freellm-token.txt"

# Case 1: switch off (missing switch file) -> freellm-call.sh exits 2, no attempt made.
switch_off_out="$(FREELLM_SWITCH="$TMPDIR/freellm-does-not-exist.json" bash "$DISPATCH" --test-freellm-attempt "irj egy segedfuggvenyt" 2>/dev/null)"; switch_off_rc=$?
check "freellm switch off -> --test-freellm-attempt prints disabled" "$switch_off_out" "disabled"
check "freellm switch off -> exit code 2" "$switch_off_rc" "2"

# Case 2: switch on, SENSITIVE content (stem "authz") -> freellm-call.sh's own content gate refuses
# (exit 4), before any network call.
sensitive_out="$(FREELLM_SWITCH="$TMPDIR/freellm-enabled.json" FREELLM_AUTH_TOKEN_FILE="$TMPDIR/freellm-token.txt" bash "$DISPATCH" --test-freellm-attempt "irj meg egy authz ellenorzest" 2>/dev/null)"; sensitive_rc=$?
check "freellm sensitive card (authz stem) -> --test-freellm-attempt prints gate-refused" "$sensitive_out" "gate-refused"
check "freellm sensitive card -> exit code 4" "$sensitive_rc" "4"

# Case 3: GPU-hold -- the capacity-route sweep branch must try freellm per leaf, not just give up.
# Fed three leaves with project "mikrob" (so they clear the is_freellm_blocked project gate),
# switch ON, NO auth-token file: leafPlain carries no "gemini-ok" marker and is now (card 392d7104,
# Peti 13201) BLOCKED by is_freellm_blocked's marker check before freellm-call.sh is even invoked;
# leafWithMarker carries the marker, clears the gate, and only then hits the (missing) auth-token
# check -> "disabled", still zero network calls; the sensitive leaf (title contains the "authz"
# stem) is blocked by is_freellm_blocked's OWN content gate (M1 fix, WhiteHat NO-GO 28484) --
# doubly so now, since it also lacks the marker. The point of this case is the ROUTING, not the
# live API: every leaf got a freellm routing DECISION instead of the old unconditional skip, and
# the gate still tells them apart.
gpu_hold_out="$(printf '[{"id":"leafPlain","project":"mikrob","title":"egyszeru segedfuggveny","description":"irj egy kis segedfuggvenyt"},{"id":"leafWithMarker","project":"mikrob","tags":"gemini-ok","title":"egyszeru segedfuggveny","description":"irj egy kis segedfuggvenyt"},{"id":"leafSensitive","project":"mikrob","title":"authz modul","description":"irj meg egy authz ellenorzest"}]' \
  | FREELLM_SWITCH="$TMPDIR/freellm-enabled.json" FREELLM_AUTH_TOKEN_FILE="$TMPDIR/freellm-no-token.txt" \
    OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$TMPDIR/no-skip-file-does-not-exist" bash "$DISPATCH" --test-capacity-route 2>/dev/null)"
check "GPU-hold case: all three leaves got a freellm routing decision (3 output lines, named by leaf id)" \
  "$(printf '%s\n' "$gpu_hold_out" | wc -l | tr -d ' ')" "3"
check "card 392d7104 (Peti 13201): a clean leaf WITHOUT the gemini-ok marker never reaches freellm-call.sh (blocked)" \
  "$(printf '%s\n' "$gpu_hold_out" | grep -c '^leafPlain blocked$')" "1"
check "card 392d7104 (Peti 13201): the SAME leaf WITH the gemini-ok marker clears the gate and reaches freellm-call.sh (switch off here -> disabled)" \
  "$(printf '%s\n' "$gpu_hold_out" | grep -c '^leafWithMarker disabled$')" "1"
check "GPU-hold case: the sensitive leaf is blocked by is_freellm_blocked's own content gate, before freellm-call.sh" \
  "$(printf '%s\n' "$gpu_hold_out" | grep -c '^leafSensitive blocked$')" "1"

# Case 4 (WhiteHat NO-GO 28484, M1 fix -- mopsion project, neutral text): a card in the mopsion
# project with NEUTRAL wording (no sensitive stem) used to pass freellm-call.sh's own text-only
# content gate and reach the network -- is_freellm_blocked's project allowlist now catches it
# BEFORE any freellm attempt, regardless of how neutral the text is.
mopsion_out="$(printf '[{"id":"leafMopsion","project":"mopsion","title":"egyszeru segedfuggveny","description":"irj egy kis segedfuggvenyt"}]' \
  | FREELLM_SWITCH="$TMPDIR/freellm-enabled.json" FREELLM_AUTH_TOKEN_FILE="$TMPDIR/freellm-token.txt" bash "$DISPATCH" --test-capacity-route 2>/dev/null)"
check "M1 fix: mopsion project + neutral text is blocked under capacity hold (never reaches freellm-call.sh)" \
  "$mopsion_out" "leafMopsion blocked"

# Case 5 (WhiteHat NO-GO 28484, M1 fix -- sec label, neutral text): a card tagged "sec" with
# NEUTRAL wording used to pass the same way -- is_freellm_blocked's tag block catches it.
seclabel_out="$(printf '[{"id":"leafSecTag","project":"mikrob","tags":"sec","title":"egyszeru segedfuggveny","description":"irj egy kis segedfuggvenyt"}]' \
  | FREELLM_SWITCH="$TMPDIR/freellm-enabled.json" FREELLM_AUTH_TOKEN_FILE="$TMPDIR/freellm-token.txt" bash "$DISPATCH" --test-capacity-route 2>/dev/null)"
check "M1 fix: sec-tagged card + neutral text is blocked under capacity hold (never reaches freellm-call.sh)" \
  "$seclabel_out" "leafSecTag blocked"

# Case 6 (card 6d8ef952, Peti Telegram 13829/13838 "no limitation", MikroB msg 18628/18638):
# veto_online no longer skips the freellm attempt under capacity hold -- a synthetic fragment
# whose parent was vetoed ONLINE on content/security grounds still gets a draft attempt; the
# decision-shaped parent card itself stays ONLINE for review regardless (untouched by this).
# Only is_freellm_blocked (project/tag/marker -- genuine "nothing to draft with") still blocks.
veto_check_out="$(printf '[{"id":"leafVetoed","project":"mikrob","tags":"gemini-ok","title":"egyszeru segedfuggveny","description":"irj egy kis segedfuggvenyt","veto_online":true}]' \
  | FREELLM_SWITCH="$TMPDIR/freellm-enabled.json" FREELLM_AUTH_TOKEN_FILE="$TMPDIR/freellm-token.txt" bash "$DISPATCH" --test-capacity-route 2>/dev/null)"
check "card 6d8ef952: a veto_online=true leaf is NOT blocked by the veto alone (only is_freellm_blocked gates it)" \
  "$veto_check_out" "leafVetoed failed"

# Case 6b: the same veto_online=true leaf, but WITHOUT the gemini-ok marker, IS still blocked --
# proves the removal is specific to the security veto, not a blanket bypass of is_freellm_blocked.
veto_no_marker_out="$(printf '[{"id":"leafVetoedNoMarker","project":"mikrob","title":"egyszeru segedfuggveny","description":"irj egy kis segedfuggvenyt","veto_online":true}]' \
  | FREELLM_SWITCH="$TMPDIR/freellm-enabled.json" FREELLM_AUTH_TOKEN_FILE="$TMPDIR/freellm-token.txt" bash "$DISPATCH" --test-capacity-route 2>/dev/null)"
check "card 6d8ef952: veto_online=true WITHOUT the gemini-ok marker is still blocked (is_freellm_blocked, not the veto)" \
  "$veto_no_marker_out" "leafVetoedNoMarker blocked"

# ============================================================================================
# Card 5aa686f0 (392d7104 follow-up, WhiteHat LOW 28818): L1 (behavioral pins for the freellm
# marker-gate guards, replacing the old TS source-text regex pins) + L2 (opt-out file must be an
# explicit {"enabled": true}, not merely present).
# ============================================================================================

# ---- L2: the opt-out file's CONTENT decides, not its mere presence --------------------------
SKIP_FILE="$TMPDIR/freellm-skip-gemini-ok-check"
check_marker_blocked() { # $1 = label, $2 = expected ("blocked"|"allowed")
  local label="$1" want="$2" rc
  DASHBOARD_URL="http://127.0.0.1:1" OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$SKIP_FILE" \
    bash "$DISPATCH" --check-freellm-blocked mikrob "" "egyszeru feladat" "irj egy fuggvenyt" >/dev/null 2>&1
  rc=$?
  local got="blocked"; [[ "$rc" -eq 42 ]] && got="allowed"
  check "L2 opt-out content ($label)" "$got" "$want"
}
rm -f "$SKIP_FILE"
check_marker_blocked "file absent" "blocked"
: > "$SKIP_FILE"
check_marker_blocked "empty file" "blocked"
printf 'off' > "$SKIP_FILE"
check_marker_blocked "content is the bare word 'off'" "blocked"
printf '{"enabled": false}' > "$SKIP_FILE"
check_marker_blocked 'content is {"enabled": false}' "blocked"
printf '{"enabled": "True"}' > "$SKIP_FILE"
check_marker_blocked 'content is {"enabled": "True"} (string, type confusion)' "blocked"
printf '{"enabled": true}' > "$SKIP_FILE"
check_marker_blocked 'content is {"enabled": true} (the only disabling value)' "allowed"
rm -f "$SKIP_FILE"

# ---- M2 (card 555419a8, CYBERED MEDIUM 25494): a FIFO or a device must not be opened at all ------
# Both run under `timeout`: before the fix, a FIFO hung the whole check open and a /dev/zero symlink
# read until memory ran out -- either is a dispatcher-wide stall, not just a wrong verdict, so the
# pass condition is "returns at all, blocked" not merely "returns blocked".
FIFO_FILE="$TMPDIR/freellm-skip-fifo"
rm -f "$FIFO_FILE"; mkfifo "$FIFO_FILE"
fifo_rc_out="$(timeout 8 env OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$FIFO_FILE" DASHBOARD_URL="http://127.0.0.1:1" \
  bash "$DISPATCH" --check-freellm-blocked mikrob "" "egyszeru feladat" "irj egy fuggvenyt" >/dev/null 2>&1; echo $?)"
check "M2: opt-out path is a FIFO -- returns within 8s instead of hanging" "$([[ "$fifo_rc_out" == "124" ]] && echo TIMED-OUT || echo "returned($fifo_rc_out)")" "returned(0)"
rm -f "$FIFO_FILE"

DEVZERO_LINK="$TMPDIR/freellm-skip-devzero"
rm -f "$DEVZERO_LINK"; ln -s /dev/zero "$DEVZERO_LINK"
devzero_rc_out="$(timeout 8 env OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$DEVZERO_LINK" DASHBOARD_URL="http://127.0.0.1:1" \
  bash "$DISPATCH" --check-freellm-blocked mikrob "" "egyszeru feladat" "irj egy fuggvenyt" >/dev/null 2>&1; echo $?)"
check "M2: opt-out path is a symlink to /dev/zero -- returns within 8s, blocked (fail-closed)" "$([[ "$devzero_rc_out" == "124" ]] && echo TIMED-OUT || echo "returned($devzero_rc_out)")" "returned(0)"
rm -f "$DEVZERO_LINK"

python3 -c 'print("{\"enabled\": true, \"pad\": \"" + "x"*5000 + "\"}")' > "$SKIP_FILE"
check_marker_blocked "M2: opt-out file is valid JSON (enabled:true) but over the 4096-byte cap" "blocked"
rm -f "$SKIP_FILE"

# ---- L1: behavioral pins for the two production freellm-fallback guard sites ----------------
# Not a source-text regex (that is exactly what 28818's L1 found too weak): each case here RUNS
# the real --test-freellm-fallback-site hook, which calls the real extracted guard function
# directly. FREELLM_CALL points at a stub that writes a marker file and exits 2 ("switch off") --
# the marker file's existence is the signal "the guard let an attempt through", independent of
# the final exit code (which can still be 1/blocked even when the attempt itself leaked through
# an upstream always-true branch, mutant 3's exact shape).
FREELLM_STUB="$TMPDIR/freellm-stub.sh"
MARKER="$TMPDIR/freellm-attempt-marker"
cat > "$FREELLM_STUB" << 'EOF'
#!/usr/bin/env bash
touch "$FREELLM_ATTEMPT_MARKER"
exit 2
EOF
chmod +x "$FREELLM_STUB"

run_fallback_site() { # $1=script path, $2=site, $3..=site args -> sets $rc, writes/clears $MARKER first
  rm -f "$MARKER"
  FREELLM_ATTEMPT_MARKER="$MARKER" OFFLOAD_FREELLM_CALL="$FREELLM_STUB" DASHBOARD_URL="http://127.0.0.1:1" \
    OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$TMPDIR/no-skip-file-does-not-exist" \
    bash "$1" --test-freellm-fallback-site "${@:2}" >/dev/null 2>&1
  rc=$?
}

# Baseline args per site: NO "gemini-ok" marker, project "mikrob" -- is_freellm_blocked blocks
# this shape by default (no skip file), so the REAL guard must never let the stub run.
EXHAUSTED_ARGS=(exhausted mikrob "" "egyszeru feladat" "irj egy fuggvenyt" leaf1 "task text" leaf1 false)
CAPHOLD_ARGS=(capacity-hold false mikrob "" "title" "desc" leaf2 "task" leaf2 false)
# card 6d8ef952 (real freellm_fallback_capacity_hold_site, not the --test-capacity-route
# reimplementation above): lveto=true must NOT by itself block the real site function any more --
# only is_freellm_blocked may. CAPHOLD_VETO_LEAKS has the gemini-ok marker (is_freellm_blocked
# allows it) and must leak; CAPHOLD_VETO_BLOCKED has no marker (is_freellm_blocked still blocks
# it) and must stay clean -- together they prove the veto argument is ignored while
# is_freellm_blocked is still consulted, not a blanket bypass.
CAPHOLD_VETO_LEAKS_ARGS=(capacity-hold true mikrob gemini-ok title desc leaf2c task leaf2c false)
CAPHOLD_VETO_BLOCKED_ARGS=(capacity-hold true mikrob "" title desc leaf2d task leaf2d false)

run_fallback_site "$DISPATCH" "${EXHAUSTED_ARGS[@]}"
check "L1 baseline (exhausted site, real code): blocked shape never reaches freellm-call.sh" \
  "$([[ -f "$MARKER" ]] && echo leaked || echo clean)" "clean"
run_fallback_site "$DISPATCH" "${CAPHOLD_ARGS[@]}"
check "L1 baseline (capacity-hold site, real code): blocked shape never reaches freellm-call.sh" \
  "$([[ -f "$MARKER" ]] && echo leaked || echo clean)" "clean"
run_fallback_site "$DISPATCH" "${CAPHOLD_VETO_LEAKS_ARGS[@]}"
check "card 6d8ef952 (real capacity-hold site): lveto=true + gemini-ok marker reaches freellm-call.sh (veto no longer gates it)" \
  "$([[ -f "$MARKER" ]] && echo leaked || echo clean)" "leaked"
run_fallback_site "$DISPATCH" "${CAPHOLD_VETO_BLOCKED_ARGS[@]}"
check "card 6d8ef952 (real capacity-hold site): lveto=true WITHOUT the marker still blocked (is_freellm_blocked, not the veto)" \
  "$([[ -f "$MARKER" ]] && echo leaked || echo clean)" "clean"

# ---- card 685f25cb (MikroB measured audit, 2026-11-20): every freellm_call.sh ledger row was
# agent_id=unknown/card_id=NULL because try_freellm_for_leaf never set FREELLM_CALLER/
# FREELLM_CARD_ID. Pin that the real assignee + post_id now reach the stub's environment, through
# BOTH guard-site wrappers (the new trailing arg each threads through to try_freellm_for_leaf). ---
FREELLM_ENV_STUB="$TMPDIR/freellm-env-stub.sh"
FREELLM_ENV_OUT="$TMPDIR/freellm-env-out.txt"
cat > "$FREELLM_ENV_STUB" << 'EOF'
#!/usr/bin/env bash
printf 'CALLER=%s CARD_ID=%s\n' "${FREELLM_CALLER:-}" "${FREELLM_CARD_ID:-}" > "$FREELLM_ENV_OUT_FILE"
exit 2
EOF
chmod +x "$FREELLM_ENV_STUB"

rm -f "$FREELLM_ENV_OUT"
OFFLOAD_FREELLM_CALL="$FREELLM_ENV_STUB" FREELLM_ENV_OUT_FILE="$FREELLM_ENV_OUT" DASHBOARD_URL="http://127.0.0.1:1" \
  OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$TMPDIR/no-skip-file-does-not-exist" \
  bash "$DISPATCH" --test-freellm-fallback-site exhausted mikrob gemini-ok "attrib cim" "attrib leiras" attribleaf "task text" attribcard false backend2 \
  >/dev/null 2>&1
check "card 685f25cb: exhausted-site wiring passes assignee/post_id to freellm-call.sh as FREELLM_CALLER/FREELLM_CARD_ID" \
  "$(cat "$FREELLM_ENV_OUT" 2>/dev/null)" "CALLER=backend2 CARD_ID=attribcard"

rm -f "$FREELLM_ENV_OUT"
OFFLOAD_FREELLM_CALL="$FREELLM_ENV_STUB" FREELLM_ENV_OUT_FILE="$FREELLM_ENV_OUT" DASHBOARD_URL="http://127.0.0.1:1" \
  OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$TMPDIR/no-skip-file-does-not-exist" \
  bash "$DISPATCH" --test-freellm-fallback-site capacity-hold false mikrob gemini-ok "attrib cim2" "attrib leiras2" attribleaf2 "task text" attribcard2 false backend3 \
  >/dev/null 2>&1
check "card 685f25cb: capacity-hold-site wiring passes assignee/post_id to freellm-call.sh as FREELLM_CALLER/FREELLM_CARD_ID" \
  "$(cat "$FREELLM_ENV_OUT" 2>/dev/null)" "CALLER=backend3 CARD_ID=attribcard2"

# ---- card 685f25cb: an UNSET assignee (e.g. the plain --test-freellm-fallback-site baseline
# calls above, which never pass one) falls back to "unknown", not an empty string -- the
# dashboard's calls list must never show a blank agent. -----------------------------------------
rm -f "$FREELLM_ENV_OUT"
OFFLOAD_FREELLM_CALL="$FREELLM_ENV_STUB" FREELLM_ENV_OUT_FILE="$FREELLM_ENV_OUT" DASHBOARD_URL="http://127.0.0.1:1" \
  OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$TMPDIR/no-skip-file-does-not-exist" \
  bash "$DISPATCH" --test-freellm-fallback-site exhausted mikrob gemini-ok "attrib cim3" "attrib leiras3" attribleaf3 "task text" attribcard3 false \
  >/dev/null 2>&1
check "card 685f25cb: a missing assignee falls back to FREELLM_CALLER=unknown, never blank" \
  "$(cat "$FREELLM_ENV_OUT" 2>/dev/null)" "CALLER=unknown CARD_ID=attribcard3"

# --- F3 routing-table shadow logging (card cdde2666) -------------------------------------------
# --test-route-shadow calls card_route_shadow_log() directly, the SAME function and only call
# site the main leaf loop uses -- not a reimplementation.
SHADOW_LOG="$TMPDIR/card-route-shadow.log"

# Case 7: CARD_ROUTE_MODE unset (the default) is byte-identical to before this card -- the
# function must return before even checking whether the table script exists. Proven by pointing
# CARD_ROUTE_TABLE at a script that WOULD fail loudly if ever invoked; legacy mode must never call it.
rm -f "$SHADOW_LOG" "$TMPDIR/table-must-not-run.sh"
cat > "$TMPDIR/table-must-not-run.sh" <<'EOF'
#!/usr/bin/env bash
echo "SHOULD NEVER RUN" >&2
exit 7
EOF
chmod +x "$TMPDIR/table-must-not-run.sh"
OFFLOAD_CARD_ROUTE_TABLE="$TMPDIR/table-must-not-run.sh" OFFLOAD_CARD_ROUTE_SHADOW_LOG="$SHADOW_LOG" \
  bash "$DISPATCH" --test-route-shadow leafA "readme fix" "small readme fix" "" mikrob false "card1~doc-update" card1
check "legacy mode (CARD_ROUTE_MODE unset): no shadow log file is created" \
  "$([[ -f "$SHADOW_LOG" ]] && echo exists || echo absent)" "absent"

# Case 8: CARD_ROUTE_MODE=legacy (explicit) is the same as unset.
rm -f "$SHADOW_LOG"
CARD_ROUTE_MODE=legacy OFFLOAD_CARD_ROUTE_TABLE="$TMPDIR/table-must-not-run.sh" OFFLOAD_CARD_ROUTE_SHADOW_LOG="$SHADOW_LOG" \
  bash "$DISPATCH" --test-route-shadow leafA "readme fix" "small readme fix" "" mikrob false "card1~doc-update" card1
check "legacy mode (explicit): no shadow log file is created" \
  "$([[ -f "$SHADOW_LOG" ]] && echo exists || echo absent)" "absent"

# Case 9: shadow mode logs a non-sensitive mechanical fragment, with the table chain, without
# acting on it (the function never returns a routing decision to anything).
rm -f "$SHADOW_LOG"
CARD_ROUTE_MODE=shadow OFFLOAD_CARD_ROUTE_SHADOW_LOG="$SHADOW_LOG" \
  bash "$DISPATCH" --test-route-shadow leafA "readme fix" "small readme fix" "gemini-ok" mikrob false "card1~doc-update" card1
check "shadow mode: logs type=doc-update sensitive=non-sensitive" \
  "$(grep -c 'type=doc-update.*sensitive=non-sensitive' "$SHADOW_LOG" 2>/dev/null)" "1"
check "shadow mode: logs the real table chain" \
  "$(grep -c 'table-chain=freellm,local,online' "$SHADOW_LOG" 2>/dev/null)" "1"

# Case 10: shadow mode on a sensitive fragment (inherited parent veto) logs sensitive=sensitive --
# same gate this file already uses (lveto), not a weaker shadow-only check.
rm -f "$SHADOW_LOG"
CARD_ROUTE_MODE=shadow OFFLOAD_CARD_ROUTE_SHADOW_LOG="$SHADOW_LOG" \
  bash "$DISPATCH" --test-route-shadow leafB "billing fix" "stripe webhook" "" mikrob true "card2~test-scaffold" card2
check "shadow mode: a veto'd fragment logs sensitive=sensitive" \
  "$(grep -c 'type=test-scaffold.*sensitive=sensitive' "$SHADOW_LOG" 2>/dev/null)" "1"

# Case 11: shadow mode on a fragment that is sensitive by CONTENT (not veto) also logs
# sensitive=sensitive -- proves is_freellm_blocked's own content gate is consulted, not just lveto.
rm -f "$SHADOW_LOG"
CARD_ROUTE_MODE=shadow OFFLOAD_CARD_ROUTE_SHADOW_LOG="$SHADOW_LOG" \
  bash "$DISPATCH" --test-route-shadow leafC "authz check" "irj meg egy authz ellenorzest" "" mikrob false "card3~type-def" card3
check "shadow mode: content-sensitive fragment (no veto) logs sensitive=sensitive" \
  "$(grep -c 'type=type-def.*sensitive=sensitive' "$SHADOW_LOG" 2>/dev/null)" "1"

# Case 12: a real (non-decomposed) leaf id, no "~type" suffix, logs type=leaf.
rm -f "$SHADOW_LOG"
CARD_ROUTE_MODE=shadow OFFLOAD_CARD_ROUTE_SHADOW_LOG="$SHADOW_LOG" \
  bash "$DISPATCH" --test-route-shadow leafPlain "small helper" "small helper plus tests" "" mikrob false "false" leafPlain
check "shadow mode: a non-decomposed leaf (synthetic=false) logs type=leaf" \
  "$(grep -c 'type=leaf\b' "$SHADOW_LOG" 2>/dev/null)" "1"

# Case 13: table mode is DELIBERATELY INERT in this card -- identical log-only behaviour as
# shadow, never a different routing outcome (there is no routing outcome at all from this
# function in either mode).
rm -f "$SHADOW_LOG" "$TMPDIR/shadow-mode.log"
CARD_ROUTE_MODE=shadow OFFLOAD_CARD_ROUTE_SHADOW_LOG="$TMPDIR/shadow-mode.log" \
  bash "$DISPATCH" --test-route-shadow leafA "readme fix" "small readme fix" "" mikrob false "card1~doc-update" card1
CARD_ROUTE_MODE=table OFFLOAD_CARD_ROUTE_SHADOW_LOG="$SHADOW_LOG" \
  bash "$DISPATCH" --test-route-shadow leafA "readme fix" "small readme fix" "" mikrob false "card1~doc-update" card1
check "table mode is inert this card: same log line content as shadow mode (mode field aside)" \
  "$(sed 's/mode=table/mode=shadow/' "$SHADOW_LOG" | cut -f2-)" "$(cut -f2- "$TMPDIR/shadow-mode.log")"

# Case 14: a missing/broken table script falls through safely (table-chain "-"), never errors the
# whole leaf loop -- the function's own failure mode is "log less information", not "crash".
rm -f "$SHADOW_LOG"
CARD_ROUTE_MODE=shadow OFFLOAD_CARD_ROUTE_TABLE="$TMPDIR/does-not-exist.sh" OFFLOAD_CARD_ROUTE_SHADOW_LOG="$SHADOW_LOG" \
  bash "$DISPATCH" --test-route-shadow leafA "readme fix" "small readme fix" "" mikrob false "card1~doc-update" card1
check "shadow mode with a missing table script: no log line is written at all (fail-safe, no crash)" \
  "$([[ -f "$SHADOW_LOG" ]] && echo exists || echo absent)" "absent"

# ---- M1 (card 555419a8, CYBERED MEDIUM 25494 on 5aa686f0): pin the WIRING, not just the guard
# functions' own content ---------------------------------------------------------------------
# RedHat's own finding: the L1 baseline above (via --test-freellm-fallback-site) proves the
# extracted guard FUNCTIONS behave correctly in isolation -- it does NOT prove the PRODUCTION call
# sites (the main leaf loop) actually invoke those functions rather than calling
# try_freellm_for_leaf directly (mutants W1/W2: the production call site is replaced wholesale).
# Two layers, matching what each is actually good at:
#   (a) a BEHAVIORAL run through the REAL entry point (bash "$DISPATCH" "$CARD", not the
#       --test-* hook) for the capacity-hold site -- this is the one of the two sites reachable
#       without a built local-llm-router.js (a stub dashboard + a "GPU busy" VRAM_GUARD stub
#       routes straight to the capacity-hold branch, no RAG/router call at all). The marker file
#       is the same tell as L1: a leak means the attempt reached freellm-call.sh.
#   (b) a STRUCTURAL pin, for BOTH sites, that the only two places in the whole script calling
#       try_freellm_for_leaf (word-boundary, outside its own "() {" definition and comments) are
#       inside the bodies of the two guard functions themselves -- a mutant that replaces either
#       production call site with a direct try_freellm_for_leaf call puts a THIRD call outside
#       both bodies, which this immediately flags. This is a call-SITE-location check, not the
#       presence/substring check 28818 already found too weak (that one looked for the guard
#       TEXT inside the function; this one looks at every CALL across the whole file).
M1_CAP_KANBAN="$TMPDIR/m1cap-kanban.json"
cat > "$M1_CAP_KANBAN" << 'EOF'
[{"id":"m1caphold","title":"[BE] egyszeru feladat","description":"irj egy fuggvenyt","status":"planned","assignee":"backend2","project":"mikrob","parent_id":null,"sort_order":1,"archived_at":null,"labels":[]}]
EOF
cat > "$TMPDIR/m1cap-stub.py" << 'PYEOF'
import http.server, sys, os
LOGDIR = sys.argv[1]; PORT = int(sys.argv[2]); KANBAN_FILE = sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/kanban'):
            body = open(KANBAN_FILE, 'rb').read()
            self.send_response(200); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0)); self.rfile.read(length)
        n = len([f for f in os.listdir(LOGDIR) if f.startswith('post-')])
        open(os.path.join(LOGDIR, f'post-{n}.json'), 'w').close()
        resp = b'{"ok":true}'
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp))); self.end_headers(); self.wfile.write(resp)
    def log_message(self, *a):
        pass
http.server.HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PYEOF
M1_CAP_LOGDIR="$TMPDIR/m1cap-postlog"; mkdir -p "$M1_CAP_LOGDIR"
M1_CAP_PORT="$(python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
python3 -I "$TMPDIR/m1cap-stub.py" "$M1_CAP_LOGDIR" "$M1_CAP_PORT" "$M1_CAP_KANBAN" &
M1_CAP_SRV_PID=$!
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$M1_CAP_PORT") 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 0.05
done

M1_CAP_INSTALLED="$TMPDIR/m1cap-installed-yes.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$M1_CAP_INSTALLED"; chmod +x "$M1_CAP_INSTALLED"
M1_CAP_VRAM_BUSY="$TMPDIR/m1cap-vram-busy.sh"
printf '#!/usr/bin/env bash\necho busy\nexit 1\n' > "$M1_CAP_VRAM_BUSY"; chmod +x "$M1_CAP_VRAM_BUSY"

rm -f "$MARKER"
timeout 20 env DASHBOARD_URL="http://127.0.0.1:$M1_CAP_PORT" OFFLOAD_INSTALLED="$M1_CAP_INSTALLED" \
  OFFLOAD_VRAM_GUARD="$M1_CAP_VRAM_BUSY" OFFLOAD_FREELLM_CALL="$FREELLM_STUB" FREELLM_ATTEMPT_MARKER="$MARKER" \
  ATTEMPTS_FILE="$TMPDIR/m1cap-attempts.json" ATTEMPTS_LOCK="$TMPDIR/m1cap-attempts.lock" \
  OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$TMPDIR/no-skip-file-does-not-exist" \
  bash "$DISPATCH" m1caphold >/dev/null 2>&1
check "M1 (a): real entry point (bash DISPATCH <card>, not --test-* hook), capacity-hold branch: blocked shape never reaches freellm-call.sh" \
  "$([[ -f "$MARKER" ]] && echo leaked || echo clean)" "clean"

kill "$M1_CAP_SRV_PID" 2>/dev/null
wait "$M1_CAP_SRV_PID" 2>/dev/null

m1_wiring_check="$(python3 - "$DISPATCH" << 'PYEOF'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
stripped = re.sub(r"(?m)^\s*#.*$", "", src)
lines = stripped.splitlines()

def body_range(fn_name):
    start = next(i for i, l in enumerate(lines) if re.match(rf"^{fn_name}\(\)\s*\{{", l))
    end = next(i for i in range(start + 1, len(lines)) if lines[i].rstrip() == "}")
    return start, end

exhausted_range = body_range("freellm_fallback_exhausted_site")
caphold_range = body_range("freellm_fallback_capacity_hold_site")

#   card f054fa3f (item 4): the old regex required a quote right after the name, so a mutant
#   that swaps a production call site for an UNQUOTED direct call (try_freellm_for_leaf $lid ...,
#   no leading quote) slipped past this pin entirely -- it never matched call_re, so it never
#   became a "third call outside both bodies" offender. Match the bare name instead; the
#   definition line is still excluded explicitly below (it has no space before its own "()").
call_re = re.compile(r"\btry_freellm_for_leaf\b(?!\(\))")
offenders = []
for i, l in enumerate(lines):
    if not call_re.search(l):
        continue
    if re.match(r"^try_freellm_for_leaf\(\)\s*\{", l):
        continue  # the definition line itself
    if exhausted_range[0] <= i <= exhausted_range[1] or caphold_range[0] <= i <= caphold_range[1]:
        continue
    offenders.append(i + 1)

print("OK" if not offenders else f"CALL-OUTSIDE-GUARD-AT-LINE:{offenders}")
PYEOF
)"
check "M1 (b): every call to try_freellm_for_leaf in the whole file sits inside one of the two guard-function bodies" \
  "$m1_wiring_check" "OK"

# ---- card f054fa3f (item 4): mutation-prove the widened call_re actually catches an UNQUOTED
# direct call, which the old regex (required a quote right after the name) missed entirely. Runs
# the SAME wiring-check logic against a MUTATED COPY of the real file (never the file itself),
# where the exhausted-site guard call is replaced by a bare, unquoted direct call. ------------------
M1_MUTANT_DISPATCH="$TMPDIR/offload-dispatch-mutant.sh"
python3 - "$DISPATCH" "$M1_MUTANT_DISPATCH" << 'PYEOF'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
old = '    { try_freellm_for_leaf "$leaf_id" "$leaf_title" "$task" "$post_id" "$synthetic" "$assignee" && return 0; }'
new = '  }\n}\ntry_freellm_for_leaf_direct_bypass() {\n    { try_freellm_for_leaf $leaf_id $leaf_title $task $post_id $synthetic $assignee && return 0; }'
assert old in src, "fixture line not found -- production call site text changed, update the mutant"
open(sys.argv[2], "w", encoding="utf-8").write(src.replace(old, new, 1))
PYEOF
m1_mutant_check="$(python3 - "$M1_MUTANT_DISPATCH" << 'PYEOF'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
stripped = re.sub(r"(?m)^\s*#.*$", "", src)
lines = stripped.splitlines()

def body_range(fn_name):
    start = next(i for i, l in enumerate(lines) if re.match(rf"^{fn_name}\(\)\s*\{{", l))
    end = next(i for i in range(start + 1, len(lines)) if lines[i].rstrip() == "}")
    return start, end

exhausted_range = body_range("freellm_fallback_exhausted_site")
caphold_range = body_range("freellm_fallback_capacity_hold_site")

call_re = re.compile(r"\btry_freellm_for_leaf\b(?!\(\))")
offenders = []
for i, l in enumerate(lines):
    if not call_re.search(l):
        continue
    if re.match(r"^try_freellm_for_leaf\(\)\s*\{", l):
        continue
    if exhausted_range[0] <= i <= exhausted_range[1] or caphold_range[0] <= i <= caphold_range[1]:
        continue
    offenders.append(i + 1)

print("OK" if not offenders else "CALL-OUTSIDE-GUARD-DETECTED")
PYEOF
)"
check "M1 (b) mutant proof: an unquoted direct call outside both guard bodies turns the pin red" \
  "$m1_mutant_check" "CALL-OUTSIDE-GUARD-DETECTED"

# ============================================================================================
# Card 555419a8 (Cybersec M1 on af8ddbf0): freellm-call.sh's own named stderr (model 404, token
# mismatch, or any other failure message) used to be thrown away by try_freellm_for_leaf's
# `2>/dev/null` -- surfaced now in BOTH offload-dispatch's own log line and a card-visible
# failure comment. A minimal stub dashboard (POST-capturing only) stands in for the real board.
# ============================================================================================
M1_STUB_LOGDIR="$TMPDIR/m1-dash-reqs"
mkdir -p "$M1_STUB_LOGDIR"
cat > "$TMPDIR/m1-dash-stub.py" << 'PYEOF'
import http.server, json, sys, os

LOGDIR = sys.argv[1]
PORT = int(sys.argv[2])

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        n = len([f for f in os.listdir(LOGDIR) if f.startswith('post-')])
        with open(os.path.join(LOGDIR, f'post-{n}.json'), 'w') as f:
            f.write(body.decode('utf-8', 'replace'))
        resp = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
    def log_message(self, *a):
        pass

srv = http.server.HTTPServer(('127.0.0.1', PORT), H)
srv.serve_forever()
PYEOF
M1_PORT="$(python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
python3 -I "$TMPDIR/m1-dash-stub.py" "$M1_STUB_LOGDIR" "$M1_PORT" &
M1_STUB_PID=$!
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$M1_PORT") 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 0.05
done

M1_FREELLM_STUB="$TMPDIR/m1-freellm-stub.sh"
cat > "$M1_FREELLM_STUB" << 'EOF'
#!/usr/bin/env bash
echo "FREELLM: model 'bogus-model-xyz' was rejected by the provider (HTTP 404) -- check it against http://127.0.0.1:3001/v1/models." >&2
exit 1
EOF
chmod +x "$M1_FREELLM_STUB"

M1_OUT="$TMPDIR/m1-out.txt"
OFFLOAD_FREELLM_CALL="$M1_FREELLM_STUB" DASHBOARD_URL="http://127.0.0.1:$M1_PORT" \
  bash "$DISPATCH" --test-freellm-fallback-site exhausted mikrob gemini-ok "M1 teszt cim" "M1 teszt leiras" m1leaf "task text" m1leaf false \
  >/dev/null 2>"$M1_OUT"

check "M1: offload-dispatch's own log line surfaces freellm-call.sh's named stderr (model id)" \
  "$(grep -c "bogus-model-xyz" "$M1_OUT")" "1"
check "M1: the log line also names the HTTP code" \
  "$(grep -c "404" "$M1_OUT")" "1"

M1_POST_FILE="$M1_STUB_LOGDIR/post-0.json"
check "M1: a card-visible failure comment was posted (exactly one POST reached the stub dashboard)" \
  "$(ls "$M1_STUB_LOGDIR"/post-*.json 2>/dev/null | wc -l | tr -d ' ')" "1"
if [[ -f "$M1_POST_FILE" ]]; then
  M1_COMMENT_CONTENT="$(python3 -c "import json; print(json.load(open('$M1_POST_FILE')).get('content',''))" 2>/dev/null || echo "")"
  check "M1: the posted comment names the model id (not a generic 'failed' message)" \
    "$([[ "$M1_COMMENT_CONTENT" == *"bogus-model-xyz"* ]] && echo yes || echo no)" "yes"
  check "M1: the posted comment carries the LOCAL-LLM DRAFT freellm tag (same convention as a success draft)" \
    "$([[ "$M1_COMMENT_CONTENT" == *"LOCAL-LLM DRAFT | freellm"* ]] && echo yes || echo no)" "yes"
fi

# ---- card f054fa3f (item 1): rc=2 ("disabled") used to discard $err_redacted entirely -- pin
# that a NAMED rc=2 stderr message (e.g. the token-file mode/owner refusal, card 555419a8 L3)
# now reaches the dispatch log. ----------------------------------------------------------------
M1_RC2_STUB="$TMPDIR/m1-rc2-freellm-stub.sh"
cat > "$M1_RC2_STUB" << 'EOF'
#!/usr/bin/env bash
echo "FREELLM: /home/neon/.config/freellmapi/auth-token is not 0600 and owned by the current user -- refusing to use it until permissions/ownership are fixed." >&2
exit 2
EOF
chmod +x "$M1_RC2_STUB"
M1_RC2_OUT="$TMPDIR/m1-rc2-out.txt"
OFFLOAD_FREELLM_CALL="$M1_RC2_STUB" DASHBOARD_URL="http://127.0.0.1:$M1_PORT" \
  bash "$DISPATCH" --test-freellm-fallback-site exhausted mikrob gemini-ok "M1 rc2 cim" "M1 rc2 leiras" m1rc2leaf "task text" m1rc2leaf false \
  >/dev/null 2>"$M1_RC2_OUT"
check "item 1: rc=2 (disabled) with named stderr now shows that text in the dispatch log" \
  "$(grep -c "not 0600 and owned" "$M1_RC2_OUT")" "1"

# ---- card f054fa3f (item 3): widen the redaction beyond the 32+-char catch-all. Each case stubs
# freellm-call.sh with a generic (non-2, non-4) failure so $err_redacted reaches BOTH the log and
# the card comment, carrying one of the four shapes the old regex pair missed. ------------------
m1_redact_case() {
  local desc="$1" raw_secret="$2" stderr_line="$3" leaf_id="$4"
  local stub="$TMPDIR/m1-redact-$leaf_id.sh" out="$TMPDIR/m1-redact-$leaf_id-out.txt"
  printf '#!/usr/bin/env bash\necho %q >&2\nexit 1\n' "$stderr_line" > "$stub"
  chmod +x "$stub"
  rm -f "$M1_STUB_LOGDIR"/post-*.json
  OFFLOAD_FREELLM_CALL="$stub" DASHBOARD_URL="http://127.0.0.1:$M1_PORT" \
    bash "$DISPATCH" --test-freellm-fallback-site exhausted mikrob gemini-ok "M1 redact cim" "M1 redact leiras" "$leaf_id" "task text" "$leaf_id" false \
    >/dev/null 2>"$out"
  check "item 3 ($desc): the log line does NOT contain the raw secret" \
    "$(grep -c "$raw_secret" "$out")" "0"
  check "item 3 ($desc): the log line DOES contain [REDACTED]" \
    "$(grep -c '\[REDACTED\]' "$out")" "1"
  local post_file; post_file="$(ls "$M1_STUB_LOGDIR"/post-*.json 2>/dev/null | head -1)"
  if [[ -n "$post_file" ]]; then
    local comment; comment="$(python3 -c "import json; print(json.load(open('$post_file')).get('content',''))" 2>/dev/null || echo "")"
    check "item 3 ($desc): the card comment does NOT contain the raw secret" \
      "$([[ "$comment" == *"$raw_secret"* ]] && echo leaked || echo clean)" "clean"
  fi
}

m1_redact_case "dotted (JWT-like)" \
  "dGhpc2lzYXNpZ25hdHVyZXZhbHVl" \
  "FREELLM: unexpected response: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZXZhbHVl" \
  "m1redactdotted"

# The documented AWS example access key id (AKIAIOSFODNN7 + EXAMPLE, same value
# store/secret-shape-scan.py's own EXAMPLE_VALUES allowlists) -- a real secret-shaped string
# would trip the repo's own secret-write-guard hook on this file, so this is the one shape-exact
# value safe to write literally.
m1_redact_case "short (AWS access key id, 20 chars, under the 32+ catch-all)" \
  "AKIAIOSFODNN7EXAMPLE" \
  "FREELLM: curl diagnostic mentioned AKIAIOSFODNN7EXAMPLE in the response" \
  "m1redactshort"

m1_redact_case "key=value (labeled, short value)" \
  "abc123xyz" \
  "FREELLM: provider rejected request, token=abc123xyz was not recognized" \
  "m1redactkv"

m1_redact_case "userinfo (URL user:pass@host)" \
  "supersecretpass" \
  "curl: (22) The requested URL returned error: 401 for http://produser:supersecretpass@127.0.0.1:9999/foo" \
  "m1redactuserinfo"

kill "$M1_STUB_PID" 2>/dev/null
wait "$M1_STUB_PID" 2>/dev/null

# ---- card 6d8ef952: freellm-FIRST route (helyi -> freellm -> online REVERSED to freellm -> helyi
# -> online, Peti Telegram 13820/13823) -------------------------------------------------------
# All cases drive the REAL try_freellm_first_for_leaf via --test-freellm-first-site, and the real
# cooldown helpers via --test-freellm-cooldown -- no reimplementation, same pattern as the L1
# fallback-site tests above. A stub FREELLM_CALL (env OFFLOAD_FREELLM_CALL) stands in for the real
# freellm-call.sh so these never touch the network; its own content/switch/token logic is covered
# by freellm-call.sh's own selftest, not duplicated here.
FF_SKIP="$TMPDIR/ff-skip-gemini-ok.json"
echo '{"enabled": true}' > "$FF_SKIP"
FF_COOLDOWN="$TMPDIR/ff-cooldown-until"
FF_STUB="$TMPDIR/ff-stub.sh"
FF_MARKER="$TMPDIR/ff-attempt-marker"

make_ff_stub() { # $1 = exit code to return (0 drafts "ff-draft-output")
  cat > "$FF_STUB" <<EOF
#!/usr/bin/env bash
touch "$FF_MARKER"
cat >/dev/null
if [[ "\$1" == "" && "${1}" == "0" ]]; then :; fi
case "${1}" in
  0) echo "ff-draft-output"; exit 0 ;;
  *) exit ${1} ;;
esac
EOF
  chmod +x "$FF_STUB"
}

run_ff_first() { # $1=leafId $2=title $3=desc $4=project $5=tags -> sets $rc, $out
  out="$(OFFLOAD_FREELLM_CALL="$FF_STUB" OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$FF_SKIP" \
    OFFLOAD_FREELLM_COOLDOWN_FILE="$FF_COOLDOWN" DASHBOARD_URL="http://127.0.0.1:1" \
    bash "$DISPATCH" --test-freellm-first-site "$1" "$2" "$3" "$4" "$5" "task text" "$1" false 2>/dev/null)"
  rc=$?
}

# Case 1: success -> "drafted", exit 0, attempt reaches the stub.
rm -f "$FF_MARKER" "$FF_COOLDOWN"
make_ff_stub 0
run_ff_first leafF1 "title" "desc" mikrob ""
check "freellm-first success: prints drafted" "$out" "drafted"
check "freellm-first success: exit 0" "$rc" "0"
check "freellm-first success: stub was actually invoked" "$([[ -f "$FF_MARKER" ]] && echo yes || echo no)" "yes"

# Case 2: rc=3 (quota/429) -> fallthrough, exit 1, and a cooldown file is written.
rm -f "$FF_MARKER" "$FF_COOLDOWN"
make_ff_stub 3
run_ff_first leafF2 "title" "desc" mikrob ""
check "freellm-first rc=3 (quota): prints fallthrough" "$out" "fallthrough"
check "freellm-first rc=3 (quota): exit 1" "$rc" "1"
check "freellm-first rc=3 (quota): cooldown file written" "$([[ -f "$FF_COOLDOWN" ]] && echo yes || echo no)" "yes"

# Case 3: cooldown active -> the leaf never reaches the stub at all (marker absent), fallthrough.
rm -f "$FF_MARKER"
make_ff_stub 0
run_ff_first leafF3 "title" "desc" mikrob ""
check "freellm-first under active cooldown: prints fallthrough" "$out" "fallthrough"
check "freellm-first under active cooldown: stub NEVER invoked" "$([[ -f "$FF_MARKER" ]] && echo leaked || echo clean)" "clean"

# Case 4: rc=4 (content gate inside freellm-call.sh itself) -> fallthrough, exit 1, NO cooldown
# written (a content-gate refusal is not a quota event -- it must not block the NEXT leaf's
# freellm-first attempt).
rm -f "$FF_MARKER" "$FF_COOLDOWN"
make_ff_stub 4
run_ff_first leafF4 "title" "desc" mikrob ""
check "freellm-first rc=4 (content gate): prints fallthrough" "$out" "fallthrough"
check "freellm-first rc=4 (content gate): exit 1" "$rc" "1"
check "freellm-first rc=4 (content gate): no cooldown written" "$([[ -f "$FF_COOLDOWN" ]] && echo yes || echo no)" "no"

# Case 5: rc=2 (disabled / switch off) -> fallthrough, exit 1, no cooldown.
rm -f "$FF_MARKER" "$FF_COOLDOWN"
make_ff_stub 2
run_ff_first leafF5 "title" "desc" mikrob ""
check "freellm-first rc=2 (disabled): prints fallthrough" "$out" "fallthrough"
check "freellm-first rc=2 (disabled): no cooldown written" "$([[ -f "$FF_COOLDOWN" ]] && echo yes || echo no)" "no"

# Case 6 (card 6d8ef952 scope change, Peti 13829/13838 "igen, vedd le"): the project allowlist is
# WIDENED to mikrob+mopsion for freellm -- a mopsion leaf now DOES reach the stub and drafts.
rm -f "$FF_MARKER" "$FF_COOLDOWN"
make_ff_stub 0
run_ff_first leafF6 "title" "desc" mopsion ""
check "freellm-first project allowlist: mopsion leaf now reaches the stub (widened, 6d8ef952)" \
  "$([[ -f "$FF_MARKER" ]] && echo reached || echo missing)" "reached"
check "freellm-first project allowlist: mopsion leaf drafts" "$out" "drafted"

# Case 6b: an UNRELATED project (not mikrob, not mopsion) is still blocked -- the widening is
# exactly two names, not a removal of the allowlist itself.
rm -f "$FF_MARKER" "$FF_COOLDOWN"
make_ff_stub 0
run_ff_first leafF6b "title" "desc" cleancore ""
check "freellm-first project allowlist: unrelated project still blocked" \
  "$([[ -f "$FF_MARKER" ]] && echo leaked || echo clean)" "clean"
check "freellm-first project allowlist: unrelated project falls through" "$out" "fallthrough"

# Case 7 (card 6d8ef952 scope change): the category/PII content gate no longer REFUSES a freellm
# card -- a sensitive-worded mikrob leaf now reaches the stub and drafts (masking of actual
# credential VALUES, tested separately below, is the real protection now, not a refusal).
rm -f "$FF_MARKER" "$FF_COOLDOWN"
make_ff_stub 0
run_ff_first leafF7 "authz check" "irj meg egy authz ellenorzest" mikrob ""
check "freellm-first content gate (prefilter): sensitive leaf now reaches the stub (6d8ef952)" \
  "$([[ -f "$FF_MARKER" ]] && echo reached || echo missing)" "reached"
check "freellm-first content gate (prefilter): sensitive leaf drafts" "$out" "drafted"

# Case 7b: an explicit BLOKKOLT-* tag is a human override, not a category inference -- it still
# blocks even after the content-gate loosening above.
rm -f "$FF_MARKER" "$FF_COOLDOWN"
make_ff_stub 0
run_ff_first leafF7b "title" "desc" mikrob "BLOKKOLT-Peti-stop"
check "freellm-first content gate: BLOKKOLT-* tag still blocks (human override, not category)" \
  "$([[ -f "$FF_MARKER" ]] && echo leaked || echo clean)" "clean"
check "freellm-first content gate: BLOKKOLT-* tag falls through" "$out" "fallthrough"

# --- redact_secrets: a card with an embedded credential drafts (not refused), and the body the
# stub actually RECEIVES never contains the raw secret -- the "Kesz, ha" pin from comment 31309
# (MikroB decision on Peti 13838): "the outgoing request body contains [REDACTED:...] instead of
# the token". FF_STUB_CAPTURE writes stdin to a file instead of discarding it, so the test can
# inspect exactly what left the machine.
FF_CAPTURED="$TMPDIR/ff-captured-body"
make_ff_stub_capture() { # $1 = exit code to return
  cat > "$FF_STUB" <<EOF
#!/usr/bin/env bash
touch "$FF_MARKER"
cat > "$FF_CAPTURED"
case "${1}" in
  0) echo "ff-draft-output"; exit 0 ;;
  *) exit ${1} ;;
esac
EOF
  chmod +x "$FF_STUB"
}
rm -f "$FF_MARKER" "$FF_COOLDOWN" "$FF_CAPTURED"
make_ff_stub_capture 0
out="$(OFFLOAD_FREELLM_CALL="$FF_STUB" OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$FF_SKIP" \
  OFFLOAD_FREELLM_COOLDOWN_FILE="$FF_COOLDOWN" DASHBOARD_URL="http://127.0.0.1:1" \
  bash "$DISPATCH" --test-freellm-first-site leafF8 "credential leak" "live key, do not leak" mikrob "" \
  "token: ghp_ABCDEFGHIJ1234567890abcdefghij" leafF8 false 2>/dev/null)"
check "redact_secrets: sensitive leaf still drafts (not refused)" "$out" "drafted"
check "redact_secrets: outgoing body does NOT contain the raw token" \
  "$(grep -c "ghp_ABCDEFGHIJ1234567890abcdefghij" "$FF_CAPTURED" 2>/dev/null)" "0"
check "redact_secrets: outgoing body contains the redaction marker instead" \
  "$(grep -c "REDACTED:github-token" "$FF_CAPTURED" 2>/dev/null)" "1"

# Case 9 (Peti 13838 "Igen, vedd le" -- PII is explicitly NOT masked, only credentials are): a
# card with a personal email address drafts, and the email passes through the outgoing body
# UNMASKED -- distinguishing the new credential-masking behaviour from a blanket PII scrub.
rm -f "$FF_MARKER" "$FF_COOLDOWN" "$FF_CAPTURED"
make_ff_stub_capture 0
out="$(OFFLOAD_FREELLM_CALL="$FF_STUB" OFFLOAD_FREELLM_SKIP_GEMINI_OK_CHECK="$FF_SKIP" \
  OFFLOAD_FREELLM_COOLDOWN_FILE="$FF_COOLDOWN" DASHBOARD_URL="http://127.0.0.1:1" \
  bash "$DISPATCH" --test-freellm-first-site leafF9 "contact update" "hivd vissza" mikrob "" \
  "ugyfel email: ugyfel@example.com" leafF9 false 2>/dev/null)"
check "redact_secrets: PII (email) is NOT masked, passes through unredacted" \
  "$(grep -c "ugyfel@example.com" "$FF_CAPTURED" 2>/dev/null)" "1"

# --- freellm_in_cooldown / freellm_start_cooldown direct pins (via --test-freellm-cooldown) ------
FF_COOLDOWN2="$TMPDIR/ff-cooldown2"
rm -f "$FF_COOLDOWN2"
check "cooldown helper: no file yet -> clear" \
  "$(OFFLOAD_FREELLM_COOLDOWN_FILE="$FF_COOLDOWN2" bash "$DISPATCH" --test-freellm-cooldown check)" "clear"
check "cooldown helper: start -> cooling" \
  "$(OFFLOAD_FREELLM_COOLDOWN_FILE="$FF_COOLDOWN2" OFFLOAD_FREELLM_COOLDOWN_SECONDS=300 bash "$DISPATCH" --test-freellm-cooldown start)" "cooling"
check "cooldown helper: already-expired timestamp -> clear" \
  "$(echo 1 > "$FF_COOLDOWN2"; OFFLOAD_FREELLM_COOLDOWN_FILE="$FF_COOLDOWN2" bash "$DISPATCH" --test-freellm-cooldown check)" "clear"
check "cooldown helper: malformed content -> clear (fail-open on the cooldown itself, not a gate)" \
  "$(echo "not-a-number" > "$FF_COOLDOWN2"; OFFLOAD_FREELLM_COOLDOWN_FILE="$FF_COOLDOWN2" bash "$DISPATCH" --test-freellm-cooldown check)" "clear"

# --- STRUCTURAL pin: try_leaf calls try_freellm_first_for_leaf BEFORE the GEMINI_ROUTE/local-RAG
# branch (word-boundary source pin, same technique as the other "X calls Y" pins in this file --
# card 6d8ef952's Kesz-ha is "every draft goes to freellm first", so the ORDER matters, not just
# the function's existence). ----------------------------------------------------------------------
# CODE-ONLY lines (comment lines stripped) -- a prose comment mentioning the function name by
# name (which this file's own header comments do, deliberately, for readability) must never count
# as the call the mutation proof needs to catch removal of.
TRY_LEAF_BODY="$(awk '/^try_leaf\(\) \{/{found=1; next} found && /^\}$/{exit} found{print}' "$DISPATCH" | grep -v '^\s*#')"
ff_line="$(printf '%s\n' "$TRY_LEAF_BODY" | grep -n 'try_freellm_first_for_leaf' | head -1 | cut -d: -f1)"
rag_line="$(printf '%s\n' "$TRY_LEAF_BODY" | grep -n '"\$RAG" --auto' | head -1 | cut -d: -f1)"
check "try_leaf's body contains a try_freellm_first_for_leaf call" "$([[ -n "$ff_line" ]] && echo yes || echo no)" "yes"
check "try_leaf's body contains the local RAG (\$RAG) call" "$([[ -n "$rag_line" ]] && echo yes || echo no)" "yes"
check "try_leaf calls try_freellm_first_for_leaf BEFORE the local RAG (\$RAG) call" \
  "$([[ -n "$ff_line" && -n "$rag_line" && "$ff_line" -lt "$rag_line" ]] && echo yes || echo no)" "yes"

# STRUCTURAL pin: try_leaf's body must NOT contain a synthetic+veto_online early-return before
# try_freellm_first_for_leaf (card 6d8ef952, Peti "no limitation" -- the veto no longer skips the
# attempt). A removed-then-reintroduced skip here would be invisible to any --test-capacity-route
# or --test-freellm-fallback-site case above, since those exercise different code paths
# (the capacity-hold sweep branch, not try_leaf's own synthetic-fragment branch).
veto_skip_line="$(printf '%s\n' "$TRY_LEAF_BODY" | grep -n 'synthetic.*==.*true.*veto_online.*==.*true' | head -1 | cut -d: -f1)"
check "try_leaf's body contains NO synthetic+veto_online early-return (the skip was removed, not just moved)" \
  "$([[ -z "$veto_skip_line" ]] && echo yes || echo no)" "yes"
check "if present, any such check would come before try_freellm_first_for_leaf (would short-circuit it) -- confirms removal, not reordering" \
  "$([[ -z "$veto_skip_line" || ( -n "$ff_line" && "$veto_skip_line" -lt "$ff_line" ) ]] && echo yes || echo no)" "yes"

# --- STRUCTURAL pin: try_leaf calls try_gemini_coding_chain_for_leaf AFTER freellm-first falls
# through but BEFORE local RAG (card 9963bf35, "FreeLLM -> Gemini -> local -> online"). ------------
gc_line="$(printf '%s\n' "$TRY_LEAF_BODY" | grep -n 'try_gemini_coding_chain_for_leaf' | head -1 | cut -d: -f1)"
check "try_leaf's body contains a try_gemini_coding_chain_for_leaf call" "$([[ -n "$gc_line" ]] && echo yes || echo no)" "yes"
check "try_leaf calls try_gemini_coding_chain_for_leaf AFTER try_freellm_first_for_leaf" \
  "$([[ -n "$ff_line" && -n "$gc_line" && "$ff_line" -lt "$gc_line" ]] && echo yes || echo no)" "yes"
check "try_leaf calls try_gemini_coding_chain_for_leaf BEFORE the local RAG (\$RAG) call" \
  "$([[ -n "$gc_line" && -n "$rag_line" && "$gc_line" -lt "$rag_line" ]] && echo yes || echo no)" "yes"

# ============================================================================================
# Card 9963bf35 (Peti Telegram 14354): Gemini in the coding chain, next to FreeLLM, unconditional
# on newDevStop. All cases drive the REAL try_gemini_coding_chain_for_leaf via
# --test-gemini-coding-chain-site -- no reimplementation, same pattern as --test-freellm-first-site.
# GEMINI_AGY_CALL/GEMINI_OFFLOAD are newly overridable (OFFLOAD_GEMINI_AGY_CALL/
# OFFLOAD_GEMINI_OFFLOAD) specifically so this can stub either backend without touching the real
# CLI/network path -- neither was overridable before this card, so try_gemini_for_leaf itself had
# NO selftest coverage at all before now (only structural/grep pins on its callers).
# ============================================================================================
GC_FLAG="$TMPDIR/gemini-coding-chain-enabled"
GC_AGY_STUB="$TMPDIR/gc-agy-stub.sh"
GC_MARKER="$TMPDIR/gc-attempt-marker"
GC_LEDGER_DB="$TMPDIR/gc-ledger.db"
rm -f "$GC_LEDGER_DB"
python3 -c "
import sqlite3
con = sqlite3.connect('$GC_LEDGER_DB')
con.execute('''CREATE TABLE llm_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent_id TEXT NOT NULL,
  card_id TEXT, task_type TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN (\"local\",\"gemini\",\"freellm\")), model TEXT,
  ok INTEGER NOT NULL, fail_reason TEXT, latency_ms INTEGER, prompt_chars INTEGER,
  response_chars INTEGER, draft_accepted INTEGER, claude_token_equiv INTEGER)''')
con.commit()
"

make_gc_agy_stub() { # $1 = exit code to return (0 drafts "gc-draft-output")
  cat > "$GC_AGY_STUB" <<EOF
#!/usr/bin/env bash
touch "$GC_MARKER"
case "${1}" in
  0) echo "gc-draft-output"; exit 0 ;;
  *) exit ${1} ;;
esac
EOF
  chmod +x "$GC_AGY_STUB"
}

run_gc_site() { # $1=leafId $2=title $3=desc $4=project $5=tags $6=assignee(optional) -> sets $rc, $out
  out="$(OFFLOAD_GEMINI_AGY_CALL="$GC_AGY_STUB" DASHBOARD_URL="http://127.0.0.1:1" \
    LLM_LEDGER_DB="$GC_LEDGER_DB" \
    bash "$DISPATCH" --test-gemini-coding-chain-site "$1" "$2" "$3" "$4" "$5" "task text" "$1" false "${6:-}" 2>/dev/null)"
  rc=$?
}

# Case 1: flag OFF (default) -> never reaches the stub, falls through, no bookkeeping.
rm -f "$GC_FLAG" "$GC_MARKER"
make_gc_agy_stub 0
unset GEMINI_CODING_CHAIN_FLAG
run_gc_site leafG1 "title" "desc" mikrob "gemini-ok"
check "gemini coding-chain, flag OFF: prints fallthrough" "$out" "fallthrough"
check "gemini coding-chain, flag OFF: stub NEVER invoked" "$([[ -f "$GC_MARKER" ]] && echo leaked || echo clean)" "clean"

# Case 2: flag ON + allowed project/marker -> drafted, stub invoked.
rm -f "$GC_MARKER"
export GEMINI_CODING_CHAIN_FLAG="$GC_FLAG"
echo on > "$GC_FLAG"
run_gc_site leafG2 "title" "desc" mikrob "gemini-ok" backend2
check "gemini coding-chain, flag ON + allowed: prints drafted" "$out" "drafted"
check "gemini coding-chain, flag ON + allowed: stub was invoked" "$([[ -f "$GC_MARKER" ]] && echo yes || echo no)" "yes"

# Case 3 (Kesz-ha: "a card with secret-shaped text or a forbidden category never reaches Gemini"):
# no gemini-ok marker tag -> is_gemini_blocked's positive-marker requirement blocks it, same gate
# every other Gemini call site in this file uses.
rm -f "$GC_MARKER"
run_gc_site leafG3 "title" "desc" mikrob ""
check "gemini coding-chain, missing gemini-ok marker: prints fallthrough" "$out" "fallthrough"
check "gemini coding-chain, missing gemini-ok marker: stub NEVER invoked" "$([[ -f "$GC_MARKER" ]] && echo leaked || echo clean)" "clean"

# Case 4 (Kesz-ha: "the 6th card in an hour skips Gemini and goes local"): gemini-agy-call.sh's
# OWN hourly cap (already selftested there: 5 calls -> 6th exits 5, see gemini-agy-call.selftest.sh
# "hourly: 5 recent agy calls -> 6th blocked, exit 5") is what actually enforces the count: this
# pins that THIS call site correctly treats that refusal as fallthrough, not a crash/hang/retry.
rm -f "$GC_MARKER"
make_gc_agy_stub 5
run_gc_site leafG4 "title" "desc" mikrob "gemini-ok"
check "gemini coding-chain, quota-exhausted (simulated rc=5, matches gemini-agy-call.sh's own hourly refusal): prints fallthrough" "$out" "fallthrough"
check "gemini coding-chain, quota-exhausted: stub WAS invoked (reached the call, quota itself said no)" "$([[ -f "$GC_MARKER" ]] && echo yes || echo no)" "yes"
make_gc_agy_stub 0

# Case 5 (card 9963bf35 attribution, same bug class as 685f25cb/9fb61222): a successful
# coding-chain draft must write an llm_ledger row attributed to the real assignee, provider=gemini.
python3 -c "
import sqlite3
con = sqlite3.connect('$GC_LEDGER_DB')
row = con.execute(\"SELECT agent_id, card_id, provider FROM llm_ledger WHERE provider='gemini' AND card_id='leafG2'\").fetchone()
print(row[0] if row else 'NO_ROW', row[2] if row else '', row[1] if row else '')
" > "$TMPDIR/gc-ledger-check.txt" 2>/dev/null || echo "QUERY_FAILED" > "$TMPDIR/gc-ledger-check.txt"
check "gemini coding-chain draft writes an llm_ledger row (agent=backend2, provider=gemini)" \
  "$(cat "$TMPDIR/gc-ledger-check.txt")" "backend2 gemini leafG2"

unset GEMINI_CODING_CHAIN_FLAG
rm -f "$GC_FLAG"

# ============================================================================================
# Card 81eb57b5 (6d8ef952 follow-up, Cybersec GO 31533 M1+M2).
# ============================================================================================

# ---- M1: redact_secrets covers all 26 secret shapes from 31533 (9 already masked at a1c72ca4 +
# 17 the GO measured as unmasked) -- red on a1c72ca4, the Gate-SHA the GO was measured against.
# Every vendor-key-shaped fixture below is built from CONCATENATED parts, never one literal
# string in the source, so the secret-write-guard pre-commit hook does not mistake a synthetic
# test value for a real vendor credential.
redact_check() { # $1 = label, $2 = input text, $3 = raw secret value expected GONE from the output
  local label="$1" input="$2" secret="$3" out
  out="$(printf '%s' "$input" | bash "$DISPATCH" --test-redact-secrets)"
  check "redact_secrets 26-shape (31533): $label -- raw secret removed" \
    "$(printf '%s' "$out" | grep -c -- "$secret")" "0"
  check "redact_secrets 26-shape (31533): $label -- a [REDACTED:...] marker is present" \
    "$(printf '%s' "$out" | grep -c '\[REDACTED:')" "1"
}

aws_key_id="AKIA"; aws_key_id="${aws_key_id}IOSFODNN7EXAMPLE"
gh_classic="ghp_"; gh_classic="${gh_classic}ABCDEFGHIJ1234567890abcdefghij"
gl_tok="glpat-"; gl_tok="${gl_tok}ABCDEFGHIJKLMNOPQRST"
slack_tok="xoxb-"; slack_tok="${slack_tok}1234567890-ABCDEFGHIJKLMN"
google_key="AIza"; google_key="${google_key}SyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"
npm_tok="npm_"; npm_tok="${npm_tok}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
openai_flat="sk-"; openai_flat="${openai_flat}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
bearer_val="abcdefghijklmnop1234567890"

# Already masked at a1c72ca4 (9 shapes) -- regression guard, must stay masked after the M1 fix.
redact_check "jwt" "jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" "dBjftJeZ4CVP"
redact_check "aws access-key-id" "aws: $aws_key_id" "$aws_key_id"
redact_check "github classic token" "gh: $gh_classic" "$gh_classic"
redact_check "gitlab token" "gl: $gl_tok" "$gl_tok"
redact_check "slack legacy token" "slack: $slack_tok" "$slack_tok"
redact_check "google api key" "google: $google_key" "$google_key"
redact_check "npm token" "npm: $npm_tok" "$npm_tok"
redact_check "openai flat key" "openai: $openai_flat" "$openai_flat"
redact_check "bearer token" "Authorization: Bearer $bearer_val" "$bearer_val"

# 17 shapes CYBERSEC GO 31533 measured as UNMASKED at a1c72ca4 -- the fix this card adds.
ant_api03="sk-ant-api03-"; ant_api03="${ant_api03}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
ant_oat01="sk-ant-oat01-"; ant_oat01="${ant_oat01}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
openai_proj="sk-proj-"; openai_proj="${openai_proj}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
stripe_live="sk_live_"; stripe_live="${stripe_live}51HxxxxxxxxxxxxxxxxxxxxxxxxxxABC"
groq_key="gsk_"; groq_key="${groq_key}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
openrouter_key="sk-or-v1-"; openrouter_key="${openrouter_key}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
gh_pat="github_pat_"; gh_pat="${gh_pat}11AABBCCDD0123456789abcdefghij"
ya29_tok="ya29."; ya29_tok="${ya29_tok}a0ARrdaMxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
hex64="0f9e0d688e5d74dc5b6b06cbdf096996"; hex64="${hex64}a96b0157b0647e8e661b8146c06aef8d"
aws_secret="wJalrXUtnFEMI/K7MDENG"; aws_secret="${aws_secret}/bPxRfiCYEXAMPLEKEY"
tg_bot_tok="123456789:weBChlYJLWAiWdjewNyZp0VCjKrTX2IkZEJ"
slack_webhook="https://hooks.slack.com/services/T000/B000/"; slack_webhook="${slack_webhook}XXXXXXXXXXXXXXXXXXXXXXXX"

redact_check "anthropic sk-ant-api03" "key: $ant_api03" "$ant_api03"
redact_check "anthropic sk-ant-oat01 (bare)" "key: $ant_oat01" "$ant_oat01"
redact_check "sk-ant-oat01 via CLAUDE_CODE_OAUTH_TOKEN= (underscore-glued env name, the \\btoken gap)" \
  "CLAUDE_CODE_OAUTH_TOKEN=$ant_oat01" "$ant_oat01"
redact_check "openai project key sk-proj-" "key: $openai_proj" "$openai_proj"
redact_check "stripe live key sk_live_ (bare)" "key: $stripe_live" "$stripe_live"
redact_check "STRIPE_SECRET= env assignment" "STRIPE_SECRET=$stripe_live" "$stripe_live"
redact_check "DASHBOARD_TOKEN= env assignment (64-hex value)" "DASHBOARD_TOKEN=$hex64" "$hex64"
redact_check "telegram bot token (digits:35chars)" "bot: $tg_bot_tok" "$tg_bot_tok"
redact_check "curl -u user:pass" "curl -u admin:S3cretPass1" "S3cretPass1"
redact_check "groq key gsk_" "key: $groq_key" "$groq_key"
redact_check "openrouter key sk-or-v1-" "key: $openrouter_key" "$openrouter_key"
redact_check "github fine-grained PAT" "key: $gh_pat" "$gh_pat"
redact_check "google oauth ya29 token" "token: $ya29_tok" "$ya29_tok"
redact_check "slack incoming-webhook URL" "webhook: $slack_webhook" "$slack_webhook"
redact_check "AWS_SECRET_ACCESS_KEY= env assignment" "AWS_SECRET_ACCESS_KEY=$aws_secret" "$aws_secret"

# PEM markers built from concatenated parts (not one literal string) for the same reason.
pem_begin="-----BEGIN RSA PRIVATE"; pem_begin="${pem_begin} KEY-----"
pem_end="-----END RSA PRIVATE"; pem_end="${pem_end} KEY-----"
pem_out="$(printf '%s\nNOT-A-REAL-KEY-TEST-FIXTURE-BODY\n%s\n' "$pem_begin" "$pem_end" \
  | bash "$DISPATCH" --test-redact-secrets)"
check "redact_secrets 26-shape (31533): PEM private-key block -- raw key body removed" \
  "$(printf '%s' "$pem_out" | grep -c 'NOT-A-REAL-KEY-TEST-FIXTURE-BODY')" "0"
check "redact_secrets 26-shape (31533): PEM private-key block -- marker present" \
  "$(printf '%s' "$pem_out" | grep -c '\[REDACTED:pem-private-key\]')" "1"

hex_out="$(printf '%s' "hex: $hex64" | bash "$DISPATCH" --test-redact-secrets)"
check "redact_secrets 26-shape (31533): bare 64-hex dashboard-style token -- raw value removed" \
  "$(printf '%s' "$hex_out" | grep -c -- "$hex64")" "0"

# PII (email) stays unmasked -- Peti 13838 "Igen, vedd le" distinguishes credential masking from a
# blanket PII scrub; the M1 widening must not have changed this.
pii_out="$(printf '%s' "ugyfel email: ugyfel@example.com" | bash "$DISPATCH" --test-redact-secrets)"
check "redact_secrets 26-shape (31533): PII (email) still NOT masked after M1 widening" \
  "$(printf '%s' "$pii_out" | grep -c 'ugyfel@example.com')" "1"

# ---- M2: a change to is_freellm_blocked must not change --check-blocked (Gemini) output. Pins
# the 2 cases Cybersec's own GO named (comment 31533, MEDIUM-2): mopsion project and a category
# tag must both stay BLOCK on the Gemini route, independent of the freellm route's wider allowlist.
# "gemini-ok" is added so the POSITIVE-MARKER-REQUIRED check does not independently block this
# card for an unrelated reason and mask a project-allowlist mutant -- the only thing left
# standing between this card and ALLOWED is the project check itself.
check "M2 (31533): --check-blocked (Gemini), project=mopsion (+gemini-ok marker) -- stays BLOCK, not widened by the freellm allowlist" \
  "$(DASHBOARD_URL="http://127.0.0.1:1" bash "$DISPATCH" --check-blocked mopsion "gemini-ok" "egyszeru feladat" "irj egy fuggvenyt" >/dev/null 2>&1; echo $?)" "0"
# "gemini-ok" is added alongside the category tag so the POSITIVE-MARKER-REQUIRED check (which
# would otherwise block this card for an unrelated reason and mask a skip_category mutant) is
# satisfied, and the only thing left standing between this card and ALLOWED is the category-tag
# check that skip_category gates.
check "M2 (31533): --check-blocked (Gemini), project=mikrob + category tag SEC (+gemini-ok marker) -- stays BLOCK" \
  "$(DASHBOARD_URL="http://127.0.0.1:1" bash "$DISPATCH" --check-blocked mikrob "SEC,gemini-ok" "egyszeru feladat" "irj egy fuggvenyt" >/dev/null 2>&1; echo $?)" "0"


# ============================================================================================
# MikroB 18891 (delta on 2453cf94, Cybersec GO on 2453cf94 with 3 fix requests before landing).
# ============================================================================================

# ---- (1) PEM pattern was quadratic when a BEGIN marker has no matching END: the unbounded
# "[\s\S]+?" makes the regex engine retry a never-found END one char at a time for EACH BEGIN
# occurrence, and with many BEGIN occurrences spread densely through the text the total work is
# O(n^2) (measured before the fix, repeated-BEGIN input: 100k chars 1.46s, 400k chars 20s per
# leaf). A single isolated BEGIN, or BEGINs spaced far apart, is much cheaper (the regex engine's
# literal-prefix search finds each one in O(1), and the bounded fix below caps the subsequent
# scan) -- so the fixture below repeats the marker DENSELY (every ~47 chars, ~8500 occurrences
# in ~400k chars) to actually exercise the quadratic path (measured: 10.8s unbounded, 0.66s with
# the 8192-char cap fix). Timing pin: must stay well under 2s.
pem_stress_marker="-----BEGIN PRIVATE"; pem_stress_marker="${pem_stress_marker} KEY-----"
pem_stress_start="$(date +%s.%N)"
pem_stress_out="$(python3 -c "
import sys
marker = sys.argv[1]
unit = marker + 'A' * 20
sys.stdout.write(unit * 8500)
" "$pem_stress_marker" | bash "$DISPATCH" --test-redact-secrets)"
pem_stress_end="$(date +%s.%N)"
pem_stress_elapsed="$(python3 -c "print(1 if ($pem_stress_end - $pem_stress_start) < 2.0 else 0)")"
check "redact_secrets PEM pattern: ~400k chars, ~8500 densely-packed unterminated BEGIN markers -- stays under 2s (MikroB 18891 M1)" \
  "$pem_stress_elapsed" "1"
check "redact_secrets PEM pattern: ~400k chars, ~8500 densely-packed unterminated BEGIN markers -- output length unchanged (no match, no truncation)" \
  "$(printf '%s' "$pem_stress_out" | wc -c)" "399500"

# ---- (2) Telegram bot token pattern was exactly {35} on the secret and {8,10} on the bot id --
# widened to secret {30,60} / id {6,12} (MikroB 18891 M2). Pin the boundary cases the old
# pattern would have missed: 34-char and 40-char secrets.
tg_bot_tok_34="123456:"; tg_bot_tok_34="${tg_bot_tok_34}$(python3 -c "print('A'*34)")"
tg_bot_tok_40="1234567890:"; tg_bot_tok_40="${tg_bot_tok_40}$(python3 -c "print('B'*40)")"
redact_check "telegram bot token, 34-char secret (widened range, MikroB 18891 M2)" "bot: $tg_bot_tok_34" "$tg_bot_tok_34"
redact_check "telegram bot token, 40-char secret (widened range, MikroB 18891 M2)" "bot: $tg_bot_tok_40" "$tg_bot_tok_40"

# ---- (3) ya29 Google OAuth token pinned with a sample the OLDER labelled patterns (google-api-key
# AIza..., bearer-token) do not already mask on their own -- confirms the dedicated
# google-oauth-token pattern is doing the work, not an accidental overlap (MikroB 18891 M3).
ya29_dedicated="ya29."; ya29_dedicated="${ya29_dedicated}c0AfJohXNqWxYzAbCdEfGhIjKlMnOpQrStUvWx"
ya29_dedicated_out="$(printf '%s' "token=$ya29_dedicated" | bash "$DISPATCH" --test-redact-secrets)"
check "redact_secrets ya29 dedicated sample -- not already masked by google-api-key or bearer-token alone" \
  "$(printf '%s' "token=$ya29_dedicated" | python3 -c '
import re, sys
text = sys.stdin.read()
older = [re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"), re.compile(r"\bBearer\s+[A-Za-z0-9._-]{10,}", re.IGNORECASE)]
print(1 if any(p.search(text) for p in older) else 0)
')" "0"
check "redact_secrets ya29 dedicated sample -- raw value removed by dedicated pattern" \
  "$(printf '%s' "$ya29_dedicated_out" | grep -c -- "$ya29_dedicated")" "0"
check "redact_secrets ya29 dedicated sample -- google-oauth-token marker present" \
  "$(printf '%s' "$ya29_dedicated_out" | grep -c '\[REDACTED:google-oauth-token\]')" "1"

echo
echo "offload-dispatch.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
