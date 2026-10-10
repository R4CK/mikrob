#!/bin/bash
# scripts/sms/seeme-send.py teszt -- kartya `adbabf7f`, marveen 4. kikötese: a
# negativ kontroll TUDJON MEGBUKNI (szerkezetileg kepes "nem"-et adni), ne csak
# egyszer atmenjen. Az utolso szakasz ezt EGY MUTACIOVAL igazolja: a kapu-agat
# kiveszi egy IDEIGLENES masolatbol, es ELVARJA, hogy AKKOR a teszt buktassa el
# azt, ami az eredetin PASS volt.
set -u
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/sms/seeme-send.py"

FAILED=0
pass(){ echo "  PASS  $*"; }
fail(){ echo "  FAIL  $*"; FAILED=1; }

# HERMETIKUS FIXTURE-OK -- kartya `fda30df6`-hoz hasonlo osztaly, itt meg
# eles kiadas elott elkapva: a `store/` gitignore-olt, tehat egy FRIS
# checkout (CI, uj worktree) SOSEM latja az EN sajat, nem-committolt
# store/seeme-internal-numbers.json-omat. A +36305552860 teszt-szam ezert
# csak NALAM klasszifikalodott BELSo-kent -- CI-n a szkript minden cimzettet
# KULSonek latott ("a fajl NEM LETEZIK"), es a script-tests-runner.test.ts
# PIROSAT adott. A fixture SAJAT, eldobhato temp konyvtarban el, es a szkript
# env-valtozon at latja (seeme-send.py: SEEME_INTERNAL_FILE) -- a valodi
# store/ tartalmat egyaltalan nem erinti a teszt.
FIXTURE_DIR="$(mktemp -d /tmp/seeme-send-fixtures-XXXX)"
export SEEME_INTERNAL_FILE="$FIXTURE_DIR/seeme-internal-numbers.json"
printf '{"internal": ["36305552860"]}' > "$SEEME_INTERNAL_FILE"

# 779b9660 (fd10c70b WhiteHat F1): a jovahagyas-ellenorzes most kozvetlen
# SQLite-ra megy (SEEME_DB_PATH), nem HTTP-re -- a fixture tehat egy sajat,
# eldobhato DB-fajl a valodi approvals tabla minimalis also-halmazaval.
export SEEME_DB_PATH="$FIXTURE_DIR/claudeclaw.db"
python3 -c "
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute('''CREATE TABLE approvals (
  id TEXT PRIMARY KEY, category TEXT, status TEXT, content_hash TEXT,
  consumed_at INTEGER, resolved_at INTEGER
)''')
con.commit()
con.close()
" "$SEEME_DB_PATH"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

anchor_for() {
  # anchor_for <to> <text> -- the exact hash seeme-send.py will compute
  python3 -c "import hashlib,sys; print(hashlib.sha256((sys.argv[1]+chr(10)+sys.argv[2]).encode()).hexdigest())" "$1" "$2"
}

insert_approval() {
  # insert_approval <id> <status> <content_hash> <consumed_at-or-NULL> <resolved_at-offset-seconds-or-NULL>
  python3 -c "
import sqlite3, sys, time
con = sqlite3.connect(sys.argv[1])
consumed = None if sys.argv[5] == 'NULL' else int(sys.argv[5])
resolved = None if sys.argv[6] == 'NULL' else int(time.time()) + int(sys.argv[6])
con.execute('INSERT INTO approvals (id, category, status, content_hash, consumed_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)',
            (sys.argv[2], 'external_message', sys.argv[3], sys.argv[4], consumed, resolved))
con.commit()
con.close()
" "$SEEME_DB_PATH" "$1" "$2" "$3" "$4" "$5"
}

consumed_at_of() {
  python3 -c "
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
row = con.execute('SELECT consumed_at FROM approvals WHERE id=?', (sys.argv[2],)).fetchone()
print(row[0] if row else 'MISSING')
" "$SEEME_DB_PATH" "$1"
}

run() {
  # run <to> <approval-or-empty> <stdin-text>
  local to="$1" approval="$2" text="$3"
  local args=(--to "$to" --dry-run)
  [ -n "$approval" ] && args=(--to "$to" --approval "$approval" --dry-run)
  printf '%s' "$text" | python3 "$SCRIPT" "${args[@]}" 2>&1
}

run_real() {
  # run_real <to> <approval> <text> -- WITHOUT --dry-run (no SEEME_BASE/creds
  # fixture exists, so this always dies at read_env() -- used only to observe
  # whether consume_approval() ran before that point).
  local to="$1" approval="$2" text="$3"
  printf '%s' "$text" | python3 "$SCRIPT" --to "$to" --approval "$approval" 2>&1
}

echo "--- alapveto osztalyozas es normalizalas ---"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to +36305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "osztalyozas : BELSO" \
  && pass "sajat szam (+36305552860) BELSo, exit 0" \
  || fail "sajat szam BELSo varva, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 06305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "cimzett     : 36305552860" \
  && pass "06-os alak ugyanarra a kanonikus szamra normalizal, mint a +36-os" \
  || fail "06-os normalizalas varva, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 36305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "osztalyozas : BELSO" \
  && pass "csupasz 36-os alak is BELSo" \
  || fail "csupasz 36-os alak varva BELSo, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to +36301234567 --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "KULSO cimzett, es nincs --approval" \
  && pass "ismeretlen szam KULSo, approval nelkul elutasitva (rc=1)" \
  || fail "KULSo elutasitas varva, kaptam (rc=$rc): $out"

echo "--- hibas bemenet ---"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to "nem-egy-telefonszam" --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "nem magyar mobilszam" \
  && pass "ertelmezhetetlen szam elutasitva" \
  || fail "ertelmezhetetlen szam elutasitasat vartam, kaptam (rc=$rc): $out"

out="$(printf '%s' "" | python3 "$SCRIPT" --to +36305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "ures a szoveg" \
  && pass "ures STDIN elutasitva" \
  || fail "ures STDIN elutasitasat vartam, kaptam (rc=$rc): $out"

long_text="$(python3 -c "print('a'*1601)")"
out="$(printf '%s' "$long_text" | python3 "$SCRIPT" --to +36305552860 --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "1601 karakter" \
  && pass "1600 karakter feletti szoveg elutasitva" \
  || fail "hossz-limit elutasitasat vartam, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to +36301234567 --approval "nem-letezo-approval-id-xyz" --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "nem UUID alaku" \
  && pass "nem UUID-alaku approval-id -> formatum-hiba, elutasitva (DB meg sem kerdezve)" \
  || fail "formatum-elutasitast vartam, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to +36301234567 --approval "00000000-0000-0000-0000-000000000000" --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "nincs ilyen approval" \
  && pass "UUID-alaku, de nem letezo approval-id -> elutasitva" \
  || fail "nem-letezo approval elutasitasat vartam, kaptam (rc=$rc): $out"

echo "--- F1 (779b9660): egyszer-hasznalatos, friss, szoveghez kotott approval ---"

TO="36301234567"
TEXT="A pontos szoveg, amire a johavagyas szol."
ANCHOR="$(anchor_for "$TO" "$TEXT")"

APPROVED_FRESH="11111111-1111-1111-1111-111111111111"
insert_approval "$APPROVED_FRESH" "approved" "$ANCHOR" "NULL" "-60"
out="$(run "$TO" "$APPROVED_FRESH" "$TEXT")"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "approved, friss" \
  && pass "approved + friss + egyezo hash -> dry-run atmegy" \
  || fail "varva: dry-run siker, kaptam (rc=$rc): $out"
[ "$(consumed_at_of "$APPROVED_FRESH")" = "None" ] \
  && pass "dry-run NEM consume-olta az approval-t (consumed_at meg NULL)" \
  || fail "a dry-runnak nem kellett volna consume-olnia, de consumed_at mar ki van toltve"

WRONG_TEXT_MATCH="22222222-2222-2222-2222-222222222222"
insert_approval "$WRONG_TEXT_MATCH" "approved" "$ANCHOR" "NULL" "-60"
out="$(run "$TO" "$WRONG_TEXT_MATCH" "MAS szoveg, mint amire a johavagyas szol.")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "content_hash" \
  && pass "egyezo approval, de MAS szoveg a kuldeskor -> elutasitva (hash nem egyezik)" \
  || fail "szoveg-kotes elutasitasat vartam, kaptam (rc=$rc): $out"

WRONG_NUMBER="33333333-3333-3333-3333-333333333333"
insert_approval "$WRONG_NUMBER" "approved" "$ANCHOR" "NULL" "-60"
out="$(run "36309999999" "$WRONG_NUMBER" "$TEXT")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "content_hash" \
  && pass "egyezo approval, de MAS cimzett a kuldeskor -> elutasitva (hash nem egyezik)" \
  || fail "cimzett-kotes elutasitasat vartam, kaptam (rc=$rc): $out"

STALE="44444444-4444-4444-4444-444444444444"
insert_approval "$STALE" "approved" "$(anchor_for "$TO" "$TEXT")" "NULL" "-99999"
out="$(run "$TO" "$STALE" "$TEXT")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "tul regi" \
  && pass "100000 masodperce dontott approval -> elutasitva (nem friss)" \
  || fail "frissesseg-elutasitast vartam, kaptam (rc=$rc): $out"

PENDING="55555555-5555-5555-5555-555555555555"
insert_approval "$PENDING" "pending" "$(anchor_for "$TO" "$TEXT")" "NULL" "NULL"
out="$(run "$TO" "$PENDING" "$TEXT")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "nem 'approved'" \
  && pass "pending approval -> elutasitva" \
  || fail "pending-elutasitast vartam, kaptam (rc=$rc): $out"

ALREADY_USED="66666666-6666-6666-6666-666666666666"
insert_approval "$ALREADY_USED" "approved" "$(anchor_for "$TO" "$TEXT")" "$(( $(date +%s) - 10 ))" "-60"
out="$(run "$TO" "$ALREADY_USED" "$TEXT")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "MAR FELHASZNALT" \
  && pass "mar consumed_at-tal rendelkezo approval -> elutasitva (egyszer-hasznalatos)" \
  || fail "mar-felhasznalt elutasitast vartam, kaptam (rc=$rc): $out"

echo "--- F1: a valodi (nem dry-run) kuldesi probalkozas tenyleg elfogyasztja ---"
REAL_USE="77777777-7777-7777-7777-777777777777"
insert_approval "$REAL_USE" "approved" "$(anchor_for "$TO" "$TEXT")" "NULL" "-60"
out1="$(run_real "$TO" "$REAL_USE" "$TEXT")"; rc1=$?
[ $rc1 -eq 1 ] && echo "$out1" | grep -qi "credentials" \
  && pass "valodi utra terve: a hitelesito-adat hianyan all el (varhato, nincs fixture .env)" \
  || fail "credentials-hibat vartam a valodi uton, kaptam (rc=$rc1): $out1"
[ "$(consumed_at_of "$REAL_USE")" != "None" ] \
  && pass "a VALODI (nem dry-run) probalkozas CONSUME-OLTA az approval-t, meg a sikertelen kuldes ELLENERE is" \
  || fail "a valodi probalkozasnak consume-olnia kellett volna, de consumed_at meg NULL"

out2="$(run_real "$TO" "$REAL_USE" "$TEXT")"; rc2=$?
[ $rc2 -eq 1 ] && echo "$out2" | grep -qi "MAR FELHASZNALT" \
  && pass "UJBOLI probalkozas UGYANAZZAL az approval-lal -> elutasitva (egyszer-hasznalatos a consume utan is)" \
  || fail "masodik-hasznalat-elutasitast vartam, kaptam (rc=$rc2): $out2"

echo "--- F3 (779b9660): --reference es --approval validalas ---"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 36305552860 --reference "$(printf 'x\ty\nFORGED\tOK\t1')" --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "reference" \
  && pass "tab/ujsor a --reference-ben -> elutasitva (naplosor-hamisitas lezarva)" \
  || fail "reference-validacios elutasitast vartam, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 36305552860 --reference "rendben-123.ok_1" --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] \
  && pass "engedett karakterkeszletu --reference atmegy" \
  || fail "varva: siker rendben alaku referenciaval, kaptam (rc=$rc): $out"

echo "--- F2 (779b9660): hianyzo 'code' mezo NEM szamit sikernek ---"
out="$(python3 -c "
import sys, os
sys.path.insert(0, os.path.dirname('$SCRIPT'))
import importlib.util
spec = importlib.util.spec_from_file_location('seeme_send', '$SCRIPT')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
# A MERT HIBA: HTTP 200 {\"error\":\"invalid key\"}, nincs 'code' mezo.
print(m.seeme_response_ok({'error': 'invalid key'}))
print(m.seeme_response_ok({'code': '0'}))
print(m.seeme_response_ok({'result': 'OK'}))
print(m.seeme_response_ok({'code': '1', 'message': 'elutasitva'}))
")"
expected="$(printf 'False\nTrue\nTrue\nFalse')"
[ "$out" = "$expected" ] \
  && pass "seeme_response_ok: hianyzo code=HIBA, code=0/result=OK=SIKER, mas code=HIBA" \
  || fail "varva:\n$expected\nkaptam:\n$out"

echo "--- mutacios kontroll (4. kikotes: a kontroll TUDJON bukni) ---"
MUT="$(mktemp /tmp/seeme-send-mutated-XXXX.py)"
trap 'rm -f "$MUT"; rm -rf "$FIXTURE_DIR"' EXIT
# A TELJES kulso-agat kivesszuk: az `if not is_internal:` felteteltdet mindig-
# hamisra cachereljuk, tehat egy KULSO szam is BELSOKENT viselkedik -- approval
# nelkul is atmegy.
sed 's/if not is_internal:/if False:/' "$SCRIPT" > "$MUT"
if ! diff -q "$SCRIPT" "$MUT" >/dev/null 2>&1; then
  pass "a mutacio ténylegesen mas szoveget hozott letre (nem no-op sed)"
else
  fail "a sed minta NEM talalt semmit -- a mutacio nem valtoztatott a fajlon"
fi

out="$(printf '%s' "teszt" | python3 "$MUT" --to +36301234567 --dry-run 2>&1)"; rc=$?
if [ $rc -eq 0 ]; then
  pass "MUTALT valtozat: a kapu-ag kivetelevel a KULSo szam approval NELKuL is atmegy -- a kontroll TUD bukni"
else
  fail "a mutacio nem valtoztatta meg a viselkedest (rc=$rc) -- a fenti teszt NEM ezt a kaput meri"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "OSSZES PASS"
  exit 0
else
  echo "VAN BUKOTT TESZT"
  exit 1
fi
