#!/usr/bin/env bash
# offload-dispatch.sh <cardId> [assignee]
#
# LEAF-LEVEL OFFLOAD (card 1bf37a35, Peti 2026-08-22, plan-grilling GO-WITH-CHANGES). Previously this
# script classified the WHOLE card (title+description) as one local/online decision in a single
# routeTask --auto call, and if that failed it asked the LOCAL model to invent an EPHEMERAL synthetic
# breakdown of the card ("card-decompose") instead of using the REAL kanban parent_id tree that rule 1
# (Fazis -> Feladat -> alfeladat -> lepes) already produces. A multi-step Feladat card therefore got
# ONE local/online verdict on its whole text, and a subtask that failed once was never retried nor
# permanently given up on -- so a genuinely online-only subtask got re-attempted forever on every sweep
# tick, burning the single-slot GPU queue.
#
# Now: resolve the REAL open (planned/in_progress, non-archived) leaf descendants of $CARD via the
# kanban API's parent_id tree (or $CARD itself, if it has none -- the common case today: measured
# 2026-08-27, 0 of 369 live cards have an OPEN parent with OPEN leaf children, so most calls still hit
# this fallback and behave like the old whole-card path, just with attempt-tracking added). Each leaf
# gets its OWN local-model attempt, with its immediate-ancestor chain (title+description) folded in as
# --context so a terse leaf ("frontend gomb hozzaadasa") is not judged in isolation from the Feladat/
# Fazis that gives it meaning -- a leaf's own text is frequently too thin on its own (grilling finding).
#
# 3-STRIKES PER LEAF (store/offload-attempts.json, flock-protected against offload-batch-run.sh and a
# live dispatch-time call landing on the same leaf concurrently -- the OLD per-$CARD lock below does
# NOT cover this, because a batch call and a direct leaf call take DIFFERENT lock files):
#   - success                          -> status=done, attempts reset to 0.
#   - router says ONLINE (rc=9)        -> NOT a retry-able failure, it is a categorical decision (auth/
#                                          security/multi-file/etc). Attempts jump straight to 3
#                                          ("exhausted"), no wasted retries on a verdict that will not
#                                          change.
#   - transient failure (any non-zero, non-9 exit from local-llm-rag.sh -- Ollama down/timeout/API/
#     verify-fail, its own exit codes 2/4/6/7) -> attempts += 1; at 3, status=
#                                          exhausted and a ONE-TIME INFO-ONLY comment is posted on the
#                                          leaf so a human/agent sees why no draft showed up. The card
#                                          is NEVER blocked by this -- draft-only was always advisory;
#                                          normal dispatch/self-advance carries the leaf online exactly
#                                          as it would if this script did not exist.
#   - exhausted entries expire after 24h (EXHAUSTED_TTL_SECONDS) so a transient Ollama outage does not
#     permanently lock a leaf out of ever trying locally again once the outage clears.
#
# DRAFT-ONLY: every local output stays draft-only; MikroB + the gate re-check it before anything ships.
#
# Exit 0 always (best-effort, non-blocking dispatch step). No secrets in argv; the dashboard token is
# read at call time from store/.dashboard-token.
#
# AUTHOR IDENTITY (card 3307b428, Cybersec finding on 6f8bba54): drafts post under author="local-llm",
# never signed with an agent's own name -- see the fuller history in git blame / DECISIONS.md, the
# rationale is unchanged by this rewrite.
set -uo pipefail

DRAFT_AUTHOR="local-llm"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
TOK="$(cat "$HERE/.dashboard-token" 2>/dev/null || true)"
RAG="$HERE/local-llm-rag.sh"
RESOLVE="$HERE/graphify-resolve.py"

# Max number of leaves given an ACTUAL local-model call in one invocation (GPU is single-slot, `-np 1`,
# no request batching -- card a717d8b5 history). This caps CALLS, not raw enumeration: leaves already
# `done` or `exhausted` in the attempts file are skipped for free (no GPU work) and do NOT consume this
# budget, so the cap always lands on leaves that still have something to try (grilling change #4 -- the
# filter runs before the cut, not after, so a large Feladat does not starve its 16th+ leaf forever).
OFFLOAD_MAX_SUBTASKS="${OFFLOAD_MAX_SUBTASKS:-15}"

ATTEMPTS_FILE="$HERE/offload-attempts.json"
ATTEMPTS_LOCK="$HERE/.offload-attempts.lock"
EXHAUSTED_TTL_SECONDS="${EXHAUSTED_TTL_SECONDS:-86400}"
export ATTEMPTS_FILE EXHAUSTED_TTL_SECONDS

# --- attempts-file helper: every call is flock-serialized on its OWN lock file (not the per-$CARD one
# set up further down), because a batch-run call and a live dispatch-time call for an overlapping leaf
# take different per-$CARD locks but must not race on the SAME leaf's counter. -------------------------
attempts_op() {
  # $1 = check|success|categorical-online|transient-fail   $2 = leafId
  flock "$ATTEMPTS_LOCK" python3 - "$1" "$2" <<'PY'
import json, os, sys, time
path = os.environ["ATTEMPTS_FILE"]
ttl = int(os.environ.get("EXHAUSTED_TTL_SECONDS", "86400"))
op, leaf = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    data = {}
now = int(time.time())
entry = data.get(leaf, {"attempts": 0, "status": "pending", "updated_at": 0})

if op == "check":
    if entry.get("status") == "exhausted" and now - int(entry.get("updated_at", 0)) > ttl:
        entry = {"attempts": 0, "status": "pending", "updated_at": now}
        data[leaf] = entry
elif op == "success":
    entry = {"attempts": 0, "status": "done", "updated_at": now}
    data[leaf] = entry
elif op == "categorical-online":
    entry = {"attempts": 3, "status": "exhausted", "updated_at": now, "reason": "router-online"}
    data[leaf] = entry
elif op == "transient-fail":
    n = int(entry.get("attempts", 0)) + 1
    entry = {"attempts": n, "status": ("exhausted" if n >= 3 else "pending"), "updated_at": now}
    data[leaf] = entry
else:
    sys.exit(2)

tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f)
os.replace(tmp, path)
print(json.dumps(entry))
PY
}

# --- resolve the leaf set: $CARD's open descendants with no open children of their own, or $CARD
# itself if it has none. Also returns, per leaf, its own tags and its ancestor chain (title+desc, up
# to 3 levels up) as context text -- grilling change #1 (a leaf's own text is often too thin alone).
# Takes the kanban card list (the raw /api/kanban response shape) on stdin and CARD from the
# environment, so the exact same code path serves the real curl-fed run AND --test-resolve (a fixture
# file on stdin) -- a test can never drift from what actually runs (mirrors offload-batch-run.sh's
# --test-select pattern). ---------------------------------------------------------------------------
resolve_leaves() {
  CARD="$CARD" python3 -c '
import json, os, re, sys

CARD = os.environ["CARD"]
try:
    data = json.load(sys.stdin)
except Exception:
    print(json.dumps([])); sys.exit(0)
cards = data if isinstance(data, list) else data.get("cards", [])
by_id = {str(c.get("id", "")): c for c in cards}

target = next((c for c in cards if str(c.get("id", "")).startswith(CARD)), None)
if target is None:
    print(json.dumps([])); sys.exit(0)
target_id = str(target["id"])

def is_open(c):
    return c.get("status") in ("planned", "in_progress") and not c.get("archived_at")

if not is_open(target):
    print(json.dumps([])); sys.exit(0)

children_by_parent = {}
for c in cards:
    p = c.get("parent_id")
    if p:
        children_by_parent.setdefault(str(p), []).append(c)

def sort_key(c):
    so = c.get("sort_order")
    return (so if isinstance(so, (int, float)) else 0, str(c.get("id", "")))

def collect_leaves(node_id, seen):
    if node_id in seen:
        return []
    seen = seen | {node_id}
    kids = sorted([c for c in children_by_parent.get(node_id, []) if is_open(c)], key=sort_key)
    if not kids:
        node = by_id.get(node_id)
        return [node] if node else []
    out = []
    for k in kids:
        out.extend(collect_leaves(str(k["id"]), seen))
    return out

leaves, seen_ids = [], set()
for l in collect_leaves(target_id, set()):
    lid = str(l["id"])
    if lid in seen_ids:
        continue
    seen_ids.add(lid)
    leaves.append(l)

def tags_for(c):
    tags = [str((lb or {}).get("name") or "").strip().lstrip("@").upper() for lb in (c.get("labels") or [])]
    lead = re.match(r"^(?:\s*\[[^\]]*\])+", c.get("title") or "")
    if lead:
        tags += [t.strip().upper() for t in re.findall(r"\[([^\]]*)\]", lead.group(0))]
    return ",".join(dict.fromkeys(t for t in tags if t))

def ancestor_context(node_id, depth=3):
    parts, seen_a, cur = [], set(), by_id.get(node_id)
    while cur and cur.get("parent_id") and depth > 0:
        pid = str(cur["parent_id"])
        if pid in seen_a:
            break
        seen_a.add(pid)
        p = by_id.get(pid)
        if not p:
            break
        title = (p.get("title") or "").strip()
        desc = (p.get("description") or "").strip()[:400]
        parts.append(f"{title}\n{desc}")
        cur, depth = p, depth - 1
    return "\n---\n".join(parts)

out = []
for l in leaves:
    out.append({
        "id": str(l["id"]),
        "title": l.get("title") or "",
        "description": l.get("description") or "",
        "assignee": l.get("assignee") or "mikrob",
        "tags": tags_for(l),
        "project": l.get("project") or "",
        "parent_context": ancestor_context(str(l["id"])),
    })
print(json.dumps(out))
' 2>/dev/null
}

# --- test hooks (no network/token/lock needed) ---------------------------------------------------
# --test-resolve: feed a kanban-list JSON fixture on stdin, CARD via env; prints the resolved leaves.
# --test-attempts-op OP LEAF [--file PATH]: exercises the attempts state machine against a scratch file.
if [[ "${1:-}" == "--test-resolve" ]]; then
  resolve_leaves
  exit 0
fi
if [[ "${1:-}" == "--test-attempts-op" ]]; then
  shift
  op="${1:-}"; leaf="${2:-}"; shift 2 2>/dev/null || true
  [[ "${1:-}" == "--file" ]] && { ATTEMPTS_FILE="$2"; export ATTEMPTS_FILE; }
  [[ -z "$op" || -z "$leaf" ]] && { echo "usage: --test-attempts-op OP LEAF [--file PATH]" >&2; exit 2; }
  attempts_op "$op" "$leaf"
  exit 0
fi

CARD="${1:-}"
[[ -z "$CARD" ]] && { echo "usage: offload-dispatch.sh <cardId> [assignee]" >&2; exit 2; }

# PER-CARD IN-FLIGHT LOCK (2026-08-07). Prevents a duplicate concurrent run for the SAME $CARD argument
# (e.g. two sweep ticks firing on the same card id). Does NOT dedup across different ids that resolve
# to overlapping leaves (a parent id vs one of its leaf ids called directly) -- that race is handled by
# the ATTEMPTS_LOCK around every read-modify-write of offload-attempts.json above.
lock_file="/tmp/offload-dispatch-$CARD.lock"
exec 8>"$lock_file"
if ! flock -n 8; then
  echo "offload-dispatch: $CARD -> already in flight (lock held), skipping duplicate"
  exit 0
fi

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): token never in argv, private 0600
# header file, removed on EXIT.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$TOK" > "$hdr_file"

LEAVES_JSON="$(curl -s -H @"$hdr_file" "$DASH/api/kanban" | resolve_leaves)"

if [[ -z "${LEAVES_JSON// }" || "$LEAVES_JSON" == "[]" ]]; then
  echo "offload-dispatch: card $CARD not found/not open/empty -> skip"
  exit 0
fi

LEAF_COUNT="$(printf '%s' "$LEAVES_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
echo "offload-dispatch: $CARD -> $LEAF_COUNT open leaf(s) resolved" >&2

# CODE-GRAPH CONTEXT (card 44477615) -- unchanged mechanism, now resolved per-leaf task text.
graph_repo_for() {
  local project="$1"
  case "$project" in
    MikroB)    (cd "$(git -C "$HERE" rev-parse --git-common-dir 2>/dev/null || echo .)/.." 2>/dev/null && pwd) ;;
    CleanCore) echo "${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}" ;;
  esac
}
graph_args_for() {
  local text="$1" repo="$2" node=""
  [[ -n "$repo" && -f "$repo/graphify-out/graph.json" ]] || return 0
  node="$(printf '%s' "$text" | timeout 30 python3 "$RESOLVE" "$repo" --max 1 2>/dev/null | head -1)"
  [[ -n "${node// }" ]] || return 0
  printf '%s\n%s\n%s\n%s\n' --graph-repo "$repo" --graph-node "$node"
}

post_draft_comment() {
  local leaf_id="$1" leaf_title="$2" content="$3"
  local body="[LOCAL-LLM DRAFT | dispatch-offload] Mechanikus reszek helyi (7B) draftja. DRAFT-ONLY: MikroB + a gate ujra-ellenorzi, semmi nem megy elesbe vakon. Az ugynok reviewlje es integralja, ne irja ujra Claude-dal.

#### $leaf_title
$content
"
  curl -s -X POST "$DASH/api/kanban/$leaf_id/comments" -H "Content-Type: application/json" -H @"$hdr_file" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"author":sys.argv[1],"content":sys.argv[2]}))' "$DRAFT_AUTHOR" "$body")" >/dev/null 2>&1
}

post_exhausted_notice() {
  local leaf_id="$1"
  local body="INFO-ONLY [local-llm offload]: a helyi 7B 3 sikertelen (tranziens) kiserlet utan kimerult ezen a kartyan (pl. Ollama nem volt elerheto). A kartya emiatt NEM blokkolt -- a felelos agens a normal (online) uton viszi tovabb. 24 ora mulva a rendszer automatikusan ujra probalkozik helyben."
  curl -s -X POST "$DASH/api/kanban/$leaf_id/comments" -H "Content-Type: application/json" -H @"$hdr_file" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"author":sys.argv[1],"content":sys.argv[2]}))' "$DRAFT_AUTHOR" "$body")" >/dev/null 2>&1
}

try_leaf() {
  # Caller already ran attempts_op check + skipped done/exhausted leaves before invoking this (the
  # loop's precheck below) -- no need to repeat that read here.
  local leaf_id="$1" leaf_title="$2" leaf_desc="$3" leaf_assignee="$4" leaf_tags="$5" leaf_project="$6" parent_ctx="$7"
  local task="$leaf_title

$leaf_desc"

  local repo; repo="$(graph_repo_for "$leaf_project")"
  local graph=(); mapfile -t graph < <(graph_args_for "$task" "$repo")

  local out rc
  out="$("$RAG" --auto --agent "$leaf_assignee" --source dispatch-offload --log-task subtask-draft \
    --tags "$leaf_tags" --context "$parent_ctx" \
    ${graph[@]+"${graph[@]}"} "$task" 2>/dev/null)"
  rc=$?

  if [[ $rc -eq 0 && -n "${out// }" ]]; then
    attempts_op success "$leaf_id" >/dev/null
    post_draft_comment "$leaf_id" "$leaf_title" "$out"
    echo "offload-dispatch: leaf $leaf_id -> posted local draft"
    return 0
  elif [[ $rc -eq 9 ]]; then
    attempts_op categorical-online "$leaf_id" >/dev/null
    echo "offload-dispatch: leaf $leaf_id -> categorical online (router decision), no retry" >&2
    return 1
  else
    entry="$(attempts_op transient-fail "$leaf_id")"
    local n; n="$(printf '%s' "$entry" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("attempts",0))' 2>/dev/null)"
    echo "offload-dispatch: leaf $leaf_id -> local attempt failed (rc=$rc), attempt ${n:-?}/3" >&2
    if [[ "${n:-0}" -ge 3 ]]; then
      post_exhausted_notice "$leaf_id"
    fi
    return 1
  fi
}

attempted=0
drafted=0
# Fields travel base64-encoded end to end (title/description routinely contain newlines/tabs, which
# would otherwise corrupt `read -r` field splitting) and are only decoded at the point of use.
while IFS=$'\t' read -r b64id b64title b64desc b64assignee b64tags b64project b64ctx; do
  [[ -z "$b64id" ]] && continue
  lid="$(printf '%s' "$b64id" | base64 -d)"
  (( attempted >= OFFLOAD_MAX_SUBTASKS )) && { echo "offload-dispatch: leaf call budget ($OFFLOAD_MAX_SUBTASKS) reached, stopping" >&2; break; }
  # cheap pre-check so an already done/exhausted leaf never consumes the call budget (grilling #4)
  precheck_status="$(attempts_op check "$lid" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status","pending"))' 2>/dev/null)"
  [[ "$precheck_status" == "done" || "$precheck_status" == "exhausted" ]] && continue
  ltitle="$(printf '%s' "$b64title" | base64 -d)"
  ldesc="$(printf '%s' "$b64desc" | base64 -d)"
  lassignee="$(printf '%s' "$b64assignee" | base64 -d)"
  ltags="$(printf '%s' "$b64tags" | base64 -d)"
  lproject="$(printf '%s' "$b64project" | base64 -d)"
  lctx="$(printf '%s' "$b64ctx" | base64 -d)"
  attempted=$(( attempted + 1 ))
  if try_leaf "$lid" "$ltitle" "$ldesc" "$lassignee" "$ltags" "$lproject" "$lctx"; then
    drafted=$(( drafted + 1 ))
  fi
done < <(printf '%s' "$LEAVES_JSON" | python3 -c '
import json, sys, base64
for l in json.load(sys.stdin):
    fields = [l["id"], l["title"], l["description"], l["assignee"], l["tags"], l["project"], l["parent_context"]]
    print("\t".join(base64.b64encode(str(x).encode()).decode() for x in fields))
')

if [[ $drafted -eq 0 ]]; then
  echo "offload-dispatch: $CARD -> no local-eligible parts (routed online)"
  exit 0
fi
echo "offload-dispatch: $CARD -> posted local draft(s) [$drafted/$attempted leaf attempt(s)]"
exit 0
