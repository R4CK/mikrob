#!/usr/bin/env bash
# gate-pretriage-card.sh -- run the local mechanical pre-triage for ONE kanban card and post the
# result as a verdict:null INPUT comment, so a gate agent starts from deterministic facts instead of
# spending online Claude tokens re-deriving them (card 83191d8d; wires card 7041c165's gate-pretriage.sh).
#
# The gate-reconciler scheduled task calls this in the "REVIEW present, gate not yet dispatched" branch,
# BEFORE dispatching the gate. It is NOT a verdict: the posted comment carries no PASS/FAIL/GO/NO-GO and
# never moves the card. Idempotent per commit -- it will not re-post for a HEAD it already triaged.
#
# USAGE:
#   gate-pretriage-card.sh <cardId> [--dry-run]                  # resolve repo+commit from the API, post
#   gate-pretriage-card.sh --repo <path> --sha <sha> --dry-run   # offline core (tests / manual), prints only
#
# EXIT: 0 on success or a benign skip (no card, unresolved commit, already posted); 2 on usage error.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DASH="http://localhost:3420"
TOKEN_FILE="$HERE/.dashboard-token"
PRETRIAGE="$HERE/gate-pretriage.sh"
# The marker is greppable AND states plainly this is not a verdict; idempotency keys on "MARKER @ <sha>".
MARKER="GATE PRE-TRIAGE (mechanikus, verdict:null)"
CLEANCORE_REPO="/mnt/h/LM_Studio_Workdir/CleanCore"
MIKROB_REPO="/home/neon/marveen"

CARD=""; REPO=""; SHA=""; DRYRUN=0; TITLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRYRUN=1; shift ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --*) echo "gate-pretriage-card: unknown arg '$1'" >&2; exit 2 ;;
    *) CARD="$1"; shift ;;
  esac
done

# SECURITY (Cybersec lesson gate-ops-scripts-token-in-argv): the dashboard bearer token must NEVER be
# passed on a curl command line -- /proc/<pid>/cmdline is world-readable, so `curl -H "Authorization:
# Bearer <token>"` leaks it to any local user/process. Instead we write the header to a private 0600
# temp file ONCE and pass `-H @"$hdr_file"`; the file is unlinked on EXIT. Same pattern as
# weekly-usage-panel-read.sh. The header file is created lazily (only card mode needs it; the offline
# --repo/--sha core never touches the network).
hdr_file=""
cleanup() { [ -n "$hdr_file" ] && rm -f "$hdr_file" 2>/dev/null || true; }
trap cleanup EXIT

ensure_auth_header() {
  [ -n "$hdr_file" ] && return 0
  hdr_file="$(mktemp)" || return 1
  chmod 600 "$hdr_file"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$hdr_file"
}

# For a MERGE commit (2+ parents), diffing against the first parent (this script's own `<sha>~1`
# convention) silently assumes trunk always sits in parent-slot 1. It does for a standard land
# (marveen-land.sh / cleancore-land.sh check out origin/<trunk> and merge the agent branch IN, so
# parent 1 IS trunk-before-the-merge) -- but an agent's own ad-hoc "resolve a conflict by merging
# origin/<trunk> into my OWN branch mid-landing" puts trunk in parent 2 instead. Measured live (card
# 5b4cca21, Cybersec's finding on commit 2c56d300, card 132a6cfb comment 15118): the pre-triage
# reported apps/api backend files that belonged to an ENTIRELY DIFFERENT card, because parent 1 there
# was Fron Ted's own branch tip, not trunk -- whoever trusted that file list was reviewing someone
# else's code.
#
# `git merge-base <sha> origin/<trunk>` finds whichever parent already sits on trunk's history, in
# EITHER parent slot, with no assumption about parent order -- this is the exact method Cybersec used
# by hand to get the correct 5-file list in that finding. Two things keep it from making the COMMON
# case worse (the regression [[marveen-gate-shas-are-merges-diff-the-branch-side]] warns about -- an
# older base sweeps in whatever ELSE landed on trunk between the branch's fork point and its own
# merge):
#   1. Trunk here only ever fast-forwards (never rebased), so this merge-base is the SAME answer at
#      merge time and at any later query time -- it is not "whatever trunk happens to be today".
#   2. A standard land's own merge commit becomes trunk's new tip immediately on push, so for that
#      case `merge-base(sha, origin/trunk)` degenerates to `sha` itself (an empty diff) the moment it
#      lands -- caught below and treated as "could not use this method", falling back to the exact
#      `sha~1` this script always used, so the common case is UNCHANGED by this fix.
merge_diff_base() {
  local repo="$1" sha="$2" trunk parents mb full
  parents="$(git -C "$repo" log -1 --pretty=%P "$sha" 2>/dev/null)"
  if [ "$(printf '%s' "$parents" | wc -w)" -lt 2 ]; then
    printf '%s~1\n' "$sha"; return 0
  fi
  case "$repo" in
    "$CLEANCORE_REPO") trunk="origin/main" ;;
    *) trunk="origin/develop" ;;
  esac
  mb="$(git -C "$repo" merge-base "$sha" "$trunk" 2>/dev/null)" || mb=""
  full="$(git -C "$repo" rev-parse "$sha" 2>/dev/null)"
  if [ -n "$mb" ] && [ "$mb" != "$full" ]; then printf '%s\n' "$mb"; else printf '%s~1\n' "$sha"; fi
}

# Build the INPUT comment body for repo+sha. Prints the body; returns 3 (benign skip) if the commit is
# not present or the pre-triage cannot run. The body deliberately contains NO PASS/FAIL/GO/NO-GO word.
# `title` (optional, may be "") drives the SELF-CHECK below -- card ce159d2b, incident 6199f0b: a
# resolved commit belonging to an ENTIRELY DIFFERENT card (dashboard semver display) got mechanically
# triaged and reported as if it were the card's own change, with nothing flagging that the changed-
# files list had no relation to the card at all. This is a NUDGE for the human/gate reading the
# comment, not a second commit-selector -- it runs AFTER selection, on whatever commit was already
# resolved, and only ever adds a warning LINE; it never blocks or changes SHA/exit code.
build_body() {
  local repo="$1" sha="$2" title="${3:-}" json base
  [[ -d "$repo/.git" ]] || return 3
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || return 3
  base="$(merge_diff_base "$repo" "$sha")"
  json="$(bash "$PRETRIAGE" --repo "$repo" --base "$base" --head "$sha" --json 2>/dev/null)" || return 3
  MARKER="$MARKER" SHA="$sha" REPO="$repo" PT_JSON="$json" TITLE="$title" python3 <<'PY'
import json, os, re
d = json.loads(os.environ["PT_JSON"])
repo = os.path.basename(os.environ["REPO"].rstrip("/"))
changed = d.get("changed_files") or []
out = [
    f'{os.environ["MARKER"]} @ {os.environ["SHA"]}',
    "Ez NEM gate-verdikt -- a gate BEMENETE: helyben futott, determinisztikus mechanikus elso kor,",
    "hogy a QA/Cybersec ne online tokenert deritse ki ugyanezt. A gate a valos reviewt tovabbra is elvegzi.",
    "",
    f'repo: {repo}   tsc: {d.get("tsc")}   valtozott fajlok: {changed}',
]

# SELF-CHECK (card ce159d2b): the title's meaningful words vs. the changed-files paths. Generic
# bracket-tags (MikroB, INFRA, SEC, CleanCore, priority words, ...) and short/numeric tokens are
# dropped on purpose -- they say nothing about WHAT changed and would make every title "match".
STOPWORDS = {
    "mikrob", "cleancore", "infra", "sec", "bug", "feat", "feature", "deploy", "peti",
    "high", "medium", "low", "urgent", "normal", "card", "the", "and", "for", "with",
}
title = os.environ.get("TITLE", "")
words = [w for w in re.findall(r"[a-zA-Z][a-zA-Z0-9-]{3,}", title.lower()) if w not in STOPWORDS]
if len(words) >= 2 and changed:
    haystack = " ".join(changed).lower()
    if not any(w in haystack for w in words):
        out.append(
            "[FIGYELEM -- ONELLENORZES] a kartya cimenek egyetlen ertelmes szava sem jelenik meg a "
            "valtozott fajlok listajaban -- ELLENORIZD KEZZEL, hogy a fenti commit tenyleg ehhez a "
            f"kartyahoz tartozik-e (cim: {title!r})."
        )

# FE-LABEL VS BACKEND-FILE MECHANICAL WARNING (card c92c2142, Cybersec finding pattern seen TWICE
# in one session -- 65e96a20: static-server.ts's own path-traversal guard; 1f51f050: /api/ingest-log
# -- both were [FE]-labeled cards whose own "Gate:" line said QA-only/no-trust-boundary, but the
# changed files were actually backend/server code, caught only by Cybersec's own source read, not
# by the assigned reviewer. This is a NUDGE, not a verdict: it only fires when the title carries an
# [FE] bracket-tag AND at least one changed file looks server/route/handler/API-shaped -- it never
# blocks or changes the resolved commit/exit code, same contract as the self-check above.
#
# The api-clause matches "/api/" only as its OWN path segment (apps/api/..., src/api/...), not as a
# filename prefix -- "api-client.ts" (an ordinary frontend fetch wrapper, a near-universal SPA
# filename) would otherwise false-positive on every frontend card that talks to an API at all.
BACKEND_FILE_RX = re.compile(
    r"(^|/)[\w.-]*-(server|http)\.[jt]sx?$|(^|/)[\w.-]*(route|handler)[\w.-]*\.[jt]sx?$|(^|/)api/",
    re.IGNORECASE,
)
if re.search(r"\[FE\]", title, re.IGNORECASE) and any(BACKEND_FILE_RX.search(f) for f in changed):
    out.append(
        "[FIGYELEM -- FE-CIMKE VS BACKEND-FAJL] a kartya cime [FE]-cimkes, de a valtozott fajlok "
        "kozott szerver/route/handler/API-mintazatu fajl is szerepel -- ELLENORIZD, hogy a kartya "
        "sajat Gate: sora tenyleg lefedi-e a backend-erintett reszt (ne maradjon QA-only/nincs-"
        "trust-boundary, ha valojaban van)."
    )

fs = d.get("findings") or []
if not fs:
    out.append("Mechanikus lelet: nincs (az olcso csapdak tisztak -- ez NEM jelenti, hogy a kartya jo).")
else:
    out.append(f"Mechanikus leletek ({len(fs)}):")
    for f in fs:
        out.append(f'  [{f.get("severity","?")}] {f.get("check","?")}: {f.get("detail","")}')
print("\n".join(out))
PY
}

# ---- Offline core mode (tests / manual): --repo + --sha + --dry-run, no API. ----
if [[ -n "$REPO" && -n "$SHA" ]]; then
  [[ $DRYRUN -eq 1 ]] || { echo "gate-pretriage-card: --repo/--sha is offline mode, requires --dry-run" >&2; exit 2; }
  if body="$(build_body "$REPO" "$SHA" "$TITLE")"; then printf '%s\n' "$body"; else echo "SKIP: commit $SHA not in $REPO (or pre-triage failed)"; fi
  exit 0
fi

# ---- Card mode: resolve repo + latest REVIEW commit from the live API. ----
[[ -n "$CARD" ]] || { echo "usage: gate-pretriage-card.sh <cardId> [--dry-run]" >&2; exit 2; }

ensure_auth_header || { echo "SKIP: could not create auth header file"; exit 0; }
comments="$(curl -s -H @"$hdr_file" "$DASH/api/kanban/$CARD/comments" 2>/dev/null || true)"
board="$(curl -s -H @"$hdr_file" "$DASH/api/kanban?limit=500" 2>/dev/null || true)"
[[ -n "$comments" && -n "$board" ]] || { echo "SKIP: dashboard unreachable"; exit 0; }

project="$(printf '%s' "$board" | CARD="$CARD" python3 -c '
import json, sys, os
d = json.load(sys.stdin); rows = d if isinstance(d, list) else d.get("cards", d.get("data", []))
print(next((c.get("project") or "" for c in rows if c.get("id") == os.environ["CARD"]), ""))' 2>/dev/null || true)"
title="$(printf '%s' "$board" | CARD="$CARD" python3 -c '
import json, sys, os
d = json.load(sys.stdin); rows = d if isinstance(d, list) else d.get("cards", d.get("data", []))
print(next((c.get("title") or "" for c in rows if c.get("id") == os.environ["CARD"]), ""))' 2>/dev/null || true)"

# CANDIDATE commits from the comments, newest first (cards d7ac3470 + 34e7285e). A card id is ALSO
# an 8-hex token, so a regex alone cannot tell a short SHA from a card id -- the disambiguation is
# "does it resolve to a real commit" (below). Selection logic lives in gate-pretriage-candidates.py
# so it is independently testable without a live dashboard -- see that file for the two incident
# classes it fixes (recency-vs-wording across comments, and first-vs-last mention within one REVIEW).
candidates="$(printf '%s' "$comments" | python3 "$HERE/gate-pretriage-candidates.py" "$CARD" "$MARKER" 2>/dev/null || true)"

# Resolve project -> primary repo, then find the FIRST candidate that is a real commit in either repo.
case "$project" in
  CleanCore) primary="$CLEANCORE_REPO"; secondary="$MIKROB_REPO" ;;
  *) primary="$MIKROB_REPO"; secondary="$CLEANCORE_REPO" ;;
esac
sha=""; repo=""
while IFS= read -r cand; do
  [[ -n "$cand" ]] || continue
  if git -C "$primary" cat-file -e "${cand}^{commit}" 2>/dev/null; then sha="$cand"; repo="$primary"; break; fi
  if git -C "$secondary" cat-file -e "${cand}^{commit}" 2>/dev/null; then sha="$cand"; repo="$secondary"; break; fi
done <<< "$candidates"

[[ -n "$sha" ]] || { echo "SKIP: no REVIEW commit resolvable on $CARD"; exit 0; }

# Idempotent: do not re-post for a commit already triaged on this card. AUTHOR-based, not a raw
# content grep over the whole comments blob (Cybersec GO on d7ac3470, measured): a plain grep matches
# the marker text inside ANY comment, including a REVIEW that quotes a prior pre-triage block --
# exactly the same class this script's own header already guards the POST against ("as its own
# author so the comment is unmistakably pre-triage INPUT"), now applied to the read side too.
already_posted="$(MARKER="$MARKER" SHA="$sha" COMMENTS="$comments" python3 <<'PY' 2>/dev/null || true
import json, os
d = json.loads(os.environ["COMMENTS"]); rows = d if isinstance(d, list) else d.get("comments", [])
needle = f'{os.environ["MARKER"]} @ {os.environ["SHA"]}'
print("1" if any(c.get("author") == "gate-pretriage" and needle in (c.get("content") or "") for c in rows) else "")
PY
)"
if [[ -n "$already_posted" ]]; then
  echo "SKIP: pre-triage for $sha already on $CARD"; exit 0
fi

body="$(build_body "$repo" "$sha" "$title")" || { echo "SKIP: pre-triage could not run for $sha"; exit 0; }
if [[ $DRYRUN -eq 1 ]]; then printf '%s\n' "$body"; exit 0; fi

# Post as its own author so the comment is unmistakably pre-triage INPUT, not a gate verdict.
tmp="$(mktemp)"
BODY="$body" python3 -c 'import json, os; print(json.dumps({"author": "gate-pretriage", "content": os.environ["BODY"]}))' > "$tmp"
curl -s -X POST "$DASH/api/kanban/$CARD/comments" -H @"$hdr_file" -H 'Content-Type: application/json' --data @"$tmp" >/dev/null || true
rm -f "$tmp"
echo "posted pre-triage for $sha on $CARD"
