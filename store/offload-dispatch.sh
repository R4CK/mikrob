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
# 2-STRIKES PER LEAF (store/offload-attempts.json, flock-protected against offload-batch-run.sh and a
# live dispatch-time call landing on the same leaf concurrently -- the OLD per-$CARD lock below does
# NOT cover this, because a batch call and a direct leaf call take DIFFERENT lock files). THRESHOLD
# LOWERED FROM 3 TO 2 (card 501c489f, MikroB verdikt komment 6007, requirement 6) -- only the
# TRANSIENT branch's threshold changed; the categorical-online branch was already a single-call jump
# to exhausted and stays that way, just landing on the new ceiling (OFFLOAD_LEAF_MAX_ATTEMPTS):
#   - success                          -> status=done, attempts reset to 0.
#   - router says ONLINE (rc=9)        -> NOT a retry-able failure, it is a categorical decision (auth/
#                                          security/multi-file/etc). Attempts jump straight to
#                                          OFFLOAD_LEAF_MAX_ATTEMPTS ("exhausted"), no wasted retries on
#                                          a verdict that will not change.
#   - transient failure (any non-zero, non-9 exit from local-llm-rag.sh -- Ollama down/timeout/API/
#     verify-fail, its own exit codes 2/4/6/7) -> attempts += 1; at OFFLOAD_LEAF_MAX_ATTEMPTS (default
#                                          2), status=exhausted and a ONE-TIME INFO-ONLY comment is
#                                          posted on the leaf so a human/agent sees why no draft showed
#                                          up. The card is NEVER blocked by this -- draft-only was
#                                          always advisory; normal dispatch/self-advance carries the
#                                          leaf online exactly as it would if this script did not exist.
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

# DECOMPOSE (card 501c489f, MikroB verdikt komment 6007). Per-card ceiling on SYNTHETIC (not real
# kanban-child) subtasks the deterministic templates in card-decompose-templates.sh may generate for
# a single card in one invocation -- the verdict's own suggested number ("javaslat: max 3"). This is
# separate from OFFLOAD_MAX_SUBTASKS above (the whole-run GPU-call budget across every leaf); the two
# only interact in that a card can never contribute more synthetic leaves than this ceiling, whatever
# the run-wide budget allows elsewhere.
OFFLOAD_DECOMPOSE_MAX_PER_CARD="${OFFLOAD_DECOMPOSE_MAX_PER_CARD:-3}"
# shellcheck source=./card-decompose-templates.sh
. "$HERE/card-decompose-templates.sh"

ATTEMPTS_FILE="$HERE/offload-attempts.json"
ATTEMPTS_LOCK="$HERE/.offload-attempts.lock"
EXHAUSTED_TTL_SECONDS="${EXHAUSTED_TTL_SECONDS:-86400}"
# Card 501c489f, MikroB verdikt komment 6007, requirement 6: 3 -> 2. Only the TRANSIENT-failure
# threshold moves; categorical-online (router says ONLINE) was already a single-call jump straight
# to exhausted and stays that way, just landing on this same new ceiling.
OFFLOAD_LEAF_MAX_ATTEMPTS="${OFFLOAD_LEAF_MAX_ATTEMPTS:-2}"
export ATTEMPTS_FILE EXHAUSTED_TTL_SECONDS OFFLOAD_LEAF_MAX_ATTEMPTS

# --- attempts-file helper: every call is flock-serialized on its OWN lock file (not the per-$CARD one
# set up further down), because a batch-run call and a live dispatch-time call for an overlapping leaf
# take different per-$CARD locks but must not race on the SAME leaf's counter. -------------------------
attempts_op() {
  # $1 = check|success|categorical-online|transient-fail   $2 = leafId
  flock "$ATTEMPTS_LOCK" python3 - "$1" "$2" <<'PY'
import json, os, sys, time
path = os.environ["ATTEMPTS_FILE"]
ttl = int(os.environ.get("EXHAUSTED_TTL_SECONDS", "86400"))
max_attempts = int(os.environ.get("OFFLOAD_LEAF_MAX_ATTEMPTS", "2"))
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
    entry = {"attempts": max_attempts, "status": "exhausted", "updated_at": now, "reason": "router-online"}
    data[leaf] = entry
elif op == "transient-fail":
    n = int(entry.get("attempts", 0)) + 1
    entry = {"attempts": n, "status": ("exhausted" if n >= max_attempts else "pending"), "updated_at": now}
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
        # What the BOARD itself carries, undefaulted. The line above defaults to "mikrob" so the local-model
        # call always has an --agent; that default would otherwise make a leaf with NO assignee
        # indistinguishable from one actually assigned to mikrob, and the draft nudge (card 0b3a3084)
        # has to say which of the two it is.
        "assignee_raw": (l.get("assignee") or "").strip(),
        "tags": tags_for(l),
        "project": l.get("project") or "",
        "parent_context": ancestor_context(str(l["id"])),
        "synthetic": False,
    })
print(json.dumps(out))
' 2>/dev/null
}

# --- DECOMPOSE WRAPPER (card 501c489f) -----------------------------------------------------------
# resolve_leaves() above is UNCHANGED: it still resolves real kanban-child leaves exactly as before
# (root cause 2's own words: "csak VALODI kanban gyerek-levelekre bont"). This wraps it: ONLY when
# resolve_leaves() fell back to the single-leaf "$CARD has no open children, return itself" shape --
# the common case (measured 2026-08-27: 0/369) that root cause 2 names -- does this look for
# DETERMINISTIC mechanical fragments (card-decompose-templates.sh) in that one leaf's own text and,
# if it finds any, REPLACE the single whole-card leaf with N synthetic ones.
#
# THE DECISION PART NEVER GOES LOCAL (requirement 2 of the verdict, verbatim: "A dontesi reszt
# semmilyen ag nem viheti helyire"): when synthetic leaves are produced, the original whole-card leaf
# is DROPPED, not kept alongside them -- the whole point is that the decision-shaped remainder stays
# exactly where it already was (ONLINE, via card-build-route.sh's own verdict, untouched by this
# file), and only the mechanical fragments get a local attempt at all. Zero candidates -> the single
# leaf is returned completely unmodified, so a card with no mechanical shape in its text behaves
# BYTE-IDENTICALLY to before this card (minimal blast radius, rule 3).
#
# A REAL single-open-child card (a Feladat with exactly one open leaf) must NOT be decomposed --
# only checked when that one leaf's id IS the target itself, the same startswith-prefix identity
# resolve_leaves()'s own python already uses to find $CARD.
resolve_leaves_with_decompose() { # stdin = kanban list JSON (same contract as resolve_leaves)
  local raw; raw="$(resolve_leaves)"
  [[ -n "${raw// }" && "$raw" != "[]" ]] || { printf '%s' "$raw"; return; }
  [[ "${CARD_DECOMPOSE:-on}" != "off" ]] || { printf '%s' "$raw"; return; }

  local count; count="$(printf '%s' "$raw" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  [[ "$count" == "1" ]] || { printf '%s' "$raw"; return; }

  local fields; fields="$(printf '%s' "$raw" | python3 -c '
import json, sys, base64
l = json.load(sys.stdin)[0]
fields = [l["id"], l["title"], l["description"], l["assignee"], l["assignee_raw"], l["tags"], l["project"]]
encoded = [base64.b64encode(str(x).encode()).decode() for x in fields]
print("|".join(encoded))
' 2>/dev/null)"
  [[ -n "${fields// }" ]] || { printf '%s' "$raw"; return; }
  IFS='|' read -r b64id b64title b64desc b64assignee b64assignee_raw b64tags b64project <<< "$fields"
  local lid ltitle ldesc lassignee lassignee_raw ltags lproject
  lid="$(printf '%s' "$b64id" | base64 -d)"
  ltitle="$(printf '%s' "$b64title" | base64 -d)"
  ldesc="$(printf '%s' "$b64desc" | base64 -d)"
  lassignee="$(printf '%s' "$b64assignee" | base64 -d)"
  lassignee_raw="$(printf '%s' "$b64assignee_raw" | base64 -d)"
  ltags="$(printf '%s' "$b64tags" | base64 -d)"
  lproject="$(printf '%s' "$b64project" | base64 -d)"

  # Only the fallback shape qualifies: the one leaf resolve_leaves() returned IS $CARD's own target
  # (same prefix-match rule the python above uses -- "startswith", because a card id argument may be
  # a short/typed prefix of the full stored id).
  case "$lid" in
    "$CARD"*) : ;;
    *) printf '%s' "$raw"; return ;;
  esac

  local candidates
  candidates="$(card_decompose_candidates "$ltitle
$ldesc
$ltags" 2>/dev/null | head -n "$OFFLOAD_DECOMPOSE_MAX_PER_CARD")"
  [[ -n "${candidates// }" ]] || { printf '%s' "$raw"; return; }

  REAL_ID="$lid" TITLE="$ltitle" DESC="$ldesc" TAGS="$ltags" ASSIGNEE="$lassignee" \
  ASSIGNEE_RAW="$lassignee_raw" PROJECT="$lproject" \
    python3 -c '
import json, os, sys
cands = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    t, task = line.split("\t", 1)
    cands.append((t, task))
real_id = os.environ["REAL_ID"]
title = os.environ["TITLE"]
desc = os.environ["DESC"]
out = []
for t, task in cands:
    # SAFETY (card 501c489f, requirement 2): local-llm-rag.sh own routeTask classifier reads ONLY
    # this "description" field (folded into task by try_leaf, title+description), NEVER the
    # separate --context value -- --context is prompt grounding only, invisible to routing. A
    # synthetic leaf whose description was JUST the generic template sentence would let routeTask
    # classify on template boilerplate instead of the parent real text, silently defeating "the
    # same steering/security gate the whole card gets" for any risk signal that lives in the
    # parent DESCRIPTION rather than its title (the title is already folded in via title below).
    # So the parent own description rides along here too, clearly delimited so the model still
    # knows to draft ONLY the named fragment, not the whole card.
    out.append({
        "id": f"{real_id}~{t}",
        "title": f"{title} — {t} (mechanikus reszfeladat, card 501c489f)",
        "description": f"{task}\n\n--- eredeti kartya (csak kontextusul -- CSAK a fenti reszfeladatot ird meg, ne a teljes kartyat):\n{desc[:600]}",
        "assignee": os.environ["ASSIGNEE"],
        "assignee_raw": os.environ["ASSIGNEE_RAW"],
        "tags": os.environ["TAGS"],
        "project": os.environ["PROJECT"],
        "parent_context": f"{title}\n{desc[:400]}",
        "synthetic": True,
    })
print(json.dumps(out))
' <<< "$candidates"
}

# --- DRAFT NUDGE (card 0b3a3084) ----------------------------------------------------------------
# The draft arrives ASYNCHRONOUSLY, after the agent was already dispatched. Measured twice on one day
# on one agent (f3757cc7, 90e4cbdf): the agent read the card at dispatch time with zero comments, the
# draft landed later, and nothing looked back -- both times the draft-review guard (1338e68b) caught it
# at the END of the work, when a draft is only an administrative item to adjudicate. Telling the owner
# the moment the comment lands is what makes the offload save tokens DURING the work, which is its
# whole point.
#
# ONE function, both posting sites on purpose: this is one contract with two call sites, and updating
# one of a pair is exactly the class of miss this card was opened for.
#
# NOT SPAM-GUARDED HERE, because the attempts file already does it (pitfall 4): a draft posts only on
# success, and success writes status=done, which the loop's precheck skips on every later sweep --
# permanently, since only `exhausted` entries expire. The exhausted notice fires only on the attempt
# that reaches 3, and that writes status=exhausted, so it can recur at most once per EXHAUSTED_TTL
# (24h) per leaf. Both are already once-per-event; a second counter would only be a second thing to
# get wrong.
#
# from="mikrob" is the fleet's convention for an automated nudge (fleet-nudger.sh does the same), and
# it carries the same disclaiming tag, because the recipient must not read it as the orchestrator
# having looked at their card. The DRAFT COMMENT itself stays author="local-llm" -- card 3307b428 is
# about comment authorship, which the gate sweeps key on; a message is not swept by author.
NUDGE_FROM="mikrob"
NUDGE_TAG="[local-llm offload, automatikus jelzes -- nem MikroB olvasta el a kartyadat]"

# True when the fleet agent currently holds a session. A message to a PARKED agent is ACCEPTED by the
# API (it validates the recipient, not its liveness) and sits pending -- the router delivers it only to
# a live session and abandons it after the window. So a nudge to a parked agent is not an error, it is
# a silent loss, which is the failure this card exists to prevent (pitfall 3). Unknown/unreachable ->
# false, so the fallback below is the safe direction.
agent_is_running() {
  local agent="$1"
  [[ -n "${agent// }" ]] || return 1
  curl -s -H @"$hdr_file" "$DASH/api/agents" 2>/dev/null | AGENT="$agent" python3 -c '
import json, os, sys
want = os.environ["AGENT"]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
agents = data if isinstance(data, list) else data.get("agents", [])
for a in agents:
    if str(a.get("name", "")) == want:
        sys.exit(0 if a.get("running") else 1)
sys.exit(1)
' 2>/dev/null
}

# The routing DECISION, separated from the sending so it can be tested without a board or a session:
# prints "<recipient>\t<prefix note>". Three cases, and the two fallbacks both land on mikrob, who is
# the one agent that never parks itself.
nudge_recipient() {
  # $1 = the assignee the board carries (may be empty)   $2 = 1 when that agent holds a session
  local assignee="$1" running="$2"
  if [[ -z "${assignee// }" ]]; then
    printf 'mikrob\tA kartyanak NINCS felelose (6a. szabaly), ezert ez neked szol. '
  elif [[ "$running" == "1" ]]; then
    printf '%s\t' "$assignee"
  else
    printf 'mikrob\tA kartya felelose (%s) most PARKOLVA van, neki kuldve elveszne. ' "$assignee"
  fi
}

nudge_leaf_owner() {
  # $1 = leaf id   $2 = the assignee the board carries (may be empty)   $3 = draft|exhausted
  local leaf_id="$1" assignee="$2" kind="$3" text="" running=0 to="" note=""

  case "$kind" in
    draft)
      text="Draft erkezett a #$leaf_id kartyara (helyi 7B, offload). Nezd meg, MIELOTT magad megirod -- a draft akkor sporol tokent, ha munka kozben hasznalod, nem ha a vegen biralod el. Amikor vegeztel vele, tegyel a kartyara egy sort (sor elejen): Draft-Review: ELFOGADVA / RESZBEN / ELUTASITVA / FELESLEGES (card 1338e68b; a FELESLEGES azt jelenti, hogy a draft JO volt, csak nem volt ra szukseg -- card 504ec76f)." ;;
    exhausted)
      text="A helyi modell KIMERULT a #$leaf_id kartyan ($OFFLOAD_LEAF_MAX_ATTEMPTS sikertelen tranziens kiserlet), draft NEM fog erkezni. A kartya nincs blokkolva: vidd tovabb a szokasos online uton." ;;
    *) return 0 ;;
  esac

  agent_is_running "$assignee" && running=1
  IFS=$'\t' read -r to note < <(nudge_recipient "$assignee" "$running")

  curl -s -X POST "$DASH/api/messages" -H "Content-Type: application/json" -H @"$hdr_file" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"from":sys.argv[1],"to":sys.argv[2],"content":sys.argv[3]+chr(10)+chr(10)+sys.argv[4]+sys.argv[5]}))' \
      "$NUDGE_FROM" "$to" "$NUDGE_TAG" "$note" "$text")" >/dev/null 2>&1 || true
  return 0
}

# advisory_draft: stdin = local-llm-rag.sh stdout from an exit-9 run. Prints the draft comment body
# (ONLINE-review header + draft) when stdout is an advisory envelope with a non-empty draft, else
# nothing. Pure, so --test-advisory-draft exercises the exact code try_leaf uses.
advisory_draft() {
  python3 -c '
import json, sys
try:
    env = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
if isinstance(env, dict) and env.get("advisory") is True and str(env.get("draft", "")).strip():
    print("ONLINE-VERDIKT (" + str(env.get("reason", "")) + "): KOTELEZO A TELJES, FUGGETLEN ONLINE FELULVIZSGALAT. Olvasd ELOSZOR a kartya specifikaciojat, es azt kerdezd, mi HIANYZIK ebbol a draftbol, ne csak azt, hogy ami benne van, helyes-e. Ha az atnezes dragabb, mint megirni, dobd el (Draft-Review: ELUTASITVA) -- ez helyes kimenet.")
    print()
    print(env["draft"])
' 2>/dev/null
}

# draft_comment_body: pure (no network), so --test-draft-comment-body can exercise the exact text a
# real run posts. $3 = synthetic ("true"/"false", optional): a decomposed mechanical-fragment draft
# (card 501c489f) carries the SAME mandatory-full-review wording advisory_draft() above already uses
# for a router-ONLINE advisory draft (requirement 2 of the verdikt: "a kotelezo TELJES online
# felulvizsgalat jelolese megmarad"). Unconditional for every synthetic leaf, not just the ones whose
# OWN narrow text would separately trigger a security gate -- a synthetic leaf only exists because
# its PARENT already matched a deterministic ONLINE gate (the decompose-eligible set), so the
# parent's own decision-worthiness is exactly why the reviewer must not skim this one.
draft_comment_body() { # $1 = leaf_title, $2 = content, $3 = synthetic ("true"/"false", optional)
  local leaf_title="$1" content="$2" synthetic="${3:-false}"
  local review_header=""
  if [[ "$synthetic" == "true" ]]; then
    review_header="MECHANIKUS RESZFELADAT (card 501c489f) egy olyan kartyabol, aminek a DONTESI resze online marad -- KOTELEZO A TELJES, FUGGETLEN ONLINE FELULVIZSGALAT, ne csak a draft belsejet nezd, hanem azt is, mi HIANYZIK belole a kartya teljes specifikaciojahoz kepest.

"
  fi
  printf '%s[LOCAL-LLM DRAFT | dispatch-offload] Mechanikus reszek helyi (7B) draftja. DRAFT-ONLY: MikroB + a gate ujra-ellenorzi, semmi nem megy elesbe vakon. Az ugynok reviewlje es integralja, ne irja ujra Claude-dal. AMIKOR VEGEZTEL VELE, tegyel a kartyara egy sort (sor elejen): '"'"'Draft-Review: ELFOGADVA'"'"' / '"'"'RESZBEN'"'"' / '"'"'ELUTASITVA'"'"' / '"'"'FELESLEGES'"'"' -- e nelkul a kartya nem mehet waiting-be (card 1338e68b). Mind a negy elfogadhato; a lenyeg, hogy a draft ne menjen at elbiralatlanul. A FELESLEGES arra valo, amikor a draft JO volt, de nem vettel at belole semmit (tipikusan mert a javitas mar kesz volt, mire megerkezett) -- ezt ELUTASITVA-nak konyvelni azt allitana, hogy a helyi modell rosszul dolgozott (card 504ec76f).

#### %s
%s
' "$review_header" "$leaf_title" "$content"
}

# --- test hooks (no network/token/lock needed) ---------------------------------------------------
# --test-resolve: feed a kanban-list JSON fixture on stdin, CARD via env; prints the resolved leaves.
# --test-attempts-op OP LEAF [--file PATH]: exercises the attempts state machine against a scratch file.
if [[ "${1:-}" == "--test-advisory-draft" ]]; then
  advisory_draft
  exit 0
fi
# --test-draft-comment-body TITLE CONTENT [SYNTHETIC]: the exact comment body a real draft posts,
# no network (card 501c489f).
if [[ "${1:-}" == "--test-draft-comment-body" ]]; then
  draft_comment_body "${2-}" "${3-}" "${4-false}"
  exit 0
fi
if [[ "${1:-}" == "--test-resolve" ]]; then
  resolve_leaves
  exit 0
fi
# --test-resolve-decompose: same contract as --test-resolve, but through the decompose wrapper (card
# 501c489f) -- the real run calls resolve_leaves_with_decompose, not resolve_leaves directly, so this
# is the hook that can never drift from what actually ships.
if [[ "${1:-}" == "--test-resolve-decompose" ]]; then
  resolve_leaves_with_decompose
  exit 0
fi
# --test-nudge-recipient ASSIGNEE RUNNING: the draft-nudge routing decision (card 0b3a3084), pure.
if [[ "${1:-}" == "--test-nudge-recipient" ]]; then
  nudge_recipient "${2-}" "${3-}"
  echo
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

# INSTALLED GATE (Peti Telegram 8928, 2026-09-19): "ha nincs telepitve local-llm akkor ez az ag el se
# induljon". Same network-free precheck as card-build-route.sh's 0a and self-advance-pickup.sh's
# step 0 -- a host with no local runtime at all should never take the per-card lock below, resolve
# leaves, or touch offload-attempts.json for a call that can only end in "nothing drafted". Exits 0,
# same as every other best-effort skip in this script (VRAM-busy included).
INSTALLED="${OFFLOAD_INSTALLED:-$HERE/local-llm-installed.sh}"
if ! bash "$INSTALLED" >/dev/null 2>&1; then
  echo "offload-dispatch: SKIPPED -- local-llm: not installed, branch skipped. Nothing was drafted; the card is untouched and goes online as usual." >&2
  exit 0
fi

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

LEAVES_JSON="$(curl -s -H @"$hdr_file" "$DASH/api/kanban" | resolve_leaves_with_decompose)"

if [[ -z "${LEAVES_JSON// }" || "$LEAVES_JSON" == "[]" ]]; then
  echo "offload-dispatch: card $CARD not found/not open/empty -> skip"
  exit 0
fi

LEAF_COUNT="$(printf '%s' "$LEAVES_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
echo "offload-dispatch: $CARD -> $LEAF_COUNT open leaf(s) resolved" >&2

# CODE-GRAPH CONTEXT (card 44477615) -- unchanged mechanism, now resolved per-leaf task text.
# Card 1b02ed3a (rebrand step 1, QA2 census, comment 4795): 'mopsion' names the SAME repo as
# 'CleanCore' -- without this branch, a card carrying the new project name fell through with no
# `*)` default, returned empty, and graph_args_for's `[[ -n "$repo" ... ]] || return 0` silently
# skipped code-graph context for it -- not a wrong answer, a quietly-degraded local-llm draft.
graph_repo_for() {
  local project="$1"
  case "$project" in
    MikroB)              (cd "$(git -C "$HERE" rev-parse --git-common-dir 2>/dev/null || echo .)/.." 2>/dev/null && pwd) ;;
    CleanCore|mopsion)    echo "${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/mopsion}" ;;
    # Explicit fail-safe default (Cybersec, card 1b02ed3a comment 4864): an unrecognised project
    # already fell through to this same empty output before this arm existed -- stated here rather
    # than left implicit, so a reader (or a future case arm added above it) cannot mistake the
    # silence for an oversight. graph_args_for's own `[[ -n "$repo" ... ]] || return 0` treats empty
    # as "skip code-graph context", never as a path to touch -- soft degradation, not a security gap.
    *) echo "" ;;
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
  # $4 = synthetic ("true"/"false", optional), forwarded to draft_comment_body.
  local leaf_id="$1" leaf_title="$2" content="$3" synthetic="${4:-false}"
  local body; body="$(draft_comment_body "$leaf_title" "$content" "$synthetic")"
  curl -s -X POST "$DASH/api/kanban/$leaf_id/comments" -H "Content-Type: application/json" -H @"$hdr_file" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"author":sys.argv[1],"content":sys.argv[2]}))' "$DRAFT_AUTHOR" "$body")" >/dev/null 2>&1
}

post_exhausted_notice() {
  local leaf_id="$1"
  local body="INFO-ONLY [local-llm offload]: a helyi 7B $OFFLOAD_LEAF_MAX_ATTEMPTS sikertelen (tranziens) kiserlet utan kimerult ezen a kartyan (pl. Ollama nem volt elerheto). A kartya emiatt NEM blokkolt -- a felelos agens a normal (online) uton viszi tovabb. 24 ora mulva a rendszer automatikusan ujra probalkozik helyben."
  curl -s -X POST "$DASH/api/kanban/$leaf_id/comments" -H "Content-Type: application/json" -H @"$hdr_file" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"author":sys.argv[1],"content":sys.argv[2]}))' "$DRAFT_AUTHOR" "$body")" >/dev/null 2>&1
}

try_leaf() {
  # Caller already ran attempts_op check + skipped done/exhausted leaves before invoking this (the
  # loop's precheck below) -- no need to repeat that read here.
  #
  # TWO IDS, DELIBERATELY SEPARATE (card 501c489f). leaf_id is the ATTEMPTS-TRACKING key -- for a
  # synthetic (decomposed) leaf this is "$realCardId~$type", so each mechanical fragment retries
  # independently. post_id is where a comment/nudge actually LANDS on the board -- a synthetic id is
  # not a real kanban row, so it is ALWAYS the real card id, same for every fragment of that card.
  # For a real leaf the two are identical (post_id == leaf_id), so this is a no-op there.
  local leaf_id="$1" leaf_title="$2" leaf_desc="$3" leaf_assignee="$4" leaf_tags="$5" leaf_project="$6" parent_ctx="$7" leaf_assignee_raw="${8:-}" post_id="${9:-$1}" synthetic="${10:-false}"
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
    post_draft_comment "$post_id" "$leaf_title" "$out" "$synthetic"
    nudge_leaf_owner "$post_id" "$leaf_assignee_raw" draft || true
    echo "offload-dispatch: leaf $leaf_id -> posted local draft"
    return 0
  elif [[ $rc -eq 9 ]]; then
    # An ONLINE verdict still carries a local draft: local-llm-rag.sh's advisory path (card ee43a6ac)
    # prints a JSON envelope on stdout and exits 9. This branch used to drop that stdout, so the 7B
    # ran for up to 120s per leaf and its draft was thrown away -- measured 2026-09-24: 9 of 11
    # dispatched cards got no draft, all as "router-online". Rule 16 (card 3c075d74): ONLINE decides
    # how thorough the online review is, not whether a draft exists. So post the envelope's draft,
    # marked as needing the full independent review, and keep the no-draft path for an empty stdout.
    local adv_draft
    adv_draft="$(printf '%s' "$out" | advisory_draft)"
    if [[ -n "${adv_draft// }" ]]; then
      attempts_op success "$leaf_id" >/dev/null
      post_draft_comment "$post_id" "$leaf_title" "$adv_draft" "$synthetic"
      nudge_leaf_owner "$post_id" "$leaf_assignee_raw" draft || true
      echo "offload-dispatch: leaf $leaf_id -> posted local draft (advisory, route stays online)"
      return 0
    fi
    attempts_op categorical-online "$leaf_id" >/dev/null
    echo "offload-dispatch: leaf $leaf_id -> categorical online (router decision), no retry" >&2
    return 1
  else
    entry="$(attempts_op transient-fail "$leaf_id")"
    local n; n="$(printf '%s' "$entry" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("attempts",0))' 2>/dev/null)"
    echo "offload-dispatch: leaf $leaf_id -> local attempt failed (rc=$rc), attempt ${n:-?}/$OFFLOAD_LEAF_MAX_ATTEMPTS" >&2
    if [[ "${n:-0}" -ge "$OFFLOAD_LEAF_MAX_ATTEMPTS" ]]; then
      post_exhausted_notice "$post_id"
      nudge_leaf_owner "$post_id" "$leaf_assignee_raw" exhausted || true
    fi
    return 1
  fi
}

# VRAM PRESSURE, ONCE PER SWEEP (card f9bad591). Per-LEAF protection already comes for free: every
# leaf goes through local-llm-rag.sh, which asks the same guard before it routes local. This check
# exists so a sweep that cannot possibly draft anything does not first walk the whole leaf list,
# read the board and spend its bookkeeping -- it says so and stops.
#
# It EXITS 0, not non-zero: "the GPU is busy" is a normal operating condition for a sweep, not a
# failure of the sweep, and a non-zero exit here would make the heartbeat treat a healthy machine as
# a broken one. Missing guard -> skipped; any non-zero exit from it -> stop, same direction as the
# other two call sites.
VRAM_GUARD="${OFFLOAD_VRAM_GUARD:-$HERE/vram-guard-check.sh}"
if [[ -f "$VRAM_GUARD" ]]; then
  vram_line="$(bash "$VRAM_GUARD" 2>/dev/null)"; vram_rc=$?
  if [[ "$vram_rc" -ne 0 ]]; then
    echo "offload-dispatch: SKIPPED -- the local model cannot take work now (${vram_line:-no output}, rc=$vram_rc). Nothing was drafted; the cards are untouched and go online as usual." >&2
    exit 0
  fi
fi

attempted=0
drafted=0
# Fields travel base64-encoded end to end (title/description routinely contain newlines/tabs, which
# would otherwise corrupt `read -r` field splitting) and are only decoded at the point of use.
# DELIMITER: '|', not TAB. A tab is IFS-WHITESPACE, so bash COLLAPSES consecutive tabs and an
# EMPTY field silently disappears -- every later field shifts one to the left. Measured:
#   printf 'A\tB\t\tD\n' | { IFS=$'\t' read -r a b c d; }  -> a=A b=B c=D d=(empty)
#   printf 'A|B||D\n'      | { IFS='|'  read -r a b c d; }  -> a=A b=B c=(empty) d=D
# This bit in production (cards 0b3a3084 -> this fix): `parent_context` is empty for any leaf with
# no parent -- most cards -- so the field after it, `assignee_raw`, was lost and the draft nudge
# announced "the card has NO assignee" for cards that plainly had one (measured on #370/cae9fb67
# assigned to backend, and #327/8b5559cf assigned to backend2; both nudges went to mikrob instead).
# The same shift also handed the local model the ASSIGNEE NAME as its --context. The old 7-field
# form hid it because the empty field was LAST, so nothing came after it to lose.
# '|' is outside the base64 alphabet (A-Za-z0-9+/=) and is not IFS whitespace, so empty fields survive.
while IFS='|' read -r b64id b64title b64desc b64assignee b64tags b64project b64ctx b64assignee_raw b64synthetic; do
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
  lassignee_raw="$(printf '%s' "$b64assignee_raw" | base64 -d)"
  lsynthetic="$(printf '%s' "$b64synthetic" | base64 -d)"
  # POST TARGET (card 501c489f): a synthetic leaf id ("$realCardId~$type") is not a real kanban row
  # -- comments/nudges always go to the real card, named by stripping everything from the FIRST `~`
  # onward (a no-op for a real leaf id, which never contains one).
  lpost_id="${lid%%~*}"
  # RECONSTRUCTION-BOILERPLATE FILTER (backend2 finding, 8b5559cf, 2026-09-12): a 2026-09-08 kanban
  # DB-kiuerueles utani rekonstrukcio ~34+ kartyan olyan leirast hagyott, ami csak a cim ismetlese +
  # egy [REKONSTRUKCIO-JAVITAS]/[DEDUP-PREFILTER] boilerplate blokk, ONALLO TORZSSZOVEG NELKUL. Ez a
  # helyi 7B-t felrevitte: a "rekonstrukcio"/"javitas" szo sokszorosa miatt a szoveg rendbetetelet
  # oldotta meg, nem a kartya tenyleges (a cimben elo) feladatat. Ha a leirasbol a boilerplate
  # kivetele utan nem marad erdemi torzsszoveg, a promptba CSAK a cim megy.
  ldesc="$(LTITLE="$ltitle" LDESC="$ldesc" python3 -c '
import os, re
title = os.environ.get("LTITLE", "")
desc = os.environ.get("LDESC", "")
body = desc
lines = body.splitlines()
# [NN%] progress markers drift between title and a stale copy left in the description by the
# 2026-09-08 reconstruction -- normalise both sides away before comparing the rest of the line.
norm = lambda s: re.sub(r"\[\d+%\]", "", s).strip().lower()
if lines and norm(lines[0]) == norm(title):
    body = "\n".join(lines[1:])
body = re.sub(r"\[REKONSTRUKCIO[^\]]*\].*?(?:\n\n|\Z)", "", body, flags=re.IGNORECASE | re.DOTALL)
body = re.sub(r"\[DEDUP-PREFILTER\].*?(?:\n\n|\Z)", "", body, flags=re.IGNORECASE | re.DOTALL)
body = re.sub(r"^--\s*Log-alap[uú] rekonstrukci[oó].*$", "", body, flags=re.IGNORECASE | re.MULTILINE)
if len(body.strip()) < 30:
    print("")
else:
    print(desc)
')"
  attempted=$(( attempted + 1 ))
  if try_leaf "$lid" "$ltitle" "$ldesc" "$lassignee" "$ltags" "$lproject" "$lctx" "$lassignee_raw" "$lpost_id" "$lsynthetic"; then
    drafted=$(( drafted + 1 ))
  fi
done < <(printf '%s' "$LEAVES_JSON" | python3 -c '
import json, sys, base64
for l in json.load(sys.stdin):
    fields = [l["id"], l["title"], l["description"], l["assignee"], l["tags"], l["project"], l["parent_context"], l["assignee_raw"], str(bool(l.get("synthetic", False))).lower()]
    print("|".join(base64.b64encode(str(x).encode()).decode() for x in fields))
')

if [[ $drafted -eq 0 ]]; then
  echo "offload-dispatch: $CARD -> no local-eligible parts (routed online)"
  exit 0
fi
echo "offload-dispatch: $CARD -> posted local draft(s) [$drafted/$attempted leaf attempt(s)]"
exit 0
