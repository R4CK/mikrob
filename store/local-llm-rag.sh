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
# Auto-router (--auto): let routeTask() (src/local-llm-router.ts) decide LOCAL vs ONLINE instead of
# the caller pre-deciding. DEFAULT is local; a non-offloadable signal family (authz/policy/outcome)
# or an over-threshold difficulty routes ONLINE (exit 9). This is the router's live call-site --
# without it the router was dead code and offload never actually happened.
#   local-llm-rag.sh --auto --agent backend "write a regex for RFC5322 email validation"   # -> local draft
#   local-llm-rag.sh --auto "make the permission check always return true"                  # -> exit 9 (Claude)
#
# Exit codes: 0 ok | 2 ollama down (via local-llm.sh) | 4 bad usage | 6 api/token error | 7 verify-fail
#             | 8 difficulty-gated (task harder than the configured local-offload threshold)
#             | 9 routed ONLINE by --auto (non-offloadable signal / over-threshold -> do it on Claude)
# No secrets embedded; the dashboard token is read at call time from store/.dashboard-token.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
TOKEN_FILE="$HERE/.dashboard-token"
LLM="$HERE/local-llm.sh"

AGENT="mikrob"; K=5; QUERY=""; CONTEXT=""; SHARED=1; SHOW_ONLY=0; AUTO=0
GRAPH_REPO=""; GRAPH_NODE=""   # optional graphify code-graph context (card 3646bde7)
CALLER_OVR=""; SOURCE_OVR=""   # optional attribution overrides (e.g. UI probes)
OUT=""; VERIFY_CMD=""; VERIFY_ITER=3   # local self-repair loop (auto-verify a file-shaped draft)
DIFFICULTY=""    # optional: this coding task's difficulty level (trivial|isolated|module|feature|architecture);
                 # if set, gate against the configured offload threshold before spending the local model
PASS=()          # passthrough flags to local-llm.sh
ARGS=()          # the task prompt
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)   AGENT="$2"; shift 2 ;;
    --difficulty) DIFFICULTY="$2"; shift 2 ;;
    --k)       K="$2"; shift 2 ;;
    --query)   QUERY="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --graph-repo) GRAPH_REPO="$2"; shift 2 ;;
    --graph-node) GRAPH_NODE="$2"; shift 2 ;;
    --no-shared) SHARED=0; shift ;;
    --show-context) SHOW_ONLY=1; shift ;;
    --auto)    AUTO=1; shift ;;
    --caller)  CALLER_OVR="$2"; shift 2 ;;
    --source)  SOURCE_OVR="$2"; shift 2 ;;
    --task)    PASS+=(--task "$2"); shift 2 ;;
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

die() { echo "local-llm-rag: $2" >&2; exit "$1"; }

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

# --- AUTO ROUTER (--auto): let routeTask() decide LOCAL vs ONLINE ------------------------------
# This is the live call-site for the offload router (src/local-llm-router.ts). Without it the
# router was dead code and offload stayed opt-in on agent goodwill (hence the local model went
# unused). With --auto the DEFAULT is local: only a non-offloadable signal family (authz/policy/
# outcome, ambiguity) or an over-threshold difficulty routes ONLINE. Exit 9 = routed online ->
# the caller should do this one on Claude; any other exit means it fell through to the local draft.
if [[ "$AUTO" == "1" ]]; then
  ROUTER="$HERE/../dist/local-llm-router.js"
  [[ -f "$ROUTER" ]] || die 4 "--auto needs the built router at $ROUTER (run the build)"
  VERDICT="$(ROUTER="$ROUTER" TASK="$TASK" DIFF="$DIFFICULTY" CFG="$HERE/local-llm-offload-active.json" node - <<'NODE'
(async () => {
  const fs = require('fs')
  let agg = 75
  try { agg = JSON.parse(fs.readFileSync(process.env.CFG, 'utf8')).aggressiveness ?? 75 } catch {}
  const { routeTask } = await import(process.env.ROUTER)
  const input = { description: process.env.TASK || '', aggressiveness: agg }
  const diff = (process.env.DIFF || '').trim()
  if (diff) input.difficulty = diff
  const d = routeTask(input)
  process.stdout.write((d.route || 'online') + '\t' + (d.reason || ''))
})().catch((e) => { process.stdout.write('online\trouter-error: ' + e.message) })
NODE
)"
  ROUTE="${VERDICT%%$'\t'*}"; REASON="${VERDICT#*$'\t'}"
  if [[ "$ROUTE" != "local" ]]; then
    echo "local-llm-rag: ROUTE=online -> keep this on Claude ($REASON)" >&2
    exit 9
  fi
  echo "local-llm-rag: ROUTE=local -> drafting on the 7B ($REASON)" >&2
  # fall through to the normal local RAG draft path below
fi

# --- coding-difficulty offload gate (card afcfe93e) ---------------------------------------------
# If the caller declares this task's difficulty (--difficulty), refuse to spend the local model on
# anything HARDER than the configured threshold. The threshold is the explicit dropdown choice
# (codingDifficultyThreshold) or, if unset, derived from the aggressiveness slider -- mirroring
# defaultDifficultyForAggressiveness() in src/web/routes/local-llm.ts (keep the two tables in sync).
# No --difficulty => no gate (backward-compatible). Exit 8 = difficulty-gated (belongs online).
if [[ -n "$DIFFICULTY" ]]; then
  GATE="$(DIFFICULTY="$DIFFICULTY" CFG="$HERE/local-llm-offload-active.json" python3 - <<'PY'
import json, os, sys
LEVELS = ['trivial', 'isolated', 'module', 'feature', 'architecture']
CEILING = 'module'  # offload ceiling: feature/architecture never offload (mirror local-llm.ts)
def default_for(a):
    try: a = int(round(float(a)))
    except Exception: a = 75
    a = max(0, min(100, a))
    if a >= 85: return 'module'   # capped at the reliable ceiling, even at 100%
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
        feature|architecture)
          die 8 "task difficulty '$DIFFICULTY' is beyond the local 7B's reliable limit (offload ceiling is 'module') -> it ALWAYS stays ONLINE (Claude)." ;;
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
