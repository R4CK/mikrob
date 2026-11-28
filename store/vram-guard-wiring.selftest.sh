#!/usr/bin/env bash
# vram-guard-wiring.selftest.sh -- card 108c7b10, reworked for card 090ab223.
#
# WHAT THIS COVERS, and what it does not. That every script which DISPATCHES WORK to the local
# model ends up ONLINE/skip/abstain when the GPU cannot take work -- regardless of whether that
# dispatcher still has its OWN direct vram-guard-check.sh call (offload-dispatch.sh, i18n-draft.sh:
# option A was NOT removed from these two, see DECISIONS.md) or now relies entirely on the
# local-llm.sh choke point (card-build-route.sh, route-classify.sh, local-llm-rag.sh,
# gate-pretriage.sh: option A WAS removed from these four after a 46-day measurement found it never
# caught anything the choke point did not). It is not an acceptance test for any of those scripts.
#
# THE STUB CONTRACT mirrors vram-guard-check.sh's own: exit 0 = ADMIT, non-zero = HOLD, and a
# MISSING guard is skipped (a host that never had a GPU is not doubt -- treating it as HOLD would
# disable local routing there for ever).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
n=0; fail=0
t() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; fail=1; fi; }
contains() { n=$((n+1)); case "$2" in *"$3"*) echo "ok   $1" ;; *) echo "FAIL $1: [$2] does not contain [$3]"; fail=1 ;; esac; }

printf '#!/usr/bin/env bash\necho "ADMIT ok 1024/24576 MiB (4%%)"\nexit 0\n' > "$TMP/vram-admit.sh"
printf '#!/usr/bin/env bash\necho "HOLD hard 23000/24576 MiB (94%%)"\nexit 1\n' > "$TMP/vram-hold.sh"
printf '#!/usr/bin/env bash\necho "vram-guard-check.sh: unknown arg" >&2\nexit 2\n' > "$TMP/vram-usage.sh"
chmod +x "$TMP"/*.sh

# --- 1. STILL-DIRECT dispatchers consult the guard themselves --------------------------------------
# option A was kept on these two (card 090ab223's finding: removing it there would change real
# behaviour, not just skip some prep work -- i18n-draft.sh's per-key loop has no busy-break, and
# offload-dispatch.sh's CAPACITY_HOLD is load-bearing FreeLLM-fallback routing, card 4eb3743e).
for s in offload-dispatch.sh i18n-draft.sh; do
  hits="$(sed -E 's/^[[:space:]]*#.*$//' "$HERE/$s" | grep -c 'vram-guard-check' || true)"
  t "$s still consults the vram guard directly (comment-stripped)" "$([ "${hits:-0}" -ge 1 ] && echo yes || echo no)" "yes"
done

# --- 1b. REMOVED-OPTION-A dispatchers no longer call vram-guard-check.sh directly -------------------
# The assertion that fails if someone re-adds a dead duplicate call site, or if a future removal
# forgets one of these four.
for s in card-build-route.sh route-classify.sh local-llm-rag.sh gate-pretriage.sh; do
  hits="$(sed -E 's/^[[:space:]]*#.*$//' "$HERE/$s" | grep -c 'vram-guard-check' || true)"
  t "$s no longer calls vram-guard-check.sh directly (card 090ab223)" "${hits:-0}" "0"
done

# NEGATIVE CONTROL for the two loops above: a GPU-purpose tool must NOT be gated. Without this, the
# loop would pass just as happily on a rule that gated everything -- including the benchmark whose
# job is to fill the GPU.
bench_hits="$(sed -E 's/^[[:space:]]*#.*$//' "$HERE/local-llm-bench.sh" | grep -c 'vram-guard-check' || true)"
t "local-llm-bench.sh is NOT gated (its subject is the GPU)" "${bench_hits:-0}" "0"

# --- 2. THE REAL CHOKE POINT, EXTRACTED FROM local-llm.sh (not reimplemented) -----------------------
# card 090ab223: four dispatchers now depend ENTIRELY on local-llm.sh's own choke point for GPU
# capacity. "Mutant: choke point fail-open must go red" (MikroB's own requirement) only means
# something if this test exercises the REAL block, not a hand-written stand-in for it -- same
# pattern fleet-test-notify-injection.selftest.sh already uses for its own functions. Extracted by
# anchoring on the exact assignment line and the matching (2-space-indented) closing `fi`; if the
# real block ever moves or is reworded, this extraction breaks LOUDLY (asserted below) rather than
# silently testing nothing.
LLM_SH="$HERE/local-llm.sh"
sed -n '/^  VRAM_GUARD="\${LOCAL_LLM_VRAM_GUARD:-\$HERE\/vram-guard-check.sh}"$/,/^  fi$/p' "$LLM_SH" > "$TMP/choke-point-block.txt"
[ -s "$TMP/choke-point-block.txt" ] || { echo "FAIL: could not extract the real VRAM choke-point block from $LLM_SH -- source and selftest have drifted"; fail=1; }
grep -q 'exit 6' "$TMP/choke-point-block.txt" || { echo "FAIL: extracted choke-point block has no 'exit 6' -- source and selftest have drifted"; fail=1; }

# The REAL block, wrapped so it runs standalone: "$HERE" inside the extracted text is only a
# fallback for an unset LOCAL_LLM_VRAM_GUARD, and every case below sets that var explicitly, so its
# value here is never actually read.
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  echo 'HERE="'"$HERE"'"'
  cat "$TMP/choke-point-block.txt"
  echo 'echo "${STUB_POST_GUARD_OUTPUT:-MECHANICAL}"'
  echo 'exit 0'
} > "$TMP/choke-point-stub.sh"
chmod +x "$TMP/choke-point-stub.sh"

# THE MUTANT: the same wrapper with the extracted block OMITTED -- i.e. what local-llm.sh would do
# if its choke point went fail-open (ignored HOLD entirely). Used below to prove each dispatcher's
# test is load-bearing: if it passes identically against the mutant, it was never testing the real
# protection.
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  echo 'echo "${STUB_POST_GUARD_OUTPUT:-MECHANICAL}"'
  echo 'exit 0'
} > "$TMP/choke-point-mutant.sh"
chmod +x "$TMP/choke-point-mutant.sh"

# --- 3. route-classify: abstains under a real choke-point HOLD, reaches the model under ADMIT ------
TASK='Add a column to the report table.'

out="$(ROUTE_CLASSIFY_LLM="$TMP/choke-point-stub.sh" LOCAL_LLM_VRAM_GUARD="$TMP/vram-hold.sh" \
       bash "$HERE/route-classify.sh" --text "$TASK" 2>/dev/null)"; rc=$?
t "route-classify: real choke-point HOLD -> UNKNOWN (abstain, caller keeps its verdict)" "$out" "UNKNOWN"
t "route-classify: HOLD still exits 0 (the caller decides, never this script)" "$rc" "0"

out="$(ROUTE_CLASSIFY_LLM="$TMP/choke-point-stub.sh" LOCAL_LLM_VRAM_GUARD="$TMP/vram-admit.sh" \
       bash "$HERE/route-classify.sh" --text "$TASK" 2>/dev/null)"
t "route-classify: real choke-point ADMIT -> the model is reached" "$out" "MECHANICAL"

# MUTATION-PIN: same HOLD, but through the FAIL-OPEN mutant instead of the real block. If this
# still came back UNKNOWN, the two cases above would be proving nothing about the choke point.
out="$(ROUTE_CLASSIFY_LLM="$TMP/choke-point-mutant.sh" LOCAL_LLM_VRAM_GUARD="$TMP/vram-hold.sh" \
       bash "$HERE/route-classify.sh" --text "$TASK" 2>/dev/null)"
t "route-classify: a fail-open choke point (mutant) is NOT caught by this script -- proves the real block above is load-bearing" "$out" "MECHANICAL"

# --- 4. card-build-route: the windowed EASY/COMPLEX loop treats a real choke-point HOLD as BUSY ----
printf '#!/usr/bin/env bash\necho MECHANICAL\n' > "$TMP/classify-mech.sh"; chmod +x "$TMP/classify-mech.sh"
CBR_TASK='Write parseDurationMs(raw: string): number and three unit tests for it.'

out="$(CARD_BUILD_ROUTE_LLM="$TMP/choke-point-stub.sh" STUB_POST_GUARD_OUTPUT=EASY \
       CARD_BUILD_ROUTE_CLASSIFY="$TMP/classify-mech.sh" LOCAL_LLM_VRAM_GUARD="$TMP/vram-hold.sh" \
       bash "$HERE/card-build-route.sh" --text "$CBR_TASK" --priority low 2>/dev/null)"
t "card-build-route: real choke-point HOLD -> ONLINE (model-busy, never held up)" "$out" "ONLINE"

out="$(CARD_BUILD_ROUTE_LLM="$TMP/choke-point-stub.sh" STUB_POST_GUARD_OUTPUT=EASY \
       CARD_BUILD_ROUTE_CLASSIFY="$TMP/classify-mech.sh" LOCAL_LLM_VRAM_GUARD="$TMP/vram-admit.sh" \
       bash "$HERE/card-build-route.sh" --text "$CBR_TASK" --priority low 2>/dev/null)"
t "card-build-route: real choke-point ADMIT -> LOCAL (verdict unchanged)" "$out" "LOCAL"

# MUTATION-PIN: same HOLD, through the fail-open mutant. Must NOT be ONLINE, or the case above
# proves nothing about the choke point specifically (as opposed to e.g. the stub always saying EASY).
out="$(CARD_BUILD_ROUTE_LLM="$TMP/choke-point-mutant.sh" STUB_POST_GUARD_OUTPUT=EASY \
       CARD_BUILD_ROUTE_CLASSIFY="$TMP/classify-mech.sh" LOCAL_LLM_VRAM_GUARD="$TMP/vram-hold.sh" \
       bash "$HERE/card-build-route.sh" --text "$CBR_TASK" --priority low 2>/dev/null)"
t "card-build-route: a fail-open choke point (mutant) is NOT caught by this script -- proves the real block above is load-bearing" "$out" "LOCAL"

# --- i18n-draft: option A kept (card 090ab223 finding -- its per-key loop has no busy-break, so
# removing the pre-check would mean up to --limit doomed subprocess spawns instead of one clean
# early exit). HOLD writes no draft, and says so with a distinct code.
I18N_DRAFT_VRAM_GUARD="$TMP/vram-hold.sh" bash "$HERE/i18n-draft.sh" \
  --messages-dir "$TMP" --lang hu >/dev/null 2>"$TMP/i18n.err"; rc=$?
t "i18n-draft: HOLD exits 3, not 4 (capacity is not a usage error)" "$rc" "3"
contains "i18n-draft: HOLD says NO draft was written" "$(cat "$TMP/i18n.err")" "NO draft was written"

# CONTROL: with ADMIT the VRAM check must let the script through to its ORDINARY validation, i.e. a
# different failure. If HOLD and ADMIT produced the same exit, the case above would prove nothing.
I18N_DRAFT_VRAM_GUARD="$TMP/vram-admit.sh" bash "$HERE/i18n-draft.sh" \
  --messages-dir "$TMP" --lang hu >/dev/null 2>&1; rc=$?
t "i18n-draft: ADMIT passes the gate (fails later, on its own preconditions)" "$([ "$rc" = "3" ] && echo same || echo different)" "different"

# the `set -e` shape (i18n-draft.sh is the only remaining direct-call site that runs under it;
# local-llm-rag.sh no longer has its own VRAM_GUARD read at all, card 090ab223). FOUND BY THIS FILE
# on code that had already shipped: under `set -e` the plain form `x="$(bash "$GUARD")"; rc=$?`
# never reaches the second statement, so a HOLD kills the script at the assignment instead of
# being handled.
body="$(sed -E 's/^[[:space:]]*#.*$//' "$HERE/i18n-draft.sh")"
bad="$(printf '%s' "$body" | grep -c 'VRAM_GUARD" 2>/dev/null)"; vram_rc=' || true)"
t "i18n-draft.sh (runs under set -e) captures the guard's status without dying" "${bad:-0}" "0"

# --- 5. local-llm-rag and gate-pretriage: call the REAL local-llm.sh unconditionally (no LLM ------
# override exists on either of them), so no stub is needed or possible here -- a forced real
# choke-point HOLD must still end in a clean, non-crashing, correctly-coded refusal.
#
# local-llm-rag.sh: `--no-route` skips the (now also choke-point-only) content router entirely and
# goes straight to drafting, so the real local-llm.sh call at the bottom (`call_model "$FULL_PROMPT";
# exit $?`, card 0c054ebf) is what is under test here -- the exact call site every ROUTE=local task
# reaches. No live ollama is needed: the choke point in local-llm.sh fires before any network call.
out="$(LOCAL_LLM_VRAM_GUARD="$TMP/vram-hold.sh" \
       timeout 20 bash "$HERE/local-llm-rag.sh" --no-route --no-shared --agent selftest "a bounded task" 2>/dev/null)"; rc=$?
t "local-llm-rag: real choke-point HOLD propagates local-llm.sh's own exit code (6), not 0 and not a hang" "$rc" "6"
t "local-llm-rag: real choke-point HOLD writes nothing to stdout (no fake draft)" "$out" ""

# gate-pretriage.sh: --explain is the only path that touches the local model at all.
REPO="$TMP/repo"
mkdir -p "$REPO" && git -C "$REPO" init -q 2>/dev/null
git -C "$REPO" config user.email t@t.test; git -C "$REPO" config user.name t
echo one > "$REPO/a.txt"; git -C "$REPO" add a.txt; git -C "$REPO" commit -qm first
echo two >> "$REPO/a.txt"; git -C "$REPO" add a.txt; git -C "$REPO" commit -qm second

out="$(LOCAL_LLM_VRAM_GUARD="$TMP/vram-hold.sh" timeout 20 bash "$HERE/gate-pretriage.sh" --repo "$REPO" --explain 2>/dev/null)"; rc=$?
contains "gate-pretriage: real choke-point HOLD still prints the mechanical report" "$out" "this is INPUT to a gate"
contains "gate-pretriage: real choke-point HOLD falls back cleanly (no crash, no fake success)" "$out" "local model unavailable"
t "gate-pretriage: real choke-point HOLD still exits 0 (advisory-only, never blocks the report)" "$rc" "0"

echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
