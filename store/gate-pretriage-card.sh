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

CARD=""; REPO=""; SHA=""; DRYRUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRYRUN=1; shift ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
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

# Build the INPUT comment body for repo+sha. Prints the body; returns 3 (benign skip) if the commit is
# not present or the pre-triage cannot run. The body deliberately contains NO PASS/FAIL/GO/NO-GO word.
build_body() {
  local repo="$1" sha="$2" json
  [[ -d "$repo/.git" ]] || return 3
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || return 3
  json="$(bash "$PRETRIAGE" --repo "$repo" --base "${sha}~1" --head "$sha" --json 2>/dev/null)" || return 3
  MARKER="$MARKER" SHA="$sha" REPO="$repo" PT_JSON="$json" python3 <<'PY'
import json, os
d = json.loads(os.environ["PT_JSON"])
repo = os.path.basename(os.environ["REPO"].rstrip("/"))
out = [
    f'{os.environ["MARKER"]} @ {os.environ["SHA"]}',
    "Ez NEM gate-verdikt -- a gate BEMENETE: helyben futott, determinisztikus mechanikus elso kor,",
    "hogy a QA/Cybersec ne online tokenert deritse ki ugyanezt. A gate a valos reviewt tovabbra is elvegzi.",
    "",
    f'repo: {repo}   tsc: {d.get("tsc")}   valtozott fajlok: {d.get("changed_files")}',
]
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
  if body="$(build_body "$REPO" "$SHA")"; then printf '%s\n' "$body"; else echo "SKIP: commit $SHA not in $REPO (or pre-triage failed)"; fi
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

# CANDIDATE commits from the comments, NEWEST REVIEW FIRST (card d7ac3470). A card id is ALSO an
# 8-hex token, so a regex alone cannot tell a short SHA from a card id -- the disambiguation is "does
# it resolve to a real commit" (below). The ordering lives in its own tracked, TESTABLE file because
# the bug it fixes was invisible from here: the old inline version let an old comment's `commit <sha>`
# wording outrank a newer comment's fresh sha, and it fed on its own previous output.
candidates="$(printf '%s' "$comments" | python3 "$(dirname "${BASH_SOURCE[0]}")/gate-pretriage-candidates.py" "$CARD" "$MARKER" 2>/dev/null || true)"

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

# Idempotent: do not re-post for a commit already triaged on this card.
if printf '%s' "$comments" | grep -qF "$MARKER @ $sha"; then
  echo "SKIP: pre-triage for $sha already on $CARD"; exit 0
fi

body="$(build_body "$repo" "$sha")" || { echo "SKIP: pre-triage could not run for $sha"; exit 0; }
if [[ $DRYRUN -eq 1 ]]; then printf '%s\n' "$body"; exit 0; fi

# Post as its own author so the comment is unmistakably pre-triage INPUT, not a gate verdict.
tmp="$(mktemp)"
BODY="$body" python3 -c 'import json, os; print(json.dumps({"author": "gate-pretriage", "content": os.environ["BODY"]}))' > "$tmp"
curl -s -X POST "$DASH/api/kanban/$CARD/comments" -H @"$hdr_file" -H 'Content-Type: application/json' --data @"$tmp" >/dev/null || true
rm -f "$tmp"
echo "posted pre-triage for $sha on $CARD"
