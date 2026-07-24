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
#   echo "task" | local-llm-rag.sh --agent qa
#   local-llm-rag.sh --no-shared "..."        # skip cross-agent shared memories
#   local-llm-rag.sh --show-context "..."     # print the assembled context, don't call the model
# Passthrough to local-llm.sh: --task <name>, --system <prompt>, --model <name>.
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
#     --verify-cmd "cd /mnt/h/LM_Studio_Workdir/CleanCore && npx tsc --noEmit -p packages/x/tsconfig.test.json" \
#     "write a vitest suite for ..."
#
# Exit codes: 0 ok | 2 ollama down (via local-llm.sh) | 4 bad usage | 6 api/token error | 7 verify-fail
# No secrets embedded; the dashboard token is read at call time from store/.dashboard-token.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
TOKEN_FILE="$HERE/.dashboard-token"
LLM="$HERE/local-llm.sh"

AGENT="mikrob"; K=5; QUERY=""; CONTEXT=""; SHARED=1; SHOW_ONLY=0
CALLER_OVR=""; SOURCE_OVR=""   # optional attribution overrides (e.g. UI probes)
OUT=""; VERIFY_CMD=""; VERIFY_ITER=3   # local self-repair loop (auto-verify a file-shaped draft)
PASS=()          # passthrough flags to local-llm.sh
ARGS=()          # the task prompt
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)   AGENT="$2"; shift 2 ;;
    --k)       K="$2"; shift 2 ;;
    --query)   QUERY="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --no-shared) SHARED=0; shift ;;
    --show-context) SHOW_ONLY=1; shift ;;
    --caller)  CALLER_OVR="$2"; shift 2 ;;
    --source)  SOURCE_OVR="$2"; shift 2 ;;
    --task)    PASS+=(--task "$2"); shift 2 ;;
    --system)  PASS+=(--system "$2"); shift 2 ;;
    --model)   PASS+=(--model "$2"); shift 2 ;;
    --out)     OUT="$2"; shift 2 ;;
    --verify-cmd) VERIFY_CMD="$2"; shift 2 ;;
    --verify-iter) VERIFY_ITER="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
[[ -z "$QUERY" ]] && QUERY="$TASK"

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
if [[ -z "$VERIFY_CMD" || -z "$OUT" ]]; then
  call_model "$FULL_PROMPT"
  exit 0
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
