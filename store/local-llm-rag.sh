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
# Exit codes: 0 ok | 2 ollama down (via local-llm.sh) | 4 bad usage | 6 api/token error
# No secrets embedded; the dashboard token is read at call time from store/.dashboard-token.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
TOKEN_FILE="$HERE/.dashboard-token"
LLM="$HERE/local-llm.sh"

AGENT="mikrob"; K=5; QUERY=""; CONTEXT=""; SHARED=1; SHOW_ONLY=0
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
    --task)    PASS+=(--task "$2"); shift 2 ;;
    --system)  PASS+=(--system "$2"); shift 2 ;;
    --model)   PASS+=(--model "$2"); shift 2 ;;
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
import json, os, re, urllib.parse, urllib.request
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
    except Exception:
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

# --- call the local model via the shared client ---
printf '%s' "$FULL_PROMPT" | "$LLM" "${PASS[@]}"
