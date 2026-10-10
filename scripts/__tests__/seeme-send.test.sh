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
# 34573931 (RedHat A2): SEEME_INTERNAL_FILE/SEEME_DB_PATH only take effect with
# SEEME_TEST_MODE=1 -- without it, seeme-send.py ignores both and falls back to
# the real store/ paths, so a hijacked env cannot redirect the gate to an
# attacker-controlled file.
export SEEME_TEST_MODE=1
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
  consumed_at INTEGER, resolved_at INTEGER, action_description TEXT
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
  # insert_approval <id> <status> <content_hash> <consumed_at-or-NULL> <resolved_at-offset-seconds-or-NULL> [action_description]
  # action_description defaults to '' -- fine for every case that is expected
  # to be rejected BEFORE the description-binding check (status/consumed_at/
  # content_hash/freshness all run first in _diagnose_approval).
  python3 -c "
import sqlite3, sys, time
con = sqlite3.connect(sys.argv[1])
consumed = None if sys.argv[5] == 'NULL' else int(sys.argv[5])
resolved = None if sys.argv[6] == 'NULL' else int(time.time()) + int(sys.argv[6])
desc = sys.argv[7] if len(sys.argv) > 7 else ''
con.execute('INSERT INTO approvals (id, category, status, content_hash, consumed_at, resolved_at, action_description) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (sys.argv[2], 'external_message', sys.argv[3], sys.argv[4], consumed, resolved, desc))
con.commit()
con.close()
" "$SEEME_DB_PATH" "$1" "$2" "$3" "$4" "$5" "${6:-}"
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
insert_approval "$APPROVED_FRESH" "approved" "$ANCHOR" "NULL" "-60" "Cimzett: $TO
Szoveg: $TEXT"
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
insert_approval "$REAL_USE" "approved" "$(anchor_for "$TO" "$TEXT")" "NULL" "-60" "Cimzett: $TO
Szoveg: $TEXT"
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

echo "--- C1 (779b9660 CYBERED NO-GO, msg 14141): a leirasnak szo szerint tartalmaznia kell a cimzettet+szoveget ---"

NO_DESC="88888888-8888-8888-8888-888888888888"
insert_approval "$NO_DESC" "approved" "$(anchor_for "$TO" "$TEXT")" "NULL" "-60" ""
out="$(run "$TO" "$NO_DESC" "$TEXT")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "leirasa NEM tartalmazza" \
  && pass "egyezo hash, de a leiras NEM tartalmazza a cimzettet/szoveget -> elutasitva (C1)" \
  || fail "leiras-kotes elutasitast vartam, kaptam (rc=$rc): $out"

MISMATCHED_DESC="99999999-9999-9999-9999-999999999999"
insert_approval "$MISMATCHED_DESC" "approved" "$(anchor_for "$TO" "$TEXT")" "NULL" "-60" "SMS johavagyva, reszletek a jegyzekben."
out="$(run "$TO" "$MISMATCHED_DESC" "$TEXT")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "leirasa NEM tartalmazza" \
  && pass "egyezo hash, altalanos/nem-kotott leiras -> elutasitva (C1, a johavagyo nem ezt latta)" \
  || fail "leiras-kotes elutasitast vartam, kaptam (rc=$rc): $out"

BOUND_DESC="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
insert_approval "$BOUND_DESC" "approved" "$(anchor_for "$TO" "$TEXT")" "NULL" "-60" "Cimzett: $TO
Szoveg: $TEXT"
out="$(run "$TO" "$BOUND_DESC" "$TEXT")"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "approved, friss" \
  && pass "hash egyezik ES a leiras szo szerint tartalmazza a cimzettet+szoveget -> dry-run atmegy" \
  || fail "varva: dry-run siker kotott leirassal, kaptam (rc=$rc): $out"

echo "--- C2 (779b9660 CYBERED NO-GO, msg 14141): --approval validalva a BELSO agon is, \\Z nem \$ ---"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 36305552860 --approval "$(printf 'x\nFORGED\tOK\t1')" --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "nem UUID alaku" \
  && pass "tab/ujsor a --approval-ban, BELSO cimzettel -> elutasitva (korabban csak a KULSO agon validalt)" \
  || fail "belso-agi approval-validacios elutasitast vartam, kaptam (rc=$rc): $out"

out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 36305552860 --reference $'abc\n' --dry-run 2>&1)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "reference" \
  && pass "--reference zaro ujsorral -> elutasitva (\\Z nem engedi at a zaro ujsor elotti egyezest)" \
  || fail "zaro-ujsoros reference elutasitast vartam, kaptam (rc=$rc): $out"

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

echo "--- C3 (779b9660 CYBERED NO-GO, msg 14141): nem-objektum JSON valasz nem omlik AttributeError-ba ---"
out="$(python3 -c "
import sys, os
sys.path.insert(0, os.path.dirname('$SCRIPT'))
import importlib.util
spec = importlib.util.spec_from_file_location('seeme_send', '$SCRIPT')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
# A MERT HIBA: egy szintaktikailag ervenyes, de nem-objektum JSON valasz
# (null/[]/\"ok\"/1) a regi kodban payload.get()-nel AttributeError-t dobott.
print(m.is_usable_response_shape(None))
print(m.is_usable_response_shape([]))
print(m.is_usable_response_shape('ok'))
print(m.is_usable_response_shape(1))
print(m.is_usable_response_shape({'code': '0'}))
")"
expected="$(printf 'False\nFalse\nFalse\nFalse\nTrue')"
[ "$out" = "$expected" ] \
  && pass "is_usable_response_shape: null/[]/\"ok\"/1 elutasitva, dict elfogadva" \
  || fail "varva:\n$expected\nkaptam:\n$out"

echo "--- L1 (34573931, RedHat delta-GO 14242): sor-egyenloseg, nem reszsztring-tartalmazas ---"

out="$(python3 -c "
import sys, os
sys.path.insert(0, os.path.dirname('$SCRIPT'))
import importlib.util
spec = importlib.util.spec_from_file_location('seeme_send', '$SCRIPT')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
to, text = '36301234567', 'kattintson a http://x.example/l linkre'
# A MERT HIBA (RedHat): a reszsztring-tartalmazas a kovetkezoket mind
# atengedte -- a sor-egyenloseg mindharmat elutasitja.
print(m._description_binds('Cimzett: ' + to + '\n' + 'Szoveg: Ne kattintson a http://x.example/l linkre, csalas', to, text))
print(m._description_binds('Indok: hogy a \'Szoveg: ' + text + '\' uzenet NE menjen ki', to, text))
print(m._description_binds('Cimzett: 1' + to + '\nSzoveg: ' + text, to, text))
# A becsuletes eset tovabbra is atmegy.
print(m._description_binds('Cimzett: ' + to + '\nSzoveg: ' + text, to, text))
")"
expected="$(printf 'False\nFalse\nFalse\nTrue')"
[ "$out" = "$expected" ] \
  && pass "_description_binds: sor-egyenloseg zarja a trimmelt tagadast, az Indok-peldat es a hosszabb szamsorba agyazott cimzettet; a becsuletes eset atmegy" \
  || fail "varva:\n$expected\nkaptam:\n$out"

echo "--- L2 (34573931, RedHat delta-GO 14242): a ket fel (cimzett/szoveg) KULON pinnelve ---"

out="$(python3 -c "
import sys, os
sys.path.insert(0, os.path.dirname('$SCRIPT'))
import importlib.util
spec = importlib.util.spec_from_file_location('seeme_send', '$SCRIPT')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
to, text = '36301234567', 'A pontos szoveg.'
desc = 'Cimzett: ' + to + '\nSzoveg: ' + text
# Csak a cimzett-sor van jo: a szoveg-sor hianyzik/mas -> el kell utasitani.
print(m._description_binds('Cimzett: ' + to + '\nSzoveg: MAS szoveg.', to, text))
# Csak a szoveg-sor van jo: a cimzett-sor hianyzik/mas -> el kell utasitani.
print(m._description_binds('Cimzett: 36309999999\nSzoveg: ' + text, to, text))
# Mindketto jo -> atmegy.
print(m._description_binds(desc, to, text))
")"
expected="$(printf 'False\nFalse\nTrue')"
[ "$out" = "$expected" ] \
  && pass "_description_binds: a cimzett-sor ES a szoveg-sor is KULON-KULON kotelezo (egyik hianya/elteresese eleg az elutasitashoz)" \
  || fail "varva:\n$expected\nkaptam:\n$out"

out="$(python3 -c "
import sys, os
sys.path.insert(0, os.path.dirname('$SCRIPT'))
import importlib.util
spec = importlib.util.spec_from_file_location('seeme_send', '$SCRIPT')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
# A MERT HIBA (RedHat): a C3 kaput (is_usable_response_shape) egy teszt mar
# pinnelte, de a tenyleges AUDIT-SORT (amit log() tenylegesen kiir) semmi --
# egy mutans, ami kitorli a log()-hivast, zolden maradt volna.
line = m.ketertelmu_nonobject_log_line('2026-10-10T10:00:00+0200', '36301234567', 'ref-1', [])
print('KETERTELMU' in line and 'valasz-nem-objektum' in line and '36301234567' in line and 'ref-1' in line)
")"
[ "$out" = "True" ] \
  && pass "ketertelmu_nonobject_log_line: a C3 audit-sor tenylegesen tartalmazza a vart mezoket (nem csak a kapu, a naplo-tartalom is pinnelve)" \
  || fail "varva: True, kaptam: $out"

echo "--- L3 (34573931, RedHat delta-GO 14242): logsafe a split/price mezore a SIKERES agon ---"

out="$(python3 -c "
import sys, os
sys.path.insert(0, os.path.dirname('$SCRIPT'))
import importlib.util
spec = importlib.util.spec_from_file_location('seeme_send', '$SCRIPT')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
# A MERT HIBA (RedHat): egy rosszindulatu/MITM gateway valaszanak split/price
# mezojebe tett tab/ujsor egy TELJES, hamis OK-sort irt a naplo-fajlba, mert
# ezek a mezok logsafe nelkul kerultek a sorba. logsafe utan a sor EGY fizikai
# sor marad, a tab/ujsor szokozre cserelve.
payload = {'split': '1\n2026-10-10T09:00:00+0200\tOK\t36300000001\treference=forged\tapproval=peti', 'price': 'x\ty'}
line = m.ok_send_log_line('2026-10-10T10:00:00+0200', '36301234567', 'ref-1', payload, 'approval-id-1', 'szoveg')
print(line.count(chr(10)))
print('\t' not in line.split('ár=')[1].split('\tapproval=')[0])
")"
expected="$(printf '0\nTrue')"
[ "$out" = "$expected" ] \
  && pass "ok_send_log_line: a gateway split/price mezoje logsafe-elt -- nincs beagyazott ujsor/tab, nem keletkezik hamis sor" \
  || fail "varva:\n$expected\nkaptam:\n$out"

echo "--- A2 (34573931, RedHat): SEEME_INTERNAL_FILE/SEEME_DB_PATH csak SEEME_TEST_MODE=1 mellett szamit ---"

# A MERT HIBA: egy tamado-befolyasolt env (pl. prompt-injektalt agent) a
# SEEME_INTERNAL_FILE-t egy sajat, iro altala kontrollalt listara allithatta,
# amiben a "kulso" cimzett BELSONEK van megadva -- approval nelkul atment.
NOTREAL="36309998877"
FAKE_INTERNAL_LIST="$FIXTURE_DIR/attacker-internal-list.json"
printf '{"internal": ["%s"]}' "$NOTREAL" > "$FAKE_INTERNAL_LIST"
out="$(SEEME_TEST_MODE= SEEME_INTERNAL_FILE="$FAKE_INTERNAL_LIST" bash -c '
  printf "%s" "teszt" | python3 "$0" --to "$1" --dry-run 2>&1
' "$SCRIPT" "$NOTREAL")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "osztalyozas : KULSO" \
  && pass "SEEME_TEST_MODE nelkul a SEEME_INTERNAL_FILE felulirasat a szkript figyelmen kivul hagyja (a hamis 'belso' lista hatastalan)" \
  || fail "varva: KULSo osztalyozas (a felulirast el kellett volna utasitani), kaptam (rc=$rc): $out"

# A tamado egy sajat irhato SQLite-fajlra is iranyithatta a johavagyas-kaput,
# egy ELORE "approved"-ra allitott sorral -- a valodi kormanyzasi tablat
# megkerulve.
FAKE_DB="$FIXTURE_DIR/attacker-db.sqlite"
python3 -c "
import sqlite3, sys, time
con = sqlite3.connect(sys.argv[1])
con.execute('''CREATE TABLE approvals (
  id TEXT PRIMARY KEY, category TEXT, status TEXT, content_hash TEXT,
  consumed_at INTEGER, resolved_at INTEGER, action_description TEXT
)''')
con.execute('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?)',
            ('99999999-0000-0000-0000-000000000000', 'external_message', 'approved',
             '$(anchor_for "$TO" "$TEXT")', None, int(time.time()) - 60, 'Cimzett: $TO\nSzoveg: $TEXT'))
con.commit()
con.close()
" "$FAKE_DB"
out="$(SEEME_TEST_MODE= SEEME_DB_PATH="$FAKE_DB" bash -c '
  printf "%s" "'"$TEXT"'" | python3 "$0" --to "$1" --approval "$2" --dry-run 2>&1
' "$SCRIPT" "$TO" "99999999-0000-0000-0000-000000000000")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "adatbazis hianyzik" \
  && pass "SEEME_TEST_MODE nelkul a SEEME_DB_PATH felulirasat a szkript figyelmen kivul hagyja (az elore-approved hamis DB hatastalan)" \
  || fail "varva: 'adatbazis hianyzik' elutasitas (a felulirast el kellett volna utasitani), kaptam (rc=$rc): $out"

echo "--- A2 (34573931, RedHat): SEEME_APPROVAL_WINDOW_S-nek nincs hatasa (a frissesseg-ablak fix 1800s) ---"

# A MERT HIBA: a regi kodban SEEME_APPROVAL_WINDOW_S felulirta a frissesseg-
# ablakot -- egy 90 napos johavagyas egy felfujt ablakkal meg "friss"-nek
# szamitott. A STALE approval (fentebb, -99999 mp = kb. 27,8 ora) ugyanugy
# elutasitva kell maradjon, akkor is, ha a hivo folyamat egy ORIASI ablakot
# allit be.
out="$(SEEME_APPROVAL_WINDOW_S=999999999 bash -c '
  printf "%s" "'"$TEXT"'" | python3 "$0" --to "'"$TO"'" --approval "$1" --dry-run 2>&1
' "$SCRIPT" "$STALE")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -qi "tul regi" \
  && pass "SEEME_APPROVAL_WINDOW_S=999999999 nem menti meg a STALE approval-t -- a frissesseg-ablak fix" \
  || fail "varva: frissesseg-elutasitas (az env-nek nem kellett volna hatnia), kaptam (rc=$rc): $out"

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
