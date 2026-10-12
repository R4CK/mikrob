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
# STALE-IN-PROGRESS SKIP (card eeebd2b5). resolve_leaves() also drops any leaf that is in_progress
# AND has been actively dispatched to its online agent for OFFLOAD_STALE_IN_PROGRESS_SECONDS
# already (default 600s/10min, rule 3's own stuck-card threshold) -- measured twice (041b6a47 msg
# 1808; card #1804) that a draft landing this late arrives after the real fix is already in place
# or nearly so, costing a Draft-Review adjudication for zero token savings.
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
GEMINI_OFFLOAD="$HERE/gemini-offload-call.sh"

# GEMINI ROUTE (card a92e9913): read the current route from the fallback state file.
# Defaults to "claude" when the file is absent or malformed -- fail-safe toward the local path.
get_gemini_route() {
  local state="$HERE/gemini-fallback-state.json"
  [[ -f "$state" ]] || { echo "claude"; return; }
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('route','claude'))" "$state" 2>/dev/null || echo "claude"
}
GEMINI_ROUTE="$(get_gemini_route)"

# is_gemini_blocked PROJECT TAGS [TITLE [DESC]]: returns 0 (true/blocked) when a leaf must NOT
# go to Gemini.  Fail-closed by design (WhiteHat2 F1, card a92e9913):
#
#   1. PROJECT ALLOWLIST (not a blocklist): only the fleet's own project ("mikrob", casefold) may
#      reach the external Gemini API.  Every other project -- including unknown / empty ones --
#      is blocked.  Empty project is blocked (unknown = unsafe).
#   2. TAG BLOCKS: casefold + Unicode-accent-strip so PÉNZ, Penz, penz all map to "penz".
#      ALL BLOKKOLT-* patterns are blocked regardless of suffix.
#      Extended blocklist (WhiteHat2 F1b, Peti Telegram 11131): mopsion, cleancore, sec, security,
#      auth, authz, rbac, tenant, superadmin, pii, penz, penzugy, finance, billing, payment,
#      secret, crypto, gdpr, privacy, legal, cybersec.
#   3. CONTENT GATE on the card title AND description (card a92e9913, MikroB 11335): if either
#      contains a sensitive keyword the card is blocked regardless of tags.  Reuses the same
#      sensitive-domain vocabulary as the router's prefilter (card-build-route).
#      A card like 6a4e34c1 (SSE ?token= leak, no sensitive tag, no sensitive title) is blocked
#      because the description reveals the sensitive nature.
#      NORMALIZED + STEM MATCH (RedHat 17510 finding 1): title/desc are casefold+accent-stripped
#      the same way as tags before matching, and each stem only needs a LEADING word boundary (no
#      trailing \b) because Hungarian glues suffixes onto the stem ("jogosult" + "sag" ->
#      "jogosultsag", "biztons" + "ag" -> "biztonsag" inside a bracket label like "[Biztonság]").
#      Previously \b...\b required a boundary AFTER the stem too, which Unicode letters like "á"
#      never produce, so "Számla", "Jogosultság" and "[Biztonság]"/"[FIN]" all passed through
#      unblocked (measured: 3 of 6 tag-less sensitive cards). Dropping the trailing boundary is a
#      deliberate false-positive-tolerant choice: a blocked card merely gets no Gemini draft
#      (routes online as usual), which is the acceptable side of this card's fail-closed design.
#      FULL TEXT, NOT A PREFIX (WhiteHat2 H1, card 40d2a253): title/desc are inspected in full,
#      because try_leaf() sends the SAME full leaf_title+leaf_desc to Gemini as "$task" (line
#      ~836) -- a cap here that the outbound call does not share would let a sensitive word past
#      the cut point through unblocked. To inspect the full text without risking an oversized
#      python3 argv (the previous fix's concern, see below), title/desc are passed over STDIN, not
#      as command-line arguments -- argv has an OS-level length ceiling, stdin does not.
#   4. CATEGORICAL-ONLINE leaves NEVER go to Gemini (WhiteHat2 F1d): the router already classified
#      the card as security/authz/multi-file; sending it to an external API discards that verdict.
#      Enforcement: the categorical-online branch no longer contains a try_gemini_for_leaf call.
#
# FAIL-CLOSED ON INTERPRETER FAILURE (RedHat 17510 finding 2, sharpened by WhiteHat2 H2): the
# Python classifier can fail before reaching an explicit sys.exit -- missing python3 (rc=127), or
# any other interpreter crash, INCLUDING an uncaught Python exception, which exits with code 1 by
# default. The old "allowed" signal was ALSO exit code 1 -- so a genuine classifier bug (regex
# error, bad encoding, anything raising) was silently indistinguishable from "allowed", the exact
# opposite of fail-closed. Fixed by giving "allowed" its own code that nothing else can produce:
# $ALLOWED_RC (42, below). ONLY that exact code returns allowed; every other outcome -- 0 (explicit
# blocked), 1 (uncaught exception), 126/127 (interpreter crash), anything else -- returns blocked.
#
# Returns 1 (false/allowed) only when all four gates pass AND the classifier ran to completion.
is_gemini_blocked() {
  local project="$1" tags="$2" title="${3:-}" desc="${4:-}"
  local rc
  # Distinct "allowed" exit code (WhiteHat2 H2, matches the Python ALLOWED_RC constant below):
  # cannot collide with a bare Python exception (1) or any shell/OS failure code, so only a
  # deliberate, successful "allowed" verdict matches. A literal, not an env var, to sidestep a
  # bash quirk: a `VAR=val command` prefix assignment on a `local -r` variable is itself an
  # assignment and bash refuses it as a readonly violation, even though it's command-scoped.
  printf '%s\0%s' "$title" "$desc" | python3 -c '
import sys, unicodedata, re

project  = sys.argv[1]
tags_csv = sys.argv[2] if len(sys.argv) > 2 else ""
ALLOWED_RC = 42  # must match the bash-side check below

# title/desc come over stdin (WhiteHat2 H1): NUL-separated, no argv length ceiling, no cap needed
# -- this is the exact same full text try_leaf() sends to Gemini as "$task".
_stdin = sys.stdin.buffer.read()
_parts = _stdin.split(b"\x00", 1)
title = _parts[0].decode("utf-8", "replace")
desc  = _parts[1].decode("utf-8", "replace") if len(_parts) > 1 else ""


# N1 (RedHat 17653, card e87e7520): fullwidth/compatibility obfuscation ("ｓｅｃｒｅｔ",
# mathematical bold/italic letters) passed norm() unblocked because NFD only decomposes
# COMBINING ACCENTS, not compatibility characters -- NFKD is required for those. Separately,
# Cyrillic homoglyphs (visually identical to Latin but a distinct codepoint: а/е/о/р/с/у/х/...)
# have NO NFKD decomposition to Latin at all, so they need an explicit substitution table.
_HOMOGLYPH_MAP = str.maketrans({
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
    "і": "i", "ѕ": "s", "һ": "h", "ԃ": "d", "ɡ": "g", "ⅰ": "i",
})

def norm(s):
    """casefold + homoglyph map + NFKD-normalize (handles fullwidth/compat chars) -> ASCII."""
    s = s.strip().casefold().translate(_HOMOGLYPH_MAP)
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()

# F2 (WhiteHat NO-GO, komment 17848, card e87e7520): the homoglyph table is open-ended and
# norm() silently DROPS any non-ASCII letter it does not know (encode("ascii","ignore")) --
# measured: 226 (stem, position, char) combinations across 18 sensitive stems bypassed the
# gate with a single untabled homoglyph (Greek, Armenian, small-caps, struck-through Latin).
# Fail-closed instead: after homoglyph-map + NFKD decomposition, if a non-ASCII LETTER
# (unicodedata category L*) remains, treat it as blocked. Genuine Hungarian text is NOT
# affected -- NFKD decomposes a/e/i/o/u-with-accent into base-ASCII-letter + a COMBINING
# MARK (category Mn, not L*), so ordinary Hungarian title/desc text passes through clean.
# The homoglyph table stays a convenience (lets a KNOWN homoglyph normalize to its real
# word for SENS_RE matching); this check is the actual guarantee, not the table.
def has_unmapped_letter(s):
    decomposed = unicodedata.normalize("NFKD", s.translate(_HOMOGLYPH_MAP))
    return any(ord(ch) > 127 and unicodedata.category(ch).startswith("L") for ch in decomposed)

# 1. Project allowlist (fail-closed: empty/unknown = blocked).
ALLOWED_PROJECTS = {"mikrob"}
if not project.strip() or norm(project) not in ALLOWED_PROJECTS:
    sys.exit(0)  # blocked

# 2. Tag blocks: casefold + accent-strip each tag.
BLOCKED_TAGS = {
    "mopsion","cleancore","sec","security","auth","authz","rbac","tenant","superadmin",
    "pii","penz","penzugy","finance","billing","payment","secret","crypto",
    "gdpr","privacy","legal","cybersec",
    # N6 (RedHat 17653, card e87e7520): exact-match tags missing from the set -- "fin" and
    # "biztonsag" are already stems in SENS_RE (title/desc text), but a TAG literally named
    # "fin" or "biztonsag" fell through here because this set never had them.
    "fin","biztonsag",
}
for tag in tags_csv.split(","):
    t = norm(tag)
    if t.startswith("blokkolt-"):   # ANY BLOKKOLT-* suffix
        sys.exit(0)  # blocked
    if t in BLOCKED_TAGS:
        sys.exit(0)  # blocked

# 3. Content gate on NORMALIZED title AND description (sensitive stem -> blocked, fail-closed).
# Leading-boundary-only stems (RedHat 17510 finding 1): matches a stem at the start of a word,
# but also matches it as the start of a longer word ("jogosultsag", "biztonsag", "finance").
# VOCABULARY PARITY WITH THE ROUTER (RedHat 17567 B2, card a92e9913): the routers own authz/PII
# prefilter (card-build-route.sh) blocks on "permission", "access control", "szemelyes adat" and
# "hozzaferes" (Hungarian for "access") -- this gates vocabulary did not have them, so e.g.
# "Permission model for the export" or "Szemelyes adat maszkolasa a naploban" passed through
# unblocked despite being exactly the authz/PII categories named in Petis standing rule
# (Telegram 11131). Added below.
if has_unmapped_letter(title) or has_unmapped_letter(desc):
    sys.exit(0)  # blocked (F2: unmapped homoglyph/script, fail-closed)

title_n = norm(title)
desc_n = norm(desc)
SENS_RE = re.compile(
    r"\b(biztons|security|auth|authz|rbac|tenant|superadmin"
    r"|penz|penzugy|fizet|szamla|afa|payroll|berszamfejtes|jelszo|password"
    r"|token|secret|titok|jogosult|gdpr|privacy|kulcs"
    r"|kripto|crypto|pii|billing|payment|legal|jogi|cybersec|fin"
    r"|hacker|exploit|pentest|inject|sqli|xss"
    r"|permission|access|szemelyes|hozzaferes)",
    re.IGNORECASE
)
# N6 second half (RedHat 17653, card e87e7520): Hungarian tenant-isolation co-occurrence,
# ported from the routers own prefilter (card-build-route.sh) -- a bare "berlo" (tenant)
# stem alone is too broad (also a literal building tenant), only sensitive when it co-occurs
# with a separation/isolation verb within 40 chars, either order. Already NFKD+ASCII-stripped
# above, so only the ASCII stems are needed here (no accented variants to match).
# F4 (WhiteHat NO-GO, komment 17848, card e87e7520): two gaps measured. (a) "." does not match
# a newline, so "berlok adatainak<newline>elkulonitese" bypassed (a multi-line description is
# the common case, not an edge case) -- fixed with re.DOTALL. (b) the verb list only had the
# two RedHat-named stems; the natural "izolacio"/"szeparalas"/"elvalasztas" phrasing (the exact
# gap N6 was meant to close) still bypassed -- widened to the stems a WhiteHat measured through.
TENANT_ISOLATION_RE = re.compile(
    r"berlo.{0,40}(elkulonit|szetvalaszt|izol|szepara|elvalaszt|kulonvalaszt|kulonit)"
    r"|(elkulonit|szetvalaszt|izol|szepara|elvalaszt|kulonvalaszt|kulonit).{0,40}berlo",
    re.DOTALL,
)
if (SENS_RE.search(title_n) or SENS_RE.search(desc_n)
        or TENANT_ISOLATION_RE.search(title_n) or TENANT_ISOLATION_RE.search(desc_n)):
    sys.exit(0)  # blocked

sys.exit(ALLOWED_RC)  # allowed -- the ONE code that means a deliberate, completed "allowed" verdict
' "$project" "$tags"
  rc=$?
  [[ "$rc" -eq 42 ]] && return 1  # must match the Python-side ALLOWED_RC constant above
  return 0
}

# gemini_route_enabled: returns 0 (true) when the Gemini route is active.
# Fail-closed: the flag file must EXPLICITLY exist; absence = disabled.
# Default ship state: disabled (store/gemini-offload-enabled does not exist).
# Enables without a tracked-file chmod: create/remove the flag file at runtime.
# MikroB restores gemini-offload-call.sh chmod +x after all gates GO, then creates
# store/gemini-offload-enabled to re-enable the route (card a92e9913 O1).
gemini_route_enabled() {
  [[ -f "${HERE}/gemini-offload-enabled" ]]
}

# gemini_draft_comment_body: same contract as draft_comment_body but for a Gemini-sourced draft.
# $1=leaf_title, $2=content, $3=synthetic ("true"/"false", optional)
gemini_draft_comment_body() {
  local leaf_title="$1" content="$2" synthetic="${3:-false}"
  local review_header=""
  if [[ "$synthetic" == "true" ]]; then
    review_header="MECHANIKUS RESZFELADAT (card 501c489f) -- KOTELEZO A TELJES, FUGGETLEN ONLINE FELULVIZSGALAT.

"
  fi
  printf '%s[GEMINI DRAFT | dispatch-offload] Gemini (kvota-stop alatti draft, card a92e9913). DRAFT-ONLY: kvota-reset utan a felelos agent reviewlje es integralja -- ne irja ujra Claude-dal. AMIKOR VEGEZTEL VELE, tegyel a kartyara egy sort (sor elejen): '"'"'Draft-Review: ELFOGADVA'"'"' / '"'"'RESZBEN'"'"' / '"'"'ELUTASITVA'"'"' / '"'"'FELESLEGES'"'"' -- e nelkul a kartya nem mehet waiting-be (card 1338e68b).

#### %s
%s
' "$review_header" "$leaf_title" "$content"
}

# try_gemini_for_leaf: call Gemini API for a leaf and post the draft comment.
# Records a transient attempt on API failure so the dispatcher can track retries.
try_gemini_for_leaf() {
  local leaf_id="$1" leaf_title="$2" task="$3" post_id="$4" synthetic="${5:-false}"

  [[ -x "$GEMINI_OFFLOAD" ]] || return 1

  local out rc=0
  out="$(printf '%s' "$task" | bash "$GEMINI_OFFLOAD" 2>/dev/null)" || rc=$?

  if [[ $rc -eq 0 && -n "${out// }" ]]; then
    attempts_op success "$leaf_id" >/dev/null
    local body; body="$(gemini_draft_comment_body "$leaf_title" "$out" "$synthetic")"
    curl -s -X POST "$DASH/api/kanban/$post_id/comments" -H "Content-Type: application/json" -H @"$hdr_file" \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"author":sys.argv[1],"content":sys.argv[2]}))' "$DRAFT_AUTHOR" "$body")" >/dev/null 2>&1
    echo "offload-dispatch: leaf $leaf_id -> posted GEMINI DRAFT" >&2
    return 0
  fi
  echo "offload-dispatch: leaf $leaf_id -> Gemini call failed (rc=$rc)" >&2
  attempts_op transient "$leaf_id" >/dev/null
  return 1
}

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
# shellcheck source=./decompose-sample-context.sh
. "$HERE/decompose-sample-context.sh"

ATTEMPTS_FILE="$HERE/offload-attempts.json"
ATTEMPTS_LOCK="$HERE/.offload-attempts.lock"
EXHAUSTED_TTL_SECONDS="${EXHAUSTED_TTL_SECONDS:-86400}"
# Card 501c489f, MikroB verdikt komment 6007, requirement 6: 3 -> 2. Only the TRANSIENT-failure
# threshold moves; categorical-online (router says ONLINE) was already a single-call jump straight
# to exhausted and stays that way, just landing on this same new ceiling.
OFFLOAD_LEAF_MAX_ATTEMPTS="${OFFLOAD_LEAF_MAX_ATTEMPTS:-2}"

# STALE-IN-PROGRESS SKIP (card eeebd2b5). Measured twice (041b6a47 msg 1808; card #1804) that a
# draft landing on an in_progress leaf the online agent has ALREADY been carrying for a while
# arrives after the real fix is already in place or nearly so -- the draft saves no tokens, it
# only costs a Draft-Review adjudication. Default 600s (10 min) matches rule 3's own stuck-card
# threshold, per the card's own suggestion. See resolve_leaves()'s is_stale_in_progress() below.
OFFLOAD_STALE_IN_PROGRESS_SECONDS="${OFFLOAD_STALE_IN_PROGRESS_SECONDS:-600}"
# NON-INTEGER GUARD (card f8e7f7cb, Cybersec F1 LOW on eeebd2b5, Gate-SHA bdb35dfa). A value like
# "10m" used to reach resolve_leaves()'s python as-is, where int(...) raises ValueError before any
# leaf is resolved -- the uncaught exception aborts that python process with no stdout, and because
# resolve_leaves()'s caller redirects stderr to /dev/null, the whole function silently returns empty,
# so EVERY leaf (including a fresh "planned" one) resolves to zero, with no trace of why.
if ! [[ "$OFFLOAD_STALE_IN_PROGRESS_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "offload-dispatch: OFFLOAD_STALE_IN_PROGRESS_SECONDS='$OFFLOAD_STALE_IN_PROGRESS_SECONDS' is not an integer -- falling back to the documented default (600s)" >&2
  OFFLOAD_STALE_IN_PROGRESS_SECONDS=600
fi
export ATTEMPTS_FILE EXHAUSTED_TTL_SECONDS OFFLOAD_LEAF_MAX_ATTEMPTS OFFLOAD_STALE_IN_PROGRESS_SECONDS

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
elif op == "no-sample":
    # card d39fc5e7 requirement 1: a decomposed leaf whose type has no real sample file to anchor
    # on. Marked exhausted (no retry) for the SAME reason categorical-online is: a GPU call would
    # not change the answer, since the repo's file tree does not change between sweep ticks.
    entry = {"attempts": max_attempts, "status": "exhausted", "updated_at": now, "reason": "no-sample"}
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
  CARD="$CARD" STALE_SECONDS="$OFFLOAD_STALE_IN_PROGRESS_SECONDS" python3 -c '
import json, os, re, sys, time

CARD = os.environ["CARD"]
STALE_SECONDS = int(os.environ.get("STALE_SECONDS", "600"))
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

# card eeebd2b5: an in_progress leaf an online agent has already been actively carrying for
# STALE_SECONDS is excluded from the returned leaf set (no draft attempt for it at all).
# dispatched_at is the once-only in_progress-spell timestamp db.ts already maintains
# (markKanbanCardDispatched on dispatch, cleared on any move OUT of in_progress) -- exactly
# "how long has THIS spell of online work been running", not just "when was it last touched".
def is_stale_in_progress(c):
    if c.get("status") != "in_progress":
        return False
    dispatched_at = c.get("dispatched_at")
    if not dispatched_at:
        return False
    try:
        return (time.time() - float(dispatched_at)) >= STALE_SECONDS
    except (TypeError, ValueError):
        return False

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
        if node is None or is_stale_in_progress(node):
            return []
        return [node]
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

# PREDECESSOR + PAIR CONTEXT (card 2be7e3e5, requirement 2: "kartya + szulo + Pair/predecessor +
# erintett fajlok kivonata, meretkorlattal"). ancestor_context above already gives parent-chain
# context; this adds the two other linked-card kinds a leaf can carry: predecessor cards (the
# `blockedBy` edge from rule 1c, a REAL dependency, not parent_id) and a Pair-FE/Pair-BE sibling
# (the `Pair-FE: <id>` / `Pair-BE: <id>` line from CLAUDE.md rule 8a, lives in the leaf own
# description, not an ancestor). Capped at 2 predecessors + 1 pair, same 400-char-per-card truncation as the
# ancestor chain, so the context package stays size-bounded.
PAIR_RE = re.compile(r"Pair-(?:FE|BE)\s*:\s*([0-9a-f]{6,12})", re.IGNORECASE)

def related_context(node_id):
    node = by_id.get(node_id)
    if not node:
        return ""
    parts = []
    for pid in list(node.get("blockedBy") or [])[:2]:
        p = by_id.get(str(pid))
        if not p:
            continue
        title = (p.get("title") or "").strip()
        desc = (p.get("description") or "").strip()[:400]
        parts.append(f"ELOZMENY (predecessor {pid}): {title}\n{desc}")
    m = PAIR_RE.search(node.get("description") or "")
    if m:
        pair_id = m.group(1)
        p = by_id.get(pair_id)
        if p:
            title = (p.get("title") or "").strip()
            desc = (p.get("description") or "").strip()[:400]
            parts.append(f"PAROSITOTT (pair {pair_id}): {title}\n{desc}")
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
        "parent_context": "\n---\n".join(p for p in [ancestor_context(str(l["id"])), related_context(str(l["id"]))] if p),
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

# draft_quality_ok: deterministic pre-post quality gate (card d39fc5e7, requirement 2) -- NO model
# call, every check is mechanical (length, repeats-the-card-text, import existence) so a bad draft
# never costs an online Draft-Review adjudication (the measured baseline: 14/17 drafts rejected,
# three recurring MECHANICAL defect shapes per card-build-route-24h-measure.sh, 2026-09-30). Prints
# "OK" or "FAIL\t<reason>" (the actual logic lives in draft-quality-gate.py, kept out of this shell
# file so it is unit-testable without a shell). ----------------------------------------------------
draft_quality_ok() { # $1 draft  $2 task(title+description)  $3 repo root (may be empty)
  local draft="$1" task="$2" repo="$3"
  python3 -c 'import json,sys; print(json.dumps({"draft":sys.argv[1],"task":sys.argv[2],"repo":sys.argv[3]}))' \
      "$draft" "$task" "$repo" \
    | python3 "$HERE/draft-quality-gate.py"
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
# --test-quality-gate DRAFT TASK [REPO]: the exact wiring try_leaf() uses before posting a draft
# (card d39fc5e7, requirement 2), no network/token/lock needed.
if [[ "${1:-}" == "--test-quality-gate" ]]; then
  draft_quality_ok "${2-}" "${3-}" "${4-}"
  exit 0
fi
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

# MASTER LOCAL-FIRST-DRAFT SWITCH (card d57d8a01, Peti Telegram 10951), checked before even the
# INSTALLED gate below -- same ordering principle (cheapest, most authoritative gate first).
# EXCEPTION (card a92e9913): when route=gemini the fleet is in quota-stop and needs drafts -- the
# local-first-draft master switch only controls the LOCAL model path, not the Gemini path.
# shellcheck source=./local-first-draft-check.sh
. "$HERE/local-first-draft-check.sh"
if ! local_first_draft_enabled; then
  if [[ "$GEMINI_ROUTE" != "gemini" ]]; then
    echo "offload-dispatch: SKIPPED -- local-first-draft is OFF (dashboard switch). Nothing was drafted; the card is untouched and goes online as usual." >&2
    exit 0
  fi
  echo "offload-dispatch: local-first-draft is OFF, but route=gemini -- continuing for Gemini path." >&2
fi

# INSTALLED GATE (Peti Telegram 8928, 2026-09-19): "ha nincs telepitve local-llm akkor ez az ag el se
# induljon". Same network-free precheck as card-build-route.sh's 0a and self-advance-pickup.sh's
# step 0 -- a host with no local runtime at all should never take the per-card lock below, resolve
# leaves, or touch offload-attempts.json for a call that can only end in "nothing drafted". Exits 0,
# same as every other best-effort skip in this script (VRAM-busy included).
# EXCEPTION (card a92e9913): when route=gemini and local LLM is not installed, Gemini still runs.
INSTALLED="${OFFLOAD_INSTALLED:-$HERE/local-llm-installed.sh}"
LOCAL_LLM_AVAILABLE=1
if ! bash "$INSTALLED" >/dev/null 2>&1; then
  if [[ "$GEMINI_ROUTE" != "gemini" ]]; then
    echo "offload-dispatch: SKIPPED -- local-llm: not installed, branch skipped. Nothing was drafted; the card is untouched and goes online as usual." >&2
    exit 0
  fi
  LOCAL_LLM_AVAILABLE=0
  echo "offload-dispatch: local-llm not installed, but route=gemini -- local path skipped, Gemini path continues." >&2
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

  # GEMINI ROUTE, LOCAL LLM NOT AVAILABLE (card a92e9913): skip the RAG call entirely.
  if [[ "$GEMINI_ROUTE" == "gemini" && "${LOCAL_LLM_AVAILABLE:-1}" -eq 0 ]]; then
    if gemini_route_enabled && ! is_gemini_blocked "$leaf_project" "$leaf_tags" "$leaf_title" "$leaf_desc"; then
      try_gemini_for_leaf "$leaf_id" "$leaf_title" "$task" "$post_id" "$synthetic" && return 0
    else
      echo "offload-dispatch: leaf $leaf_id -> gemini blocked (project=$leaf_project)" >&2
    fi
    return 1
  fi

  local repo; repo="$(graph_repo_for "$leaf_project")"
  local graph=(); mapfile -t graph < <(graph_args_for "$task" "$repo")

  # SAMPLE-CONTEXT REQUIREMENT (card d39fc5e7, requirement 1): a synthetic (decomposed) leaf's own
  # text is a GENERIC templated sentence (card-decompose-templates.sh), not a real spec -- the
  # measured failure mode is a BLIND draft with nothing real to copy a house style from (e.g. an
  # Express/supertest test scaffold on a repo that uses raw handlers, card 825d7657). So for the
  # four typed fragments, find ONE real, nearest sample file and fold it in as extra context; if
  # none exists, do not call the model at all -- a template sentence with no anchor is exactly the
  # blind-draft shape this exists to prevent. A REAL (non-synthetic) leaf already carries its own
  # full card text and ancestor context, so this only applies when a type is recoverable from the
  # leaf id's "$realCardId~$type" suffix (synthetic leaves only, card 501c489f's own id shape).
  local dtype=""
  [[ "$synthetic" == "true" && "$leaf_id" == *"~"* ]] && dtype="${leaf_id##*~}"
  if [[ -n "$dtype" ]]; then
    local sample; sample="$(decompose_sample_context "$dtype" "$task" "$repo")"
    if [[ -z "${sample// }" ]]; then
      echo "offload-dispatch: leaf $leaf_id -> NO-SAMPLE for type '$dtype' (no real file in '$repo' to anchor the draft on), skipping" >&2
      attempts_op no-sample "$leaf_id" >/dev/null
      return 1
    fi
    parent_ctx="${parent_ctx:+$parent_ctx

}$sample"
  fi

  local out rc
  out="$("$RAG" --auto --agent "$leaf_assignee" --source dispatch-offload --log-task subtask-draft \
    --tags "$leaf_tags" --context "$parent_ctx" \
    ${graph[@]+"${graph[@]}"} "$task" 2>/dev/null)"
  rc=$?

  if [[ $rc -eq 0 && -n "${out// }" ]]; then
    # QUALITY GATE (card d39fc5e7, requirement 2): deterministic, no model call. A failing draft
    # posts NOTHING -- the whole point is that a bad draft must not cost anyone an online
    # Draft-Review adjudication -- and counts as a transient failure so it still counts toward the
    # existing 2-strikes ceiling instead of being retried forever on an unchanging verdict.
    local qverdict; qverdict="$(draft_quality_ok "$out" "$task" "$repo")"
    if [[ "$qverdict" != OK* ]]; then
      echo "offload-dispatch: leaf $leaf_id -> draft FAILED the quality gate (${qverdict#FAIL$'\t'}), no comment posted" >&2
      attempts_op transient-fail "$leaf_id" >/dev/null
      return 1
    fi
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
      local qverdict2; qverdict2="$(draft_quality_ok "$adv_draft" "$task" "$repo")"
      if [[ "$qverdict2" != OK* ]]; then
        echo "offload-dispatch: leaf $leaf_id -> advisory draft FAILED the quality gate (${qverdict2#FAIL$'\t'}), no comment posted" >&2
        attempts_op categorical-online "$leaf_id" >/dev/null
        return 1
      fi
      attempts_op success "$leaf_id" >/dev/null
      post_draft_comment "$post_id" "$leaf_title" "$adv_draft" "$synthetic"
      nudge_leaf_owner "$post_id" "$leaf_assignee_raw" draft || true
      echo "offload-dispatch: leaf $leaf_id -> posted local draft (advisory, route stays online)"
      return 0
    fi
    attempts_op categorical-online "$leaf_id" >/dev/null
    echo "offload-dispatch: leaf $leaf_id -> categorical online (router decision), no retry" >&2
    # F1d (WhiteHat2, card a92e9913): categorical-online leaves NEVER go to Gemini.
    # The router already classified this card as auth/security/multi-file -- sending it to an
    # external API would discard that verdict.  No Gemini fallback here.
    return 1
  else
    entry="$(attempts_op transient-fail "$leaf_id")"
    local n; n="$(printf '%s' "$entry" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("attempts",0))' 2>/dev/null)"
    echo "offload-dispatch: leaf $leaf_id -> local attempt failed (rc=$rc), attempt ${n:-?}/$OFFLOAD_LEAF_MAX_ATTEMPTS" >&2
    if [[ "${n:-0}" -ge "$OFFLOAD_LEAF_MAX_ATTEMPTS" ]]; then
      # GEMINI FALLBACK when local LLM is exhausted (card a92e9913): try Gemini before giving up.
      if [[ "$GEMINI_ROUTE" == "gemini" ]] && gemini_route_enabled && ! is_gemini_blocked "$leaf_project" "$leaf_tags" "$leaf_title" "$leaf_desc"; then
        try_gemini_for_leaf "$leaf_id" "$leaf_title" "$task" "$post_id" "$synthetic" && return 0
      fi
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
