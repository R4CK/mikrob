#!/usr/bin/env bash
# local-llm-rag.sh -- RAG wrapper around local-llm.sh for the fleet offload path.
#
# PURPOSE: when a fleet agent hands a bounded sub-task to the LOCAL model, this
# first retrieves the RELEVANT memory chunks (semantic, salience-ranked) from the
# dashboard memory API and prepends them -- plus any inline context -- so the
# local model works WITH the right project/agent memory instead of blind.
# This is the path fleet agents should use for offload (not bare local-llm.sh),
# per Peti's rule: an offloaded task must carry the proper context + memory.
#
# USAGE:
#   local-llm-rag.sh "task prompt"
#   local-llm-rag.sh --agent backend --k 5 "refactor this helper ..."
#   local-llm-rag.sh --query "calendar sync target" "draft the settings copy"
#   local-llm-rag.sh --context "file: foo.ts; caller passes ctx.tenantId" "..."
#   local-llm-rag.sh --graph-node routeTask --graph-repo /home/neon/marveen "explain this fn"
#                                             # pull graphify code-graph context (card 3646bde7)
#   echo "task" | local-llm-rag.sh --agent qa
#   local-llm-rag.sh --no-shared "..."        # skip cross-agent shared memories
#   local-llm-rag.sh --show-context "..."     # print the assembled context, don't call the model
# Passthrough to local-llm.sh: --task <name>, --system <prompt>, --model <name>.
#
# PRESETS (--task <name>; template lives in store/local-llm-skills/<name>.txt):
#   code        code snippet from an exact spec (RAG + self-repair verify-loop)
#   commit-msg  git diff / change summary -> one Conventional Commits message
#   pr-body     commits or diff -> PR description (Summary / Changes / Test plan)
#   changelog   change summary -> Keep-a-Changelog entries (Added/Changed/Fixed/...)
#   summarize   1-3 sentence factual summary
#   rewrite     clear, concise copy-edit
#   classify    general classifier -> {"label","confidence","reason"} JSON
#   triage      email/message triage -> {"category","reason"} JSON
#   msg-triage  inter-agent message triage -> {"category","urgency","suggested_action"} JSON
#   card-decompose  task -> {"phase","tasks":[{"task","subtasks":[...]}]} work-breakdown JSON
#   daily-log       events/notes -> a concise HU daily-log entry (MikroB voice)
#   morning-brief   email/calendar/news -> a scannable HU morning brief
#   board-reconcile card list -> terse HU board-reconcile summary + next actions
#   tg-draft        a point -> a non-critical HU Telegram message draft (MikroB voice, no auto-send)
#   translate       source text -> translation to a requested language (values only)
#   doc-draft       code/diff/spec -> a markdown documentation draft
#   test-scaffold   function/spec -> a test-file scaffold (happy/edge/error, real assertions)
#   crud-adapter    entity/port spec -> boilerplate CRUD adapter (scope-carrying, no speculative extras)
#   docstring       function/class -> same code with doc-comments added (code unchanged)
#   dep-diff        lockfile/manifest diff -> terse add/remove/upgrade summary, major-bumps flagged
#   pr-review       diff -> first-pass review notes (severity-tagged; a human gate decides)
#   i18n-keys       EN key/value pairs + target locale(s) -> translated pairs (keys + placeholders preserved)
#   regex           described pattern + examples -> a regex + MATCH/NO-MATCH check
#   type-def        sample JSON/usage -> TypeScript type/interface definitions
#   sql-migration   described schema change -> additive forward SQL migration (+down); DRAFT, gate-critical
#   api-client      endpoint spec -> one typed API-client function (with error path)
#   refactor-draft  code + mechanical change -> refactored code, behaviour unchanged
#   code-explain    snippet -> concise plain-language explanation (read-only)
#   error-i18n      raw error -> i18n key + descriptive, no-leak user message (rule 12)
#   env-doc         config/.env sample -> markdown env-var table (names only, no secret values)
#   mermaid         described flow/arch -> a valid mermaid diagram
#   bugfix-draft    failing code + repro -> minimal fix draft; DRAFT, needs repro-test + gate
#   json-transform  JSON + described transform -> resulting JSON
#   schema-validator type/shape -> runtime validator (zod / JSON Schema)
#   sample-data     schema + count -> realistic sample rows for tests/seeds (no real PII)
#   a11y-check      markup -> first-pass WCAG AA findings (QA gate decides)
#   responsive-check CSS/markup -> first-pass responsive findings (rule 13; QA gate decides)
#   release-notes   changelog/commits -> user-facing release notes
#   yaml-config     described pipeline -> valid YAML (CI/compose/k8s)
#   dockerfile      described stack -> Dockerfile draft (no baked secrets)
#   shell-script    described task -> bash script draft (safe defaults)
#   naming          code -> naming suggestions (only where genuinely unclear)
#   action-items    notes/transcript -> markdown action-item checklist
#   cron-expr       plain-language schedule -> cron expression + human read-back
#   user-story      feature + roles -> user stories (role/goal/acceptance); DRAFT, >=5 where warranted
#   acceptance-criteria  story/feature -> Given/When/Then criteria (positive + negative); DRAFT
#   edge-cases      function/spec -> edge cases + failure modes worth testing; DRAFT
#   log-summary     noisy log lines -> terse error/incident digest (grouped, first thing to check); DRAFT
#   keywords        text -> concise keyword/tag list for search/memory (grounded in the text)
#   alt-text        image context -> one concise screen-reader alt string (meaning, not "image of"); DRAFT
#   faq             feature/docs -> short Q&A FAQ pairs (grounded in the input); DRAFT
#   commit-split    diff/change -> suggested logical commit breakdown (Conventional subjects); DRAFT
#   -- Peti-approved batch 2026-08-02 (card 91b68885), module-ceiling stays put:
#   code-review-checklist  diff -> weighted review checklist (bug/error-handling/security/tests/style)
#   migration-plan-draft   schema-change description -> stepwise migration plan (no SQL, rollback steps)
#   api-doc-draft          endpoint/code -> OpenAPI-style doc draft
#   onboarding-doc         module/repo -> short "how to get started" onboarding doc
#   incident-postmortem-draft  incident log/repro -> blameless postmortem draft
#   module-impl     module spec -> full multi-function module (single-file, module-tier); DRAFT
#   class-impl      class spec -> full class with every method; DRAFT
#   state-machine-impl  described transitions -> state machine impl (invalid transition rejected); DRAFT
#   algorithm-impl  bounded algorithm spec -> implementation + complexity comment; DRAFT
#   parser-impl     described grammar -> small parser/tokenizer impl; DRAFT
#   rate-limiter-impl  limiting policy -> rate-limiter/backoff wrapper (fail-closed default); DRAFT
#   validation-pipeline  validation steps -> pipeline collecting ALL failures, not just the first; DRAFT
#   cache-wrapper-impl  cache policy + interface -> cache decorator/wrapper (error path explicit); DRAFT
#   worker-consumer-impl  queue/message shape -> worker/consumer (ack/nack, retry/dead-letter); DRAFT
#   test-suite-full  module/spec -> full test suite (happy/edge/error, real assertions); DRAFT
#   -- Peti-approved batch 2026-08-02 (agent-task-driven): recurring role-agent OUTPUT formatting,
#   never a new fact/number/verdict -- QA/Cybersec/Cybered/jogász/marketing/pénzügy/performance:
#   qa-test-plan    feature/card -> test-plan skeleton (unit/integration/e2e); DRAFT, qa-engineer decides
#   bug-report-draft  repro steps -> structured bug report (title/steps/expected/actual); DRAFT triage
#   finding-writeup   an ALREADY-IDENTIFIED security finding -> formatted report entry; DRAFT, Cybersec/Cybered gate decides
#   retro-notes     raw notes -> retro summary (went-well/went-wrong/action-items); DRAFT
#   standup-update  raw progress notes -> short Done/Doing/Blocked status; DRAFT
#   pricing-comparison-draft  tier/feature/number input -> pricing comparison table; DRAFT, finance-officer decides
#   unit-economics-summary  ALREADY-COMPUTED CAC/LTV/burn numbers -> narrative summary; DRAFT, never computes new numbers
#   gtm-plan-draft  feature/product description -> go-to-market plan skeleton; DRAFT, marketing-strategist decides
#   landing-copy-draft  feature/product description -> landing-page copy skeleton (headline/subhead/CTA); DRAFT
#   legal-summary   contract/clause text -> plain-language summary; NEVER drafts new legal wording or opinion
#   perf-summary    ALREADY-MEASURED before/after perf numbers -> narrative summary; DRAFT, never measures new numbers
# These offload work that today burns online Claude tokens; drafts are draft-only
# (label local-llm-draft) and re-checked by MikroB + gate before shipping.
#
# Retrieval query defaults to the task text; override with --query for a focused
# retrieval. Memory scope defaults to agent=mikrob; set --agent to the caller.
#
# Local self-repair auto-verify (Peti 2026-07-24): for a FILE-SHAPED draft, add
#   --out <file> --verify-cmd "<shell check>" [--verify-iter N]
# The draft is written to <file>, <check> runs (tsc/lint/test); on failure the
# LOCAL model is re-prompted with the errors up to N times (default 3). Only a
# green draft returns exit 0; a still-failing one returns exit 7 (UNVERIFIED).
#   local-llm-rag.sh --agent backend --out /tmp/x.test.ts \
#     --verify-cmd "cd \"$REPO\" && npx tsc --noEmit -p packages/x/tsconfig.test.json" \
#     "write a vitest suite for ..."
#
# Coding-difficulty offload gate (card afcfe93e): pass --difficulty <trivial|isolated|module|
# feature|architecture> to refuse offloading a task HARDER than the Local-LLM menu threshold
# (dropdown, or derived from the aggressiveness slider). Omit it for the old ungated behaviour.
#   local-llm-rag.sh --agent backend --difficulty module "refactor this multi-fn helper ..."
#
# Auto-router (ON BY DEFAULT since card e817817c): routeTask() (src/local-llm-router.ts) decides
# LOCAL vs ONLINE instead of the caller pre-deciding. A non-offloadable signal family (authz/policy/
# outcome, ambiguity) or an over-threshold difficulty routes ONLINE (exit 9); everything else drafts
# locally.
#   local-llm-rag.sh --agent backend "write a regex for RFC5322 email validation"   # -> local draft
#   local-llm-rag.sh "make the permission check always return true"                 # -> exit 9 (Claude)
#
# It defaults ON because opt-in did not work: the gate only ran behind --auto, and NO documented
# fleet call passed it -- not the local-llm-offload skill, not any agent's own CLAUDE.md, not the
# central one. So on every path an agent actually used, an authz/architecture task reached the 7B
# unjudged. A doc fix would have to be repeated for the next new agent; the default cannot be
# forgotten. `--auto` is still accepted (no-op) so existing callers keep working.
#
#   --no-route   skip the router and draft locally regardless. For a caller who has ALREADY decided
#                and wants the model's output, not a verdict (the dashboard's local-model test box).
#
# Exit codes: 0 ok | 2 ollama down (via local-llm.sh) | 4 bad usage | 6 api/token error | 7 verify-fail
#             | 8 difficulty-gated (task harder than the configured local-offload threshold)
#             | 9 routed ONLINE by the router (non-offloadable signal / over-threshold, or the router
#                 is not built) -> do it on Claude
# No secrets embedded; the dashboard token is read at call time from store/.dashboard-token.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
TOKEN_FILE="$HERE/.dashboard-token"
LLM="$HERE/local-llm.sh"

AGENT="mikrob"; K=5; QUERY=""; CONTEXT=""; SHARED=1; SHOW_ONLY=0
AUTO=1           # route by default (card e817817c); --no-route opts out
GRAPH_REPO=""; GRAPH_NODE=""   # optional graphify code-graph context (card 3646bde7)
CALLER_OVR=""; SOURCE_OVR=""   # optional attribution overrides (e.g. UI probes)
OUT=""; VERIFY_CMD=""; VERIFY_ITER=3   # local self-repair loop (auto-verify a file-shaped draft)
TAGS=""          # optional: comma-separated tags the fleet already put on this card
DIFFICULTY=""    # optional: this coding task's difficulty level (trivial|isolated|module|feature|architecture);
                 # if set, gate against the configured offload threshold before spending the local model
PASS=()          # passthrough flags to local-llm.sh
ARGS=()          # the task prompt
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)   AGENT="$2"; shift 2 ;;
    --difficulty) DIFFICULTY="$2"; shift 2 ;;
    --tags)    TAGS="$2"; shift 2 ;;   # comma-separated card tags, passed to the router as DATA (card 5f0e7aa5)
    --k)       K="$2"; shift 2 ;;
    --query)   QUERY="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --graph-repo) GRAPH_REPO="$2"; shift 2 ;;
    --graph-node) GRAPH_NODE="$2"; shift 2 ;;
    --no-shared) SHARED=0; shift ;;
    --show-context) SHOW_ONLY=1; shift ;;
    --auto)    AUTO=1; shift ;;   # accepted for compatibility; routing is the default now
    --no-route) AUTO=0; shift ;;
    --caller)  CALLER_OVR="$2"; shift 2 ;;
    --source)  SOURCE_OVR="$2"; shift 2 ;;
    --task)    PASS+=(--task "$2"); shift 2 ;;
    --log-task) PASS+=(--log-task "$2"); shift 2 ;;   # usage-log label only (card ea3e4270)
    --system)  PASS+=(--system "$2"); shift 2 ;;
    --model)   PASS+=(--model "$2"); shift 2 ;;
    --out)     OUT="$2"; shift 2 ;;
    --verify-cmd) VERIFY_CMD="$2"; shift 2 ;;
    --verify-iter) VERIFY_ITER="$2"; shift 2 ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    --) shift; while [[ $# -gt 0 ]]; do ARGS+=("$1"); shift; done ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

# ONCE THE ROUTER HAS SPOKEN, NOTHING DOWNSTREAM MAY CHANGE THE ANSWER (card ee43a6ac). In advisory
# mode the run continues past the routing decision only to produce a draft, so every later failure --
# no dashboard token, memory API down, graph context unavailable, an unexpected non-zero anywhere --
# must still end in the exit code the router chose. Measured, not theoretical: the first cut let the
# run fall through to memory retrieval, and on a box with no token an ONLINE task exited 6 instead of
# 9. Two chokepoints rather than one promise: die() below, and an ERR trap for whatever does not go
# through die().
die() {
  if [[ -n "${ADVISORY_REASON:-}" ]]; then
    echo "local-llm-rag: advisory draft unavailable ($2) -- nothing changes, this task is ONLINE" >&2
    exit 9
  fi
  echo "local-llm-rag: $2" >&2; exit "$1";
}
trap 'code=$?; if [[ -n "${ADVISORY_REASON:-}" ]]; then echo "local-llm-rag: advisory path failed after the routing decision (exit $code) -- nothing changes, this task is ONLINE" >&2; exit 9; fi' ERR

# --- ADVISORY-ONLY DRAFT ON AN ONLINE VERDICT (card ee43a6ac) ------------------------------------
# Until now an ONLINE verdict produced NOTHING locally: the router said "do this on Claude" and the
# 7B sat idle, so the hardest work was also the work the local model never touched. This path keeps
# the DECISION exactly where it was and moves only the DRAFTING: the local model writes a draft, the
# online agent REVIEWS it instead of starting from an empty file.
#
# THE SAFETY PROPERTY IS THE EXIT CODE, and it is structural rather than promised: an advisory run
# ALWAYS ends in `exit 9`, the same answer the caller got before, so no caller can read a draft as
# permission to skip the online work. Concretely, in advisory mode:
#   * the file-writing self-repair loop is NOT used -- it owns the only exit-0 path in this script,
#     and an unverified security draft must not land on disk where a later step could pick it up as
#     if it had been checked;
#   * --show-context also exits 9, so even the prompt-dump path cannot answer 0 on an online task;
#   * a failed, empty or timed-out draft changes nothing -- the run still ends 9, with one line
#     saying the draft is missing. A local model that is down must not alter routing.
#
# WHAT THIS DOES CHANGE, stated because the first version of this comment did not (card 37756c9c,
# Cybered condition iii). "No gate is weakened" is true of the ROUTING gate and false as a general
# claim: in the vetoed categories -- authz, isolation, security-decision -- the online step's role
# moves from WRITER to REVIEWER, and those are not the same control. A reviewer is systematically
# worse at noticing what is ABSENT: two measured cases on this board (9632b4d6, a missing trust
# dimension; 36d559e5, a missing conflicting-decision test) were omissions a reviewer accepted and a
# writer would have had to invent. So the honest statement is: the decision stays online and the
# routing gate is untouched, but the ONLINE AGENT's job changed, and it is now the agent's
# responsibility to ask "what is missing from this draft" rather than only "is what is here correct".
# That is why the envelope hands over the SPEC first and marks the draft discardable: reading the
# spec before the draft is what keeps the reviewer able to see an omission at all.
# The draft is time-boxed for the same reason: the caller is waiting to do the work itself, and a
# hung 7B must not become a stall on the online path.
#
# WHERE IT DOES NOT RUN, deliberately: when the online verdict says the input is unusable or hedged
# (empty description, ambiguity fail-closed), because a draft written from an ask nobody understood
# is confident noise, and reviewing noise costs more than writing from scratch. Also not on the
# difficulty gate (exit 8): that gate's whole statement is "the model is not reliable at this size",
# so its draft would be the least useful and the most likely to mislead.
#
# DATA FLOW, stated because a gate will ask: this sends the task text to the LOCAL model on this box
# (ollama on 127.0.0.1), which is where every locally-routed task and every stage-1 classification
# already goes. Nothing leaves the machine, and no draft is treated as an answer.
ADVISORY="${LOCAL_LLM_ADVISORY:-1}"                 # 0 turns the draft off; routing is unaffected
ADVISORY_TIMEOUT="${LOCAL_LLM_ADVISORY_TIMEOUT:-120}"
ADVISORY_REASON=""                                  # set = this run is an advisory draft, exit 9

# Route ONLINE. Either exits 9 now, or (advisory) records why and lets the draft path continue.
online() { # $1 = the reason string the caller would have printed
  local reason="$1"
  echo "local-llm-rag: ROUTE=online -> $reason" >&2
  if [[ "$ADVISORY" != "1" ]]; then exit 9; fi
  case "$reason" in
    # The two "we do not know what is being asked" cases -- see above.
    *"empty or non-string description"*|*"ambiguous/hedged"*|*"router not built"*)
      echo "local-llm-rag: advisory draft SKIPPED -- the online reason is that the ask itself is unusable" >&2
      exit 9 ;;
    # A stale build is treated exactly like a missing one (card a3611ecc): nothing CURRENT judged this
    # task, so we do not hand the local model a task that may be the very kind the rebuilt router
    # would have refused. Fix the build and the draft comes back.
    *"stale build"*)
      echo "local-llm-rag: advisory draft SKIPPED -- no current router judged this task; run \`npm run build\`" >&2
      exit 9 ;;
  esac
  ADVISORY_REASON="$reason"
}

# --- gather task prompt (args or stdin) ---
if [[ ${#ARGS[@]} -gt 0 ]]; then
  TASK="${ARGS[*]}"
else
  [[ -t 0 ]] && die 4 "no task prompt (pass as arg or pipe via stdin); see --help"
  TASK="$(cat)"
fi
[[ -z "${TASK// }" ]] && die 4 "empty task prompt"

# --- graphify code-graph context (card 3646bde7) ------------------------------------------------
# Give the LOCAL model real code understanding instead of guesses: pull the deterministic knowledge
# graph's explanation of a node (its neighbours + relations) into the same CONTEXT block the memory
# retrieval already uses. Goes through store/graphify.sh, never the raw CLI, so the allowlist +
# egress gate apply here too (code-only, no LLM pass, no URL fetch). Best-effort: if the graph is
# missing or the node is unknown, the offload proceeds WITHOUT graph context rather than failing --
# a missing graph must never block a draft.
if [[ -n "$GRAPH_NODE" ]]; then
  [[ -n "$GRAPH_REPO" ]] || GRAPH_REPO="$(pwd)"
  if GRAPH_EXPLAIN="$(bash "$HERE/graphify.sh" explain "$GRAPH_REPO" "$GRAPH_NODE" 2>/dev/null)" \
     && [[ -n "${GRAPH_EXPLAIN// }" ]]; then
    CONTEXT="${CONTEXT:+$CONTEXT

}CODE GRAPH (graphify, deterministic AST -- node, neighbours and relations):
$GRAPH_EXPLAIN"
  else
    echo "local-llm-rag: no graph context for '$GRAPH_NODE' (build it: store/graphify.sh build $GRAPH_REPO)" >&2
  fi
fi
[[ -z "$QUERY" ]] && QUERY="$TASK"

# --- AUTO ROUTER (default; --no-route opts out) -------------------------------------------------
# This is the live call-site for the offload router (src/local-llm-router.ts). It runs on EVERY
# invocation unless --no-route is given, because behind a flag it ran on none of them: the gate was
# only reachable via --auto and no documented fleet call passed it (card e817817c).
# Exit 9 = routed online -> the caller should do this one on Claude; any other exit means it fell
# through to the local draft.
#
# A MISSING BUILD ROUTES ONLINE rather than erroring out. The unjudged direction is the dangerous
# one: without the router there is nothing stopping an authz or architecture task from reaching the
# 7B, and "write it on Claude yourself" is always correct, only more expensive. This matches how a
# router EXCEPTION is already handled below (catch -> 'online').
#
# A STALE BUILD IS TREATED THE SAME WAY (card a3611ecc), and for the same reason: an artifact built
# before the source it claims to implement is not a judge, it is a memory of one. Checked in the node
# call below, before the import -- see store/build-freshness.mjs for why the check is not compiled.
if [[ "$AUTO" == "1" ]]; then
  ROUTER="$HERE/../dist/local-llm-router.js"
  if [[ ! -f "$ROUTER" ]]; then
    online "router not built at $ROUTER, nothing can judge this task"
  fi
  VERDICT="$(ROUTER="$ROUTER" FRESH="$HERE/build-freshness.mjs" TASK="$TASK" DIFF="$DIFFICULTY" TAGS="$TAGS" CFG="$HERE/local-llm-offload-active.json" node - <<'NODE'
(async () => {
  const fs = require('fs')
  // A STALE ROUTER IS NOT A ROUTER (card a3611ecc). The verdict below is only worth having if the
  // artifact producing it was built from the source that is on disk now; asked here, in the process
  // that is about to import it, so it costs ~2ms and no extra spawn. Anything other than `fresh` --
  // including "cannot tell" -- goes online, exactly like a missing build.
  const { checkBuildFreshness } = await import(process.env.FRESH)
  const freshness = checkBuildFreshness(process.env.ROUTER)
  if (freshness.status !== 'fresh') {
    // Both wordings contain "stale build" so the advisory-skip case below matches either, but they
    // must not read the same: "cannot tell" is a different fact from "is out of date", and a caller
    // that gets told the wrong one will go looking in the wrong place.
    const what = freshness.status === 'stale' ? 'stale build: ' : 'stale build check inconclusive: '
    process.stdout.write('online\t' + what + freshness.reason)
    return
  }
  let agg = 75
  try { agg = JSON.parse(fs.readFileSync(process.env.CFG, 'utf8')).aggressiveness ?? 75 } catch {}
  const { routeTask } = await import(process.env.ROUTER)
  const input = { description: process.env.TASK || '', aggressiveness: agg }
  const diff = (process.env.DIFF || '').trim()
  if (diff) input.difficulty = diff
  // Tags arrive as DATA, not as text appended to the description (card 5f0e7aa5): a tag must not be
  // something the classifier has to find in prose, and appending it would also let a card's own
  // wording forge one.
  const tags = (process.env.TAGS || '').split(',').map((t) => t.trim()).filter(Boolean)
  if (tags.length) input.tags = tags
  const d = routeTask(input)
  process.stdout.write((d.route || 'online') + '\t' + (d.reason || ''))
})().catch((e) => { process.stdout.write('online\trouter-error: ' + e.message) })
NODE
)"
  ROUTE="${VERDICT%%$'\t'*}"; REASON="${VERDICT#*$'\t'}"
  if [[ "$ROUTE" != "local" ]]; then
    # In advisory mode `online` RETURNS instead of exiting (card ee43a6ac), so everything below --
    # stage 1 and the "drafting on the 7B" line -- must be skipped: those belong to a LOCAL verdict
    # and printing them here would put ROUTE=local in the log of a task that is going online.
    online "keep this on Claude ($REASON)"
  else
  # STAGE 1 (card 05f8d99c): the deterministic rules said LOCAL. Ask the local model whether this is
  # a security/authz DECISION before drafting it.
  #
  # THE SAFETY PROPERTY IS THE POSITION OF THIS BLOCK, not the prompt. It runs ONLY on a `local`
  # verdict and can ONLY flip to `online`. A wrong answer, a hung model, no model at all (first run)
  # or a parse failure all yield UNKNOWN, which changes nothing -- the deterministic verdict stands.
  # So stage 1 can cost an online draft; it cannot open a hole. That is why it is safe to put a 7B
  # in the routing path at all.
  #
  # It exists because five rounds of keyword fixes could not close the class: Cybersec produced five
  # real RBAC questions ("Restrict the payroll export to the finance team", "Give admins the ability
  # to impersonate a user") that name no security noun and no list caught. The classifier's own
  # numbers live in store/route-classify-selftest.sh and are measured at temperature 0 -- the
  # pre-2026-08-14 figures were single draws from a sampling model and were discarded.
  #
  # The guard tests -f, not -x (Cybersec F4): the call below is `bash <script>`, which needs a
  # readable file and not an exec bit. Testing a property the call does not need means a lost exec
  # bit (a copy, a permission change) would silently remove the control while it would still run.
  if [[ "${ROUTE_CLASSIFY:-1}" == "1" && -f "$HERE/route-classify.sh" ]]; then
    TRIAGE="$(bash "$HERE/route-classify.sh" "$TASK" 2>/dev/null || echo UNKNOWN)"
    if [[ "$TRIAGE" == "SECURITY" ]]; then
      online "stage-1 classifier called this a security decision (deterministic rules said: $REASON)"
    fi
    # The verdict is named, not implied. MECHANICAL ("the classifier read it and did not object")
    # and UNKNOWN ("the classifier could not answer -- no model, timeout, parse failure") are very
    # different states, and printing the same line for both is how a broken control stays invisible.
    echo "local-llm-rag: ROUTE=local -> stage 1 verdict=$TRIAGE ($REASON)" >&2
  else
    # Cybersec F5: say WHICH state this is. A disabled stage 1 used to print the same line as a
    # stage 1 that ran and passed, so a log could not tell "the control cleared it" from "the
    # control was off".
    echo "local-llm-rag: ROUTE=local -> stage 1 DISABLED (ROUTE_CLASSIFY=${ROUTE_CLASSIFY:-1}, classifier present: $( [ -f "$HERE/route-classify.sh" ] && echo yes || echo no ))" >&2
  fi
  echo "local-llm-rag: ROUTE=local -> drafting on the 7B ($REASON)" >&2
  # fall through to the normal local RAG draft path below
  fi
fi

# --- coding-difficulty offload gate (card afcfe93e) ---------------------------------------------
# If the caller declares this task's difficulty (--difficulty), refuse to spend the local model on
# anything HARDER than the configured threshold. The threshold is the explicit dropdown choice
# (codingDifficultyThreshold) or, if unset, derived from the aggressiveness slider -- mirroring
# defaultDifficultyForAggressiveness() in src/web/routes/local-llm.ts (keep the two tables in sync).
# No --difficulty => no gate (backward-compatible). Exit 8 = difficulty-gated (belongs online).
# Skipped in advisory mode (card ee43a6ac): the routing decision has already been made and printed,
# and this gate can only re-state it as `die 8` -- which would throw away the draft we came here for
# without changing where the work happens.
if [[ -z "$ADVISORY_REASON" && -n "$DIFFICULTY" ]]; then
  GATE="$(DIFFICULTY="$DIFFICULTY" CFG="$HERE/local-llm-offload-active.json" python3 - <<'PY'
import json, os, sys
LEVELS = ['trivial', 'isolated', 'module', 'feature', 'architecture']
CEILING = 'feature'  # offload ceiling: architecture never offloads (mirror local-llm.ts, Peti 2026-08-07)
def default_for(a):
    try: a = int(round(float(a)))
    except Exception: a = 75
    a = max(0, min(100, a))
    if a >= 95: return 'feature'  # capped at the reliable ceiling, even at 100%
    if a >= 85: return 'module'
    if a >= 75: return 'isolated'
    return 'trivial'
def clamp(level):  # a stored threshold above the ceiling clamps down
    return CEILING if LEVELS.index(level) > LEVELS.index(CEILING) else level
task = (os.environ.get('DIFFICULTY') or '').strip().lower()
if task not in LEVELS:
    print('BAD\t' + '|'.join(LEVELS)); sys.exit(0)
cfg = {}
try:
    with open(os.environ['CFG']) as f: cfg = json.load(f)
except Exception: cfg = {}
thr = cfg.get('codingDifficultyThreshold')
thr = clamp(thr) if thr in LEVELS else default_for(cfg.get('aggressiveness', 75))
allowed = LEVELS.index(task) <= LEVELS.index(thr)
print(('OK' if allowed else 'DENY') + '\t' + thr)
PY
)"
  verdict="${GATE%%$'\t'*}"; info="${GATE#*$'\t'}"
  case "$verdict" in
    BAD)  die 4 "unknown --difficulty '$DIFFICULTY' (allowed: ${info//|/, })" ;;
    DENY)
      case "$DIFFICULTY" in
        architecture)
          die 8 "task difficulty '$DIFFICULTY' is beyond the local 7B's reliable limit (offload ceiling is 'feature') -> it ALWAYS stays ONLINE (Claude)." ;;
        *)
          die 8 "task difficulty '$DIFFICULTY' exceeds the configured local-offload threshold '$info' -> keep this one ONLINE (Claude), or raise the threshold in the Local-LLM menu." ;;
      esac ;;
    OK)   : ;;  # within threshold -> proceed
    *)    die 4 "difficulty gate produced no verdict" ;;
  esac
fi

[[ -f "$TOKEN_FILE" ]] || die 6 "no dashboard token at $TOKEN_FILE"
TOKEN="$(cat "$TOKEN_FILE")"

# --- retrieve relevant memories + assemble context (multi-term recall) ---
# The dashboard q= search narrows as terms are added, so a long task string
# under-recalls. We tokenize the query into salient terms and union the results
# (per-term + whole-query), dedup by id, rank by salience, take top K.
CONTEXT_BLOCK="$(DASH="$DASH" TOKEN="$TOKEN" QUERY="$QUERY" AGENT="$AGENT" K="$K" \
  SHARED="$SHARED" INLINE="$CONTEXT" python3 - <<'PY'
import json, os, re, sys, urllib.parse, urllib.request
DASH=os.environ['DASH']; TOKEN=os.environ['TOKEN']
QUERY=os.environ['QUERY']; AGENT=os.environ['AGENT']
K=int(os.environ.get('K','5')); SHARED=os.environ.get('SHARED','1')=='1'
INLINE=os.environ.get('INLINE','').strip()

STOP=set("the a an and or of to for with vs is are be this that then how what "
         "why when where our your their per not use uses need needs draft short "
         "task about into from on in at it its as by de el la".split())
def terms(q):
    words=[w for w in re.findall(r"[a-zA-Z0-9]{4,}", q.lower()) if w not in STOP]
    seen=[];
    for w in words:
        if w not in seen: seen.append(w)
    return seen[:4]

def fetch(params):
    url=DASH+"/api/memories?"+urllib.parse.urlencode(params)
    req=urllib.request.Request(url, headers={"Authorization":"Bearer "+TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d=json.loads(r.read().decode())
        return d if isinstance(d,list) else d.get('memories', d.get('data', []))
    except Exception as e:
        # Rule 12: a memory-retrieval failure degrades the offload draft (no context) but must NOT be
        # SILENT. Speak the reason on stderr so a degraded run is visible/diagnosable; retrieval is
        # best-effort augmentation, so we still fail-open (empty context) rather than abort the draft.
        print("[local-llm-rag] retrieval degraded (memory API unreachable): %s" % e, file=sys.stderr)
        return []

queries=[QUERY]+terms(QUERY)
by_id={}
for q in queries:
    if not q.strip(): continue
    for m in fetch({"q":q,"agent":AGENT,"limit":K}):
        by_id.setdefault(m.get('id'), m)
if SHARED:
    for q in queries:
        if not q.strip(): continue
        for m in fetch({"q":q,"category":"shared","limit":K}):
            by_id.setdefault(m.get('id'), m)

mems=sorted(by_id.values(), key=lambda m: m.get('salience',0), reverse=True)[:K]
lines=[]
for m in mems:
    c=(m.get('content') or '').strip()
    if not c: continue
    if len(c)>600: c=c[:600].rstrip()+' [...]'
    kw=(m.get('keywords') or '').strip()
    cat=(m.get('category') or '?')
    lines.append(f"- [{cat}] {c}"+(f"  (kw: {kw})" if kw else ""))

out=[]
if lines:
    out.append("RELEVANT MEMORY (retrieved, most-relevant first):")
    out.extend(lines)
if INLINE:
    if out: out.append("")
    out.append("TASK CONTEXT:")
    out.append(INLINE)
print("\n".join(out))
PY
)"

# --- build the enriched prompt ---
if [[ -n "$CONTEXT_BLOCK" ]]; then
  FULL_PROMPT="$CONTEXT_BLOCK

------------------------------------------------------------
TASK (use the memory/context above only if relevant; do not invent facts):
$TASK"
else
  FULL_PROMPT="$TASK"
fi

if [[ "$SHOW_ONLY" -eq 1 ]]; then
  printf '%s\n' "$FULL_PROMPT"
  # An advisory run answers 9 on EVERY path, including this one: --show-context on an online task
  # must not hand back a 0 that a caller could read as "local handled it".
  [[ -n "$ADVISORY_REASON" ]] && exit 9
  exit 0
fi

# --- call the local model via the shared client (attributed as a RAG call) ---
# Caller/source default to the agent + "rag"; a caller may override both (e.g.
# the dashboard quick-test tags itself caller=ui-test source=ui so those probes
# are excludable from the real fleet-usage metric).
CALLER_FINAL="${CALLER_OVR:-$AGENT}"
SOURCE_FINAL="${SOURCE_OVR:-rag}"

call_model() { printf '%s' "$1" | "$LLM" --caller "$CALLER_FINAL" --source "$SOURCE_FINAL" "${PASS[@]}"; }
# drop a single ```lang ... ``` fence so a file-shaped draft is written as raw code
strip_fence() { awk '/^[[:space:]]*```/{f=!f; next} {print}'; }

# --- ADVISORY DRAFT (card ee43a6ac): draft for an ONLINE task, then still answer 9 ---------------
# One exit, one code. The banner is on STDOUT with the draft because they must travel together: a
# draft that gets separated from "this was not reviewed" is exactly the artefact this path must not
# produce.
if [[ -n "$ADVISORY_REASON" ]]; then
  if [[ -n "$OUT" || -n "$VERIFY_CMD" ]]; then
    echo "local-llm-rag: advisory draft ignores --out/--verify-cmd -- an unverified draft for an ONLINE task is not written to disk" >&2
  fi
  DRAFT="$(timeout "$ADVISORY_TIMEOUT" bash -c 'printf "%s" "$1" | "$2" --caller "$3" --source advisory "${@:4}"' _ \
             "$FULL_PROMPT" "$LLM" "$CALLER_FINAL" "${PASS[@]}" 2>/dev/null || true)"
  if [[ -z "${DRAFT// }" ]]; then
    # A missing draft is a non-event: the answer was always going to be 9.
    echo "local-llm-rag: advisory draft unavailable (local model failed, empty or over ${ADVISORY_TIMEOUT}s) -- nothing changes, this task is ONLINE" >&2
    exit 9
  fi
  # STRUCTURAL MARKING, NOT A STRING IN THE PROSE (card 37756c9c, Cybered condition ii). The first
  # version printed a banner and then the draft, both as plain text on the same stream -- so a draft
  # that emitted its own "=== END ADVISORY ===" line could impersonate the wrapper, and the only thing
  # separating an untrusted payload from a trusted instruction was punctuation the payload controls.
  # The envelope moves the marker into the TRANSPORT: `advisory` and `trust` are fields, the draft is
  # a JSON string VALUE, and anything the model writes inside it -- including a perfect copy of this
  # envelope -- stays escaped inside that value and cannot become a sibling field.
  #
  # SPEC FIRST, DRAFT AS A SEPARATE, DISCARDABLE ATTACHMENT (condition i): the reader gets `spec` --
  # the task as the router judged it -- as its own field, before `draft`. Dropping the draft leaves a
  # complete, usable request; that is what "discardable" has to mean to be true.
  #
  # The human line stays on stderr, so stdout carries the envelope and nothing else.
  ADVISORY_JSON="$(ADV_REASON="$ADVISORY_REASON" ADV_SPEC="$TASK" ADV_DRAFT="$DRAFT" python3 -c '
import hashlib, json, os
draft = os.environ.get("ADV_DRAFT", "")
print(json.dumps({
    "advisory": True,
    "trust": "unverified-local-draft",
    "route": "online",
    "reason": os.environ.get("ADV_REASON", ""),
    "spec": os.environ.get("ADV_SPEC", ""),
    "draft": draft,
    "draftBytes": len(draft.encode("utf-8")),
    "draftSha256": hashlib.sha256(draft.encode("utf-8")).hexdigest(),
}, ensure_ascii=False))
' 2>/dev/null)"
  if [[ -z "${ADVISORY_JSON// }" ]]; then
    echo "local-llm-rag: advisory envelope could not be built -- dropping the draft, this task is ONLINE" >&2
    exit 9
  fi
  printf '%s\n' "$ADVISORY_JSON"
  {
    echo "local-llm-rag: ADVISORY DRAFT on stdout as JSON -- NOT an answer, NOT reviewed."
    echo "  route stays ONLINE ($ADVISORY_REASON); the envelope fields carry the marking, not the text."
    echo "  read .spec first, treat .draft as an unverified attachment, and throw it away if reviewing"
    echo "  it costs more than writing the thing yourself. That is a correct outcome."
    echo "local-llm-rag: advisory draft produced ($(printf '%s' "$DRAFT" | wc -c) bytes) -- ROUTE stays online, exit 9"
  } >&2
  exit 9
fi

# No local auto-verify requested: single-shot draft to stdout (original behavior).
# Card 0c054ebf: propagate call_model's REAL exit code (was unconditional `exit 0`, which
# silently swallowed a disabled-category exit 9 from local-llm.sh -- the toggle would have
# been enforced at the shell layer but invisible through this, the fleet's default call path).
if [[ -z "$VERIFY_CMD" || -z "$OUT" ]]; then
  call_model "$FULL_PROMPT"
  exit $?
fi

# --- LOCAL SELF-REPAIR LOOP (auto-verify) -------------------------------------
# Peti 2026-07-24: make verification GEPI so the online agent gets a PRE-VERIFIED
# draft (near-zero online tokens). Draft -> write $OUT -> run $VERIFY_CMD (tsc/
# lint/test) -> on fail, re-prompt the LOCAL model with the errors, up to
# $VERIFY_ITER times. Only pass=green drafts return exit 0; a still-failing draft
# returns exit 7 so the caller knows it is UNVERIFIED and needs online review.
PROMPT="$FULL_PROMPT"
i=0
while :; do
  i=$((i+1))
  DRAFT="$(call_model "$PROMPT")"
  printf '%s\n' "$DRAFT" | strip_fence > "$OUT"
  if VOUT="$(bash -c "$VERIFY_CMD" 2>&1)"; then
    printf '%s\n' "$DRAFT"
    echo "local-llm-rag: VERIFY PASS on iter $i (wrote $OUT, check: $VERIFY_CMD)" >&2
    exit 0
  fi
  if [[ "$i" -ge "$VERIFY_ITER" ]]; then
    printf '%s\n' "$DRAFT"
    { echo "local-llm-rag: VERIFY FAIL after $i iters -- draft UNVERIFIED, needs online review. Last errors:";
      printf '%s\n' "$VOUT" | tail -20; } >&2
    exit 7
  fi
  echo "local-llm-rag: verify failed (iter $i/$VERIFY_ITER), re-prompting local model with errors" >&2
  PROMPT="$FULL_PROMPT

------------------------------------------------------------
Your previous draft was written to $OUT and FAILED this check: $VERIFY_CMD
Fix ALL of these errors; return the COMPLETE corrected file, CODE ONLY, no prose:
$(printf '%s' "$VOUT" | tail -40)"
done
