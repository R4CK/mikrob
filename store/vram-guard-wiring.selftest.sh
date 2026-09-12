#!/usr/bin/env bash
# vram-guard-wiring.selftest.sh -- card 108c7b10.
#
# WHAT THIS COVERS, and what it does not. Only ONE thing: that every script which DISPATCHES WORK to
# the local model asks the VRAM guard first, and does the right thing when it says HOLD. It is not
# an acceptance test for any of those scripts.
#
# WHY A FILE OF ITS OWN rather than cases inside each script's selftest. Two of the three scripts
# wired by this card have no selftest at all, and the third (route-classify) is on the fleet
# runner's EXCLUDED list because it needs a live local model -- so a case added there would never
# run on a landing. These cases need no model: every guard is a stub. A control that does not run is
# the failure this fleet keeps finding, and it was one filename away here.
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

# --- 1. EVERY dispatcher consults the guard -------------------------------------------------------
# Source-level, on COMMENT-STRIPPED text (CLAUDE.md rule 12): a script that only MENTIONS the guard
# in a comment must not count as wired. This is the assertion that fails if someone removes a call
# site, or adds a seventh dispatcher and forgets it.
#
# The list is the WORK dispatchers -- the ones that route real tasks to the model. Deliberately NOT
# the GPU-purpose tools (local-llm-bench, local-llm-tune*, first-run-llm, graphify): their subject IS
# the GPU, and gating them would be circular. Measured when this card was taken: those tools do not
# go through local-llm.sh at all, so the two populations really are disjoint.
for s in card-build-route.sh local-llm-rag.sh offload-dispatch.sh \
         gate-pretriage.sh i18n-draft.sh route-classify.sh; do
  hits="$(sed -E 's/^[[:space:]]*#.*$//' "$HERE/$s" | grep -c 'vram-guard-check' || true)"
  t "$s consults the vram guard (comment-stripped)" "$([ "${hits:-0}" -ge 1 ] && echo yes || echo no)" "yes"
done

# NEGATIVE CONTROL for the check above: a GPU-purpose tool must NOT be gated. Without this, the loop
# would pass just as happily on a rule that gated everything -- including the benchmark whose job is
# to fill the GPU.
bench_hits="$(sed -E 's/^[[:space:]]*#.*$//' "$HERE/local-llm-bench.sh" | grep -c 'vram-guard-check' || true)"
t "local-llm-bench.sh is NOT gated (its subject is the GPU)" "${bench_hits:-0}" "0"

# --- 2. route-classify: HOLD abstains, and abstaining is not a new outcome -------------------------
# A STUB MODEL, so these cases measure the GUARD and not the GPU. The first draft pointed at the
# real model for the missing-guard case and was non-deterministic: it returned UNKNOWN on one run
# (model timed out) and MECHANICAL on the next (model answered). That is precisely why the fleet
# runner EXCLUDES route-classify's own selftest, and it would have made this file a flake.
printf '#!/usr/bin/env bash\necho MECHANICAL\n' > "$TMP/llm-stub.sh"; chmod +x "$TMP/llm-stub.sh"
TASK='Add a column to the report table.'

out="$(ROUTE_CLASSIFY_VRAM_GUARD="$TMP/vram-hold.sh" ROUTE_CLASSIFY_LLM="$TMP/llm-stub.sh" \
       bash "$HERE/route-classify.sh" --text "$TASK" 2>/dev/null)"; rc=$?
t "route-classify: HOLD -> UNKNOWN (abstain, caller keeps its verdict)" "$out" "UNKNOWN"
t "route-classify: HOLD still exits 0 (the caller decides, never this script)" "$rc" "0"

out="$(ROUTE_CLASSIFY_VRAM_GUARD="$TMP/vram-usage.sh" ROUTE_CLASSIFY_LLM="$TMP/llm-stub.sh" \
       bash "$HERE/route-classify.sh" --text "$TASK" 2>/dev/null)"
t "route-classify: a guard USAGE error also abstains (doubt about the measurement = doubt)" "$out" "UNKNOWN"

# THE CONTROL THAT MAKES THE THREE ABOVE MEAN SOMETHING: same stub model, guard MISSING. The model
# IS consulted and its answer comes through, so the UNKNOWNs above are the guard short-circuiting
# BEFORE the model -- not this script abstaining for some unrelated reason.
out="$(ROUTE_CLASSIFY_VRAM_GUARD="$TMP/nonexistent.sh" ROUTE_CLASSIFY_LLM="$TMP/llm-stub.sh" \
       bash "$HERE/route-classify.sh" --text "$TASK" 2>/dev/null)"
t "route-classify: a MISSING guard is skipped -- the model is reached" "$out" "MECHANICAL"

# --- 3. i18n-draft: HOLD writes no draft, and says so with a distinct code -------------------------
I18N_DRAFT_VRAM_GUARD="$TMP/vram-hold.sh" bash "$HERE/i18n-draft.sh" \
  --messages-dir "$TMP" --lang hu >/dev/null 2>"$TMP/i18n.err"; rc=$?
t "i18n-draft: HOLD exits 3, not 4 (capacity is not a usage error)" "$rc" "3"
contains "i18n-draft: HOLD says NO draft was written" "$(cat "$TMP/i18n.err")" "NO draft was written"

# CONTROL: with ADMIT the VRAM check must let the script through to its ORDINARY validation, i.e. a
# different failure. If HOLD and ADMIT produced the same exit, the case above would prove nothing.
I18N_DRAFT_VRAM_GUARD="$TMP/vram-admit.sh" bash "$HERE/i18n-draft.sh" \
  --messages-dir "$TMP" --lang hu >/dev/null 2>&1; rc=$?
t "i18n-draft: ADMIT passes the gate (fails later, on its own preconditions)" "$([ "$rc" = "3" ] && echo same || echo different)" "different"

# --- 3b. gate-pretriage: HOLD skips the advisory summary and SAYS SO ------------------------------
# A tiny real repo, because the script needs a commit range. Only --explain is exercised: without it
# the local model is not involved at all and there is nothing here to measure.
REPO="$TMP/repo"
mkdir -p "$REPO" && git -C "$REPO" init -q 2>/dev/null
git -C "$REPO" config user.email t@t.test; git -C "$REPO" config user.name t
echo one > "$REPO/a.txt"; git -C "$REPO" add a.txt; git -C "$REPO" commit -qm first
echo two >> "$REPO/a.txt"; git -C "$REPO" add a.txt; git -C "$REPO" commit -qm second

out="$(PRETRIAGE_VRAM_GUARD="$TMP/vram-hold.sh" bash "$HERE/gate-pretriage.sh" --repo "$REPO" --explain 2>/dev/null)"
contains "gate-pretriage: HOLD says the model was NOT asked" "$out" "local model not asked"
contains "gate-pretriage: HOLD still prints the mechanical report" "$out" "this is INPUT to a gate"

# CONTROL: with ADMIT the script must NOT print the not-asked line -- otherwise the case above would
# pass on a script that always skips the model, which is the opposite failure.
out="$(PRETRIAGE_VRAM_GUARD="$TMP/vram-admit.sh" timeout 90 bash "$HERE/gate-pretriage.sh" --repo "$REPO" --explain 2>/dev/null)"
case "$out" in
  *"local model not asked"*) t "gate-pretriage: ADMIT does not claim the model was skipped" "skipped" "asked" ;;
  *) t "gate-pretriage: ADMIT does not claim the model was skipped" "asked" "asked" ;;
esac

# --- 4. the `set -e` shape, on every call site that runs under it -----------------------------------
# FOUND BY THIS FILE, on code that had already shipped. Under `set -e` the plain form
#   vram_line="$(bash "$GUARD")"; vram_rc=$?
# never reaches the second statement: the assignment itself carries the guard's non-zero status and
# kills the script. Measured on the live main clone before the fix: local-llm-rag.sh exited 1 with NO
# output when the guard said HOLD, so ROUTE=online with a vram-hold reason -- its documented
# behaviour -- never happened. The safe direction survived by accident (a dead script drafts
# nothing); the explanation did not.
#
# Asserted on the SOURCE because reproducing it end to end needs a built router. Scoped to the
# scripts that actually run under `set -e`: on the others the plain form is correct and flagging it
# would be noise.
for s in local-llm-rag.sh i18n-draft.sh; do
  body="$(sed -E 's/^[[:space:]]*#.*$//' "$HERE/$s")"
  case "$body" in
    *'set -e'*)
      bad="$(printf '%s' "$body" | grep -c 'VRAM_GUARD" 2>/dev/null)"; vram_rc=' || true)"
      t "$s (runs under set -e) captures the guard's status without dying" "${bad:-0}" "0" ;;
    *) t "$s does not run under set -e -- nothing to check" "skip" "skip" ;;
  esac
done

echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
