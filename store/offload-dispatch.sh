#!/usr/bin/env bash
# offload-dispatch.sh <cardId> [assignee]
#
# DISPATCH-TIME OFFLOAD (Peti 2026-07-30): BEFORE a card is handed to its agent,
# route its mechanical sub-steps to the LOCAL 7B via local-llm-rag.sh --auto and
# attach the drafts to the card as a `local-llm-draft` comment. This makes
# offload STRUCTURAL (MikroB-driven at dispatch), not opt-in on agent goodwill --
# which is exactly why the local model went unused (the router was never on a
# live path). The agent then REVIEWS + integrates the draft instead of writing
# from scratch with online Claude tokens.
#
# It always attempts at least the local card-decompose, so a live invocation
# exercises the local model even for a feature card whose whole is ONLINE.
#
# DRAFT-ONLY: every local output stays draft-only; MikroB + the gate re-check it
# before anything ships (nothing goes live unverified).
#
# Exit 0 always (best-effort, non-blocking dispatch step). No secrets in argv;
# the dashboard token is read at call time from store/.dashboard-token.
#
# AUTHOR IDENTITY (card 3307b428, Cybersec finding on 6f8bba54). The draft comment used to be posted
# as author="mikrob". The DRAFT-ONLY warning was in the body, but the AUTHOR field said orchestrator,
# so every author-keyed consumer read 7B free text as a MikroB decision. The gate sweeps are exactly
# such consumers: they detect an orchestrator directive as author=='mikrob' + a keyword (DONE /
# BLOKKOLVA / KOTOTT) and then drop the card from the sweep. Measured on the live board: 27 of these
# drafts, 8 carrying a trigger word, 1 posted AFTER a REVIEW -- the ordering that actually silently
# ejects a card from its gate. So the drafts post under their OWN author now: model output is never
# signed with the orchestrator's name.
#
# Why `local-llm` and not e.g. `mikrob-offload`: consumers in this codebase match agent identity by
# PREFIX too (is_cybersec_verdict uses author.startswith('cybersec')), so any name beginning with
# "mikrob" would just recreate the confusion one string-compare later.
set -uo pipefail

# The author every locally-drafted comment is signed with. Distinct from EVERY agent id on purpose --
# it is not an agent, it is the local model, and nothing it writes is a decision.
DRAFT_AUTHOR="local-llm"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
TOK="$(cat "$HERE/.dashboard-token" 2>/dev/null || true)"
RAG="$HERE/local-llm-rag.sh"
CARD="${1:-}"
[[ -z "$CARD" ]] && { echo "usage: offload-dispatch.sh <cardId> [assignee]" >&2; exit 2; }

# The single-card GET only accepts the full id; fetch the list and match by id
# prefix so a short (8-char) card id works too.
J="$(curl -s -H "Authorization: Bearer $TOK" "$DASH/api/kanban" 2>/dev/null | CID="$CARD" python3 -c '
import json,os,sys
cid=os.environ["CID"]
try:
    d=json.load(sys.stdin); cards=d if isinstance(d,list) else d.get("cards",[])
    c=next((x for x in cards if str(x.get("id","")).startswith(cid)), None)
    print(json.dumps(c or {}))
except Exception:
    print("{}")' 2>/dev/null)"
TITLE="$(printf '%s' "$J" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("title",""))
except Exception: print("")' 2>/dev/null)"
DESC="$(printf '%s' "$J" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("description",""))
except Exception: print("")' 2>/dev/null)"
ASSIGNEE="${2:-$(printf '%s' "$J" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("assignee","mikrob") or "mikrob")
except Exception: print("mikrob")' 2>/dev/null)}"
[[ -z "${TITLE// }" ]] && { echo "offload-dispatch: card $CARD not found/empty -> skip"; exit 0; }
TASK="$TITLE

$DESC"

DRAFTS=""
add_draft() { DRAFTS+="#### $1"$'\n'"$2"$'\n\n'; }

# 1) Whole-card route: small/mechanical cards draft as-is; features fall through.
WHOLE="$("$RAG" --auto --agent "$ASSIGNEE" --source dispatch-offload "$TASK" 2>/dev/null)"
rc=$?
if [[ $rc -eq 0 && -n "${WHOLE// }" ]]; then
  add_draft "Teljes kartya (local draft)" "$WHOLE"
else
  # 2) Non-offloadable as a whole -> decompose LOCALLY (a local call in itself),
  #    then draft each mechanical, local-eligible subtask on the 7B.
  DECOMP="$("$RAG" --task card-decompose --agent "$ASSIGNEE" --source dispatch-offload "$TASK" 2>/dev/null || true)"
  mapfile -t SUBS < <(printf '%s' "$DECOMP" | python3 -c '
import json,sys,re
raw=sys.stdin.read()
m=re.search(r"\{.*\}", raw, re.S)
out=[]
if m:
    try:
        d=json.loads(m.group(0))
        for t in d.get("tasks",[]):
            subs=t.get("subtasks") or []
            for s in subs:
                if isinstance(s,str) and s.strip(): out.append(s.strip())
            if not subs and t.get("task"): out.append(str(t["task"]).strip())
    except Exception: pass
for s in out[:6]: print(s.replace(chr(10)," ").strip())
' 2>/dev/null)
  for s in "${SUBS[@]:-}"; do
    [[ -z "${s// }" ]] && continue
    D="$("$RAG" --auto --agent "$ASSIGNEE" --source dispatch-offload "$s" 2>/dev/null)"
    [[ $? -eq 0 && -n "${D// }" ]] && add_draft "$s" "$D"
  done
fi

if [[ -z "${DRAFTS// }" ]]; then
  echo "offload-dispatch: $CARD -> no local-eligible parts (routed online)"
  exit 0
fi

BODY="[LOCAL-LLM DRAFT | dispatch-offload] A kartya mechanikus reszeinek helyi (7B) draftja. DRAFT-ONLY: MikroB + a gate ujra-ellenorzi, semmi nem megy elesbe vakon. Az ugynok reviewlje es integralja, ne irja ujra Claude-dal.

$DRAFTS"
curl -s -X POST "$DASH/api/kanban/$CARD/comments" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOK" \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"author":sys.argv[1],"content":sys.argv[2]}))' "$DRAFT_AUTHOR" "$BODY")" >/dev/null 2>&1
echo "offload-dispatch: $CARD -> posted local draft(s) [$ASSIGNEE]"
exit 0
