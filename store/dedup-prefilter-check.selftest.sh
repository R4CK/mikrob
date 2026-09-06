#!/usr/bin/env bash
# dedup-prefilter-check.selftest.sh -- hermetic cases for the dedup pre-filter (card 49be3576).
#
# WHY HERMETIC AND NOT "RUN IT ON THE BOARD": the tool's ONE demonstrated true positive
# (cff4fa09 vs fe2f71ca, the pair the whole heuristic was calibrated on) sits at position 877
# in the done-card list ordered by updated_at. The default lookback is 200. So the founding
# case has been OUT OF RANGE on the live board for a long time, and a run there proves nothing
# about the signal -- it only proves the window. A fixture keeps the founding case reachable
# forever, which is the point of pinning it at all.
set -uo pipefail
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dedup-prefilter-check.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
passed=0
failed=0
ok()   { printf '  PASS  %s\n' "$1"; passed=$((passed+1)); }
bad()  { printf '  FAIL  %s\n       %s\n' "$1" "$2"; fail=1; failed=$((failed+1)); }

# The tool hardcodes STORE=/home/neon/marveen/store, so point it at a fixture root instead by
# copying the script beside a fixture db and rewriting only that one path.
root="$TMP/store"; mkdir -p "$root"
DB="$root/claudeclaw.db"
sed "s#^STORE=.*#STORE=\"$root\"#" "$SCRIPT" > "$root/dedup-prefilter-check.sh"
# THE HARNESS MUST NOT BE ABLE TO PASS BY NOT RUNNING. Four of these six cases assert "no match",
# and a bed that never reaches the fixture db returns exactly that -- measured while writing this
# file: DB pointed one directory above `root`, the tool answered {"error":"claudeclaw.db not
# found"} for every case, and the two negative cases reported PASS. So every run is checked for an
# error field first, and a case that produces one is a HARNESS FAULT, not a result.
run() {
  local out; out="$(bash "$root/dedup-prefilter-check.sh" "$1" "${2:-200}")"
  if printf '%s' "$out" | grep -q '"error"'; then
    printf 'HARNESS FAULT: %s\n' "$out" >&2; fail=1; printf '{"match":"HARNESS-FAULT"}'; return
  fi
  printf '%s' "$out"
}
match_id() { python3 -c "import json,sys;d=json.load(sys.stdin);m=d.get('match');print('HARNESS-FAULT' if m=='HARNESS-FAULT' else (m['doneCardId'] if m else 'NONE'))"; }
match_reason() { python3 -c "import json,sys;d=json.load(sys.stdin);m=d.get('match');print('HARNESS-FAULT' if m=='HARNESS-FAULT' else (m['reason'] if m else 'NONE'))"; }

BLOCK='[DEDUP-PREFILTER] Lehetséges duplikátum: zzzz0001 "[marveen][INFRA][LOW] valami mas kartya" (közösen hivatkozott ID(k): SHAREDREF). Ellenőrizd a hivatkozott kártyát, mielőtt folytatod -- ha ugyanazt a problémát oldja meg, ne kezdj bele, inkább kommentelj rá a meglévőre (rule 6b).'

seed() {  # $1 = python snippet adding rows
  rm -f "$DB"
  python3 - "$DB" "$BLOCK" <<PY
import sqlite3, sys
db, BLOCK = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
c.execute("CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, updated_at INTEGER)")
def add(i, t, d, s='done', u=1000):
    c.execute("INSERT INTO kanban_cards VALUES (?,?,?,?,?)", (i, t, d, s, u))
$1
c.commit()
PY
}

echo "== 1. SELF-CONTAMINATION: a ref that exists ONLY inside the tool's own block must not match"
seed "
add('aaaa0001','ratchet baseline szuro finomitas','A leiras sajat szoveg, semmi kozos hivatkozas. '+BLOCK.replace('SHAREDREF','deadbeef'),'planned',2000)
add('bbbb0002','teljesen mas temaju kartya kesz','Onallo szoveg mas szavakkal. '+BLOCK.replace('SHAREDREF','deadbeef'))
"
got="$(run aaaa0001 | match_id)"
[ "$got" = "NONE" ] && ok "no match when the shared ref lives only in prefilter blocks" \
                    || bad "no match when the shared ref lives only in prefilter blocks" "got $got"

echo "== 2. CONTROL for case 1: the SAME ref, author-written, MUST still match"
seed "
add('aaaa0001','ratchet baseline szuro finomitas','Ez a deadbeef lelete alapjan keszult, sajat szoveg.','planned',2000)
add('bbbb0002','teljesen mas temaju kartya kesz','Szinten a deadbeef kartyabol nott ki, mas szavakkal.')
"
got="$(run aaaa0001 | match_id)"; why="$(run aaaa0001 | match_reason)"
[ "$got" = "bbbb0002" ] && [ "$why" = "shared-reference" ] \
  && ok "author-written shared reference still matches (the signal is narrowed, not removed)" \
  || bad "author-written shared reference still matches" "got $got / $why"

echo "== 3. THE FOUNDING TRUE POSITIVE (cff4fa09 vs fe2f71ca, shared root 34c4840e) survives"
seed "
add('cff4fa09','Git-integritas orszem: race-vs-korrupcio alairas megkulonboztetese (34c4840e kovetkezmenye)','Cybered lelete (34c4840e GO-komment): a store/git-object-integrity-monitor.sh egy TELJES git fsck-t futtat a megosztott klonon.','planned',2000)
add('fe2f71ca','CleanCore fsck-sweep idozitesi vizsgalat lezarva','Backend 3 izolalt fsck-futtatast vegzett CleanCore-on (34c4840e/1da2367a korabbi FAIL-ek kapcsan).')
"
got="$(run cff4fa09 | match_id)"
[ "$got" = "fe2f71ca" ] && ok "the pair the heuristic was calibrated on is still found" \
                        || bad "the pair the heuristic was calibrated on is still found" "got $got"

echo "== 4. The block's BOILERPLATE must not carry a lexical match on its own"
# Two cards with no real vocabulary in common; only the block prose is shared. The block is long
# enough that its words alone cleared BOTH lexical thresholds on the live board (0.41 / 34 words).
seed "
add('aaaa0001','alfa','xxxa xxxb xxxc xxxd. '+BLOCK.replace('SHAREDREF','11110000'),'planned',2000)
add('bbbb0002','beta','yyya yyyb yyyc yyyd. '+BLOCK.replace('SHAREDREF','22220000'))
"
got="$(run aaaa0001 | match_id)"
[ "$got" = "NONE" ] && ok "shared block boilerplate alone does not reach the lexical threshold" \
                    || bad "shared block boilerplate alone does not reach the lexical threshold" "got $got"

echo "== 5. Text AFTER the block is still compared (the strip must not run to end-of-text)"
seed "
add('aaaa0001','alfa','$BLOCK'.replace('SHAREDREF','11110000')+' Ezt a kartyat a cafe1234 lelete szulte, es ez a mondat a blokk UTAN all.','planned',2000)
add('bbbb0002','beta','Szinten a cafe1234 nyoman keszult, sajat szoveggel.')
"
got="$(run aaaa0001 | match_id)"
[ "$got" = "bbbb0002" ] && ok "an author-written ref AFTER the block is still seen" \
                        || bad "an author-written ref AFTER the block is still seen" "got $got"

echo "== 6. A block MISSING its canonical tail drops only that line, not the rest"
seed "
add('aaaa0001','alfa','[DEDUP-PREFILTER] Lehetséges duplikátum: zzzz0001 (közösen hivatkozott ID(k): 11110000) csonka blokk tail nelkul\nEz a kovetkezo sor a cafe1234 lelete alapjan keszult.','planned',2000)
add('bbbb0002','beta','Szinten a cafe1234 nyoman keszult, sajat szoveggel.')
"
got="$(run aaaa0001 | match_id)"
[ "$got" = "bbbb0002" ] && ok "a tail-less block costs one line, not the rest of the card" \
                        || bad "a tail-less block costs one line, not the rest of the card" "got $got"

echo
# The COUNT is required, not decorative: store-selftests-all-run.test.ts refuses a summary that
# does not state a non-zero number, precisely so "ran every case and they passed" cannot look the
# same as "ran nothing". Same shape as offload-dispatch.selftest.sh.
echo "dedup-prefilter-check.selftest: $passed passed, $failed failed"
exit "$fail"
