#!/usr/bin/env bash
# dedup-prefilter-check.sh -- cheap title/description overlap pre-filter for
# folyamatos-munka-orchestrator, before it dispatches an OLD (>2 day, rule 6b) planned card.
#
# WHY (card 43878b8f, Backend jelzese 2026-08-17): rule 6b's dedup check today only fires
# before OPENING a brand-new card. Four already-open planned cards (c0a0e94d, f4e6f185,
# d4c3f427, cff4fa09) sat in the queue while a later-opened, already-done card quietly
# solved the same problem -- each one only got caught live, per-card, after a full
# dispatch+build cycle. This is a PRE-DISPATCH heuristic, not a verdict: it flags a likely
# duplicate so the orchestrator can skip auto-dispatching it THIS cycle and let a human/
# agent verify, instead of burning a full build cycle on probably-redundant work.
#
# NOT full semantic dedup (out of scope, card explicitly asked for "olcso, gyors elo-szures").
# Two cheap signals, calibrated against a REAL confirmed-duplicate pair from this card's own
# motivating incident (cff4fa09 vs. fe2f71ca -- Backend's REVIEW named fe2f71ca as the card
# that had already solved it) plus a 15-card random sample of unrelated done cards, because
# the naive "lexical score >= 0.5" first draft MISSED the real pair (0.16, buried by long
# descriptions) while a lowered threshold would have FALSE-POSITIVED on unrelated cards
# sharing generic infra vocabulary (up to 0.17 / 10 shared words in the random sample):
#   1. SHARED CARD-ID REFERENCE (primary, high-confidence): both cards cite the same other
#      card's 7-8 char hex id in their title/description (this fleet's own convention for
#      "X kovetkezmenye" / "Y lelete" back-references -- confirmed on the real pair: both
#      cff4fa09 and fe2f71ca cited 34c4840e as the shared root-cause card). Zero false
#      positives against the 15-card random sample.
#   2. LEXICAL OVERLAP (secondary, lower-confidence): significant words (>=4 chars, boilerplate
#      tags + common Hungarian glue words stripped), scored as |shared| / min(|target words|,
#      |done-card words|). Flags only at score >= 0.35 AND >= 8 shared words -- calibrated
#      above the random-sample noise band (max observed there: score 0.17, 10 shared, never
#      both at once) but this band was measured on ONE 15-card sample, not proven -- treat as
#      a heuristic that can still misfire, not a guarantee.
# Read-only query against store/claudeclaw.db directly, because GET /api/kanban truncates
# 'done' cards (memory: kanban-api-truncates-done-not-open) -- the API is fine for open cards
# but NOT for scanning history.
#
# Usage:  bash store/dedup-prefilter-check.sh <cardId> [doneLookbackCount=200]
# Output: single JSON line to stdout, always exit 0 (informational, never blocks the caller):
#   {"cardId":"...", "match": null}                                    -- no likely duplicate
#   {"cardId":"...", "match": {"doneCardId":"...","doneTitle":"...",
#                              "reason":"shared-reference","sharedRefs":["34c4840e"]}}
#   {"cardId":"...", "match": {"doneCardId":"...","doneTitle":"...",
#                              "reason":"lexical-overlap","score":0.41,"sharedWords":[...]}}
#   {"error":"..."}                                                     -- bad input / no such card
#
# Caller contract: on a non-null match, do NOT dispatch this card this cycle. Instead
# comment on it (reference the matched done card id) and move to the next-highest-priority
# dispatchable card. A wrong flag costs one skipped cycle, not a broken card -- MikroB/the
# next self-advance pass can still dispatch it normally if the match turns out to be a
# false positive.
set -uo pipefail

STORE="/home/neon/marveen/store"
DB="${STORE}/claudeclaw.db"
CARD_ID="${1:-}"
LOOKBACK="${2:-200}"

if [ -z "$CARD_ID" ]; then
  echo '{"error":"usage: dedup-prefilter-check.sh <cardId> [doneLookbackCount]"}'
  exit 0
fi
if [ ! -f "$DB" ]; then
  echo '{"error":"claudeclaw.db not found"}'
  exit 0
fi

python3 - "$DB" "$CARD_ID" "$LOOKBACK" <<'PY'
import sqlite3, sys, re, json

db_path, card_id, lookback = sys.argv[1], sys.argv[2], int(sys.argv[3])
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

row = conn.execute(
    "SELECT id, title, description FROM kanban_cards WHERE id = ?", (card_id,)
).fetchone()
if row is None:
    print(json.dumps({"error": f"card {card_id} not found"}))
    sys.exit(0)

# Boilerplate tags + common Hungarian glue words that appear on nearly every card title/
# description and would otherwise swamp a lexical-overlap signal with noise.
STOPWORDS = {
    "mikrob", "infra", "low", "normal", "high", "urgent", "gate", "card", "kartya",
    "hogy", "mint", "vagy", "nincs", "van", "ezt", "azt", "erre", "arra", "ennek",
    "annak", "amit", "amely", "amelyik", "ahol", "amikor", "miutan", "mielott",
    "ezert", "tehat", "csak", "meg", "mar", "ide", "oda", "igy", "ugy", "ket",
    "het", "egy", "minden", "barmi", "utan", "elott", "kell", "lehet", "volt",
}


def tokenize(text):
    if not text:
        return set()
    words = re.findall(r"[a-zA-Z0-9À-ſ]{4,}", text.lower())
    return {w for w in words if w not in STOPWORDS}


ID_RE = re.compile(r"\b[0-9a-f]{7,8}\b")


def referenced_ids(text, own_id):
    if not text:
        return set()
    return {t for t in ID_RE.findall(text.lower()) if t != own_id}


target_words = tokenize(row["title"]) | tokenize(row["description"] or "")
target_refs = referenced_ids(row["title"], card_id) | referenced_ids(row["description"] or "", card_id)
if len(target_words) < 3:
    print(json.dumps({"cardId": card_id, "match": None, "reason": "too-few-significant-words"}))
    sys.exit(0)

done_rows = conn.execute(
    "SELECT id, title, description FROM kanban_cards "
    "WHERE status = 'done' ORDER BY updated_at DESC LIMIT ?",
    (lookback,),
).fetchall()

ref_match = None
lex_match = None
for d in done_rows:
    if d["id"] == card_id:
        continue
    done_words = tokenize(d["title"]) | tokenize(d["description"] or "")
    done_refs = referenced_ids(d["title"], d["id"]) | referenced_ids(d["description"] or "", d["id"])

    # Signal 1 (primary): both cards cite the same other card's id.
    shared_refs = target_refs & done_refs
    if shared_refs and ref_match is None:
        ref_match = {
            "doneCardId": d["id"],
            "doneTitle": d["title"],
            "reason": "shared-reference",
            "sharedRefs": sorted(shared_refs),
        }

    # Signal 2 (secondary, only tracked if no reference-match found yet).
    if done_words and ref_match is None:
        shared = target_words & done_words
        if len(shared) >= 8:
            score = len(shared) / min(len(target_words), len(done_words))
            if score >= 0.35 and (lex_match is None or score > lex_match["score"]):
                lex_match = {
                    "doneCardId": d["id"],
                    "doneTitle": d["title"],
                    "reason": "lexical-overlap",
                    "score": round(score, 2),
                    "sharedWords": sorted(shared)[:12],
                }

best = ref_match or lex_match
print(json.dumps({"cardId": card_id, "match": best}))
PY
