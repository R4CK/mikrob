#!/usr/bin/env bash
# gate-pretriage.sh -- LOCAL first-pass before an online gate agent reads a card (card 7041c165).
#
# THE POINT: a QA/Cybersec gate currently spends online Claude tokens re-discovering the same
# mechanical facts on every card -- what changed, does it type-check, do the new tests actually touch
# the diff, are there vacuous assertions, did a secret land in argv. All of that is DETERMINISTIC and
# can run on this machine for free. This script produces that report so the online gate starts from
# facts instead of paying to derive them.
#
# WHAT THIS IS NOT: a verdict. It never prints PASS/FAIL/GO/NO-GO and it never decides whether a card
# ships. The checks below are cheap heuristics chosen because each one corresponds to a finding class
# that ACTUALLY recurred in this fleet's gate history; a clean report means "the cheap traps are
# clear", never "this card is good". The online gate still does the real review. A local 7B must not
# adjudicate security, so the optional --explain summary is explicitly labelled advisory and no check
# result is derived from it.
#
# USAGE:
#   gate-pretriage.sh --repo <path> [--base <ref>] [--head <ref>] [--json] [--explain] [--trunk <ref>]
#     --base/--head  commit range to inspect (default: HEAD~1..HEAD)
#     --json         machine-readable output (for a scheduled task / the dashboard)
#     --explain      additionally ask the LOCAL model for a plain-language summary (advisory only)
#     --trunk <ref>  OPT-IN land-parity check (card a42d27e1): build the ACTUAL merge-with-<ref>
#                    tree in a disposable worktree and run lint-ratchet.sh + a DECISIONS.md
#                    append-union dry-run + an importer-sweep fleet-test.sh pass against it -- the
#                    same three things marveen-land.sh checks, which no gate round runs today. Three
#                    fully-gated cards (56344ff4, 2ba008f2, 9ea8dcb8) were stopped only by the land
#                    dry-run after every gate had already said GO/PASS. Omitted (the default): this
#                    section does not run at all, so every existing caller keeps today's cost and
#                    behaviour -- a real merge + a real lint run + a real fleet-test.sh run are not
#                    free, so this only happens where a caller explicitly asks for land parity.
#
# EXIT: always 0 unless usage/repo is wrong (2). A finding is REPORTED, never fatal -- this is an
# input to a human/agent gate, not a CI blocker, and a non-zero exit would make callers treat a
# heuristic hit as a hard failure.

set -uo pipefail

REPO=""; BASE=""; HEAD_REF="HEAD"; JSON=0; EXPLAIN=0; TRUNK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD_REF="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    --explain) EXPLAIN=1; shift ;;
    --trunk) TRUNK="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "gate-pretriage: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO" && -d "$REPO/.git" ]] || { echo "gate-pretriage: --repo must be a git repo" >&2; exit 2; }
cd "$REPO" || exit 2
[[ -n "$BASE" ]] || BASE="$(git rev-parse "${HEAD_REF}~1" 2>/dev/null || echo "$HEAD_REF")"

CHANGED=$(git diff --name-only "$BASE" "$HEAD_REF" 2>/dev/null)
CODE_FILES=$(echo "$CHANGED" | grep -E '\.(ts|tsx|js|mjs|cjs)$' | grep -v '\.test\.' || true)
TEST_FILES=$(echo "$CHANGED" | grep -E '\.test\.(ts|tsx)$' || true)

findings=()   # "severity|check|detail"
add() { findings+=("$1|$2|$(printf %s "$3" | tr "\n" " ")"); }

# NET-NEW counting. A diff-based heuristic that only counts `+` lines cries wolf on every refactor
# that MOVES an existing pattern (verified: this script's own first run flagged "secret-in-argv" on a
# commit that merely swapped a path inside lines that already contained the pattern). Comparing the
# added against the removed count separates "introduced" from "touched"; a check that fires on
# untouched risk teaches gates to ignore it, which is worse than not having the check.
#   net_new <pattern> [paths...]  -> prints "<net_new> <added>"
net_new() {
  local pat="$1"; shift
  local d plus minus
  d=$(git diff "$BASE" "$HEAD_REF" -- "$@" 2>/dev/null)
  plus=$(echo "$d" | grep -cE "^\+.*${pat}" || true)
  minus=$(echo "$d" | grep -cE "^-.*${pat}" || true)
  echo "$(( plus - minus )) $plus"
}

# --- 1. changed code with no changed test -------------------------------------------------------
# Recurring class: a green suite that never executes the diff ("N/N green" is vacuous if no test
# touches the changed symbols).
if [[ -n "$CODE_FILES" && -z "$TEST_FILES" ]]; then
  add "warn" "no-test-for-changed-code" "$(echo "$CODE_FILES" | wc -l) code file(s) changed, 0 test files"
fi

# --- 2. exported symbols added without any test mentioning them ---------------------------------
if [[ -n "$CODE_FILES" ]]; then
  new_syms=$(git diff "$BASE" "$HEAD_REF" -- $CODE_FILES 2>/dev/null \
    | grep -E '^\+export (function|const|class) ' \
    | sed -E 's/^\+export (function|const|class) ([A-Za-z0-9_]+).*/\2/' | sort -u)
  untested=""
  for sym in $new_syms; do
    if ! git grep -qE "\b${sym}\b" "$HEAD_REF" -- '*.test.ts' '*.test.tsx' 2>/dev/null; then
      untested="${untested}${untested:+, }${sym}"
    fi
  done
  [[ -n "$untested" ]] && add "warn" "exported-symbol-untested" "no test references: $untested"
fi

# --- 3. vacuous assertions ----------------------------------------------------------------------
# `.not.toBe(input)` passes for a WRONG output too -- this exact shape once hid a rate-limit bug
# where every IPv4 client collapsed into one bucket.
if [[ -n "$TEST_FILES" ]]; then
  read -r vac_net vac_add <<< "$(net_new '\.not\.(toBe|toEqual)\(' $TEST_FILES)"
  if [[ "${vac_net:-0}" -gt 0 ]]; then
    add "warn" "possibly-vacuous-assertion" \
      "$vac_net NEW .not.toBe/.not.toEqual assertion(s) -- assert the EXACT expected value instead"
  elif [[ "${vac_add:-0}" -gt 0 ]]; then
    add "info" "possibly-vacuous-assertion" "$vac_add touched, none net-new (pre-existing shape)"
  fi
  todo=$(git diff "$BASE" "$HEAD_REF" -- $TEST_FILES 2>/dev/null \
    | grep -cE '^\+\s*(it|test|describe)\.(skip|todo)\(' || true)
  [[ "${todo:-0}" -gt 0 ]] && add "warn" "skipped-test-added" "$todo newly skipped/todo test(s)"
fi

# --- 4. secret material on a command line -------------------------------------------------------
# argv is world-readable via /proc/<pid>/cmdline, so a token passed as an argument leaks to any
# local process for the lifetime of the call.
read -r tok_net tok_add <<< "$(net_new '(Authorization: Bearer \$|--password[= ]\$|token=\$)' .)"
if [[ "${tok_net:-0}" -gt 0 ]]; then
  add "high" "secret-in-argv" \
    "$tok_net NEW line(s) put a token/password on a command line -- read it from a 0600 file instead"
elif [[ "${tok_add:-0}" -gt 0 ]]; then
  add "info" "secret-in-argv" "$tok_add touched, none net-new (pre-existing pattern, not introduced here)"
fi

# --- 5. inline styles on the frontend (CSP) -----------------------------------------------------
# jsdom does not enforce CSP, so an inline style passes every unit test and breaks only in a browser.
fe=$(echo "$CHANGED" | grep -E '\.(tsx|jsx)$' || true)
if [[ -n "$fe" ]]; then
  read -r css_net css_add <<< "$(net_new 'style=\{\{' $fe)"
  if [[ "${css_net:-0}" -gt 0 ]]; then
    add "warn" "csp-inline-style" \
      "$css_net NEW inline style={{...}} -- blocked by a strict CSP, invisible to jsdom tests"
  elif [[ "${css_add:-0}" -gt 0 ]]; then
    add "info" "csp-inline-style" "$css_add touched, none net-new"
  fi
fi

# --- 6. migration without a rollback note -------------------------------------------------------
mig=$(echo "$CHANGED" | grep -E 'migrations/.*\.sql$' || true)
if [[ -n "$mig" ]]; then
  for m in $mig; do
    git show "$HEAD_REF:$m" 2>/dev/null | grep -qiE 'backfill|rollback|down|IF NOT EXISTS' \
      || add "warn" "migration-no-safety-note" "$m has no IF NOT EXISTS / backfill / rollback note"
  done
fi

# --- 8. lockfile out of sync with a changed package.json ----------------------------------------
# Recurring class, twice in one day (cards 8d673233 and af7441a3): a workspace dependency declared in
# package.json with pnpm-lock.yaml not regenerated. Both passed every gate and both blocked the
# deploy, because NO local check reads the lockfile -- tsc, vitest and the linters all resolve
# through an already-installed node_modules, so the first clean install is at deploy time.
#
# Reported, never fatal, like every other finding here: this script is an input to a gate, and the
# landing script is where the same check refuses. A harness fault (exit 3 -- no pnpm, network) is
# deliberately NOT reported as a finding: "the toolchain is broken" is not a fact about this card.
if echo "$CHANGED" | grep -qE '(^|/)package\.json$'; then
  lf_out="$("$(dirname "$0")/lockfile-sync-check.sh" --repo "$REPO" --ref "$HEAD_REF" 2>&1)"
  case $? in
    1) add "fail" "lockfile-out-of-sync" "$(printf '%s' "$lf_out" | grep -iE 'were added|were removed|specifiers' | head -1 | sed 's/^ *//')" ;;
    3) : ;; # harness fault -- say nothing rather than blame the card
  esac
fi

# --- 8b. the SAME question for npm repos (card c3f052ad) ----------------------------------------
# Section 8 above is pnpm-only. On marveen -- an npm repo -- it answered "not applicable" after card
# fe06da0c, which removed a false [fail] but left the real question unasked. Same contract, same
# three-way exit handling: a harness fault is not a finding about this card.
if echo "$CHANGED" | grep -qE '(^|/)package\.json$'; then
  npm_lf_out="$("$(dirname "$0")/npm-lockfile-sync-check.sh" --repo "$REPO" --ref "$HEAD_REF" 2>&1)"
  case $? in
    1) add "fail" "npm-lockfile-out-of-sync" "$(printf '%s' "$npm_lf_out" | grep -iE 'were added|were removed|specifiers differ' | head -1 | sed 's/^ *//')" ;;
    3) : ;; # harness fault -- say nothing rather than blame the card
  esac
fi

# --- 9. land parity: lint-ratchet + DECISIONS append-union + importer sweep, on the ACTUAL
# merge-with-trunk tree, not the diff (card a42d27e1, OPT-IN via --trunk; see usage block above for
# why it defaults off). Checks 1-8 above all reason from `git diff`/`git show` alone -- cheap, but
# blind to anything that only exists once trunk and this branch are actually merged: a lint rule
# that only regresses in the COMBINED tree, a DECISIONS.md tail-append that conflicts against
# trunk's OWN concurrent append, a sibling test (same hub file, different test file) a scoped QA
# run never touched. Each of those sank a fully-gated card at the LAND dry-run, after every gate
# had already said GO/PASS -- this builds the same tree land builds, so a gate sees it first.
if [[ -n "$TRUNK" ]]; then
  if git -C "$REPO" rev-parse --verify "${TRUNK}^{commit}" >/dev/null 2>&1; then
    PARITY_WT="$(mktemp -d "${TMPDIR:-/tmp}/gate-pretriage-parity.XXXXXX")"
    # Backstop cleanup: `git worktree remove` first (normal case), `rm -rf` if that worktree was
    # never registered (e.g. `worktree add` itself failed). Runs once, at actual script exit --
    # nothing earlier in this script calls `exit` after this point except the final `exit 0`.
    trap '[[ -n "${PARITY_WT:-}" ]] && { git -C "'"$REPO"'" worktree remove --force "$PARITY_WT" >/dev/null 2>&1 || rm -rf "$PARITY_WT"; }' EXIT
    git -C "$REPO" worktree add --detach "$PARITY_WT" "$TRUNK" >/dev/null 2>&1

    merge_ok=0
    if git -C "$PARITY_WT" -c user.email=gate-pretriage@marveen.local -c user.name=gate-pretriage \
         merge --no-ff "$HEAD_REF" -m "gate-pretriage land-parity check" >/dev/null 2>&1; then
      merge_ok=1
      add "info" "land-parity-merge" "clean merge against $TRUNK, no conflicts"
    else
      conflicted="$(git -C "$PARITY_WT" diff --name-only --diff-filter=U 2>/dev/null)"
      if [[ "$conflicted" == "DECISIONS.md" && -f "$REPO/store/decisions-append-union.sh" ]]; then
        # shellcheck source=./decisions-append-union.sh
        . "$REPO/store/decisions-append-union.sh"
        if try_append_union "$PARITY_WT" "DECISIONS.md" 2>/dev/null; then
          git -C "$PARITY_WT" -c user.email=gate-pretriage@marveen.local -c user.name=gate-pretriage \
            commit --no-edit -q
          merge_ok=1
          add "info" "land-parity-merge" "DECISIONS.md conflicted against $TRUNK, auto-unioned (pure append both sides)"
        else
          add "fail" "decisions-union-would-refuse" \
            "DECISIONS.md conflicts against $TRUNK and would NOT auto-union at land time -- check the new entry's header against the ## YYYY-MM-DD glob try_append_union requires"
          git -C "$PARITY_WT" merge --abort >/dev/null 2>&1
        fi
      elif [[ -n "$conflicted" ]]; then
        add "fail" "land-merge-conflicts" \
          "merge against $TRUNK conflicts in: $(printf '%s' "$conflicted" | tr '\n' ' ')"
        git -C "$PARITY_WT" merge --abort >/dev/null 2>&1
      else
        add "info" "land-parity-merge" "merge against $TRUNK failed with no conflicted-file list (harness fault, not a card fact)"
      fi
    fi

    if [[ "$merge_ok" == "1" ]]; then
      # lint-ratchet.sh must be the WORKTREE'S OWN copy, never the main clone's -- its ROOT
      # resolves from its own BASH_SOURCE path, so the main clone's copy would measure the WRONG
      # tree (card 2ba008f2 round 6's own lesson, learned by hand before this section existed).
      if [[ -x "$PARITY_WT/store/lint-ratchet.sh" ]]; then
        [[ -d "$REPO/node_modules" && ! -e "$PARITY_WT/node_modules" ]] \
          && ln -s "$REPO/node_modules" "$PARITY_WT/node_modules" 2>/dev/null
        lint_out="$(bash "$PARITY_WT/store/lint-ratchet.sh" 2>&1)"; lint_rc=$?
        case $lint_rc in
          1) add "fail" "lint-ratchet-regression" \
               "$(printf '%s' "$lint_out" | grep -iE 'worse|->' | head -3 | tr '\n' ' ')" ;;
          3) add "info" "lint-ratchet-unmeasured" "lint-ratchet.sh could not measure the merged tree (harness fault, not a card fact)" ;;
        esac
      fi

      # Importer sweep (card 56344ff4's miss): every src/__tests__/*.test.ts file that imports OR
      # text-scans a changed, non-test src file, run through fleet-test.sh against the MERGED tree.
      # A plain grep on the basename stem, deliberately a SUPERSET of a real import graph -- it
      # catches both `import { x } from '.../stem'` and a source-text pin like
      # agent-extra-channels.test.ts's literal check against a sibling hub file.
      changed_src="$(git -C "$PARITY_WT" diff --name-only "$TRUNK" HEAD -- '*.ts' '*.tsx' 2>/dev/null \
        | grep -vE '\.test\.(ts|tsx)$' | grep -E '^src/' || true)"
      if [[ -n "$changed_src" && -d "$PARITY_WT/src/__tests__" ]]; then
        importers=""
        for f in $changed_src; do
          stem="$(basename "$f")"; stem="${stem%.*}"
          hit="$(grep -lrE "[\"'./]${stem}([\"'.]|$)" "$PARITY_WT/src/__tests__" \
            --include='*.test.ts' --include='*.test.tsx' 2>/dev/null || true)"
          [[ -n "$hit" ]] && importers="${importers}${importers:+$'\n'}${hit}"
        done
        importers="$(printf '%s\n' "$importers" | sed '/^$/d' | sort -u)"
        if [[ -n "$importers" ]]; then
          rel_importers=()
          while IFS= read -r p; do [[ -n "$p" ]] && rel_importers+=("${p#"$PARITY_WT"/}"); done <<< "$importers"
          merge_sha="$(git -C "$PARITY_WT" rev-parse HEAD)"
          sweep_out="$(bash "$REPO/store/fleet-test.sh" --ref "$merge_sha" "${rel_importers[@]}" 2>&1)"
          sweep_rc=$?
          if [[ $sweep_rc -ne 0 ]]; then
            # The importer list itself can run into the hundreds (the sweep is deliberately a wide
            # grep, not a precise import graph) -- the finding names the FAILING file(s) and the
            # vitest "FAIL"/"Tests ... failed" lines, never the full candidate list, which a blind
            # `tail -N` cannot reliably surface once vitest's own trailing perf hint outgrows it.
            fail_lines="$(printf '%s' "$sweep_out" | grep -E '^\s*(FAIL|⎯⎯⎯⎯⎯⎯⎯ Failed Tests|Tests .*failed)' | head -8)"
            add "fail" "importer-sweep-red" \
              "${#rel_importers[@]} importer file(s) swept, at least one red against the merged tree -- $(printf '%s' "$fail_lines" | tr '\n' ' ' | sed 's/^ *//')"
          else
            add "info" "importer-sweep-green" "${#rel_importers[@]} importer test file(s) green against the merged tree"
          fi
        else
          add "info" "importer-sweep-empty" "no src/__tests__ file imports or text-scans the changed src file(s)"
        fi
      fi
    fi
  else
    add "info" "land-parity-skipped" "--trunk '$TRUNK' does not resolve in this repo"
  fi
fi

# --- 7. type-check, scoped to the repo's own command --------------------------------------------
TSC="unknown"
# The repo's OWN tsc, by explicit path -- never `npx --no-install tsc` (card aae6632c). npx resolves
# upward and through its cache, so in a throwaway repo with no node_modules it can find SOME tsc on
# the machine and type-check the fixture against a toolchain the repo does not have. That is how
# this check reported `errors:1` where it should have reported `unavailable`, and it made
# gate-pretriage.test.ts red on develop for anyone whose machine happened to have a resolvable tsc.
TSC_BIN="./node_modules/.bin/tsc"
if [[ -f tsconfig.json ]]; then
  if [[ ! -x "$TSC_BIN" ]]; then
    # No local toolchain: say so instead of type-checking against someone else's compiler.
    TSC="unavailable"
    add "info" "tsc-unavailable" "tsc could not run here (no local toolchain) -- type-check NOT verified"
  else
    # Card aba71f7d: a single FIXED path shared by every invocation was a cross-process race hazard
    # (e.g. concurrent test cases each spawning this script). mktemp gives each invocation its own,
    # created only here (tsc is actually about to run) so the common no-tsconfig/no-local-tsc paths
    # above never leak an unused temp file. Not cleaned up unconditionally: an errors/crash finding
    # below points a human at this exact path ("see $TSC_LOG") for follow-up, so only the clean
    # (nothing to inspect) case removes it.
    TSC_LOG="$(mktemp "${TMPDIR:-/tmp}/gate-pretriage-tsc.XXXXXX.log")"
    if "$TSC_BIN" --noEmit >"$TSC_LOG" 2>&1; then
      TSC="clean"
      rm -f "$TSC_LOG"
    else
      # `grep -c` EXITS 1 when it matches nothing, so `... || echo '?'` emitted BOTH the count and
      # the fallback -- a newline inside the value, which then broke the JSON encoder downstream.
      # Capture with `|| true` and default in the expansion instead.
      _tsc_errs=$(grep -c 'error TS' "$TSC_LOG" 2>/dev/null || true)
      if [[ "${_tsc_errs:-0}" -gt 0 ]]; then
        TSC="errors:${_tsc_errs}"
        add "high" "tsc-errors" "$TSC (see $TSC_LOG)"
      else
        # The local tsc EXISTS and exited non-zero, yet logged no `error TS` line: it crashed, ran
        # out of memory, or rejected its own config. Reporting that as "0 errors, high severity"
        # would be doubly wrong: it invents a code defect AND lets a gate read "tsc: errors:0" as a
        # clean type-check. (The missing-toolchain case is caught above, before tsc runs at all.)
        TSC="unavailable"
        add "info" "tsc-unavailable" "tsc could not run here (no local toolchain) -- type-check NOT verified"
      fi
    fi
  fi
  # A repo whose ROOT tsconfig excludes tests cannot surface a stale fixture via `tsc --noEmit` --
  # UNLESS a SEPARATE project in its typecheck chain covers test files anyway (card b143a439,
  # Cybered's finding). CleanCore's chain (card 2c0b2002) runs packages/control-plane/tsconfig.test.json,
  # packages/modules/workforce/tsconfig.test.json and the root tsconfig.tests.json specifically
  # BECAUSE the root tsconfig.json excludes tests -- so this note fired on EVERY CleanCore card
  # regardless of whether the changed file was already covered by one of those, and a gate (Cybered)
  # had already taken the note as fact once, unverified, and written it into a verdict. If any such
  # project config exists anywhere in the tree, the note has nothing true left to say.
  if ! find . -name 'tsconfig.test.json' -not -path '*/node_modules/*' 2>/dev/null | grep -q . \
     && [[ ! -f tsconfig.tests.json ]]; then
    grep -qE '"\*\*/\*\.test\.ts"' tsconfig.json 2>/dev/null \
      && add "info" "tsc-excludes-tests" \
         "root tsconfig excludes **/*.test.ts -- tsc --noEmit CANNOT see test-file type errors"
  fi
fi

# --- report -------------------------------------------------------------------------------------
if [[ "$JSON" == "1" ]]; then
  BASE="$BASE" HEAD_REF="$HEAD_REF" TSC="$TSC" CHANGED="$CHANGED" \
  FINDINGS="$(printf '%s\n' "${findings[@]+"${findings[@]}"}")" python3 -c '
import json, os
raw = [l for l in os.environ["FINDINGS"].split("\n") if l.strip()]
out = []
for line in raw:
    sev, check, detail = line.split("|", 2)
    out.append({"severity": sev, "check": check, "detail": detail})
print(json.dumps({
    "base": os.environ["BASE"], "head": os.environ["HEAD_REF"],
    "tsc": os.environ["TSC"],
    "changed_files": [f for f in os.environ["CHANGED"].split("\n") if f],
    "findings": out,
    "verdict": None,
    "note": "MECHANICAL PRE-TRIAGE ONLY. Not a gate verdict. A clean report means the cheap traps are clear, not that the card is correct.",
}, indent=2, ensure_ascii=False))'
else
  echo "== gate pre-triage: $BASE..$HEAD_REF =="
  echo "changed files: $(echo "$CHANGED" | grep -c . || echo 0)   tsc: $TSC"
  if [[ ${#findings[@]} -eq 0 ]]; then
    echo "no mechanical findings (cheap traps clear -- NOT a verdict)"
  else
    for f in "${findings[@]}"; do
      IFS='|' read -r sev check detail <<< "$f"
      printf '  [%-4s] %-26s %s\n' "$sev" "$check" "$detail"
    done
  fi
  echo "-- this is INPUT to a gate, not a verdict; the online gate still reviews the change --"
fi

# --- optional advisory local-LLM summary --------------------------------------------------------
if [[ "$EXPLAIN" == "1" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo
  echo "-- ADVISORY local-model summary (DRAFT, not evidence, not a verdict) --"
  # VRAM PRESSURE (card 108c7b10), and the ADVISORY nature is not an exemption -- it is the reason.
  # card f9bad591 settled this for local-llm-rag.sh in so many words: the advisory path calls the
  # SAME local model, so letting it run puts work on exactly the GPU the guard just said is full.
  # "Advisory" describes what the OUTPUT is worth, not what the RUN costs.
  #
  # Missing guard -> skipped (a host that never had a GPU is not doubt); any non-zero exit, usage
  # errors included, skips the summary -- the direction the guard itself documents. Nothing else in
  # this report depends on it: the mechanical findings above are already printed.
  VRAM_GUARD="${PRETRIAGE_VRAM_GUARD:-$HERE/vram-guard-check.sh}"
  vram_rc=0; vram_line=""
  if [[ -f "$VRAM_GUARD" ]]; then
    vram_line="$(bash "$VRAM_GUARD" 2>/dev/null)"; vram_rc=$?
  fi
  # MASTER LOCAL-FIRST-DRAFT SWITCH (card d57d8a01, Peti Telegram 10951), checked alongside the
  # VRAM guard above -- same direction (local model not asked), same reason (advisory-only, never
  # evidence, so skipping it costs nothing this report depends on).
  # shellcheck source=./local-first-draft-check.sh
  . "$HERE/local-first-draft-check.sh"
  if ! local_first_draft_enabled; then
    echo "(local model not asked -- local-first-draft is OFF (dashboard switch); the mechanical report above stands on its own)"
  elif [[ "$vram_rc" -ne 0 ]]; then
    echo "(local model not asked -- ${vram_line:-no output from the vram guard} (rc=$vram_rc); the mechanical report above stands on its own)"
  else
    git diff --stat "$BASE" "$HEAD_REF" 2>/dev/null | tail -40 \
      | "$HERE/local-llm.sh" --task summarize --caller gate-pretriage 2>/dev/null \
      || echo "(local model unavailable -- the mechanical report above stands on its own)"
  fi
fi
exit 0
