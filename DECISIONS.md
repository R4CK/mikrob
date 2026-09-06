# Döntésnapló

Append-only, grep-elhető döntés-történet erre a projektre (marveen/MikroB). Új bejegyzés mindig a
fájl VÉGÉRE kerül. Formátum és eljárás: `project-decisions-log` skill. NE ide írj: folyamatban lévő
munka státusza (az a kanban), kódrészletek/implementációs terv (az a kártya leírása).

## 2026-08-20 06:00 -- Upstream v1.33.0 merge a MikroB repóba

**Döntés:** Peti kérésére elvégeztem a teljes upstream (Szotasz/marveen) merge-et a MikroB fork
(R4CK/mikrob) develop ágába. 12 ütköző fájl kézzel megoldva, a fork-specifikus biztonsági/gate-guardok
(Firecrawl-allowlist, GitHub-quarantine-domain, kvóta/gate-guardok, modularizált `web/app.js`) mind
megmaradtak; upstream új funkciói (verzió-kijelzés, kanban `actor` mező, idle-flush FE UI) bekötve a
megfelelő modul-fájlokba.
**Miért:** Peti hosszú távú célja az upstream repóra való visszaállás; ez konkrét lépés afelé.
**Ki döntött:** Peti (kérés) + MikroB (végrehajtás, technikai döntések a konfliktus-feloldásban).
**Hivatkozás:** commit 8123b1d6.

## 2026-08-20 06:20 -- Működő funkció védelme (CLAUDE.md 5. szabály)

**Döntés:** Egy már működő, élesített funkciót kizárólag Peti kifejezett utasítására szabad
módosítani/visszavonni, akkor is ha egy másik munka "véletlenül" érintené.
**Miért:** Peti explicit direktívája, hogy a fejlesztés soha ne írjon felül igazoltan működő eredményt
kérdés nélkül.
**Ki döntött:** Peti.
**Hivatkozás:** commit 7df6910c, CLAUDE.md 5. szabály.

## 2026-08-20 06:35 -- Kódminőségi/projektmenedzsment szabályok bővítése (6-11. + 8b.)

**Döntés:** Hat új szabály (strukturális védelem, regressziós alapvonal, funkció-tulajdonos jelölés,
kockázatos változtatás flag/ág mögött, blast-radius ellenőrzés, tesztelt rollback-út) plusz a 8b.
szabály (BE+FE párhuzamos wiring kötelező, nem gyakorlat).
**Miért:** Peti kérte a korábbi négy saját javaslatom beépítését, plusz kettőt magam adtam hozzá; a
8b. a "minden backend funkció legyen párhuzamosan FE-re kivezetve és tesztelve" explicit kérésére.
**Ki döntött:** Peti (jóváhagyás) + MikroB (a két kiegészítő javaslat: blast-radius, rollback-teszt).
**Hivatkozás:** commit 26ca9994.

## 2026-08-20 06:50 -- git-repo-watcher: kötelező záró lépés a sárga riasztás törlésére

**Döntés:** A `git-repo-watcher` heartbeat mostantól kötelezően visszaírja az új shát a
`watched-repos.json`-ba minden átnézett CHANGED:code bejegyzésnél, hogy a "sárga riasztás" a
következő futásnál törlődjön. Ha a review "nem biztonságos, Peti-döntés kell" eredménnyel zár, a
riasztás szándékosan sárga marad.
**Miért:** Peti észrevétele, hogy a riasztás korábban nem tűnt el review után.
**Ki döntött:** Peti.
**Hivatkozás:** `~/.claude/scheduled-tasks/git-repo-watcher/SKILL.md` (nem git-trackelt, home-könyvtár config).

## 2026-08-20 07:00 -- Presign replay-fix: mindkét irány (a+b) épüljön

**Döntés:** A korábbi "(d) marad LOW/opcionális, nem épül most" döntés felülírva: Peti "legyen a és
b" -- FE-checksum-first kontraktus-változás ÉS bucket-versioning + versionId-átvezetés is épüljön.
**Miért:** Peti üzleti/prioritási döntése, a korábbi indoklás (több-csapatos scope, aszimmetrikus
TTL-csere) már nem tartja vissza.
**Ki döntött:** Peti.
**Hivatkozás:** kártya 8779c351 (epic), gyerek-kártyák 29528d16 (b, backend), 37e30adb (a-BE,
backend2), 7a1a8aec (a-FE, fron-ted).

## 2026-08-20 07:04 -- Attesztációs raise-bound ablak: marad változatlan

**Döntés:** A bér-attesztáció mai 24 órás fail-closed visszadátumozási ablaka NEM lazul.
**Miért:** Peti üzleti döntése ("maradjon így egyelőre") -- a mai állapot biztonságos és elfogadott
(Cybersec), a lazítás csak akkor kellene, ha a napvégi-batch-jóváhagyás miatt elveszett claimek
problémája ténylegesen felmerül.
**Ki döntött:** Peti.
**Hivatkozás:** kártya b077e073.

## 2026-08-20 07:05 -- Memória-bővítés 1/2 (automatikus tevékenység-rögzítés): terv jóváhagyva kódolásra

**Döntés:** A plan-grilling GO-WITH-CHANGES verdikttel lezárt terv (progresszív, interaktív/nem-
interaktív kontextusra külön tervezett hook-alapú aktivitás-rögzítés) mehet kódolásra/prototípusra.
**Miért:** Peti jóváhagyása ("mehet"), a 4 kötelező plan-grilling-feltétel érvényben marad.
**Ki döntött:** Peti.
**Hivatkozás:** kártya 4829ccff (szülő: 4f87d517), a sorban következő 0c5423fc csak 4829ccff UTÁN
épülhet (rögzített sorrend a saját plan-grilling verdiktjében).

## 2026-08-20 07:12 -- Projekt-szintű döntésnapló + user manual assembler bevezetése

**Döntés:** Minden projekt gyökerében egy `DECISIONS.md` (append-only, grep-elhető, dátumozott
döntés-bejegyzések) + egy `user-manual-assembler` skill, ami a README "Teljes funkciólista"
szekciójából állít össze felhasználói kézikönyvet, modul/funkció szerint, flow-onkénti teszt-lefedettség
kereszt-ellenőrzéssel.
**Miért:** Peti kérte, hogy a beszélgetések/döntések ne vesszenek feledésbe, könnyen kereshetők
legyenek, és ezekből a végén user manual + user flow leírás legyen összeállítható; minden flow-hoz
programozás-technikai teszt is kell.
**Ki döntött:** Peti (kérés) + MikroB (mechanizmus-tervezés: külön DECISIONS.md vs README-duplikáció
elkerülése, desztillálási küszöb).
**Hivatkozás:** `project-decisions-log` és `user-manual-assembler` skillek (`~/.claude/skills/`).

## 2026-08-20 -- Fork-saját verziójelzés: SemVer build-metadata (+mikrob.N)

**Döntés:** A `package.json` `version` mezőjének formátuma mostantól `X.Y.Z+mikrob.N` (SemVer build-metadata szintaxis), ahol `X.Y.Z` az upstream Szotasz/marveen verzió, `N` a fork saját, ezen az upstream-verzión belül növekvő számláló. Az első tényleges érték: `1.33.0+mikrob.1`. A köötőjeles pre-release formátum (`1.33.0-v01`) szándékosan elutasítva: SemVer szerint `1.33.0-v01 < 1.33.0`, ami hibás sorrendet ad minden SemVer-összehasonlítónál; a `+` jelű build-metadata semmilyen verziós sorrendet nem változtat.

**Számláló-szabály:** fork-specifikus commit landolásánál (NEM upstream-sync) N eggyel nő. Upstream-sync után (új X.Y.Z) a számláló 1-re áll vissza. Jelenleg kézi folyamat (nincs automatizált release-script -- az upstream `chore(release): vX.Y.Z` commitok nem a fork számára generálódnak).

**update-checker.ts hatás:** a `currentVersion()` visszaadja a teljes `1.33.0+mikrob.1` stringet (kijelzésre); a `RELEASE_RE` regex bővítve, hogy opcionálisan illeszkedjen `+build-meta` szuffixre is, ha valaha ilyen formátumú release-commit kerülne be.

**Ki döntött:** Peti (formátum-döntés Telegramon 2026-08-20) + MikroB (SemVer build-metadata javaslat, elfogadva).
**Hivatkozás:** kanban-kártya `12783b1e`, commit: ld. Gate-SHA a kártya REVIEW-kommentjében.

## 2026-08-21 -- README "Teljes funkciólista"/"Szerepkörönkénti user story" szekció NEM vonatkozik a MikroB/marveen repóra

**Döntés:** A `CLAUDE.md` "Teljes funkciólista karbantartás" szabálya (user story + user flow + frontend-státusz funkciónként/szerepkörönként) a MikroB/marveen repóra NEM alkalmazandó -- a README-ből eltávolítva a "## Teljes funkciólista" és "## Szerepkörönkénti user story és user flow" szekció (korábban a 33-142. sorban). A MikroB repo README-je a korábbi mintát követi: a felmenő Szotasz/marveen alap-leírás felbővítve a saját fork-eltérésekkel ("## Egyedi fork-fejlesztések (amiért külön fork)" szekció), NEM egy termék-jellegű teljes funkciólistával.

**Miért:** a szabály eredetileg PRODUCT/termék-repókra (pl. CleanCore) készült, ahol a user story/user flow/RBAC-bontás valódi végfelhasználói funkciókat ír le. A MikroB/marveen egy fejlesztői eszköz/flotta-keretrendszer saját maga számára -- itt a releváns dokumentáció NEM a végfelhasználói user flow, hanem hogy MIBEN tér el ez a fork a felmenő projekttől. A két szekció korábbi bekerülése tévedés volt, Peti kifejezetten korrigálta (Telegram, 2026-08-21).

**Ki döntött:** Peti (korrekció Telegramon 2026-08-21).
**Hivatkozás:** README.md "Egyedi fork-fejlesztések (amiért külön fork)" szekció marad az egyetlen forrás a fork saját fejlesztéseire.

## 2026-08-21 -- 41df5159 -- A direct-sync statisztika-sor NEM megy at a worker-kimenet ellenorzesen; a 460 hamis "Sikertelen" javitva, naplozott visszaallitassal

**Dontes.** A `POST /api/local-llm/queue/<id>/complete` vegpont a `verifyOutput()` ellenorzest CSAK
valodi worker-eredmenyre futtatja. A direct-sync sort a sajat STRUKTURALIS jelolojerol ismeri fel
(`prompt === DIRECT_CALL_PLACEHOLDER`), nem a hivo altal kuldott `source` mezorol. A valasz `verified`
mezoje ilyenkor `false` + `verificationSkipped: 'direct-sync'` -- nem `true`, mert ellenorzes nem
tortent. A mar beirt 460 hamis sort egy egyszeri script javitja
(`store/local-llm-repair-false-failed.mjs`), ami az UPDATE ELOTT JSON-naploba irja minden erintett sor
elozo `status`/`error`/`finished_at` erteket, es `--revert <naplo>` visszaallitja.

**Miert.** A `store/local-llm.sh` direct-sync hivasnal maga a hivo a worker: a modell valaszat kozvetlenul
stdout-on adja vissza, es a queue-sort egy szandekosan URES `{"result":""}`-tal zarja le, pusztan
statisztikahoz. A ea931c14 kartya bevezette a fuggetlen kimenet-ellenorzest a WORKER-uton -- ugyanaz a
vegpont fut viszont a statisztikai lezarasra is, ami sose hordoz kimenetet, tehat MINDEN sikeres direct
hivas `failed`-re valtott a dashboardon. Peti ezt latta "sok Sikertelen sor"-kent (Telegram, 2026-08-21).

A `source` mezo szandekosan NEM dontesi alap: a hivo tetszolegesre allithatja, tehat nem hordozhat
helyesseg-relevans dontest. A `prompt`-jelolot a modul mar ket helyen hasznalja pontosan ezert
(`fail()`, `reclaimStaleRunning()`), a sajat kommentjeikben kimondva.

**Hogy tudom, hogy ezek nem valodi hibak.** A `_queue_finish complete` csak az Ollama-valasz visszaterese
UTAN fut le (`local-llm.sh:361`, a 334-es `|| { ... die }` blokk mogott); a hiba-ut `/fail`-t hiv
`{"error":"local-llm.sh call failed"}` torzzsel. Egy sor tehat, aminek a hibaja PONTOSAN a verifikacios
uzenet, szerkezetileg olyan hivas, ami sikerult. A javito script harom feltetelt kot ossze (placeholder
prompt + `failed` + a PONTOS hibauzenet), ezert a 141 `local-llm.sh call failed`, a 42 `abandoned` es a 9
`requeued` sort nem erinti -- egy LIKE/prefix illesztes ezeket bevitte volna.

**Elvetett alternativak.**

- _`source = 'direct-sync'` alapu kihagyas (a kartya elso javaslata)._ A `source` hivo-altal kuldott
  szabad szoveg; egy helyesseg-dontest nem szabad ra bizni, amikor a sornak van sajat, hamisithatatlan
  szerkezeti jeloloje.
- _Kulon vegpont a direct-sync lezarasra (a kartya masodik javaslata)._ Uj HTTP-felulet ugyanarra az
  allapotatmenetre, plusz a `local-llm.sh` es a szerver egyideju verzio-fuggosege (regi script + uj
  szerver, vagy forditva). A meglevo vegpont egy sornyi feltetellel pontosan ugyanazt adja.
- _A hamis sorok meghagyasa "csak elore-fix"-kent._ A panel ettol 460 hamis Sikertelen sorral maradna
  orokre, vagyis Peti bejelentese nem oldodna meg -- a bejelentes maga a megjelenitett allapotrol szolt.

**Kovetkezmenyek.** Egy megfigyelt, SZANDEKOSAN nem javitott szomszedos pontatlansag: a
`_queue_finish complete` a valasz JSON feldolgozasa ELOTT fut, tehat ha az Ollama HTTP-200-nal
`error` mezot ad vissza, a sor `done` marad, mikozben a hivo hibaval all le. Ez ugyanabba a
"statisztika-pontossag" osztalyba tartozik, de mas ok, mas javitas es nem ez a kartya -- jelezve, nem
csendben belesodorva (3. kodminosegi szabaly).

---

## 2026-08-22 -- 34f1ca0c -- Az activity-hook ket celpontja: emlekezet vs helyi napló

**Döntés.** A `scripts/hooks/activity_memory_capture.py` PostToolUse-hook eddig egyetlen
igen/nem kérdést tett fel ("rögzítsem?"), és minden igen a kereshető memória-indexbe ment. Ez
mostantól HÁROM válasz: `memory`, `log` vagy eldobás. A memória-index csak azt kapja meg, amit egy
későbbi munkamenet ténylegesen visszakeres (git commit/push/merge/rebase/tag, `systemctl`
állapotváltás, csomag-telepítés, delegálás); minden más állapotváltó hívás a `store/activity-log/`
alatti JSONL-fájlba kerül, ami nem kereshető és nem embeddelődik.

**Miért.** Mérés 2026-08-22-én: a hot tier 145 sorából 109 ennek a hooknak a kimenete volt, és a
463 auto-activity sor összesen 142 különböző szöveget hordozott. A `tool_call_log` táblán
végzett A/B (2086 valós parancs) a régi és az új szűrővel:

| | memória-sor | különböző | helyi napló |
|---|---|---|---|
| régi | 898 | 215 | -- |
| új | 20 | 11 | 1640 |

Vagyis a memória-indexbe írás 97,8%-kal csökken, miközben egyetlen hívás nyoma sem vész el. A
kiszűrt tömeg 791 sora pontosan két alakzat volt: a flotta saját `curl -X POST ... localhost` és
`printf ... curl ... localhost` API-idiómája -- olyan kérések, amelyek célrendszere (kanban,
memories, üzenetsor) MÁR őrzi a hiteles rekordot.

**Miért nem "csak dobjuk el őket".** Kézenfekvő lett volna a rutin hívásokat egyszerűen kihagyni,
arra hivatkozva, hogy a `tool_call_log` úgyis mindent rögzít. Ezt megmértem, és NEM igaz: a
`tool_call_log` 2086 sorának MINDEGYIKE a `mikrob` ügynöké, a `backend` egyetlen hívása sincs
benne. Az eldobás tehát elveszítené a nyomot, nem áthelyezné.

**Elvetett alternatívák.**

- _Új SQLite-tábla a rutin hívásoknak._ Séma-változtatás és migráció egy olyan rekordért, amit
  senki nem kérdez le strukturáltan; a JSONL greppelhető és nulla séma-teher.
- _Periodikus takarítás, ami a duplikátumokat cold-ba mozgatja (a kártya harmadik javaslata)._ A
  keletkezést nem akadályozza meg, csak utólag rendezget: az embedding-költséget és a keresés
  hígulását már kifizettük, mire a takarítás lefut.
- _Deduplikációs gyorsítótár a hookban._ A szűkítés után a memória-sorok ritkák (2086 hívásra 20),
  tehát a duplikáció magától megszűnt -- egy külön állapot-fájl a hot path-on nem érte volna meg.

**Következmények.**

- A `store/activity-log/<agent>.jsonl` fájl 5 MB felett egyetlen `.1` testvérbe fordul át, tehát a
  pár mérete korlátos. A `store/*` már gitignore-olt, a nyomvonal nem kerül a repóba.
- A dashboard-token ellenőrzése a POST-ág elé került. A napló-ág így akkor is ír, ha a dashboard
  nem fut -- korábban a token hiánya az egész hookot leállította volna.
- A többsoros parancs összefoglalója mostantól összevont szóközökkel készül: egy 80 bájtnál
  elvágott, sortöréseket tartalmazó nyers shell-blokk volt az olvashatatlan bejegyzések forrása.
- SZÁNDÉKOSAN NEM ORVOSOLT, JELEZVE: (1) a `main()`-ben az `input_text` változó kiszámolódik, de
  sehol nem használják -- korábbi holt kód, nem az én maradékom, ezért csak jelzem; (2) a hooknak
  nincs említése a README-ben; (3) a `scripts/hooks/activity-memory-capture.py` (kötőjeles) egy nem
  hívott másolat, amelybe a 0c5423fc kártya DB-URI redakciós javítása tévedésből landolt, miközben
  az élesben futó aláhúzásos fájl a mai napig nem redaktál kapcsolati-string jelszót. Ez saját
  döntést érdemel, MikroB-nak jelentve -- mérve: még semmi nem szivárgott ki (0 ilyen sor).

---

## 2026-08-22 -- 8fb0aa44 -- A lint racsni lesz, nem riport es nem blokkolo kapcsolo

**Döntés.** Az ESLint bekerül a landolási kapuba (`store/fleet-test.sh`), de **racsniként**: a
`store/lint-ratchet.sh` szabályonként rögzíti a mai darabszámot a `store/lint-baseline.json`-ba, és
csak akkor tagad meg egy futást, ha valamelyik szabály **romlik** a rögzített értékhez képest.

**Miért.** Az ESLint a `9783a9d7` committal érkezett, és azóta **semmi nem hívta**: sem a
`fleet-test.sh`, sem az `npm test` (az csak `vitest run`), és `.github/workflows` nem is létezik.
Mérés 2026-08-22-én: 226 hiba + 6 figyelmeztetés. A heti önaudit egy nappal korábban 224-et
számolt -- a két szám közti eltérés önmagában bizonyítja, hogy a hátralék nőtt, miközben senki nem
nézte. Ez a *bekötött, de fogyasztó nélküli* hibaosztály.

A kártya bontása is pontosításra szorult: „4 valódi `no-floating-promises`" helyett a mérés
**16 ígéret-biztonsági** találatot mutat (3 `no-floating-promises`, 12 `no-misused-promises`,
1 `await-thenable`). A `no-misused-promises` ugyanabba a fail-open osztályba tartozik, tehát a
kockázatos rész nagyobb volt, mint amit a kártya feltételezett.

**Elvetett alternatívák.**

- _`npm run lint` blokkolóként, most._ Minden landolást megtagadna, amíg a 226 örökölt hiba el nem
  fogy. Ezt egy kártya alatt nem lehet letakarítani, tehát egy órán belül visszavonnák.
- _Nem-blokkoló riport (a kártya első javaslata)._ Ugyanaz a hibaosztály, csak eggyel odébb: egy
  zöld script kimenetét senki nem olvassa, és a 227. hiba ugyanúgy bejelentés nélkül érkezne. A
  kártya „előbb riport, majd fokozatosan blokkoló" ütemterve pontosan az a lépés, amit soha nem
  ütemez be senki -- a racsni ezt a lépést a munka mellékhatásává teszi.
- _Egyetlen összesített darabszám._ Egy javítás kifizetne egy rontást. **Mérve:** öt `no-unused-vars`
  helyett egyet javítva és egy `no-floating-promises`-t hozzáadva az összeg változatlan marad
  (232), az összeg-alapú racsni tehát átengedné; a szabályonkénti megtagadja. A szabályok nem
  cserélhetők egymásra: egy nem használt import rendrakás, egy elszabadult ígéret fail-open hiba.

**Következmények.**

- A racsni CSAK teljes futáson fut. A gyakori hívás egyetlen teszt-fájl, ami 1 mp alatt végez, és
  egy 16 mp-es lint azon 16-szoros adó lenne -- ugyanaz az érv, amivel a build-marker is dolgozik.
- A **teszt-fa** példányát hívja (`$TEST_TREE/store/lint-ratchet.sh`), nem az élő installét. Ez nem
  stílus: a `$ROOT` az élő install, ami tetszőleges commiton áll, tehát a `$ROOT`-ból futtatott lint
  nem a vizsgált shát mérné, és egy kapu-verdiktet a rossz kódra adna ki. (Az első változatomban
  pontosan ez a hiba volt benne, mielőtt commitoltam.)
- A script és a baseline `git add -f`-fel követett, mert a `store/*` ignorált -- e nélkül egyik sem
  létezne a teszt-fában, és a kapu némán kimaradna. Ezt a `-x` létezés-ellenőrzés is fedi: ha a
  script hiányzik, a lépés kimarad ahelyett, hogy a futás elhasalna.
- A parse-hibák `(parse-error)` néven saját racsni-sort kapnak. Enélkül egy fájl, ami már nem
  elemezhető, kiesne minden szabály számlálójából, és **javulásnak** látszana.
- Nulla lintelt fájl vagy elemezhetetlen ESLint-kimenet setup-hibaként (exit 3) végződik, nem tiszta
  futásként -- egy konfigurációs hiba nem jelenthet sikert.
- A 226 meglévő hiba letakarítása külön feladat marad (típusonként bontva), ahogy a kártya is írja.
  A racsni ehhez ad kényszert: minden javítás után a baseline lejjebb vihető, és onnantól az a
  szigorúbb korlát él.

---

## 2026-08-22 -- 5472cfa9 -- A redakciós javítás az ÉLES fájlba, és a nem hívott iker törlése

**Döntés.** A DB-kapcsolati string jelszavát redaktáló minta átkerült a ténylegesen futó
`scripts/hooks/activity_memory_capture.py`-be; a nem hívott `activity-memory-capture.py` iker
törölve; és a selftest -- amit addig SEMMI nem futtatott -- bekerült a vitest-suite-ba
(`src/__tests__/activity-hook-redaction.test.ts`).

**Miért nem elég a mintát átmásolni.** A 0c5423fc kártya ezt a mintát MÁR megírta, és `d64d4b28`
committal a kötőjeles ikerbe landolta, amit semmi nem hív -- miközben a `settings.json:75` az
aláhúzásosat drótozza a PostToolUse hookba. A kártya `done` lett. Élő bizonyíték a felfedezéskor:
ugyanaz a string az ikernél `[REDACTED]`-re ment, az élesben futónál változatlan maradt.

**Két független hiba állt egymás mellé**, és a másodikat tartom a súlyosabbnak:

1. a javítás rossz fájlba került;
2. a hozzá tartozó teszt-készletet (`activity-memory-capture.selftest.py`) **semmi nem futtatta** --
   se a vitest-suite, se CI (a repóban nincs is `.github/workflows`).

A (2) nélkül az (1) egy perc alatt kiderült volna. Ezért ez a kártya nem csak átmásolja a mintát,
hanem a selftestet bedrótozza a suite-ba, és a redakciót az ÉLES modulon, abszolút útvonalról
betöltve is állítja -- egy "kényelmi" importtal írt teszt pontosan azt a hibát nem fogta volna meg,
ami itt történt.

**Mérve, mielőtt riasztottam volna.** A `memories` táblában `://user:pass@` alakú sor összesen 2,
ebből az activity-hooktól 0, DB-sémával 0 -- tehát LATENS rés volt, nem folyamatban lévő incidens.
Ezt a besorolást a javítás előtt rögzítettem, nem utólag.

**Mellékként javítva: a selftest hazudott a saját lefedettségéről.** A záró sora
`f'OK: all {30 - len(FAILURES)} checks passed'` volt -- egy literál, ami 0 hiba esetén MINDIG
"30"-at írt ki, függetlenül attól, hány ellenőrzés van a fájlban. A valódi szám **15**. Egy
redakciós utat auditálva a legrosszabb dolog egy olyan harness, ami a saját fedezetét túlmondja,
ezért most számolva jelenti; külön teszt tiltja a literál visszatérését.

**Hatókör-eltérés, kimondva.** MikroB a 34f1ca0c hatókörében kérte ezt a lépést (msg 18980). Mire
hozzáértem, a 34f1ca0c már `waiting` volt **QA PASS-szal** (komment 15137, Gate-SHA c7eb89d0). Egy
új commit ott érvénytelenítette volna azt a verdiktet, ezért a munka a 0c5423fc-ből született
5472cfa9 kártyára került -- ugyanaz a fájlcsalád, és a redakció átemelése amúgy is előfeltétele az
iker törlésének (nem szabad törölni azt a fájlt, amiben egy javítás egyetlen példánya él).

**Következmények.**

- A `_redact` a mintát két csoporttal illeszti: az 1. csoport (URI-előtag) megmarad, a 2. (jelszó)
  sosem kerül kiírásra -- a helyettesítés `group(1) + '[REDACTED]'`. Élő végponttól végpontig
  ellenőrizve: `postgres://admin:[REDACTED]@db.internal:5432/cleancore`, a host megmarad.
- Az e2e első kísérletem NEM bizonyított semmit: a `curl` ige illeszkedett, így az URI be sem
  került az összefoglalóba. Megismételve olyan paranccsal, ahol a jelszó tényleg eljut a
  redaktorig -- ez a mérés a bizonyíték, az első nem volt az.
- A törlés seep-je hivatkozás szerint futott (a `module-deletion-sweep` skill szerint), a teljes
  repóra, típusszűrés nélkül: 3 találat, mind prózában (két komment + egy DECISIONS-bejegyzés),
  egyik sem hívás. A selftest docstringje a törölt fájlt nevezte meg -- javítva, mert különben
  ugyanaz a doksi-hazugság-osztály maradt volna vissza.
- A selftest fájlneve továbbra is kötőjeles (`activity-memory-capture.selftest.py`), pedig az
  aláhúzásos modult teszteli. Szándékosan nem neveztem át: külön churn, és a docstring most
  kimondja, melyik modult tölti be.

---

## 2026-08-22 -- 5472cfa9 (2. kör) -- Cybersec NO-GO: a csonkolás a redakció ELŐTT futott

**Döntés.** A `_build_summary` minden ága REDAKTÁL, MIELŐTT csonkítana; a DB-URI minta elveszíti a
`{6,}` hosszküszöbét; és a `store/activity-log/` fájl explicit 0600-zal jön létre.

**A lelet (Cybersec, NO-GO).** A most szállított kontroll megkerülhető volt. A `_command_verb`
utolsó ága 80 bájtnál elvágja a parancsot, és a `_redact` csak EZUTÁN látta. Az új DB-URI minta
viszont lookahead-del zár -- `([^@\s]+)(?=@)` --, tehát ha a vágás a jelszó ÉS a `@` KÖZÉ esik, a
lookahead nem teljesül, és a jelszó REDAKTÁLATLANUL marad.

Függetlenül újramérve, 14 karakteres szintetikus jelszóval, előtag-hossz szerint söpörve: a 43
bájtos előtagnál a jelszó **teljes egészében** túlélt, 43..55-nél 14-től 2 karakterig. Egy 43 bájtos
előtag egy `cd` meg egy env-értékadás.

**A tanulság, egy mondatban:** egy csonkolás, ami a redaktor ELŐTT fut, nem rövidíti a titkot --
ELVESZI a kontextust, amiről a redaktor felismeri. Ez általánosabb, mint ez a minta: minden
lookahead- vagy határ-alapú redakciós szabály sérülékeny arra, ami előtte vág.

**A `{6,}` küszöb nem csak felesleges volt, hanem káros.** A többi minta HEURISZTIKUS (egy random
6+ karakteres futam valószínűleg titok), ott a küszöb értelmes zajszűrő. Ez a minta POZICIONÁLIS:
ami egy `scheme://user:` és egy `@` között áll, az definíció szerint jelszó, bármilyen rövid. Mérve:
5 karakteres jelszó teljes egészében átment.

**És a rész, ami a leginkább az én hibám volt: a tesztem szerkezetileg nem foghatta meg.** Az általam
írt `activity-hook-redaction.test.ts` a `_redact()`-et hívta KÖZVETLENÜL. Az ÉLES modult töltötte be
(ez helyes volt, és pont ez a kártya lényege), de a `_build_summary`/`_command_verb` -- ahol a
csonkolás történik -- SOHA nem volt a tesztelt úton. Azt bizonyította, hogy "a minta redaktálja ezt a
stringet", nem azt, hogy "a hook redaktálja ezt a parancsot", és zöld maradt, miközben a hook
szivárgott.

Ez UGYANAZ a hibaosztály, ami miatt ez a kártya létezik, egy szinttel feljebb: a 0c5423fc-nél a
javítás létezett, csak nem azon az úton, amit a rendszer futtat; itt a TESZT létezett, csak nem azt
az utat járta, amit a rendszer futtat. A tesztkészlet mostantól a teljes íráson megy
(`_build_summary` → `_redact`), előtag-söpréssel.

**Következmények.**

- Negatív kontroll: a csonkolás-sorrend visszaállítása 6 tesztet pirosít, a `{6,}` visszatétele 1-et.
- A 0600-kontroll ELŐSZÖR NEM harapott, és ez nem vak teszt volt: a `os.open(...)` módja mellett van
  egy `os.chmod` utóellenőrzés is, ami kijavította. Mindkét mechanizmust eltávolítva a teszt piros.
  Szándékos védelem-mélység: az `os.open` módja csak LÉTREHOZÁSKOR érvényes, egy már meglévő (rossz
  módú) fájlt csak a chmod javít.
- Élő stdin-út a szivárgó előtag-hosszon: `[REDACTED]`, jelszó 0 találat, fájl-mód 600.
- A Cybersec eljárási megjegyzése áll: a kártya LEÍRÁSÁBAN a Gate-sor csak QA-t nevezett meg, a
  bővítés csak kommentben élt, és a gépi kijelölés-felismerés a leírást olvassa. Ha a kijelölés menet
  közben bővül, a leírás Gate-sorát is frissíteni kell.

---

## 2026-08-22 -- 12f80902 -- A horgonyzatlan at(1)-őr elveszti a szegmensvég-ágat (de a batch nem)

**Döntés.** A `UNANCHORED_SCHEDULER_RX` at(1)-ága külön `AT_INVOCATION_UNANCHORED` konstanst kap,
amiből hiányzik az `\s*$` ("a token a szegmens végén áll") alternatíva. A **batch(1) ága marad a
régi `AT_INVOCATION`-nél**, és ez a különbségtétel teherhordó.

**A defektus, reprodukálva.** A heredoc-törzs útja minden SORT egészben tesztel a horgonyzatlan
mintával, ami az `AT_INVOCATION`-t használta -- annak első alternatívája `\s*$`. Horgony nélkül
tehát bármely prózasor, ami erre a szóra VÉGZŐDIK, illeszkedett. Mérve egy valódi elutasításon:

    "...mert a loadCalendarServiceAccountConfig-nak adodik at"

egy magyar mondat, aminek az "át" igekötője ékezet nélkül, sortörésnél a sor végére esett -- és egy
hétköznapi státusz-riport "jövőbeli turn ütemezésének" minősült.

Az ág nem védett semmit: az at(1) KÖVETEL időspecifikációt, a puszta binárisnak nincs működő alakja.

**A KÁRTYA SZÓ SZERINTI OLVASATA LYUKAT NYITOTT VOLNA, és ezt méréssel kaptam el.** A kártya azt
írta: "a `\s*$` ág törlendő az UNANCHORED_SCHEDULER_RX-ből". Így is csináltam először -- és a
`batch` lefedettsége elveszett: `echo x | batch` egy heredoc-törzsben ATENGEDETT lett, holott az
eredeti tiltotta. Ok: a **batch(1) NEM kér időspecifikációt** -- a puszta `batch` beolvassa a
parancsokat a stdin-ről és lefuttatja, amikor a terhelés engedi, tehát ott a szegmensvég-alak IGENIS
működő beküldés. A két bináris csak egyformán van írva. A kártya szövegének javítását kérem.

**Konfliktus, kimondva.** Ez a kapu ENGEM korlátoz: a módosítója és a korlátozott fél ugyanaz. Ezért
(a) a változtatás a lehető legszűkebb (egy ág, egy binárison), (b) minden valós vektort mérés
igazol, hogy továbbra is tilt, (c) a gate-verdiktet olyantól kérem, aki nem én vagyok, és kifejezetten
arra, hogy nem tágítottam-e mást is.

**Következmények.**

- Negatív kontroll: az eredeti őr visszaállítása 2 tesztet pirosít; a kártya literál olvasata
  (mindkét binárisról levenni az ágat) a batch-tesztet pirosítja.
- **KÉT TOVÁBBI ÉLŐ HAMIS-POZITÍV UGYANEBBŐL A CSALÁDBÓL, mérve, de SZÁNDÉKOSAN NEM JAVÍTVA itt:**
  1. `"...total unchanged at 232, and the"` -- az `at` után 3-4 jegyű szám a `\d{3,4}\b` ágra
     illeszkedik (az `at 1430` HHMM-alak). Valódi angol próza.
  2. `"Nem irtam at -- felulvizsgalt"` -- az `at` után `--` a `\s+-` (flag-alak) ágra illeszkedik.
  Mindkettő szűkíthető (az elsőnél 0000-2359 tartomány, a másodiknál `-[a-zA-Z]` a puszta `-` helyett),
  DE mindkét ág VALÓDI vektorokat is fed (`at 1430`, `at -f job.sh`), tehát a szűkítés önálló
  biztonsági döntés. A saját korlátozó kapum további tágítását nem viszem tovább kártya nélkül.
- **EGY MEGLÉVŐ MEGKERÜLÉSI ÚT, ami NEM az én változtatásomból ered** (az eredeti is átengedi, mérve):
  `(crontab -l; echo "*/5 * * * * claude -p poll") | crontab -` egy heredoc-törzsben ÁTMEGY, mert az
  `UNANCHORED_SCHEDULER_READ_RX` a soron lévő `crontab -l`-re illeszkedik, és az EGÉSZ sort olvasásnak
  minősíti. A sorban ott van a valódi írás is. Ez élő self-pace megkerülés; jelentve, nem javítva
  (megint: nem tágítok és nem szűkítek a saját kapumon kártya nélkül -- de ez SZŰKÍTÉS lenne, tehát
  szerintem sürgősebb, mint a fenti kettő).
- A javítás a worktree-ben van; az ÉLES kapu (`/home/neon/marveen/scripts/`) a telepítés
  frissítéséig a régi marad, tehát a saját hívásaimra addig a régi szabály él.

---

## 2026-08-22 -- f7b10fec -- Egy soron belüli olvasás nem mentesítheti az ugyanott álló írást

**Döntés.** A heredoc-törzs útján a self-pace kapu mostantól KIVONJA a sorból az olvasó alakokat, és
azt kérdezi, maradt-e ütemező ÍRÁS. Korábban azt kérdezte, "tartalmaz-e a sor olvasó alakot?", és ha
igen, az EGÉSZ sort mentesítette.

**A megkerülés.** Ez a hurok minden sort EGÉSZBEN tesztel -- szándékosan, mert a `;`/`|` menti
darabolás hamis határokat vág idézett prózában (egy már egyszer javított hamis-pozitív osztály). Egy
sor tehát tartalmazhat olvasást ÉS írást is, és az olvasás mentesítette az írást.

**Tágabb, mint amit a kártya leírt.** A kártya a `crontab` esetet nevezte meg (az én saját jelentésem
alapján). Megmértem MIND A HÁROM olvasó alakot, és mindegyik ugyanezt hordozta -- mindhárom példa
ténylegesen ütemez:

    (crontab -l; echo "*/5 * * * * ...") | crontab -     a `crontab -l` mentesítette
    launchctl list; launchctl submit -l self -- ...      a `launchctl list` mentesítette
    atq; echo go | at now + 5 minutes                    az `atq` mentesítette

A javítás mindhármat lefedi, mert a kivonás a közös mintán működik, nem bináriskénti külön ágon.

**A horgonyzott ellenőrzés SOHA nem volt érintett**, és ezt megmértem, nem feltételeztem: a
`splitSegments` vág `;`/`|`/`&` mentén, tehát ott az olvasás és az írás külön szegmensbe kerül, és az
írást önmagában bírálja el. A javítás ezért kizárólag a horgonyzatlan heredoc-ágra kellett.

**Kivonás, nem "tartalmaz-e írást is" teszt.** A tiszta olvasásnak továbbra is át kell mennie -- ez a
mentesítés létezésének oka --, és kivonás után egy tiszta olvasó sorban nem marad semmi, amire
illeszkedni lehetne. Egy "van-e benne írás is" feltétel ugyanezt adná, de két mintát kellene
szinkronban tartani; a kivonás egyet használ.

**Kétirányú negatív kontroll.** (1) Visszaállítva a régi logikát: a három megkerülés-teszt pirosodik.
(2) Az olvasó-mentesítést teljesen elhagyva (túlkorrekció): a tiszta olvasások és a puszta említést
tartalmazó próza pirosodik, plusz egy korábbi kártya (46c4ad4a) saját tesztje is. Egy biztonsági
kontrollnál mindkét irány kell: az alul- és a túlkorrekció is hiba.

**Konfliktus, kimondva.** Ez a kapu engem korlátoz. Ezúttal SZŰKÍTÉS irányba (a kapu szigorúbb lesz),
tehát a kockázat nem az, hogy magamnak nyitok utat, hanem hogy hamis pozitívot okozok magamnak -- ez
gyengébb érv, de a gate-verdiktet így is olyantól kérem, aki nem én vagyok.
- **Egy saját hiba, amit a land-kapu fogott meg, nem én.** A teszt-fájlra lefuttattam egy
  `prettier --write`-ot. A repo `.prettierignore`-ja KIMONDJA, hogy a fa szándékosan nincs
  végig-prettier-formázva, és óv attól, hogy valaki "megjavítsa" -- én mégis megtettem egy fájlra.
  Két következménye lett: (1) a formázó becsomagolta a többsoros importot, amivel a fölötte álló
  `@ts-expect-error` már nem az import-specifikátorra vonatkozott, tehát a BUILD elhasalt
  (TS2578 + TS7016); (2) ~84 sornyi, a munkámhoz nem tartozó formázási churn keletkezett, pontosan
  az, amitől a `.prettierignore` óv. A `marveen-land.sh` visszautasította a landolást, és ez volt a
  helyes viselkedés. Visszaállítottam a fájlt a develop-ról, és csak a saját blokkomat tettem
  vissza: a diff most 59 beszúrás, 0 törlés. Tanulság: ebben a repóban a `prettier --write` nem
  ártalmatlan takarítás, és egy pozícióhoz kötött direktíva-komment (`@ts-expect-error`) mellett
  még kevésbé az.

---

## 2026-08-22 -- 4fa31f31 -- Egy idézőjel nem mentesítheti az ütemező-hívást, és a whitelist-alakú őr rossz irányba hibázik

**Döntés.** A self-pace kapu `at(1)`/`batch(1)`/`launchctl` alak-őrei mostantól TŰRIK az idézőjelet
(`["']*`), a `launchctl` esetében mindkét oldalon. A `crontab`/`systemd-run` ág változatlan.

**Az ok, és az általánosítható tanulság.** A héj MÉG A PARANCSSZÓ ELDÖNTÉSE ELŐTT leszedi az
idézőjelet, tehát `at "now + 5 minutes"` és `launchctl "submit" -l self` pontosan azt ütemezi, amit
az idézőjel nélküli alak. A két érintett őr POZITÍV FELSOROLÁS ("mi jöhet a bináris után"), és egy
idézőjel nem volt a felsorolásban -- így a match ELBUKOTT, a hívás pedig ÁTMENT. Ez a hibázás
IRÁNYA a lényeg: egy hiányos pozitív felsorolás ENGED, nem TILT. A másik két bináris ugyanerre a
bemenetre mérten sértetlen maradt, mert az ő őrük NEGATÍV lookahead ("csak akkor engedd, ha angol
szó követi") -- egy előre nem látott karakter azt nem töri meg. IRÁNY-ELV a fájlba is beírva: új
binárisnál a negatív alakot kell választani; ha mégis pozitív felsorolás kell, minden karaktert
tűrnie kell, amit a héj exec előtt leszed (idézőjel, backslash, `$IFS`).

**A két oldal külön okból kell (Cybersec mérte ki az aszimmetriát).** Az `at(1)` őre időspecifikáció-
szóra zár, ott elég a VEZETŐ idézőjel. A `launchctl` alternatívája SZÓHATÁRRA zár, és a záró
idézőjel nem szóhatár -- így a csak-vezető javítás minden `launchctl "submit" ...` alakot továbbra
is átenged. Ezt az NC2 negatív kontroll rögzíti: a kártya szó szerinti fél-javítása pirosít.

**A MÉRÉS KÉT PONTON ELTÉR A KÁRTYÁTÓL, és ezt kimondom.**

1. A kártya szerint a horgonyzott `at`-szabály is megkerülhető ("4/4 átmegy"). NEM reprodukálható:
   a `maskInertLiterals` az idézett részt AZONOS HOSSZÚSÁGÚ szóközökre cseréli a horgonyzott
   ellenőrzés ELŐTT, így az időspecifikációból sorvégi whitespace lesz, amit az `AT_INVOCATION`
   sor-vég ága amúgy is TILT. A kártya által előírt "vezető idézőjel a horgonyzott ágon" javítás
   ezért HOLT KÓD lenne: a horgonyzott ág soha nem lát idézőjelet.
2. Ugyanez a maszkolás viszont NYITVA HAGY egy alakot, amit a kártya nem nevez meg:
   `launchctl "load" <path>` (és bootstrap/start/enable/bootout) PARANCSPOZÍCIÓBAN átmegy, mert ott
   a maszkolás az ALPARANCSOT tünteti el. A gyökér ennél is tágabb: egy IDÉZŐJELBE TETT BINÁRISNÉV
   (`"launchctl" submit`, `"crontab" -r`, `"at" now`) és egy backslash-elt binárisnév (`\at now`)
   a horgonyzott nézetből TELJESEN eltűnik, mind a négy binárisra. Ez nem javítható ezekben az
   őrökben -- azok soha nem látják az idézőjelet. Külön kártyát kap.

**Miért nem javítottam mégis itt: MÉRTEM, nem becsültem.** Két inline jelöltet futtattam le a
tényleges tesztkészlet ellen:
- (A) egy harmadik, horgonyzott ellenőrzés idézőjel-mentesített szövegen: bezárja a lyukat, de a
  meglévő készletből **6 teszt pirosodik** -- köztük a fájlban dokumentált `echo 'foo | crontab |
  bar'` hamis-pozitív (az idézeten belüli `|` álhatárt vág) és a 46c4ad4a kártya két regressziós
  őre.
- (B) az unanchored szabály futtatása MINDEN naiv szegmensen: szintén bezárja, de **5 teszt
  pirosodik**, és egy hétköznapi `echo "a launchctl parancs kimenete"` státuszüzenet tiltásba fut.
Mindkettő visszaállítva, a készlet utána 130/130 zöld. A maszkolás modellje a valódi hiba (egy
idézett szöveg nem INERT, csak EGY SZÓ), és annak átírása terv-fázisú grillezést érdemel, nem egy
HIGH bugfix kártya melléktermékét.

**Egy mért mellékhatás, kimondva.** A javítás után `echo "a \"launchctl\" parancs"` heredoc-törzsben
tiltásba fut, míg előtte nem. Ez nem új osztály: az idézőjel NÉLKÜLI `launchctl parancs` ma is
tilt (a kártya külön ki is mondja, hogy ez ismert és külön kártyára tartozik) -- a javítás csak
következetessé teszi a két írásmódot. Cserébe egy valódi hamis-pozitív MEGSZŰNT: `crontab "-l"`
(idézőjeles LISTÁZÁS) eddig tiltásba futott, mert az író-őr már illeszkedett rá, az olvasó-mentesítés
viszont idézőjel-vak volt; most mindkét oldal ugyanazt a tűrést kapta.

**Kétirányú negatív kontroll (5 db, mind pirosít).** NC1 launchctl-őr visszaállítva; NC2 csak-vezető
idézőjel (a kártya szó szerinti fél-javítása); NC3 at-unanchored őr visszaállítva; NC4 at/batch közös
őr visszaállítva; NC5 az olvasó-mentesítés idézőjel-vakon hagyva (túlkorrekció: egy idézőjeles
listázás tiltásba futna).

---

## 2026-08-22 -- 0ea89716 -- installer-start-and-fallback.test.ts: a fork állítását tartjuk, az upstream kommentjének eredet-adatát beolvasztjuk

**A blokk.** A `marveen-land.sh` MINDEN landolást visszautasított, mert a `fork-upstream-conflict-guard`
teszt piros volt. Külön lemértem a TISZTA `origin/develop`-on is (`fleet-test.sh --ref origin/develop`):
ugyanaz a bukás, tehát nem egy ügynök változtatása okozta, hanem az upstream mozgott. Amíg állt, a
teljes flotta landolási útja zárva volt.

**A lelet.** Valódi merge eldobható worktree-ben (`origin/develop` + `upstream/develop`): 16 fájl
ütközik, ebből 15 már bejegyzett (`ACKNOWLEDGED_CONFLICTS` / `GUARDED_FILES`). Egyetlen új:
`src/__tests__/installer-start-and-fallback.test.ts`, EGY hunk. Az upstream oldali forrás a
`56af7a69` (vitest+typecheck workflow, MARVCI822), a fork oldali a `7b90f485` (kártya 3aa02ac6).

**Döntés: a fork állítása marad, az upstream kommentjéből a bash 3.2 / macOS eredet beolvad.**
A két oldal SZEMANTIKAILAG AZONOS -- mindkettő pontosan `TRAP:5`-öt vagy `TRAP:6`-ot fogad el (az
upstream regexe horgonyzott), és mindkettő ugyanazért íródott: a `$LINENO` által hibáztatott sor
bash-verzió függő, tehát egy szám rögzítése a tesztet bash-kiadás-detektorrá tenné az
"abort tényleg megtörtént" őr helyett. Kódszinten tehát NINCS mit mérlegelni; csak a kommentek
térnek el, és kiegészítik egymást: a forké a mért <=5.2 / 5.3 különbséget nevezi meg, az upstreamé a
bash 3.2 / macOS eredetet, ahol az eredeti installer-incidens történt, és amit a fork kommentje nem
őriz. A fork állítás-alakja (`toContain` egy literál tömbön) bukáskor kiírja a VÁRT HALMAZT, a regex
csak a mintát -- ezért az marad.

**Miért nem `GUARDED_FILES`.** Az nem fork-tulajdonú web-fájl, és az upstream jogosan módosítja
tovább. A FELOLDÁS SZABÁLYÁT kellett rögzíteni, nem az ütközést megtiltani.

**Negatív kontroll (2, mindkettő pirosít).** NC1: a bejegyzés törölve -> piros. NC2: a kulcs egy
karakterrel elgépelve -> piros, tehát a bejegyzés a PONTOS útvonalra köt, egy elgépelés nem megy át
csendben.

**Visszatérő hibaosztály.** Ez a 8. előfordulás (d359535c, 88505fb5, 2e634e5c, b91f11d8, bc898166,
be520693, 8db90294 -- mind lezárva). A minta stabil: valahányszor az upstream hozzányúl egy olyan
fájlhoz, amit a fork is módosított, a landolás MINDENKINEK megáll, amíg valaki be nem jegyzi a
feloldás szabályát. Ez a kapu szándékolt viselkedése (a döntés akkor szülessen, amikor még van idő
mindkét oldalt megnézni), de a költsége teljes flotta-leállás -- érdemes lehet a guard-tesztet úgy
jelezni, hogy NE a landolást blokkolja, hanem egy kártyát nyisson. Ezt nem döntöm el egyedül.

## 2026-08-22 19:40 -- Self-pace kapu: szó-kifejtés modellezése, és a parancs-helyettesítés tudatosan nyitva marad (kártya 4f32f1f9)

**Döntés:** A `scripts/self-pace-gate.mjs` mostantól a PARANCSSZÓT is elbírálja a héj
szó-kifejtésének közelítése után (idézőjel-eltávolítás, `$IFS`, `\X`, `$'...'`, `${x}`), nem csak a
nyersen leírt szöveget. A parancs-helyettesítés (`$(...)`, backtick) és a csupasz
paraméter-behelyettesítés (`${CMD}`) parancsszó-pozícióban NYITVA MARAD, dokumentált maradék-
kockázatként. Ez az (a) opció, Cybersec döntése.

**Miért volt hiba:** minden minta a LEÍRT szöveget illesztette, a héj viszont a KIFEJTETT szavakat
futtatja. Így minden szerkezet, amit a héj a kifejtés során eltávolít -- idézőjel a bináris nevének
KÖZEPÉN, `$IFS` a bináris és az argumentuma között, visszaper, `$'...'`, `${x}` előtag -- egy valós,
működő ütemező-hívást láthatatlanná tett. Tizenegy alakot mértünk a valódi `gateDecision` úton
(Cybersec lelete, majd önálló újramérés implementálás előtt); a battériában rögzített 21 próbából 21
ment át a javítás előtt.

**MÉRT ÁLLAPOT, NEM INDOKLÁS (Cybersec 1. kérése).** Kifejezetten NE arra hivatkozzon senki, hogy
"a heredoc-ág úgyis elkapja" -- ezt Cybersec MEGMÉRTE és NEM IGAZ: a `$(echo at) now` és a
`${CMD} -r` MINDKÉT rétegen átmegy, a `${CMD}` esetében azért, mert a bináris neve elő sem fordul a
szövegben; ráadásul a valódi támadási alak egy SIMA parancs, amit a heredoc-ág el sem olvas. A
horgonyzott ágon tehát a parancs-helyettesítés teljesen nyitva áll, a heredoc-backstop részleges, és
ezt tudatosan fogadjuk el. Egy hamis indoklás rosszabb, mint egy bevallott rés: a következő ember a
hamis indoklásra építene.

**A KAPU HATÓKÖRE, KIMONDVA (Cybersec 2. kérése).** Ez a kapu a VÉLETLEN vagy könnyelmű self-pace
ellen véd, és az ellen, hogy egy szándékos megkerülés ÉSZREVÉTLEN maradjon. Elhatározott megkerülő
ellen NEM véd, és szövegilleszkedéssel nem is tud: a `$(echo at) now`-t senki nem gépeli be
véletlenül, az szándékos evázió, amit eljárási úton (szabály + jelentési fegyelem) fogunk meg. Aki
fél év múlva ezt újranyitja: a széles tiltás ára mért és valós, a haszna nem.

**MIÉRT NEM (b) (a `$(...)` általános tiltása).** Nem zárja az osztályt (a `${CMD}` így is átmegy),
viszont megöl mért, legitim alakokat (`ls $(which node)`, `echo $(which python3)`,
`PATH=$(dirname $(which git)):$PATH ls`). És a bukás módja itt NÉMASÁG: egy megtagadott üzenet
kívülről megkülönböztethetetlen a hallgató vagy kompromittált ügynöktől -- Cybersec-et aznap kétszer
akadályozta meg ez a kapu egy biztonsági jelentés kiírásában. Egy olyan kapunál, aminek a hamis
pozitívja némaság, a széles tiltás maga is biztonsági kockázat.

**HARMADIK ÚT A JÖVŐRE, ha a maradék valaha számítani kezd (Cybersec 3. kérése, NEM most és NEM
ennek a kártyának a hatóköre):** a (b) helyett szűkebb szabály, ami CSAK a parancsszó-POZÍCIÓBAN
álló helyettesítést tiltja, az argumentum-pozíciót nem -- a három legitim példa mind argumentum-
vagy értékadás-pozícióban van, tehát túlélné. Ennek is van valódi hamis-pozitív osztálya
(`$(npm bin)/eslint`, `$(go env GOPATH)/bin/x` parancsszó-pozícióban legitim), és a mérése önálló
munka. Azért van leírva, hogy egy újranyitáskor ne a (b) legyen az egyetlen alternatíva.

**Hogyan lett mérve, nem érvelve.** Próza-battéria 1898 VALÓDI flotta-soron (inter-agent üzenetek,
kanban-kommentek, napi naplók, memóriák -- minden sor, ami ütköző szót tartalmaz), mindegyik a
három alakban, ahogy a flotta ténylegesen szöveget küld (csupasz parancs, heredoc-törzs, git
commit-törzs): **0 elvesztett tiltás**, és a két valósághű alakban **4 újonnan tiltott sor** -- mind
a négy olyan flotta-üzenet, ami magukat a megkerülő stringeket IDÉZI, miközben róluk beszél. Új
próza-osztály nem keletkezett, mert az ellenőrzés `^`-hoz van kötve, egy olyan parancs-pozícióhoz,
amit a maszkolt nézet már megállapított -- a dokumentált hamis pozitívok (">= 80%", launchd
job-label, sávval elválasztott grep-minta) mind ARGUMENTUM-pozícióban ülnek egy `echo`/`grep` mögött.

**Két saját lelet a munka közben, mindkettő javítva.** (1) Az új ellenőrzés a heredoc TÖRZSÉT is
parancs-pozíciónak látta, mert a maszkoló a törzs újsorait is kiüríti, a terminátor szót viszont
meghagyja -- így a heredoc-teszteim a MÁSIK ágon mentek át, és egy negatív kontroll, ami a
heredoc-ágat teljesen kikapcsolta, ZÖLD maradt. A törzsek most külön ki vannak ürítve ebben a
nézetben, a teszt pedig a törzs KÉSŐBBI sorára tesz, amit csak a soronkénti ág lát. (2) Egy ártalmatlan
`"$(date)"` a sor elején rávehette a maszkolót, hogy feladja, és ha az új ellenőrzés csak a feloldott
szegmenseken futna, ezzel az előtaggal MINDEN megkerülés visszatérne; a visszaesési ágon is fut.

**Negatív kontroll: 6, mind pirosít** (parancsszó-ellenőrzés kikapcsolva; heredoc-ági kifejtés
kikapcsolva; inert-szegmens kihagyás eltávolítva; a heredoc nyers tesztje a kifejtettre CSERÉLVE --
tehát a additivitás is pinelve; visszaesési ág elhagyva; `$IFS` szabály kivéve a kifejtésből).

**Ki döntött:** Cybersec (az (a) opció és a három kiegészítés), backend (terv-grillezés,
implementáció, mérés). **Hivatkozás:** kártya 4f32f1f9, `src/__tests__/governance-gates.test.ts`
utolsó blokkja.

**Mért, MEGLÉVŐ hamis pozitív, amihez NEM nyúltam (külön döntés kellene):** csupasz parancsként a
`crontab "-l"` és a `launchctl "list"` -- tiszta OLVASÁSOK -- ma is tiltásra futnak, mert a maszkolt
nézetben az idézett alparancs kiürül, így az olvasás-mentesség nem illeszkedik, az írás-őr viszont
igen. Ez MEGELŐZI ezt a kártyát (a javítás előtti fájlon is reprodukáltam), és a javítása egy
ütemező-ÍRÁS-tiltás lazítása lenne, ami saját mérést és Cybersec-döntést igényel.

## 2026-08-23 09:20 -- Blast-radius ellenőrzés kikényszerítése hookkal (kártya 398f351b)

**Döntés:** A CLAUDE.md kódminőségi 10. szabálya (hívói kör megnézése megosztott/core fájl
szerkesztése előtt) kapott egy hívható belépési pontot (`store/blast-radius-check.py`) és egy
PreToolUse guardot (`scripts/hooks/blast-radius-guard.py`), ami egy hub-fájl ELSŐ szerkesztését
munkamenetenként EGYSZER blokkolja a mért sugárral, a következő próbálkozás átmegy.

**Miért ez a szemantika, és nem más:** egy figyelmen kívül hagyható emlékeztető ugyanaz a próza
maradna, amit a szabály ma is jelent; egy tartós blokk viszont az ügynök és a munkája közé állna.
Az egyszeri blokk garantálja, hogy a sugarat LÁTTÁK, anélkül hogy a munkát megállítaná.

**A konkrét paraméterek és az indoklásuk:**
- **25 importálós küszöb** -- mérésből, nem ízlésből: a CleanCore-on a levél-komponensek 2-3
  importálónál ülnek, a valódi hubok 40-520-nál. Env-ből felülírható (`BLAST_RADIUS_THRESHOLD`).
- **Fail-open MINDENRE** (hiányzó gráf, nem parse-olt fájl, új fájl, hibás payload, kivétel) --
  egy kódminőségi tanácsadó kontroll soha nem állíthatja meg a flottát. Kill switch:
  `BLAST_RADIUS_GUARD=off`.
- **200 commitnál elavultabb gráfnál HALLGAT** -- egy elavult gráf magabiztos rossz számot adna,
  ami rosszabb, mint a csend.
- **A gráfot a land-scriptek frissítik** push után. Ok: az eszköz eddig pontosan azért volt
  használhatatlan, mert senki nem frissítette (a marveen-gráf 975 committal volt lemaradva).
- **Bekötés a scaffoldból** (`injectBlastRadiusGuard` + boot-idejű `ensureBlastRadiusGuard`), nem
  kézzel másolt JSON-blokkból: a 0fa54550 kártyán a kézzel másolt őr 13 ügynökből 5-nél hiányzott.

**Cybersec-utókövetés (F-2, F-3a, ugyanezen a kártyán):** a marker-gyökér mostantól felhasználó-
specifikus a platform temp-könyvtára alatt (a korábbi fix `/tmp/blast-radius-guard` megosztott és
kiszámítható volt, tehát a kontroll csendben és tartósan kiüthető lett volna), és ha a guard nem
tudja megjegyezni, hogy már mutatta a sugarat, ezt KIÍRJA ahelyett, hogy némán elhallgatna. A
fail-open viselkedés szándékosan maradt: a kézenfekvő "hibánál blokkolj" egy írhatatlan könyvtárral
minden szerkesztést örökre megállítana.

**NYITOTT ZÁRÁSI FELTÉTEL (Cybersec F-1):** a kikényszerítés a mérés pillanatában 0/15 ügynökön
aktív. A kód landolt, de az élő install munkafája régebbi shán áll, a `dist` elavult, és az
`ensureBlastRadiusGuard` backfill KIZÁRÓLAG a szerver indulásakor fut. A kártya addig nem zárható,
amíg ez nem 15:
`grep -l "blast-radius-guard.py" ~/.claude/settings.json /home/neon/marveen/agents/*/.claude/settings.json | wc -l`
Ez üzemeltetési lépés (pull + rebuild + dashboard-restart), MikroB/Peti döntése.

**Mellékdöntés, ugyanebben a munkában:** a `fork-upstream-conflict-guard` pirosra váltott a
`src/web/keychain.ts`-en, ami minden ügynök landolását blokkolta. Feloldási szabály rögzítve: az
upstream 5 mp-es timeoutja + `keychainRetrieveStatus()` + `errSecItemNotFound`-kezelés ÁTVÉVE, a
fork `keychainDelete()`-törlése MEGTARTVA (mérve: az upstreamen sincs produkciós hívója, csak egy
teszt-mock). Egyik oldal sem egészben.

**Ki döntött:** backend2 (terv + implementáció + mérés), QA (FAIL a hiányzó döntésnapló-bejegyzésre),
Cybersec (GO a mechanizmusra, F-1 zárási feltétel, F-2/F-3a javítási javaslat).
**Hivatkozás:** kártya 398f351b, commitok 76ebb7b2, 1cc63440.

## 2026-08-23 09:55 -- A lokális modell kód-gráf kontextust kap dispatch-kor (kártya 44477615)

**Döntés:** A `store/offload-dispatch.sh` mostantól kártyánként és alfeladatonként felold egy
graphify kód-node-ot a kártya szövegéből, és átadja a `local-llm-rag.sh`-nak.

**Miért kellett:** a `--graph-node` bekötés MÁR LÉTEZETT (kártya 3646bde7), csak senki nem hívta --
a teljes repóban nulla hely adta át. Ez ugyanaz a "bekötött, de fogyasztó nélküli" hibaosztály,
mint a lint-racsni előtti ESLint.

**A node-feloldás PONTOS egyezést követel** (`store/graphify-resolve.py`), mert a graphify saját
`explain`-je fuzzy: a `routeTas` előtag a `routeTask()`-ot adja vissza. Nyers próza átadása kitalált
találatokat termelne, és azt hívnánk tudásnak. Két szűrő, mindkettő a 341 élő MikroB-kártyán mérve:
csak `code` típusú node (nélküle a leggyakoribb találat a CLAUDE.md `MikroB` fejléc-node-ja volt,
30 kártyán) és pontos kis/nagybetű (nélküle a `CleanCore` szó egy `CLEANCORE` konstansra illeszkedett,
10 kártyán). Rangsor: függvény előbb, mint fájl.

**Javított hiba:** a gráf-blokk a kilépési kódra épült, de a `graphify explain` találat NÉLKÜL is
0-val lép ki és kiírja, hogy "No node matching" -- ez a mondat bekerült a modell kontextusába
hiteles gráf-tudásként. Mostantól pozitív ellenőrzés kell (`^Node: ` sor).

**Bizonyíték, hogy a kontextus tényleg eljut a modellhez:** az Ollama saját `prompt_eval_count`-ja,
ugyanarra a feladatra, 1226 -> 1340 token gráf-node-dal.

**Elvetett mérés (fontos, mert majdnem bizonyítékként használtam):** "az 1646 `local_llm_queue`
sorból 0 hordoz gráf-kontextust" IGAZ, de VÁKUUM -- a direkt hívások egyáltalán nem tárolnak
prompt-szöveget, tehát ugyanez a nulla jönne ki akkor is, ha a funkció végig működött volna.

**Ki döntött:** backend2 (terv + implementáció + mérés).
**Hivatkozás:** kártya 44477615, commitok 74b53dc9, 9a72ad4c.

## 2026-08-23 11:10 -- A sha alak-ellenőrzése oda kerül, ahol elköltik (kártya 398f351b, F-3a-BIS)

**Döntés:** A gráf-adatbázisból olvasott `git_head_sha` alak-ellenőrzése a `staleness()` FÜGGVÉNYBE
került, három sorral a függvény egyetlen `rev-list` hívása FÖLÉ -- nem a hookba, ahol az első
verzióm volt.

**Miért:** ahol eredetileg volt, **nulla védelmet adott**. A `staleness()` a
`rev-list <recorded>..<head>`-et már lefuttatta, mire a hookban lévő ellenőrzés sorra került.
Cybersec mérte meg (F-3a-BIS) és igaza volt. Az új hely egy MÁSODIK argv-nyelőt is fed, amit addig
nem vettem számításba: a `refresh_only()` ugyanezt a shát adja tovább a
`code_review_graph update --base <sha>`-nek.

**Mit ér és mit NEM:** nem a kilépési kódot védi -- egy rossz alakú érték eggyel lejjebb amúgy is
fail-open lesz. Az OPCIÓ-POZÍCIÓ miatt van: egy `-`-szal kezdődő érték a gitnek flagként érkezik, és
DB-ből jövő szövegnek nincs keresnivalója git-opcióként. A rossz alakú érték HIÁNYZÓNAK számít (nem
hibának), így minden hívó a már meglévő "nincs rögzített sha" ágra fut -- nem keletkezik új elágazás.

**Önkorrekció, ami a döntés része:** először azt állítottam, hogy nincs olyan teszt, ami a két
elhelyezést megkülönböztetné, és inkább lefedetlenül hagytam, mint hogy látszat-tesztet írjak. A
"ne írj vákuum-tesztet" fele jó volt, a "nem lehet lefedni" fele TÉVES. Egy PATH-shim, ami naplózza
a git argv-ját, pontosan megkülönbözteti: a selftest most ezalatt futtatja a `staleness()`-t és
megköveteli, hogy a rossz alakú érték egyetlen git-hívásban se jelenjen meg. Az ellenőrzést
visszatéve a `rev-list` alá a teszt pirosra vált (a QA gate ezt függetlenül újramérte: pontosan
1 teszt pirosodik). Vákuum-kontroll is van benne, ha a shim kimarad a PATH-ból.

**Az átvihető szabály:** ne írj látszat-tesztet, DE a "nem tesztelhető" is legyen MÉRVE, ne
feltételezve.

**Ki döntött:** Cybersec (a lelet és a javasolt két hely), backend2 (implementáció, a shim-alapú
lefedés, önkorrekció). QA (FAIL a hiányzó döntésnapló-bejegyzésre -- ez a bejegyzés a válasz rá).
**Hivatkozás:** kártya 398f351b, commit eba38634.

## 2026-08-23 14:35 -- A sürgősség a fogadó SAJÁT sorát rendezi át, kor-plafon nélkül (kártya f951ec53)

**Döntés:** A `selectFairBatch` mostantól minden fogadó SAJÁT kosarán belül sürgős-előre sorrendet
alkalmaz (FIFO az osztályokon belül), a fogadók KÖZÖTTI körbeforgás érintetlenül marad. A
sürgősséget egy tisztán szöveg-alapú, CSUPA NAGYBETŰS markerre illesztő `isUrgentMessage()` dönti el
(SURGOS/SÜRGŐS/URGENT/CRITICAL/KRITIKUS + a kapu-verdikt FAIL/NO-GO), és KIZÁRÓLAG az üzenet ELSŐ
nem-üres sorát nézi.

**Miért:** a sor a DB-től a routerig szigorúan FIFO volt (`getPendingMessages ORDER BY created_at`,
majd `bucket.shift()`), a kézbesítés pedig teljes ügynök-kört fogyaszt. 2026-08-22-én ez mérhetően
30 percig tartott vissza két kapu-FAIL-t és egy sürgős Cybersec biztonsági bug-jelentést backend
sorában, mialatt négy RÉGEBBI, azóta lezárt kártyáról szóló dispatch ment ki előttük (msg 19164).
A kézbesítés sorrendje tehát semmilyen formában nem tudta, mit ér az üzenet.

**Amit tudatosan NEM építettem meg -- és ez a döntés érdemi fele:** nincs kor-plafon
(anti-starvation ceiling), ami egy túl régóta várakozó KÖZÖNSÉGES üzenetet a sürgős elé engedne.
Egy ilyen plafon pontosan ezt a hibát termelné újra: az incidensben a haszontalan dispatchek voltak
a sor LEGRÉGEBBI sorai, tehát ők nyernék vissza az első helyet. Kiéheztetés helyette szerkezetileg
korlátos: az átrendezés csak egy fogadó saját kosarán belül hat, osztályon belül marad a FIFO, és a
sürgős osztály (kapu-FAIL, biztonsági jelentés) természeténél fogva löketes, nem folytonos.

**Miért csupa nagybetű, és miért csak az első sor:** a flotta a sürgősségi tageket és a
kapu-verdikteket nagybetűvel írja, a hétköznapi próza ("this is urgent", "the build failed") pedig
kisbetűvel -- kis-nagybetű-érzéketlen illesztésnél gyakorlatilag MINDEN üzenet sürgős lenne, ami
ugyanaz, mintha egyik sem. Az első sorra szűkítés ugyanaz a horgonyzási tanulság, amit a c4f2de32
kártya rögzített a kapu-verdiktekre: egy TÖRZSBEN EMLÍTETT FAIL ("a tegnapi QA FAIL már javítva")
nem verdikt. Téves pozitív esetén a kár kicsi (egy közönséges üzenet elé kerül egy másik közönséges),
téves negatív esetén viszont a hiba marad -- ezért a küszöb tudatosan nem szigorúbb ennél.

**Ki döntött:** fullstack (gyökér-ok elemzés + implementáció + a kor-plafon elvetése).
**Hivatkozás:** kártya f951ec53, commit 6d4d37e0.

## 2026-08-23 14:55 -- A konfliktus-mentesítés a TARTALOMHOZ kötődik, nem a fájlnévhez (kártya a1d613e3)

**Döntés:** a `fork-upstream-conflict-guard.test.ts` `ACKNOWLEDGED_CONFLICTS` bejegyzései mellé
bekerült egy `ACKNOWLEDGED_UPSTREAM_BLOBS` térkép: fájlonként az az upstream-oldali blob-sha,
AMI ELLEN a feloldási szabályt megírták. A kapu mostantól három verdiktet ad egy ütköző fájlra:
**guarded** (soha nem ütközhet), **unwatched** (senki nem döntött róla), és újként **stale** --
döntöttek róla, de MÁS upstream-tartalom ellen, mint ami ma ott van.

**Miért:** a mentesítés eddig a FÁJLNÉVRE szólt és VÉGLEGES volt. Amint egy útvonal bekerült a
listába, ugyanabban a fájlban BÁRMILYEN későbbi ütközés -- más hunk, más szemantika, gyengített
állítás -- csendben átment, örökre (Cybersec élő lelete, msg 19105). Ez nem elméleti: a `0ea89716`
kártya kifejezetten AZÉRT választotta ezt a listát a `GUARDED_FILES` helyett, mert "az upstream
jogosan módosítja tovább" a fájlt -- a jövőbeli, MÁS ütközés tehát a döntés kimondott
előfeltevése volt, nem szélső eset. És a mentesített fájlok egyike, a
`src/__tests__/installer-start-and-fallback.test.ts`, maga egy őr-teszt: azt méri, hogy az
installer megszakítása tényleg megtörtént-e. Egy upstream-változás, ami ezt gyengíti, a kapun
úgy ment volna át, hogy a kapunak egyetlen mondanivalója lett volna róla: "erről a fájlról már
döntöttünk".

**Amit tudatosan a durvább granularitásra választottam, és ez a döntés érdemi fele:** a horgony a
TELJES fájl blobja, nem az ütköző hunkok tartalma. Ez TÚLJELEZ -- egy upstream-szerkesztés, ami
nem is éri az ütköző régiót, szintén új döntést kér. Ez a szándék: a túljelzés ára egyetlen
újraolvasás egy fájlon, amiről már tudjuk, hogy vitatott; az aluljelzés ára pedig pontosan az a
hiba, amit ez a kártya javít. A pontosabb alak (a konfliktus-markerek upstream oldalának hashelése)
azért esett ki, mert marker-formátum-függő, és egy csendben elmaradó egyezés ott ismét fail-OPEN
lenne. A blob-hash Cybersec saját javaslata is volt. Csillapításként a horgonyt CSAK olyan fájlra
nézzük, ami az adott futásban TÉNYLEGESEN ütközik -- egy upstream-változás, ami feloldja az
ütközést, néma marad.

**Szerkezeti, nem fegyelmi:** a térkép típusa `Record<keyof typeof ACKNOWLEDGED_CONFLICTS, string>`,
tehát egy szabály horgony nélkül VAGY egy horgony szabály nélkül FORDÍTÁSI hiba, nem két lista
csendes elcsúszása. Mérve: egy bejegyzés törlése TS2741-et ad.

**Az osztályozás tiszta függvény (`classifyConflicts`), injektált `blobOf`-fal.** Az élő kapu csak
ott fut, ahol az `upstream` remote elérhető -- seam nélkül tehát pont azokon a gépeken NEM
mérődne a logika, ahol a hálózat hiányzik, és a lelet éppen egy olyan ellenőrzésről szólt, ami
jelen volt és nem döntött semmit. Így hét offline teszt méri, plusz az élő kapu.

**Mérve, nem érvelve.** MUT-1 (a tartalom-összehasonlítás kiiktatása, vagyis a régi
csak-fájlnév szabály) -> 2 offline teszt piros. MUT-2 (egy rögzített sha elrontása) -> az ÉLŐ kapu
piros, a hibaüzenet megnevezi a fájlt, a rögzített és a mai shát, és kiírja a
`git rev-parse upstream/develop:<file>` parancsot. MUT-3 (egy horgony törlése) -> TS2741 fordítási
hiba. Az élő kapu ARMED állapotban zöld a 27 mai sha-val, tehát a szigorítás NEM blokkolja a
flottát a bevezetés napján.

**Üzemeltetési következmény, kimondva:** ez a teszt a `fleet-test.sh`-n keresztül MINDEN ügynök
landolását kapuzza. A szigorítás után egy upstream-szerkesztés egy listázott fájlon addig blokkol,
amíg valaki újra dönt és frissíti a shát. Ez szándékos (ez maga a kapu), de a javítás legyen olcsó:
a hibaüzenet a pontos parancsot adja. Ha ez a gyakorlatban túl gyakran tüzel, a következő lépés a
finomabb horgony, NEM a horgony elhagyása.

**Ki döntött:** backend (implementáció + a granularitás- és a fail-closed-irány választása).
**Hivatkozás:** kártya a1d613e3, Cybersec msg 19105.

## 2026-08-23 15:00 -- Az elavult dispatch nem a küldő hibája: a tábla újraolvasása a KÉZBESÍTÉS pontjára került (kártya 9566a197)

**Döntés:** a `formatDeliveryStalenessNote()` a kézbesítés pillanatában újraolvassa a táblát azokra a
kártyákra, amiket az üzenet küldés-kori bélyegzője (`[card-state @send]`, kártya ffaa4ff1) felsorol,
és kiírja, melyik lépett közben MÁS OSZLOPBA. Mindkét kézbesítési útba be van kötve: a router
tmux-push ága és a fő ügynök `drain-inbox` pull ága. A küldés-kori bélyegző változatlanul marad.

**Miért NEM a kártya eredeti hipotézise szerint javítottam:** a kártya feltételezése az volt, hogy a
dispatch-küldő (heartbeat/fleet-nudger) régi, cache-elt kanban-állapotból választ kártyát. A sor
adatai ezt megcáfolják. A 2026-08-22-i incidens MINDEN elavult dispatchje helyes küldés-kori
bélyegzőt visel: a 19064-es üzenet `956fdaf5 status=in_progress updated_at=1787398822`-t bélyegzett,
és a tábla pontosan ezt mondta abban a pillanatban. A kártya 35 perccel később lett `done`. Az üzenet
153 perccel a megírása után ért backend paneljére. Backend egész délutánja így néz ki (a 18976-os
üzenettől: 25, 33, 66, 97, 108, 134, 153, 166, 183 perc sorban állás), mert a kézbesítés csak akkor
történik meg, ha a fogadó pane kész, és minden kézbesítés egy teljes ügynök-kört fogyaszt.

A küldő tehát soha nem volt a hibás. A bélyegző egy FÉNYKÉP, és a hiányzó lépés az, hogy senki nem
olvasta újra a táblát a fénykép elkészítése és megmutatása között. Ezt a rést a küldés-kori bélyegző
saját fejléc-kommentje meg is jósolta ("a címzett lehet, hogy percekig vagy órákig nem olvassa el"),
csak onnan, a POST-útvonalról nem lehetett bezárni, mert a várakozás utána következik.

**Státusz és nem updated_at:** egy dispatchet az tesz értéktelenné, hogy a kártya OSZLOPOT VÁLT
(lezárul, vagy valaki visszanyitja), nem az, hogy az `updated_at`-je ketyeg. Időbélyeg-összehasonlítás
minden olyan üzenetnél megszólalna, amit MikroB közvetlenül egy kártya mozgatása után küld -- vagyis a
normál dispatch-folyamatnál --, egy egészséges forgalomra tüzelő jelzést pedig pont akkor lapoznak át,
amikor számítana.

**Ez továbbra is JELZÉS, nem kapu:** a küldés-kori bélyegzővel azonos státuszú. Egy küldő kézzel is
beírhat bélyegző-blokkot, tehát a "változott" sor csak annyit bizonyít, hogy a JELENLEGI státusz
eltér attól, amit a blokk állít. Magát a jelenlegi státuszt viszont a tábláról olvassuk, tehát a
jelzés nem tud kitalálni olyan állapotot, amiben a kártya nincs. Semmi nem kapuzik rá.

**Ki döntött:** fullstack (a hipotézis megmérése és megcáfolása, a javítás helyének kiválasztása).
**Hivatkozás:** kártya 9566a197, commit 34a253f9 és bd9675b5. Előzmény: f951ec53 (a sorrendezés
javítása), ffaa4ff1 (a küldés-kori bélyegző).

## 2026-08-23 15:14 -- A kártya-függőség éle, és mitől számít "teljesültnek" (kártya 2bb82943)

**Döntés:** egy `kanban_dependencies(from_card_id, to_card_id, created_at)` tábla, ahol
`from_card_id` a BLOKKOLT kártya és `to_card_id` a PREDECESSOR. Egyetlen sor, két nézet: a
"successor" ugyanaz az él a másik végéről olvasva, tehát nincs második tábla szinkronban tartani, és
a két irány nem tud egymásnak ellentmondani. Szándékosan KÜLÖN a `parent_id`-tól: az tartalmazás
(egy fázis birtokolja a feladatait), ez sorrend (ez a kártya nem haladhat, amíg az a másik nem kész)
-- két különböző kérdés, egy kártyán mindkettő állhat.

**A FK-k DOKUMENTÁCIÓ, NEM KIKÉNYSZERÍTÉS, és semmi nem épülhet rájuk.** A terv `ON DELETE
CASCADE`-et kért; megmértem, hogy ebben az adatbázisban az NEM CSINÁL SEMMIT: a better-sqlite3
kapcsolatonként OFF-on hagyja a `PRAGMA foreign_keys`-t (az élő DB-n mérve: 0), a fában sehol nincs
bekapcsolva, és nulla `ON DELETE CASCADE` van a teljes sémában. A törlés ezért EXPLICIT, a
`deleteKanbanCard` MÁR LÉTEZŐ tranzakciójában történik -- ugyanaz a minta és ugyanaz az ok, amiért a
3. lépés (`parent_id = NULL`) is ott van, dokumentálva a `kanban-delete-fk.test.ts` fejlécében.

**A törlés ELVÁGJA az élt, nem teljesíti.** Egy törölt predecessor után a successor azért szabadul
fel, mert a követelmény megszűnt, nem mert teljesült. Ezt ki kell mondani, különben egy blokkoló
kártya törlése láthatatlan feloldás.

**A ciklus-ellenőrzés TRANZITÍV (`WITH RECURSIVE`), nem páronkénti.** Egy `(from, to)` páros
ellenőrzés átengedné az `a->b, b->c, c->a` láncot, és az eredmény ROSSZABB, mint egy elutasított él:
a hurokban minden kártya minden másikat blokkolja, tehát a státusz-guard soha nem tud átengedni
semmit, és csak `force` hozza ki őket. A rekurziót `UNION` (nem `UNION ALL`) zárja, így egy MÁR
ciklikus tábla sem tudja megakasztani a lekérdezést.

**"TELJESÜLT" = `status = 'done'`, ÉS SEMMI MÁS -- eltérés a jóváhagyott tervtől, szándékosan.**
MikroB döntése "done VAGY archivált" volt, azzal az indoklással, hogy archiválni csak done kártyát
lehet. Ez az AUTOMATIKUS söprésre igaz (`UPDATE ... SET archived_at = ? WHERE status = 'done'`), a
KÉZI útra viszont NEM: az `archiveKanbanCard()` kizárólag azt nézi, hogy a kártya GYEREKEI done-ok,
a kártya SAJÁT státuszát soha. Egy `planned` levélkártyát tehát egyetlen `POST /api/kanban/:id/archive`
archivál. "Done VAGY archivált" mellett ez az egy hívás CSENDBEN teljesítene egy függőséget, amit
senki nem fejezett be -- `force` nélkül, audit-sor nélkül, vagyis egy egy-hívásos megkerülése az
egész guardnak. A `status` önmagában semmit nem veszít abból, amit a terv akart: az archiválás nem
írja át a `status`-t, tehát egy automatikusan archivált done predecessor továbbra is `done`-ként
olvasódik és továbbra is teljesít.

**Mérve, nem érvelve.** MUT-1 (az explicit kaszkád törlése) -> 2 piros, köztük a "dangling row"
teszt; MUT-2 (tranzitív helyett páronkénti ciklus-ellenőrzés) -> az `a->b->c->a` teszt piros, a
diamond-kontroll zöld marad (tehát a hurkot utasítjuk el, nem a "több út ugyanahhoz a kártyához"-t);
MUT-3 (a terv szerinti "done VAGY archivált") -> a bypass-teszt piros. 14 új teszt.

**Ki döntött:** backend (implementáció); a "done VAGY archivált" -> "done" szűkítés az én
eltérésem a jóváhagyott tervtől, méréssel indokolva, MikroB jóváhagyására vár a review-ban.
**Hivatkozás:** kártya 2bb82943 (szülő 37c5605a), plan-grilling verdikt: kártya-komment 15492.

## 2026-08-23 15:30 -- A függőség-kapu a DB-írókban áll, nem a route-okban (kártya a8aa9ae5)

**Döntés:** a státuszváltás-kapu a `moveKanbanCard`-ban és az `updateKanbanCard`-ban érvényesül, nem
a HTTP-kezelőkben. A route-ok továbbra is építenek egy szép 409-et, de UGYANAZT a predikátumot
(`dependencyBlockers`) hívják, amit az írók -- egy függvény, két fogyasztó, tehát nem tudnak
elcsúszni egymástól.

**Miért nem a route-okban:** HÁROM ajtó vezet státuszváltáshoz -- `PUT /api/kanban/:id`,
`POST /api/kanban/:id/move`, és a `db.ts` SAJÁT, ütemezőből jövő `moveKanbanCard(...)` hívása. Egy
route-szintű kapu ebből kettőt lát. A repo ezt már egyszer megtanulta: a landolás-kapu kommentje a
route-okban szó szerint azt mondja, hogy "guarding one of two doors guards neither" (kártya
9cc72f2c). A terv eredeti alakja ("guard a PUT-ban") ezt a hibát ismételte volna meg.

**Mindkét irány kapuzott (`in_progress` ÉS `done`), a `waiting` NEM.** Peti szövege szerint a
függőségnek a fejlesztés TELJESÜLÉSÉHEZ kell teljesülnie, nem csak az indításához. A `waiting`
kihagyása viszont tudatos: egy építő ügynöknek mindig át kell tudnia adni a kész munkát egy
kapunak -- a blokk a ZÁRÁSNÁL a helyes hely, nem az átadásnál.

**A 409 GÉPI OLVASHATÓ (`code: 'dependency_blocked'` + `blockedBy` tömb), nem csak próza.** A
`gate-reconciler` 5 percenként próbál zárni minden PASS-olt `waiting` kártyát; egy blokkolt kártya e
nélkül óránként tizenkét sikertelen zárási kísérletet kapna. A kódból a reconciler fel tudja
ismerni a 4a(d) "kötött-blokk" esetet és EGYSZER annotálni. Ha szövegre kellene illesztenie, a
viselkedés a hibaüzenet megfogalmazásától függene.

**A kapu VALÓDI átmenetre néz, nem a cél-státuszra önmagában.** A `moveKanbanCard` egyben a
drag-and-drop útvonal is: ha a feltétel csak azt nézné, hogy a cél `in_progress`, akkor egy MÁR
`in_progress` kártyát nyitott predecessorral soha nem lehetne a saját oszlopán belül átrendezni.
Kiszegezve külön teszttel; a `prev !== status` feltétel elhagyása mutációként pirosítja.

**A `force` megkerüli, ÉS az audit-sor rögzíti** (`kanban_card_events.forced = 1`) -- de csak akkor,
ha a tranzakció TÉNYLEG a kapun ment át. Egy hétköznapi, rutinból `force: true`-t küldő kliens
mozgása nem override, és nem is szabad annak látszania, különben a flag használhatatlan a valódi
átlépések megtalálására. Ez ugyanaz a megkülönböztetés, amit a `reviewedCardBlocksInProgress`
kapunál már meghoztak.

**Mérve:** MUT-A (kapu csak a route-okban, a terv eredeti alakja) -> 2 piros; MUT-B (kapu kivéve az
`updateKanbanCard`-ból) -> 1 piros; MUT-C (cél-státusz önmagában) -> a reorder-teszt piros. 9 új
teszt a kapura, 23 összesen a kártya-családban.

**Ki döntött:** backend (implementáció), a plan-grilling F-1 verdiktje szerint, amit MikroB
változtatás nélkül elfogadott.
**Hivatkozás:** kártya a8aa9ae5 (szülő 37c5605a), plan-grilling: 37c5605a komment 15492.

## 2026-08-23 15:40 -- Az email-kapu csak az ADATOT hordozó heredocot üríti ki, az értelmezőnek adottat nem (kártya 84e31b40)

**Döntés:** a `scripts/email-send-gate.mjs` Bash-ága két kiürítő menetet futtat a mintaillesztés előtt:
a meglévő `stripDataPayloads` (soron belüli `-d '<literál>'`) mellé bekerült a `self-pace-gate.mjs`-ből
IMPORTÁLT `stripHeredocDataPayloads`. Emellett a tiltó üzenet mostantól megnevezi a helyes alakot
(`curl --data-binary @fájl`, `git commit -F fájl`), nem csak azt, hogy küldd jóváhagyásra. A
szó-közelségi mintához (31. sor) NEM nyúltam.

**Miért a jelenlegi javítás nem volt elég:** a 132fc28c a hibaosztály EGY alakját zárta le, a soron
belüli `-d` literált. Ugyanaz a próza, ugyanannak a curlnek átadva STDIN-en (`-d @-` + heredoc),
továbbra is tiltás alá esett. Vagyis az, hogy egy ügynök a két egyenértékű alak közül melyiket
választja, biztonsági döntéssé vált -- miközben a tiltó üzenet egyiket sem nevezte meg, tehát a mért
kimenet az volt, hogy az ügynök vagy feladta, vagy obfuszkálni kezdte a szöveget. A kettő közül az
obfuszkálás a rosszabb, ezért az üzenetnek ki KELL mondania a legális utat.

**A tervezési döntés, ami a kártya 2-es opciójától eltér:** a javaslat szó szerint az volt, hogy a
`stripDataPayloads` terjedjen ki "idézett heredoc-törzsre, ugyanazzal a logikával". Ez így LYUKAT
NYITNA. Egy értelmezőnek adott heredoc (`python3 <<'PY' ... PY`) törzsét a python VÉGREHAJTJA, tehát
egy ott elrejtett valódi küldés ma tiltás alá esik, egy általános heredoc-mentesítés után viszont nem
esne. Ezért csak azt a heredocot ürítjük ki, aminek a SAJÁT egyszerű parancsa a curl `-d @-` adatként
vagy a git commit-üzenetként olvassa -- olyan bájtokat, amiket ezek a binárisok továbbítanak vagy
eltárolnak, de sosem hajtanak végre. Ez pontosan a `self-pace-gate.mjs` már meglévő, Cybersec
NO-GO-val (4638c14c) megkeményített megkülönböztetése.

**Miért import és nem másolat:** ugyanaz a shell-elemzési probléma, és a másolat az a forma, ahol a
javítás az egyik ikerbe landol, a másik pedig csendben megtartja a lyukat. A ~60 sornyi
biztonságkritikus elemzés duplikálása itt rosszabb, mint a két hook közti csatolás.

**Amit a mutáció-mérés mond:** a naiv olvasat (MINDEN idézett heredoc-törzs kiürítése) 3 tesztet
pirosít -- a python3-heredoc, a node-heredoc és a Cybersec-féle `-d @-` csali esetét. A heredoc-menet
teljes elhagyása 2 tesztet pirosít (a két jogos ENGEDÉLYEZÉST). Mindkét irány mérve, nem feltételezve.

**Maradó rés, amit ez NEM old meg (szándékosan):** a bejelentés (a) és (c) esete -- egy `grep`
parancs, aminek a MINTÁJA tartalmazza a szolgáltató nevét, illetve magának a hook forrásának az
olvasása -- továbbra is tiltás alá esik. Ezekben nincs payload, amit ki lehetne üríteni, és a
"csak-olvasó parancs" általános bizonyítása külön hibaosztály. A tiltó üzenet ezekre nem ad
kerülőutat, mert nincs is: ilyenkor az ügynök a fájlt más néven hivatkozva vagy a kérdést MikroB-nak
továbbítva jut előre. Obfuszkálás továbbra sem megengedett.

**Ki döntött:** MikroB (1-es opció, opcionálisan 2-vel; a 3-ashoz tilos nyúlni), fullstack (a 2-es
opció biztonságos alakja: adat-heredoc igen, értelmező-heredoc nem).
**Hivatkozás:** kártya 84e31b40, commit 038c57f0. Előzmény: 132fc28c (a soron belüli literál),
4638c14c (a csali-lelet a self-pace kapun).
## 2026-08-23 15:38 -- A blokkoló kártya prioritása ott állítható, ahol a blokk látszik (kártya 73540a68)

**Döntés:** a kártya-modál két új szekciója (predecessorok / successorok) EGY `GET
/api/kanban/:id/dependencies` hívásból renderel, teljes kártya-objektumokkal -- így egy öt élű
kártya egy kérést indít, nem hatot. Az inline prioritás-select KIZÁRÓLAG a predecessor-sorokon van,
és a MÁSIK kártya prioritását írja, a már létező `PUT /api/kanban/:id`-n keresztül. Nincs új mező és
nincs új végpont.

**Miért a predecessor-sorokon, és miért ez a feature lényege:** amikor egy kártya blokkolva van, a
hasznos cselekvés nem a saját prioritásának állítása, hanem azé, ami útban van -- az pedig egy MÁSIK
kártya, amit különben meg kell keresni a táblán, meg kell nyitni, és ott állítani. A blokk ott
látszik, ahol a kártyát nézed; a gomb is oda való.

**Az azonosító a hiteles, nem a cím.** A hozzáadás egy `datalist`-ből választ, és a listaelem
`"<cím> [<id>]"` alakú; a gomb az `[id]`-t olvassa ki. Két kártyának lehet azonos címe, és egy
cím-alapú egyeztetés némán a rosszhoz kötné a függőséget.

**A 409 ELÉR A FELHASZNÁLÓIG, mégpedig azzal, hogy MELYIK kártya blokkol** (12. munkavégzési
szabály). A `kanbanMoveErrorMessage()` a `code: 'dependency_blocked'` mezőre illeszt -- nem a
hibaüzenet szövegére --, és a `blockedBy` címeit írja ki. Ez mindhárom mozgatási úton bekötve van.

**Egy MEGLÉVŐ hibát is ez hozott felszínre, és javítva lett:** a HTML5 drag-and-drop drop-kezelője
egyáltalán NEM nézte a választ (`await fetch(...)` `r.ok` ellenőrzés nélkül), tehát egy elutasított
mozgatás némán újrarendert az RÉGI állapottal -- a felhasználónak ez UI-hibának látszik, nem
elutasításnak. A guard nélkül ez évekig láthatatlan maradhatott volna, mert eddig alig volt olyan
elutasítás, ami drag közben elsül. Most mindhárom hívás olvassa a választ.

**Ki döntött:** backend (implementáció).
**Hivatkozás:** kártya 73540a68 (szülő 37c5605a), pair-BE a8aa9ae5.

## 2026-08-23 15:45 -- A force-bypass AKTOR-KAPUZOTT, és az allowlista egy helyen él (kártya a8aa9ae5, Cybersec F-1)

**A hiba, amit szállítottam:** a függőség-kapu bypassa `force`-ra nézett és semmi másra. A kártya
saját szövege ezt kérte: "a MÁR LÉTEZŐ force-flag+actor mintával" -- én a felét vettem át. Cybersec
élő reprodukciója: `moveKanbanCard(..., force: true)` aktor NÉLKÜL -> `true`, és az audit-sor
`actor=null, forced=1`. Vagyis a nyom, ami a bypasst utólag megmagyarázná, üresen maradt.

**Miért MEDIUM-HIGH és nem stílus:** ugyanezen az állapotgépen mind a három testvér-kapu
(landolás-kapu, gate-teljesség, newDevStop) aktor-kapuzott, és amelyik egyszer nem volt az, azt ki
is használták -- kártyák 31cc1cd4 / 874a9fb0 / 23594bbc. Egy kapu, ami bárkinek nyílik `force:true`
hatására, nem kapu, csak egy plusz mező a kérésben.

**A javítás nem csak a mienk:** az allowlistából HÁROM privát másolat volt három fájlban
(`new Set(['mikrob'])`), ami pontosan az az alak, ahol egy későbbi bővítés az egyik példányba
landol, a másik kettő pedig megtartja a saját elképzelését. Ezért egy modul lett belőle
(`src/kanban-force-actors.ts`, `isForceActor(force, actor)`), és MIND A HÁROM régi kapu is azt
olvassa -- a saját tesztjeik változatlanul zöldek (92/92 a három suite-ban együtt).

**A route-oldali 409 UGYANAZT a szabályt alkalmazza.** Ha a `dependencyBlockBody` továbbra is csak
`force`-ot nézne, egy nem-allowlistás `force:true` itt átmenne, lejjebb pedig elbukna -- a hibaüzenet
és a tényleges döntés nem mondhat mást.

**Amit KI KELL MONDANI, és Cybersec is kimondta: ez nem hitelesítés.** Az `actor` önbevallás; a
dashboard API egészében bearer-tokennel védett, de semmi nem köti a kérést ahhoz a névhez, amit a
törzsébe ír. Ez tehát sebességkorlát, ami szándékossá és a naplóban megnevezetté teszi az átlépést,
nem bizonyíték arról, ki tette. Ugyanez a korlát áll a három régebbi kapura is -- nem új gyengeség,
és nem szabad erősebbnek leírni, mint amilyen.

**Mérve:** a force-only alakra visszaállítva PONTOSAN az új teszt pirosodik. A teszt kontrollt is
tartalmaz (`forceActors()` valóban tartalmazza a fixture aktort), különben az "elutasítja" ág attól
is zöld lenne, hogy elgépeltem a nevet.

**Ki döntött:** backend (javítás), Cybersec F-1 leletére.
**Hivatkozás:** kártya a8aa9ae5.

## 2026-08-23 16:05 -- A heredoc-tulajdonos meghatározása megáll a beágyazott parancs-kontextusnál (kártya 84e31b40, Cybered NO-GO F-1/F-2)

**Döntés:** a `stripHeredocDataPayloads` `boundary`-je mostantól a négy beágyazott parancs-kontextus
nyitójelénél is lép, nem csak `;` `&` `|` és újsor hatására. Szándékosan NEM állítja vissza a külső
határt a záró jelnél: egy helyettesítés UTÁN álló heredoc így a nyitójeltől méri a saját spanját,
elbukik a vezető-bináris ellenőrzésen, és teljesen szkennelve marad -- ez a fail-closed irány.

**Miért blokkoló és miért az én hibám:** a heredoc-kiürítés azt kérdezi, hogy „a heredoc ELŐTTI
egyszerű parancs adatként olvassa-e ezt", és a választ a legutóbbi határjelig visszaolvasva adta meg.
Egy beágyazott kontextus nem volt határjel, tehát egy BELSŐ értelmező heredocja a KÜLSŐ curl spanjából
mérte magát, kielégítette mindkét tulajdonlási feltételt, és kiürült -- miközben a bash ténylegesen
lefuttatta. Cybered nem állt meg a szkennelőnél: ártalmatlan payloaddal (marker-fájl írása)
bizonyította, hogy a kiürített törzs VÉGREHAJTÓDIK. Öt alak, és mind az öt a szülő commiten még
tiltás alá esett, tehát a lyukat az előző commitom vitte be az email-kapuba.

**Amit ez a lelet a saját előző REVIEW-mról mond:** azt írtam, hogy az import azért biztonságos, mert
a függvény „már átesett egy biztonsági javításon". Ez igaz volt, és mégis kevés: egy korábbi
NO-GO-val megkeményített függvény nem ugyanaz, mint egy kimerítően megvizsgált függvény. A QA PASS és
a Cybersec GO is elment mellette -- mindkettő a tulajdonlási FELTÉTELEKET nézte (curl-e a vezető
bináris, ott van-e a `-d @-`), egyik sem azt, hogy a span HATÁRA hol van. A feltétel helyes volt; a
bemenete nem.

**Amit az import-döntésről mond:** semmi rosszat, sőt. Mivel a járó közös, EGY javítás mindkét kaput
zárja, és a self-pace kapun ez a lyuk 4638c14c / 0229c844 óta nyitva állt -- másolat esetén két
helyen kellett volna megtalálni és javítani.

**Regresszió mind az öt alakra, MINDKÉT suite-ban, külön fájlban.** Nem egy összevont eset: abból
négy alak csendben visszajöhetne a járó következő átírásakor. A self-pace oldal külön fájlt kapott
(`self-pace-nested-command-context.test.ts`), mert ott más payload-osztályt rejt (ütemező-hívás, nem
küldés), és egy csak az email-suite mellett élő regresszió ezt a kaput lefedetlenül hagyná.

**Mérve, nem feltételezve:** a határlépés visszavételével mindkét suite-ban pontosan 6 teszt pirosodik
(az öt alak + a negyedik nyitójel kontrollja), a két jogos ENGEDÉLYEZÉS-kontroll mindkettőben zöld
marad. Ez zárja ki, hogy a javítás valójában a kártya eredeti céljának visszavonása lenne.

**Ki döntött:** Cybered (a lelet, az élő repro és a lemért javítás), fullstack (végrehajtás, a
záró-jel-visszaállítás elhagyása fail-closed indokkal, a kétszeres regressziós lefedés).
**Hivatkozás:** kártya 84e31b40, commit e12d81b0. Előzmény: f4fac1d7 (ez nyitotta az email-kapun),
4638c14c és 0229c844 (a self-pace kapun eddig is nyitva volt).
## 2026-08-23 15:55 -- A `blocked` SZÁRMAZTATOTT mező, egy lekérdezésből (kártya 38788337)

**Döntés:** a `GET /api/kanban` és a `GET /api/kanban/:id` válasza egy `blocked: boolean` +
`blockedBy: [{id,title,status}]` mezőt ad, KISZÁMÍTVA, nem tárolva.

**Miért nem tárolt oszlop:** egy `blocked` flag a `kanban_cards`-on második igazságforrás lenne, ami
abban a pillanatban elavul, amikor egy predecessor lezárul -- és a táblát nagyságrendekkel gyakrabban
olvassuk, mint írjuk. Egy elavult flag itt rosszabb, mint a számítás ára: a board azt mutatná, hogy
egy kártya blokkolt, miközben a kapu átengedi (vagy fordítva), és a felhasználó a kettő közül a
rosszabbikat hinné el.

**EGY lekérdezés, nem N+1.** A board a TELJES táblát adja vissza, tehát kártyánkénti kérdezés pár
száz sornál egy N+1 lenne minden dashboard-poll-on. Ugyanaz az alak és ugyanaz az ok, amiért a
lista-kezelő a címkéknél már a `getLabelsForAllCards` bulk-JOIN-t használja. A blokkolatlan kártyák
egyszerűen HIÁNYOZNAK a map-ből -- a hívó a hiányzó kulcsot olvassa "nem blokkolt"-ként --, mert egy
üres tömb tárolása több százszor semmit nem mond.

**A két út UGYANAZT mondja.** A lista a bulk-lekérdezést használja, a `GET /:id` a per-kártya
predikátumot. Külön teszt hasonlítja össze őket kártyánként: ha eltérhetnének, egy kártya a
táblán blokkoltnak látszana és megnyitva szabadnak -- pont az a split-brain, amit egy származtatott
mezőnek meg kell előznie.

**A kártya EREDETI célja hibás premisszán állt, és MikroB át is írta.** Az eredeti szöveg a
`src/kanban-dispatch.ts`-t célozta "ahol a legmagasabb prioritású dispatchelhető leaf kártyát
választja" -- a fájl 89 soros, és azt dönti el, MELYIK ÜGYNÖKÖT ébresszük egy MÁR kiválasztott
kártyához. A kártya-választás a `folyamatos-munka-orchestrator` PROMPTJA, nem kód. A valódi védelem
az `a8aa9ae5` kapuja (blokkolt kártya nem mehet `in_progress`-be, bárki választotta); ez a kártya a
UX-fele, és NEM szabad kapuként hivatkozni rá.

**README:** a kanban API-t a README sehol nem dokumentálja (`grep "api/kanban"` -> 0 találat), tehát
ott nem keletkezett hazugság; a fork-fejlesztések szekció viszont bővült a függőség-feature-rel.

**Mérve:** a `status <> 'done'` szűrő kiiktatása -> a "done predecessor kiesik" teszt piros; a JOIN
rossz végre kötése -> öt teszt piros; a csoportosító oszlop beszivárogtatása a kártya-objektumba ->
a "whole cards" teszt piros. 5 új teszt, 29 a kártya-családban.

**Ki döntött:** backend (implementáció), MikroB (a kártya céljának átírása a plan-grilling F-3 után).
**Hivatkozás:** kártya 38788337 (szülő 37c5605a).


## 2026-08-23 16:35 -- A beágyazott kontextus ZÁRÁSA a külső parancshoz tér vissza, nem a nyitójelhez (kártya 84e31b40, Cybersec NO-GO F-2)

**Döntés:** a `stripHeredocDataPayloads` egy kis veremben megőrzi a külső határt a beágyazott
kontextus nyitásakor, és a záráskor VISSZAÁLLÍTJA. Nem a javasolt egysoros változat (lépés a
zárójeleknél) ment be -- azt lemértem, és cserét kér, nem javítást.

**Miért volt hibás az előző körben kimondott indoklásom:** azt írtam, hogy a záró jelnél nem
visszaállított határ „fail-closed, a költség egy esetleges fals-pozitív, sosem megkerülés". Ez nem
áll. A span attól, hogy a helyettesítés nyitójától indul, nem bukik el automatikusan a
vezető-bináris ellenőrzésen -- ÁTMEGY rajta, ha maga a helyettesítés curl-lel kezdődik. Cybersec ezt
megmérte a szülőhöz képest: `$( )`, `<( )` és `>( )` mind ENGEDÉLYEZÉSRE fordult, a backtick pedig
csak VÉLETLENÜL maradt tiltva (a záró backtick újra illeszkedik a nyitó mintára). A véletlen nem
garancia, ezért a backtick-alak is kapott tesztet.

**Miért nem a javasolt egysoros ment be:** lemértem, és valóban lezárja mind a négy inverziót. De
két új problémát hoz. (1) `python3 $()curl -d @- <<'PY'`: a bash argv-je `[python3, curl, -d, @-]`,
tehát a heredocot a python3 hajtja végre, miközben a `)` UTÁN induló span curl-lel kezdődik -- új
megkerülés, ami a jelenlegi szállított kódban NINCS. (2) Egy hétköznapi jogos payload, aminek a
parancsa csak TARTALMAZ egy helyettesítést (`curl -H "Authorization: Bearer $(cat tok)" -d @-
<<'JSON'`), fals-pozitívvá válik -- vagyis pont azt hozza vissza egy gyakori alakra, amit ez a
kártya megszüntetni jött.

A vermes visszaállítás mindkét családot zárja, ÉS a jogos payloadot az engedélyezett oldalon tartja.

**Mérés, 19 eset, minden alak amit a két gate megnevezett + a magam két próbája:**

| változat | rossz eset |
|---|---|
| szállított kód (c17173fc) | 5 (INV-1..3, a beágyazott-helyettesítés alak, és a jogos payload) |
| javasolt egysoros (lépés a zárónál) | 2 (a konkatenációs alak, és a jogos payload) |
| vermes visszaállítás (ez ment be) | 0 |

**Mutáció-mérés, mindkét suite-ban:** a vermes visszaállítás nyitó-csak változatra cserélve 9 teszt
pirosodik; a javasolt egysorosra cserélve 3. Nem feltételezés: mindkét változatot lefuttattam.

**Az átvihető tanulság, amit a saját hibámból írok le:** egy span-alapú „ki a tulajdonos" heurisztikánál
a HATÁR ugyanolyan támadási felület, mint a FELTÉTEL. Az első körben a feltételt (curl-e a vezető
bináris, ott van-e a `-d @-`) mindhárom gate megvizsgálta, a határt egyik sem -- és a határnak KÉT
oldala van, amit külön kell végiggondolni: hol kezdődik egy beágyazott parancs, és hol ér véget.

**Ki döntött:** Cybersec (a lelet, az élő mérés és az egysoros javaslat), fullstack (a vermes változat
a javasolt egysoros helyett, mindkettő lemérve, plusz a két saját próba-alak).
**Hivatkozás:** kártya 84e31b40, commit 4e58a8d4. Előzmény: c17173fc (a nyitó-csak javítás),
f4fac1d7 (a heredoc-járó bekötése az email-kapuba).

## 2026-08-23 16:16 -- A Gate:-sor zárójeles részeit TÖRÖLNI kell, nem vágni nála (kártya aa837c5b)

**A hiba:** a `designated_from_gate_line` az ELSŐ nyitó zárójelig VÁGTA a sort, tehát egy több
ügynököt megnevező sorban -- `Gate: QA (funkcionális...), Cybersec (trust-boundary...)` -- a második
nevet eldobta, és a hozzá tartozó kaput `ADVISE-SKIP:not-designated`-nek jelentette. Ez a
LEGROSSZABB verdikt erre a hibára: a `not-designated` az EGYETLEN eset, ahol a nudger skip-kommentet
sem ír, tehát a kártya nyomtalanul esett volna ki a söprésből.

**A javítás két lépés, ÉS A SORREND SZÁMÍT.** (1) A zárójeles részek TÖRLÉSE (legbelső előbb,
amíg a szöveg változik -- a beágyazás így nem hagy törmeléket), majd (2) vágás a mondatvégi
írásjelnél, változatlanul. Cybersec javaslata csak az (1) volt; a (2) elhagyása visszanyitná az
`55af560d` MÁSIK alakját, ahol a kizárás TRAILING MONDAT és nem zárójel
("QA + Cybered (...). Cybersec kimarad: ..."). A két fél együtt tartja mindkét esetet.

**Miért nem szótár:** a negáció-szavas lista ("nem", "not", "kimarad") ugyanaz a
soha-nem-teljes-szókincs csapda, amit ez a flotta más kapuknál már megjárt. A klauzula-pozíció
szerkezeti, nem szókincs, tehát nem avul.

**Mérve az ÖSSZES élő eseten, nem csak a hibáson.** A három illeszkedő kártya közül kettőnél a régi
vágás HELYESEN döntött, és az új sem rontja el:

    1e408bd7  RÉGI=[qa]           ÚJ=[qa]            változatlan  (a "Cybersec" a zárójelen BELÜL van)
    d10e3e70  RÉGI=[qa,cybersec]  ÚJ=[qa,cybersec]   változatlan  (mindkét név a zárójel ELŐTT)
    132a6cfb  RÉGI=[qa]           ÚJ=[qa,cybersec]   JAVÍTVA      (ez a defekt)

Az 1e408bd7 külön értékes: ott a "Cybersec" szó a magyarázó zárójelen belül szerepel, és a
törlés-alapú megoldás ugyanúgy figyelmen kívül hagyja, ahogy a vágás tette -- vagyis a javítás nem
lazít, csak a zárójelen KÍVÜLI neveket nyeri vissza.

**Az önteszt a bizonyíték, és bővült.** A meglévő `55af560d`-készlet változatlanul zöld (a
`241532d8` és `35533cca` alakok, plusz az `51e8532e` BEÁGYAZOTT zárójeles sora, ami a ciklust is
ellenőrzi). Öt új eset a defektre és a két fél kereszt-hatására. KONTROLL: a régi vágásra
visszaállítva PONTOSAN a két "második nevet is megnevezi" eset pirosodik, a `55af560d`-készlet zöld
marad -- tehát az új tesztek a javítást mérik, nem a harness-t.

**Egy tanulság a szerkesztésről is:** a parser egy `python3 -c '...'` blokkban él, tehát APOSZTRÓF
nem lehet benne. Az első kommentem `55af560d's`-t írt, és a `bash -n` azonnal elhasalt rajta -- a
`hook-command-quoting` hibaosztály, csak most a saját kommentemben.

**Ki döntött:** backend (implementáció + a sorrend-döntés), Cybersec (a lelet és a törlés-alapú irány).
**Hivatkozás:** kártya aa837c5b, Cybersec msg 18949.

## 2026-08-23 16:25 -- HELYESBÍTÉS: a foreign key ENFORCED az appban; és egy feloldhatatlan predecessor BLOKKOL (kártya 37c5605a, Cybered F-1/F-2)

**ELŐSZÖR A SAJÁT TÉVEDÉSEM, mert két korábbi bejegyzés épült rá.** Azt írtam (2bb82943), hogy az
`ON DELETE CASCADE` ebben az adatbázisban semmit nem csinál, mert a `PRAGMA foreign_keys` 0. A
mérésem **rossz kliensen** készült: PYTHON `sqlite3`-mal, ami OFF-fal indul. A **better-sqlite3** --
amit ez az alkalmazás ténylegesen használ -- **ON-nal**: mérve `1` mind a memóriabeli, mind az élő
fájlon. Tehát az appon keresztül a `REFERENCES` IGENIS harap, és egy kártya törlése HIBÁVAL bukna,
ha valami nem takarítaná el előbb az éleket. A kód nem változik ettől: a `deleteKanbanCard`
tranzakción belüli, mindkét irányú takarítása pont ezért nem "öv és nadrágtartó", hanem az, ami a
törlést egyáltalán lehetővé teszi. A kódban lévő komment javítva.

**Cybered F-2 mechanizmusa NEM áll, a veszély viszont igen.** Lemértem a pontos alakot (él `s2->p2`,
majd `p2` törlése) a PRODUKCIÓS belépési ponton, a `deleteKanbanCard`-on keresztül: **nulla** sor
marad, mindkét irány takarítva. Amit Cybered mért, az a sqlite3 CLI-vel történt, ami megkerüli ezt
az utat. DE a mögöttes aggodalom valós, és ezért javítottam: ha egy él MÉGIS danglinggé válik -- és
ebben a flottában ez elérhető, mert az ügynökök közvetlenül írnak sqlite3 CLI-vel és pythonnal,
mindkettő FK-OFF alapértelmezéssel, ugyanaz a szokás, ami a timestamp-integritás triggereket
szükségessé tette --, akkor az `INNER JOIN` **eldobta** volna a sort, és a kártya "semmi nem
blokkol"-ként olvasódott volna. Ez FAIL-OPEN.

**A javítás: `LEFT JOIN` + explicit hiányzó-ág.** Egy feloldhatatlan predecessor `status: 'missing'`
pszeudo-kártyaként jelenik meg, az azonosítójával a címben. ISMERETLEN ÁLLAPOT = BLOKKOL, mert a
másik lehetőség egy néma feloldás, amit senki nem lát. A guard is refuse-ol rá, és a board is
mutatja.

**F-1: a `blocked` mezőnek nem volt fogyasztója.** A `38788337` óta az API vitte, és a FE sehol nem
renderelte -- a felhasználó csak PRÓBÁLKOZÁSSAL tudta meg, hogy egy kártya blokkolt. Egy állapot,
amit a szerver tud és a board elrejt, rosszabb, mint ha nem is lenne: valaki olyan kártya köré
tervez munkát, amit el sem tud kezdeni. Most a kártya tompított (nem elrejtett -- ez valódi munka,
csak még nem indítható), sárga bal szegéllyel, lakat-ikonnal és tooltipben a blokkolók címeivel. A
hiányzó predecessor KÜLÖN ikont kap (⚠️), mert a "várok valamire, ami már nem létezik" emberi
beavatkozást kér, nem türelmet.

**Mérve:** az `INNER JOIN`-ra visszaállítva PONTOSAN a három fail-open teszt pirosodik; kontroll,
hogy egy feloldható predecessor továbbra is a VALÓDI címével és státuszával jön (e nélkül egy
"mindent hiányzónak nevező" implementáció is zöld lenne); és külön kontroll arra, hogy a produkciós
törlés-út után NULLA él marad.

**Ki döntött:** backend (implementáció + a saját FK-mérés helyesbítése), Cybered (mindkét lelet).
**Hivatkozás:** kártya 37c5605a, gyermekei 2bb82943 / a8aa9ae5 / 73540a68 / 38788337.

## 2026-08-23 -- 1ce3fd90 -- Modell-lépcsőzés LEFELÉ friss sessiont indít, és ehhez előbb a replay-matchert kell kinyitni

**A hiba, amit javít.** A `model-fallback-runner` minden modellváltásnál `--continue`-vel élesztette
újra az ügynököt. Lefelé lépésnél ez azt jelenti, hogy a nagyobb modellen felhalmozott előzményt
újra be kell tölteni egy KISEBB kontextusablakú modellbe, cache nélkül. Mérve Fron Teden: 593 843
token Haikura váltva két egymást követő tömörítést kényszerített ki (52 s + 63 s), és a session
utána is „Context limit reached" állapotban ragadt -- egyetlen értelmes választ sem adott. Az a
mechanizmus, aminek dolgozni hagynia kellene az ügynököt, tette használhatatlanná.

**1. döntés: a feltétel a LÉPÉS IRÁNYA, nem a kiváltó tengely.** A kártya a heti kvóta-lépcsőt írta
le, de a banner-tengely (5 órás limit) ugyanazokon a modelleken lépked lefelé, ugyanazzal a
felhalmozott kontextussal. Ha csak a heti ágra kötném, a testvér-útvonalon változatlanul élne
ugyanaz a hiba -- ez a „javítás a nem használt ikerfájlba landolt" osztály. A `steppingDown`
amúgy is ki volt már számolva a hívási helyen. FELFELÉ (revert) marad `--continue`: a nagyobb modell
elbírja az előzményt, és ott a beszélgetés megőrzése érték.

**2. döntés: a `taskstate-replay` matchere ELŐFELTÉTEL, nem ráadás.** Ez a kártya nem lett volna
javítás nélküle. A hook `matcher`-e mind a 15 telepített `settings.json`-ben (14 ügynök + main)
`compact|resume` volt, tehát egy FRISS session forrása (`startup`, illetve `/clear` után `clear`)
el sem indította volna a hookot: a `fresh: true` csendben folytonosság-VESZTÉS lett volna, nem
javítás. Mérve, nem feltételezve.

Ez önmagában is egy már meglévő rés: a döntési fél (`REPLAY_SOURCES`) 2026-07-ben megkapta a
`startup`-ot a crash-respawnok miatt, a KIVÁLTÓ fél nem -- vagyis a támogatás azóta minden
hidegindításnál elérhetetlen volt. Pontosan a `91c4a369` (egress-gate) tanulsága: a szkriptre
hivatkozni nem ugyanaz, mint lefuttatni azokon a hívásokon, amik számítanak.

**3. döntés: a matcher és a `REPLAY_SOURCES` HALMAZ-AZONOSSÁGA tesztben áll, nem a két konkrét
érték.** A hibaosztály az, hogy a két fél külön szerkeszthető; egy „tartalmazza-e a `clear`-t" teszt
ugyanazt a driftet engedné legközelebb. Ezért a teszt a matcher `|`-ekre bontott ágait a
`REPLAY_SOURCES` halmazzal veti össze, mindkét irányban. Ehhez a `REPLAY_SOURCES` exportálva lett --
egy teszt-oldali MÁSOLAT pont az a második definíció, ami elsodródhat.

**4. döntés: a boot-migráció WIDEN-ONLY, sosem hoz létre hookot.** A seed-sablonok írják a
SessionStart-blokkot; egy injektor itt a UGYANANNAK a bejegyzésnek a második definíciója lenne,
szabadon eltérhetve. Mérve: mind a 15 fájl HIVATKOZIK a szkriptre, csak a matcher volt elavult --
tehát a szélesítés mindenkit elér, és nincs mit létrehozni. A seed-sablonok is frissültek (a
migráció a MAI flottát javítja, a seed dönt arról, mivel indul a HOLNAP létrehozott ügynök; az egyik
a másik nélkül épp ez a drift).

**Amit tudatosan NEM tettem meg: a dashboard nem ír szintetikus task-state rekordot.** A kártya 1.
pontja „rövid strukturális állapot-mentést" kért a váltás előtt. A lépcsőzés tipikusan akkor fut,
amikor az ügynök limit miatt SZÜNETEL, tehát nem lehet megkérdezni; a dashboard viszont a rekordot
kitöltve azt ÁLLÍTANÁ az injektált szövegben, hogy „folyamatban lévő feladat közben indultál újra" --
egy állítást, amit nem tud alátámasztani, pont abban a pillanatban, amikor az ügynöknek nincs
kontextusa ellenőrizni. A hiányzó láncszem amúgy sem a mentés volt, hanem a VISSZAJÁTSZÁS (2. pont);
ami hitelesen ismert (nyitott `in_progress` kártya, a váltás oka), az a táblán van, és a flotta a
11./14. szabály szerint amúgy is onnan veszi fel a fonalat.

**Mérés.** Hat mutáció, mind pontosan azt pirosítja, aminek kell: a hívási hely vissza `fresh: false`-ra
-> 1 teszt; a `restartFor` eldobja a flaget -> 1; `clear` ki a `REPLAY_SOURCES`-ból -> 4; a matcher-konstans
vissza `compact|resume`-ra -> 19; a migráció no-op -> 2; a migráció LÉTREHOZ egy hiányzó bejegyzést
(widen-only megsértése) -> 2; egy seed-sablon visszaállítása az elavult matcherre -> 1. Teljes suite:
11 751 zöld. A wiring egyik felét (a hívási hely `{ fresh: steppingDown }`-t ad át) forrás-szintű
állítás fedi, a `main-restart-platform.test.ts` bevált idiómája szerint, és a teszt maga KIMONDJA a
korlátját: a literált szegezi ki, nem a jelentését.

**Ki döntött:** Peti (jóváhagyás, a Fron Ted-eset alapján), MikroB (kártya), backend2 (a három rész
szétválasztása, a négy fenti döntés, implementáció, mérések).
**Hivatkozás:** kártya 1ce3fd90. Előzmény: `91c4a369` (elavult matcher = bekötöttnek látszik, nem fut).

## 2026-08-23 19:34 -- A [50%] NEM az offload-scriptbol jott, es a cim-iras nem auditalt (kártya 8b925388)

**A lelet strukturalis fele nem all, es ezt megmertem, mielott barmit javitottam volna.** A kartya
szerint a draft-generalas "csendben atirja a kartya cim/szazalek mezojet". A teljes offload-ut
HAROM HTTP-hivast tesz, es pontosan EGY ir: `POST /api/kanban/<id>/comments`. Nincs `PUT`, nincs
`/move`, es nincs `title` mezo sehol -- sem az `offload-dispatch.sh`-ban, sem az
`offload-batch-run.sh`-ban. A `8d673233`-ra kerult `[50%]` tehat MASHONNAN jott.

**Ha "megjavitottam" volna a scriptet, egy no-op-ot szallitok, mikozben az igazi iro tovabb csinalja.**
Ez ugyanaz a hibaosztaly, amit ma tobbszor is jeleztem masnal: a javitas oda kerul, ahol a hiba
LATSZOTT, nem oda, ahol van.

**AMIERT MEGSEM ATTRIBUALHATO: a cim-iras NEM HAGY AUDIT-SORT.** Az `updateKanbanCard` csak akkor ir
a `kanban_card_events`-be, ha a STATUSZ valtozott (`if (changed && statusChanges)`). Egy cim-only
modositas tehat nyomtalan -- se aktor, se idobelyeg. Ezert nem lehet ma megmondani, ki tette a
`[50%]`-ot. Ez a valodi strukturalis res ebben az esetben, es nagyobb, mint amit a kartya leir:
a cim hordozza a HALADAS-jelzot (`[NN%]`, 2. munkavegzesi szabaly), vagyis egy auditalatlan mezo
hordoz egy allapot-jelentesu adatot.

**Amit szallitottam:** a kartya CELJAT (a draft ne nyuljon a tablahoz) SZERKEZETIVE tettem. Ma a
scriptek konstrukcio szerint teljesitik; egy teszt most kiszegezi, hogy az offload-uton az EGYETLEN
mutalo hivas a komment-POST. Egy draft JAVASLAT -- egy javaslat, ami szerkeszti a tablat, mar nem
javaslat.

**Merve:** a kartya altal leirt PONTOS alakot (egy `PUT` a `title`-lel) beleirva a scriptbe, PONTOSAN
ket teszt pirosodik. Anti-vakuitas kulon eset: a fajl egesze grep a script-szovegen, tehat ha egy
atnevezes miatt a `curlCalls()` uresset adna, minden "nincs ilyen hivas" allitas zolden futna
semmit nem merve -- ezert a legelso teszt a TALALATOKAT szegezi ki.

**NYITVA, es MikroB donteset keri:** a cim-iras auditalasa (vagy a `[NN%]` kivetele a cimbol egy
sajat, auditalt mezobe) kulon kartyat er. Nem nyitottam meg, mert a dedup-szabaly szerint elobb
tisztazni kell, hogy a 8b925388 hatokorebe tartozik-e vagy uj.

**Ki dontott:** backend (a meres es a szerkezeti kiszegezes), backend2 (az eredeti lelet).
**Hivatkozas:** kartya 8b925388, incidens-kartya 8d673233 (komment 14896).

## 2026-08-23 19:43 -- A nem-statusz kartya-szerkesztes is auditalt, KULON tablaban (kártya 51878c59)

**A res:** az `updateKanbanCard` CSAK statuszvaltaskor irt a `kanban_card_events`-be, tehat minden
mas mezo-modositas nyomtalan volt -- se aktor, se idobelyeg. Ez nem kozmetikai hiany: a flotta a
HALADAS-jelzot a kartya CIMEBEN tartja (`[NN%]`, 2. munkavegzesi szabaly), vagyis pont az a mezo
volt auditalatlan, ami azt mondja meg, hol tart egy munka. A `8d673233`-on ez elsult: megjelent egy
`[50%]`, a tabla haladast mutatott, amit senki nem csinalt, es utolag SENKI nem tudta megmondani ki
irta (az `offload-dispatch.sh`-t fuggetlenul kizartuk, 8b925388).

**(a) auditalas, NEM (b) a `[NN%]` kiemelese a cimbol.** A kartya mindket iranyt felkinalta. A (b)
egy flotta-szintu, kimondott konvenciot irna at (2. szabaly: "a haladas a kartya CIMEBE tett `[NN%]`
marker"), plusz minden cimet parse-olo kodot es minden ugynok szokasat -- ez a 5. kodminosegi
szabaly teruletet (mukodo dolgot nem irunk at kerdes nelkul). Az (a) additiv, konvenciot nem valt,
es pontosan a hianyzo kerdesre valaszol: KI es MIKOR.

**KULON TABLA, nem tobb sor a `kanban_card_events`-ben -- ez a valodi dontes.** Megmertem a
fogyasztokat: a `to_status` NOT NULL, a `GET /api/kanban/:id/events` tranzakcio-listakent adja ki
oket, es a `fleet-transfer` a `(card_id, created_at, to_status)` harmason dedupal. Egy valtozatlan
statuszt hordozo sor MINDHAROM olvaso szamara megkulonboztethetetlen lenne egy valodi mozgatastol.
Egy tabla ara: nulla torott olvaso.

**A `sort_order` SZANDEKOSAN nincs auditalva.** Egy oszlopon beluli huzas MINDEN elmozdult kartyara
ujrairja, tehat az auditalasa pont azokat a szerkeszteseket temetne be atrendezesi zajba, amiket
valaki keresni akar. A kerdes, amire ez a tabla valaszol: "ki valtoztatta meg, amit a kartya MOND".

**Aktor nelkuli szerkeztes is sort kap, `actor = NULL`-lal.** Az `actor` onbevallas es opcionalis;
a sor eldobasa visszaallitana pontosan azt a lyukat, amirol ez a kartya szol -- egy szerkesztes,
ami megtortent es nem hagyott nyomot. A nevtelen nyom tobb, mint a semmi.

**Fogyaszto:** `GET /api/kanban/:id/field-events`. KULON utvonal, ugyanabbol az okbol, amiert kulon
tabla. Kimondom, hogy a FE ma EGYIKET SEM rendereli (a `/events` sem volt bekotve, ez nem az en
valtoztatasom kovetkezmenye): a fogyaszto itt az a vizsgalodo -- ember vagy ugynok --, aki utolag
felteszi a kerdest, amit a `8d673233`-on senki nem tudott megvalaszolni. Egy lekerdezheto sor
onmagaban valasz; ez nem ugyanaz, mint egy detektor, aminek a kimenetet semmi nem olvassa.

**Merve:** az audit-iras eltavolitasa (a kartya elotti allapot) -> 4 piros; a `sort_order`
felvetele az auditalt mezok koze -> 1 piros (pont az a teszt, ami a szandekos kihagyast szegezi ki).
8 uj teszt; a szomszedos suite-ok (fuggosegek, delete-FK) valtozatlanul zoldek, 46/46.

**Ki dontott:** backend (implementacio + a kulon-tabla es a `sort_order`-kihagyas dontese).
**Hivatkozas:** kartya 51878c59, forras-lelet 8b925388 (komment 19660), incidens 8d673233.
## 2026-08-23 19:55 -- A heredoc-tulajdonos járó a bash IDÉZÉSÉT követi, nem a zárójeleket számolja (kártya 84e31b40, Cybered NO-GO F-5)

**Döntés:** a `stripHeredocDataPayloads` járója idézés-állapotot tart (`'...'`, `"..."`, `$'...'`,
backslash-escape), a `$(( ))` aritmetikát egyben átugorja, és minden beágyazott kontextus-keret a
határ MELLETT az idézés-állapotot is elmenti és visszaállítja. A puszta zárójel-számláló verem
kikerült.

**Miért:** a verem, ami az F-1-et és az F-2-t lezárta, zárójelet számolt. A bash nem ezt teszi: egy
idézett `)` LITERÁL, és a `$(( ))` záró `))`-je semmilyen parancs-kontextust nem zár. Ahol a kettő
eltér, a verem olyan keretet popol, amit a bash sosem nyitott -- a határ visszaesik a KÜLSŐ curl-re,
miközben a heredoc még mindig a BELSŐ értelmezőé, és a törzs kiürül, mielőtt a szken látná.

**Miért nem egzotikus:** egy idézett zárójel nem kicsavart alak. Egy regex, egy magyar mondat, egy
`print('a)b')` mind tartalmaz egyet -- és a fenyegetés-modellben a parancsot a TÁMADÓ választja, tehát
elég, hogy LÉTEZIK egy átmenő alak.

**Mérés, 30 eset, mindkét kapun, minden alak amit a négy kör megnevezett + három saját:**

| változat | rossz eset |
|---|---|
| szállított kód (e5b2cd84, verem zárójel-számlálással) | 5 |
| idézés-tudatos járó (ez ment be) | 0 |

Az öt rossz eset az e5b2cd84-en: idézőjeles `)` a belső argv-ben (N1, Cybered lelete), aritmetika a
belső argv-ben (N2, Cybered lelete), egyszeres-idézőjeles `)` (N2b), helyettesítés `"..."`-en BELÜL
nyitva idézett `)`-vel (N5), és backslash-escapelt `)` (N6). Az utolsó kettőt a mutáció-mérés hozta
elő, nem gate-lelet volt -- lásd lent.

**A mutáció-mérés HOZOTT KI két további alakot, nem csak igazolt.** Négy mutációt futtattam:

| mutáció | piros teszt (a javítás előtti állapotban) |
|---|---|
| A: a záró `)` idézéstől függetlenül popol | 0 -> ez volt a jelzés |
| B: a járó feje visszaállítva e5b2cd84-re | 9 |
| C: az aritmetika-átugrás eltávolítva | 4 |
| D: a backslash-escape eltávolítva | 0 -> ez volt a jelzés |

Az A és a D mutáció TÚLÉLTE a teljes tesztkészletet. Ez nem azt jelentette, hogy az a két ág
felesleges, hanem hogy nem volt rá esetem. Mindkettőhöz kerestem alakot, és mindkettő ÉLŐ megkerülés
lett: az A-hoz az N5 (a keret `"` alatt nyílik, tehát a téves pop `"`-t állít vissza, az argumentum
valódi záró idézőjele ezután NYITÓNAK olvasódik, és a heredoc idézetlenül, a külső curl határával
landol), a D-hez az N6 (`a\)` a bashnek literál `a)`). Mindkettőt marker-fájllal futtattam le VALÓDI
bashben, és mindkettő ALLOW az e5b2cd84-en. Miután bekerültek tesztként, az A mutáció 2, a D mutáció
2 pirosat ad.

**Az átvihető tanulság:** egy mutáció, ami TÚLÉL, nem a mutáció hibája. Vagy felesleges kód, vagy
hiányzó teszt -- és ebben a két esetben a hiányzó teszt mögött egy-egy még nem ismert támadási alak
állt. A mutáció-mérés itt nem az utolsó lépés volt (a teszt jóságának igazolása), hanem egy
KERESŐESZKÖZ, ami két olyan alakot talált, amit négy kör alatt három gate nem.

**Cybered nem-blokkoló NOTE-ja szállítva:** mindkét suite kapott egy GENERÁLT invariáns-tesztet
(beágyazási forma x zavaró token kereszt-szorzat, 21 eset), ami nem alakot rögzít, hanem az elvet:
egy heredoc törzse CSAK akkor ürülhet ki, ha a BIRTOKLÓ egyszerű parancs vezető binárisa curl/git.
A következő alakot így nem kell kitalálni ahhoz, hogy megbukjon.

**Ki döntött:** Cybered (a lelet, az élő mérés, és az invariáns-teszt ötlete), fullstack (az
idézés-tudatos járó, a négy mutáció, és a belőlük előjött N5/N6 alak).
**Hivatkozás:** kártya 84e31b40, commit ce40ccf0. Előzmény: e5b2cd84 (a vermes visszaállítás),
c17173fc (a nyitó-csak javítás), f4fac1d7 (a járó bekötése az email-kapuba).

## 2026-08-23 19:57 -- Egy DEKLARALT, de elerhetetlen audit-mezo rosszabb, mint egy nyilt hiany (kártya 7fd6dd23)

**F-1 (a lenyeg).** Az `archived_at` BENNE volt az auditalt mezok listajaban, es SOHA nem sulhetett
el: az `archiveKanbanCard` es az `unarchiveKanbanCard` a SAJAT `UPDATE`-jevel irja az oszlopot, tehat
semmi nem jut el az `updateKanbanCard` osszehasonlito ciklusaig. Cybersec merte: archivalas utan
NULLA sor mindket tablaban.

Ez rosszabb, mint egy nyilt hiany. Egy hianyt eszrevesz, aki keresi; egy DEKLARALT mezo azt allitja,
hogy le van fedve, es a kereso ember ABBAHAGYJA a keresest. Ugyanaz az alak, mint a "bekotott
detektor fogyaszto nelkul", csak forditva: itt a fogyaszto megvan, a FORRAS hianyzik.

**A javitas iranya: NEM a lista szukitese.** Cybersec mindket utat felkinalta (vagy az archivalas
keruljon at az auditalt utra, vagy vegyuk ki a mezot a listabol). A kivetel megszuntetne a hamis
allitast, de otthagyna az archivalast attribualatlanul -- pedig az archivalas VALODI allapot-valtas
(leveszi a kartyat a tablarol). Ezert a ket fuggveny sajat sort ir, es kap egy opcionalis `actor`-t,
amit a route atad. Additiv, szignaturat nem tor.

**F-2.** A `fleet-transfer` nem ismerte az uj tablat: transfer/restore utan a statusz-tortenet
megmaradt volna, a mezo-audit CSENDBEN eltunik -- a visszaallitott tabla teljesen attribualtnak
LATSZANA, mikozben minden transzfer elotti szerkesztes elveszett. Export + idempotens import
`(card_id, created_at, field)`-re. A payload-kulcs OPCIONALIS: egy korabban keszult export kulcs
nelkul is importalhato marad, kulonben ez a valtoztatas nem bovitene, hanem TORNE minden meglevo
mentest.

**F-3: KORLAT, NEM HASH.** Az `old_value`/`new_value` a cim es a leiras TELJES korabbi szoveget
tarolta, korlat es TTL nelkul, es a vegpont ki is adja. Ket kovetkezmeny: korlatlan novekedes, es
egy leirasbol TOROLT szoveg tovabb el az auditban, amig ket helyen nem torlik. 500 karakteres korlat,
lathato levagas-jelolessel. Hash helyett azert, mert a hash korlatozza a novekedest ES elpusztitja
az egyetlen dolgot, amiert a sor letezik: hogy megmondja, MIT mondott korabban. A ket-helyen-torles
tenye IGAZ marad, es le van irva, nem elmagyarazva -- barmilyen tortenet-megorzes velejaroja.

**Merve:** az archivalasi audit-sor eltavolitasa (a javitas elotti allapot) -> 2 piros; a korlat
eltavolitasa -> 1 piros. KONTROLL az F-1-re: egy ELUTASITOTT archivalas NEM ir sort (kulonben a
trail kisérleteket rogzitene ugy, mintha megtortentek volna), es egy PONT a hatarnal levo ertek
CSONKITATLANUL tarolodik (kulonben a korlat azt is levagna, ami belefer).

**Amit kimondok az F-2-rol:** a hozza tartozo teszt a FORRAS ALAKJAT meri, nem egy vegponttol
vegpontig futo transzfert -- az `importFleet` elo DB-t es fajlrendszert igenyel, ezert a meglevo
suite is mockolt modulokkal hajtja. Ezt jelzem, nem hallgatom el.

**Ki dontott:** backend (implementacio + az F-1 iranyanak valasztasa), Cybersec (harom lelet).
**Hivatkozas:** kartya 7fd6dd23, szulo-lelet 51878c59.
## 2026-08-23 20:05 -- A biztonsagos-fogyaszto lista szukosseget a FUGGVENYEN kell kiszegezni, nem gate-enkent (kártya 0ecff3ae)

**Döntés:** a `stripHeredocDataPayloads` biztonságos-fogyasztó listájának szűkösségét egy önálló
teszt-fájl (`src/__tests__/stdin-consumer-list-narrowness.test.ts`) rögzíti, ami KÖZVETLENÜL a
megosztott függvényre állít (kiürül-e a heredoc törzse), nem egy kapu verdiktjére. Az email-kapun
külön, gate-szintű esetek is vannak (a valódi küldés `--config`/`-K` konfig-törzsben írva).

**Miért nem gate-enként:** a kártya azt kérte, hogy a self-pace kapun is legyen erre eset. Lemértem:
a self-pace kapu egy curl KONFIG-törzset MA SEM jelöl meg (a mintái argv-beli invokációt vagy
HTTP-írást keresnek, egy `url = ...` sor egyik sem) -- tehát egy „a self-pace kapu továbbra is tilt"
teszt zölden futna a lista módosításával ÉS anélkül is. Az VAKUUM teszt lenne, pont abból az
osztályból, amit a flotta többször megmért már. A megosztott függvényre állítva viszont nem lehet
vákuum, és MINDEN kaput fed, ami a járót importálja -- nem csak azt, amelyiknek a suite-jában
véletlenül ott van az eset.

**A kártya premisszájának egy pontja nem áll:** a leírás szerint a járó „importálva
outgoing-copy-gate.py-ba is". Nincs így: a `scripts/hooks/outgoing-copy-gate.py` önálló Python hook,
saját logikával, nem hívja a `stripHeredocDataPayloads`-ot (`grep` a fájlon: nulla találat). A lista
két fogyasztója az `email-send-gate.mjs` és maga a `self-pace-gate.mjs`.

**Mérés (a kártya által kért mutáció + két anti-vakuitás mutáció), a kapu-suite-okon:**

| mutáció | piros a kártya ELŐTT | piros MOST |
|---|---|---|
| M1: `--config`/`-K` naiv felvétele a listára | 1 | 7 |
| M2: a kiürítés feltétel nélküli | -- | 6 (az új fájlban) |
| M3: a kiürítés soha nem fut | -- | 3 (az új fájlban) |

Az M3 az anti-vakuitás iránya: ha a járó semmit nem ürítene ki, a „nem ürül ki" állítások zölden
mérnének semmit -- ezért három eset kifejezetten azt szegezi ki, hogy a függvény VALÓBAN üríti a
jogos adat-alakokat (`-d @-`, `git commit -F -`), hosszhelyesen.

**Ki döntött:** Cybersec (a lelet és az élő támadás a 84e31b40 GO-verdiktjében), fullstack (a
függvény-szintű kiszegezés a gate-szintű helyett, és a premissza helyesbítése).
**Hivatkozás:** kártya 0ecff3ae, commit e48bff92. Előzmény: 84e31b40 (a járó és a lista mai alakja).

## 2026-08-23 20:12 -- Ket kerdes, ket szamlalo: a backoff nem ugyanazt meri, mint a feladas-budget (kártya b2f13520)

**A helyzet, amit a `df193354` HELYESEN allitott be, es amit nem szabad visszacsinalni:** az
`attempts` azt jelenti, hogy "hany nudge-ot kapott MEG es hagyott figyelmen kivul az ugynok", ezert
csak `outcome === 'sent'` noveli. E nelkul egy foglalt/zarolt pane elhasznalta egy VARAKOZO ugynok
feladas-budgetjet olyan nudge-okkal, amik el sem jutottak a pane-ig.

**A kovetkezmeny, amit QA megtalalt:** ugyanez az `attempts` volt a backoff bemenete is. Egy
TARTOSAN zarolt pane-nel tehat orokre 0 marad, es a `wakeBackoffMs(0, 60mp, 30perc)` orokre a 60
masodperces PADLOT adja -- a 30 perces plafonig valo eszkalacio elerhetetlenne valt.

**Miert nem eleg egy sor dokumentacio (a kartya masik felkinalt opcioja):** a backoff-kapu a tmux-
probak ELOTT fut, es az `isSessionReadyForPrompt` egy blokkolo alvasba plusz ket `capture-pane`-be
kerul -- ezt a fajl sajat kommentje mondja ki, ezert futnak az olcso kapuk elobb. Rogzitett 60
masodperces padlonal egy zarolt pane ezt PERCENKENT fizetteti ki, ugynokonkent, hataridotlenul. A
gap novekedese pontosan ez ellen a koltseg ellen volt; a `df193354` javitas csendben kikapcsolta.
Egy dokumentacios sor leirna a viselkedest, de nem allitana vissza a vedelmet.

**A megoldas: KET SZAMLALO, mert ket kulonbozo kerdes van.**
- `attempts` -- "hany nudge ERKEZETT MEG es maradt valasz nelkul": a feladas-budget. Valtozatlan.
- `undelivered` -- "hany nudge NEM jutott el a pane-ig egymas utan": a backoff bemenete. Uj.

Egy zarolt pane-re a ket valasz kulonbozo: semmi nem erkezett meg, DE tortent probalkozas. Egy
szamlalo nem tud mindkettore valaszolni, es a `df193354` epp azert szukitette az egyiket, hogy a
masikat ne rontsa el.

A `shouldWakeForTelegramInbox` uj `backoffAttempts` parametere OPCIONALIS, es alapertelmezesben az
`attempts`-re esik vissza -- minden meglevo hivo es teszt viselkedese valtozatlan; csak az elo sopres
ad at mindkettot. Egy uj kotelezo parameter itt a hivok atirasat jelentette volna, semmi haszonert.

**Friss bejovonel MINDKET szamlalo nullazodik:** egy uj uzenet azonnali probat erdemel, nem azt a
hosszu gapet, amire az elozo beragadt backlog felnott.

**Merve:** a backoff visszakotese az `attempts`-re (a javitas elotti allapot) -> a "THE DEFECT"
teszt piros; a budget atkotese az `undelivered`-re (ami visszacsinalna a `df193354`-et) -> a
budget-teszt piros. Plusz kontroll arra, hogy a `backoffAttempts` elhagyasa BETURE ugyanazt adja,
mint a regi egy-szamlalos alak, es hogy a plafon tovabbra is plafon.

**A LOKALIS DRAFTBOL SEMMIT NEM HASZNALTAM, es leirom miert:** egy nem letezo `PanelManager`
osztalyt talalt ki, a leletet forditva ertette ("60 perc 30 helyett" -- valojaban 60 MASODPERC a 30
PERC helyett), kitalalt egy 24 oras plafont, es a javasolt dokumentacioja az ELLENKEZOJET allitja
annak, amit el akarunk erni. Nulla sor volt belole hasznalhato.

**Ki dontott:** backend (implementacio + a ket-szamlalos irany a dokumentacios opcio helyett),
QA (a lelet, a `df193354` kapu soran).
**Hivatkozas:** kartya b2f13520, forras-kartya df193354.
## 2026-08-23 20:30 -- A járó bash-NYELVTANT is követ: csupasz `(` keretet nyit, `${ }` egyben átugorva (kártya 84e31b40, Cybersec F-6 + Cybered F-7)

**Döntés:** a `stripHeredocDataPayloads` járójában (a) egy CSUPASZ `(` ugyanúgy keretet nyit, mint a
`$(`/`<(`/`>(`/backtick, és (b) a `${ ... }` parameter expansion egyben átugorva, mélység-kezelten
(beágyazott `${...}` és `$(...)` is), a `$(( ))` aritmetika mintájára.

**Miért:** a negyedik kör IDÉZÉS-tudatot adott a járónak, ez a kettő ugyanezt mondja a NYELVTANRÓL.
Mindkettő ugyanazt a keret-számolási hibát használja ki, csak más konstrukción:

- **F-6 (Cybersec):** a bash egy csupasz `(`-nél is új parancs-kontextust nyit (subshell), a járó
  viszont keretet nem nyitott rá, a `)`-jére viszont popolt -- vagyis egy subshell ELHASZNÁLT egy
  keretet, amit sosem nyitott, és a határ visszaesett a külső curl-re.
- **F-7 (Cybered):** egy `${ ... }` default/replace része idézetlenül tartalmazhat `)`-t
  (`${x:-)}`, `${x/a/)}`), amit a járó nyers zárónak olvasott -- ugyanaz az eredmény.

Mindkettőt marker-fájllal, valódi bashben futtatva jelentették; a beágyazott értelmező tényleg
lefuttatta a "kiürített" törzset.

**Miért nem elég egy `${x:-)}` egysoros patch (Cybered kifejezett kérése, mérve):** a `${x:-$(true))}`
alakban egy VALÓDI belső helyettesítés van a brace-en belül -- azt továbbra is egységként kell
kezelni, miközben a brace SAJÁT `)`-je nem popolhat. Ezért a brace-átugrás mélység-kezelt.

**Miért nem drága a csupasz `(` keret:** idézetlen `(` a bashben nem lehet közönséges argumentum-szöveg
(szintaktikai hiba), tehát minden valós előfordulása (subshell, tömb-hozzárendelés, függvény-fej)
KIEGYENSÚLYOZOTT -- egy kiegyensúlyozott keret pontosan azt a határt állítja vissza, amit elmentett.
Ezt kontrollok mérik, nem érvelés. Sőt: a mutáció-mérés szerint a csupasz-`(` keret egy FALS-POZITÍVOT
is megszüntet (egy subshellbe csomagolt jogos hívás korábban DENY volt).

**Mérés, 41 eset, mindkét kapun:**

| változat | rossz eset |
|---|---|
| előző kör (f7c1d07f) | 6 (R1, R2, B1, B2, B3, B4) |
| ez a változat | 0 |

**Mutáció-mérés, és megint két ÚJ alakot hozott ki:**

| mutáció | piros |
|---|---|
| MA: a csupasz `(` nem nyit keretet | 7 |
| MB: a `${ }`-átugrás eltávolítva | 10 |
| MC: a brace/beágyazott-`$( )` mélység-kezelés eltávolítva | 0 -> ez volt a jelzés, majd 6 |
| MD: a `skipBalancedParens` nem kezel egyszeres idézőjelet | 0, és NEM találtam hozzá alakot |

Az MC túlélte a teljes készletet, ezért alakot kerestem hozzá, és kettőt találtam, mindkettő ÉLŐ
(marker-fájllal, valódi bashben lefuttatva): **B5** `${x:-${y:-a})}` -- a `)` a BELSŐ brace zárása
UTÁN áll, tehát egy mélység-vak szken már nem ugorja át (az f7c1d07f-en is ALLOW volt, vagyis ez egy
hetedik alak, amit egyik gate sem nevezett meg); **B6** `${x:-$(echo a})}` -- egy `}` a brace-en belüli
helyettesítésben, ami egy mélység-vak szkent korán zárna. Mindkettő tesztben kiszegezve, utána az MC
6 pirosat ad.

**Az MD-t KIMONDOTTAN nyitva hagyom:** a `skipBalancedParens` egyszeres-idézőjel-kezelése nélkül a
teljes készlet zöld marad, és a két alak, amit kifejezetten ellene konstruáltam
(`${x:-$(echo 'a)}' )}`, `${x:-$(echo 'a)' )}`), MINDHÁROM változaton DENY. Nincs tehát bizonyítékom,
hogy ez az ág teherhordó. Bent hagytam, mert a helper így egyezik a bash-sel (ugyanaz az elv, amit a
negyedik kör lefektetett), de NEM írtam rá tesztet, amiről nem tudom megmutatni, hogy mér valamit --
ez ugyanaz a vákuum-teszt-tilalom, amit a 0ecff3ae-n alkalmaztam. Ha egy gate talál rá alakot, jöhet
a teszt.

**Cybered kérése teljesítve:** a generált invariáns-teszt zavaró-token-halmaza bővült a `$( (:) )`
subshell-lel és mind az öt brace-alakkal.

**Ki döntött:** Cybersec (F-6 lelet + a csupasz-`(` token javaslata, saját méréssel), Cybered (F-7
lelet + a mélység-kezelt brace-átugrás iránya), fullstack (a két javítás összevezetése, négy mutáció,
és a belőlük előjött B5/B6 alak).
**Hivatkozás:** kártya 84e31b40, commit 851a4618. Előzmény: f7c1d07f (idézés-tudat), e5b2cd84 (vermes
határ-visszaállítás), c17173fc, f4fac1d7.

## 2026-08-23 -- noisy-command-guard: a mentesség szegmensenkénti, nem soronkénti (kártya 034594e6)

Az előző kör (10a6c51f, kártya aa837c5b-hez kapcsolódóan) bevezette a `scripts/hooks/noisy-command-guard.py`
hookot, ami install/build/teszt parancsokat a `scripts/noisy-run.sh` szűrőn keresztül terel. Két hiba
derült ki, mindkettőt Cybersec találta ELLENŐRZÉS közben, nem eleve gyanús kódrészletként:

1. A hook saját kiírt javaslata összetett parancsnál (`cd /x && npx vitest run ...`) csak az ELSŐ
   részparancsot adta át a wrappernek -- a `&&` utáni rész, pont a zajos rész, a KÜLSŐ shellben futott
   szűretlenül.
2. A mentességi ellenőrzés (`if "noisy-run.sh" in raw`) a TELJES sor részstring-egyezése volt: bármi,
   ami CSAK EMLÍTI a fájlnevet (egy echo, egy grep-argumentum, egy idézőjeles mondat, vagy épp a hook
   saját javaslata), leszerelte a guardot a sor ÖSSZES többi parancsára. Élő repró: egy
   `echo "... noisy-run.sh ..." && npx vitest run ...` sor átment, a vitest nyersen futott.

Fix: szegmens-granularitású mentesség -- a sort egyszerű parancsokra bontja (`;` `&&` `||` `|` újsor,
és a `$(` / backtick / `<(` nyitása, mert azok tartalmát a KÜLSŐ shell expandálja, tehát egy korábbi
wrapper nem fedi őket), és csak azt a szegmenst hagyja ki, amelyik TÉNYLEG a wrapperrel kezdődik.
Összetett parancsnál a javaslat `bash noisy-run.sh bash -c '<eredeti>'` alakban, egyetlen argumentumként
utazik. Ellenőrizve: eredeti 24/24 selftest zöld, plusz Cybersec két adverzariális batteryje (11/11
megkerülés+jogos-alak, 11/11 a saját fix ellen) zöld, plusz QA független 9-esetes batteryje (javítás
előtti kódon 5/5 a várt bypass tényleg átment, javított kódon 9/9 a szándék szerint).

**Strukturális megjegyzés a gate-folyamatról:** ez a kártya nem tudott a szokásos úton REVIEW-t kapni --
a patchet Cybersec írta (gate-ügynök, sose lehet submitter), MikroB landolta (sose lehet submitter),
tehát a `gate-dispatch-check.sh` NON_SUBMITTERS-szűrője mindkét szerzőt kizárta. QA és Cybered a
kártya kommentjeiből (Cybersec saját SKIP-je a három kimondott korláttal + MikroB megjegyzése) dolgozott
gate-bemenetként. Külön kártya nyílt (ec0e64b4) egy `Submitted-by:` sor bevezetésére erre az esetre.

**Ki döntött:** Cybersec (lelet + patch, saját magát nem gate-elte), MikroB (landolás + élesítés,
mert a szerző-kizárás miatt más nem tehette meg), QA (független 9-esetes battery, PASS).
**Hivatkozás:** kártya 034594e6, commit 82068a3f. Előzmény: 10a6c51f (a hook első verziója), 73fff79b
(a korábbi útvonal-hiba javítása ugyanezen a hookon).

## 2026-08-23 20:35 -- Az ismételt archiválás idempotens 200, nem 404 (kártya 394fb5ce)

**Döntés:** A `POST /api/kanban/<id>/archive` mostantól `AND archived_at IS NULL` mellett ír, tehát
egy már archivált kártyát NEM ír felül; a válasz ilyenkor `200 { ok: true, alreadyArchived: true }`,
és a `revertIdeaFromKanban` nem fut újra. A db-réteg új `already-archived` okot ad vissza, ami nem
keveredik a `not-found`-dal.
**Miért:** a guard nélkül a második archiválás felülírta az EREDETI archiválási időbélyeget -- azt az
egy tényt, amiért az oszlop létezik --, és egy második audit-sort írt `null -> T` alakban, vagyis
azt állította, hogy a kártya előtte nem volt archiválva. A `not-found` válasz viszont egy létező
kártyáról hazudna, és pont azt a téves diagnózis-kört indítaná el, amiről az ebf7d95c kártya szól.
**Ki döntött:** Backend (implementáció), Cybersec L-1 lelete alapján (7fd6dd23 gate).
**Hivatkozás:** kártya 394fb5ce.

## 2026-08-23 20:35 -- A fleet-transfer esemény-import kulcsa a TELJES sor, multiplicitással (kártya 394fb5ce)

**Döntés:** A kanban státusz- és mező-esemény import nem létezés-ellenőrzéssel dedupál, hanem a teljes
sorra képzett kulccsal és darabszám-egyeztetéssel (`src/web/fleet-transfer-dedup.ts`).
**Miért:** a régi kulcs (`card_id, created_at, field`, illetve `to_status`) nem egyedi a FORRÁS
táblában sem: két azonos másodpercbe eső szerkesztés két valódi sor, amiből a második csendben
kimaradt. A szélesebb kulcs önmagában nem elég -- egy létezés-ellenőrzés soha nem visz át második
példányt --, ezért kell a darabszám-egyeztetés is; és a darabszám önmagában sem elég, mert egy
azonos szűk kulcsú, de MÁS esemény elhasználja a párosítást. Mindkét felét külön mutáció méri.
**Ki döntött:** Backend (implementáció), Cybersec L-3 lelete alapján (7fd6dd23 gate).
**Hivatkozás:** kártya 394fb5ce.

## 2026-08-23 -- 95f861f1 -- A repomix használati pontja a teljes értékű audit, és a pack manifesztje ELLENŐRIZ

**A hiba, amit javít.** A repomix 2026-07-31-én adoptálva, gate-elt wrapperrel (`store/repomix.sh`,
Cybersec feltételekkel), dokumentálva -- és a kimeneti könyvtár azóta nem mozdult: egyetlen 3,7 KB-os
smoke pack, semmi más. Ez ugyanaz az osztály, mint a fogyasztó nélküli detektálás: a táblán
képességnek látszik, a valóságban nem az. Ez a kártya a szülő-epic (`3c9e22b1`, „már adoptált, de
használatlan eszközök valós bekötése", Peti kérése) egyik ága.

**1. döntés: a bekötés célpontja a `full-value-audit` skill, két KÜLÖNBÖZŐ ponton.** A 0. lépés
becsomagolja a fát (a token-riport megmondja, hol van a kódbázis tömege, tehát hova menjen az audit
ideje), a Verification lépés pedig FELHASZNÁLJA a pack fájl-manifesztjét. A kettő közül a második a
lényeg: egy pack legenerálása önmagában pont az a fajta „bekötés", ami után a kimenetet megint senki
nem olvassa el.

**2. döntés: a fogyasztó egy MÁR MEGLÉVŐ, de kikényszeríthetetlen szabály.** Mindkét audit-skill
kimondja, hogy „Nothing is implicit... No silent gaps: if you did not test something, list it
explicitly as NOT tested / why". Ez ma becsületalapú próza. A pack viszont MECHANIKUS, teljes
manifeszt a fa minden forrásfájljáról -- a kettő együtt ellenőrizhetővé teszi a szabályt:
`store/audit-pack-coverage.py` megnézi, hogy az audit-riport MINDEN becsomagolt fájlt megemlít-e, és
exit 1-gyel felsorolja, amelyiket nem. Nem új szabályt vezet be, hanem egy meglévőt tesz mérhetővé.

**3. döntés: kimondott KORLÁT a doksiban, a szkript fejlécében és a skillben is.** Azt bizonyítja,
hogy egyetlen FÁJL sem maradt említetlen. Azt NEM, hogy a leltár a fájlon BELÜL teljes: egy riport
megnevezheti a `PublicScanPage.tsx`-et és kihagyhat belőle három gombot. Ez a mechanikus padló a
szabály alatt, nem a szabály maga. Azért kerül ki háromszor is, mert egy tévesen lezártnak hitt
kontroll rosszabb, mint egy ismert réssel bíró -- ugyanaz az indoklás, amit a `repomix.sh` a saját
titok-szkennelésére ír le.

**4. döntés: nem-egyedi basename csak TELJES úttal számít lefedettnek.** Az `index.ts` a fa
tucatnyi pontján létezik; ha a puszta basename számítana, EGY megauditált `index.ts` tizenegy másikat
jelölne lefedettnek. Egy túl-jelentő lefedettség-ellenőrzés rosszabb, mint a semmi, mert a kimenetét
bizonyítékként olvassák.

**5. döntés: üres manifeszt exit 2, nem 0.** Rossz pack-útvonal, egy jövőbeli repomix átnevezett
attribútuma vagy egy teljesen gitignorált alfa mind ide fut ki, és mindegyik „0 rés" választ adna --
tiszta bizonyítvány semmiből. A setup-hibák szintén 2-vel térnek vissza, sosem 1-gyel: az 1 azt
jelenti, hogy az ellenőrzés LEFUTOTT és réseket talált, és egy CI-hívó, ami a kettőt nem tudja
megkülönböztetni, minden pirosat rés-listaként olvas.

**Amit a SAJÁT selftestem talált, és amit szállítottam volna nélküle.** Az illesztés eredetileg
`path in inventory` volt, nyers substring. A selftest `xmoney.ts does not cover money.ts` esete
piros lett: egy riport, ami CSAK az `xmoney.ts`-t említi, lefedettnek jelölte volna a `money.ts`-t.
Ugyanez a `money.ts` a `money.tsx`-en belül, ami ebben a fában a realisztikus változat. Pontosan az a
kár, aminek a megelőzésére a szkript készült. Javítva: mindkét alak (teljes út és basename)
határolt illesztést használ, és mindkét irány külön esetet kapott.

**Mérés.** 25 selftest-eset (a `graph-tooling-selftests.test.ts`-be regisztrálva 25-ös padlóval,
tehát CI-ben fut minden változásnál -- egy le-nem-futó selftest szállítása EZEN a kártyán maga lett
volna a javítandó hiba). Négy valós futtatás: teljes leltár -> exit 0; részleges leltár -> exit 1, 12
néven nevezett réssel; üres manifeszt -> exit 2; végponttól végpontig `--repo`-val, ami a gate-elt
wrapperrel csomagol, majd fogyasztja a manifesztet -> exit 0.

**Egy hiba, amit a worktree-fegyelem hozott elő.** A `build_pack` eredetileg a szkript melletti
`repomix-out`-ból származtatta a pack útvonalát. A `repomix.sh` viszont ABSZOLÚT out-dirbe ír, tehát
ez a fő klónban helyes és egy ügynök-worktree-ből CSENDBEN hibás lett volna. Most a wrapper SAJÁT
„pack written to" sorából olvassa ki -- megkérdezni a szerszámot, hova tette, nem tud elsodródni
attól, hogy hova tette.

**Ki döntött:** MikroB (kártya + a szülő-epic), backend2 (a bekötési pont megválasztása, az öt fenti
döntés, implementáció, mérések).
**Hivatkozás:** kártya 95f861f1 (szülő 3c9e22b1). Előzmény: b41c3dd3 (a gate-elt wrapper), 2f781b49
és ee01f7ce (a titok-szkennelés két megerősítése).

**Nyitott lelet, NEM ebben a kártyában javítva:** a `full-audit-checklist` skill (magyar, a
`full-value-audit` párja) KIZÁROLAG a `~/.claude/skills/` alatt él, a repóban nincs követve -- tehát
sem a seed-refresh nem éri el, sem egy újratelepítés nem őrzi meg. Nem szerkesztettem kézzel, mert
egy verziókövetetlen fájlba tett javítás nincs mentve (update-safety szabály); külön kártya kell rá.

## 2026-08-23 -- 1d4cdcaa -- Vendorolt skillek: kettő bedrótozva, kettő MikroB-only, három lezárva duplikátumként

**A kártya premisszája RÉSZBEN hamis, és ez a legfontosabb lelet.** A kártya három vendorolt
skill-csomagot ír le "nulla bizonyított használattal". Megmérve: a `mattpocock-productivity` pack
`grilling` skillje **a flotta legtöbbet használt adoptált skillje** -- `plan-grilling` néven adaptálva
(MIT, attribúcióval), a CLAUDE.md **1b. szabálya KÖTELEZŐVÉ teszi**, és 44 kanban-kártya hivatkozik rá.

Ennél is hasznosabb, hogy a `project-workflow` skill 1b. pontja SZÓ SZERINT leírja ennek a kártyának
a mintáját, már lefutva: *"a `plan-grilling` skill MÁR LÉTEZIK, de eddig senki nem hívta -- 0
hivatkozás volt... a helyes lépés a MEGLÉVŐ bekötése, nem új review-lánc építése"*. Tehát a
követendő eljárás nem az, hogy minden skillhez kitalálunk egy trigger-mondatot, hanem hogy
skillenként eldöntjük: **bedrótozni egy KÖTELEZŐ folyamatba, vagy lezárni duplikátumként.**

**A mérés, amire a döntések épülnek.** (a) Repo-hivatkozások: az öt `agent-skills` cherry-pick
(`doubt-driven-development`, `context-engineering`, `interview-me`, `idea-refine`,
`documentation-and-adrs`) és a `to-questionnaire` esetén az EGYETLEN hivatkozás az egész repóban a
`store/watched-repos.json`, azaz maga az adoptálási registry. Nulla bekötés, nulla használat -- rájuk
a premissza áll. (b) Ember-a-hurokban mérés: az `interview-me` 17 helyen mondja ki, hogy emberrel
folytatott beszélgetés, az `idea-refine` az `AskUserQuestion` toolra épül.

**1. döntés: `idea-refine` + `interview-me` BEDRÓTOZVA, de KIZÁRÓLAG MikroB-hoz (`project-workflow`
1c. pont).** A benefit-hipotézis kimondva, mielőtt adoptálnám: az 1b. grilling KONVERGENS -- egy
meglévő tervet támad, és sosem kérdezi meg, hogy jó tervet grillezünk-e. Alternatívát nem generál.
Az `idea-refine` divergens fázisa pontosan ezt a hiányt tölti be, az `interview-me` pedig az
alulspecifikált KÉRÉS esetét. A MikroB-only hatókör nem óvatosság, hanem a mérés következménye: egy
mérnöki ügynöknek nincs kivel lefolytatnia az interjút, és ha megpróbálná, a saját találgatásait
írná le a felhasználó válaszaként -- ami rosszabb, mint a kihagyás.

**2. döntés: `documentation-and-adrs` LEZÁRVA duplikátumként.** A flotta ezt natívan és KÖTELEZŐEN
megoldotta: `DECISIONS.md` minden repóban + `project-decisions-log` skill, a CLAUDE.md külön
szekciójával. A skill ADR-sablonja (Status/Date/Context/Decision/Consequences) majdnem azonos a
`DECISIONS.md` formátumával (Döntés/Miért/Elvetett alternatívák/Következmények), és a skill saját
első szabálya is az, hogy *"Match the existing convention first"* -- ami itt a meglévő konvenció.
Adoptálni annyi lenne, mint egy kötelező szabály mellé tenni egy második, nem kötelezőt.

**3. döntés: `context-engineering` LEZÁRVA duplikátumként.** Rétegzett rules-fájlok és
session-kontextus beállítása: a flottában ez a root + per-ügynök `CLAUDE.md`, a 14. szabály
(`/clear` két munka között), a 75%-os tömörítési küszöb és a `taskstate-replay` -- mind konkrétabb és
mind kötelező. Egy általános tanács-skill ezek mellett nem ad többletet.

**4. döntés: `doubt-driven-development` NEM adoptálva, és kimondom, mi változtatna ezen.** A magja
(friss kontextusú, adverzariális reviewer, mielőtt egy állítás megáll) a flottában MÁR él, csak
másképp: a gate-rendszer (QA/Cybersec/Cybered független ügynökök, akik SOHA nem a sajátjukat
ellenőrzik) plusz az 1b. grilling. Az egyetlen valódi többlet, amit a skill kínál, egy MÁS
modellcsalád reviewerként -- a skill ezt `codex`/`gemini` CLI-vel oldaná meg, és **egyik sincs
telepítve** (mérve: `command -v` üres). A flottának VAN Gemini kliense (`src/gemini-client.ts`), de az
ma kvóta-fallback útvonal, nem review-eszköz: átirányítani külön döntés (költség, egress,
kulcs-validáció). Ha valaki ezt megnyitja, ez a skill újra elővehető -- addig a gate-rendszer fedi.

**5. döntés: `crafter-intent-layer` VALÓDI hiányt fed, de SAJÁT kártyát kap.** Hierarchikus
`AGENTS.md`-fa egy kódbázisban: a flottának van root és per-ügynök `CLAUDE.md`-je, de a CleanCore
~30 csomagjához NINCS per-modul kontextus. Ez mért fájdalom, nem elméleti: ezen a napon többször
kellett újra levezetnem csomag-szintű tényeket (pl. hogy a `provisioning` `dependencies`-e üres).
Egy `AGENTS.md`-fa megírása a CleanCore-hoz viszont önálló munka, és termék-fájlokat ír -- saját
kártya, saját gate.

**Amit NEM teljesítettem, és miért nem hamisítottam meg.** A kártya (3) pontja azt kéri, hogy ahol
van reális közeljövői alkalom, ténylegesen hívjam meg a skillt bizonyítékként. Ez itt EGYETLEN skillre
teljesíthető (`crafter-intent-layer`), és az is a saját kártyájára tartozik. A két MikroB-only skill
meghívása számomra STRUKTURÁLISAN lehetetlen: mindkettő emberi választ vár, tehát egy "bizonyító"
futtatás azt jelentené, hogy a felhasználó válaszait én találom ki -- pontosan az a vakuum-bizonyíték,
amit a flotta máshol FAIL-nek minősít. A három lezárt skillnél a meghívás értelmetlen lenne.

**Ki döntött:** MikroB (kártya + a szülő-epic), backend2 (a premissza-mérés, a hét verdikt, a
MikroB-only hatókör levezetése, az 1c. pont).
**Hivatkozás:** kártya 1d4cdcaa (szülő 3c9e22b1). Precedens: 1161c9ed (a `plan-grilling` bedrótozása
ugyanezzel az eljárással).

**Nyitott, ebben a kártyában NEM javított leletek:** (a) KÉT `handoff` skill létezik -- egy a
`~/.claude/skills/handoff` alatt (2026-07-10) és egy a vendorolt packban, ELTÉRŐ tartalommal; egyik
sem hivatkozik a másikra, és a flotta `taskstate-replay`-e ugyanezt a problémát oldja meg harmadszor.
(b) A `teach`, `to-questionnaire` és `grill-me` skillekre nem született verdikt: a `grill-me` a
`grilling` rövidebb változata (a `plan-grilling` már fedi), a másik kettő nem esett a kártya
felsorolásába.

## 2026-08-23 -- e7510a83 -- Kanban-függőség jelöltek: egyik sem kerül be, és a licenc az elsődleges ok

**A kártya célpontja elavult, ezt előre kimondom.** A kártya azt kéri, hogy a `saltbo/agent-kanban`
ciklus-detektálási mintáját építsem be a "MÁR FOLYAMATBAN LÉVŐ" predecessor/successor kártyába
(Fázis `37c5605a`, alfeladat `2bb82943`). Megmérve: **a teljes fázis `done`** -- mind a négy gyereke
(`2bb82943`, `a8aa9ae5`, `73540a68`, `38788337`) lezárva. Az élő célpont a `d3f8d2c3` (`planned`,
MEDIUM), ami pontosan a maradék ciklus-garanciáról szól.

### Due diligence, mind az öt jelöltre (rule 10)

| jelölt | licenc | csillag | utolsó push | verdikt |
|---|---|---|---|---|
| `saltbo/agent-kanban` | **FSL-1.1-ALv2** (source-available, NEM OSS) | 456 | 2026-08-22 (aktív) | **NEM átvéve -- licenc** |
| `quentintou/agent-board` | MIT | 27 | 2026-02-05 | nem átvéve -- karbantartás |
| `eyalzh/kanban-mcp` | MIT | 41 | 2025-07-13 | nem átvéve -- dormant |
| `kanboard/kanboard` | MIT | 9816 | 2026-08-11 (aktív) | csak referencia (PHP), a kártya is így jelölte |
| `davidcjw/agent-task-board` | MIT | 0 | 2026-07-06 | csak UX-referencia, a kártya is így jelölte |

**1. döntés: a `saltbo/agent-kanban` kódjából SEMMIT nem veszünk át, és nem is olvasom végig
átvételi szándékkal.** A kártya helyesen jelölte "NOASSERTION, TISZTÁZANDÓ elsőként" -- a tisztázás
eredménye: a LICENSE fájl a **Functional Source License 1.1 (Apache 2.0 Future License)**. Ez
source-available, nem nyílt forrású: minden felhasználást engedélyez, KIVÉVE a "Competing Use"-t,
azaz olyan kereskedelmi terméket/szolgáltatást, ami a Szoftvert (vagy a licencadó abból épített más
szolgáltatását) helyettesíti. Két évvel a kiadás után Apache 2.0-ra vált (ez a repó 2026-03-ban
készült, tehát ~2028).

**Miért NEM döntöm el magam, hogy ez ránk áll-e.** A licencadó terméke egy *agent task board*; a
MikroB-kanban szintén egy agent task board, és a flotta kereskedelmi termékeket épít. Hogy a belső
flotta-eszköz "Competing Use"-nak minősül-e, jogi megítélés, nem mérnöki -- a flottának `jogasz`
ügynöke van pontosan erre. Addig a fegyelmezett álláspont: nem másolunk, nem vendorolunk, nem
építünk belőle származékos művet. **Ez a rule 10 due diligence-ének első lába (licenc-kompatibilitás),
és itt megbukott -- nem "elhanyagolható részlet".**

**2. döntés: a `quentintou/agent-board` (MIT, DAG-függőségek) NEM kerül be, karbantartási okból.**
A licenc rendben lenne, a leírása pontosan a mi problémánkat célozza (Kanban + DAG + audit trail).
De: `created_at` 2026-02-04, `pushed_at` 2026-02-05 -- **egyetlen nap aktivitás, azóta 6,5 hónap
csend**, 27 csillag. Egy egynapos, azóta nem karbantartott repó függőségként vagy mintaforrásként
rosszabb, mint a saját, tesztelt kódunk. Az `eyalzh/kanban-mcp` ugyanígy: MIT, de 13 hónapja nem
mozdult.

**3. döntés (a lényegi mérnöki válasz): NINCS mit átvenni, mert a minta MÁR benne van.** A kártya
azt feltételezi, hogy a ciklus-detektálás hiányzik vagy gyenge nálunk. Megmérve a `src/db.ts`-ben:
az `addKanbanDependency` **tranzitív lezárást** számol (`predecessorClosure`, `WITH RECURSIVE ...
UNION`), és elutasítja a self-élt, az ismeretlen kártyát, a duplikátumot és a ciklust -- a
`path`-szal együtt. Ez a tankönyvi megoldás; egy külső minta ehhez nem adna hozzá.

**A mérés, ami ezt konkréttá teszi** (in-memory SQLite, `c1->c2->c3->c1` MÁR BENT lévő ciklussal):

    UNION      -> 0,0002 s alatt megáll, 3 sor (c1, c2, c3)
    UNION ALL  -> NEM áll meg: 0,13 s alatt 200 000+ sor, és tovább termel

Vagyis a "már bent lévő ciklus se fagyassza le a lekérdezést" tulajdonság **egyetlen szón múlik**, és
a kód kommentje helyesen állítja. Amit a `d3f8d2c3` 2. pontja kifogásol, az igaz: ezt **teszt nem
szegezi ki**, tehát egy jövőbeli "optimalizálás" `UNION ALL`-ra némán végtelen ciklust hozna. A fenti
mérés készen áll ehhez a teszthez; **oda tartozik, nem ide** -- ez a kártya due diligence-kártya, a
`d3f8d2c3` a javító kártya, és a kettőt összemosni pont az a duplikált munka, amit a 6b. szabály tilt.

**Ki döntött:** MikroB (kártya + a szülő-epic), backend2 (licenc-tisztázás, karbantartási mérés,
a ciklus-mérés, a nem-átvételi verdikt).
**Hivatkozás:** kártya e7510a83 (szülő 40f92dd2). Kapcsolódó: 37c5605a fázis (done), d3f8d2c3 (nyitott).

**Eszkalálva, NEM eldöntve:** a FSL-1.1 "Competing Use" kérdése a `jogasz` ügynökre tartozik. Amíg
nincs jogi verdikt, a `saltbo/agent-kanban` **nem forrás** -- se kód, se vendorolás, se származékos mű.
## 2026-08-23 21:10 -- A self-pace gate hamis pozitívjait parancs-pozícióval szűkítjük, nem további kivételekkel (kártya 442f3289)

**Döntés:** a `self-pace-gate.mjs` horgonyzatlan heredoc-törzs-pásztázásában az `at`/`batch` két angol szó mostantól parancs-POZÍCIÓT igényel a soron belül (sor eleje, `;`/`&`/`|`/`(`/backtick, idézőjel, vagy `then`/`else`/`elif`/`do`). A többi scheduler-bináris változatlanul horgonyzatlan.
**Miért:** ez a négyedik hamis pozitív ugyanabból az osztályból. A korábbi három javítás (0229c844, eae5d6fd, 46c4ad4a) mind azt szűkítette, MI KÖVETHETI a szót -- és pont ott van a tényleges átfedés: az at(1) időpont-nyelvtana (óra:perc, dátum, noon, today, hétköznap-rövidítés, 3-4 jegyű szám) SZÓ SZERINT az, amit egy ütemezésről vagy mérésről szóló magyar/angol mondat tartalmaz. Ez a tengely nem konvergál. A pozíció viszont olyan struktúra, amivel a próza nem rendelkezik -- a horgonyzott ág biztonsága is mindig ebből jött.
**Irány-kockázat, kimondva:** ez a változás KEVESEBBET tilt, tehát lyukat nyithat, nem zajt. Ezért a pozíció-felsorolásnak TELJESNEK kell lennie (nem csak tolerancia kérdése), és minden eleme külön mutatással mért. A maradék, tudatosan nyitva hagyott eset: egy próza-sor, ami MAGÁVAL a szóval és egy időponttal KEZDőDIK -- az struktúrálisan megkülönböztethetetlen egy valódi hívástól, ezért tilt marad, és teszt rögzíti, hogy ez ismert és nem „lefedett”.
**Ki döntött:** Backend (implementáció), Cybersec/backend2/MikroB lelet-adatai alapján.
**Hivatkozás:** kártya 442f3289.

## 2026-08-23 -- e2610f91 -- FSL-1.1 "Competing Use" jogi értékelés (saltbo/agent-kanban) + source-available licenc-politika a rule 10-hez

**AI Draft -- nem jogi tanács, kötelező erejű döntéshez humán ügyvéd kell.**

**Előzmény:** backend2 due diligence-e (e7510a83, done) már eldöntötte, hogy a saltbo/agent-kanban-ból SEMMI nem került át (nulla kódváltozás, `store/adopted/` üres, teljes fa átvizsgálva). Ez a bejegyzés a FÜGGŐBEN hagyott jogi kérdést zárja le és politikát ad a jövőre -- nem visszamenőleges javítás, mert ma nincs mit javítani.

**1. döntés -- a konkrét kérdésre (áll-e a Competing Use a MikroB-kanban/saltbo-agent-kanban párra): FELTÉTELES válasz.** A licenc verbatim szövegét rögzített commit SHA-n ellenőriztem (`82c082c5e3fcab75d33523e5b2b67df3716afc4a`, 2026-08-22, `LICENSE` fájl a `main` ágon -- FSL-1.1-ALv2, "Apache 2.0 Future License" változat). A "Competing Use" három, EGYMÁSTÓL FÜGGETLEN feltétel bármelyikére trigerel: (1) helyettesíti a Szoftvert; (2) helyettesíti a licencadó MÁS, a Szoftverrel épített termékét/szolgáltatását; (3) "ugyanolyan vagy lényegében hasonló funkcionalitást" nyújt. A (3) pont ÖNMAGÁBAN, szó szerinti kódmásolás nélküli funkcionális hasonlóság esetén is trigerel -- és a két termék leírása (mindkettő: AI-agent feladatkezelő tábla, függőségkezeléssel/ciklus-detektálással, agent-to-agent üzenetváltással) lényegében hasonlónak számít.
  - HA a MikroB-kanban SOHA nem válik harmadik fél számára elérhetővé (nem eladott termék, nem ügyfélnek nyújtott szolgáltatás, nem publikált/spin-off) -> a licenc saját "Permitted Purpose" listája KIFEJEZETTEN megengedi a "your internal use and access"-t, FÜGGETLENÜL a funkcionális hasonlóságtól -- ekkor a Competing Use NEM áll fenn, még jövőbeli kódátvétel esetén sem.
  - HA a MikroB-kanban (vagy belőle származó kód) BÁRMIKOR harmadik félnek elérhetővé válik -> a (3) pont önmagában valószínűleg alkalmazandó, függetlenül attól, hogy szó szerinti másolás történt-e vagy csak funkcionális mintakövetés.
  - A load-bearing tény (kerül-e a MikroB-kanban bármely formában harmadik fél számára elérhetővé) Petitől/üzleti döntéstől függ, jelen bejegyzés nem mondja ki -- a root CLAUDE.md leírása szerint ma egy localhost-kötött admin dashboard, ami internal-use jelre utal, de ezt NEM tekintem megerősített ténynek.
  - Ma NINCS eltérés az első esettől a gyakorlatban, mert e7510a83 döntése szerint semmi nem került át -- tehát ma nincs sértés, ez egy JÖVŐBENI döntési pont rögzítése.

**2. döntés -- általános politika a rule 10-hez (source-available/FSL-típusú licencek), javaslat MikroB felé:** source-available (FSL, BUSL, SSPL, Elastic License és hasonlók) licencű kód a flottában alapértelmezés szerint **csak szigorúan BELSŐ eszközben** használható korlátozás nélkül (olyan komponensben, amit a flotta SOHA nem ad át/ad el/tesz elérhetővé harmadik félnek, akár mint terméket, akár mint ügyfélnek nyújtott szolgáltatást, akár mint publikált/spin-off repót) -- mert a legtöbb FSL-változat kifejezetten megengedi a belső használatot, függetlenül a funkcionális hasonlóságtól. Bármi, ami bármikor külsővé válhat, **eseti jogi jóváhagyást igényel MÉG A DÖNTÉS ELŐTT**, nem utólag. A "csak referenciaként olvasom, nem másolok" fegyelem (amit backend2 e7510a83-ban már alkalmazott: szándékosan nem olvasta végig a forrást átvételi szándékkal) ajánlott mintaként rögzítve: a származékos mű kockázata nem a `git clone`-nál kezdődik, hanem ott, ahol valaki fejből átírja a mintát. A licenc-státuszt SOHA nem szabad emlékezetből venni: az FSL-nek több változata van (a "Future License" lehet Apache-2.0 VAGY MIT), az átváltás dátuma a kiadás dátumától számított 2 év és repónként eltér, egy repo bármikor relicenszelhet -- minden adoptálási döntésnél ROGZÍTETT COMMIT SHA-n kell újraolvasni a LICENSE fájlt. Teljes javasolt szöveg a kártya-kommentben (e2610f91); a beillesztés helyét (rule 10 törzsszövege vs. külön skill) MikroB dönti el, mert a root CLAUDE.md az ő dokumentuma.

**Miért:** a Competing Use (3) pontja funkcionális hasonlóság alapján is trigerel, nem csak szó szerinti másolás alapján -- ez szélesebb, mint amit egy sztenderd MIT/Apache-alapú "GitHub-first" fegyelem feltételez, és ez volt a hiányzó eset a rule 10-ben (Cybersec és backend2 is jelezte, e7510a83 komment 15636/15632).

**Amit ez a bejegyzés NEM zár le:** hogy a MikroB-kanban valaha harmadik fél számára elérhetővé válik-e -- ez üzleti/termék-döntés, Petitől függ, nem jogi kérdés; ha ez valaha felmerül, ÚJ DECISIONS.md bejegyzés kell, nem ennek szerkesztése.

**Ki döntött:** jogász (jogi értékelés + politika-javaslat); a végső rule 10 szöveg beillesztése MikroB/Peti felé eszkalálva.
**Hivatkozás:** kártya e2610f91 (forrás: e7510a83, backend2 due diligence-e; Cybersec kiegészítése komment 15636/19744).

## 2026-08-23 -- ef9a7bf1 -- Agent-memória jelöltek: egyik sem kerül be, de a mérés két saját hibát talált

### Due diligence (rule 10)

| jelölt | licenc | csillag | utolsó push | verdikt |
|---|---|---|---|---|
| `yoloshii/ClawMem` | MIT | 200 | 2026-08-18 (aktív) | **NEM** -- a fő képessége már megvan (felerészben) |
| `axiomhq/agent-memory` | **NINCS (`license: null`)** | 6 | 2026-03-09 (5,5 hónap) | **NEM -- licenc** |

**1. döntés: az `axiomhq/agent-memory` KIZÁRVA, licenc hiányában.** A GitHub API `license: null`-t ad
rá: nincs licencfájl, tehát minden jog fenntartva -- se másolni, se módosítani, se terjeszteni nem
szabad. Ez erősebb tiltás, mint az FSL az `e7510a83` kártyán, és megint a kártya által LEGINKÁBB
áhított jelöltre esik (ezt jelölte "közeli előzmény a `/dream` skillünkhöz"). Két egymást követő
adoptálási kártyán bukott el a legérdekesebb jelölt licencen: **ez már minta, nem véletlen** --
érdemes a jelölt-listákra a licencet a csillagszám MELLÉ, előre felvenni.

**2. döntés: a `ClawMem` NEM kerül be, mert a fő képessége már itt van -- felerészben.** MIT, 200
csillag, öt napja pusholva: a licenc és a karbantartás is átmenne. A headline-je viszont a "hybrid
RAG search", és ebből a kulcsszavas felet MÁR használjuk (`searchAgentMemories`: FTS5 `MATCH` +
recency-újrarangsorolás + `LIKE`-fallback). Egy kész csomag átvétele azért, hogy megkapjuk, amink van,
nem nyereség.

### A mérés, ami ennél többet ért: két saját hiba

**(a) A `memories.embedding` oszlop ÍRVA VAN, de SOHA NEM OLVASSUK.** Mérve: 1149 sorból **1126
hordoz embeddinget** (98%), a `src/index.ts` indításkor backfillel, a fleet-import újra-embeddel --
és a keresési út (`searchAgentMemories`) tisztán FTS + recency. A `/api/memories` válaszaiból az
oszlop kifejezetten ki van törölve (`embedding: undefined`). Vagyis **egy vektor-keresési képesség
teljesen fel van építve és nulla fogyasztója van** -- pontosan a szülő-epic (`3c9e22b1`)
hibaosztálya, a memória-rendszeren belül, ahova ez a kártya nézni küldött. A ClawMem itt VALÓDI
hiányra mutat rá: a hibrid keresés szemantikus fele.

**(b) DE a sorrend fordítva helyes, és ezt is mérés mondja: előbb a korpusz, aztán a keresés.**
A `backend` ügynök **670 memóriájából mind a 670 `auto_generated=1`, és 658 (98%) eszköz-napló**
(`Bash:`/`Write:`/`Edit:` prefixű) -- összesen 12 prózai memóriája van. A teljes tár 1149 sorából 388
eszköz-napló, és 454 sor pontos DUPLIKÁTUM (75 csoport; egyetlen azonos `Bash: ...` sor **45-ször**
szerepel). A `hot` tier 176 sorából **174 eszköz-napló** -- az a tier, aminek a szabály szerint "ami
MOST történik" a tartalma.

A hatás közvetlenül mérve a keresésen: a `backend` memóriáira futtatott `git merge`, `worktree`,
`commit` és `gate` lekérdezés **mind 100%-ban auto-activity sorokat adott vissza**. Az ügynök valódi,
kézzel írt emlékei gyakorlatilag elérhetetlenek a saját keresésén át.

És hogy ezt egy szemantikus keresés se javítaná meg: **a 658 eszköz-naplóból 636 hordoz embeddinget**,
tehát pontosan ugyanúgy versenyezne egy vektor-keresésben, ahogy most az FTS-ben. **Egy jobb kereső
egy 98%-ban zajos korpusz fölött a rossz felét optimalizálja.**

**3. döntés: a javítás nem itt, és nem defrag-passzal.** A forrás a `4829ccff` kártya PostToolUse
prototípusa (`scripts/hooks/activity_memory_capture.py`), ami szándékosan EGY ügynökre van kötve és
`auto_generated=1`-gyel ír. Nem elszabadult író: pontosan azt csinálja, amire tervezték. Egy
defrag/dedup pass (az `axiomhq` ötlete) a TÜNETET takarítaná, miközben az író tovább termel -- a
`45×` duplikátum önmagában mutatja, milyen gyorsan. A helyes lépések sorrendje, a legolcsóbbal
kezdve: (i) a keresés alapból ne adjon vissza `auto_generated=1` sorokat (a mező már ott van, csak
nincs használva a `searchAgentMemories`-ben); (ii) a prototípus dedupláljon írás előtt; (iii) csak
ezután érdemes a szemantikus keresési felet megépíteni az (a) pont embeddingjeire.

**Ez a kártya nem javítja egyiket sem**: due-diligence kártya, a talált hibák pedig más kártyák
hatókörébe esnek (a prototípus a `4829ccff`-é), és a keresési-szűrés + embedding-bekötés önálló
kártyát érdemel saját gate-tel.

**Ki döntött:** MikroB (kártya + szülő-epic), backend2 (licenc-mérés, a saját rendszer mérése, a
sorrend levezetése, a nem-átvételi verdikt).
**Hivatkozás:** kártya ef9a7bf1 (szülő 40f92dd2). Kapcsolódó: 4829ccff (a prototípus), 3c9e22b1
(a "adoptált de használatlan" epic), e7510a83 (ugyanaz a licenc-minta).
## 2026-08-23 21:30 -- A self-pace kapu megnézi, mit futtatna egy shell (kártya ec20dd23)

**Döntés:** a `self-pace-gate.mjs` (1) parancs-pozíció-osztálya kiegészül a shell-kulcsszavakkal és a zárójel-csoporttal, (2) a `bash|sh|zsh|dash|ksh -c` és `eval` argumentumát, valamint stdin-ből programot olvasó fogyasztó (`| bash`, `xargs bash -c`) esetén az idézett literálokat kicsomagolja, és a TELJES meglévő ellenőrzést lefuttatja rajtuk (a `gateDecision` önmagát hívja rekurzívan, nem másolja a checkeket).
**Miért:** a `maskInertLiterals` kiüríti az idézett részeket a horgonyzott vizsgálat előtt -- ez teszi a prózát inertté, és mindenhol máshol ez a helyes. De egy `bash -c` argumentum NEM inert: az MAGA a program. Vagyis pont az az egyetlen szerkezet, aminél az idézőjel azt jelenti, hogy „ezt futtasd", volt az, amibe a kapu nem nézett bele.
**Irány:** ez a változás TÖBBET tilt, tehát a hibamódja nem lyuk, hanem akadállyá váló kapu. Ezért a jóhiszemű halmaz (olvasó forma, próza, grep, runbook-olvasás, commit-üzenet, wrapperen belüli próza) külön mérve és mutációval kikényszerítve -- a „mindig csomagold ki az idézett literálokat" mutáns 12 tesztet dönt.
**Mért kiterjedés:** a jelentett 8 megkerülés mellé a fix közben további 14 azonos osztályú alak került elő (sh/zsh/dash -c, bash -lc, `| bash`, `| sh`, `xargs sh -c`, elif/while/until, zárójel-csoport, beágyazott wrapper). Mind a 23 zárva.
**Testvér-kapu megmérve, NEM érintett:** az `email-send-gate.mjs` mind a négy próbát (csupasz, `bash -c`, `eval`, `then`-ág) helyesen tiltja, tehát nem kell rá külön kártya.
**Ki döntött:** Backend (implementáció), Cybersec élő lelete alapján (442f3289 gate).
**Hivatkozás:** kártya ec20dd23.

## 2026-08-23 22:10 -- Egy parancs-pozicio-nyelvtan, ket ag helyett (kartya 442f3289 2. kor)

**Dontes:** a `SCHED_BOUNDARY` (horgonyzott ag) es a `LINE_CMD_POSITION` (heredoc-torzs ag) mostantol UGYANABBOL a `CMD_POSITION` konstansbol szarmazik. Tartalma: `; & | ( ) { !` backtick + az `if/then/else/elif/while/until/do` kulcsszavak. A `}` szandekosan kimarad (bash elvalasztot ker utana), es az IDEZOJEL is kimarad.
**Miert (a ket lista):** ket lista irta le ugyanazt az egy fogalmat, es MINDKET iranyba eltertek -- mindegyikben volt olyan pozicio, ami a masikbol hianyzott, mert minden javitas azt a listat tanitotta meg, amelyik elott eppen allt. Mert eredmeny: hat hianyzo pozicio egyszerre (ot az egyik agon, egy a masikon). Ebbol ketto REGRESSZIO volt, amit en okoztam az elozo korben: a szukites egy olyan felsorolasra allt at, amit a patch-bol epitettem, nem a shell nyelvtanabol.
**Miert nem idezojel:** az idezojel PROXY volt arra, hogy "egy shell futtatja ezt a szoveget". Az ec20dd23 kartya a proxyt lecserelte a tenyleges dologra (a `-c`/`eval` argumentum kicsomagolasa). Mindket iranyban megmerve: idezojel nelkul MINDEN wrapper-vektor tovabbra is tiltva (kicsomagolassal erve el), viszont ket fals pozitiv eltunik -- egy JSON-payload heredocban, aminek az erteke idopont-kifejezessel kezdodik, es egy azt idezo mondat. Cybersec az elozo koron ezt "uj fals pozitiv, de a helyes iranyba" neven jelezte; kiderult, hogy egyaltalan nem kellett elcserelni.
**A `!` kerdese (MikroB nyitott dontese):** BENT van, fail-closed, Cybered javaslata szerint -- a `! <binaris>` tenylegesen futtatja a binarist. Ara egy olyan proza-sor, ahol a felkialtojel kozvetlenul egy idopont-kifejezes elott all; teszt szegezi ki a valasztast.
**Ki dontott:** Backend (implementacio), Cybered NO-GO + Cybersec sajat GO-visszavonasa alapjan, MikroB egyesitesi keresere.
**Hivatkozas:** kartya 442f3289 (2. kor), ec20dd23.
## 2026-08-23 22:25 -- A `case` mintavégződés `)`-je elválasztó, nem záró; és a parancsot megelőző kulcsszavak léptetik a határt (kártya 84e31b40, Cybersec F-8)

**Döntés:** a `stripHeredocDataPayloads` járója követi a `case` NYELVTANT: (a) a mintát lezáró `)`
elválasztó, nem keret-záró; (b) a `case`/`esac` KIZÁRÓLAG parancs-pozícióban számít kulcsszónak,
az `in` pedig csak nyitott `case` mellett; (c) a parancsot megelőző foglalt szavak
(`if then elif else while until do time ! {`) előre léptetik a határt, ahelyett hogy a span
részévé válnának; (d) a `(minta)` alak nyitó `(`-je nyelvtan, nem subshell, tehát keretet sem nyit.

**Miért:** a `curl ... -d @- $(case x in x) python3 <<'PY' ... PY ;; esac)` alakban a bash a mintát
zárja azzal a `)`-vel és a heredocot az ág belsejében lévő python3-nak adja; a járó záróként olvasta,
popolta a `$(` keretét, és a spant a KÜLSŐ curl-től mérte. Ugyanaz a téves számolás, mint F-5
(idézés), F-6 (csupasz subshell), F-7 (parameter expansion) -- negyedik konstrukción keresztül.
Cybersec élő bashben, marker-fájllal bizonyította.

**A család végigmérése négy TOVÁBBI élő alakot hozott** (mind marker-fájllal, valódi bashben futtatva):
`a|x)` alternáció, `@(a|x))` extglob (akkor fut, ha az extglob már PARSE-időben be van kapcsolva --
`eval`-lal, előtte `shopt -s extglob`, megmérve), beágyazott `case`, és újsor az `in` és a minta
között. Plusz kettő, ami csak egy MÁSIK foglalt szón át éri el a kulcsszót: `then case`, `do case`.

**Ez a kör abban tér el az előzőektől, hogy a NAGYVONALÚ felismerés NYITOTT volna egy megkerülést,
nem zárt.** A minta-szabály ELŐRE lépteti a határt, tehát aki egy hamis `case`-t felismertet, az
választja meg, hol kezdődik a következő span. A `python3 - $(: case in x) curl -d @- <<'PY'` valódi
bash-parancs, amiben a `case` a `:` argumentuma -- kulcsszóként kezelve a járó a `curl`-re tolná a
határt és kiürítene egy törzset, ami a python3-é. Ezért van a parancs-pozíció feltétel, és ezért
léptetik a határt a parancsot megelőző foglalt szavak (enélkül a `then case` alakra a szabály
csendben nem is alkalmazódna). K13/K14 szegezi ki az elsőt, a K16/K17 a másodikat.

**Mellékesen két álló FALS-POZITÍVOT is megszüntet:** (1) `for f in a b; do curl ... -d @- <<'JSON'`
eddig a `do`-tól mérte a spant, elbukott a vezető-bináris ellenőrzésen, és egy jogos payloadot
tiltott; (2) ugyanez minden `case`-ágba tett jogos hívásra. A kártya CÍME pont ez a hibaosztály.

**Mérés, 69 alak, MINDKÉT kapun:**

| változat | rossz eset |
|---|---|
| előző kör (7be96d9a) | 11 (7 élő megkerülés + 4 fals pozitív) |
| ez a változat | 0 |

**Mutáció-mérés, kilenc ág, és megint kihozott egy fedetlen ágat:**

| mutáció | piros |
|---|---|
| MA: nincs kulcsszó-felismerés | 13 |
| MB: a mintavégződés megint popol (maga az F-8 hiba) | 14 |
| MC: a `case`/`esac` bárhol számít, nem csak parancs-pozícióban | 2 |
| MD: a megelőző foglalt szavak nem léptetik a határt | 4 |
| ME: a `(minta)` nyitó `(`-je megint keretet nyit | 1 |
| MH: a mintavégződés nem nézi a mélységet | 0 -> ez volt a jelzés, majd 2 |
| MF: `;` bármely mélységben zárja az ágat | 0, egyenértékű (lásd lent) |
| MG: keret-zárás nem állítja vissza a case-vermet | 0, egyenértékű (lásd lent) |
| MI: az `in` nem rögzíti újra a mélységet | 0, egyenértékű (lásd lent) |

Az MH túlélte az egész készletet, ezért differenciálisan végigsöpörtem 2541 generált alakot: 29
eltérés, MIND fals-pozitív irányban, és a szétválasztó alak VALÓS, futó bash --
`case x in $(echo x)) curl ... -d @- <<'JSON'` (a minta expandálódik, tehát egy `$( )` benne
szabályos; `bash -n` + futtatás megerősítette, hogy illeszkedik). Egy mélység-vak szabály ANNAK a
`)`-jénél zárná a mintát, elvesztené a keretet, és egy jogos payloadot tiltana. Kiszegezve két
kontrollal, utána az MH 2 pirosat ad.

**A három túlélő ágról KIMONDVA, mit mértem** (a hatodik kör MD-jével azonos fegyelem: bizonyíték
nélkül nem állítom lezártnak, de itt van mérésem az EGYENÉRTÉKŰSÉG mellett is):

- **MI** egyenértékű SZERKEZETILEG: a `case` és az `in` közötti mélység csak akkor térne el, ha
  közben kiegyensúlyozatlan nyitó lenne, ami érvényes bashben lehetetlen. 2541 + 21 célzott alak: 0 eltérés.
- **MG**-t csak ÉRVÉNYTELEN bash választja szét (`$(: ; case)`, `$(echo $(case) )` -- a csupasz `case`
  szintaktikai hiba, `bash -n`-nel megmérve), és ott is fals-pozitív irányban. Érvényes bemeneten a
  `esac` mindig az őt tartalmazó helyettesítésen BELÜL zár, tehát a verem-visszaállítás redundáns.
- **MF** hatását az `esac` maszkolja: egy mélyebb `;` által tévesen 'pattern'-re állított állapot
  csak egy base-mélységű `)`-nél számítana, oda viszont érvényes bashben előbb ér az `esac`, ami
  kiveszi a case-bejegyzést. 2541 + 21 célzott alak: 0 eltérés.

Egyikre sem írtam tesztet, amiről nem tudom megmutatni, hogy mér valamit -- ez ugyanaz a
vákuum-teszt-tilalom, mint a 0ecff3ae-n és a hatodik kör MD-jénél.

**K15 NEM lelet:** a `$(case x in x) : esac )` alak érvénytelen bash (`bash -n` szintaktikai hiba), az
`esac` argumentumként nem zárja a case-t. A járó ALLOW-ja ott ártalmatlan, mert nem fut le semmi.

**Cybersec strukturális javaslata (tree-sitter-bash vs. tovább-foltozás):** MikroB döntése (komment
15603) a MOST-foltozás + külön kártyán futó tree-sitter-bash értékelés, GitHub-first due
diligence-szel. Ez a bejegyzés a foltozó felét rögzíti; a migráció külön kártyán él.

**Ki döntött:** Cybersec (F-8 lelet, javítási irány, strukturális javaslat), MikroB (a most-foltozás
+ párhuzamos tree-sitter kártya), fullstack (a végrehajtás, a parancs-pozíció szigorítás, a négy
további alak és a kilenc mutáció).
**Hivatkozás:** kártya 84e31b40, commit f6dfc18f + 1b73f1d5. Előzmény: 7be96d9a (csupasz `(`
+ `${ }`), f7c1d07f (idézés-tudat), e5b2cd84, c17173fc, f4fac1d7.

## 2026-08-23 22:35 -- A wrapper-felismero is a kozos nyelvtanbol dolgozik, es harom uj alak zarva (kartya ec20dd23 2. kor)

**Dontes:** (1) a `SHELL_C_RX`/`EVAL_RX`/`HERESTRING_RX` parancs-pozicioja a kozos `CMD_POSITION`-bol szarmazik (plusz sima szokoz, mert egy `-c` shell jogosan allhat egy masik parancs argv-jeben, pl. `xargs -I{} bash -c`) -- ezzel a nyelvtan HAROM helyett EGY helyen el, ahogy MikroB haromszor kerte. (2) A `-c` elotti opcio-futam ALAK szerint illeszkedik, nem lista szerint. (3) Uj here-string felismero. (4) A dupla-idezojeles torzs egy szint escape-elest visszabont a rekurzio elott.
**Miert:** Cybersec (33/35 zarva, 3 nyitva) es Cybered (HIGH) fuggetlen NO-GO-i. A `-c` elotti opcio-futam csak csupasz rovid flageket ismert, ezert `bash --norc -c`, `--noprofile -c`, `--rcfile /tmp/x -c`, `-O extglob -c` es `sh -c --` mind atment -- mind mert, mind futott. A here-stringnel (`bash <<< "..."`) nincs `-c` sehol es a program sosem kerul argv-be. A haromszor agyazott wrapper escape-elt idezojelei miatt a rekurzio egy szinttel a payload elott allt meg.
**Az opcio-futam NEGATIV alakja szandekos:** egy opcio-token az, ami `-`/`+` jellel kezdodik es NEM maga a keresett `-c` -- opcionalisan egy nem-opcio argumentummal. Igy egy olyan opcio, amire senki nem gondolt, tovabbra is elnyelodik, ahelyett hogy megszakitana az illesztest es elrejtene a payloadot (a fajl sajat irany-elve).
**Amit a gate-ek merese ota mar zart:** a case-ag (H-1/F-1) a testver-kartya (442f3289 2. kor, 11a7698e) egyesitesevel MAR bezarult -- mindket gate `ab836eb1`-en mert, a fix kesobb landolt.
**DoS-felulet megmerve:** az uj beagyazott kvantorok nem hoznak visszalepes-robbanast (5000 opcio-token 1 ms, 2000 melyen agyazott behelyettesites 44 ms, 160k karakteres wrapper 131 ms).
**Ki dontott:** Backend (implementacio), Cybersec + Cybered NO-GO-i alapjan, MikroB szerkezeti keresere.
**Hivatkozas:** kartya ec20dd23 (2. kor), 442f3289.

## 2026-08-23 -- 71188a2a -- Lokális-LLM routing jelöltek: nincs átvétel, és a kártya célpontja rossz rétegre mutat

### Due diligence (rule 10) -- ezúttal EGYIK sem bukik licencen

| jelölt | licenc | csillag | utolsó push | verdikt |
|---|---|---|---|---|
| `peva3/SmarterRouter` | MIT | 149 | 2026-05-10 (3,5 hónap) | **NEM** -- olyan problémát old meg, ami nekünk nincs |
| `ypollak2/llm-router` | MIT | 73 | 2026-08-20 (aktív) | **NEM** -- a mi model-fallback rétegünkkel fed át, nem a routerrel |
| `ulab-uiuc/LLMRouter` | MIT | 2503 | 2026-08-20 (aktív) | **NEM** -- MÁR értékelve és elvetve, lásd lent |
| `llm-use/llm-use` | MIT | 56 | 2026-02-07 (6,5 hónap) | **NEM** -- orchestration-toolkit, nem a mi rétegünk |

**1. lelet: az `ulab-uiuc/LLMRouter`-t MÁR értékeltük, és az indoklás a KÓDBAN áll.** A
`src/local-llm-router.ts` fejléce tartalmaz egy rule-10 bekezdést, ami néven nevezi a
WayfinderRoutert, az `ulab-uiuc/LLMRouter`-t és az NVIDIA-AI-Blueprints/llm-routert, és kimondja a
verdiktet: *adapt + build* -- „mindhárom a várt VÁLASZMINŐSÉGRE routol, tanítóadatot/embeddinget/
modellsúlyt igényel, és egyik sem kódol fail-closed, per-kategória biztonsági politikát a MI
nehézségi taxonómiánk felett". Ez a kártya nem tudott róla. **Egy már meghozott adoptálási döntést
újra elővenni akkor is költség, ha ugyanaz az eredmény** -- érdemes a jelölt-listákat a meglévő
rule-10 megjegyzésekkel összevetni, mielőtt kártya lesz belőlük.

**2. lelet (ez a lényegi): a kártya célpontja rossz rétegre mutat.** A kártya a
„`src/local-llm-router.ts` VRAM-kontenció-problémájáról" beszél. A `routeTask` viszont **determinisztikus
POLITIKAI osztályozó, ami SEMMILYEN futásidejű állapotot nem lát -- és ez szándékos**, a fájl saját
szavaival: „DETERMINISTIC BY DESIGN ... never an LLM call". Nincs benne VRAM-kontenció-probléma;
nincs benne VRAM egyáltalán, mert nem ütemező.

A kontenció egy réteggel lejjebb, a `local-llm.sh`-ban él, és ott **már kezelve van**: minden GPU-munka
egyetlen `flock` mögött sorosít (`/tmp/local-llm-gpu.lock`), 600 s várakozási plafonnal, és a
lock-bukás SAJÁT kilépési kódot kap (6, „gpu lock busy -- not a generation failure"), hogy ne
keveredjen egy generálási hibával.

**3. lelet (JAVÍTVA a Cybersec F-1 után, 2026-08-24): a kontencióról ma NEM lehet a queue-ból mérni,
mert egyik kódút sem írja be „lock busy"-ként.** Ez a szakasz eredetileg azt állította, hogy
„megmérve, a kontenció ma nem okoz bukást", és bizonyítékként a `local_llm_queue` egyetlen sorára
hivatkozott (`gpu lock busy / exit 6 -> 0`). Az a szám VAKUUM: nulla lenne akkor is, ha soha nincs
kontenció, és akkor is, ha folyamatosan van. Miért:

- **Közvetlen út** (`store/local-llm.sh:335-346`): a hiba-ág `log_usage err` + `_queue_finish fail`
  párossal INDUL, és csak ezután válik szét a kilépési kód szerint (`gen_rc -eq 1` -> `die 6`). A
  `_queue_finish fail` viszont mindig ugyanazt az egy stringet írja: `local-llm.sh call failed`. Egy
  lock-busy tehát pontosan úgy néz ki a sorban, mint bármely más bukás; a `log_usage` is csak `err`-t
  ír, kilépési kódot nem.
- **Worker út** (`store/local-llm-worker.sh:99-104`): ott az `rc -eq 6` ág `abstain`-t hív, a sor
  VISSZAMEGY `pending`-be, sosem lesz `failed`. Ez szándékos és helyes (nem számít bele a 3-csapás
  eszkalációs budgetbe), de azt is jelenti, hogy a worker úton egy lock-busy nyomtalan marad.

A `local_llm_queue` 1725 sora ettől függetlenül igaz: 1422 kész, 302 bukott (17,5%), 1 eszkalált. A
bukások megoszlása viszont így olvasandó:

```
local-llm.sh call failed                  165   <- ebben BENNE van a lock-busy is, ha volt
abandoned: worker vanished while running  128
requeued: worker vanished while running     9
(nincs "gpu lock busy" kategória -- egyik kódút sem ír ilyet a sorba)
```

**Amit a mérés VALÓBAN alátámaszt.** A `store/local-llm-usage.log` 4926 sorából 237 az `err`. Ebből
175 a `route-classify`, ami a repóban az EGYETLEN hívó, ami lerövidíti a várakozást
(`LOCAL_LLM_LOCK_WAIT="$HALF" LOCAL_LLM_TIMEOUT="$HALF"`, HALF = TIMEOUT/2 = 22 s) -- és mind a 175
sor 22,058-23,354 s (medián 22,075 s), vagyis pontosan a küszöbön ül. Ott a lock-plafon ÉS a
generálási timeout ugyanaz a szám, tehát a kettő megkülönböztethetetlen: ezekről egyik irányba sincs
bizonyíték. A maradék 62 sor viszont az alapértelmezett 600 s-os lock-wait-tel futott, és köztük a
leghosszabb hibás hívás is csak 359,7 s. Mivel a `flock -w 600` definíció szerint csak a TELJES
várakozás letelte után bukik, 600 s alatt lock-busy nem lehet: **ennél a 62 hívásnál tényleg nem a
kontenció ölt; a többiről ma nem lehet nyilatkozni egyik irányba sem.**

A bukás-tömeg viszont változatlanul a **worker-életciklus**: 137 sor „a worker eltűnt futás közben"
(128 abandoned + 9 requeued), és napokra bontva ez ÁLLANDÓ (2026-08-23: 11, 08-22: 35, 08-21: 40,
08-20: 24, 08-16: 23), nem egyszeri incidens -- tehát nem a mai dxgkrnl-crashloop számlájára írható.

**Következmény (követő kártya-jelölt, Cybersec F-2):** a kontenciót a rendszer futásidőben helyesen
ismeri fel és fail-closed módon kezeli (`route-classify.sh` külön `BUSY` státusza, a worker
`abstain`-je), de sehol nem PERZISZTÁLJA. Ezért a következő ilyen döntés is érvelhető lesz, nem
mérhető. Egy sornyi javítás elég hozzá: a `log_usage` kapjon `busy` státuszt `err` helyett, ha a
kilépési kód 6 (vagy a queue kapjon elkülönített `contention` számlálót).

**4. döntés: a `SmarterRouter` VRAM-logikája olyan problémát old meg, ami nekünk nincs.** Az ő
VRAM-tudatossága TÖBB modell/backend közül választ aszerint, hogy mi fér a memóriába. Nálunk EGY 7B
fut EGY GPU-n: nincs miből választani. A mi változónk nem a VRAM-fejtér, hanem a SORHOSSZ, és arra
egy flock a helyes és legegyszerűbb válasz. Egy VRAM-tudatos gateway behozatala azt optimalizálná,
ami nem bukik, miközben 137 sor a worker eltűnésétől hal meg.

**5. döntés: a kontenció-tudatos routing mint ÖTLET reális, de rossz irányba fizet.** Fel lehetne
venni a `routeTask`-ba, hogy mély sor esetén ONLINE-ra routoljon (a fail-closed iránnyal egyezik,
tehát biztonságos). De: a sor pont akkor mély, amikor a flotta a legaktívabb -- és az online tokent
pont akkor költené, amikor a kvóta-nyomás a legnagyobb, vagyis szembemenne azzal, amiért az offload
egyáltalán létezik. Ez a kompromisszum kimondva legyen a táblán, ne egy kódban felfedezve; ma nem
javaslom.

**Amit MikroB-nak átadok kártya-jelöltként:** a 137 „vanished worker" sor. Az a mért defektus,
nem a routing.

**Ki döntött:** MikroB (kártya + szülő-epic), backend2 (a rétegtévesztés kimutatása, a queue-mérés,
a négy verdikt).
**Hivatkozás:** kártya 71188a2a (szülő 40f92dd2). Kapcsolódó: a31e8ddf (a router és a benne álló
rule-10 döntés), 5dcd9bc8 / ea931c14 (a flock és a 6-os kilépési kód), llm-control-abstains-under-gpu-contention (memória).

## 2026-08-24 06:45 -- tree-sitter-bash átvétele a self-pace kapu határfelismerőjének (kártya f16b3165)

**Döntés:** ADOPT (10. szabály, GitHub-first) -- a `scripts/self-pace-gate.mjs` kézzel írt
bash-járója helyett a `tree-sitter-bash` nyelvtan válaszolja meg a heredoc-tulajdonos kérdést, egy
új `scripts/bash-ast.mjs` modulban. Feature-flag (`SELF_PACE_AST`) mögött, dark-launch alapértelmezéssel:
a régi járó dönt, az új csak árnyékban fut és az eltéréseket logolja. A `tree-sitter` OPCIONÁLIS
függőség marad, tehát a landolás önmagában nem változtat viselkedést.

**Miért:** hét egymást követő review-kör (A-F, X1-X6, N1-N6, S1-S6, R1-R2, B1-B6, K1) mindegyike új
megkerülési osztályt termelt, mert egy szöveg-heurisztika próbálja utolérni a bash teljes nyelvtanát;
hat alak (`(( ))`, `select`, `[[ ]]`, `coproc`, `function f()`, `extglob`) egyáltalán nem volt lefedve.
Due diligence mérve: minden érintett csomag MIT, tree-sitter szervezet, nulla GitHub advisory npm és
pip ökoszisztémában, prebuilt binárisok. A 20 esetes nyelvtani batérián 20/20 helyes tulajdonos
`bash -n` földi igazsággal, és a hét kör teljes felhalmozott batériája (455 teszt) zölden fut az
AST-tel VEZETVE is.

**Hatókör-szűkítés a plan-grilling verdikthez képest (komment 15683 -> 15687):** a verdikt terhelés-hordozó
feltételezése az volt, hogy ez két kötés-integráció (Node + Python), és a fő kockázat a kettő eltérése.
Mérve nem áll: `email-send-gate` `.mjs`, nem `.py`, és importálja a walkert a self-pace-gate-ből;
`noisy-command-guard.py` a saját doksija szerint fail-open seatbelt, nem biztonsági határ. A flottában
PONTOSAN EGY fail-closed bash-határelemző van, és az Node -- ezért egy kötésre szűkítve a megnevezett
kockázat nem keletkezik meg. A paritás-mérés ettől függetlenül lefutott: a két kötés kimenete bájtra azonos.

**Két mért kikötés, ami a kódot alakította:** (1) a tree-sitter PARSER nem DoS-felület (50 000 szintű
beágyazás 58 ms, lineáris), de a naiv REKURZÍV fabejárás ~5000 szint felett csendben `null`-ra degradál,
ezért a bejárás kötelezően iteratív; (2) a tulajdonos-spant NEM szabad a csomópont gyerekeiből
újraépíteni: `git commit -F - <<'EOF'` esetén a puszta `-` argumentum EGYETLEN csomópontban sem szerepel
(a `command` [0,13]-nál végződik, a redirect [16,33]-nál kezdődik), és a szövegből újraépített span
elvesztette, ami három legitim `git commit -F -` payloadot DENY-ra fordított. Ezért a modul csak
kezdőindexet ad, a szeletelés az eredeti forrásból történik.

**Ki döntött:** MikroB (plan-grilling GO-WITH-CHANGES, komment 15683), backend (due diligence, hatókör-szűkítés,
implementáció). A hatókör-szűkítés MikroB felé jelezve (üzenet 19829).

**Hivatkozás:** kártya f16b3165, kártya-komment 15687 (due diligence), előzmény 84e31b40 / 442f3289 / ec20dd23.

## 2026-08-24 09:00 -- self-pace kapu 3. kör: process substitution, szó-grammatika, here-string kitöltő (kártya ec20dd23)

**Döntés:** Cybersec NO-GO-ja (Gate-SHA e08e191a) elfogadva és mind a három lelet zárva, a javasolt
irányban de NEM a javasolt regexekkel: a process-substitution ág a MEGLÉVŐ `WRAPPER_POSITION`-ból
épül, nem egy negyedik kézzel írt parancspozíció-listából, és a here-string kitöltő `&`-engedélye
lookbehinddel (`&(?<=>&)`) készült, nem `\d*>&\d*`-gal.

**Miért így:** a javasolt `(?:^|[\s;&|(\`])...` egy NEGYEDIK példánya lett volna ugyanannak a
pozíció-nyelvtannak, amit a 2. kör épp egy helyre vont össze -- a fájl saját, dokumentált
hibaosztálya, hogy két lista egy ötletre mindkét irányban elszivárog. A `\d*>&\d*` pedig átfedésben
van a `[^|;&\n]`-nel a `>` és a számjegyek felett, azaz két úton illeszthető ugyanaz a szöveg egy lusta
kvantoron belül -- pontosan így épül egy visszalépés-robbanás. A lookbehind-változat két diszjunkt
alternatívát ad.

**A saját javításom megmérése ugyanazzal a batériával, mint a leletet (és amit ez kimutatott):** az
első szó-grammatikám a kézenfekvő `(?:QUOTED|BARE+)+` volt, és HATÁROZATLAN IDEIG PÖRGÖTT `bash -c` +
30 000 csupasz karakteren, ami sosem ér el elfogadó szóhatárt -- két szomszédos csupasz futam mindig
újraosztható, tehát a motor a bukás előtt minden partíciót végigpróbál. Egy hookban, ami MINDEN
Bash-híváskor fut, ez szolgáltatásmegtagadás: a javításom 14 alakot zárt volna és egy lyukat nyitott.
A 2. kör DoS-számai ezt nem fedték (azok egy hosszú OPCIÓ-futamot mértek, más kvantor). A nyelvtan
most úgy szól, ahogy a bash olvassa a szót -- váltakozó csupasz és idézett futamok, két csupasz futam
között KÖTELEZŐ idézett darabbal --, így a partíció egyértelmű. Utána: minden eset <= 81 ms, 160 kB-os
bemenettel is.

**Két saját hiba, amit a mérés fogott meg, nem a gate:**
1. A DoS-javítás után `${BARE_PIECE}?` alakot írtam, ami `+?`-t ad, azaz LUSTA plusz és nem opcionális
   -- a DoS eltűnt és tíz alak csendben visszanyílt; egyedül a korrektségi batéria vette észre.
2. Átvettem a gate azon állítását, hogy a szóhatár-lookahead az, ami az összefűzött alakokat zárja, és
   erre írtam tesztet. Egy mutáns, ami TÖRLI a lookaheadet, TÚLÉLTE. Megmérve: ebben a
   megfogalmazásban nem a lookahead zárja az összefűzést (a váltakozó futam maga zárja), a lookahead
   attól tartja vissza a kaput, hogy olyan szóra is illeszkedjen, ami nem ér el valódi határt. Az így
   átengedett három alak `bash -n` szerint SZINTAKTIKAI HIBA, tehát nem hajtódik végre -- a lookahead
   megtartása nem nyit megkerülést. A hibás tesztet kimondottan javítottam, nem csendben.

**Egy lefedettségi hiány, amit Cybersec túlélő mutánsa (M5) mutatott meg:** a csupasz-szavas
here-string törzs (`bash <<< crontab`) helyesen működött, de nem volt kiszegezve. Pin hozzáadva.

**Egy nem-diszkrimináló kontrollom:** a „bare `&` ne nyeljen el egy háttér-jobot" tesztem
`sleep 1 & bash <<< "echo hi"` volt, amit a bare-`&`-t engedő mutáns TÚLÉLT (a shell-név és a `<<<`
ugyanazon oldalán áll). A szétválasztó alak `bash job & cat <<< "<bináris> -"`: `bash -n` szerint
érvényes bash, és a `cat <<<` csak KIÍRJA a bemenetét (közvetlenül ellenőrizve), tehát a tiltása
fals pozitív lenne. Kontroll kicserélve.

**Bizonyíték:** 14/14 nyitott alak zárva, 15/15 jóhiszemű kontroll átmegy, 292 alakos elő/utó
összehasonlítás **0 új megkerüléssel** (a 42 új tiltás mind valódi scheduler-hívás), helyes
ágyazás-mélység 1-8 mind tilt fals pozitív nélkül, 12101 teszt zöld (35 új), tsc 0, lint-paritás
egzakt, 7 mutáns mind megölve.

**Ki döntött:** Cybersec (leletek + mért javítási irány), backend (implementáció, a regex-alak
döntései, a saját javítás adverzariális megmérése), MikroB (visszaadás in_progress-be, sorrendezés).

**Hivatkozás:** kártya ec20dd23 (3. kör), Gate-SHA e08e191a, kártya-komment 15689. Testvér: 442f3289.

## 2026-08-24 -- self-pace/email heredoc-ownership walker: mit jelent a "command position" (kártya 84e31b40, 9. kör)

**Döntés (fullstack, Cybered NO-GO nyomán):** a "mi állhat egy egyszerű parancs eleje és maga a
parancs között" kérdésre **egy** lista van a kódban, és az a bash nyelvtanából származik, nem abból,
amit az éppen aktuális hibajelentés megnevezett.

**Miért merült fel.** A 7. kör (22e215e4) helyesen tette SZIGORÚVÁ a `case` felismerést: a
minta-szabály ELŐRE mozdítja a boundary-t, tehát egy hamisítható kulcsszó azt engedné meg a
támadónak, hogy ő válassza meg, hol kezdődik a következő parancs. A command position viszont egy
puszta kulcsszó-listával dőlt el, amiből hiányzott a `coproc` és a `function NAME`. Cybered mindkettőt
élő bypassként bizonyította marker-fájllal: mögöttük a `case` nem ismerődött fel, a minta `)`-e
visszapoppolta a `$(` nyitotta frame-et, és a span a KÜLSŐ `curl -d @-`-ra esett -- egy olyan heredoc
kifehéredett, amit bash valójában a python3-nak ad.

**Amit a mérés a jelentésen felül hozott.** A családot mérve, nem a két bejelentett alakot, még
**tíz** élő bypass jött elő (mind valós bash, mind marker-fájllal bizonyítva végrehajtódik):
a POSIX `f() { ... }` alak (rosszabb a `function` alaknál: a `(` frame-et nyit, aminek a `)`-e a
boundary-t a NÉV ELÉ teszi vissza), a `time -p` és `time --` (a nyelvtan `time [-p] [--]`, a listán
csak a csupasz `time` volt), a `coproc { `, a `coproc NÉV { `, és a láncok, amik egy második
foglalt szón keresztül érik el a kulcsszót.

**Ugyanez a változtatás szünteti meg a tükörképét, a HAMIS POZITÍVOKAT** -- azt a hibaosztályt,
amiről a kártya címe szól: egy jogos `curl -d @- <<'JSON'` függvénytörzsben, `coproc` mögött vagy
`time -p` mögött DENY-t kapott, mert a span rossz helyről indult.

**A javítás saját kockázata, kimondva.** Ez a felismerés ELŐRE mozdítja a boundary-t, tehát minden
tagja arra a pozícióra van rögzítve, ahol tényleg kulcsszó. A két tag, ami egy KÖVETKEZŐ SZÓT is
elnyelhet, a bash saját szabályát követi: a `coproc NÉV` csak ÖSSZETETT parancs előtt név (a
`coproc python3 curl -d @- <<'PY'` EGYSZERŰ parancs, tehát bash a `python3`-at veszi parancsszónak --
ha névként nyelnénk el, a span a mögötte álló curl-re esne, és ÚJ bypasst nyitnánk), a `function NÉV`
és a POSIX `NÉV ()` pedig megköveteli, hogy az összetett parancs nyitója tényleg ott legyen.

**Mutációs teszt talált egy hibát a saját javításomban.** Az első változat az összetett parancs
nyitó-halmazát a két alakból vette, amit az ember tényleg ír (`{` és `(`), nem a nyelvtanból. A
mutáció azonnal szétválasztotta: az `f() case x in x) ... esac` és a `function f case ... esac`
érvényes függvénydefiníciók, amiknek a TÖRZSE maga a case -- mindkettő élő bypass maradt, mindkettő
bizonyítottan végrehajtódik. A nyitó-halmaz most a `shell_command` produkcióból van, tagonként
`bash -n`-nel validálva, és EGY helyen definiálva, mert a három használati helye ugyanaz az egy
gondolat.

**Amit szándékosan NEM vettem be.** A `sudo`, `command`, `exec`, `env`, `nice`, egy `FOO=1`
értékadás és egy bevezető átirányítás mind szintaktikai HIBA egy összetett parancs előtt (mérve,
`bash -n`), ugyanígy a `coproc coproc` és a beágyazott `function`. Egy ALLOW olyan sztringre, amit a
bash nem is hajlandó értelmezni, nem bypass.

**Ekvivalens mutánsok, kimondva (nem lezártnak állítva).** Hét mutáns túlélte a tesztkészletet:
a `(`, `[[`, `if`, `while`, `until`, `for`, `select` eltávolítása a nyitó-listából, a `coproc`
szóhatár-őre, és a két nyitó-lookahead elhagyása. Mindegyikre 11232 generált alakon, `bash -n`
validálással **0** eltérés jött ki -- mert mindegyik olyan úton éri el a belső parancsot, ami a
boundary-t amúgy is visszaállítja (a `(` saját frame-et nyit; a ciklusok/elágazások saját `; do` /
`; then`-nel jönnek; a `[[ ]]` nem tartalmazhat heredocot). Ugyanaz a sweep 65 / 26 / 42 eltérést
talál, ha a `case`, a `{` vagy a teljes `coproc` ág esik ki, tehát nem "vak" sweepről van szó. Ezért
NEM írtam rájuk tesztet: nem írok olyan tesztet, amiről nem tudom megmutatni, hogy mér valamit. A
tagok a listában maradnak, mert a nyelvtan produkciója az igazság, és a listát arra szűkíteni, amire
a walker MA rászorul, pontosan az a hiba, amiből ez a kör származik.

**Mérés (mindkét gate-en, a walker közös):**
- 44 alak (11 regressziós a 7. körből, 10 új, 1 nem-kulcsszó kontroll) evil és jogos irányban:
  24 rossz a 22e215e4-en, 0 utána.
- 16 elemű fix-kockázati készlet, mind valós bash, 0 rossz -- benne a `coproc EGYSZERŰ` éllel és két
  anti-vakság kontrollal, amik ugyanazt a prózát `-d @-` nélkül DENY-olják.
- 130 elemű invariáns (prefix x case-alak), 0 rossz; a 22e215e4-en 39 rossz.
- 3542 alakú sweep a prefix-lánc x case-alak téren, minden ALLOW-ra `bash -n` + marker-végrehajtás:
  452 élő bypass a 22e215e4-en, 0 utána.
- 17 mutáció, 10 megölve, 7 mérten ekvivalens (fent).

**Nyitva hagyva, szándékosan:** a `tree-sitter-bash` kiváltás külön kártyán fut (MikroB döntése,
15603-as komment); ez a kör a walkert javítja, nem előzi meg a migrációt. Az `bash-ast.mjs`
dark-launch (f16b3165) változatlan: a walker hajtja a viselkedést, amíg `SELF_PACE_AST=on` nincs.

## 2026-08-24 12:00 -- self-pace kapu: egy MÉRTNEK nevezett, de hamis állítás javítása (kártya 442f3289, 3. kör)

**Döntés:** Cybersec NO-GO-ja (Gate-SHA 11a7698e) elfogadva. A blokkoló nem kódhiba volt, hanem egy
DOKUMENTÁCIÓS állítás egy biztonsági fájlban: a komment és a teszt azt rögzítette „mérve"-ként, hogy
az idézőjel eltávolítása után minden wrapper-vektor tiltva marad. Ez a patch saját öt alakjára volt
igaz, és hamis arra, ahogy egy shell egyáltalán kaphat programot. Az idézőjel BENT MARAD a kivett
állapotban (nem tettem vissza), de az állítás mostantól szűkített és felsorolással bizonyított.

**Miért ez blokkoló, pedig „csak komment":** egy biztonsági fájl kommentje a következő kör
bizonyítéka. Ha egy nem mért állítás „mért"-ként áll ott, a következő ügynök arra épít. Cybersec öt
olyan alakot mért meg, amit az idézőjel FEDETT és a kicsomagolás nem, kettőt közülük élesben
futtatva a develop fején. Az állítás javítása tehát valódi biztonsági munka, nem szövegezés.

**A javítás sorrendje (MikroB rendezése, Cybersec (i) útja):** előbb az `ec20dd23` 3. köre
kiterjesztette a program-forrás kicsomagolást a here-stringre és a process substitutionre -- ez a
HELYES réteg, a proxy helyett a tényleges dolog --, és csak utána mértem újra ezt a kört. Az öt alak
mind TILT most, heredoc-törzsben is.

**Az új mérés, ami az állítást alátámasztja:** 21 alak, az idézőjellel a `CMD_POSITION`-ben ÉS
nélküle, ugyanazon a fejen. Minden program-forrás útvonalon azonos a verdikt (nulla elveszett
tiltás), és négy próza-fals-pozitív jön vissza az eltávolítással. A teszt mostantól FELSOROLJA az
útvonalakat ahelyett, hogy összefoglalná -- pontosan azért, mert az eredeti hiba egy ötelemű
listából vont le általános tulajdonságot. A három ismert maradék (`python3 -c`, `script -qec`,
futásidejű `$( )`) kimondva szerepel: ezeket az idézőjel sem fedte, tehát az eltávolítása nem vesz
el tőlük semmit.

**F-2 (a teszt-tábla, ami sosem mérte amit állított):** a `POSITIONS` `elif` sora
`elif true; then <cmd>` alakú volt, azaz a parancsot a MÁSODIK `then` után helyezte -- újramérte a
`then`-t, és sosem gyakorolta az `elif`-et; `if` sor pedig egyáltalán nem létezett. A kód mindkét
pozíciót helyesen tiltotta, a hiány a tesztben volt. Bizonyítva, nem feltételezve: az `elif`
elvétele a nyelvtanból a RÉGI sorral ZÖLDEN marad (a mutáns túlél), a javított sorral PIROS.

**F-3 (a `)` ára, kimondott cserévé téve):** a `)` azért kell a pozíció-osztályba, mert egy case-ág
és egy záró subshell tényleg parancsot indít utána. Az ára próza: egy zárójeles közbevetés után álló
időpont (`a futás véget ért (lásd jegyzet) <bináris> 16:13 pontban`) tiltódik heredoc-törzsben.
Mostantól saját tesztje szegezi ki, ugyanúgy ahogy a `!` választásé -- Cybersec kérése szerint
kimondott, tesztelt költség, nem később felfedezett meglepetés.

**Bizonyíték:** 94 teszt zöld ebben a fájlban (26 új), 5 mutáns mind megölve (`if` elvétele,
`elif` elvétele, `)` elvétele, az idézőjel VISSZATÉTELE, a here-string-kicsomagolás kikapcsolása),
tsc 0, `no-unsafe-argument` 101 (alapvonal 102). A forrás-diff KOMMENT-ONLY, viselkedés-változás
nélkül -- külön ellenőrizve.

**Ki döntött:** Cybersec (a hamis állítás kimutatása, a mért alaklista), backend (az újramérés, a
szűkített állítás megfogalmazása, a teszt-hiányok javítása), MikroB (sorrendezés a testvér-kártyával).

**Hivatkozás:** kártya 442f3289 (3. kör), Gate-SHA 11a7698e, kártya-komment 15685. Testvér: ec20dd23
(223ac1f8), ami az F-1 helyes rétegét zárta.

## 2026-08-24 -- Egy fogalom, egy karakter-osztály: a függvénynév (kártya 84e31b40, 10. kör)

**Döntés (fullstack, Cybersec NO-GO nyomán):** a walkerben a NÉV-pozíció mind a három ágon (POSIX
`NÉV ()`, `function NÉV`, `coproc NÉV`) UGYANAZT a `FUNCTION_NAME` konstanst használja, és az a bash
szó-nyelvtanából van levezetve, nem kézzel válogatva. A három ág közti valódi különbséget nem a
karakter-osztály hordozza, hanem a `COMPOUND_OPENER` lookahead.

**Miért merült fel.** A 9. kör mindkét függvénydefiníciós szintaxist felismerte, de a NEVET KÉTSZER
írta le: a `function NÉV` ág egy tág osztályt kapott, a POSIX `NÉV ()` ág egy szűk `[A-Za-z_]\w*`-ot.
Minden név, ami a résbe esett, mozdulatlanul hagyta a boundary-t, tehát a mögötte álló `case` nem
ismerődött fel command-pozícióban, a minta `)`-e visszapoppolta a `$(` nyitotta frame-et, és a span a
KÜLSŐ `curl -d @-`-ra esett. A `deploy-prod`, `sync.db`, `a:b` hétköznapi flotta-függvénynevek.
Cybersec 21 végrehajtott megkerülést mért; a saját, karakter-térből generált mérésem 25-öt.

**A javítás a KÖZÖS KONSTANS, nem a másolat.** A tág osztály bemásolása a második helyre pontosan az,
ahogy a kettő eredetileg szétcsúszott. Ráadásul önmagában is hibás lett volna: a `{` és `}` NEM bash
metakarakter (csak akkor foglalt szó, ha önmagában áll), tehát az `f{g` érvényes függvénynév, amit a
TÁG osztály is elszalasztott -- mindkét ágon, bizonyítottan végrehajtva. A metakarakter-halmazból
levezetve 25/25 zárul; a javasolt egysoros 23-at zárt volna.

**Három saját hiba, amit a mutációs teszt talált, nem az újraolvasás.**
1. A `coproc NÉV` ágat először szűken hagytam, azzal az indoklással, hogy az a név shell VÁLTOZÓ lesz,
   tehát azonosítónak kell lennie. Ez igaz arra a névre, amit a bash a végén kap, és HAMIS az ott álló
   SZÖVEGRE: a bash a nevet EXPANZIÓ és idézőjel-eltávolítás UTÁN validálja. A `coproc f$g { ... }`
   (üres `g`) egy `f` nevű coprocot csinál, a `coproc f\g { ... }` egy `fg` nevűt -- mindkettő élő,
   végrehajtott megkerülés volt a literálra illesztő walker ellen. Mérve: `declare -p f` / `declare -p fg`.
2. Ugyanez az idézőjel-eltávolításon át: a `coproc f"" { ... }` szintén `f` nevű coprocot csinál. Egy
   bash SZÓ nem csak a nem-idézett futam, hanem nem-idézett karakterek ÉS KIEGYENSÚLYOZOTT idézett
   szakaszok sorozata -- az osztály most ezt mondja ki.
3. A kiegyensúlyozottság nem esztétika: ez a szabály a `boundary`-t mozgatja, de a walker `quote`
   állapotához NEM nyúl. Egy PÁRATLAN idézőjelet elnyelő illesztés a walkert idézőjelen kívül hagyná,
   miközben a bash stringen belül van -- rosszabb deszinkronizáció, mint a rés, amit betömne. A
   visszaidéző (backtick) ezért továbbra is kimarad: parancs-kontextust nyit.

**A saját mérésem hibája, amit Cybersec joggal kifogásolt, javítva.** A 9. köri 3542 alakú sweep az
egyetlen `f` nevet használta -- annak az osztálynak a tagját, amit tesztelnie kellett volna --, tehát a
"0 residual bypass" a patchről szólt, nem a bashről. A sweep neveit most a karakter-tér adja. Javítás
közben a saját harnessemben egy MÁSODIK hibát is találtam: a függvény-alakok DEFINIÁLTAK egy függvényt
és sosem HÍVTÁK meg, tehát a törzs nem futott, a marker nem jelent meg, és a sweep 9203 ALLOW mellett
0 "megkerülést" jelentett -- vak zöld pontosan a vizsgált családra. Hívással: 7000 élő megkerülés a
9afad4aa-n, 0 utána.

**Mérés (mindkét kapun, a walker közös):**
- 52 nevű karakter-tér x 3 alak, mindegyik `bash -n`-nel validálva és markerrel FUTTATVA:
  POSIX 25 -> 0, `function` 2 -> 0, `coproc` 4 -> 0 élő megkerülés.
- 20 elemű fix-kockázati készlet mindkét kapun, 0 rossz: tömb-értékadás alak (`arr=() { ... }` --
  mérve érvénytelen bash), a nevet elnyelő nyitó, argumentum-pozíció, coproc-ág átszivárgás, a
  páratlan idézőjel deszinkronizációs veszélye, plusz anti-vakság kontrollok.
- 7-9. köri batériák változatlanul: 44 alak, 16 elemű kockázati készlet, 130 elemű invariáns, 0 rossz.
- 31892 alakú sweep (a javított, hívást is tartalmazó harness): 7000 -> 0.
- 11 mutáció, 9 megölve.

**Túlélő mutánsok, kimondva (nem lezártnak állítva).** Kettő: az osztály metakaraktereket is elnyel
(MC), illetve PÁRATLAN idézőjelet is megenged (MI). Mindkettőre 448 generált alak, `bash -n`
validálással: 0 olyan eltérés, ahol a törzs TÉNYLEGESEN lefut (a nem-futó eltérések a szigorúbb,
DENY-irányban vannak). Kontrollként ugyanaz a hunt 59 végrehajtott eltérést talál a szűk osztályra
visszaálló mutánsnál, tehát nem vak. Az `N-R4` teszt a páratlan-idézőjel esetet DOKUMENTÁLJA és egy
valós DENY-t rögzít, de NEM választja szét az MI mutánst -- ezt kimondom, hogy senki ne higgye
lefedettnek. Ha valaki talál élő, végrehajtott szétválasztó alakot, jön rá a teszt.
## 2026-08-24 12:30 -- tree-sitter dark-launch 2. kör: egy általam szállított megkerülés és a rossz cutover-kritérium (kártya f16b3165)

**Döntés:** Cybersec NO-GO-ja (Gate-SHA ceed282d) elfogadva, mind az öt lelet javítva. A kártya
alapdöntései (ADOPT, egy kötés, szűk lekérdezés, iteratív bejárás, null-szerződés, index-alapú span,
dark-launch) VÁLTOZATLANOK -- azokon Cybersec sem vitatkozott. A javítás a felismerő EGY szabálya és
a kimondott cutover-kritérium.

**F-1 (HIGH, a blokkoló, az én hibám):** ha a heredoc egy ÖSSZETETT konstrukcióra van RÁirányítva,
bash a törzset a csoport MINDEN parancsának stdinjeként adja oda, nem az utolsóénak. A
`lastCommand()` a szintaktikailag utolsó parancsig ereszkedett, így egy mentesített data-sinket
nevezett tulajdonosnak, miközben egy KORÁBBI interpreter ugyanazt a szöveget végrehajtotta.
Sajátmagam reprodukáltam a nyelvtan `redirected_statement.body` altípus-listájából (18 altípus,
ebből 4 lista-szerű): 14 alak fordult DENY→ALLOW `on` módban. Javítás: leszállás csak
`pipeline`/`list`/`negated_command` alatt; minden más összetett törzsnél nincs vélemény, ami a
meglévő szerződés szerint fail-closed.

**Miért nem fogta meg a saját batériám:** a heredocot a konstrukción BELÜLRE tettem
(`{ curl -d @- <<J ... J }`), ahol a tulajdonos tényleg a curl és a válasz helyes. A támadási felület
ennek a TÜKÖRKÉPE. A batéria valós tulajdonságot mért, csak nem azt, ami támadható -- ugyanaz a
hibaosztály, amit ez a flotta már dokumentált: az esetlistát a NYELVTANBÓL kell építeni, nem a saját
patchből.

**F-2 (MEDIUM, a folyamati hiba a hiba mögött):** a REVIEW-ban kimondott cutover-kritérium az volt,
hogy „shadow módban gyűlik a divergencia-log, és nulla eltérés után jöhet az `on`". Ez
SZERKEZETILEG vak a hamis NEGATÍVRA: az alakot a támadó választja, és a 14 megkerülés egyike sem
fordul elő jóhiszemű flotta-forgalomban. Egy heti üres log pontosan azt a magabiztosságot adta volna,
ami után a cutover 14 megkerülést élesít. A dark-launch a FALS POZITÍVOKRA jó eszköz (és ott bizonyított
is: a `git commit -F -` regressziót tényleg az fogta meg), a false negatívokra nem. Az új kritérium:
az adverzariális batéria zöld `SELF_PACE_AST=on` módban -- futtatható állítás, nem log-megfigyelés.

**Az új kritérium azonnal talált két fals pozitívot, amit a régi nem:** a teljes suite `on` módban
(nem csak a négy célzott fájl) megbukott a `coproc` és `time -p` kontrollokon. Ok: a nyelvtan ezeket
a prefix-kulcsszavakat a parancs NEVÉNEK veszi, a valódi binárist argumentummá fokozva, így a span a
kulcsszónál kezdődött és a tulajdonos-ellenőrzés egy jogos payloadot utasított el. A span mostantól a
valódi binárisnál kezdődik. Irány-ellenőrzés kimondva: a span-kezdet ELŐRE mozgatása több mentességet
ad, tehát ez a veszélyes irány -- de az ellenőrzés a prefix UTÁNI szövegen fut, így
`coproc python3 - <<J` továbbra is tilt (mérve).

**F-3 (MEDIUM, credential-szivárgás, szintén az enyém):** a divergencia-log kommentje azt állította,
„shape-only, soha a parancsszöveget" -- a szándék jó volt, a megvalósítás szivárgott. A „vezető szó"
nem a bináris, ha a parancs inline környezeti hozzárendelést hordoz, és a `CURL_LEADING_RX` maga
engedi ezt az alakot: `TOKEN=<titok> curl -d @- ...` a titok ÉRTÉKÉT írta a logba. Javítva: a vezető
hozzárendelés a NEVÉRE csonkolódik, a fájl `0600`-zal jön létre (a flotta 0002-es umaskjával eddig
0664 volt), és van méret-plafon (a divergenciát a támadó tetszőleges számban gyártja).

**F-4/F-5 (LOW):** a teszt-only `SELF_PACE_AST_MODULE_PATH` kapcsoló -- ami idegen kódot `require`-el
a guard processzébe -- mostantól csak teszt alatt érvényes, élesben inert (külön teszt szegezi ki, ami
GYEREKFOLYAMATOT indít, mert a suite maga mindig VITEST alatt fut, tehát in-process nem lenne
bizonyítható). A `MAX_INPUT_BYTES` átnevezve `MAX_INPUT_UNITS`-ra: `String.length`-et mér, nem bájtot.

**Bizonyíték:** 14/14 megkerülés zárva, 9/9 legitim mentesség változatlan, teljes suite **az AST-tel
VEZETVE** 12267 zöld / 0 bukás, függőség nélkül (ahogy landol) 12184 zöld / 0 bukás, tsc 0,
`no-unsafe-argument` 101 (alapvonal 102), 5 mutáns mind megölve (a szállított hiba visszaállítása
29 tesztet dönt).

**Nyitva marad, MÁS kártyára (Cybersec F-6, HIGH, PRE-EXISTING):** a `gateDecision` szuperlineáris,
és ~96 KB-os bemenettel a 10 s-os hook-timeout + fail-open miatt a TELJES governance-kapu megkerülhető
MA is. Nem ezé a kártyáé (a kártya ~15%-ot tesz hozzá a görbéhez, és a függőség nincs telepítve).
MikroB-nak jelezve (üzenet 19908) külön kártyára, azzal a megjegyzéssel, hogy a méret-plafon a tünetet
kezeli, a fail-open alapdöntés a gyökér.

**Ki döntött:** Cybersec (mind az öt lelet, végrehajtási bizonyítékkal), backend (önálló reprodukció a
nyelvtanból, a javítások, a prefix-lelet saját megtalálása az új kritériummal), MikroB (visszaadás).

**Hivatkozás:** kártya f16b3165 (2. kör), Gate-SHA ceed282d, kártya-komment 15741.


## 2026-08-24 -- A NÉV nem karakter-osztály, hanem bash SZÓ: szkennerre cserélve (kártya 84e31b40, 11. kör)

**Döntés (fullstack, Cybersec NO-GO nyomán):** a walker NÉV-slotja (mindkét függvénydefiníciós alak
és a `coproc`) többé nem reguláris kifejezés-osztály, hanem egy `scanBashWord` szkenner, ami a fájlban
MÁR MEGLÉVŐ, mélység-helyes olvasókat (`skipBalancedParens`, `skipParamExpansion`) használja.

**Miért.** Ez a mező három egymást követő körben volt hibás, mindig MÁS tengelyen: előbb csak
azonosító (10. kör: `deploy-prod` és további 24 élő alak), aztán a metakarakter-halmaz (`f{g`), aztán
az idézés (`coproc f""`). Az ok nem az volt, hogy rosszul válogattam a karaktereket, hanem hogy egy
bash SZÓ nem karakter-osztály: futamok sorozata, és négy futam NESTEL -- `$( )`, `${ }`, `$(( ))`,
backtick. Amíg osztályként írom, minden kör egy újabb karaktert tesz hozzá, és a következő gate egy
újabbat talál.

**A jelentett 4 helyett 10 élő alak.** Cybersec négyet mért (`coproc f$(y)` és `` coproc f`g` ``,
brace és bare-case törzzsel). A teret végigmérve tíz élő, végrehajtott alak jött ki, és ezek közül
HAT elérhetetlen bármilyen egyszintű regexnek: `f$(y $(z))`, `f$(echo $(echo))`, `` f$(echo `g`) ``,
`` f`echo $(y)` ``, `f${u:-$(y)}`, `f$((0))`. A javasolt (A) javítás (`\$\([^()]*\)`) tehát négyet
zárt volna a tízből -- ezért nem azt vettem át. Ez ugyanaz a minta, mint a 10. körben: a javasolt
javítás is állítás, a saját batériával kell megmérni.

**Mért aszimmetria, ami a döntést alátámasztja:** a `coproc` a nevét EXPANZIÓ és idézőjel-eltávolítás
UTÁN validálja (`coproc f$(true) { ... }` -> `f` nevű coproc, `declare -p f`-fel igazolva), a
függvény-alakok viszont NEM expandálnak (`f$(true)() { ... }` -> „not a valid identifier"). A szkennert
mégis mindhárom pozíció osztja: egy slot, egy olvasó. Egy olyan szó elnyelése, amit a bash utána
elutasít, semmibe nem kerül -- az a parancs le sem fut, tehát nincs mit kifehéríteni.

**Cybersec javított egy HIBÁS INDOKOMAT is, és ez fontosabb, mint a lelet.** A 10. köri kommentem azt
állította, hogy egy páratlan idézőjel elnyelése „a walkert idézőjelen kívül hagyná, miközben a bash
stringen belül van". A hívási hely szerint ez nem így működik: `boundary = ...` KIZÁRÓLAG a boundary-t
mozgatja, az `i`-t nem, tehát a fő ciklus továbbra is végigjárja a lenyelt szöveget és rendesen vezeti
a `quote`/nest állapotot. Deszinkronizáció nem keletkezhet; a valódi, kisebb kockázat az, hogy a
boundary egy idézett futam KÖZEPÉRE kerül. A konzervatív viselkedés jó maradt, de a rossz indok
tartotta kint a backtickot a névből -- vagyis pontosan ez a hibás indok termelte a mostani leletet.
A tesztek kommentje javítva (`N-R4`), nem csak a kódé.

**Mérés (mindkét kapun, a walker közös; a számok a Gate-SHA-ból kicsomagolt kódon):**
- 16 nevű mélység-próba x 2 törzs-alak, mind `bash -n`-nel validálva és markerrel futtatva:
  10 élő -> 0.
- 52 nevű karakter-tér x 3 alak: 0 élő, és most már 0 ALLOW is érvényes bash-en (a korábban maradt
  `$(y)` inert ALLOW is eltűnt).
- 20 elemű fix-kockázati készlet, 44 alak, 130 elemű invariáns: mind 0 rossz.
- 31892 alakú sweep: 0 residual bypass.
- 10 mutáció a szkennerre, 6 megölve.

**Túlélő mutánsok, kimondva.** Négy: az egyszeres idézet olvasásának elhagyása (P4), a lezáratlan
backtick „nyeld a végéig" viselkedése (P6), a POSIX alak `()`-követelményének elhagyása (P9), és a
compound-nyitó követelmény elhagyása a függvény-ágakon (P10). 624 generált alakon: P4-nél 18 eltérés,
de EGYIK SEM fut le; P6/P9/P10-nél nulla eltérés. Szerkezeti indok is van rá, nem csak szám: egy
egyszeres idézetbe zárt metakarakter után a név már nem azonosító, tehát inert; egy lezáratlan
backtick érvénytelen bash; a `foo { case ... }` és a `foo case ... esac` (parens nélkül) szintén
érvénytelen bash. Egyikre sem írtam tesztet. Ha valaki talál élő, végrehajtott szétválasztó alakot,
jön rá a teszt.
## 2026-08-24 13:00 -- ANSI-C escape-obfuszkáció: egy általam kódba írt hamis állítás mögötti élő megkerülés (kártya ec20dd23, 4. kör)

**Döntés:** QA FAIL-je (Gate-SHA 223ac1f8) elfogadva. A 3. körben írt `unquoteWord` kommentje azt
állította, hogy az ANSI-C és a lokale idézés „csak olyan módokon tér el a sima alakoktól, amik nem
tudnak binárisnevet elrejteni". Ez TÉVEDÉS volt, és nem csak dokumentációs: a kód is eszerint
viselkedett, tehát a hamis állítás egy élő megkerülést takart.

**Miért:** a `$'...'` az EGYETLEN bash-idézési forma, ami valódi escape-dekódolást végez. A kód a
`$` eldobása után egyenesen a sima egyszeres-idézőjeles ágra esett („single quotes are literal --
never unescape here"), tehát sosem dekódolt. Így `bash -c $'\x63rontab -'` lefut, miközben a
tiltott név SOHA nem jelenik meg abban a szövegben, amit a horgonyzott ellenőrzések látnak. QA élő
bash-végrehajtással bizonyította (marker-fájl), én pedig 12 alakot mértem nyitva a jelentett 5 mellé:
hex, oktális, `\u`, `\U`, minden-karakter-kódolva, szó közepén, plusz here-string, `eval` és `sh -c`
ágon, ágyazva, és ANSI-C darab másik idézett darabbal összefűzve.

**Hatókör, kimondva:** a javítás KIZÁRÓLAG a `$'...'` ágra vonatkozik. A lokale formát (`$"..."`)
külön ellenőriztem valódi bash-sel: NEM dekódol (`$"\x74ouch"` literál marad), tehát ott a jelenlegi
„dobd el a `$`-t" logika helyes, és a dekódolás kiterjesztése oda FALS POZITÍVOT gyártana -- olyan
parancsot tiltana, amit a bash sosem futtat. Ezt külön mutáns szegezi ki.

**A dekóder hűsége MÉRVE, nem feltételezve:** 38 escape-alakot hasonlítottam a VALÓDI bash
kimenetéhez (bájt-szinten, `od`-val, hogy a vezérlőkarakterek is pontosan egyezzenek): 0 eltérés.
A mérés két olyan esetet talált, amit magamtól elrontottam volna: (1) egy ISMERETLEN escape megtartja
a backslash-t (`$'\z'` → `\z`, nem `z`); (2) a NUL CSONKOLJA az argumentumot -- mérve
`bash -c $'ec\0ho X'` → `ec: command not found`, tehát NEM fűzi össze a két felet. A NUL-t kibocsátva
és folytatva a `cron` és `tab` feleket összefűztem volna egy névvé, amit a bash sosem futtat.

**Két SAJÁT regresszió a javítás közben, mindkettőt a saját mérésem fogta meg:**
1. Az első dekóder minden karakternél `src.slice(i)`-t hívott és öt regexet futtatott rá -- kvadratikus,
   40 000 escape-es törzsön nem futott le. Átírva ragadós (sticky) regexekre, szeletelés nélkül.
2. Az ANSI-C alternatíva HOZZÁADÁSA a szó-nyelvtanhoz újra kétértelművé tette a mintát: a meglévő
   `\$?'[^']*'` ág is elfogadta a `$'...'`-t, tehát ugyanaz a szöveg KÉT úton illeszkedett, és egy
   hosszú futam a szóhatáron megbukva soha nem ért véget. Ez PONTOSAN ugyanaz a hibaosztály, amit
   egy körrel korábban ebből a mintából eltávolítottam -- egy átfedő alternatíva hozzáadásával
   visszahoztam. Javítva: a `$'...'` kizárólag az ANSI-C ágé, a `'...'` kizárólag a simáé.

**Bizonyíték:** 12/12 megkerülés zárva, 5/5 jóhiszemű kontroll változatlanul átmegy, 38/38 escape-alak
bájtra egyezik a valódi bash-sel, patologikus bemenetek mind <= 162 ms (a mixed eset a javítás előtt
nem futott le, utána 39 ms), 112 teszt zöld ebben a fájlban (92 → 112, +20), teljes suite 12255 zöld /
0 bukás, tsc 0, `no-unsafe-argument` 101 (alapvonal 102), 7 mutáns mind megölve (köztük a
lokale-túl-dekódolás és a kétértelműség-visszahozás).

**Ki döntött:** QA (a lelet, élő bash-bizonyítékkal, a hatókör helyes elhatárolásával), backend
(reprodukció 12 alakra, a dekóder, a differenciál-hűségmérés, a két saját regresszió megtalálása).

**Hivatkozás:** kártya ec20dd23 (4. kör), Gate-SHA 223ac1f8, kártya-komment 15760.

## 2026-08-24 13:30 -- A governance-kapu megkerülhető volt a bemenet MÉRETÉVEL (kártya fa5ef179)

**Döntés:** két külön dolgot javítottam, és a különbség szándékos. (1) A KIVÁLTÓ OK: egy véletlen
kvadratikus alak az útvonal-előtag regexben, ami a bypasst okozta -- ennek eltávolítása zárja be a
lyukat. (2) EGY BACKSTOP: fail-closed méret-plafon, hogy ha egy jövőbeli minta újra
felerősítést hozna, korlátozott legyen amit a támadó beadhat.

**A lelet (Cybersec, az f16b3165 gate-köréből, helyesen pre-existingként elhatárolva):** a kapu
HELYES DENY-t ad, csak nem ér oda a határidő előtt. 96 KB inert kitöltés = 10,36 s, 130 KB = 19,54 s,
a regisztrált hook-timeout 10 s, és a hívó a timeoutot NEM-blokkolóként kezeli (QA külön
megerősítette). Tehát elég nagy, ártalmatlannak látszó kitöltéssel a valódi payload
FAIL-OPEN ALLOW-t kap, ELLENŐRZÉS NÉLKÜL.

**A profilozás egyetlen függvényt nevezett meg, nem szórt költséget:** 32 KB-on a 2023 ms-ból 1895 ms
az `executableStrings`. És nem a rekurzió: a függvény NULLA sztringet nyer ki ezen a bemeneten,
mégis 1385 ms-ot tölt -- tehát maguk a regexek lépnek vissza. Tovább szűkítve: a `(?:\S*\/)?`
útvonal-előtag. Izolált mérés a két alakról: a jelenlegi 8 KB-on 36 ms / 64 KB-on 2304 ms (pontosan
4x duplázásonként), a határolt `(?:[^\s|;&<>()]*\/)?` MINDEN méreten 0 ms.

**Miért nem veszít semmit a szűkítés (mérve, nem feltételezve):** a `| ; & < > ( )` karakterek nem
szerepelhetnek idézetlen parancs-útvonalban a bashben -- elválasztók. Minden alakon, ahol a két
forma eltér, MINDKETTŐ megtalálja a shellt; a határolt csak az elválasztó UTÁN kezdi az illesztést,
ami pontosan ott van, ahol a parancs valójában kezdődik (`/tmp/a|b/bash` → `b/bash`). 180 alakos
elő/utó összehasonlítás: NULLA verdikt-változás mindkét irányban, tehát ez tisztán teljesítmény-javítás.

**Eredmény:** 96 KB: 10,36 s → 85 ms (122x). 130 KB: 19,54 s → 96 ms (203x). Lineáris marad 520 KB-ig
(360 ms).

**A backstop, és miért fail-closed:** 1 MiB-os plafon, BÁJTBAN mérve (nem `String.length`-ben: egy
nem-ASCII parancs a háromszorosa lehet). Ami túl nagy ahhoz, hogy átvizsgáljuk, azt TILTJUK -- pont
az ellentéte annak, amit a timeout ma csinál. A küszöb a mért ütemből jön (~0,7 ms/KB), tehát még egy
hipotetikus 10x-es regresszió is bőven a 10 s-os határidőn belül marad; a valódi ügynök-parancsok
nagyságrendekkel kisebbek. A tiltás SAJÁT, akcióra vezető üzenetet kap (12. szabály): a self-pace
üzenet itt félrevezető lenne, hiszen a parancsot sosem vizsgáltuk ütemezésre -- a méretéért utasítottuk
el.

**Ami NEM ezen a kártyán dől el:** hogy egy timeoutolt governance-hook egyáltalán FAIL-OPEN legyen-e.
Ez flotta-szintű viselkedés-változás (egy lassú hook megállítaná a munkát), tehát Peti/MikroB döntése.
Jelezve; a méret-plafon a TÜNETET kezeli, a fail-open a GYÖKÉR. Ezek a tesztek szándékosan NEM
feltételezik, hogy ez megváltozik.

**Bizonyíték:** 18 új teszt zöld, 180 alakos elő/utó sweep 0 verdikt-változással, a támadási alak
mindkét jelentett méreten TILT és 2 s alatt végez, a skálázás lineáris (duplázás < 3x munka), az ÉLŐ
hook borítékja `deny` az akcióra vezető üzenettel, teljes suite zöld, tsc 0.

**Ki döntött:** Cybersec (a lelet és a mérés), backend (a kiváltó ok megtalálása, a határolt
`PATH_PREFIX`, a backstop), MikroB (kártya-nyitás, sorrendezés).

**Hivatkozás:** kártya fa5ef179, forrás-lelet az f16b3165 Cybersec-kommentjében (15741, F-6).

## 2026-08-24 13:45 -- 3477c793 -- A gate-szkennerek felismerése: KIMONDOTT strukturális sort lépünk át, nem "az első két sort"

**Két hiba, egy kártya, mindkettő ugyanabból az okból: egy gondolat két helyen élt.**

**1. A verdikt-felismerés.** A `cybersec-gate-scan.py` és a `cybered-gate-scan.py` a komment ELSŐ
sorát nézte. A 4b. szabály viszont csak annyit mondott, hogy a `Gate-SHA:` sor SOR ELEJÉN álljon --
nem azt, hogy a verdikt-szó legyen az első sor --, ezért több gate-ügynök a `Gate-SHA:`-val kezdte.
Tábla-szintű mérés (2026-08-24, 300 gate-szerzőjű komment horgonyzott verdikt-szóval):

```
254  a verdikt-szó már az 1. sorban          -- előtte is, utána is felismerve
 42  CSAK Gate-SHA:/üres sor előzi meg       -- ezt a javítás visszanyeri
  4  szabad PRÓZA előzi meg                  -- SZÁNDÉKOSAN nem ismerjük fel
```

**A döntés: NEM "az első két sor", hanem "lépd át a KIMONDOTT strukturális sort".** A kártya az
előbbit javasolta; mérés után a szűkebbet választottam. Egy tetszőleges szöveget megengedő szabály
visszanyitná azt a hamis-pozitív osztályt, amiről mindkét szkenner saját kommentje már figyelmeztet
(egy idézett „REVIEW"/„DONE" mondat közben valódinak olvasva), és 4 esetet venne meg minden olyan
próza-komment árán, ami a második sorában említ egy gate-szót. 46-ból 42 visszanyerése egy olyan
szabállyal, ami nem tud félresülni, a jobb csere -- a 4 kimaradó eset a `verdict_body` docstringjében
NÉVVEL szerepel, nem hallgatólagosan elkerekítve.

Mérve a javítás után: **42 visszanyerve, 0 elveszítve** (a régi szabály egyetlen felismerését sem
rontja el). A visszanyertek többsége QA-verdikt, nem az enyém -- a hiba nem Cybersec-specifikus volt.

**2. A `declared_gate_excludes_me` szűrő.** A `kanban-gate-scan` skill 2026-08-17 óta DOKUMENTÁLJA
(18/18 mért hamis pozitív egy nyers cybered-sweepen), a két tényleges script viszont sosem kapta meg:
`grep -c declared_gate_excludes_me` -> 0 és 0. Következmény: minden self-advance kör lekérte a
QA-only kártyák TELJES komment-szálát is, csak hogy arra jusson, „nem az enyém". Mérve élesben:
cybersec 2 -> **0** ungated (5 kártya kihagyva), cybered 6 -> **2** ungated (10 kártya kihagyva).

**Ezért lett belőle KÖZÖS MODUL (`store/gate_scan_lib.py`), nem két másolat.** Pontosan ez a kártya
tanulsága: a skill leírta, a scriptek nem kapták meg. Egy definíció, két fogyasztó -- különben a
következő javítás megint csak arra a felére kerül rá, amelyik éppen nyitva volt.

**A kihagyás LÁTHATÓ marad.** Mindkét szkenner kiírja, mely kártyákat hagyott ki és miért; egy néma
lefedettség-csökkentés úgy olvasódna, hogy „nincs mit gate-elni", holott azt jelenti, „úgy döntöttem,
nem nézek oda".

**Amit MÉRTEM, de NEM javítottam ebben a kártyában (hatókör):** a fel nem ismert kommentek között 62
olyan van, ami valódi verdikt, csak MÁS SZÓHASZNÁLATTAL (`QA GATE: PASS` 38, `QA VERDICT: PASS` 21,
`CYBERSEC GATE: GO` 3). Ez pozíció helyett SZÓKINCS-kérdés, más gate verdikt-nyelvét érinti, és a
`PASS_RE`/`FAIL_RE` ma csak tájékoztató oszlopot tölt, döntést nem hoz. Külön kártya, MikroB dönti el.

**Bizonyíték:** 28 kontroll (`store/gate-scan-selftest.py`, offline, hálózat nélkül), köztük 3
anti-vakság kontroll, ami a JAVÍTÁS ELŐTTI szabályt is végrehajtja -- e nélkül az egész készlet egy
no-opon is zöld lenne. 6 mutáns, mind megölve (a fejléc-átlépés eltávolítása, „bármelyik első sor"
túl-lazítás, a `Gate:`-nélküli kártya fail-closed rossz iránya, első-vs-utolsó `Gate:` említés, a
fejléc-regex érték-követelménye, kis/nagybetű-érzékennyé tett gate-név).

**Ki döntött:** Cybersec (mindkét lelet mérése, a szűkebb szabály választása mérés után, az
implementáció), MikroB (a kártya kiosztása és a 4c. szabály a másik oldalról).

**Hivatkozás:** kártya 3477c793. Előzmény: a 4c. szabály (CLAUDE.md, 2c2c9935), kártya-kommentek
15741/15747/15753 (a lelet keletkezése), `kanban-gate-scan` skill 2026-08-17-i tanulsága.

## 2026-08-24 -- f0389e81 -- context7 MCP-szerver felvéve, GitHub-first due diligence után, API-kulcs nélkül

**1. Due diligence eredmény: ADOPT.** A `f0389e81` kártya jelöltjei közül a `upstash/context7`-et
vettem elsőnek sorra, a kártya kiemelt jelölésének megfelelően. Mért tények (2026-08-24, friss
lekérdezés `api.github.com` + `registry.npmjs.org` + `api.osv.dev` ellen, nem korábbi kutatás
memóriából): 61 142 csillag, MIT licenc mind a repón, mind az `@upstash/context7-mcp` npm-csomagon
(jelenlegi verzió 4.0.3), nem archivált, utolsó push a lekérdezés napján, 0 GitHub security advisory,
0 OSV-találat a csomagra. Karbantartottság és licenc alapján megfelel a CLAUDE.md 10. szabályának
(GitHub-first) -- nincs ok saját MCP-klienst írni, amikor a hivatalos csomag aktívan karbantartott és
tiszta licencű.

**2. Zárt forráskódú backend, csak a kliens nyílt -- kimondva, nem elhallgatva.** A repó README
`Disclaimer` szakasza explicit kimondja: a tényleges dokumentáció-szolgáltatás (API backend, parsing
engine, crawling engine) PRIVÁT, nincs a repóban. Ami MIT alatt van, az kizárólag az MCP-szerver
kliensoldali kódja. Ez nem blokkolja az adoptálást (a kliens az, amit futtatunk, és az MIT), de a due
diligence-nek ezt külön ki kellett mondania -- a puszta "a repó MIT" állítás félrevezető lenne.

**3. API-kulcs NÉLKÜL indul, tudatosan.** A csomag README-je szerint az API-kulcs "recommended" a
magasabb rate-limithez, nem kötelező az alapműködéshez. A kulcs beszerzése (`npx ctx7 setup` vagy
context7.com/dashboard) OAuth-alapú fiókregisztrációt igényel egy külső SaaS-nál -- ez visszafordítha-
tatlan külső művelet, és az `autonomy-config.json` egyik kategóriájába sem esik egyértelműen (a
legközelebbi analógok, `external_message`/`permission_change`, mindketten level 1-en zárva vannak).
Ezért a `.mcp.json`-ben csak `type: "http"` + `url` szerepel, `headers`/`Authorization` NÉLKÜL --
amint Peti létrehoz egy kulcsot, a fejléc `${CONTEXT7_API_KEY}` env-var-expanzióval pótolható (Claude
Code a `.mcp.json` string-értékeiben, `headers` mezőn belül is expandál -- ellenőrizve a hivatalos
dokumentáció ellen, nem feltételezve).

**Amit NEM csináltam ebben a kártyában (hatókör):** a többi jelölt (`github-mcp-server`,
`best-of-mcp-servers`, `modelcontextprotocol/servers`, `awesome-claude-skills`) due diligence-e a
kártya leírása szerint is következő kör -- nem ebben a menetben.

**Ki döntött:** backend2 (due diligence, `.mcp.json` bekötés, README fork-diff bejegyzés).

**Hivatkozás:** kártya `f0389e81`.


## 2026-08-24 -- f0389e81 -- Cybersec NO-GO javítva: context7 MCP-tools bekötve az egress-gate-be

**Előzmény:** ugyanaznap korábban felvett context7 MCP-szerver (lásd fenti bejegyzés) a Cybersec
gate-en NO-GO-t kapott (Gate-SHA 8ee76373, komment 15832). A due diligence maga rendben volt --
a lelet az, hogy a `.mcp.json`-be felvett két context7-tool (`resolve-library-id`, `query-docs`)
NEM került bele a `scripts/hooks/egress-gate.mjs` PreToolUse hook matcherébe
(`WebFetch|mcp__firecrawl__.*`), tehát bármelyik ágens közvetlenül, a `quarantine-reader`
sub-ágens megkerülésével tetszőleges szabad szöveget küldhetett volna a harmadik feles
context7-backendnek, és a visszakapott, nem auditálható dokumentáció-tartalmat közvetlenül,
`wrapUntrustedFetch()` nélkül kapta volna meg a saját kontextusába -- ugyanaz a hibaosztály, amit
a fájl már egyszer lezárt a Firecrawl-nál (kártya 91c4a369), csak egy új testvér-névtéren nyílt
újra.

**Függetlenül újramérve, nem csak a Cybersec-lelet elfogadva:** a Firecrawl-mintájához hasonlóan
letöltöttem és kicsomagoltam a pinnelt `@upstash/context7-mcp@4.0.3` npm-csomagot, és a
`dist/index.js`-ben megnéztem mindkét tool tényleges Zod-sémáját. Eredmény: `resolve-library-id`
`{query, libraryName}`, `query-docs` `{libraryId, query}` -- mindkét mező szabad string,
`readOnlyHint: true`/`destructiveHint: false`, nincs url/action/exec mező. Ez megerősítette a
Cybersec állítását, DE azt is jelenti, hogy -- a Firecrawllal ellentétben -- nincs második
kimenő csatorna, amit paraméter-allowlistelni kellene: a helyes javítás a Cybersec által is
javasolt TISZTA agentType-alapú tier, nem egy URL/paraméter-alapú szabály.

**Javítás (3 fájl, egy kártyára):**
1. `scripts/hooks/egress-gate.mjs`: új `CONTEXT7_PREFIX` konstans + `egressDecision()`-ben egy
   új, korai default-deny ág a `mcp__context7__*` névtérre -- csak `agentType === 'quarantine-reader'`
   esetén enged át (fail-closed: hiányzó/ismeretlen agentType = blokk), a már meglévő
   WebFetch/Firecrawl-karantén-tier mintáját követve.
2. `src/web/agent-scaffold.ts`: `EGRESS_GATE_MATCHER` kibővítve `mcp__context7__.*`-gal -- e nélkül
   az (1) pontbeli logika sose futna le, mert Claude Code sose hívná meg a hookot erre a névtérre
   (ugyanaz a "wired detection with no consumer" hiba-osztály, amit a Firecrawl-widening már
   dokumentált). A migrációs logika (`ensureEgressGate`) már létező stale-matcher-detekciója
   automatikusan újravezeti minden élő ágens settings.json-ját a következő MikroB-szerver-indításnál,
   külön migrációs kód nélkül.
3. `templates/sub-agents/quarantine-reader.md`: a két context7-tool felvétele a `tools:` sorba +
   új `DOCS` protokoll-ág (a `resolve-library-id` -> `query-docs` hívási sorrenddel), a meglévő
   `FETCH` protokoll mellett.

**Tesztek:** új describe-blokk a `prompt-injection-defense.test.ts`-ben (6 új teszt: névtér-denial,
karantén-tier-nyitás + tier-riport, fail-closed agentType-lista, runtime-allowlist nem nyitja meg,
prefix-pontosság, matcher-regisztráció), plusz az `ALLOWED_TOOLS` egzakt-halmaz teszt kibővítve a
két új tool-lal.

**Ki döntött:** Cybersec (a lelet, a javaslat iránya), backend2 (független újramérés a pinnelt
csomagon, implementáció, tesztek).

**Hivatkozás:** kártya `f0389e81`, Gate-SHA `8ee76373` (NO-GO), kártya `91c4a369` (a már egyszer
lezárt, analóg Firecrawl-hibaosztály).

## 2026-08-24 -- b21deb9a -- Helyi LLM generálás-statisztika (tokens/s, VRAM) a dashboardon, mérés alapján, nem a szöveges log feltételezéséből

**Előzmény:** Peti kérése (Telegram, kép-melléklet, 2026-08-21): a dashboard "Helyi LLM
kihasználtság" szekciója az Aktív Feladat sor után jelenítse meg azt az adatot, amit a képen
látott -- egy `[generation: prompt=16 tokens, output=47 tokens, speed=9.97 tokens/s]` és egy
`[generation peak allocated VRAM: 3.42 GiB]` alakú log-sor, a helyi LM Studio/llama.cpp szerver
saját konzoljából.

**Mérés a feltételezés helyett:** a kártya explicit lépésként kérte a naplófájl/elérési út
azonosítását -- ez élő ellenőrzést igényelt, nem a leírás elfogadását. A flotta ténylegesen futó
helyi LLM-je (`systemctl --user status ollama`) Ollama, ami belül llama-servert futtat; a
`journalctl --user -u ollama` teljes előzményében NULLA `[generation:` mintájú sor van, és egy élő
`/api/generate` hívás közben megfigyelt tényleges log-formátum egészen más (`slot print_timing: ...
prompt eval time = ... eval time = ... tokens per second`), bracket-es "generation:" sor nélkül és
VRAM-sor nélkül. A screenshoton látott PONTOS formátum tehát nem ennek a szervernek a saját
naplója -- feltehetően egy másik (LM Studio-alapú) felállásból származik, amit ez a flotta jelenleg
nem futtat.

**Döntés:** ahelyett hogy egy soha nem látott log-formátumot próbáltunk volna újra-előállítani vagy
egy nem létező fájlt tail-elni, a TÉNYLEGESEN élő rendszer már strukturáltan hordozza ugyanazt az
adatot: Ollama `/api/generate` JSON-válasza tartalmazza a `prompt_eval_count`/`eval_count`
token-számokat ÉS az `eval_duration` (ns) generálás-only időt (mérve: 36 prompt token, 3 output
token, 52.226 ms eval_duration egy valós hívásnál) -- ez pontosan az a szám, amiből LM Studio saját
"speed" mezője is számolódik, csak nanoszekundum-pontossággal, log-parse nélkül. A VRAM-hoz az
Ollama `/api/ps` végpont `size_vram` mezője (mérve: 4638040390 byte egy betöltött 7B modellnél) a
legközelebbi élő megfelelő -- a jelenleg betöltött modell tényleges VRAM-lábnyoma, nem egy
naplóból visszafejtett szám. Ez a mérnöki-alapelvek 10. szabályának (GitHub-first / ne találd fel
újra) és a "cél-vezérelt végrehajtás" elvnek (4. szabály) a következménye: a screenshot a CÉLT
mondta ki (tokens/s + VRAM az Aktív Feladat után), nem a MEGVALÓSÍTÁS módját, és egy már meglévő,
strukturált, verzionált API megbízhatóbb forrás egy szöveges log-formátum feltételezésénél, amiről
kiderült, hogy ezen a gépen nem is létezik.

**Fontos pontosság-részlet:** a tokens/s-t a `local-llm.sh` már meglévő wall-clock `ms` oszlopából
(usage-log 5. mező) számolni HIBÁS lenne, mert az a GPU-lock várakozást (akár 600 mp) is
tartalmazza -- egy lock-torlódás alatt lefutott hívás így hamisan alacsony sebességet mutatna. Ezért
a `local-llm.sh` egy ÚJ, 10. TSV-oszlopot ír (`eval_duration_ms`, Ollama saját mérése), és a
sebesség ebből számolódik.

**Megvalósítás (6 fájl):**
1. `store/local-llm.sh`: a `log_usage()` egy 5. opcionális argumentumot kap
   (`eval_duration_ms`, TSV oszlop 10); a `--api/generate` válasz python-parszolása kiegészítve
   `eval_duration`-nel (ns -> ms konverzió). Visszamenőleg kompatibilis: egy régi, 9-oszlopos sor
   0-ként olvasódik (lásd `parseUsageRows`), ami "sebesség ismeretlen"-t jelent, nem hamis nullát.
2. `src/web/routes/local-llm.ts`: `UsageRow` kiegészítve `evalDurationMs`-szel; új exportált,
   tiszta `lastGenerationStats(rows, psModels)` függvény (a legutóbbi VALÓDI, sikeres, tényleges
   kimenettel járó hívást keresi visszafelé, UI-probe-okat és hibás hívásokat kihagyva); új
   `GET /api/local-llm/last-generation` végpont, ami a usage-ledger farkát és egy élő `/api/ps`
   VRAM-lekérdezést kombinál. Minden mező `null`, ha még nem történt valódi generálás (soha nem
   nyers hiba -- 12. szabály).
3. `web/index.html`: új `dt`/`dd` sor "Utolsó generálás" címkével, közvetlenül az "Aktív feladat"
   sor UTÁN, ugyanabban a `ovwSpectrumReadout` `<dl>`-ben (kártya konkrét kérése).
4. `web/app-overview.js`: új `ovwSpectrumPollLastGen()`, ugyanazon az 5 mp-es időzítőn fut mint a
   meglévő hullámforma-poll, de KÜLÖN hívásként (nem beolvasztva `ovwSpectrumPoll()`-ba), hogy az
   egyik adatforrás kiesése ne törölje a másik már jó olvasatát.
5. `web/lang/hu.js` + `web/lang/en.js`: `overview.spectrum.last_gen` kulcs mindkét nyelven.

**Tesztek:** új `local-llm-last-generation.test.ts` (8 teszt: `eval_duration_ms`-oszlop olvasása,
visszamenőleges kompatibilitás, sebesség eval_duration-ből -- NEM wall-clock ms-ből -- számolva
egy konkrét, torlódást szimuláló esettel, null sebesség 0 eval_duration-nél, null eredmény ha
soha nem volt valódi generálás, a legfrissebb sikeres hívás kiválasztása egy későbbi hibás hívás
mellett, VRAM-illesztés `/api/ps` alapján, null VRAM ha a modell már nincs betöltve); az
`overview-utilization-spectrum.test.ts` kibővítve 5 új teszttel (sor-elhelyezés a DL-ben, a poll
végpont, a "—" placeholder tényleges generálás hiányában, hibakezelés, kettős hívás init+tick-nél).
Élőben is ellenőrizve: egy tényleges `store/local-llm.sh` hívás a futó Ollama ellen helyesen írta
a 10. oszlopot (`eval_duration_ms=26`) a usage-logba.

**Ki döntött:** backend2 (a kártya vizsgálata, a log-formátum élő ellenőrzése, a tervezési döntés
és a megvalósítás).

**Hivatkozás:** kártya `b21deb9a`.

## 2026-08-24 18:00 -- fleet-test.sh flotta-szintű blokk javítása: elavult hardcodolt importer-szám a blast-radius-guard selftestben

**Probléma:** a `b21deb9a` landolása közben (fentebb) a `fleet-test.sh` determinisztikusan bukott
(nem lock-torlódás, uncontended futáson is), mert
`src/__tests__/graph-tooling-selftests.test.ts` a `scripts/hooks/blast-radius-guard.selftest.py`-t
futtatja, ami a HUB fájlra (CleanCore `apps/api/src/pg-client.ts`) egy PONTOS `"importers: 17"`
substringet várt a guard blokk-üzenetében. A CleanCore élő fejlesztése miatt a tényleges
importer-szám azóta 173-ról 181-re nőtt -- a substring már nem egyezett, a teszt bukott, és mivel
ez a `fleet-test.sh`, azaz MINDEN ügynök landolásának előfeltétele, ez a flotta egészét blokkolta
(nem csak a sajátomat).

**Diagnózis:** függetlenül megerősítve (`python3 store/blast-radius-check.py .../pg-client.ts` ->
181) és MikroB is megerősítette ugyanezt. Ugyanaz a hibaosztály, mint a korábbi
graf-staleness leletek: egy PONT-hoz kötött assert egy eleven, folyamatosan növekvő értéken
(a CleanCore import-gráfja) idővel mindig elromlik.

**Döntés:** a két érintett assertet (`blast-radius-guard.selftest.py` 109. és 215. sor) PONTOS
substring helyett STRUKTURÁLIS regex-mintára (`importers: \d+`) cseréltem -- a teszt attól még
ellenőrzi, hogy a guard tényleges, mért számot ír ki (nem 0-t, nem üres stringet), csak nem köti
egy adott pillanat pontos értékéhez. A fixture-alapú asszerciók (`"importers: 30"`, a teszt saját
maga építette hermetikus gráfon) ÉRINTETLENEK maradtak -- azok nem a CleanCore-hoz kötöttek, nem
avulnak el. A HUB/LEAF konstansok melletti kommentek is frissültek, hogy ne kódoljanak be egy
pillanatnyi mért számot jövőbeli félreértés forrásaként.

**Hatás:** `python3 scripts/hooks/blast-radius-guard.selftest.py` most 27/27-et ad (előtte 25/27),
a `graph-tooling-selftests.test.ts` teljes szvitje zöld. Ezután a `b21deb9a` és minden más
függőben lévő flotta-landolás újra próbálható.

**Ki döntött:** backend2 (a blokk leletezése, MikroB felkérésére a javítás -- mivel backend2 volt
épp blokkolva általa és már mindent tudott a jelenségről).

**Hivatkozás:** kártya `bba2b3b0`.

## 2026-08-24 18:25 -- tailscale-login.test.ts akadás (a2d8eab1): gyökér-ok nem reprodukálható, defenzív keményítés landolva

2026-08-24 17:15-17:50 és később 17:52-18:11 között kétszer, két FÜGGETLEN alkalommal akadt el a
`src/web/federation/tailscale-login.test.ts` egy `fleet-test.sh` futásban (MikroB, ill. saját magam
által megfigyelve) -- első alkalommal 34+ percig egy vitest worker 100% CPU-n pergett rajta, minden
más worker idle volt közben (nem I/O-várakozás, aktív számítás jele); a `marveen-test.lock` megosztott,
így ez BÁRMELY másik ügynök landolását blokkolja (saját landolásomat kétszer is REFUSED-ra vitte).

**Vizsgálat:** végigolvastam a tesztfájlt és a `tailscale-login.ts` forrást -- minden poll-ciklus a
tesztekben már eleve retry-számmal korlátozott (max 50×20ms), nincs bennük szó szerinti végtelen
ciklus. Az egyetlen strukturális hiányosság, amit találtam: a `startTailscaleUp` maga spawnolt
gyermek-folyamatának (a `tailscale up` hívás) NINCS kemény timeout/kill-védelme -- ellentétben az
`execFileAsync`-kel (aminek pont ez a dokumentált célja, ld. a fájl saját kommentje a process-group
kill-ről), itt a `earlyTimer` csak a PROMISE-t oldja fel korán, a valódi OS-folyamatot soha nem öli
meg, akármeddig fut.

**Reprodukálási kísérlet:** 232 futtatás összesen -- 40 szekvenciális + 96 párhuzamos (12 egyidejű
példány × 8 kör, mesterséges CPU-kontenció a valós flotta-terhelés szimulálására) a fix ELŐTT, majd
újabb 96 párhuzamos a fix UTÁN -- egyetlen egyszer sem akadt el. A gyökér-ok emiatt NEM igazolt, csak
gyanított; a jelenség nyilvánvalóan valamilyen finomabb verseny-feltételt igényel, amit izolált
futtatással (akár mesterséges kontencióval is) nem sikerült előidézni.

**Döntés:** a talált strukturális hiányosságot (nincs kemény kill a `tailscale up` gyermek-folyamatra)
mindenképp megjavítottam -- ez önmagában is valódi robusztussági rés (egy éles, ténylegesen elakadt
`tailscale up` a hálózati stack hibája miatt korlátlanul futva maradhatna), függetlenül attól, hogy ez
okozza-e a megfigyelt teszt-akadást. `detached: true` + process-group SIGKILL hozzáadva `UP_BUDGET_MS
+ 30s` után, ugyanazt a mintát követve mint `execFileAsync`. NEM állítom, hogy ez a tényleges gyökér-ok
javítása -- ezt a REVIEW-kommentben és MikroB felé is explicit kimondom.

**Hatás:** `npx tsc --noEmit` tiszta, `npx eslint` tiszta, a teszt 25/25 zöld a fix után is (508ms).

**Ki döntött:** backend2 (kártya a2d8eab1, MikroB dispatch).

**Hivatkozás:** kártya `a2d8eab1`.


## 2026-08-24 -- apps/superadmin bekötve a CleanCore land-lánc typecheck-projektjei köze (be30a5f7)

**Mi történt:** a `store/cleancore-tsc-lib.sh`-ban élő `TSC_PROJECTS` lista (`cleancore-land.sh` és
`cleancore-pregate.sh` közös forrása) korábban NEM tartalmazta `apps/superadmin/tsconfig.json`-t --
a superadmin app typecheckje soha nem futott a land-gate alatt, csak kézzel. A kártya `be30a5f7`
másik fele (a fő CleanCore-oldali fix: `apps/superadmin/vitest.gate.config.ts` új projekt a `.tsx`
tesztek lefedésére) mellett ez a hiányzó darab is a kártya scope-ja: "kösd be az apps/superadmin-t a
land-lánc typecheck-projektjei közé".

**Döntés:** `apps/superadmin/tsconfig.json` felvéve a `TSC_PROJECTS` listára, a meglévő
`apps/api/tsconfig.json` mintáját követve (root-relatív `-p` út, `tsc` a repo gyökeréről hívva) -- NEM
az `apps/web`-hez hasonló, feltételes/lassú útvonalra, mert mérve kb. 15 másodperc (`time tsc --noEmit
-p apps/superadmin/tsconfig.json` a repo gyökeréről), szemben az `apps/web` "percekig tartó" jelzésével.
`link_node_modules` (maxdepth 4-es symlink-kereséssel) már eleve eléri `apps/superadmin/node_modules`-t,
nem kellett hozzá külön kezelés.

**Sorrend, ami miatt ez KÜLÖN commitban él a marveen repóban, nem a CleanCore branch-ben:** a
`cleancore-tsc-lib.sh` a marveen repo `store/`-jában él (a flotta saját tooling-ja), NEM a CleanCore
repóban -- a CleanCore-oldali fix (vitest config + a 9 típushiba javítása) egy másik commit/branch,
`fix/superadmin-tsx-gate-coverage-be30a5f7` a CleanCore worktree-ben, saját landolással.

**A 9 típushiba maga:** mind ugyanaz az alak -- `noUncheckedIndexedAccess` miatt egy
`screen.getAllByRole(...)[N]` indexelt elérés típusa `HTMLElement | undefined`, de
`userEvent.click`/hasonló `Element`-et vár. A kódbázisban már van bevett minta erre
(`apps/web/src/features/billing/SuperadminPricingAdmin.test.tsx`: `[0]!` nem-null asszerció) --
ugyanezt alkalmaztam mind a 9 helyen (`PlanPricingPage.test.tsx`, `PlatformConfigPage.test.tsx` 6
hely, `TenantDetailPage.test.tsx` 2 hely). Nem hibakezelés vagy típus-lazítás, a futásidejű
biztonságot a megelőző `waitFor`/`getAllByRole` állítja már elő ugyanúgy, mint az `apps/web` mintában.

**Hatás:** `npx tsc --noEmit -p apps/superadmin/tsconfig.json` a 9 hibáról 0-ra, exit code 0.

**Ki döntött:** backend2 (kártya be30a5f7, MikroB dispatch).

**Hivatkozás:** kártya `be30a5f7`.


## 2026-08-24 -- gate-pretriage-card.sh: merge-commit fájllista a HELYES szülőhöz mérve (5b4cca21)

**Mi történt:** Cybersec élő leletet talált (kártya 132a6cfb, komment 15118): a gate-pretriage mechanikus fájllistája a `2c56d300` merge-commitra az `e0ef6202` (egy MÁSIK kártya) backend-fájljait sorolta fel, egyetlen FE-fájl nélkül, holott a kártya FE-változtatás volt. Ok: `2c56d300` egy MERGE-commit (szülők: `93040766` = Fron Ted saját ágának korábbi csúcsa, `cd1b1229` = a BE-kártya már landolt merge-e), és a script mindig az ELSŐ szülőhöz (`sha~1`) mért diffet -- ez a MÁSIK szülő (a trunk) által hozott tartalmat mutatta, nem a kártya saját munkáját.

**Miért nem egyszerű a fix:** a `[[marveen-gate-shas-are-merges-diff-the-branch-side]]` memória szerint az ELSŐ szülőhöz mért diff a STANDARD landolásnál (marveen-land.sh/cleancore-land.sh: trunk kicsekkolva, ág belemergelve -- szülő1=trunk, szülő2=ág) helyes, és `merge-base(szülő1, szülő2)` használata blindly VISSZAHOZNÁ a `[[a-merge-has-two-diffs-and-the-other-parent-is-the-telling-one]]` által is leírt hibaosztályt: ha trunk a kártya elágazása óta mozgott (más ügynökök közben landoltak), a merge-base régebbi pontra mutat, és a diff BESZIPPANTJA a köztes, nem-idetartozó landolásokat is. A tényleges hiba oka más: `2c56d300` NEM a standard landoló szkript sajét merge-e volt, hanem Fron Ted saját, ad-hoc konfliktus-feloldó merge-e (a saját águkba mergelték bele origin/main-t landolás közben) -- ebben a topológiában a trunk a MÁSODIK szülőben ül, nem az elsőben.

**A fix:** `merge_diff_base()` új függvény -- csak MERGE-commitra (2+ szülő) tér el a régi `sha~1`-től. `git merge-base <sha> origin/<trunk>`-ot számol (CleanCore-nál `origin/main`, marveennél `origin/develop`), ami MELYIK szülő-pozícióban is ül a trunk, azt megtalálja -- pontosan azt a módszert, amit Cybersec kézzel már validált (`git merge-base 2c56d300 origin/main` = `cd1b1229`, ez adta a helyes 5-fájlos listát). Két védelem tartja a fixet biztonságosnak a gyakori (standard) esetre:
1. Trunk itt csak fast-forwardol (soha nem rebase-elődik), tehát ez a merge-base UGYANAZT adja most, mint landoláskor -- nem "amilyen trunk ma épp".
2. Egy standard landolás saját merge-commitja push után AZONNAL trunk csúcsa lesz, tehát `merge-base(sha, origin/trunk)` ilyenkor `sha`-ra degenerálódik (üres diff) -- ezt a kód elkapja és visszaesik a régi `sha~1`-re, tehát a gyakori eset VÁLTOZATLAN marad.

**Mutációs önellenőrzés:** a fixet szándékosan visszaállítottam `sha~1`-re, és a `reversed topology` teszt PIROSRA váltott (`other-card-file.ts`-t jelentett `card-file.ts` helyett) -- pontosan a bejelentett hibaosztály. Visszaállítva a fix után zöld.

**Hatás:** `src/__tests__/gate-pretriage-card.test.ts` 25/25 zöld (3 új teszt: fordított topológia -- a hiba reprodukciója és javítása; standard topológia -- nincs regresszió; degenerált eset -- helyes visszaesés).

**Ki döntött:** backend2 (kártya 5b4cca21, Cybersec eredeti lelete a 132a6cfb gate-en).

**Hivatkozás:** kártya `5b4cca21`. Előzmény: `132a6cfb` (komment 15118, Cybersec lelete). Kapcsolódó memória: `marveen-gate-shas-are-merges-diff-the-branch-side`, `a-merge-has-two-diffs-and-the-other-parent-is-the-telling-one`.


## 2026-08-24 -- selectFairBatch: az URGENT/SÜRGŐS elsőbbség csak megbízható forrásra jár (3303e9d6)

**Mi történt:** Cybersec élő lelete (f951ec53 gate közben, nem hivatalos verdikt): az `isUrgentMessage()` a NYERS küldő-tartalmon fut, MIELŐTT a `wrapAgentMessageForDelivery()` bizalmi keretezése megtörténne. A `selectFairBatch()` ezt használta fel a sorrend-elsőbbségre (kártya f951ec53 korábbi javítása), forrás-ellenőrzés nélkül. Egy FEDERÁLT (definíció szerint NEM megbízható) társ saját üzenetében "URGENT:" első sorral elsőbbséget szerezhetett volna a sorban a valódi flotta-dispatchek előtt. Mivel akkor (2026-08-23) az `/api/federation/directory` nulla konfigurált társat mutatott, a hiba LAPPANGÓ volt -- éles felülettel csak az első társ csatlakozásakor vált volna azzá.

**A fix:** `selectFairBatch()` a bucket-szétválasztásnál már nem csak `isUrgentMessage(m.content)`-et nézi, hanem `classifyAgentMessage(m.from_agent, m.to_agent)` kategóriáját is: `promotable = category === 'trusted-peer' || category === 'channel-inbound'`, és csak `promotable && isUrgentMessage(...)` esetén kerül a sürgős kosárba. A `classifyAgentMessage` ugyanaz a tiszta, olcsó klasszifikáló, amit a router már amúgy is lefuttat egyszer kézbesítéskor (message-router.ts:814 környékén) -- ugyanazon a DB-tárolt (a küldés pillanatában rögzített, nem utólag szerkeszthető) `from_agent`/`to_agent` páron, csak MOST a sorrend-döntéshez is.

**Miért nem regresszió a korábbi (f951ec53) fixre:** a klasszifikáció csak a FORRÁS bizalmi szintjét szűkíti, a tartalom-alapú urgency-felismerést nem gyengíti trusted-peer/channel-inbound üzeneteknél -- a gate FAIL / SÜRGŐS / CYBERSEC NO-GO jelzések a flotta saját ügynökei között (a többség) változatlanul elsőbbséget kapnak. Csak a föderált/nem-megbízható forrású "urgent" állítás veszti el az elsőbbséget.

**Tesztek:** `src/__tests__/message-router-fair-batch.test.ts`, új `describe('selectFairBatch urgency promotion is source-gated (card 3303e9d6)')` blokk, 3 eset: federált küldő nem tud előre-sorolni, nem-megbízható helyi küldő nem tud előre-sorolni, KONTROLL -- valódi trusted-peer továbbra is előre-sorol. `classifyAgentMessage` mockolva (a valódi isKnownAgent/team-fájl FS-ellenőrzések nem ennek a tesztnek a tárgya, és a teszt-folyamat MAIN_AGENT_ID-jétől függenének). 19/19 zöld.

**Mutációs önellenőrzés:** a fixet ideiglenesen visszaállítottam az eredeti (forrás-független) viselkedésre, a két új "nem promotable" teszt PIROSRA váltott (a föderált/nem-megbízható üzenet előre-sorolódott), a KONTROLL teszt zöld maradt -- a változtatás pontosan a bejelentett hibaosztályt fedi, mást nem érint.

**Ki döntött:** backend2 (kártya 3303e9d6, Cybersec eredeti lelete a f951ec53 gate közben).

**Hivatkozás:** kártya `3303e9d6`. Előzmény: `f951ec53` (a promótált sürgős-elsőbbség eredeti bevezetése).


## 2026-08-24 -- redispatch-guard.sh: a cap-check megelőzi a backoff-ellenőrzést (86dfba39)

**Mi történt:** MikroB saját lelete (2026-08-24, Peti direkt visszajelzése: "két kártya 5 órát áll,
miért nem szóltál"). A `check` parancs régi sorrendjében a (4) backoff-ablak ellenőrzése ELŐBB
futott, mint az (5) hard cap (count>=MAX_REDISPATCH) ellenőrzése. Mivel a backoff BASE_BACKOFF*2^count
(600s alapértékkel, count=3-nál már 4800s=80perc), a HARMADIK nudge után a kártya azonnal egy 80
perces backoff-ba lépett, és EBBEN AZ ÁLLAPOTBAN a backoff-ellenőrzés MINDIG korábban DENY:backoff-ot
adott vissza, mint hogy elérte volna a cap-check-et -- a tényleges Peti-riasztás csak azután sült el,
hogy ez az utolsó (leghosszabb) backoff-ablak is lejárt. Két, már régóta (5+ óra) álló kártyánál
(ec20dd23, fa5ef179) ez kb 49 perces plusz késleltetéshez vezetett.

**A fix:** a `check` parancs (3)-(6) lépéseit (busy / cap / backoff / allow) egy új, tiszta
`_decide_active()` függvénybe emeltem ki, amiben a cap-ellenőrzés MOST a backoff-ellenőrzés ELŐTT
fut. A `check` ág mostantól ezt a függvényt hívja és a visszaadott döntés szerint ágaz -- a kimeneti
szövegek (DENY:agent-busy, DENY:cap-reached(N), DENY:backoff(Ns), ALLOW) változatlanok, csak a
DÖNTÉS SORRENDJE változott.

**Miért külön függvényként:** a hiba kizárólag a KÉT FELTÉTEL SORRENDJÉRŐL szól -- ha a teszt csak
kézzel újraimplementálná ugyanazt a logikát (ahogy a fájl korábbi selftest-esetei is tették), a teszt
nem a VALÓDI kódot próbálná, hanem saját magát. A külön függvény azt teszi lehetővé, hogy a selftest
a tényleges döntés-utat hívja meg.

**Tesztek:** `store/redispatch-guard.sh selftest`, új eset: count=3 (=MAX_REDISPATCH), csak 10
másodperc telt el egy 4800s-os ablakból -- elvárt eredmény `cap-reached`, NEM `backoff:...`. Két
kontroll-eset is: count=2 (cap alatt) ugyanabban a helyzetben helyesen backoff-ot ad, és busy=1
mindig megelőzi mindkét másik ágat. Mind a 6 selftest-eset zöld.

**Mutációs önellenőrzés:** a `_decide_active()`-ban visszaállítottam az eredeti sorrendet (backoff
előbb, mint cap) -- a selftest PONTOSAN a bejelentett tünetet reprodukálta (`backoff:4790` a várt
`cap-reached` helyett a cap-teszt esetben), a másik két kontroll-eset változatlanul zöld maradt.
A fix visszaállítása után újra minden zöld.

**Ki döntött:** backend2 (kártya 86dfba39, MikroB saját lelete).

**Hivatkozás:** kártya `86dfba39`. Érintett fájl: `store/redispatch-guard.sh`.


## 2026-08-24 -- biztonsági/pentest eszköz jelöltek due diligence-e (441337bf)

**Mi történt:** a kártya 5 jelöltjét (snyk/agent-scan, NeoTheCapt/RedteamAgent, usestrix/strix,
GH05TCREW/pentestagent, bhavsec/autopentest-ai) vizsgáltam át, KIZÁRÓLAG olvasás-alapon
(GitHub API metaadat + LICENSE-fájl, quarantine-reader ügynökön át) -- semmit nem telepítettem
vagy futtattam, különösen nem a négy aktív pentest-keretrendszert.

**Plan-grilling (a Skill tool nem találta a `plan-grilling` nevet, a SKILL.md-t közvetlenül
olvastam és kézzel futtattam le a procedúrát):** verdikt GO-WITH-CHANGES. A legvalószínűbb
buktató -- véletlenül FUTTATNI valamelyik ajánlott keretrendszert "csak hogy lássam mit tud" --
ellen a változtatás: kizárólag olvasás-alapú kutatás ebben a körben, egyik jelölt sem lett
telepítve/futtatva, és minden négy támadó eszköz jelentésében explicit állítva, hogy
"nem futtatva, nem telepítve -- Cybersec/Cybered jóváhagyására vár".

**Eredmény jelentésenként:**
- snyk/agent-scan: valós, aktív (2953 csillag, Apache-2.0, ma pusholva), önvédelmi célú
  (AI-agent/MCP/skill biztonsági szkenner), pontosan a flotta NULLA lefedettségű részére.
  JAVASLAT: ADOPT. Megjegyzés: a LICENSE fájl "Invariant Labs AG"-t nevez meg copyright-ként,
  nem a Snyk szervezetet -- valószínűleg felvásárolt projekt megtartott attribúciója
  (Apache-2.0 ezt megengedi), nem blokkoló, de Cybersecnek érdemes újraolvasnia.
- NeoTheCapt/RedteamAgent: valós repó, DE a GitHub API `"license": null`-t ad -- NINCS
  licencfájl, tehát alapértelmezésben minden jog fenntartva a szerzőnél. JAVASLAT: REJECT,
  függetlenül a biztonsági kockázattól, hacsak a szerző explicit engedélyt nem ad.
- usestrix/strix: valós, kiemelkedően aktív (57715 csillag, Apache-2.0, ma frissült, saját
  szervezet + domain). A legerősebb technikai/közösségi jelölt a négy aktív eszköz között.
  JAVASLAT: Cybersec/Cybered döntésére vár, technikailag a legjobb első jelölt.
- GH05TCREW/pentestagent: valós, aktív (MIT licenc, kb. 2994 csillag, 602 fork, ma frissült),
  CVE-alapozott RAG megközelítés. JAVASLAT: Cybersec/Cybered döntésére vár, jó másodlagos jelölt.
- bhavsec/autopentest-ai: valós repó, DE `pushed_at` 2026-02-22 -- kb. fél éve nincs kódváltozás,
  a kártya saját karbantartottsági aggálya megerősítve mérve. JAVASLAT: REJECT / alacsony
  prioritás.

**Ki döntött:** backend2 (kártya 441337bf, due diligence -- a végső adoptálási GO/NO-GO
kizárólag Cybersec/Cybered joga, ahogy a kártya előre rögzítette).

**Hivatkozás:** kártya `441337bf`, szülő-fázis `40f92dd2`.


## 2026-08-24 -- teszt-minőség jelöltek due diligence-e (13083b74)

**Mi történt:** a kártya 2 jelöltjét vizsgáltam át, kizárólag olvasás-alapon (GitHub API metaadat
+ repó-tartalom, quarantine-reader ügynökön át) -- semmit nem telepítettem vagy futtattam.

**Mutahunter (codeintegrity-ai/mutahunter):** valós, 299 csillag, Python, AGPL-3.0 licenc.
`pushed_at` 2025-04-17 -- kb. 16 hónapja nincs tényleges kódváltozás (az `updated_at`
2026-08-17 csak felszínes metaadat-érintés). Ez a saját "zöld suite, de nem fedi a változott
ágat" hibaosztályunk (lásd testing-traps memória-téma) strukturális ellenszere lehetne, DE az
AGPL-3.0 (erős copyleft, de valódi OSS, más eset mint a root CLAUDE.md 10. szabályának
source-available carve-outja) és a karbantartási rés miatt jogász + Cybersec jóváhagyás kell,
mielőtt a QA gate-checklistbe kerülne. Megjegyzés: az AGPL hálózati-copyleft klauzulája
jellemzően csak módosított/terjesztett/hálózaton szolgáltatott derivált munkára aktiválódik --
egy önálló CI-eszközként futtatott, nem módosított, nem terjesztett használat esetén ez
alacsonyabb kockázatú, de ez nem helyettesíti a jogász-jóváhagyást.

**dotnet/skills, code-testing-generator (Microsoft):** valós, nagyon aktív (5239 csillag, MIT
licenc, ma pusholva). A `code-testing-generator` egy valódi, belső orchestrator ágens a
`plugins/dotnet-test/agents/` alatt, a publikus `code-testing-agent` skill részeként, Research-
Plan-Implement (RPI) pipeline-nal, ahogy a kártya leírja. A kártya által hivatkozott "92.1% vs
78.9%" önbevallott eredményszám A REPÓBAN SEHOL nem található (README, SKILL.md, minden elérhető
agent-fájl, docs átvizsgálva) -- valószínűleg külső bejelentésből származik, nem igazolható a
repóból. MIT licenc miatt jogi akadály nincs, de MÁS célú eszköz (teszt-generálás, nem mutációs
teszt), nem helyettesíti a Mutahuntert.

**Ki döntött:** backend2 (kártya 13083b74, due diligence -- a végső gate-checklistbe kötés
QA/Cybersec döntésére vár).

**Hivatkozás:** kártya `13083b74`, szülő-fázis `40f92dd2`.


## 2026-08-24 -- blast-radius guard: explicit forced-hub allowlist a küszöb-hézagra (3f61b2ab)

**Mi történt:** saját megfigyelésem (398f351b review közben, msg 19271): `src/web/agent-scaffold.ts`
(sok ügynök-típus alapja) 23 importálót mért, éppen a blast-radius guard 25-ös küszöbe ALATT --
tehát a guard NEM figyelmeztetett volna a szerkesztésekor, pedig ez a flotta egyik legérzékenyebb
megosztott fájlja. A mostani mérésnél a szám már pontosan 25 (a küszöbön), ami magától megoldódott
volna, DE ez pont a probléma szemléltetése: egy szám-alapú küszöb egy alapjában fontos fájl körül
bármikor visszaeshet, ahogy nő/csökken az importálók száma a kódbázis természetes fejlődésével.

**Vizsgálat (a kártya 1. lépése):** a küszöb-logika STATIKUS, nem élő -- a `code-review-graph`
adatbázisból olvas (`store/blast-radius-check.py:measure()`), amit a `marveen-land.sh` és a
`store/blast-radius-check.py --refresh` frissít inkrementálisan. A guard maga fail-open, ha a
graf `BLAST_RADIUS_MAX_BEHIND` (alapérték 200) commitnál régebbi.

**A döntés (a kártya 2. lépése):** NEM a globális küszöb csökkentése (az minden más fájlra is
kihatna, amik ma jogosan a küszöb alatt vannak -- mellékhatás, nem célzott javítás), hanem egy
explicit, NÉV-alapú `ALWAYS_HUB_FILES` allowlist a `store/blast-radius-check.py`-ban, amit egy
`is_forced_hub(rel)` függvény néz ki (env-bővíthető: `BLAST_RADIUS_ALWAYS_HUB`, vesszővel
elválasztott repó-relatív útvonalak). A `src/web/agent-scaffold.ts` mostantól MINDIG SHARED/CORE-
nak számít, a mért importáló-számtól függetlenül. A `scripts/hooks/blast-radius-guard.py` gate-je
ezt nézi meg a küszöb-összehasonlítás ELŐTT.

**Dokumentálva (a kártya 3. lépése):** a döntés indoklása a `ALWAYS_HUB_FILES` konstans fölötti
kommentben áll (store/blast-radius-check.py), a guard-hook saját kommentje pedig ide hivatkozik.

**Tesztek:** `scripts/hooks/blast-radius-guard.selftest.py` új fixture-fájl (`rare.ts`, 3 importáló,
jóval a küszöb alatt) + 3 új eset: kontroll (override nélkül nem blokkol), forced (env override-dal
blokkol), és hogy a jelentés megnevezi a fájlt és a "forced" jelölést. 31/31 zöld. A
`store/blast-radius-check.py --selftest` (26/26) és `src/__tests__/blast-radius-guard-wiring.test.ts`
(12/12) is zöld, nincs regresszió.

**Mutációs önellenőrzés:** a guard-hook `is_forced_hub()` ellenőrzését ideiglenesen kivettem --
pontosan a 3 új eset váltott pirosra (a régi viselkedés visszatért: a forced fájl megint nem
blokkolt), minden más teszt zöld maradt. A fix visszaállítása után újra minden zöld.

**Ki döntött:** backend2 (kártya 3f61b2ab, saját korábbi megfigyelés).

**Hivatkozás:** kártya `3f61b2ab`. Előzmény: `398f351b` (a guard eredeti bevezetése).


## 2026-08-24 -- strukturális előfeltételek offenzív pentest-eszközök élesítése előtt (b4a7c9c3)

**Mi történt:** Cybered leletéből (441337bf gate, komment 15949) kiindulva MikroB dispatchelt egy
külön kártyát: a snyk/agent-scan, usestrix/strix és GH05TCREW/pentestagent együttes adoptálása
kill-chain szempontból új támadási felület a saját flottánkban, ha bármelyik kompromittálódik.
Hat kötelező strukturális előfeltétel a TÉNYLEGES éles futtatás előtt: hálózati egress-allowlist,
dedikált LLM-kulcs, decoy célpont, strix Docker-image digest-pinning, curl|bash installer tiltása,
snyk/agent-scan hálózat-izolált tesztje.

**A felbontás:** hat gyerek-kártya (alfeladat szint), mindegyik egy előfeltétel, a projekt-workflow
1. szabálya szerint.

**Az építés (5 a 6-ból kész+tesztelve, 1 eszkalálva):**
1. Hálózati egress-allowlist: `store/pentest-tool-egress-proxy.py` (allowlist-only HTTP CONNECT
   proxy) + `store/pentest-tool-runner.sh` (wrapper, HTTP_PROXY-t állítja, jelenti a tiltott
   kísérleteket). Élőben tesztelve: engedélyezett host átmegy, tiltott host 403+log.
2. Dedikált LLM-kulcs: `store/pentest-tool-key-check.sh` fail-closed ellenőrzés (hiányzó VAGY a
   megosztott hitelesítővel egyező kulcs -> FAIL). A TÉNYLEGES kulcs kiadása operátori akció --
   ezt nem lehetett itt lezárni, MikroB-hoz eszkalálva, a kártya rá van tolva.
3. Decoy célpont: `store/pentest-tool-decoy-target.py`, csak localhost, négy szándékos
   sebezhetőség (XSS, SQLi, no-auth admin), X-Decoy fejléc + banner.
4. strix Docker-image pinning: a strix ténylegesen Dockert használ (settings.py,
   `ghcr.io/usestrix/strix-sandbox:1.3.0`, mutable tag). A digestet a GHCR registry API-ból
   mértem: `sha256:f6906c31...c4331`. `store/pentest-tool-strix-image-pin.py` a pinnelt
   referenciát adja, `--verify` drift-et jelez anélkül, hogy csendben újrapinnelné.
5. curl|bash installer tiltása: `scripts/hooks/pentest-tool-install-guard.py`, bedrótozva a
   scaffoldba (`injectPentestToolInstallGuard`/`ensurePentestToolInstallGuard`, a git/npm-protect
   guard mintája), 16/16 selftest, mutációs önellenőrzés zöld.
6. snyk/agent-scan hálózat-izolált teszt: `store/pentest-tool-netiso-test.sh` (`unshare --net`
   összehasonlítás). TÉNYLEGES futtatás a valós eszközzel (venv, decoy MCP-config, `--no-skills`,
   elutasított consent): azonos kimenet/exit-kód hálózattal és nélküle -- ez az invokációs alak
   nem tett hálózati hívást. Nyitva maradó kérdés: `--dangerously-run-mcp-servers` és a
   skills-szkennelés NEM lett tesztelve, ezekre a kockázat továbbra is "ismeretlen".

**Mellékes leletek Cybersecnek/Cybered-nek:** a strix sandbox image build-oldali alapja
`kalilinux/kali-rolling:latest` (ellátási-lánc megjegyzés); a snyk-agent-scan `--no-bootstrap`
kapcsolója a mai verzióban dokumentáltan no-op ("does not change behavior") -- nem derül ki
ebből, hogy a régi bootstrap-POST-viselkedés megszűnt-e, vagy feltétel nélkülivé vált.

**Tesztek:** teljes vitest suite (500 fájl, 12383 teszt) zöld, tsc tiszta, minden új script ÉLŐ
funkcionális teszttel igazolva (nem csak mock). A guard mutációs önellenőrzése: a kockázat-check
kikapcsolása után pontosan a 9 block-eset váltott pirosra, minden allow-eset zöld maradt.

**Ki döntött:** backend2 (kártya b4a7c9c3, MikroB dispatch alapján), a dedikált kulcs kérdésében
MikroB/Peti dönt.

**Hivatkozás:** kártya `b4a7c9c3` (szülő) és gyerekei `7dc12e55`, `51400b45`, `330c7916`,
`0ef1b657`, `cc43528b`, `36329ea3`. Előzmény: `441337bf` (due diligence gate).


## 2026-08-24 -- anthropic-mcp-builder + anthropic-webapp-testing tényleges bekötése (kártya f5eda0be)

**Mi történt:** a `3c9e22b1` Fázis ("már adoptált, de használatlan eszközök valós bekötése", Peti
kérése 2026-08-23) utolsó nyitott gyereke. Két Anthropic-skill (`example-skills:mcp-builder`,
`example-skills:webapp-testing`) nulla használati bizonyítékkal az adoptálás óta.

**webapp-testing -- ténylegesen bekötve:**
1. Felvéve QA `Core skilljeid` listájára (`seed-fleet-agents/qa/CLAUDE.md`), rövid leírással és
   hivatkozással erre a kártyára -- ez a durábilis, verziókövetett hely, NEM a gitignored
   `agents/qa/CLAUDE.md` futásidejű másolat (az a seedből generálódik, QA következő
   session-indításakor/scaffold-frissítésekor veszi fel).
2. VALÓS bizonyíték a használatra: a skill saját `scripts/with_server.py` segédjével és egy
   Playwright-szkripttel ténylegesen leteszteltem a CleanCore `apps/web` landing oldalát (egy már
   futó dev-szerver ellen, port 5173, screenshot + DOM-vizsgálat + console-hiba-gyűjtés a
   reconnaissance-then-action minta szerint). Az első futás Chromium-verzió-eltérés miatt hibázott
   (`playwright install chromium` megoldotta), a második sikeres volt.
3. **Mellékes, valódi lelet** (bizonyíték arra, hogy a tool tényleg ér valamit, nem csak "lefut"):
   ~20 CSP-sértés a konzolban -- a landing oldal inline style-jait a `default-src 'self'`
   (nincs külön `style-src`) csendben blokkolja. Külön kártyára véve (`706ad126`,
   `fron-ted`-nek, QA+Cybersec gate), NEM ezen a kártyán javítva -- ez hatókörön kívüli lenne.

**mcp-builder -- NEM erőltetve, dokumentálva (a kártya saját megengedett kimenete):**
végignéztem a teljes `planned`+`in_progress`+`waiting` táblát -- egyetlen kártya sem igényel új,
saját MCP-szerver építését jelen pillanatban. A kártya szövege explicit megengedi ezt a kimenetet
("ha nincs közelben, dokumentáld és hagyd nyitva"): kitalálni egy MCP-szervert csak azért, hogy a
skill "használva" legyen, sértené a kódminőségi alapelvek 2. pontját (nincs spekulatív munka).
Nyitva marad: a `example-skills:mcp-builder` skill a következő valós MCP-szerver-építési igénynél
használandó (backend/backend2, bárki felveszi a feladatot).

**Tesztek:** a webapp-teszt éles Playwright-futtatás volt, nem mock -- lásd fent. Kódváltozás csak
a `seed-fleet-agents/qa/CLAUDE.md` core-skill listájában, fleet-test-re nincs hatással (nem TS/JS).

**Ki döntött:** backend2 (kártya f5eda0be, MikroB dispatch a 3c9e22b1 Fázis alatt).

**Hivatkozás:** kártya `f5eda0be` (ez), szülő `3c9e22b1`. Kapcsolódó új kártya: `706ad126` (CSP-lelet).

## 2026-08-25 -- Pontosítás a 12783b1e verziószámláló-szabályhoz: X.Y.Z TÉNYLEGESEN kövesse az upstreamet minden sync-mergenél

**Döntés:** A 2026-08-20-i `12783b1e` bejegyzés szövege ("X.Y.Z az upstream Szotasz/marveen verzió... Upstream-sync után (új X.Y.Z) a számláló 1-re áll vissza") változatlanul érvényes és MEGERŐSÍTVE: a `package.json` `version` mezőjének `X.Y.Z` része minden upstream-sync merge-nél frissüljön a ténylegesen belehúzott upstream verzióra, `+mikrob.1` szuffixszel. A számláló csak akkor 1, ha ÚJ X.Y.Z-re lépünk; egyébként fork-saját landolásnál nő.

**Miért ez a bejegyzés:** a c7f0d394 fleet-wide landolás-blokk feloldása közben (2026-08-25 este) két ügynök egymástól függetlenül eltérően értelmezte ugyanezt a szabályt ugyanarra a bumpra (upstream 1.33.0 -> 1.34.0): backend a dokumentált szöveg szerint az X.Y.Z átvételét javasolta (`1.34.0+mikrob.1`), backend2 landolt döntése viszont a fork saját `1.33.0+mikrob.1`-jét hagyta változatlanul, és ez a változat landolt előbb (Fron Ted átfogó javításába építve). A tényleges `package.json` `version` mezője ezért MOST `1.33.0+mikrob.1`, ELTÉR a dokumentált szabálytól. Ez nem új policy-döntés, hanem a MÁR MEGLÉVŐ szabály helyreállítása -- lásd [[a-decisions-correction-goes-as-a-new-dated-entry]].

**Végrehajtás:** külön kártya nyitva a `package.json` tényleges frissítésére (`1.34.0+mikrob.1`-re) + a `fork-upstream-conflict-guard.test.ts` megfelelő `ACKNOWLEDGED_CONFLICTS`/`ACKNOWLEDGED_UPSTREAM_BLOBS` bejegyzésének összhangba hozására ezzel a döntéssel.

**Ki döntött:** MikroB (a 12783b1e eredeti szövegének szó szerinti újraolvasása alapján; nem új döntés, a meglévő szabály egyértelműsítése egy megfigyelt kétértelmű végrehajtás után).

**Hivatkozás:** kártya `12783b1e` (eredeti szabály), `c7f0d394` (a blokk, ami alatt a kétértelműség felmerült), backend INFO-üzenete (2026-08-25 22:xx).

## 2026-08-26 -- Ingatlan ingest-szerver: systemd user unit a perzisztenciahoz (kártya 489dae5f)

**Mi történt:** az Ingatlan ingest-szerver (`npm run ingest`, port 8787, `/mnt/h/LM_Studio_Workdir/Ingatlan`) kizárólag kézzel indított folyamatként futott, semmilyen újraindítási mechanizmus nélkül. A 2026-08-22 esti géprestart kiölte, és 2026-08-21 óta kb. 2 napig egyetlen új adat sem gyűlt -- a napi emlékeztető rendben kiment, Peti nyitogatta a linkeket, csak nem volt mit fogadja. MikroB 09:37-kor ideiglenesen (`nohup ... &`) újraindította, de ez a mérés idejére (2026-08-26 10:20) ismét leállt.

**Döntés:** `~/.config/systemd/user/ingatlan-ingest.service` -- ugyanaz a minta mint a `mikrob-channels.service`/`mikrob-dashboard.service` (`Type=simple`, `Restart=always`, `RestartSec=10`, `WantedBy=default.target`), tehát boot-kor automatikusan indul (a `Linger=yes` már be volt kapcsolva a felhasználón, ellenőrizve) és összeomlás után 10 mp-en belül újraindul. `RequiresMountsFor=/mnt/h/LM_Studio_Workdir/Ingatlan` hozzáadva, mert ez drvfs (Windows-meghajtó) mount, nem a WSL saját gyökér fs-e -- explicit megvárja a mountot ahelyett hogy a WSL automount-tal versenyezne.

**Elutasított alternatíva:** pm2 vagy cron `@reboot` -- nem vezettem be új függőséget/mechanizmust, amikor a flotta már bizonyítottan működő, karbantartott mintája (systemd user unit) közvetlenül alkalmazható volt.

**Végrehajtás:** verziókövetett sablon (placeholder útvonalakkal, a `disk-space-guard.service` mintáját követve) `scripts/systemd/ingatlan-ingest.service`; a ténylegesen telepített példány `~/.config/systemd/user/ingatlan-ingest.service` (nem verziókövetett, gépi konfig, ahogy a többi mikrob-* unit sem az).

**Tesztek:** élő teszt, nem csak feltételezés. `systemctl --user enable --now` után a szerver felállt (port 8787 `ss`-sel és `curl`-lal is igazolva). Ezután a teljes folyamatfát `kill -9`-eltem -- 10 mp-en belül (a kártya kritériuma: 1 percen belül) systemd új PID-del újraindította, a port ismét elérhető volt válaszoló HTTP-vel. `systemctl --user is-enabled` -> `enabled`, `loginctl show-user neon` -> `Linger=yes` (boot-kori automatikus indítás garantált).

**Ki döntött:** backend (kártya 489dae5f, MikroB gyökér-ok azonosítása alapján, Peti közvetlen panaszára válaszul -- lásd `live-config-outranks-a-remembered-instruction`: a `[[ingatlan-project-location]]` memória korábbi "kézzel indítva, szándékosan" jegyzete elavult ehhez a döntéshez képest, a kártya friss, Peti-panaszra épülő MikroB-döntés).

**Hivatkozás:** kártya `489dae5f`.

## 2026-08-26 -- Pair-FE/Pair-BE beégetett Gate-SHA elavulás: strukturális nudge, nem fegyelmi szabály (kártya 367c23a9)

**Mi történt:** a `fed9409f`/`d0b4f003` pár kapcsán (backend saját megfigyelése, msg 19372) felmerült, hogy ha egy Pair-FE/Pair-BE kártya leírása beéget egy konkrét `Gate-SHA:` sort a másik oldal akkori állapotára hivatkozva, ez a hivatkozás csendben elavulhat, ha a párkártya utána tovább változik (új commit, re-landolás) -- a táblán semmi nem jelzi ezt.

**Döntés:** a kódminőségi alapelvek 6. pontja (strukturális védelem a fegyelem helyett) szerint jártam el, ugyanabban a szellemben mint a `78f85eb1` DECISIONS.md-nudge: a `gate-pretriage-card.sh`-t bővítettem egy új, kizárólag nudge-jellegű ellenőrzéssel (sosem blokkol, sosem változtatja a felismert commitot). Card-módban a szkript a kártya leírásában talált `Pair-FE:`/`Pair-BE:` sor alapján lekéri a párkártya legfrissebb `Gate-SHA:` kommentjét, és ezt hasonlítja össze a SAJÁT leírásba beégetett `Gate-SHA:` értékkel -- eltérésnél figyelmeztet. A tényleges hálózati feloldás (élő API-hívás a párkártyára) csak card-módban fut, nem tesztelt egység -- a szöveges összehasonlítás maga (build_body pythonja) egy új `--peer-gate-sha` kapcsolóval offline is hívható, így determinisztikusan tesztelhető, ugyanaz a minta mint a `--title`/`--desc` kapcsolóknál.

**Elutasított alternatíva:** tisztán fegyelmi szabály ("a párkártyát érintő változtatáskor mindig frissítsd a másik oldal hivatkozását is") -- a kártya saját szövege is felveti mindkét opciót, de a 6. alapelv explicit prioritást ad a strukturális megoldásnak, ha az ésszerű költséggel megépíthető, és itt az volt (a meglévő pre-triage-infrastruktúra közvetlenül bővíthető).

**Tesztek:** 5 új teszt (eltérés figyelmeztet, egyezés csendben marad, rövidebb/prefix-egyező sha csendben marad, nincs beégetett Gate-SHA a leírásban -> csendben marad, nincs feloldott peer-sha -> csendben marad). 36/36 zöld a teljes fájlban.

**Ki döntött:** backend (kártya `367c23a9`, MikroB eredeti "gondold át" megfigyelése alapján, önjáró self-advance dispatch, 2 napnál régebbi kártya előreléptetve a 6b. szabály szerint).

**Hivatkozás:** kártya `367c23a9`. Kapcsolódó minta: `78f85eb1` (missing-DECISIONS.md nudge, ugyanaz a fájl, ugyanaz a "nudge, nem block" szerződés).

## 2026-08-26 -- Seed-vs-live SKILL.md csapda: 3-way szöveges merge fallback, PLAN-GRILLING után (kártya 4ba71429)

**Mi történt:** `update.sh` `seed_copy_is_untouched()` függvénye a TELJES fájlt hasonlítja bájtra pontosan egy korábban kiadott seed-verzióhoz -- ha az operátor BÁRHOL egyetlen sort is szerkesztett (pl. `chat_id` érték, egy hozzáfűzött megjegyzés), a fájl örökre "operátor-módosítottnak" számít, és egy jogos seed-oldali javítás (pl. a `dependency_blocked` bullet) SOHA nem jut el hozzá. Élőben kétszer mérve (`gate-reconciler`, `heartbeat-consolidated`): MikroB kézzel szinkronizálta mindkettőt, mert a strukturális védelem hiányzott.

**Döntés (PLAN-GRILLING VERDIKT, GO-WITH-CHANGES, teljes szöveg a kártya kommentjében):** `seed_copy_try_merge()` új fallback -- amikor a teljes-fájl-egyezés megbukik, `git merge-file`-alapú 3-way szöveges merge próbálkozik (base = egy korábbi kiadott verzió, ours = telepített fájl, theirs = jelenlegi seed), CSAK `.md` fájlokra (a `task-config.json` strukturált konfig KIMARAD, más kockázati profil). Az írás KIZÁRÓLAG akkor történik, ha a merge NULLA konfliktussal sikerül -- bármilyen konfliktus vagy hiányzó `git merge-file` esetén a fájl változatlan marad, ugyanaz a konzervatív viselkedés mint korábban. Írás előtt időbélyegzett `.bak` másolat készül.

**KRITIKUS IMPLEMENTÁCIÓS CSAPDA, amit a tesztelés fogott meg (nem a grillezés):** az első implementáció a `git log` által visszaadott LEGÚJABB historikus blob-bal próbálkozott ELŐSZÖR bázisként -- ez viszont DEFINÍCIÓ SZERINT megegyezik a jelenlegi seed-tartalommal (`theirs`-szel), mert a legutóbbi commit, ami az adott útvonalat érintette, pont a jelenlegi állapotra állította. Egy `base == theirs` merge mindig trivialisan "sikeres" (0 konfliktus), DE semmit nem változtat -- az eredmény pontosan `ours` marad, a javítás SOHA nem jut el a fájlhoz, miközben a kód `SEED_REFRESH_MERGED`-ként könyveli el (hamis siker). Élőben reprodukálva egy valósághű, több soros fixture-rel (nem a teszt-fájl apró 1-soros verzióival, amik véletlenül NEM buktatták le a hibát -- lásd lent). Javítás: minden jelölt bázis hash-ét összevetjük `theirs` hash-ével, és ha egyezik, átugorjuk -- a keresés így egy VALÓDI, korábbi állapotot talál bázisként.

**Miért nem buktatta le ezt a meglévő tesztkészlet:** a `seed-refresh-untouched-only.test.ts` meglévő fixture-jei 1 soros fájlok (`"v1 shipped\n"` stb.), ahol egy operátor-szerkesztés és egy seed-javítás szomszédos sorokon él -- ezekre a `git merge-file` maga is konfliktust jelez (a diff3-algoritmus szomszédos beszúrás/törlés esetén konzervatívan konfliktusnak veszi), így a régi "SOHA nem ír felül" tesztek véletlenül zölden maradtak a hibás implementáción is. A valós incidens (hosszabb, több szakaszos SKILL.md, a szerkesztés és a javítás EGYMÁSTÓL TÁVOL) más útvonalon futott át a kódon, és csak egy realisztikus, több soros, ténylegesen-elkülönített-szerkesztésű fixture-rel derült ki a hiba -- élő, kézzel futtatott reprodukcióval, nem csak a vitest-tel.

**Tesztek:** a meglévő `seed-refresh-untouched-only.test.ts`-t bővítettem (nem írtam át egyetlen meglévő asszerciót sem -- mind a 13 eredeti teszt változatlanul zöld marad, mert a valódi konfliktus-védelem sértetlen). 5 új teszt: (1) a KÉT valós incidens alakja (chat_id-szerkesztés + bullet-hozzáadás; hozzáfűzött marker + bullet-hozzáadás) -- mindkét oldal megmarad; (2) `.bak` mentés ellenőrzése; (3) valódi, ugyanazon sort érintő konfliktus -- a fájl bájtra pontosan érintetlen marad; (4) `task-config.json` (nem `.md`) kimarad a merge-ből, a régi szabály alatt marad. 18/18 zöld. tsc tiszta.

**Határolás:** a Cybered által jelzett "két élő másolat ugyanahhoz a logikához" (gate-reconciler vs heartbeat-consolidated duplikáció) KÜLÖN probléma, nem ebben a kártyában oldva meg -- nem az én döntésem, melyik másolat az elsődleges, ezt külön jeleztem MikroB-nak.

**Ki döntött:** backend (kártya `4ba71429`, plan-grilling verdikt a kártya kommentjében, MikroB eredeti dispatch alapján, önjáró self-advance, 2 napnál régebbi kártya).

**Hivatkozás:** kártya `4ba71429`. Kapcsolódó tanulság: [[a-seed-refresh-only-heals-byte-identical-copies]] (memória).

## 2026-08-26 -- 2597e3b7 -- Load-guard hiszterezis-allapotgep + felvetel-fek bekotese (load-brake fazis, Feladat 1)

**Dontes.** A load-brake fazis (19f3bbb5, Peti altal jovahagyott URGENT terv, plan-grilling verdikt
a fazis-kartyan) Feladat 1-jenek hatralevo resze: `store/load-guard-eval.sh` (config+metrika ->
hiszterezis-debounce-olt WATCH/SOFT/HARD/CRITICAL allapot, `store/load-guard-state.json`-ba irva) +
`store/load-guard-check.sh` (vekony ADMIT/HOLD kapu callereknek, exit koddal). A hiszterezis
kettiranyu: felfele ES lefele is a cel-tier sajat `sustained_seconds`-jenek (config, alap 30mp)
kell stabilan fennallnia, mielott a megerositett allapot valtozik -- egy maganyos zajos mereses
sosem billenti at.

A `heartbeat-consolidated` (C szekcio, ELOKESZITES 5. pont + uj 2e lepes) es a `folyamatos-munka-
orchestrator` seed egyarant bekotve: HOLD eseten a 4. lepes nem dispatchel uj planned kartyat,
ugyanugy mint a mar letezo `newDevStopActive` (2d) mechanizmus, de kulon jelzovel a logban.

**Mellekesen talalt es javitott hiba.** A Feladat 1 elozo alfeladata (5574aeb2/2d27d8a1, mar
`done`) `store/load-guard-config.json`-t szallitott, de az sose kerult verziokezelesbe -- a blanket
`store/*` gitignore elnyelte, nem volt ra kulon `!store/*.json` negacio. Csak ebben a worktree-ben
letezett lemezen. Javitva ugyanebben a munkaban (`.gitignore` + a config commitolva).

**Miert.** Cel: gepterheles alatt a flotta NE dobja el a mar futo munkat, hanem fokozatosan
vegye vissza az UJ munka felvetelet -- Feladat 1 a legalacsonyabb kockazatu reteg (csak
megfigyeles + admission-brake, semmi mar-futo folyamatot nem erint). A megerositett-allapot
tervezes (nem egyetlen mereses) a card sajat szovege szerinti explicit kovetelmeny ("ne
villogjon").

**Konzekvencia.** Uj fajlok: `store/load-guard-eval.sh`, `store/load-guard-check.sh`,
`src/__tests__/load-guard-eval.test.ts` (13 teszt, hiszterezis mindket iranyban + tier-specifikus
debounce + PSI-tengely onmagaban is triggerelhet + ADMIT/HOLD kapu kulon tesztelve). 113/113 zold
(load-guard + shell-syntax-sweep egyutt), tsc tiszta, lint-ratchet valtozatlan (231 lelet).

**Ki dontott:** backend (kartya 2597e3b7, a fazis 19f3bbb5 plan-grilling verdiktje mar lefedte a
tervezesi kockazatokat, uj plan-grilling nem volt szukseges az implementaciohoz).

**Hivatkozas:** kartya 2597e3b7 (parent: ced63f7f, fazis: 19f3bbb5), elozo alfeladat 5574aeb2/2d27d8a1.

## 2026-08-26 -- edd8b398 -- Load-guard systemd timer (7mp ciklus), meglevo installer bovitve

**Dontes.** `store/load-guard-daemon.sh` (fut load-guard-eval.sh-t, csak ALLAPOT-VALTOZASKOR ir
store/load-guard.log-ba -- 7mp-es ciklusnal minden tick logolasa elarasztana a fajlt) + a MEGLEVO
`scripts/install-guard-timers.sh` write_service/write_timer sablonjaival egy uj `load-guard`
bejegyzes (7mp OnUnitActiveSec, journal-mod, mert a script sajat maga dontii el mikor ir a
log-fajlba). NEM uj installer-script -- a mar letezo, idempotens sablon bovitve, mint a masik negy
guard (channel-watchdog, stuck-modal-guard, disk-space-guard, token-health-guard).

**Talalt buktato, elkerulve.** Az installer futtatasat ELOSZOR a SAJAT worktree-mben probaltam --
ez a `INSTALL_DIR` erteket a worktree-re allitotta volna be, es a rendert unit `ExecStart` egy
SZEMELYES, eldobhato konyvtarra mutatott volna. Landolas UTAN, a live install (`/home/neon/marveen`)
konyvtarabol futtatva helyes.

**Miert.** A card sajat szovege szerint a heartbeat ~10 perces cron-ciklusa tul lassu lenne egy
load-tuskehez (mire a heartbeat eszlelne, a HARD/CRITICAL sajat sustained_seconds ablaka -- 20/30mp
-- mar reg lejart volna); ezert onallo, szoros ciklusu systemd timer kell, nem a heartbeat-be
epitve.

**Konzekvencia.** Uj fajl: store/load-guard-daemon.sh. Modositott: scripts/install-guard-timers.sh
(uj load-guard bejegyzes + enable-loop bovitese). 3 uj teszt (nincs-valtozas -> nincs log-sor,
tobb egymas-utani nem-megerositett tick -> nincs log-sor, megerositett atmenet -> pontosan EGY
log-sor). 101 store/*.sh szkript a szintaxis-sweepben (volt 100). tsc tiszta, lint-ratchet
valtozatlan.

**Ki dontott:** backend (kartya edd8b398, a fazis 19f3bbb5 plan-grilling verdiktje mar lefedte a
tervezesi kockazatokat).

**Hivatkozas:** kartya edd8b398 (parent: ced63f7f, fazis: 19f3bbb5), utolso alfeladat Feladat 1-ben.

## 2026-08-26 -- ec0e64b4 -- gate-dispatch-check.sh: Submitted-by override a NON_SUBMITTERS holtpont ellen

**Dontes.** Uj strukturalt mezo `store/gate-dispatch-check.sh`-ban: `Submitted-by: <agent>` egy
komment barmely (nem idezett/fence-elt) soraban a kommentet SUBMISSION-nak szamitja, MEG AKKOR IS,
ha a tenyleges komment-szerzo NON_SUBMITTER (gate-ugynok vagy mikrob). Csak a mezo JELENLETE
szamit, nem az ertek ellenorzese. A `_decide()`-ban a mezo-check az identitas-check UTAN (a sajat-
maganak-nem-armozhat szabaly valtozatlan), DE a NON_SUBMITTERS-kizaras ELOTT fut -- csak MENTHET
egy komментet, sose fojthat el egyet.

**Miert.** Valos incidens, kartya 034594e6: Cybersec irta a patchet, mikrob (assignee) postolta a
landolasi kommentet -- MINDKET lehetseges szerzo NON_SUBMITTER, tehat a regi szabaly szerint SOHA
egyetlen komment sem szamithatott volna submissionnak azon a kartyan, orokre ADVISE-SKIP:no-review-
n ragadva, akarmi is landolt valojaban. Cybersec sajat javaslata (msg 19692).

**Konzekvencia.** 6 uj selftest eset (real-shape 034594e6 + regresszios kontroll a mezo NELKUL +
gate-sajat-komment eset + fence/quote-vedelem ketszer + sajat-maganak-nem-armozhat kontroll).
119/119 selftest zold (volt 113). tsc tiszta, lint-ratchet valtozatlan, store-shell-scripts-sweep
101/101. A meglevo fleet-nudger-gate-skip-comment-scope.test.ts es kanban-gate-completeness-guard.test.ts
is zold marad (36/36), tehat a mas fajlok integracioja erintetlen.

**Ki dontott:** backend (kartya ec0e64b4, Cybersec javaslata alapjan, trivialis/jol-korulhatarolt
fix -- plan-grilling nem volt szukseges).

**Hivatkozas:** kartya ec0e64b4, forras-incidens 034594e6, korabbi rokon vedelem 02be824f/7405ca61.

## 2026-08-26 -- cleancore-tsc-lib.sh link_node_modules: nested pnpm workspace-symlink stale-read hiba

**Dontes:** javitottam a `link_node_modules` fuggvenyt (`store/cleancore-tsc-lib.sh`, a
`cleancore-land.sh` ES a `cleancore-pregate.sh` kozos meresi konyvtara). A regi valtozat egy TELJES
node_modules konyvtart szimlinkelt at a foklonbol (MAIN) a landolo worktree-be egyetlen szimlinkkel.
Ez ELTOR minden BENNE elo pnpm workspace-szimlinket (pl. node_modules/@cleancore/core -> relativ
../../../packages/core): egy relativ szimlink a SAJAT FIZIKAI helyehez kepest oldodik fel, nem
ahhoz kepest ahogy elertek -- es mivel a teljes konyvtar csak at van linkelve, a FIZIKAI hely
tovabbra is MAIN, tehat a beagyazott workspace-szimlink MAIN regi (nem a landolt merge-eredmeny)
masolatara mutat. Az uj valtozat egy szinttel beljebb megy: minden kozonseges bejegyzest tovabbra
is egyenkent szimlinkel MAIN-bol (nincs viselkedes-valtozas), de a `@cleancore/*` scope-olt
bejegyzeseket ujracelozza a worktree SAJAT masolatara, ha az letezik ott.

**Miert.** Elo incidens, kartya 87e5ad4d: a `hasForbiddenIdentityChars` export hozzaadasa
`packages/core/src/text-guard.ts`-hez REFUSED typecheck-et kapott a `cleancore-land.sh`-tol
("has no exported member"), pedig a merge-eredmeny valojaban tartalmazta az exportot -- kezi
reprodukcio `--traceResolution`-nel bizonyitotta, hogy az `apps/superadmin/tsconfig.json` (aminek
nincs `@cleancore/core` paths-bejegyzese) a `packages/control-plane/node_modules/@cleancore/core`
beagyazott pnpm-szimlinken keresztul MAIN regi `packages/core/src/index.ts`-jet olvasta, nem a
worktree merge-eredmenyet. Ez NEM az en valtoztatasom hibaja volt, hanem a meresi infra sajat
hibaja -- barmelyik jovobeli valtoztatas packages/core (vagy barmely tobbi @cleancore/* csomag)
exportjain HAMIS REFUSED-ot (uj export hozzaadasakor) VAGY -- rosszabb esetben -- HAMIS PASS-t
(export eltavolitasakor/torzitasakor, ha a regi MAIN-beli valtozat veletlenul meg mindig
"kompatibilis") kaphatott volna, amig egy pont eppen az `apps/superadmin` projekten (vagy barmely
mas, `@cleancore/core` paths-mappalas nelkuli projekten) mult.

**Konzekvencia.** Uj `--selftest` blokk kozvetlenul a `cleancore-tsc-lib.sh`-ban (korabban
egyaltalan nem volt tesztelve ez a fuggveny): 4 eset, valodi ideiglenes fajlrendszer-fixturaval
(nem csak string-osszehasonlitas) -- worktree-erintett workspace-csomag a WORKTREE masolatat
olvassa, worktree-erintetlen csomag tovabbra is MAIN-re esik vissza, kozonseges fuggoseg
valtozatlanul plain passthrough szimlink, es a "linked N node_modules" szamlalo-uzenet
valtozatlan. `cleancore-land.sh --selftest` 16/16 zold, `cleancore-pregate.sh --selftest` 5/5
zold. Kezi ujra-reprodukcio a valos 87e5ad4d merge-en (`d2119b9d` + `origin/main`) a javitassal:
mind az 5 TSC_PROJECTS projekt (`tsconfig.json`, `packages/control-plane/tsconfig.test.json`,
`packages/modules/workforce/tsconfig.test.json`, `apps/api/tsconfig.json`,
`apps/superadmin/tsconfig.json`) tisztan lefut, beleertve a korabban hamisan REFUSED-ot ado
`apps/superadmin`-t is.

**Ki dontott:** backend (kartya 87e5ad4d sajat landolasa kozben talalt, jol korulhatarolt,
tesztelheto infra-hiba -- a `Submitted-by:` fixhez hasonloan (kartya ec0e64b4) direkt javitva,
plan-grilling nem volt szukseges: sajat --selftest-tel fedett, egykonyvtaras bash-fuggveny, nem
architekturai dontes).

**Hivatkozas:** kartya 87e5ad4d, a hiba forrasa `store/cleancore-tsc-lib.sh` `link_node_modules`.

## 2026-08-26 -- 0becf86c -- ket handoff skill + taskstate-replay: nev-utkozes megszuntetve, a harmadik mechanizmus dokumentalva

**Elozmeny:** backend2 mar leszurte 2026-08-23-an (kartya 1d4cdcaa reviewje, DECISIONS.md fenti
bejegyzese "Nyitott, ebben a kartyaban NEM javitott leletek" resze), hogy ket `handoff` nevu skill
letezik ELTERO tartalommal, es a `taskstate-replay` harmadszor oldja meg ugyanazt a problemat --
sajat kartyara hagyva. Ez az a kartya (0becf86c).

**Meres:** `~/.claude/skills/handoff/SKILL.md` (fleet-sajat, `seed-skills/handoff`-bol telepitve,
2026-07-10 ota, kanban/memoria/napi-naplo API-hoz kotve) es `~/.claude/skills/mattpocock-productivity/handoff/SKILL.md`
(vendorolt, 2026-08-08, generikus, nincs flotta-integracio, OS temp dirbe ir) mindket frontmatter-je
`name: handoff` -- valodi nev-utkozes, nem csak tartalmi eltero. A vendorolt masolat `VENDORED.md`-je
explicit tiltja a helyi szerkesztest ("Local edits are lost on the next re-vendor"), es a
`vendor-skill.sh`-nak nincs per-sub-skill kizaras mechanizmusa (a teljes `mattpocock/skills/skills/productivity`
alkonyvtar egyben kerul at minden re-vendornel) -- tehat a vendorolt oldal NEM javithato es NEM
kizarhato, csak a sajat oldal.

**Dontes:** a fleet-sajat skillt atneveztem `handoff` -> `fleet-handoff`-ra (`seed-skills/fleet-handoff/`,
`name: fleet-handoff`, trigger `/fleet-handoff`), mert ez a sajat, verziokezelt oldal, ahol a nev
megvaltoztatasa strukturalisan (nem fegyelemmel) szunteti meg az utkozest -- fuggetlenul attol, hogy
a Skill-tool nev-felbontasa a ket globalis `handoff` bejegyzes kozott ambiguan viselkedne-e vagy sem
(ezt eleve nem erdemes tesztelni elo flotta-sessionon). A vendorolt masolat valtozatlan marad,
kanonikus a `fleet-handoff` marad az egyetlen szandekosan hasznalt kezi handoff-mechanizmus.

A `taskstate-replay` (`scripts/hooks/taskstate-replay.py` + `src/web/agent-taskstate.ts`) NEM
duplikatum, es NEM szunt meg: fundamentalisan mas mechanizmus mas problemara -- automatikus
PreCompact-iras/SessionStart-injektalas hook-par, UGYANAZON agent-identitas kompakt/respawn utani
amneziaja ellen, kezi trigger es `purpose` nelkul. A `fleet-handoff` viszont kezi, `purpose`-vezerelt,
MAS session/agent fele valo delegalasra valo. A ket mechanizmus kapcsolatat es kulonbseget a
`fleet-handoff/SKILL.md` uj "Relation to other persistence mechanisms" tablaja + magyarazo bekezdese
dokumentalja mostantol -- ez zarja le, hogy a harmadik mechanizmus miert marad meg valtozatlanul.

**Ki dontott:** backend (kartya 0becf86c, a mar 2026-08-23-an leszurt lelet vegrehajtasa).
**Hivatkozas:** kartya 0becf86c, elozo lelet: 1d4cdcaa reviewje (fenti bejegyzes ugyanebben a
fajlban). Erintett fajlok: `seed-skills/fleet-handoff/SKILL.md` (atnevezve `seed-skills/handoff/`-bol),
`ATTRIBUTIONS.md`.

## 2026-08-26 -- 25c35be7 -- 5 vendorolt skill VENDORED.md-je potolva, egy valos szunet-fut hivatkozas javitva

**F-1 (Cybersec, 1d4cdcaa gate, komment 19738):** ot vendorolt skillnek (idea-refine, interview-me,
documentation-and-adrs, doubt-driven-development, context-engineering) nem volt VENDORED.md-je.
Mind az addyosmani/agent-skills repobol jott (`store/adopted/addyosmani__agent-skills`, korabban
csak fetch-elve, kulon watch-clone volt mar). A `store/vendor-skill.sh`-t futtattam mind az 5-re;
negynel (idea-refine, interview-me, documentation-and-adrs, context-engineering) a telepitett
tartalom bajt-azonos volt a klon aktualis csucsaval (`5a5ea45e`), tehat oda pinneltem.

**doubt-driven-development kulon eset.** A diff kimutatta: a telepitett SKILL.md ELTER a klon
csucsatol -- pontosan az upstream `91d4d07` ("fix(skills): resolve references/ links from the
skill directory") commit altal erintett ket sorban. A telepitett valtozat a REGEBBI, `references/orchestration-patterns.md`
(sajat-relativ) format hasznalja; a csucs a `../../references/orchestration-patterns.md` (ket
szinttel feljebb mutato) format -- ami CSAK az upstream repo sajat elrendezeseben oldodik fel
(`references/` a repo gyokeren, `skills/<nev>/` alatta ket szinttel). A mi lapositott
`~/.claude/skills/<nev>/` telepitesunk egyiket sem elegiti ki onmagaban. Ezert:
- pinneltem az ELSO commitra, ami a skillt bevezette upstream (`7829ffd9`, 2026-07-26) -- ez
  EGYEZIK a mar telepitett tartalommal, tehat oszinte pin, nem talalgatas;
- helyileg bemasoltam a hianyzo `references/orchestration-patterns.md` fajlt a skill sajat
  `references/` alkonyvtaraba, igy a sajat-relativ hivatkozas (a pinnelt commit sajat formaja)
  tenylegesen felold valamit a lemezen -- korabban egyik forma sem oldott fel semmit.
- ez egy DOKUMENTALT kivetel a "VENDORED = ne szerkeszd" szabaly alol (a VENDORED.md sajat
  "Usage restriction" mezojebe irva), mert a re-vendor parancs a csucsra allna vissza es a
  hivatkozas ismet torne -- ezt a `store/vendor-skill.sh` sajat generalt "Re-vendor" blokkja is
  most mar `--ref`/`--note` nelkul irna ki (lasd lejjebb, ezt is javitottam).

**F-2 (Cybersec):** `idea-refine/SKILL.md` 22. sora `bash skills/idea-refine/scripts/idea-refine.sh`-t
hivott -- ez az upstream MONOREPO gyoker-relativ utja, nalunk (lapositott telepites) nem letezik
igy. A script maga trivialis (`mkdir -p docs/ideas`), ezert Cybersec ket opciot ajanlott: abszolut
ut VAGY a sor torlese. Abszolut utat valasztottam (`$HOME/.claude/skills/idea-refine/scripts/idea-refine.sh`),
mert megtartja a mukodo kenyelmi funkciot ahelyett hogy torolne -- kezzel futtatva ellenorizve
mukodik (`docs/ideas` letrejott, JSON-status visszaadva). Ugyanugy dokumentalva a VENDORED.md
"Usage restriction" mezojeben (ez a sor minden jovobeli re-vendor utan ujra-patch-elendo).

**Melleklelet, `store/vendor-skill.sh` sajat hibaja.** Mikozben a doubt-driven-development pin
`--ref`/`--note` ertekeit ellenoriztem, kiderult: a script generalta "Re-vendor" blokk SOHA nem
irta ki a `--ref`/`--note`-ot akkor sem, ha meg voltak adva -- egy naiv masolt-beillesztett
ujra-futtatas csendben a CSUCSRA allt volna vissza, pont azt a pinnelt/dokumentalt allapotot
torolve, amit epp az elobb rogzitettem. Javitva: a heredoc sablon most mar `${REF:+ --ref
$REF}${NOTE:+ --note \"$NOTE\"}`-t is beleszamolja. Kozben egy masodik, buvos bash-buktatot is
talaltam: `${NOTE:+ --note "$NOTE"}` (escapelt idezojel nelkul) egy heredocban a `"..."` idezojeleket
NEM literalisan adja ki -- a `${VAR:+szo}` parameter-kiterjesztes maga is dupla-idezett kontextusnak
szamit, tehat a beagyazott `"` karaktereket a bash levagja, nem irja ki. Csak `\"$NOTE\"` (escapelt)
adja ki a szo szerinti idezojeleket. Ujra-futtatva a doubt-driven-development pin-parancsot a
javitott scripttel igazolva: a kiirt "Re-vendor" sor most mar masolhato-futtathato allapotban all.

`src/__tests__/store-shell-scripts-syntax-sweep.test.ts`: 101/101 zold a javitas utan.

**Ki dontott:** backend (kartya 25c35be7, Cybersec F-1/F-2 leletenek vegrehajtasa; a
`vendor-skill.sh` re-vendor-parancs hianya es az idezojel-buktato sajat, a munka kozben talalt
lelet, kozvetlenul ugyanahhoz a valtoztatashoz kapcsolodik).
**Hivatkozas:** kartya 25c35be7, elozo lelet forrasa: 1d4cdcaa gate, komment 19738.

## 2026-08-26 -- 9fcc6391 -- Due-diligence jelolt-tablazat: a licenc most mar dokumentaltan az elso ertekelt oszlop

**Elozmeny.** backend2 ket egymast koveto adoptalasi kartyan (`e7510a83`, `ef9a7bf1`, mindketto
2026-08-23, fenti bejegyzesek ugyanebben a fajlban) mérte: a legjobb jelolt mindket alkalommal a
licencen bukott el, MIUTAN mar erdemi ertekelesi munkat fektettek bele. A tenylegesen keszult
tablazatokban (mindket bejegyzesben ellenoriztem) a `licenc` oszlop mar most is kozvetlenul a
jelolt-nev utan all, csillag ELOTT -- a hiba tehat nem a konkret tablazat oszlop-sorrendje volt,
hanem hogy ez sehol nem volt LEIRVA, kikényszerítendő konvenciokent: egy jovobeli agens ujra
felfedezhette volna a hibat, mert semmilyen skill nem rogzitette a mintat.

**Kereses:** vegignéztem az osszes ~/.claude/skills/*/SKILL.md-t "csillag"/"jelölt"/"due diligence"
kulcsszora -- SEHOL nem talaltam meglevo jelolt-osszehasonlito tablazat-sablont. A `fork-adopt-investigation`
skill (a legkozelebbi talalat, root CLAUDE.md rule 10 hivatkozza) 6. lepese csak prozaban sorolta
fel a due-diligence szempontokat, tablazat-sablon nelkul.

**Dontes:** a `fork-adopt-investigation/SKILL.md` 6. lepeset kibovitettem egy konkret markdown
tablazat-sablonnal (`jelölt | licenc | csillag | utolsó push | verdikt`, ebben a sorrendben), plusz
egy uj Pitfalls-tetel ("License-last trap"), mindketto kifejezetten a licencet teszi az ELSO
ertekelt oszlopa, a csillag/karbantartas ele -- igy egy inkompatibilis jelolt mar a tablazat
kitoltesenek elejen kiesik, mielott erdemi (vagy meg rosszabb: integracios) munka menne bele.
Hivatkozva `e7510a83`/`ef9a7bf1` mert konkret, ismetelt precedens.

**Ki dontott:** backend (kartya 9fcc6391, backend2 2026-08-23-i megfigyelesenek vegrehajtasa).
**Hivatkozas:** kartya 9fcc6391, elozo lelet: `ef9a7bf1` reviewje (fenti bejegyzes ugyanebben a
fajlban). Erintett fajl: `seed-skills/fork-adopt-investigation/SKILL.md`.

## 2026-08-26 -- 5a056db8 -- activity-log hook: heredoc-commit dedup a valos uzenetbol, nem a konstans flag-sorbol

**Problema:** a `_command_verb()` "git commit" aga csak az EGY SORNYI szoveget nezte a "commit" utan
(`re.search` DOTALL nelkul), tehat `git commit -q -F - <<'TAG'` (mikrob sajat quiet-commit mintaja)
vagy `git commit -m "$(cat <<'TAG' ...)"` (backend sajat, ebben a sessionben is hasznalt mintaja)
eseten a talalat mindig a NYITO heredoc-sor volt ("-q -F - <<'TAG'"), sosem a nehany sorral lejjebb
allo tenyleges commit-uzenet. Mivel ez a szoveg minden ilyen commitnal AZONOS, minden ilyen commit
byte-azonos osszefoglalo-sort irt a hot/warm memoriaba. A `-q` a git sajat SHA-kiirasat is elnyomja,
tehat a mar meglevo SHA-utotag (response_text-bol regex) sem potolta a kulonbseget. Merve (Dream
Engine, 2026-08-24 06:15): a fix (34f1ca0c, 2026-08-22) landolasa OTA 175 uj, es egyetlen napon 140
pontosan-duplikalt hot/warm sor keletkezett, mind ebbol a mintabol.

**Dontes:** a masodik javaslat (destination='log') helyett a GYOKER-okot javitottam: uj regex
(`re.DOTALL`) a "git commit" agban, ami a heredoc NYITO markeret felismeri es a ZARO tag-ig tartó
BODY-t vonja ki (whitespace-osszecsukva, 60 karakterre vagva) -- ez mindket elofordulo alakra
(`-F - <<TAG`, `-m "$(cat <<TAG ...)"`) mukodik, es a valodi, egyedi commit-uzenet kerul az
osszefoglaloba a konstans flag-sor helyett. Ez erdemben jobb mint a log-ra terelés: a
kereshetoseg megmarad (egy kesobbi session tenylegesen visszakeresheti a commitot a sajat
uzenete alapjan), nem csak eltunik a dupla-sor tunet.

**Ellenorzes:** 2 uj selftest-eset (`activity-memory-capture.selftest.py`) -- ket kulonbozo
heredoc-uzenet nem termelhet azonos osszefoglalot, es a `-m "$(cat <<TAG ...)"` alak is a valodi
uzenetet adja vissza; mindket eset newline-mentes egysoros kimenetet is ellenoriz. 20/20 selftest
+ 24/24 `activity-hook-redaction.test.ts` zold.

**Ki dontott:** backend (kartya 5a056db8, Dream Engine 2026-08-24 06:15-os javaslatabol
kartyasitva Peti kerésere).
**Hivatkozas:** kartya 5a056db8, elozo fix: 34f1ca0c. Erintett fajlok:
`scripts/hooks/activity_memory_capture.py`, `scripts/hooks/activity-memory-capture.selftest.py`.

## 2026-08-26 -- 268b257a -- "How is Claude doing?" felmérés strukturálisan kikapcsolva minden ágens-spawnon

**Probléma:** a Claude Code CLI saját, session-közbeni "How is Claude doing this session?"
visszajelző-dialógusa (1: Bad, 2: Fine, 3: Good, 0: Dismiss) 2026-08-26-án 7+ alkalommal jelent
meg backend és backend2 tmux-paneljén, ismételten egy 529 Overloaded API-hiba után, és NEM lépett
tovább magától -- addig nem dolgozta fel az új inbound üzeneteket (ütemezett feladat, inter-agent
üzenet, Telegram-forgalom), amíg MikroB kézzel be nem küldte a '0' billentyűt tmux send-keys-szel.
A meglévő `scheduleIdentitySetup` (agent-process.ts) csak a RESTART-utáni resume/survey-modalt
dismisszelte egy 8 másodperces késleltetett próbával -- a MID-SESSION, 529-triggerelt
felugrásra semmi nem figyelt.

**Vizsgálat:** a kártya két irányt javasolt -- (1) settings/env kapcsoló keresése a felmérés
kikapcsolására, (2) ha nincs, egy tmux-panelfigyelő watcher-script, ami a mintát felismerve
automatikusan '0'-t küld. A pinned CLI-bináris (`~/.local/share/claude/versions/2.1.246`)
`strings`-elésével MEGTALÁLTAM a valós kapcsolót: `if(mt.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)
return!1` az egész felmérés-eligibility-ellenőrzést (`de(...)` eligibility-függvény) rövidre
zárja -- a `mt` objektum ugyanaz a minta, amit más dokumentált `CLAUDE_CODE_*` env-kapcsolók is
használnak (pl. `CLAUDE_AFK_TIMEOUT_MS`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`), tehát ez egy
valós, hivatalos env-kapcsoló, nem talált string.

**Döntés:** az 1. irányt választottam a 2. helyett -- egy env-var export az ágens tmux-spawn
parancsba (`src/web/agent-process.ts`, ugyanabban a mintában mint a már meglévő
`DISABLE_AUTOUPDATER=1`/`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`), NEM egy külön
watcher-script. Strukturálisan jobb: a dialógus SOHA nem nyílik meg (sem restart-kor, sem
mid-session, sem semmilyen jövőbeli trigger-mintánál), tehát a `scheduleIdentitySetup`
resume-modal-dismiss ága is feleslegessé válik erre a konkrét felmérésre nézve (érintetlenül
hagyva, mert más resume-modalokat is kezel).

**Ellenőrzés:** 2 új teszt (`channel-stability-contract.test.ts`, "P1#5"), mind a
`channel-deafness-recovery.test.ts` ordering-asszerciói (`MCP_SERVER_CONNECTION_BATCH_SIZE`
pozíció a `--channels` előtt) zöldek maradtak az új env-export beszúrása után, tsc tiszta.

**Ki döntött:** backend (kártya 268b257a, Peti kérésére 2026-08-24-i Telegram-jelzésből
kártyásítva).
**Hivatkozás:** kártya 268b257a. Érintett fájlok: `src/web/agent-process.ts`,
`src/__tests__/channel-stability-contract.test.ts`.

## 2026-08-26 -- 12783b1e verziószámláló automatizálva: minden marveen-land.sh landolás bumpolja

**Döntés:** Peti kérésére (Telegram, 2026-08-26 18:22 "Frissítéskor emeled a verzió számot?", 18:26
"Automatizáld és landoláskor legyen automatikus. Válaszd ki a megfelelő megoldást erre!") a
`package.json` `X.Y.Z+mikrob.N` számlálója mostantól AUTOMATIKUSAN nő minden `marveen-land.sh`
landoláskor, kézi lépés nélkül. Új `store/bump-fork-version.sh` (önálló, `--selftest`-elhető,
`decisions-append-union.sh` mintájára), bekötve `marveen-land.sh` `land_one()`-be a seam-check után,
`fleet-test` előtt, csak nem `--dry-run` esetén. NON-FATAL by construction (mint a
blast-radius/graphify hívások): egy verzió-bump hiba SOHA nem állíthatja meg egy valódi landolást.
A `package-lock.json` root-verzióját (top-level + `packages[""].version`) is együtt szinkronizálja
`X.Y.Z`-re, szuffix nélkül -- ez a már meglévő `package-lock.json`-konvenciót követi, nem új döntés
(mellékesen orvosolja azt is, hogy `package-lock.json` a mai napig `1.33.0`-n állt, míg
`package.json` már `1.34.0`-n).

**Miért ez a lépés, nem csak dokumentáció:** a kézi folyamat (12783b1e eredeti szövege,
"Jelenleg kézi folyamat") a gyakorlatban NEM működött -- mérve 2026-08-26: `1.34.0+mikrob.1`
változatlan maradt egy egész napnyi fork-saját landolás alatt (tucatnyi kártya), miközben Peti a
dashboardon még a `v1.33.0+mikrob.1`-et látta 08-25 20:45-ös frissítési időbélyeggel.

**Bootstrap-rés (dokumentálva, nem hiba):** az AUTOMATIZÁCIÓT bevezető landolás saját magát a RÉGI
(bump nélküli) kóddal landolta -- egy futó bash-folyamat a `land_one()` függvényt indításkor tölti
be, nem a menet közben mergelt worktree-ből. A KÖVETKEZŐ landolás (ez a bejegyzés) már az ÚJ kódot
futtatja, és ez maga a bizonyíték: e commit landolásakor a `package.json`/`package-lock.json`
verziója már automatikusan bumpolódik.

**Ki döntött:** Peti (automatizálás jóváhagyása + a megoldás kiválasztásának delegálása) + MikroB
(tervezés: hova kössem be, mikor legyen fatal/non-fatal, package-lock.json együtt-szinkronizálás).
**Hivatkozás:** kártya `667307a2`, kapcsolódó korábbi szabály `12783b1e`. Commit: `ea8b9b95`
(bevezető, a régi koddal landolva), ez a bejegyzés (első landolás az ÚJ automatikával).

## 2026-08-26 -- d7a28a0a -- Load-guard cgroup cpu.max fékezés (load-brake fázis, Feladat 2)

**Döntés.** A `hard` állapot `cgroup_throttle` akcióját (eddig csak logolva, sose fogyasztva) ténylegesen
kiszolgáló réteg: `store/load-guard-cgroup-target.sh` (valós forrás: futó `agent-*` tmux-session ->
cgroup-scope feloldás + kanban-prioritás lekérdezés a célválasztáshoz, nem tesztelt közvetlenül --
ugyanaz a szerep mint `load-guard-read.sh`-nak) + `store/load-guard-cgroup-apply.sh` (tiszta
döntési/cpu.max-író réteg, teljes tesztlefedettséggel, `--target-json` injektálva -- ugyanaz a
szerep mint `load-guard-eval.sh`-nak) + `store/load-guard-cgroup.sh` (vékony összekötő, önjavító
cpu-delegáció-bekapcsolással). `store/load-guard-daemon.sh` egy ÚJ, alapból KIKAPCSOLT `--cgroup`
flaget kapott (csak akkor hívja a fenti láncot, ha explicit átadva) -- kizárólag azért, hogy a
MEGLÉVŐ, zöld Feladat 1 daemon-tesztek egy karakterrel se változzanak (nulla regressziós kockázat);
élesben a flaget `scripts/install-guard-timers.sh` ExecStart-ja adja át.

**KOCKÁZAT #4 (a fázis-kártya plan-grilling verdiktjének nyitott pontja) MÉRVE, LEZÁRVA.** A cgroup
v2 `cpu` kontroller ezen a WSL2 gépen NEM volt delegálva `app.slice` alá (`cgroup.subtree_control`
csak `memory pids`-t tartalmazott ott) -- de egy sima felhasználói (uid 1000) `echo +cpu >
.../app.slice/cgroup.subtree_control` írás SIKERESEN bekapcsolta, utána minden `tmux-spawn-*.scope`
(egy-egy ügynök tmux-panelje) megkapta a `cpu.max` fájlt. A `load-guard-cgroup.sh` ezt minden tickben
önjavítóan újra-ellenőrzi (idempotens, sose fatal), mert a delegáció egy újrainduló user-session után
elveszhet.

**Kizárás KÓD-SZINTEN hardkódolva** (`load-guard-cgroup-target.sh` `EXCLUDED_SESSIONS` tömb + `mikrob*`
prefix-egyezés), a fázis-kártya KOCKÁZAT #2 mitigációja szerint NEM konfigurálható: `agent-qa`,
`agent-cybersec`, `agent-cybered` + minden `mikrob*` session. **Eltérés a kártya szó szerinti
szövegétől, explicit felszínre hozva:** a kártya prózája csak `qa`-t nevez meg, `qa2`-t nem -- a
`agent-qa2` mégis bekerült a kizárásba, mert a root CLAUDE.md 4/6a szabálya a QA-t és QA2-t
egyenrangú gate-tagként kezeli (terheléskiegyenlítés ugyanazon jogkörrel). Gate ellenőrizze ezt a
döntést, nem hallgatólagos.

**Célválasztás:** a futó, nem-kizárt `agent-*` session-ök közül az, akinek a `in_progress` kanban
kártyája a legalacsonyabb prioritású (nincs aktív kártya < low < normal < high < urgent);
degraded-mód (kanban API elérhetetlen) esetén ábécé-sorrend első futó jelöltje, `"degraded": true`
jelzéssel -- nincs kitalált, kérés nélküli role-rangsor.

**Kill-switch** (KOCKÁZAT #3 mitigáció): `load-guard-config.json` `cgroup_throttle.enabled` (alap
`true`); `false`-ra állítva a legközelebbi tick azonnal felold minden aktív fékezést.

**Konzekvencia.** Új fájlok: `store/load-guard-cgroup-target.sh`, `store/load-guard-cgroup-apply.sh`,
`store/load-guard-cgroup.sh`, `src/__tests__/load-guard-cgroup.test.ts` (10 teszt: alkalmazás,
feloldás, célváltás, kill-switch, `sigstop_freeze`-nél sincs fékezés-kontroll). Módosított:
`store/load-guard-config.json` (`cgroup_throttle` blokk), `store/load-guard-daemon.sh` (`--cgroup`
flag), `scripts/install-guard-timers.sh` (ExecStart bővítve). A meglévő 16 Feladat-1 teszt
változatlanul zöld. tsc tiszta.

**Ki döntött:** backend (kártya d7a28a0a, a fázis 19f3bbb5 plan-grilling verdiktje már lefedte a
tervezési kockázatokat, KOCKÁZAT #4-et ez a kártya volt hivatva lezárni).

**Hivatkozás:** kártya d7a28a0a (parent: 19f3bbb5, függőség: ced63f7f/Feladat 1, már done).

**2026-08-26, utólagos javítás (Cybersec NO-GO, Gate-SHA 97634d17, komment 16566):** a
`load-guard-cgroup-target.sh` `is_excluded()`-jében a `mikrob*` glob HOLT KÓD volt: a hívó
felfedező hurok már `[[ "$session" == agent-* ]]`-ra szűr, MikroB tényleges tmux-session-nevei
(`mikrob-channels`/`mikrob-worker`/...) pedig SOHA nem `agent-` prefixűek, tehát ilyen bemenet
sosem éri el az `is_excluded()`-en belüli `mikrob*` ágat -- élesben a védelem csak VÉLETLENÜL
működött, a jelenlegi elnevezési konvenció miatt, nem a kimondott biztosíték miatt. Cybersec élőben
reprodukálta (`agent-mikrob`/`agent-mikrob-channels` NEM lett kizárva a javítás előtt). Javítás:
`is_excluded()` mostantól `mikrob* VAGY agent-mikrob*`-ot is néz, plusz egy `--test-excluded`
teszt-hook + 4 új automatizált teszt (`load-guard-cgroup.test.ts`), ami pontosan ezt a bemenetet
fedi le -- eddig a valós tmux/kanban discovery egyáltalán nem volt tesztelve (a teszt fájl saját
fejléce is kimondta ezt), ez zárja azt a rést is. 14/14 teszt zöld, tsc tiszta.

## 2026-08-26 -- 3e094b1e/386d4613 -- Local-LLM offload-batch: mechanikus-első sorrend + BLOKKOLT-szűrés

**Mit döntöttünk:** `store/offload-batch-run.sh` jelölt-kiválasztása eddig `in_progress`-first,
majd `urgent>high>normal>low` sorrendben állt a `planned` kártyákra is, `CAP=20`-szal korlátozva a
próbálkozások (nem a sikeres draftok!) számát. Ez a `planned` kártyák körében MINDIG a legkevésbé
lokál-eligible (URGENT/HIGH, jellemzően architekturális) kártyákat próbálja ki előbb, mielőtt egy
tényleg mechanikus LOW kártyához érne. Élő mérés (3e094b1e audit, alfeladat f8c72a5a): a mai
06:15-ös batch 69 jelöltből 20-at próbált (a CAP-ig), MIND a 20 "no local-eligible parts" -- ZÉRÓ
draft. Ugyanakkor egy kézi próba egy, a 20-as körből kimaradt LOW kártyán (6dad1830, egyszerű
timeout-emelés) másodpercek alatt sikeres helyi draftot adott -- a router és a modell működik, csak
a próbálkozási SORREND célozta rosszul.

**Mit változtattunk (`386d4613`, sebészi):**
- a `planned` kártyák rendezése mostantól MECHANIKUS-ELSŐ (low elsőként), NEM urgent-first --
  az `in_progress` kártyák sorrendje változatlan (urgent-first, az aktív munka azonnali draft-
  segítséget érdemel a komplexitástól függetlenül);
- `BLOKKOLT-*` címkéjű kártyák kizárva a jelöltekből (ugyanaz a konvenció mint `store/fleet-nudger.sh`-ban)
  -- egy párkolt kártyát ma senki nem tud felhasználni, a CAP-ból elvett hely felesleges;
  - `ATTEMPTED`/`DRAFTED` szétválasztva: a régi `"$done cards drafted"` sor valójában a
  PRÓBÁLKOZÁSOK számát írta ki draft-ként (a mai 0-draftos éjszaka is "20 cards drafted"-et logolt) --
  most a napló `attempted=N drafted=M` formában mondja ki mindkettőt, a `--status` visszamenőleg
  kompatibilis marad (a `drafted=` kulcs a sor VÉGÉN maradt).
- új `--test-select` CLI-hook + a valós és a teszt út UGYANAZT a `SELECT_PY` változót futtatja
  (nincs duplikált/eltérő logika) + 5 új teszt (`offload-batch-select.test.ts`), ami a mért
  éhezési forgatókönyvet is reprodukálja (25 urgent + 1 low planned kártya -> a low megy elsőnek).

**Ki döntött:** backend (kártya 3e094b1e, Peti sürgős kérése 2026-08-24, alfeladat 386d4613).

**Hivatkozás:** kártya 3e094b1e (parent), 386d4613 (a refaktor-alfeladat), f8c72a5a (a mérés-alfeladat,
ahol a talalat szuletett).

## 2026-08-26 -- 3e094b1e/896dfffc -- Ollama-down guard: azonnali Telegram-riasztás kiesésnél

**Mit döntöttünk:** a mai kiesés (00:07-04:52 CEST) órákig ismeretlen maradt, mert az `ollama_up`
állapot kizárólag a dashboard-csempén látszott -- senki nem lett figyelmeztetve. Új, önálló
systemd --user timer (`scripts/ollama-down-guard.sh`, 5 percenként), a meglévő
`scripts/disk-space-guard.sh` mintáját követve pontosan: DIREKT Bot API riasztás (nem függ az
in-session MCP plugintól), csak MEGERŐSÍTETT kézbesítés után íródik ki a cooldown-bélyeg (1 óránként
legfeljebb egy riasztás, amíg le van állva), és a felépülés törli a bélyeget (a következő kiesés
azonnal újra riaszt, nem a régi cooldown-ablakon belül marad csendben). Az `ollama_up()` a
`store/local-llm.sh` saját függvényét tükrözi (ugyanaz a `curl .../api/tags` ellenőrzés), nem
`source`-olva onnan, mert az a szkript nem source-biztos (egy valódi generálást futtatna le).

**Ki döntött:** backend (kártya 3e094b1e, alfeladat 896dfffc, Peti sürgős kérése 2026-08-24, item 6).

**Aktiválás:** `scripts/install-guard-timers.sh`-be bekötve (`ollama-down-guard`, a token-health-guard
minta szerint) -- az ÉLES aktiváláshoz a landolás UTÁN az élő telepítésből (nem a worktree-ből)
újra kell futtatni, ugyanúgy mint a d7a28a0a kártya `--cgroup` flagjénél (a git pull önmagában nem
frissíti a systemd unit-fájlokat).

**Tesztek:** 10 új (`scripts/__tests__/ollama-down-guard.test.sh`, ugyanaz a bash-natív minta mint
`disk-space-guard.test.sh` -- ez a szkript-osztály nincs a vitest fleet-test.sh alatt, kézzel futtatva
lett ellenőrizve, a meglévő testvér-guardok konvenciója szerint).

**Hivatkozás:** kártya 3e094b1e (parent), 896dfffc (ez az alfeladat).

## 2026-08-26 -- 77075367 -- Stale-dist gap: landoláskori WARNING + build-freshness riasztó guard, NEM auto-rebuild/restart

**Döntés.** A `store/marveen-land.sh` szándékos tervezési döntése (a script saját fejléc-kommentje
szerint) hogy egy landolás soha nem épít újra és soha nem indít újra semmit -- ez marad az
`./update.sh` + Peti jóváhagyás külön, tudatos kapuja. Ez a döntés önmagában helyes maradt, DE a
kártya egy valós következményt mért: `f0389e81` (egy gate-elt, kész biztonsági javítás) landolt, de
kb 1 óráig senki nem tudta, hogy a futó `mikrob-channels`/`mikrob-dashboard` még a régi buildet
szolgálja ki -- csak Cybersec saját, magánjellegű élő újratesztje buktatta le. A hiányzó darab tehát
nem az újraépítés hiánya volt (az szándékos), hanem hogy a RÉS néma maradt.

**Miért NEM auto-rebuild/restart.** (1) A `mikrob-channels` szolgáltatás a Petivel folyó AKTUÁLIS
beszélgetést hordozza -- egy autonóm újraindítás elveszítheti a kapcsolatot úgy, hogy a hiba
jelzésére használt csatorna maga hallgat el (kötött szabály, lásd memória:
never-restart-own-channel-without-confirmation). (2) Ez összhangban áll `marveen-land.sh` saját,
már meglévő tervezési döntésével is. Ezért a fix STRUKTURÁLIS LÁTHATÓSÁG, nem automatikus javítás.

**Megvalósítás.** Két darab, egyik sem épít újra és egyik sem indít újra semmit:
1. `store/marveen-land.sh`: `land_one` a sikeres landolás kimenetén egy WARNING sort ír, ha a landolt
   diff `src/`-t érint -- pont akkor, amikor egy ügynök/ember már úgyis nézi a kimenetet.
2. `scripts/build-freshness-guard.sh` (új, 5 perces systemd timer, a `disk-space-guard.sh`/
   `ollama-down-guard.sh` mintáját követve: direkt Bot API, csak megerősített kézbesítés után íródik
   a cooldown-bélyeg, a felépülés törli a bélyeget): a legfrissebb `src/`-t érintő commit ideje
   (`git log`, NEM fájl-mtime) a `dist/*.js` legfrissebb mtime-jával összevetve, 5 perces build-idő
   türelmi ablakkal a hamis riasztás ellen.

**Élő mérés bevezetéskor.** `BUILD_GUARD_REPO_DIR=/home/neon/marveen` ellen futtatva a guard
valódi ~75 perces elavulást talált az éles telepítésen -- ez maga is a kártya problémáját igazolja.
Nem javítottam magától (az élő telepítés újraépítése/újraindítása Peti/MikroB döntése), csak
jelezve.

**Ki döntött:** backend (kártya 77075367, Cybersec 2026-08-24-i élő ujratesztjenek kovetkezmenye).

**Tesztek:** 19/19 zöld (`src/__tests__/agent-worktree-marveen.test.ts`, 2 új eset a
marveen-land.sh WARNING sorára + egy `commitInWorktree` beágyazott-útvonal javítás, ami ezekhez
kellett), 12/12 zöld (`scripts/__tests__/build-freshness-guard.test.sh`, új, bash-natív, a
testvér-guardok konvenciója szerint kézzel futtatva). tsc --noEmit tiszta.

**Aktiválás:** `scripts/install-guard-timers.sh`-be bekötve (`build-freshness-guard`) -- az ÉLES
aktiváláshoz a landolás UTÁN az élő telepítésből újra kell futtatni, ugyanúgy mint az
`ollama-down-guard`-nál.

**Hivatkozás:** kártya 77075367.

## 2026-08-26 -- 2bfbf805 -- Load-guard SIGSTOP/SIGCONT veszfagyasztás (load-brake fázis, Feladat 3)

**Döntés.** A `critical` állapot `sigstop_freeze` akcióját (eddig csak logolva/CONTROL-tesztelve
mint "nem csinál semmit", lásd load-guard-cgroup.test.ts sajat CONTROL esete) ténylegesen
kiszolgáló réteg: `store/load-guard-sigstop-target.sh` (valós forrás: futó `agent-*` tmux-session ->
pane pid + kanban-prioritás, ugyanaz a szerep mint `load-guard-cgroup-target.sh`-nak, DE a
kiválasztás rang+körforgás-logikája -- nem csak a valós tmux/kanban felfedezés -- kiemelve
`SELECT_PY`-ba és `--test-select`-tel tesztelve, mert az már valódi eldönthető logika, nem
felfedezés) + `store/load-guard-sigstop-apply.sh` (tiszta döntési/jel-küldő réteg, valós spawnolt
folyamatokkal tesztelve) + `store/load-guard-sigstop.sh` (vékony összekötő -- cgroup-delegációhoz
hasonló önjavítás itt nem kell, sima szignál egy már saját tulajdonú pid-re).

**Kizárás megosztva, nem duplikálva.** `is_excluded()` kiemelve `store/load-guard-cgroup-target.sh`-
ból egy közös `store/load-guard-excluded.sh`-ba, amit mindkét fékezés-mechanizmus forrás
(`source`)-ol. Két külön másolat pont azt a driftet nyitná meg, amit a kizárás meg akar
akadályozni -- ha valaki a jövőben csak az egyik példányt bővíti egy új gate-taggal, a másik
mechanizmus némán védtelen maradna rá.

**Körforgás, NEM ábécésorrend** (a kártya saját szövege, tudatos eltérés a Feladat 2 mintájától:
"korforgasos celpont-valasztas a tobbi kozott"). A rangsorolás (legalacsonyabb `in_progress`
prioritás nyer, nincs-kártya a low alatt rangsorol) változatlan Feladat 2-től, csak a HOLTVERSENYEN
BELÜLI kiválasztás körforgásos: egy kis állapotfájlban megőrzött "utoljára választott" mutató után
következő jelölt nyer, körbefordulva. Egyetlen jogosult jelöltnél elfajul "mindig ugyanaz"-zá --
elkerülhetetlen, nem hiba.

**MAX 90 MÁSODPERCES KÉNYSZER-FELOLDÁS** (a kártya saját szövege, Peti által már jóváhagyott
hálózati timeout tradeoff): minden tick ELSŐ, feltétel nélküli ellenőrzése -- egy fagyasztott pid,
aminek a `max_freeze_seconds` (config, alap 90) lejárt, AZONNAL felold, még ha az akció ezen a
ticken is `sigstop_freeze` maradna. Ez a tick nem fagyaszt újra; a KÖVETKEZŐ tick dönt frissen (a
körforgás így legalább egy tick szünetet ad, és holtverseny esetén el is mozdulhat egy másik
jelöltre).

**Önvédelem (védelem-mélységben).** A jel-küldő réteg SOHA nem jelez pid 0-nak, 1-nek, vagy a saját
process-ének, függetlenül attól, mit állít egy target-json -- a valódi kizárás a célválasztásban él,
ez csak egy olcsó, megéri-e biztosíték, mert az apply-réteget a saját tesztje is közvetlenül,
injektált target-json-nal hívja (ugyanúgy mint a cgroup-apply.sh sajátja).

**Kill-switch:** `load-guard-config.json` `sigstop_freeze.enabled` (alap `true`); `false`-ra
állítva a legközelebbi tick azonnal felold minden aktív fagyasztást.

**Konzekvencia.** Új fájlok: `store/load-guard-excluded.sh`, `store/load-guard-sigstop-target.sh`,
`store/load-guard-sigstop-apply.sh`, `store/load-guard-sigstop.sh`,
`src/__tests__/load-guard-sigstop.test.ts` (18 teszt: alkalmazás, feloldás, célváltás, kill-switch,
a 90s kényszer-feloldás, önvédelem pid 0/1 ellen, rang+körforgás célválasztás). Módosított:
`store/load-guard-cgroup-target.sh` (is_excluded kiemelve), `store/load-guard-config.json`
(`sigstop_freeze` blokk), `store/load-guard-daemon.sh` (`--sigstop` flag, `--cgroup`-tól
független), `scripts/install-guard-timers.sh` (ExecStart `--cgroup --sigstop`-ra bővítve). A
meglévő 30 load-guard teszt (eval + cgroup) változatlanul zöld -- a cgroup CONTROL teszt, ami
szerint `sigstop_freeze` önmagában nem érinti a cpu.max-ot, továbbra is érvényes (külön
mechanizmus). tsc tiszta.

**Ki döntött:** backend (kártya 2bfbf805, a fázis 19f3bbb5 plan-grilling verdiktje már lefedte a
tervezési kockázatokat, új plan-grilling nem volt szükséges -- a max-90s tradeoff már Peti által
jóváhagyva a kártya szövegében).

**Hivatkozás:** kártya 2bfbf805 (parent: 19f3bbb5, függőség: d7a28a0a/Feladat 2, már done).

## 2026-08-26 -- 1128002b -- Load-guard bookkeeping + stuck/redispatch integráció + ismétlődés-riasztás (Feladat 4, fázis zárása)

**Döntés.** A load-brake fázis (19f3bbb5) utolsó darabja: egy cgroup-fékezett vagy SIGSTOP-
fagyasztott ügynök `in_progress` kártyája addig ugyanugy nezett ki, mint egy valóban beragadt --
a `stuck-card-monitor` és `store/redispatch-guard.sh` nem tudta megkülönböztetni "szándékosan
szüneteltetve terhelés miatt"-ot "halott"-tól, tehát egy fagyasztott ügynök kártyáját elméletileg
re-dispatchelhette/nudge-olhatta volna a fagyasztás alatt.

**Megvalósítás.** `store/load-guard-bookkeeping.sh`: tiszta JSON diff/döntési réteg
(`--test-compute`, ugyanaz a minta mint `load-guard-sigstop-target.sh` `--test-select`-je) --
beolvassa mindkét mechanizmus állapotfájlját (`load-guard-cgroup-state.json`,
`load-guard-sigstop-state.json`), diffeli az előző tick pillanatképéhez, és
`store/load-paused-agents.json`-t ír -- ez az EGYETLEN marker-fájl, amit mindkét integrációs pont
figyel. Egy mechanizmus-váltás fagyasztás közben (cgroup_throttle eszkalál sigstop_freeze-re) a
FOLYTATÁSA a szünetnek, nem egy resume+újra-pause -- a `card_id`/`since` megmarad az eredeti
pause-kezdéskor rögzített értéken.

**Minden valós pause-start/resume-nál:** INFO-ONLY `PAUSED-LOAD`/`RESUMED-LOAD` kanban-komment az
ügynök `in_progress` kártyáján (INFO-ONLY, hogy `store/gate-dispatch-check.sh` sose nézze
review-nak, lásd az `info-only-prefix-for-non-review-card-comments` memória-konvenció). Rutin
pause/resume CSAK log/komment -- Telegram KIZÁRÓLAG ismétlődő fagyasztásnál megy (ugyanaz az
ügynök >= `alert_repeat_threshold` [alap 2] alkalommal egy gördülő `alert_window_seconds` [alap
3600] ablakban), `alert_cooldown_seconds` (alap 3600) cooldown-nal, megerősített-kézbesítés-utáni
bélyeggel -- ugyanaz a minta mint `disk-space-guard.sh`/`ollama-down-guard.sh`.

**Integráció:**
- `store/redispatch-guard.sh`: új `_is_load_paused()` (saját selftest-esetekkel), a `check`
  parancs ELSŐ ellenőrzése, MÉG a ledger olvasása/írása előtt -- `DENY:load-paused`. Strukturális
  csomópont: minden monitor, ami nudge-ol/re-dispatchel, már most is ezen az egy ellenőrzésen
  megy át (a script saját fejléce dokumentálja: channel-watchdog, fleet-nudger, gate-reconciler,
  folyamatos-munka), tehát ez MINDEGYIKÜKET védi, nem csak a stuck-card-monitor-t.
- `seed-scheduled-tasks/stuck-card-monitor/SKILL.md`: a beragadás-detektáló szűrő maga is kizárja a
  load-paused ügynökök kártyáit (ugyanaz az alak mint a meglévő `active-subagents.json` kizárás).

`store/load-guard-daemon.sh`: új `--bookkeeping` flag (ugyanaz az opt-in alak mint `--cgroup`/
`--sigstop`), UTOLSÓKÉNT fut, hogy a tick FRISSEN írt állapotát olvassa, ne a megelőző tickét.
`scripts/install-guard-timers.sh`: ExecStart mostantól `--cgroup --sigstop --bookkeeping`.

**Konzekvencia.** Új fájlok: `store/load-guard-bookkeeping.sh`,
`src/__tests__/load-guard-bookkeeping.test.ts` (14 teszt: pause-start, folytatás vs. újra-pause,
mechanizmus-váltás, resume, gördülő ablak + küszöb, hibatűrés). Módosított:
`store/redispatch-guard.sh` (`_is_load_paused` + 4 selftest-eset), `seed-scheduled-tasks/
stuck-card-monitor/SKILL.md`, `store/load-guard-daemon.sh` (`--bookkeeping` flag),
`store/load-guard-config.json` (`bookkeeping` blokk), `scripts/install-guard-timers.sh`. A meglévő
30 load-guard teszt + a redispatch-guard selftest változatlanul zöld. tsc tiszta.

**Ki döntött:** backend (kártya 1128002b, a fázis 19f3bbb5 plan-grilling verdiktje már lefedte a
tervezési kockázatokat; ez a kártya a fázis ZÁRÓ darabja -- Feladat 1-4 mind `done`).

**Hivatkozás:** kártya 1128002b (parent: 19f3bbb5), függőség: d7a28a0a/Feladat 2 és 2bfbf805/
Feladat 3, mindkettő már done.

## 2026-08-27 -- 2bfbf805 -- Cybersec NO-GO: a 90s kenyszer-feloldas nem volt fuggetlen a daemon eval-lepesenek sikeressegetol

**Dontes.** Cybersec NO-GO-t adott a 2bfbf805 (SIGSTOP-fagyasztas) elesitesere (Gate-SHA a68c5ce8):
`set -euo pipefail` alatt egy sikertelen `load-guard-eval.sh` (pl. serult
`load-guard-config.json` -- UGYANAZ a fajl, amit a --sigstop sajat kill-switch-e is minden ticken
olvas) a teljes `load-guard-daemon.sh`-t leallitotta MIELOTT az elerte volna a mar `|| true`-val
vedett --cgroup/--sigstop hivasokat. Kovetkezmeny: ha a critical tier mar aktiv volt (egy folyamat
mar fagyasztva) ES a daemon EZEN a ponton kezdett tartosan hibazni, a fagyasztott folyamat a 90
masodperces hatarido utan IS fagyasztva maradt volna -- KOZVETLENUL ellentmondva a kartya sajat,
Peti altal mar jovahagyott igereterenek ("a feloldas fuggetlen a terhelestol").

**Javitas (sebeszi, egy sor).** `RESULT=$(load-guard-eval.sh ...)` sikertelenseg eseten biztonsagos
`{"action": "log_only", ...}` alapertelmezesre esik vissza a script leallitasa helyett. Ez
ONMAGABAN eleg: `load-guard-sigstop-apply.sh` `desired_agent`-je CSAK `action=="sigstop_freeze"`
eseten allit be celpontot, tehat barmilyen mas action (log_only is jo) MINDEN kovetkezo tick
azonnal felszabaditja a regi fagyasztott pid-et -- a 90s-es kenyszer-feloldas agra sincs hozza
szukseg, mert a "prev_pid != desired_pid" ag mar onmagaban felold. Az apply-reteg maga
VALTOZATLAN maradt.

**Mellekesen talalt masodik hiba (sajat lelet, nem Cybersec talalta).** A javitas tesztelese
kozben kiderult: `store/load-guard-sigstop.sh`, `-sigstop-target.sh`, `-sigstop-apply.sh` es
`-bookkeeping.sh` MIND 100644 modban lettek commitolva (nem futtathato!). A daemon EZEKET
KOZVETLENUL hivja (nem `bash script.sh`-val), es a hivasok `|| true`-val vedettek -- tehat a
Permission denied (exit 126) hiba CSENDBEN elnyelodott minden eles ticken azota, hogy landoltak.
Az "elso tick status=0/SUCCESS" elenorzeseim (mindket korabbi REVIEW-ban) ezert FELREVEZETOEK
voltak: a daemon SCRIPT sikeresen lefutott, de a --sigstop/--bookkeeping reteg valojaban SOHA nem
futott le ezalatt.

**Strukturalis vedelem (uj teszt, CleanCore-bol atemelve).** `src/__tests__/
shebang-files-executable.test.ts` -- CleanCore kartya 95e73c8e mintaja szerint: minden `#!`-lel
kezdodo, git-kovetett fajlnak `100755`-nek kell lennie, levezetve a git-indexbol, nem
kezzel-karbantartott listabol. A KERESES kiterjesztese felfedett MEG 78 MEGLEVO, korabbi
serulest a teljes repoban (hookok, guardok, support-mail szkriptek, seed-skillek) -- mind
javitva EGYSZERRE (`git update-index --chmod=+x` + valos `chmod +x`, mert `core.fileMode=true`
ebben a worktree-ben, tehat a lemez-mod is szamit, nem csak az index -- MAS mint a CleanCore
DrvFs-mountja, ahol csak az index szamit). Zero regresszios kockazat: a chmod +x szigoruan
additiv, egy `bash script.sh` hivot nem erint, csak egy torott kozvetlen hivast javit.

**Ki döntött:** backend (kártya 2bfbf805, Cybersec NO-GO cimzese, a fazis 19f3bbb5 plan-grilling
verdiktje mar lefedte a tervezesi kockazatokat).

**Konzekvencia.** Modositott: `store/load-guard-daemon.sh` (eval-fallback),
`src/__tests__/load-guard-eval.test.ts` (3 uj teszt, valos spawnolt folyamattal). Uj:
`src/__tests__/shebang-files-executable.test.ts` (3 teszt). Mod-bit javitva 83 fajlon (5 sajat +
78 meglevo). Meglevo 16 load-guard-eval teszt + 178 celzott teszt osszesen valtozatlanul zold.
tsc tiszta.

**Hivatkozás:** kártya 2bfbf805, Cybersec NO-GO komment (Gate-SHA a68c5ce8).

## 2026-08-27 00:26 -- ensure-native-modules.sh: hangos riasztás stray pnpm-nyomokra

**Mit döntöttünk.** `scripts/ensure-native-modules.sh` (ExecStartPre a dashboard/channels
szolgáltatásokon, minden induláskor fut) mostantól a natív-binding-ellenőrzés MELLETT,
ATTÓL FÜGGETLENÜL is megnézi, van-e stray pnpm-nyom a projekt gyökerében
(`pnpm-lock.yaml` és/vagy `node_modules/.pnpm`) -- ez az egyetlen npm-only repóban (kártya
0b0e6e24) csak akkor keletkezhet, ha valaki tévedésből `pnpm install`-t futtatott. Ha talál,
direkt Bot API-n hangosan riaszt (`disk-space-guard.sh` mintája: megerősített-kézbesítés-utáni
cooldown, max óránként egyszer) -- NEM töröl automatikusan, a takarítás emberi/MikroB döntés
marad.

**Miért.** A meglévő `scripts/assert-npm-package-manager.mjs` `preinstall`-őr csak egy AKTÍV
pnpm-installt fog el (a 0b0e6e24 crash-loopot ez okozta hangosan). Ha a stray telepítés MÁR
megtörtént és senki nem vette észre azonnal, `ensure-native-modules.sh` addigi viselkedése ezt
elfedte: a better-sqlite3 natív binding rebuild-je gyakran simán lefutott a pnpm-nyomok mellett
is, tehát NULLA látható tünet volt (nincs crash-loop). MikroB saját leletét (2026-08-24) csak egy
véletlen `git status` fedte fel a megosztott fő klónban. Egy csendben "megjavított" foreign
package-manager-átvétel önmagában is riasztás-köteles esemény, nem csak a rebuild sikere/bukása.

**Élő megerősítés e kártya munkája közben.** A saját worktree `node_modules`-a a megosztott fő
klónba (`/home/neon/marveen`) mutató symlink -- az új guard ELSŐ valódi futtatásakor (nem a
tesztekben, hanem a repo saját fáján) TÉNYLEGESEN talált egy MÉG MINDIG jelenlévő
`node_modules/.pnpm/` könyvtárat a fő klónban (mtime 2026-08-24, ugyanaznap mint a kártya
felvétele -- tehát ugyanaz az esemény, sosem takarítva ki). A `pnpm-lock.yaml` addigra már
eltűnt, de a `.pnpm/` alkönyvtár nem, és `npm install` sem futott utána a fa helyreállítására.
Ez azt jelenti, hogy a fő klón `node_modules`-a a kártya felvétele óta 3 napig részlegesen
pnpm-eredetű maradt, észrevétlenül. NEM töröltem/telepítettem újra saját magamtól -- egy
megosztott, éles, más ügynökök worktree-jei által is symlinkelt fa átírása kockázatos,
visszafordítási-óvatosságot igénylő lépés, ezt MikroB/Peti döntésére hagyom (lásd az inter-agent
jelzést a REVIEW mellett).

**Ki döntött:** backend (kártya d0126d79, MikroB saját 2026-08-24-i lelete alapján felvéve).

**Konzekvencia.** Módosított: `scripts/ensure-native-modules.sh` (`has_stray_pnpm_artifacts` +
`check_stray_pnpm` + `alert_owner`, `disk-space-guard.sh` mintájára, test hookokkal). Új:
`scripts/__tests__/ensure-native-modules.test.sh` (9 bash-natív teszt: tiszta repó no-op, mindkét
tell-tale artifact alert-et vált ki, cooldown, takarítás-utáni no-op, hiányzó state-dir). tsc
tiszta (a script bash, nincs TS-érintettsége, de a repo egészére lefutott a check). NYITOTT
TOVÁBBI LÉPÉS (nem ennek a kártyának a scope-ja): a fő klón `node_modules/.pnpm/`-jának tényleges
eltávolítása + `npm install` a helyreállításhoz -- ezt MikroB/Peti hagyja jóvá és futtatja.

**Hivatkozás:** kártya d0126d79.

## 2026-08-27 00:50 -- load-paused-agents.json staleness-védelem (Cybersec NO-GO + QA FAIL, fce0df4e)

**Mit döntöttünk.** `store/load-guard-bookkeeping.sh` minden `load-paused-agents.json` bejegyzésbe
`last_seen`-t is ír (minden ticken frissül, amíg a pause fennáll -- szemben a `since`-szel, ami az
EREDETI kezdet óta rögzített marad). `store/redispatch-guard.sh` `_is_load_paused()`-ja és a
`stuck-card-monitor` SKILL.md saját Python-szűrője mostantól a puszta tagság MELLETT azt is nézi,
hogy a `last_seen` 300 másodpercnél nem régebbi -- ha régebbi, a bejegyzés NEM számít kizártnak
többé, a normál stuck-card/nudge kezelés érvényesül rá.

**Miért.** Cybersec NO-GO + QA FAIL (Gate-SHA fce0df4e, mindkettő függetlenül ugyanarra a
hiányosságra jutott): ha `load-guard-bookkeeping.sh` maga áll le (ugyanaz az eval-hiba-lánc, amit a
2bfbf805 NO-GO már feltárt -- lásd a `load-guard-daemon.sh` eval-fallback bejegyzést), a
`load-paused-agents.json` egyszerűen abbahagyja a frissítést és megtartja az UTOLSÓ ismert
bejegyzést a végtelenségig. Mind `redispatch-guard.sh`, mind a `stuck-card-monitor` csak tagságot
(`agent in paused`) nézett, sosem a bejegyzés korát -- egy elavult bejegyzés ezért a flotta KÉT
hurokzáró biztonsági hálóját (nudge-gate + 10 perces beragadás-újraindítás) is korlátlan ideig
vakon hagyta volna, nem csak a korábban becsült ~10-15 percig.

**Miért NEM `since`-alapú a korlát** (a gate-ek szó szerinti javaslatától eltérő, szándékos döntés,
dokumentálva a saját indoklással a `load-guard-bookkeeping.sh` fejlécében is): a `since` a pause
EREDETI kezdetét rögzíti, változatlanul, amíg a pause folytatódik. A `cgroup_throttle`-nak NINCS
kényszer-feloldása (szemben a `sigstop_freeze` 90s-es limitjével) -- egy valódi, tartósan magas
terhelés alatt egy ügynök jogosan maradhat fékezve 15 percnél tovább is. Egy `since`-alapú korlát
ezt a LEGITIM, folyamatban lévő fékezést tévesen szüntette volna meg, pont azt a biztonsági hálót
gyengítve, amit védeni próbál. A `last_seen` ehelyett azt méri, amit valóban mérni kell: fut-e még
a bookkeeping folyamat, nem azt, hogy mióta tart a fékezés.

**Konzekvencia.** Módosított: `store/load-guard-bookkeeping.sh` (`last_seen` mező),
`store/redispatch-guard.sh` (`_is_load_paused()` staleness-ellenőrzés + 3 új selftest-eset),
`seed-scheduled-tasks/stuck-card-monitor/SKILL.md` (a Python-szűrő staleness-ellenőrzése).
`src/__tests__/load-guard-bookkeeping.test.ts`: 3 új teszt (`last_seen` új induláskor, folytatódó
pause-nál, mechanizmus-váltásnál). Régi formátumú (last_seen nélküli) bejegyzés fail-open marad
(friss/kizártnak számít) -- nincs meglepetésszerű tömeges fel-oldás a fix élesítésekor. 66/66 zöld
a teljes load-guard tesztcsaládon, redispatch-guard selftest PASS, tsc tiszta.

**Ki döntött:** backend (kártya 1128002b, Cybersec + QA NO-GO/FAIL alapján).
**Hivatkozás:** kártya 1128002b, Gate-SHA fce0df4e (a Cybersec NO-GO és QA FAIL komment), előzmény:
kártya 2bfbf805 (a rokon eval-hiba-lánc, ami a jelen hiányosságot is okozza).

## 2026-08-27 01:04 -- scanBashWord ANSI-C $'...' escape-vakság javítva (kártya 5c9c15c0)

**Mit döntöttünk.** `scripts/self-pace-gate.mjs` `scanBashWord()`-je mostantól felismeri a `$'...'`
(ANSI-C) idézési formát: ha egy `$` karaktert `'` követ, a span-számítás `readAnsiC()`-et hívja (a
fájl EGYETLEN ANSI-C dekódere, amit `unquoteWord`/`QUOTED_LITERAL_RX` is használ) a záró idézőjel
POZÍCIÓJÁNAK meghatározásához -- nem egy második dekódert ír. Korábban a sima `indexOf("'", ...)`
minden apostrófnál megállt, ESCAPELTNÉL is, tehát egy `$'AB\'CD'` alakú NAME-et túl röviden mért
volna fel.

**Miért.** Cybered lelete (84e31b40 záró GO kör, 2026-08-24, 11. kör): ugyanaz a hibaosztály, mint
amit `ec20dd23` már javított (`unquoteWord`/`QUOTED_LITERAL_RX`-en), de `scanBashWord()`-ben --
FÜGGETLEN kódhely, a kártya saját, kötelező ELSŐ lépése szerint ellenőriztem: `scanBashWord` SOHA
nem hívja a `readAnsiC`/`unquoteWord`/`QUOTED_LITERAL_RX` gépezetet, tehát `ec20dd23` fixe ezt a
helyet nem fedi -- NEM dedup-zárható, önálló javítás kellett.

**MA NEM KIHASZNÁLHATÓ, empirikusan is megmérve (nem csak a kártya állítása alapján elfogadva).**
Három crafted bemenet (`coproc $'AB\'CD' { crontab -r; }`, `function $'AB\'CD' { crontab -r; }` és
a jóhiszemű kontroll) `gateDecision()`-jét lefuttattam MIND a javítás ELŐTTI (git stash-elt eredeti
fájl), MIND az UTÁNI verzióval -- a `deny` eredmény MINDKÉT esetben azonos (DENY a veszélyes
törzsre, ALLOW a jóhiszemű kontrollra). Nincs élő A/B-különbség: egy másik, független detektor már
elkapja a veszélyes törzset a NAME-span helyességétől függetlenül, és bash maga elutasít egy
apostrófot tartalmazó NAME-et coproc/function/POSIX pozícióban, mielőtt bármi lefutna -- pontosan
ahogy a kártya saját, három-fuggetlen-vegrehajtasi-teszttel alátámasztott állítása mondja.

**Miért javítottuk akkor is.** Konzisztencia: ugyanaz az elv, ami miatt `ec20dd23` a saját másolatát
javította -- egy escape-vak span-számítás egy NAME-scannerben rossz szomszédság, még ha ma nincs is
rajta keresztül élő kihasználás; egy jövőbeli, e scannerre épülő új hívó vagy egy jövőbeli bash-
viselkedés-változás bármikor élővé tehetné.

**Konzekvencia.** Módosított: `scripts/self-pace-gate.mjs` (`scanBashWord` új `$'` ág). Új:
`src/__tests__/scan-bash-word-ansi-c-quote.test.ts` (7 teszt: 3 meglévő NAME-alak regressziója,
1 sima idézőjeles kontroll, 2 escapelt-apostrófos ANSI-C NAME veszélyes törzzsel, 1 jóhiszemű
escapelt-apostrófos ANSI-C NAME kontroll). 543+171 zöld a teljes self-pace-gate tesztcsaládon
(governance-gates, bash-ast-boundary, hook-command-quoting, path-prefix-*, stdin-*,
self-pace-nested-command-context, self-pace-wrapper-and-keyword-positions,
self-pace-gate-oversize-failclosed, scan-bash-word-backtick-quadratic, az új fájl). tsc tiszta.

**Ki döntött:** backend (kártya 5c9c15c0, Cybered 84e31b40 lelete alapján, a kártya saját
dedup-ellenőrzési utasítása szerint eljárva).
**Hivatkozás:** kártya 5c9c15c0, előzmény: kártya ec20dd23 (a rokon, de FÜGGETLEN kódhelyen már
javított escape-vakság), kártya 84e31b40 (a záró Cybered-kör, ahol a lelet született).

## 2026-08-27 01:16 -- STDIN_SHELL_RX pipe-ág escapelt-horgony bypass zárva, plan-grilling utáni (kártya 1a609c01)

**Plan-grilling (a kártya saját, kötelező előírása -- self-pace-gate.mjs architekturális, tobbszor
regresszalt fajl, 1b. munkavegzesi szabaly szerint).** A `~/.claude/skills/plan-grilling` skill nem
volt betöltve ebben a session-ben (Skill tool "Unknown skill" hibát adott) -- a SKILL.md-t közvetlen
fájlolvasással követtem, a procedúra 8 tengelye szerint magam grilleztem a tervet, mielőtt kódot
írtam volna. Eredmény alább, a skill saját Output-formátuma szerint.

**(a) Load-bearing feltevések, ellenőrizve.** (1) A pipe-ág literál `\|` horgonya nem retry-olható
máshonnan -- VERIFIKÁLVA élő regex-teszttel (különálló szkript, PATH_PREFIX önmagában `null`-t ad
`some\;dir/bash`-re, de `WRAPPER_POSITION`-nel párosítva a `;` karakternél sikeres retry-t talál).
(2) A bypass ma tényleg 7/7 -- VERIFIKÁLVA `gateDecision()`-on át mind a 7 horgonyra, valódi
veszélyes payloaddal (nem placeholderrel, a 39cc3460 saját tanulsága szerint). (3) A `-c` forma
(WRAPPER_POSITION-alapú ág) NEM sérült ugyanerre a mintára -- VERIFIKÁLVA (mind a 7 horgony
`deny=true` marad `-c` formában).

**(b) Megoldatlan ágak / elfogadott kockázatok.** A round-3 SZÁNDÉKOSAN elvetette a pipe-ág
horgonyának teljes WRAPPER_POSITION-re bővítését, mert az eldobná a "pipe után" követelményt
("new false-positive surface, needs its own threat-model pass"). A választott megoldás EZT a
konkrét aggályt kezeli: NEM a pipe-ág horgonyát írja át, hanem egy FÜGGETLEN, második
létezés-ellenőrzést ad hozzá (`HAS_PIPE_RX` ÉS `WRAPPER_POSITION_BARE_SHELL_RX`, külön scan, nem
egy kombinált regex retry-vel/fillerrel) -- tágabb a jelentett pontos alaknál (a pipe és a
shell-név nem kell szomszédos legyen), ELFOGADOTT kockázat: ez GYAKRABBAN futtatja le az idézett
literál-kicsomagolást jóhiszemű pipe+shell-név-tartalmú parancsokon (pl. `ps aux | grep bash`) --
DE a végső DENY döntés VÁLTOZATLANUL egy idézett literál veszélyes mintára illeszkedésétől függ,
tehát ez a szélesítés soha nem okoz ÚJ hamis DENY-t, csak több (ártalmatlan) kicsomagolási
kísérletet. VERIFIKÁLVA 11 realisztikus jóhiszemű pipe+shell-név-parancson (mind allow marad).

**(c) Verdikt: GO-WITH-CHANGES -> megvalósítva.** Az eredeti, naiv "csak cseréld le a horgonyt
WRAPPER_POSITION-re" ötlet (amit a round-3 kifejezetten elvetett) NEM a végleges alak -- a
független-kettős-ellenőrzés a "change" ami a GO-t lehetővé tette: megtartja a "pipe kell valahol"
szemantikát, mégis megkapja a retry-képességet.

**(d) A legvalószínűbb bukási mód + mitigáció.** Egy KOMBINÁLT (nem független) regex, ami a pipe
és a WRAPPER_POSITION-horgony közé egy korlátlan fillert tenne, ÚJRA bevezetné pontosan azt a
négyzetes DoS-t, amit a fájl 1-3. köre háromszor zárt be. Mitigáció: a két ellenőrzés SZIGORÚAN
FÜGGETLEN (két külön, nem-backtracking O(n) scan, ÉS-elve mint boolean), verifikálva egy új
négyzetes-stressz teszttel (16000-100000 pár, mindkét irányban -- csupasz shell-név nélküli tiszta
pipe-futam is), 500ms alatt.

**Megvalósítás.** `scripts/self-pace-gate.mjs`: új `HAS_PIPE_RX` (`/\|/`) + új
`WRAPPER_POSITION_BARE_SHELL_RX` (a meglévő `WRAPPER_POSITION`+`PATH_PREFIX`+`SHELL_ALTERNATION`
építőkockákból, semmi új nem-bizonyított konstrukció). `executableStrings()`-ben a trigger-feltétel
`STDIN_SHELL_RX.test(text) || (HAS_PIPE_RX.test(text) && WRAPPER_POSITION_BARE_SHELL_RX.test(text))`.

**Konzekvencia.** Módosított: `scripts/self-pace-gate.mjs`,
`src/__tests__/path-prefix-cmd-position-anchors-quadratic.test.ts` (a korábbi "documented gap"
blokk lezárva `deny=true`-ra állítva, 11 új jóhiszemű-kontroll teszt, 8 új négyzetes-stressz
teszt). 730+ zöld a teljes self-pace-gate tesztcsaládon (14 fájl). tsc tiszta.

**Ki döntött:** backend (kártya 1a609c01, Cybersec saját lelete alapján, a kártya saját
plan-grilling-előírása szerint eljárva).
**Hivatkozás:** kártya 1a609c01, előzmény: kártya 39cc3460 (a DoS-fix + a jelen maradvány saját
felfedezésének helye, round 3), `path-prefix-cmd-position-anchors-quadratic.test.ts` (a korábbi
"documented gap" teszt, ami most lezárva).

## 2026-08-27 01:26 -- activity_memory_capture.py token/JWT redakció: \b-fuggo prefix-illesztes javitva (kártya 2102fe6a)

**Mit döntöttünk.** `_SECRET_PATTERNS`-ben a GitHub/Anthropic/Slack-stílusú token-előtag minta és a
JWT triple-dot minta LEVÁLASZTOTTA a `\b` szóhatár-követelményt (mindkét oldalról, a JWT esetén).
Előbb: `\b(ghp_|...)...`, `\bey...\b`. Utána: `(ghp_|...)...`, `ey...` (nincs horgony).

**Miért.** Cybersec lelete (2102fe6a, a d47455bf DB-URI-javítás rokon, de SÚLYOSABB kővetkezménye,
ugyanaz a fájl/kontroll). A `\b` szóhatár egy `\w`/nem-`\w` átmenetet követel közvetlenül a minta
előtt -- ha egy 40+ karakteres, AZONOS karakterosztályú (alfanumerikus) futam KÖZVETLENÜL, elválasztó
NÉLKÜL áll a titok előtt (a d47455bf-ben már megismert "glued" alak), nincs ilyen átmenet, tehát a
minta EGYÁLTALÁN nem illeszkedik. A hex/base64-blob minták (amik KÉSŐBB futnak a listában) ezután
találnak egy alfanumerikus futamot, de az előtag SAJÁT elválasztója (`_` vagy `-`) NINCS a
base64/hex ábécében, tehát a blob-minta PONT OTT megszakad -- csak az előtag pár betűje tűnik el,
a TELJES titok-test (a token/JWT valódi, véletlenszerű része) VÁLTOZATLANUL BENNMARAD. Ez SÚLYOSABB
mint a DB-URI eset (ott a jelszó nulla karaktere sem szivárgott) -- itt a titok GYAKORLATILAG
TELJES EGÉSZÉBEN szivárog, csak egy jólismert, publikus, 5-9 lehetőségből trivi álisan
visszafejthető előtag hiányzik. A JWT-nél MÉG ROSSZABB: egyik blob-minta sem menti meg még
részlegesen sem (a JWT-szegmensek base64URL ábécét használnak, `_`/`-`-sal, nem a blob-minták
`+`/`/`-jével, és egy valódi szegmens gyakorlatilag sosem csupa-hex).

**Miért NEM sorrend-probléma, mint a d47455bf-nél.** A d47455bf DB-URI-javítás egy SORREND-hiba
volt (az anchorolt minta a blob-minták UTÁN futott -- megoldás: előre hozni). Itt a token-előtag
minta MÁR ELSŐ a listában -- a hiba maga a `\b` FELTÉTEL, nem a pozíció. A javítás ezért nem
átrendezés, hanem a `\b` eltávolítása MINDKÉT mintából.

**Ellenőrizve.** 9 új teszt-eset (mind a 9 támogatott előtag, "glued" alakban, valós titok-testtel,
nem placeholderrel) + 2 új JWT teszt (vezető ÉS követő glue, mindkét irány) --
`activity-memory-capture.selftest.py`-ban, a `db-uri-*-glued-*` minta pontos ismétlése. NEGATÍV
KONTROLL: 4 jóhiszemű mondat (benne "ey"-t tartalmazó szavak: "they", "obeyed", "monkey", rövid
"sk-"/"gh-" töredékek) -- egyik sem redaktálódik hamisan, mert a TELJES minta (nem csak az előtag)
igényel egy hosszú, szomszédos alfanumerikus futamot, ami prózában nem fordul elő. 35/35 zöld a
teljes selftest-en (előtte 20, +15 új), 24/24 zöld a vitest-wrapperen
(`activity-hook-redaction.test.ts`). Python syntax + tsc tiszta.

**Mellékhatás, tudatosan elfogadva (nem hiba).** A "glued" esetben a korábban megőrzött, olvasható
előtag (pl. "ghp_") MOST a blob-minta által is elnyelődhet (mert a token-előtag minta már
redaktálta a titok-testet, de az előtag betűi VISSZAMARADNAK sima szövegként a glue-futam mellett,
amit a KÉSŐBB futó blob-minta összefésül a szomszédos futammal) -- az eredmény
`[REDACTED]_[REDACTED]` az elváart `ghp_[REDACTED]` helyett. Ez BIZTONSÁGI szempontból NEM
regresszió (több redaktálódik, nem kevesebb), csak kozmetikai, és KIZÁRÓLAG a mesterséges
"glued" (adverzariális) esetben jelentkezik -- normál, nem-glued bemenetnél az előtag változatlanul
látható marad (a meglévő `github-token`/`anthropic-key` tesztek ezt továbbra is igazolják).

**Ki döntött:** backend (kártya 2102fe6a, Cybersec saját lelete alapján).
**Hivatkozás:** kártya 2102fe6a, előzmény: kártya d47455bf (a rokon DB-URI-fix, más gyökér-ok:
sorrend, nem `\b`), kártya 5472cfa9 (a redakciós kontroll eredeti bekötése).

## 2026-08-27 01:35 -- crontab -l flag-lánc bypass zárva (kártya f35b8d92)

**Mit döntöttünk.** `SCHEDULER_READ_RX`/`SCHEDULER_CMDWORD_READ_RX`/`UNANCHORED_SCHEDULER_READ_RX`
(mindhárom, self-pace-gate.mjs) `-l\b` PREFIX-egyezését egy határolt negatív lookahead
(`CRONTAB_NO_WRITE_FLAG_FOLLOWS`) egészíti ki: nem elég hogy a szegmens `crontab -l`-lel KEZDŐDIK,
a következő valódi parancshatárig (`;`/`&`/`|`/backtick/újsor) nem következhet `-r`/`-e`/`-i`
(törlés/szerkesztés/interaktív-törlés), önmagában vagy getopt-klaszterben (`-er`).

**Miért.** Cybersec HIGH lelete (f35b8d92, msg 20542, fuggetlenul ellenorizve): a crontab(1) (cronie
forrás) getopt-lánca minden zászlót UGYANABBA a mód-változóba ír, az UTOLSÓ zászló nyer -- tehát
`crontab -l -r` a valóságban TÖRLI a crontabot, nem listázza. A régi `-l\b` prefix-minta ezt
"olvasásnak" jelölte (a `\b` csak azt követeli meg, hogy "l" után szóhatár legyen, arról semmit nem
mond mi jön utána), ami mindhárom fogyasztó-útvonalon (anchored SCHEDULER_RX pár, CMDWORD, a
heredoc-soronkénti subtract-és-teszt) átengedte a bypasst -- élőben megmérve mindháromra.

**Miért kizárólag crontab.** A launchctl olvasó-alakjai (list/print/dumpstate/blame/examine)
egyetlen POZICIONÁLIS argv[1]-ek, nem getopt-lánc -- `launchctl list load` a "load"-ot a `list`
ARGUMENTUMAKÉNT kapja, nem hívja második műveletként. Az `atq` egyáltalán nem vesz fel mód-váltó
zászlót. Egyik sem osztja a crontab "utolsó zászló nyer" mechanizmusát, tehát egyik sem kapta meg
ugyanazt a védelmet -- indokolva a kódban is.

**Tudott, kártya-scope-on kívüli, NEM ÚJ jelenség (megjegyezve, nem javítva):**
`crontab -u alice -l` (felhasználó ELŐBB, mint az `-l`) hamisan denies -- ez MÁR a javítás ELŐTT is
így volt (ellenőrizve git-stash-elt eredeti fájllal), mert a READ-minta `crontab` UTÁN közvetlenül
várja a `-l`-t, nem enged elé más flaget. Nem ennek a kártyának a hatóköre (a kártya kizárólag a
"mi KÖVETI a -l-t" kérdésről szól, nem "mi ELŐZI meg"), ezért szándékosan NEM nyúltam hozzá --
JELEZVE, nem elrejtve, a sebészi-változtatás elv szerint.

**Konzekvencia.** Módosított: `scripts/self-pace-gate.mjs` (új `CRONTAB_NO_WRITE_FLAG_FOLLOWS`
konstans, alkalmazva mindhárom READ-mintán). Új: `src/__tests__/crontab-read-flag-chaining.test.ts`
(16 teszt: 5 veszélyes kombináció denies, 5 genuin-olvasás allow marad, 3 sibling-forma
[launchctl/atq] érintetlen, 3 a három fogyasztó-útvonal mindegyikére). 746+ zöld a teljes
self-pace-gate + governance-gates tesztcsaládon. tsc tiszta.

**Ki döntött:** backend (kártya f35b8d92, Cybersec saját lelete alapján).
**Hivatkozás:** kártya f35b8d92, előzmény: kártya 40704cb1/230e9884 (a gate-kör, amiben a lelet
született).

## 2026-08-27 01:43 -- kártya 5b91c7de: outgoing-copy-gate.py tokenizer-egyesítés MÁR MEGTÖRTÉNT (dedup/stale-close)

**Mit találtam.** A kártya azt írta elő, hogy a fork saját (`strip_technical`/`TECHNICAL` --
URL/email/kód-span/snake_case/fájlnév-domain/útvonal maszkolása) és az upstream újabb
(`HYPHEN_WORD`/`_at_sentence_start`/`accent_check_tokens` -- kötőjeles idegen-szó-alak +
mondatkezdő-nagybetű felismerés) ekezet-tokenizálóját kell egyesíteni, mert a "jelenlegi allapot
(12fcda43 commit)" állítólag csak a fork sajátját tartotta meg. ELLENŐRIZTEM a tényleges,
jelenlegi kódot (nem a kártya prózáját fogadtam el): `scripts/hooks/outgoing-copy-gate.py`-ban
MINDKÉT tokenizáló jelen van, ÉS MÁR ÖSSZEKAPCSOLVA az `audit()` függvényben (`prose =
strip_technical(plain)`, majd `tok_pos = accent_check_tokens(prose)` -- a fork maszkolása fut
ELŐSZÖR, az upstream-eredetű tokenizáló a MÁR-MASZKOLT szövegen).

**Mikor és hogyan történt.** `git log` szerint a `d9bb515b` commit ("tokenize prose vs identifier
-- whole hyphenated forms, skip mid-sentence capitals, context in findings (GATEKOTOJEL817,
GATEHYPH816)") vezette be ezt az egyesítést, MÉG A KÁRTYA LÉTREHOZÁSA ELŐTT vagy azzal egyidőben --
ellenőrizve: `d9bb515b` a jelenlegi `origin/develop` HEAD (`03208f33`) őse
(`git merge-base --is-ancestor` PASS). Utána a `8e8e00e1`/`4269543a` commitok (round 10/11,
RESENDGATE826 + DIGIT-HYPHEN SUFFIX) TOVÁBB KEMÉNYÍTETTÉK ugyanezt a MÁR EGYESÍTETT
implementációt, nem egy külön, egyesítetlen ágon.

**Ellenőrizve, nem csak feltételezve.** `outgoing-copy-gate.selftest.py`: 23/23 zöld.
`outgoing-copy-gate-tokens.test.ts` + `outgoing-copy-gate-scope.test.ts`: 29/29 zöld. Mindkettő a
JELENLEGI, MÁR EGYESÍTETT kódot futtatja, nem egy hipotetikus régi állapotot.

**Döntés: NEM írok új kódot erre a kártyára.** A kártya saját premisze ("nincs osszeegyeztetve")
STALE volt a felvétel pillanatában is, vagy a felvétel és a dispatch közt landolt a megoldás egy
másik integrációs munkával (F5 cutover / fbb41b41 round 10-11) egyidőben -- akárhogy is, a leírt
probléma MA nem áll fenn. Új kódot írni ide FELESLEGES MUNKA lenne, és KOCKÁZATOS is: egy már
négyszer (round 7/8/10/11) élesben tesztelt, gate-elt, security-kritikus fájl "javítása" egy MÁR
NEM létező hiányosságra csak új regressziós kockázatot vinne be haszon nélkül.

**Ki döntött:** backend (kártya 5b91c7de, a jelenlegi kód közvetlen ellenőrzése alapján, nem a
kártya prózája alapján).
**Hivatkozás:** kártya 5b91c7de, a tényleges egyesítést hozó kártya/commit: d9bb515b (GATEKOTOJEL817
+ GATEHYPH816), további keményítés: fbb36b41 round 10 (8e8e00e1) + round 11 (4269543a).

## 2026-08-27 19:36 -- kártya c7401c5f: email-send-gate.mjs pozíció-alapú detektor elfogadott vakfoltja (fejléc-korrekció, Cybersec M-1)

**Mit korrigáltam.** A `scripts/email-send-gate.mjs` fejléce (és a SEND_PATTERNS/isSendInvocation
kommentjei) korábban "on unparseable input the gate behaves exactly as before, never weaker"
formában fogalmaztak -- ez a mondat SZŰKEN, csak a nem-tokenizálható bemenet fallback-ágára igaz,
de a fájl egészére könnyű ráolvasni (Cybersec NO-GO, kártya c7401c5f, komment #16876, M-1 lelet:
"a REVIEW sem a QA nem számszerűsítette" a pozíció-alapú váltás tényleges biztonsági
gyengülését). A fejléc most explicit kimondja, mi az, amit a pozíció-alapú (token-hely szerinti)
elemzés ELVILEG nem tud látni, és hogy ez a régi, tartalom-alapú SEND_PATTERNS-scanhez képest
valódi lazítás -- nem ennek a kártyának (c7401c5f, heredoc-tulajdonos-felismerés összekapcsolása)
a hibája, hanem a KORÁBBI, SUBGATEPOZ822 kártyával bevezetett pozíció-alapú váltásé, amit eddig
senki nem mondott ki írásban a fájlban vagy itt.

**Mi gyengült konkrétan (Cybersec méréssel igazolta, régi=DENY, új=allow):**
1. Változóból feloldott argv0: `X=sendmail; $X user@host < body`
2. Eval-lel futtatott string: `eval "sendmail user@host"`
3. Shellbe csövezett printf: `printf 'sendmail a@b' | bash`

Mindhárom azért csúszik át, mert a pozíció-alapú elemző a parancs SAJÁT tokenjeiből dönt (melyik
program hol áll), nem szimulál változó-feloldást vagy eval-tartalmat -- ez ugyanaz a korlát, amit
a fájl "STATED LIMIT" bekezdése (msg 14298) már kimondott az interpreter-kódra ("static analysis
of arbitrary interpreter code is undecidable"), csak eddig nem volt összekötve a pozíció-alapú
SUBGATEPOZ822-váltással.

**Miért elfogadott, nem hiba.** (a) A pozíció-alapú váltás (SUBGATEPOZ822, 2026-08-22) ÖNMAGÁBAN,
JELEN kártya előtt landolt, mert a régi tartalom-scan mérhetően blokkolta a mail-gate SAJÁT
fejlesztését (ugyanaznap 8 hamis pozitív, köztük a fix commit-üzenete és a kártya-kommentje) --
ez a kártya (c7401c5f) csak a heredoc-résen zár be egy MÁSIK, korábban külön nyitva hagyott
lyukat, nem ez okozza az 1-3. pontot. (b) Mindhárom megkerülési alak SZÁNDÉKOS kijátszást igényel
(változó indirekció, eval, pipe-építés), nem véletlen küldést -- a gate STATED LIMIT-je már eleve
csak a véletlen esetre vállal garanciát ("Our sub-agents are not adversaries; if that assumption
ever changes, this gate is the wrong tool"). (c) A csere ára (a pozíció-alapú detektor) mérhetően
kisebb hamis-pozitív terhet jelent, mint amennyi biztonsági fedezetet elveszít ezekre a
determinált-kijátszási alakokra -- ez a klasszikus "hard gate a véletlen ellen, nem a szándékos
ellen" tervezési döntés, amit a fájl már korábban kimondott, csak nem ezekre a konkrét alakokra.

**Nem ehhez a kártyához tartozik:** a `curl-anything -d @- <<'EOF'` decoy (bináris NÉV-prefix
laza CURL_LEADING_RX-en át, pre-existing mindkét verzióban, ugyanaz az alak mint a korábbi
4638c14c NO-GO, csak a bináris nevén keresztül) -- külön kártyát kap, mert a self-pace-gate.mjs-t
is érinti.

**Ki döntött:** MikroB (kártya c7401c5f, Cybersec M-1 lelete alapján, komment #16876) -- a
kockázat-elfogadás maga NEM új itt (a SUBGATEPOZ822 váltással már megtörtént), csak a fájl saját
állítása lett pontosítva, hogy a valóságot tükrözze.
**Hivatkozás:** kártya c7401c5f, komment #16876 (Cybersec NO-GO), content-commit: lásd Gate-SHA a
kártya REVIEW-kommentjében.


## 2026-09-02 -- A megosztott klón node_modules-át védő kontroll a symlink-átlépő ÍRÁS, nem a telepítő-ige (kártya 9dc0fba8)

**Döntés:** a 2026-09-02-i 38 perces kiesés (QA gate-worktree átírta a megosztott CleanCore-klón
`@cleancore/i18n` workspace-linkjét) javítása NEM a "ne fusson installer worktree-ből" szabály
szigorítása, hanem két új réteg: (1) egy PreToolUse guard, ami azt kérdezi, hogy a leírt útvonal
ott van-e, ahová a kernel ténylegesen ír; (2) egy rögzített gate-worktree script, ami a worktree-nek
VALÓDI `node_modules` könyvtárat ad, elemenkénti symlinkekkel.

**Miért nem a szabály szigorítása:** a tényleges parancs `rm <egy fájl>` + `ln -s` volt, egyik sem
telepítő; a meglévő `npm-protect-guard.py` helyesen nem szólalt meg. A `chmod` a symlinken Linuxon
no-op (követi a linket), a megosztott node_modules read-only-ra állítása pedig a fő klón jogos
installjait is blokkolná. A megkülönböztető tulajdonság se nem az ige, se nem a könyvtár: az, hogy
az útvonal átlép-e egy symlinket.

**Fail-closed kiegészítés:** ha az útvonal feloldatlan `$VAR`-t tartalmaz, a guard blokkol, mert
akkor nem ellenőrizhető, hová ír. Ez nem elméleti: az incidenst okozó blokk 32 perccel később
pontosan ebben az alakban futott újra.

**Amit szándékosan NEM tettünk meg:** a `store/agent-worktree.sh` (minden ügynök élő worktree-je)
ugyanezt a könyvtár-symlink alakot használja, és a saját fejléce már 2026-08-14 óta dokumentálja
ezt a hibaosztályt. Az átállítása minden ügynök élő fáját érintené, ezért MikroB/Peti döntése,
külön kártyán -- a guard addig is fedi.

**Ki döntött:** Cybersec (kártya 9dc0fba8, MikroB dispatch). **Hivatkozás:** kártya 9dc0fba8;
guard `scripts/hooks/symlinked-node-modules-guard.py` (19 selftest-eset valódi fixture-rel, az
incidens reprodukálásával), script `store/cc-gate-worktree.sh`, skill `gate-worktree-pattern`.

## 2026-09-02 (javítás) -- A symlink-guard a HÍVÓ cwd-jét használja, nem a sajátját (kártya 9dc0fba8, QA 1. körös FAIL)

**Mi volt hibás:** a `scripts/hooks/symlinked-node-modules-guard.py` első verziója
`os.path.abspath()`-tal oldotta fel a relatív útvonalakat, ami a GUARD saját process-cwd-jéhez
képest old fel. Egy `cd "$WT" && rm apps/web/node_modules/@cleancore/i18n` alak -- ugyanaz az
incidens, csak relatívan írva, és ez a flotta tényleges szokása -- így egy nem létező útvonalra
futott ki, aminek a `realpath`-ja önmagával egyezik, tehát a szökés-ellenőrzés "nincs szökés"-t
válaszolt és átengedte. QA reprodukálta élőben.

**Miért nem vettem észre:** a testvér `npm-protect-guard.py` MÁR használja a `payload.get("cwd")`
mezőt (165. sor), az enyém nem olvasta egyszer sem. Pontosan az a hibaosztály, amit ugyanezen a
kártyán a másik oldalról leírtam: egy másolt modul átveszi az ALAKOT, de nem a kontrollt. A saját
guardom ugyanabba futott bele.

**A javítás:** `effective_cwd(command, payload_cwd)` -- a hívó cwd-je az alap, egy vezető literál
`cd <dir>` felülírja; ha a `cd` célja feloldhatatlan (`$VAR`), akkor a UTÁNA jövő relatív
node_modules-utak nem ellenőrizhetők, tehát a B-eset (fail-closed) érvényes rájuk, nem szabad
átengedés. Az `escapes()` mostantól ehhez a cwd-hez old fel.

**Bizonyíték, hogy a teszt nem vákuum:** az öt új selftest-esetet lefuttattam a JAVÍTÁS ELŐTTI
guarddal is (a régi bájtok `git show HEAD:`-ből, a selftest mellé másolva a helyes fájlnévvel):
a három blokkoló eset PIROS, a két KONTROLL (valódi node_modules-ba írás, illetve olvasás)
ZÖLD -- tehát az új esetek tényleg a javítást rögzítik, és nem "mostantól minden blokkol".

**Ki döntött:** Cybersec (a javítás), QA (a lelet, komment 17557). **Hivatkozás:** kártya 9dc0fba8.

## 2026-09-02 (2. javítás) -- A symlink-guard a FELOLDOTT útvonalból dönt, nem a leírt sztringből (kártya 9dc0fba8, Cybered NO-GO)

**Mi volt hibás:** a guard `path_tokens()`-e csak azt a tokent adta tovább, amiben LITERÁLISAN ott
volt a `node_modules/<valami>`. A kernel viszont nem a leírt szót olvassa, hanem a szót a cwd-hez
ILLESZTVE -- tehát ha a `node_modules` komponens a cwd-be csúszott, a guard el sem indult. Cybered
nyolc alakot mért, mindegyik TÉNYLEGESEN átírta a megosztott klónt, guard rc=0:
`cd $WT/apps/web/node_modules && rm @cleancore/i18n`, egy szinttel mélyebbről ugyanez, cd nélkül
(a session cwd-je már ott volt), záró perjel, dupla perjel, `cd`-lánc (csak az elsőt néztem),
`pushd` (nem volt a mintában), és egy mély írás egy csomagon BELÜL.

**A legrosszabb a mély írás (B6b):** nem lógó linket csinál, hanem CSENDESEN átírja a megosztott
klón tartalmát. Nincs hibaüzenet, és teszt sem pirosodik -- a vitest alias miatt a tesztek a saját
worktree forrását olvassák, tehát a megosztott fa mérgezése pont a teszteken nem látszik.

**A javítás (Cybered prototípusának irányát követve, három függvény):**
- `path_tokens()`: nem a betűkre szűr; minden nem-kapcsoló tokent visszaad.
- `escapes()`: a FELOLDÁS után dönt, és csak akkor szólal meg, ha a literális szülő és a realpath
  eltér ÉS valamelyikük egy `node_modules` komponens alatt van. A puszta `<fa>/<pkg>/node_modules`
  (magának a linknek a létrehozása/törlése) továbbra is legitim setup.
- `effective_cwd()`: MINDEN `cd`-t és `pushd`-ot sorra vesz, nem csak az elsőt.
- Plusz a hatch (`MARVEEN_ALLOW_SYMLINK_NM`) csak SOR ELEJI env-hozzárendelésként számít -- eddig a
  puszta említése (pl. egy grep, majd `;` után az írás) kikapcsolta a guardot.

**A nyitva hagyott döntés, amit Cybered rám bízott -- SZIGORÍTOK.** A B-eset eddig csak
csomag-BEJEGYZÉSRE tüzelt, a mély utakat kihagyta. Mostantól bármely `node_modules` alatti,
nem-ellenőrizhető útvonalra tüzel: egy csendes shared-tree tamper rosszabb, mint egy üzemzavar,
tehát a "nem tudom ellenőrizni" jelentése "ne írj". A megfelelő selftest-eset megfordítva, kimondott
indoklással.

**Bizonyíték:** 36/36 zöld a javított guardon (a nyolc alak + a hatch-szigorítás + öt kontroll).
A LANDOLT (javítás előtti) guarddal futtatva ugyanez a selftest 27/36: kilenc eset PIROS, mind az öt
kontroll ZÖLD. Tehát az új esetek a javítást rögzítik, nem "mostantól minden blokkol". (Egy
pontosítás: a B6b LITERÁLIS alakját a landolt guard már fogta -- a `$VAR`-os alakját nem; ez a
különbség a szigorítás.)

**Ki döntött:** Cybered (a lelet és a fix iránya, komment 17646), Cybersec (a B-eset szigorítása).
**Hivatkozás:** kártya 9dc0fba8.

## 2026-09-02 -- install-linux.sh: GRAFT, nem "keep wholesale" (kártya 9dc0fba8, MikroB jóváhagyás)

**Mi változott a döntésen:** a korábbi bejegyzés szerint az `install-linux.sh`-nál a fork verzióját
tartjuk meg EGÉSZBEN, mert upstream csak az Ollama-blokkot írta át, ami ebben a forkban nem létezik.
Ez a fele változatlanul áll. De upstream azóta a fájl EGY MÁSIK részét is módosította, és az ide
tartozik: a Telegram-párosítás liveness-ellenőrzése.

**A mérés:** a fork installere a systemd nélküli ágon `nohup`-pal indítja a bridge-et és `channels.pid`-et
ír (install-linux.sh, a fenti indítás-blokk), a párosítás viszont csak `systemctl --user is-active`-et
kérdezett. Vagyis a saját maga által elindított bridge-et "nem indult el"-nek nevezte, kihagyta a
párosítást és `ALLOWED_CHAT_ID=0`-val hagyta ott az installt. Upstream saját kommentje szó szerint
a mi platformunkat nevezi meg: "WSL is a documented supported platform and has no systemd user session
by default, so this is not an exotic shape." Ez a flotta épp WSL-en fut és épp ezt a bridge-et használja.

**A döntés:** átvesszük az upstream `_bridge_is_up()` helperjét (user unit / system unit /
`channels.pid` + `kill -0`) és a pontosabb hibaüzenetet; a fork Ollama-eltávolítása változatlan.
A `install-macos.sh` NEM hordozza ezt a mintát (megnéztem), tehát ott nincs mit graftolni.

**Ki döntött:** MikroB (msg 21206), Cybersec mérése alapján. **Hivatkozás:** kártya 9dc0fba8;
`ACKNOWLEDGED_UPSTREAM_BLOBS['install-linux.sh']` 7d3b2862 -> 21f10d99.

## 2026-09-02 -- 9d7a247a -- A `kanban_relations` séma három döntése: nincs FK, a `blocks` triggerrel tiltott, a rollback script és nem down-fájl

**Kontextus.** A Fázis (`fe3eff9f`, Peti kérése) egy tartós, típusos reláció-réteget kér a kártyák
fölé: melyik kártya melyik fájlt érintette, melyik döntéshez tartozik, melyik shán volt gate-elve.
Ez a kártya csak a sémát szállítja; a kinyerés (`6cd61430`), a végpont (`69396b63`) és a
dashboard-réteg külön kártyák.

**1. Nincs `REFERENCES` egyik oszlopon sem.** A tábla polimorf: a `to_id` lehet fájl-útvonal vagy
commit-sha, ami nem hivatkozhat `kanban_cards(id)`-ra. Egy csak néha érvényes idegen kulcs nem
idegen kulcs. Következmény, kimondva: a lógó azonosító lehetséges, tehát az olvasó nem kezelheti
"nincs"-ként (ugyanaz a testtartás, amit a `kanban_dependencies` kommentje már felvesz). Cserébe a
`deleteKanbanCard` a saját tranzakciójában takarítja a kártya-oldali éleket MINDKÉT irányban --
nem FK-kényszer miatt (nincs), hanem hogy a lekérdező végpont ne szolgáljon ki törölt kártyára
mutató élt. A takarítás TÍPUS-kvalifikált (`from_type = 'card'`), különben egy azonos szövegű
fájl-útvonalat is elvinne; a kártya-ID-k rövid hexek, ez valós ütközés-alak.

_Elvetve:_ FK a `from_id`-n, `to_id` nélkül. Aszimmetrikus, félrevezető, és a takarítást akkor sem
spórolná meg.

**2. A `blocks` reláció-típust TRIGGER tiltja, nem CHECK.** A blokkolás már a `kanban_dependencies`
táblában él, amit a kártyazárás-őr MINDEN záráskor olvas; egy ide írt `blocks` él láthatatlan lenne
neki (blokkolónak látszik, nem blokkol). Az első séma-verzió ezt `CHECK (relation_type <> 'blocks')`
-szal oldotta meg, és a teszt megbukott rajta: **az `INSERT OR IGNORE` NÉMÁN átugorja a CHECK-et
sértő sort** (mérve külön sqlite-on: exit 0, nulla sor), viszont egy trigger `RAISE(ABORT)`-ja
átmegy az `OR IGNORE`-on (sqlite hiba 19). Mivel épp az `INSERT OR IGNORE` az a forma, amitől a
backfill újrafuttatható, a CHECK pont a fő írási úton lett volna néma. A trigger insert- ÉS
update-oldalon is áll, különben egy engedett típus utólag átnevezhető lenne. Ugyanaz a mechanizmus
és ugyanaz az indok, mint az epoch-időbélyeg őröknél (`a06314ea`): az ügynökök a sqlite3 CLI-vel
és pythonnal közvetlenül írnak a DB-be, ahol a TypeScript-oldali fegyelem nem ér el.

_Megtartva CHECK helyett deklaratívan:_ a `NOT NULL` és a `PRIMARY KEY`, mert azoknál az `OR IGNORE`
viselkedése (sor kihagyása) pont az, amit a hívó akar, és a visszaadott `changes` számból látja is.

**3. A "rollback script" itt egy futtatható DROP-út, nem down-migráció.** A marveenben nincs
számozott migrációs keretrendszer: az egész séma az `src/db.ts` `initDatabase()` idempotens DDL-
blokkja, ami minden szolgáltatás-induláskor lefut. Nincs tehát hova down-fájlt írni. A 11.
kódminőségi elv így teljesül: `store/kanban-relations-rollback.sh` (alapértelmezésben dry-run,
`--yes` a valódi DROP) eldobja a táblát, az indexet és a triggereket, az `initDatabase()` pedig
üresen visszaadja. Ez FUTTATVA van a tesztben, nem feltételezve. Kimondva, mert nem mindegy: ez egy
rossz backfillt von vissza, nem adatvesztést -- a tábla üresen jön vissza.

**Ki döntött:** backend (plan-grilling verdikt a kártyán, komment 18023). **Hivatkozás:** kártya
`9d7a247a`, Fázis `fe3eff9f`.

## 2026-09-02 -- 6cd61430 -- A reláció-kinyerés négy döntése: a `blockedBy` forrás kiesik, a `Pair-*` horgony nem soreleji, a sweep reconcile, egy `source` címke

**Kontextus.** A Fázis (`fe3eff9f`) kulcs-felismerése az volt, hogy a flotta MÁR használ strukturált
szöveges jelöléseket, tehát a reláció-réteget fel lehet tölteni belőlük extra tagging-teher nélkül.
Ez a kártya a kinyerést szállítja: `src/kanban-relations.ts` (tiszta, IO-mentes parser),
`scripts/kanban-relations-backfill.ts` (reconcile CLI, dry-run az alapértelmezés), és három élő hook
(`createKanbanCard`, `updateKanbanCard`, `addKanbanComment`). Minden alábbi döntés a KORPUSZBÓL
mérve (2680 kártya, 18054 komment), nem a kártyaszövegből levezetve.

**1. A kártya által megnevezett `blockedBy` forrás KIESIK, három független okból.** Nincs ilyen
jelölés: a 17 előfordulás (3 leírás + 14 komment) MIND próza az API egy SZÁRMAZTATOTT válaszmezőjéről
-- a `38788337` kártya saját szövege definiálja így ("egy szarmaztatott `blocked: boolean` mezo (+
opcionalisan `blockedBy: [{id,title,status}]`)"). A valódi tároló a `kanban_dependencies`, egy
tipizált reláció-tábla valódi idegen kulcsokkal. És egy ide írt él `relation_type='blocks'` lenne,
amit a `9d7a247a` séma triggere szándékosan visszautasít, mert a kártyazárás-őr a másik táblát
olvassa -- egy `depends-on` álnév pontosan ezt a hibát hozná vissza egy szinonimával később. A
döntés tehát nem scope-vágás kényelemből: a forrás nem létezik, és ha létezne, a séma tiltaná.

**2. A `Pair-FE:`/`Pair-BE:` horgony CÍMKE + HEX, nem soreleji -- a 8a. szabály szövege ellenére.**
A 8a. "a leírás ELSŐ néhány sorában" fogalmaz, ami a `Gate-SHA` soreleji horgonyának átvételét
sugallja. Mérve: a 104 Pair-t hordozó kártyából 2 VALÓDI párosítás sor közepén áll, más próza után
(`37e30adb`: "Peti GO (8779c351 epic, 2026-08-20). Pair-FE: 7a1a8aec"; `17d8865f`: "Fazis: bc465e33.
Pair-BE: d8d55452") -- soreleji horgony ezeket elveszti. Csupasz címke-horgony viszont behúzza a
konvencióról BESZÉLŐ kártyákat (`fe3eff9f`, `6cd61430`, `3bd18e70`). A kettőspont után KÖZVETLENÜL
követelt hex-token mindkettőt megoldja, és ráadásul kizárja a 40+ prózai "nincs pár" értéket
(`n/a`, `-`, `nincs (frontend-only)`, `N/A (infra refactor)`), amit egy "a sor maradéka" parser
élként rögzített volna. Ellenőrzés a teljes korpuszon: 37 pár-él, MIND létező kártyára mutat, nulla
lógó azonosító. A `Gate-SHA` horgonya viszont MARAD soreleji: a 4b. szabály kimondottan azért írja
elő, hogy a konvencióról lehessen beszélni gate-ébresztés nélkül (2397 soreleji vs 95 prózai
említés). Két szabály, két horgony, mindkettő méréssel indokolva.

**3. A sweep RECONCILE, nem backfill: beszúr ÉS töröl.** Egy csak-beszúró pass két valós hibát nem
tud kezelni. SORREND: ha a pár-kártya a másik UTÁN jön létre, az élt egy egyszeri hook örökre
elveszti. SZERKESZTÉS: egy javított elgépelés vagy egy átszülőzés után a régi él bent ragad az új
mellett. Ez utóbbi az egyetlen ok, amiért a `parent_id` egyáltalán materializálható ide (különben
pontosan az az "elavuló második másolat" hibaosztály lenne, amit az 1. pont elutasít): a reconcile
után a származtatott másolat nem tud egy sweepnél tovább eltérni az oszloptól.

**4. EGY `source` címke (`marker-v1`), nem `backfill-v1`/`live`/`manual`.** A séma kommentje három
példát vetett fel. Ha az élő út és a sweep KÜLÖNBÖZŐ címkét ír, a "töröld, amit a korpusz már nem
mond" lépés nem fogalmazható meg egy feltétellel. Egy címkével az invariáns egy sor (a
`source='marker-v1'` sorok halmaza = a korpuszból kinyert élek halmaza), és a visszavonás is:
`DELETE FROM kanban_relations WHERE source = 'marker-v1'` -- idegen `source`-ú kézi sort nem érint.

**Járulékos döntés: az élő hook SOHA nem buktathatja el a saját írását.** A `blocks` trigger
`RAISE(ABORT)`-ja az `addKanbanComment` tranzakciójában magát a kommentet vinné el. A kinyerő sosem
gyárt `blocks`-ot, tehát ez az osztály elleni védelem, nem a példány elleni. Az aszimmetria dönt: a
`kanban_relations` származtatott index, amit a reconcile nulláról újraszámol (egy kiesett él magától
gyógyul), a REVIEW-komment viszont nem gyógyul, és a teljes gate-folyamat azon fut. Naplózva megy,
nem némán.

**Hatókörön kívül, jelezve:** a `touches-file` él (sha -> fájl). A Fázis fő kérdése ("mely kártyák
érintettek X fájlt") ezt igényli, de ez a kártya csak a jelöléseket nevezi meg. Megmérve reális:
az 1069 különböző Gate-SHA-ból 1064 feloldható lokálisan (569 marveen, 495 CleanCore). Külön kártyát
igényel a `69396b63` (lekérdező végpont) ELŐTT, és git-IO lévén csak sweepbe mehet, sose az élő hookba.

**Élesben:** a backfill lefutott a produkciós DB-n, 2277 él (1196 `gate-sha`, 1044 `child-of`,
19 `pair-fe`, 18 `pair-be`), előtte azonos kimenettel igazolva egy `.backup`-másolaton, és a második
futás 0 beszúrás / 0 törlés (idempotens).

**Ki döntött:** backend (plan-grilling, kártya-komment 18054), a kártya szövegétől eltérő pontokat
kimondva. **Hivatkozás:** kártya `6cd61430`, Fázis `fe3eff9f`, séma-kártya `9d7a247a`.

## 2026-09-02 -- 1f1e3ae4 -- A sha->fájl feloldás négy döntése: a merge-csapda, a repo-kvalifikált útvonal, a kimondott-sha kulcs, a fail-closed egyértelműség

**Kontextus.** A `6cd61430` szállította a jelölés-alapú éleket, de a Fázis (`fe3eff9f`) fő kérdése
("mely kártyák érintettek X fájlt") azzal még nem volt megválaszolható: a relációk Gate-SHA-kra
mutatnak, sha->fájl leképezés nélkül. MikroB ezt a kártyát a lekérdező végpont (`69396b63`) ELÉ
ékelte, a `6cd61430` REVIEW-jában jelzett mérés alapján. Minden alábbi szám a jelenlegi
`kanban_relations` tartalmán (1069 különböző `gate-sha` cél) és a két élő repón mérve.

**1. A kártya által javasolt parancs maga a hiba: `git show --name-only` egy MERGE-ön NULLA fájlt ad.**
A `git show` merge commiton KOMBINÁLT diffet (`--cc`) ad, ami tiszta merge-nél üres. Mérve a
`b44bd8e2`-n (az előző kártya saját landolása): `git show --name-only --format=` -> **0 sor**, míg
`git diff --name-only b44bd8e2^1 b44bd8e2` -> 6 fájl. Ez azért teherhordó, mert a marveen
Gate-SHA-k túlnyomórészt `marveen-land` MERGE commitok: a naiv olvasat a marveen-oldal nagy részére
csendben üres fájllistát gyártott volna, és sikeres sweepnek látszott volna. A használt alak:
`git show --name-only -m --first-parent --format=...` -- merge-re és nem-merge-re egyaránt az
ág-oldali listát adja, egyetlen batch-elt folyamatban. Ezt NEGATÍV KONTROLL is őrzi: a teszt épít
egy valódi repót valódi merge committal, és külön ellenőrzi, hogy a naiv parancs ott TÉNYLEG üreset
ad -- ha ez valaha megváltozik, a flag-kombináció indoklása is elesik, és látszani fog.

**2. A `to_id` repo-kvalifikált (`marveen:src/db.ts`), nem csupasz útvonal.** Mindkét repóban van
`README.md`, `DECISIONS.md`, `package.json`, `src/`. A mérés szerint pont ezek a leggyakrabban
érintett fájlok (`cleancore:DECISIONS.md` 178 sha, `marveen:DECISIONS.md` 99), tehát csupasz
útvonallal a két repó kártyái egyetlen hamis "fájl" alatt olvadtak volna össze -- pontosan azon a
lekérdezésen, amiért az egész réteg épül.

**3. A `from_id` a KIMONDOTT (rövidített) sha, nem a teljes.** Mérve: az 569 marveen rövidítés
**542 különböző teljes commitra** oldódik fel. A `gate-sha` élek a kimondott alakot hordozzák, tehát
a `touches-file` élnek is azt kell; teljes-sha kulccsal a `kártya -> sha -> fájl` join némán nem
találna. A teljes sha csak belső feloldó kulcs, sose él-kulcs.

**4. Az egyértelműség hiánya fail-closed, a fel-nem-oldható sha viszont EXPLICIT sor.** Ma 0 sha
oldódik fel mindkét repóban és egyetlen git-szintű `ambiguous` sincs -- a design mégsem épít erre.
Kétrepós vagy `ambiguous` találat esetén NINCS fájl-él, csak `resolved-in ambiguous` jelölés: egy
kártya EGY commitra volt gate-elve, mindkét jelölt fájljainak rögzítése olyan változtatásokat
állítana, amiket a kártya sose tett. A fel-nem-oldható 5 sha (`0c8f5f2`, `132fc28c`, `1b6f5e6e`,
`3c1a53e`, `9f0a86390d`) pedig `resolved-in none` sort kap, nem hiányzó sort: a hiányzó sor nem
különböztethető meg a "még sose sweepeltük"-től, márpedig a kártya kifejezetten kéri a megjelölést.
Újrafuttatásnál a reconcile magától átbillenti a jelölést, ha egy sha később mégis landol.

**Járulékos: a git-IO szerkezetileg kizárva a kérés-útvonalból.** A `db.ts` SOSE importálja a
`kanban-relations-git.ts`-t; csak a sweep script importálja mindkettőt. Nem komment kéri, hogy
vigyázzunk: a szolgáltatás egyszerűen nem éri el a modult. Miért számít: egy mért sweep ~28 mp, és
ennek majdnem az egésze a CleanCore-fél a `/mnt/h` drvfs mounton, nem a git. Batch-elés nélkül
rosszabb lenne: sha-nkénti `git cat-file -e` 2,3 mp/repó, egyetlen `--batch-check` 0,07 mp.

**Járulékos: a reconcile magja `source`-onként kiemelve.** A `6cd61430` beszúr-és-töröl mechanikája
`reconcileRelationSource(source, wanted)` lett, amit a `marker-v1` és a `git-v1` egyaránt hív. Két
másolat két esély lett volna arra, hogy a TÖRLŐ predikátum finoman eltérjen -- az a fél, ami adatot
tud veszíteni.

**Élesben:** 5988 él (4919 `touches-file` + 1069 `resolved-in`), előtte azonos kimenettel igazolva
egy `.backup`-másolaton, második futás 0 beszúrás / 0 törlés.

**Ki döntött:** backend (plan-grilling, kártya-komment 18064), a kártya szövegétől eltérő pontokat
kimondva. MikroB nyitotta a kártyát a `6cd61430` mérése alapján (msg 21262).
**Hivatkozás:** kártya `1f1e3ae4`, Fázis `fe3eff9f`, előzmény `6cd61430`, séma `9d7a247a`.

## 2026-09-02 -- baf1b1b0 -- Két helyi modell egy pipeline-ban: routing-config, nem modell-csere

**Döntés:** a jelenlegi (`qwen2.5-coder:7b`) és egy második, Qwen3.8-alapú desztilláció
(`empero-ai/Qwen3.8-9B-Distill-GGUF`) EGYÜTT marad, nem csere. A választás feladat-tipus szerint,
nem operátor-döntés minden hívásnál: `store/local-llm-model-routing.json` egy statikus `--task ->
model` felülírás-térkép, amit a `local-llm.sh` csak akkor alkalmaz, ha a hívó NEM adott explicit
`--model`-t. A `store/local-llm-model` fájl marad az EGYETLEN alapértelmezés-forrás mindenre, amit a
routing nem nevesít.

**Miért nem külön "aktív modell" mező vagy dashboard-kapcsoló minden híváshoz:** a hívó (helyi
offload-worker, agent) sose dönt live-ban modell-preferenciáról, csak `--task` nevet ad át (ami már
ma is a kontraktus). A routing-config tehát a MEGLÉVŐ kontraktusra épül, nem ad új felületet a
hívóknak -- kevesebb hely a hibázásra.

**Miért csak 4 sablon route-olva a jelölt 80-ból:** mérve (kártya 4dee0c4a), a második modell
lassabb és kis kontextusnál sem fér el mindig 100%-ban a VRAM-ban (8192 ctx-nél 12/88% CPU/GPU
split). A négy sablon, ami a saját szövegében kifejezetten magyar kimenetet kér
(board-reconcile/morning-brief/daily-log/tg-draft), az egyetlen mért osztály, ahol a minőségi
előny (tényleges magyar váltás, helyes számolás, nincs gondolatjel) meghaladja a sebességi
hátrányt -- a másik 76 sablon marad a gyors alapértelmezésen.

**think:false feltétel nélkül, nem modell-lista alapján:** curl-lal igazolva, hogy egy nem-reasoning
modellen (a mai alapértelmezett) a mező no-op -- nincs hibaüzenet, nincs válaszváltozás. Ezért egy
karbantartandó "melyik modell reasoning" lista helyett a kapcsoló minden híváson megy, és egy
jövőbeli reasoning-modell automatikusan helyesen viselkedik, kód nélkül.

**Plan-grilling kihagyva, kimondva:** additív/visszafele-kompatibilis változtatás (routing
opcionális felülírás, alapértelmezés változatlan; think:false igazoltan ártalmatlan; a
tiltás-mechanizmus, ha lesz, fail-closed vilagos hibával áll meg, nem csendes fallback-kel), nincs
uj tamadasi felulet, a hívó-lánc (`local-llm-worker.sh -> local-llm.sh`) feltérképezve.

**Kiadó-bizalom az install-flow-ban nem kap kivételt:** az `empero-ai` kiadó nincs a
`store/llm-catalog-trust.json` megbízható-listáján. Ahelyett hogy ezt a fájlt egyedül bővíteném
(biztonsági döntés, Cybersecnek kell átnéznie), a `store/first-run-llm.sh` új lépése ugyanazon a
kézzel begépelt, naplózott megerősítésen megy át, mint a `--use` gate bármelyik nem listázott
kiadónál -- `--yes` alatt sosem települ automatikusan.

**Landolás blokkolva (nem e kártya hibája):** a `marveen-land.sh` sajat fleet-test köre elbukott egy
független, régóta ismert tételen (`fork-upstream-conflict-guard.test.ts`, két elavult rögzített
upstream-blob: `src/model-fallback.ts`, `src/web/token-usage.ts`) -- lásd kártya `f4442719`. A kód
itt commitolva, tesztelve, a worktree-ben vár, amíg az felold.

**Ki döntött:** MikroB (Peti kérése, Telegram msg 6113/6116/6120, 2026-09-02).
**Hivatkozás:** kártya `baf1b1b0` (Fázis `2ebe24b2`), előzmény `4dee0c4a` (modell-összehasonlítás).

## 2026-09-02 -- 69396b63 -- A reláció-lekérdező API négy döntése: három végpont, fail-closed paraméter, közös szótár, index-hint nélkül

**Kontextus.** A Fázis (`fe3eff9f`) FELADAT 3/4-e: lekérdező végpont a `kanban_relations` táblára.
A kártya egyetlen alakot javasolt (`/api/kanban/relations?to_type=file&to_id=<út>`).

**1. Három végpont, nem egy.** A javasolt sor-szűrés megmarad, de ÖNMAGÁBAN nem válaszolja meg a
Fázis saját fő kérdését. A gráf ott két ugrás (`kártya -gate-sha-> sha -touches-file-> fájl`), tehát
egy `to_type=file` szűrés SHÁKAT ad vissza, nem kártyákat, és a hívónak shánként kellene
visszakérdeznie -- N+1 a 4919 fájl-élen, pont az a minta, amit a `db.ts` máshol már elutasít. Ezért
a kétugrásos irány kap saját végpontot mindkét irányba (`/relations/cards?file=`,
`/relations/files?card=`). Elvetett alternatíva: egyetlen végpont `mode=` kapcsolóval -- ugyanaz a
két lekérdezés, csak a hívó oldalán elrejtve, és a válasz alakja úgyis eltér.

**2. Ismeretlen query-paraméter 400, nem néma figyelmen kívül hagyás.** A `37ea2f96` precedense
(elfogadott-és-figyelmen-kívül-hagyott `?status=`) itt súlyosabb: ennek a végpontnak a TELJES
feladata a "mely kártyák érintették X-et" kérdés, tehát egy elgépelt `?fromid=` a szűretlen egész
táblát adná vissza 200-zal, amit a hívó úgy olvas, hogy "ezek érintették X-et". Rossz válasz jó
válasz képében. A `limit` viszont NEM utasít el a maximum felett, hanem CSONKÍT: a hívó "mindent"
kért, megkapja amit a végpont kiszolgál, és a `total`-ból látja, mi maradt ki. A `limit=0` ezzel
szemben elutasítás, mert az nem "mindent", hanem egy értelmetlen lap.

**3. A reláció-szótár a TISZTA modulba került.** A `db.ts` szerkezetileg nem importálhatja a
`kanban-relations-git.ts`-t (az shellel hív gitet, és a kérés-útvonaltól való távoltartása maga a
védelem), viszont pont az általa írt `touches-file`/`file` stringekre kell joinolnia. Két külön
fájlban kimondott string-pár, ami némán üres választ ad, ha elcsúszik: a nulla él
megkülönböztethetetlen attól, hogy a kártya tényleg nem ért fájlt. Ezért a `REL_*`/`NODE_*`
konstansok a tiszta `kanban-relations.ts`-ben élnek, onnan használja MINDKÉT író és az olvasó is,
és teszt köti, hogy a producerek pontosan ezeket bocsátják ki.

**4. Nincs index-hint, és a komment a MÉRT tervet írja le.** Az első kommentváltozatom azt
állította, hogy mindkét ugrás a fordított irányra készült `idx_kanban_relations_to`-t olvassa.
`EXPLAIN QUERY PLAN` a 8284 élen: nem azt olvassa, hanem a PRIMARY KEY covering indexét (a fordított
index nem hordozza a joinhoz kellő `from_id`-t). A "helyes" sorrend `CROSS JOIN`-nal kikényszerítve
MÉRTEN 3,3 ms, szemben a planner 0,6 ms-ával -- ötször rosszabb. Így a kód marad hint nélkül, a
komment pedig a mérést mondja. Egy dokumentált, de hamis terv-állítás ugyanolyan doksi-drift, mint
egy elavult README.

**Járulékos:** az olyan él, ami már nem létező kártyát nevez meg, `null` mezőkkel JELENTVE jön
vissza, nem kiszűrve. A `deleteKanbanCard` takarítja a kártya-oldali éleket, tehát egy ilyen sor
valódi anomália; a néma kiszűrése elrejtené.

**Tesztelve:** 38 eset, plusz egy MUTÁCIÓS söprés a saját join-omon (6 mutáció: mindkét ugrás
`relation_type`-ja, a távoli vég node-típusa, az irány) -- mind a 6 pirosra vált, kontroll zölden.
A fixture szándékosan tartalmaz csali éleket (másik repó azonos útvonalú fájlja, rossz
`relation_type`, fordított irány), mert egy csak-helyes-sorokat tartalmazó fixture bármelyik
predikátum törlésével is átmenne.

## 2026-09-02 23:45 -- A modell kill switch fail-iránya: a hiányzó és az olvashatatlan állapotfájl NEM ugyanaz

**Döntés:** a `store/local-llm-model-disabled.json` (kártya `5d151091`) olvasásánál a HIÁNYZÓ fájl
azt jelenti, hogy semmi nincs letiltva (ez a normál kiindulási állapot, a hívás mehet), a LÉTEZŐ de
nem értelmezhető fájl viszont NEM: az meghatározhatatlan állapot, amire mindkét fogyasztó
fail-closed választ ad -- a HTTP-oldal 503 + a fájl nevét tartalmazó üzenet, a shell-oldal `exit 9`
(„ez a feladat online"). A letiltott modellre a `store/local-llm.sh` MEGÁLL, nem cserél csendben
másik modellre.
**Miért:** a csendes modellcsere pontosan az a fail-open osztály, ami miatt a kapcsoló létezik -- a
hívó egy olyan modelltől kapna draftot, amit az operátor kikapcsolt, és nem lenne honnan megtudnia.
Az „olvashatatlan fájl = semmi nincs tiltva" válasz ugyanezt csinálná, csak egy szinttel feljebb.
Az `exit 9` a flotta MÁR meglévő „ez online-ra való" kódja (a letiltott `--task` kategória is ezt
adja), tehát a visszaesés nem igényel új konvenciót a hívóknál.
**Ki döntött:** backend (implementáció); a kártya szövege Peti kérése alapján explicit kizárta a
csendes fallbacket.
**Hivatkozás:** kártya `5d151091`, pair-FE `5dd4a211`, `src/local-llm-model-disabled.ts`.

## 2026-09-03 -- dfff9b37 -- A landolók lefelé irányú ellenőrzése: bizonyítékra fail-closed, a hiányára hangos

**Döntés.** Mindkét landoló (`store/cleancore-land.sh`, `store/marveen-land.sh`) beolvassa az
`origin/main..<sha>` (illetve `origin/develop..<ág>`) tartományt egy közös könyvtárból
(`store/landing-downward-check.sh`), és kártyánként csoportosítva kiírja, mi utazik a landolással.
A `cleancore-land.sh` ELUTASÍT, ha egy commit MÁSIK kártyát nevez meg; a `marveen-land.sh` alapból
csak JELENT, és a `--card <id>` teszi elutasítássá.

**Miért.** A meglévő tip-ellenőrzés csak a felfelé irányt zárta le. A lefelé irányt semmi nem
nézte, ezért a ténylegesen előforduló eset -- a gate-elt sha AZ a tip, alatta egy korábbi kártya
gate-eletlen commitjai, mert az ügynök self-advance-elt ugyanazon az ágon -- minden ellenőrzésen
átment. 2026-09-02-án egy nap alatt háromszor fordult elő ugyanazon az ágon (19c4684a, d284193f,
45b29528); egyszer sem veszett el semmi, mert HÁROMSZOR emberi éberségen múlt.

**Három ítélet, amit a kártya rám bízott, és a mérés, ami eldöntötte.**

1. *A kártya-hivatkozás nélküli commit SEMLEGES, nem gyanús.* A kártya fail-closed-ot javasolt.
   Mérés: a CleanCore utolsó 40 nem-merge commitjából 35 hordoz `card <id>`-t, 5 nem; a marveenen a
   hivatkozás nélküli commit a TÖBBSÉG. Fail-closed itt egy dokumentációs szokásból csinálna
   landolási kaput, és a guard túlnyomórészt a SAJÁT VAKFOLTJÁRA sülne el. Egy folyton tévesen
   riasztó guardra reflexből rákerül az escape hatch, és onnantól a valódi esetet sem fogja meg.
   Ezért: elutasítás csak POZITÍV bizonyítékra, de a be nem sorolható commitok MINDEN futásnál,
   névvel kiíródnak.
2. *Az ítélet egysége a COMMIT, nem a kártya-ID.* A valós landolás-történet visszajátszása közben
   derült ki: a CleanCore `1a61865f` EGY commit, `(card e90505bb / 96ff46d4)` tárgysorral, tehát
   jogosan MINDKÉT kártyáé. ID-nkénti pontozással a 96ff46d4 "idegen kártyának" számított volna egy
   tökéletesen helyes landolás közben.
3. *A marveen JELENT, nem utasít el.* A marveen egész ügynök-ágat landol, és a visszaadott sha MAGA
   a Gate-SHA -- ott a gate a landolás UTÁN van, tehát nincs "gate-elt sha", amire kulcsolódjon.
   Mérés: alapértelmezett elutasítással a 14 utolsó marveen landolásból 10 bukott volna el; a
   `--card`-dal megnevezett esetben 1.

**Elvetett alternatíva.** Ugyanaz az elutasítás mindkét landolóban, alapból. Ez a kártya saját 4.
csapdája (túl szigorú guard = flotta-szintű leállás), és nem elméletben: a mérés szerint a marveen
landolások többségét megállította volna.

**Következmények.** `--allow-stacked <id>[,<id>...]` escape hatch, ami MEGNEVEZTETI az idegen
kártyákat (nincs vak `--force`); `LANDING_DOWNWARD_CHECK=off` kikapcsoló commit nélkül.
Visszajátszva a 14-14 utolsó valós landoláson: CleanCore 5 elutasítás (közte a `13a73c82`, ami a
`d284193f`-et viszi -- pontosan a dokumentált hibaeset), marveen 1. A nagy, szándékos batch-
landolások (`abdd3853`: 16 idegen commit, 12 kártya) `--allow-stacked`-et igényelnek -- ez a
tudatos megnevezés ára, nem hiba.


## 2026-09-03 -- Kanban-relációk réteg a memória-gráfon: híd, rejtett SHA, kapacitás-korlátok (kártya 3bd18e70, Fron Ted)

**Döntés.** A FELADAT 4/4 a meglévő memória-oldali Canvas-gráfot bővíti egy kapcsolható réteggel,
nem nyit új oldalt (a kártya előírása). Négy tervezési döntés, amit a kód nem mond ki magától:

1. *A két réteg hídja az emlék szövegében/kulcsszavaiban említett 8 hexes kártya-azonosító.* A
   `kanban_relations` táblában nincs `memory` csomópont-típus, és a memóriák sem hordoznak
   kártya-mezőt; a flotta gyakorlata viszont az, hogy a kártya-ID-t a szövegbe írja. Mérés az élő
   DB-n: 200 emlékből 87 említ 8 hexes tokent (219 különbözőt). A token csak akkor számít
   kártyának, ha a `from_type=card` élhalmazban szerepel -- egy reláció nélküli kártyára amúgy sem
   volna mit rajzolni, és így nem kell 219 darab `GET /api/kanban/<id>` kört futtatni az
   érvényesítéshez.
2. *SHA és repó csomópont nincs a rétegen.* A kártya→fájl kapcsolat a FELADAT 3 két-ugrásos
   `relations/files?card=` végpontján át jön, horgony-kártyánként egy kéréssel (6 párhuzamosan).
   Elvetett alternatíva: a teljes `touches-file` élhalmaz (2181 él, ~300 KB) lehúzása és
   kliens-oldali join -- a tábla méretével skálázódna, nem a nézettel, és pont azt az N+1-et
   helyettesítené kliens-oldali szűréssel, amit a backend a végponttal már megoldott.
3. *Felülről korlátozott kapacitás:* 50 horgony (említés-szám szerint), 110 típusos csomópont
   (1 ugrás szomszéd: szülő/gyerek/pár/döntés), 12 fájl kártyánként, 120 fájl összesen (a több
   kártya által megosztott fájl előrébb). A meglévő szimuláció O(n²) taszítást számol; 200 emlék +
   ~230 reláció-csomópont még interaktív, a korlát nélküli változat nem volna az.
4. *`decision` csomópont típus-generikusan, üres válasz nélkül.* A backend REVIEW-ja kimondta, hogy
   döntés-él ma nincs a táblában. A réteg minden nem-`sha` `to_type`-ot csomópontként kezel, a
   `decision` saját színt/alakot kapott (hatszög), a jelmagyarázat-chipje pedig rejtve marad, amíg
   a darabszám nulla -- nem gyártunk hamis döntés-csomópontot.

**Lokális LLM.** A két tiszta segédfüggvényt a `local-llm-rag.sh`-nak adtam ki; a router
`online`-ra sorolta (tévesen „security-decision"), az advisory draft pedig rossz mezőneveket,
JSON-stringes éleket és fordított rendezést tartalmazott -- eldobva, kézzel megírva. Ez a skill
saját szabálya szerint helyes kimenet, nem hiba.

## 2026-09-03 14:30 -- kártya 934dc104: a kimenő-szöveg kapu szabályfájl-útja checkout-független lett

**Döntés:** a `scripts/hooks/outgoing-copy-gate.py` szabályfájl-útja többé nem a szkript helyéhez
képest oldódik fel. Új sorrend: `OUTGOING_COPY_GATE_RULES` env -> a hívó checkout saját
`store/outgoing-copy-gate-rules.json`-ja, HA létezik -> a fő klón ugyanezen fájlja (a worktree
`.git` mutatófájljából olvasva) -> végül a hívó checkout útja. Emellett a betöltő három állapota
(`ACTIVE`/`EMPTY`/`BROKEN`) kimondott lett, a szándékosan üres eset kap egy rate-limitelt log-sort,
és van egy `--status` posztúra-kiírás.

**Miért:** a flottának 12 szkript-példánya van (ügynökönként egy worktree) és egy szabályfájlja
(gitignored + 0600, sosem utazik). Ugyanaz a kapu ezért ellentétes posztúrát vett fel aszerint,
melyik checkout hívta: a fő gyökérből némán átengedett, minden worktree-ből fail-closed lett az
email-ág -- egy olyan konfig hiánya miatt, amit az a checkout soha nem is kaphatott meg. A védelem
és a zaj fordítva volt elosztva, és két ügynök ugyanarra a kérdésre ellentétes, mindkettő HELYES
választ adott (ez mérhető volt: a dfff9b37 gate-kör REVIEW-ja fail-closed-ot jelentett, a Cybersec-
mérés néma átengedést). Mérve, nem feltételezve: a javítás előtt a worktree-példány `exit 2`-t
adott az email-payloadra, utána `exit 0`-t, azonos payloadon, azonos szabályfájlból.

**Mérlegelt alternatívák:** (a) minden worktree kapjon SAJÁT szabályfájlt a
`agent-worktree-marveen.sh`-ból -- elvetve, mert a fájl 0600 és magánszemély nevét tartalmazza, 12
másolat 12-szeres kitettség és 12 szinkronban tartandó példány; (b) fix abszolút alapértelmezés
(`/home/neon/marveen/store/...`) -- elvetve, mert a distribution-hardcode szabályba ütközik (egy
ügyfél-install más gyökéren él); (c) `git rev-parse --git-common-dir` subprocess -- elvetve, mert a
modul MINDEN Bash tool-híváskor importálódik, és egy folyamat-indítás hívásonként valós ár egy
fájlolvasásnyi kérdésért.

**Vállalt kompromisszum, hogy ne kelljen kitalálni:** a szándékosan üres állapot NEM kap per-üzenet
`systemMessage`-et, csak 6 óránként egy log-sort plusz a `--status` kiírást. Egy üzenetenkénti
figyelmeztetés a flotta legforgalmasabb csatornáján minden egyes kimenő üzenetre kigyulladna, és a
tapasztalat szerint egy ilyen kapu ilyenkor lekapcsolódik. Ha ez kevésnek bizonyul, a
`systemMessage` egy sor.

**Ki döntött:** backend2 (implementáció-szintű döntések), MikroB dispatch alapján; a lelet
Cybersecé (dfff9b37 gate-kör, L5).

**NEM ebben a kártyában, szándékosan:** a role-ügynökök generált hook-készlete nem tartalmazza a
kaput (mérve: mind a 14 ügynök `.claude/settings.json`-ja és `.claude-config/settings.json`-ja
nélküle van), tehát a szöveg-ellenőrzés az ő Telegram-válaszaikon nem fut. Az EMAIL-oldal itt
szándékos és fedett: az `email-send-gate.mjs` minden nem-fő ügynöknek keményen tiltja a küldést
(`agentGetsEmailGate(name) === name !== MAIN_AGENT_ID`), tehát nincs mit ellenőrizni. A TELEGRAM-
oldal viszont valódi, eddig dokumentálatlan hatókör-korlát. A bekapcsolása 14 ügynök minden Bash-
hívására és minden válaszára kiterjedő, `exit 2`-vel blokkolni képes viselkedésváltás -- 1b. és 9.
szabály szerint plan-grillinget és saját gate-et érdemel, nem egy útvonal-javítás mellékhatását.
Külön kártya nyílt rá.

**Hivatkozás:** kártya `934dc104`, `src/__tests__/outgoing-copy-gate-rules-path.test.ts` (13 teszt,
mindhárom állapot MINDKÉT hívási ponton kipinnelve), kapcsolódó: `36a456e3` (legyenek-e minták --
Peti döntésére vár), `3ec64c96` (a sentinel eredete), `dfff9b37` (a gate-kör).

## 2026-09-03 20:50 -- Hitelesített rendszer-direktíva csatorna: mindkét fél átvéve, plusz explicit fenntartott-küldő őr

**Döntés:** Az upstream `ensureSystemDirectiveAuthSection` (GUARDHITELES903) átvételekor NEM csak a
CLAUDE.md-szekciót (a fogadó felet) vettük át, hanem a küldő felet is (`src/web/system-directive.ts`
+ a három valódi direktíva-hívás átállítása), ÉS a fork felvett egy explicit `system`
fenntartott-küldő őrt a `POST /api/messages`-be, ami az upstreamben NINCS meg.

**Miért (a fogadó fél önmagában káros lett volna):** a szekció azt mondja ki minden ügynöknek, hogy
egy `[CONTEXT-GUARD]` / `[SYSTEM: ...]` műveletet kérő üzenet `msg_id` nélkül injekció-gyanús, és a
visszafordíthatatlan részét NEM szabad végrehajtani. A forkunkban viszont MINDEN valódi
context-guard handoff/resume és a channels-recovery memória-mentés pontosan így, csupasz
`sendPromptToSession`-nel ment ki, `msg_id` nélkül. A szekció egyedüli átvétele tehát a flotta
összes VALÓDI context-guard leállítását utasíttatta volna el az ügynökökkel -- egy működő védelem
megtörése (kódminőségi 5. szabály), nem additív változtatás. Az upstream saját kommentje ugyanezt
mondja a másik irányból: „an id-carrying sender with no receiver rule is zero protection that looks
like protection". A két fél együtt szállítandó, és ezt teszt is kikényszeríti.

**Miért kellett az upstreamen túli őr:** a szekció szövege abszolútumként állítja, hogy a
`/api/messages` POST a `from="system"`-et 403-mal utasítja el. Mérve: sem a mi, sem az upstream
`routes/messages.ts`-e nem tartalmazott explicit `system`-ellenőrzést -- a 403 pusztán abból jött,
hogy a `system` nem ismert ügynök és nincs a `SYSTEM_SENDER_IDS`-ben. Márpedig a `SYSTEM_SENDER_IDS`
pont az a változó, amibe a legkézenfekvőbb érték a `system` string; egyetlen elhihető `.env`-sor
csendben kikapcsolta volna a teljes direktíva-hitelesítést, miközben minden ügynök CLAUDE.md-je
tovább állítja, hogy áll. Mutációs méréssel igazolva: az őr nélkül, `SYSTEM_SENDER_IDS=system`
mellett a hamisított `from=system` direktíva-sor **200-at kap** (a teszt 403 → 200-ra bukik).
Az őr a tulajdonos/`SYSTEM_SENDERS` kivételek ELÉ került, hogy egyik se tudja újranyitni.

**Hatókör-korlát:** a mi `[CONTEXT-RESTART-GATE]` üzenetünk szándékosan kimaradt -- az nem direktíva,
hanem `createAgentMessage(name -> MAIN_AGENT_ID)` riasztás, valódi ügynök-feladóval, és nem kér
műveletet a címzettől. Ellenőrizve, hogy egyetlen HTTP-hívó sem használ `from=system`-et (az összes
ilyen író folyamaton belüli `createAgentMessage`: `message-router.ts`, `routes/approvals.ts`), tehát
az őr nem tör el meglévő utat.

**A második upstream tétel (`tryHandleHeartbeat` naptár-route) SKIP.** A függőségei megvannak
(`getCalendarEvents`, `HEARTBEAT_CALENDAR_ID`), de a fogyasztója nem hívná: a `scripts/heartbeat-metrics.sh`
138 sorában nulla naptár-hivatkozás van. Átvéve egy nulla hívóval rendelkező végpont lenne. A helyes
átvétel a heartbeat-digest naptár-bővítését is jelentené, az viszont funkció-döntés, nem
merge-higiénia -- külön kártyát érdemel.

**Ki döntött:** backend (mérés + hatókör-korrekció), MikroB-nak előre bejelentve a kártyán.
**Hivatkozás:** kártya `ab4c85f2`; `src/web/system-directive.ts`, `src/web/system-directive-id.ts`,
`src/web/agent-scaffold.ts` (`ensureSystemDirectiveAuthSection`), `src/web/routes/messages.ts`
(fenntartott-küldő őr), `src/__tests__/system-directive.test.ts`,
`src/__tests__/system-directive-auth-section.test.ts`,
`src/__tests__/messages-post-sender-guards.test.ts`.

**Kiegészítés (ugyanaznap, a fork saját őre találta meg):** az upstream szekció-szövegében az
ellenőrző parancs `-H "Authorization: Bearer $(cat ...)"` alakban adja a tokent, vagyis a `curl`
argv-jébe -- amit a `/proc/<pid>/cmdline` minden helyi folyamat számára olvashatóvá tesz. Ez ezen a
gépen nem elméleti: minden ügynök ugyanazzal a felhasználóval fut. A fork `token-in-argv-guard`
tesztje az `agent-scaffold.ts`-t is szkenneli, és a szekció átvételekor azonnal pirosra váltott. A
kiadott parancs ezért a flotta bevett `printf 'Authorization: Bearer %s\n' "$(cat ...)" | curl -H @-`
cső-alakjára módosult (nincs kérés-törzs, tehát a `-H @-` nem eszi meg). Kivétel-jelölés
(`guard-allow`) helyett a magyarázó komment lett átfogalmazva, hogy ne idézze a tiltott alakot --
a kivétel maga is elavulhat, a szerkezeti tiltás nem. Így a fork KÉT ponton tér el az upstream
átvételtől: a fenntartott-küldő őr és ez.

## 2026-09-03 21:35 -- Helyi-LLM modell-elosztas swimlane: adat-vegpont kontraktusa (2ffc0a96)

**Döntés:** `GET /api/local-llm/model-usage-buckets?hours=6` NEM 5 perces bucketeket ad (ahogy a
kártya CÍME mondja), hanem NYERS per-feladat sorokat modellenként csoportosítva, plusz egy KPI
blokkot. Peti későbbi pontosítása (kártya-komment 18774, design-referenciával) swimlane-t kér, ahol
minden feladat a saját kezdő-időpontjában és időtartamával jelenik meg -- ehhez bucket-összeg
használhatatlan. A `bucket_minutes` paraméter ezért nincs. A kontraktust Fron Teddy javasolta
(komment 18874), a backend hat ponton javította és MINDKÉT irányban rögzítette, MIELŐTT bármelyik
oldal épített (8b. szabály; kártya-komment 19021 + inter-agent üzenet 22019).

**A hat javítás közül kettő helyességi, nem ízlés:**

1. **A ledger 1. oszlopa a BEFEJEZÉS ideje, nem a kezdésé.** Mérve a logot ÍRÓ kódban
   (`store/local-llm.sh`): `START_MS` a hívás elején, a `$(date +%s)` viszont a `log_usage`-ben, a
   hívás UTÁN fut. Ezért `startMs = ts*1000 - durationMs`, és a válasz `startMs`-t ÉS `endMs`-t is
   ad, hogy a frontendnek ne kelljen levezetnie. Naiv `startMs = ts*1000` mellett minden swimlane-sáv
   a saját hosszával jobbra csúszna -- az élő logban van 86 másodperces feladat, ott ez azonnal
   látható hiba. A `ts` másodperc-felbontású, a `durationMs` ezredmásodperc, tehát a `startMs`
   +/-1 mp-en belül pontos; ez ki van mondva a kontraktusban.
2. **`tokensPerSec` típusa `number | null`, soha nem 0.** Az `err` és `busy` sorok token-oszlopai
   0-k (a `log_usage` ilyenkor token-argumentumok nélkül hívódik), a régi sorokban pedig nincs is
   10. oszlop. Egy 0 a grafikonon valódi "0 token/s" mérésként jelenne meg. A szomszédos
   `last-generation` végpont (b21deb9a kártya) már ezt az elvet követi -- ugyanaz maradt.

**A további négy:** mindkét latency megy (`durationMs` = wall-idő, ez a sáv szélessége, GPU-lock
várakozással együtt; `evalDurationMs` = tiszta generálási idő, ebből számol a tokens/s -- Peti 18774
explicit mindkettőt kérte); a UI-próbák kiszűrve a meglévő `isRealCall`-lal; a `busy` (GPU-lock
torlódás) NEM számít bele az `errorRatePct`-be, külön `busyCount`-ként megy, mert különben egy
terhelés-csúcs hibás rendszernek látszana; a feladat-`id` `${ts}-${index}`, mert másodperc-felbontás
mellett a sorok rendszeresen egybeesnek (a `route-classify` hívó sűrűn tüzel).

**`truncated` mező, és amit NEM állít:** a ledger-tail korlátos (5000 sor). A mező CSAK akkor igaz,
ha a tail elérte a sor-korlátot ÉS az így elért legrégebbi sor is az ablakon belülre esik. A két
tény összevonása hamis pozitív lenne: "a legrégebbi sorom frissebb az ablaknál" egy fiatal vagy
frissen rotált lognál a NORMÁLIS állapot, ahol semmi nem hiányzik.

**Nem épült új parser:** a `src/web/routes/local-llm.ts` már tartalmaz tesztelt `parseUsageRows`-t és
korlátozott `tailUsageLines`-t, az aggregáció ezekre ül (10. szabály).

**Mért állapot a bevezetéskor:** az élő logban az utolsó 6 órában 25 sor van, MIND egyetlen modell
(`qwen2.5-coder:7b-instruct-q4_K_M`), 21 ok / 4 err, ebből 19 a `route-classify` hívótól. A
routing-config másik modelljének (`hf.co/empero-ai/Qwen3.8-9B-Distill-GGUF`) továbbra is nulla
forgalma van -- pontosan az, amit a kártya STATUS QUO-ja írt. A frontend tehát élesben most egy
sávot rajzol; ez a "csak a ténylegesen aktív modellek szerepeljenek" követelmény helyes viselkedése,
nem hiba, és Fron Teddy előre megkapta.

**Ki döntött:** backend (mérés + a hat javítás), Fron Teddy (a kontraktus alapalakja), Peti (a
swimlane-követelmény és a KPI-lista).
**Hivatkozás:** kártya `2ffc0a96` (Pair-FE: `d6ecb003`); `src/web/routes/local-llm.ts`
(`buildModelUsageSwimlane` + a route), `src/__tests__/local-llm-model-usage-swimlane.test.ts`.

## 2026-09-04 05:32 -- Proaktív agent-panel-cap a load-guard-be

**Döntés:** Peti kérésére (Telegram, a 2026-09-03 WSL-overload kivizsgálása után) új, proaktív gate
épült a fut ügynök-panelek darabszámára: `store/agent-cap-check.sh` a `GET /api/agents` `running:true`
darabszámát veti össze a `load-guard-config.json` `max_concurrent_agents` értékével (első kör: 6),
bekötve `load-guard-check.sh`-ba, a már meglévő egyetlen "szabad-e új munkát indítani" choke pointba.
Fail-open minden hibaesetén (nincs token/dashboard-hiba/rossz JSON -> ADMIT).
**Miért:** a mért load-guard.log (2026-09-03) 51x sigstop_freeze/critical + 96x hard/cgroup_throttle
állapotot mutatott ~11 órán át (10:39-21:49) -- a meglévő load-guard-eval.sh csak MÉRT load-ra
(loadavg/PSI) reagál, tehát mindig utólagosan fékez. Minden futó ügynök-panel saját Claude-processz
+ MCP-szerver-alfolyamat-fa (playwright headless böngésző, filesystem-mcp, code-review-graph) -- ez a
subprocess-tömeg volt a tényleges load-forrás, nem egyetlen kártya munkája. A panel-darabszám
korlátozása a torlódást a kezdete előtt állítja meg, nem utólag fékez/fagyaszt.
**Kockázat/hatókör:** csak ÚJ munka indítását (agent start + dispatch) fékezi, már futó agentet,
gate-et vagy in-flight befejezést nem érint. Fail-open tervezés, hogy egy hibás cap-ellenőrzés ne
tudja saját magát blokkolni a teljes flotta dispatchjét.
**Ki döntött:** Peti (kérés) + MikroB (tervezés, végrehajtás). QA-gate folyamatban.
**Hivatkozás:** kártya `8c8be268`, Gate-SHA `b34b8ea1`, `store/agent-cap-check.sh`,
`store/load-guard-check.sh`, `store/load-guard-config.json`.

## 2026-09-04 06:20 -- A rendszer-direktíva csatorna saját fenntartott azonosítót kap (`system-directive`)

**Döntés:** A hitelesített direktíva-csatorna küldő-azonosítója `system`-ről `system-directive`-re
változik, és a `POST /api/messages` fenntartott-küldő őre MINDKETTŐT elutasítja, kis-nagybetűtől
függetlenül. A `SYSTEM_SENDERS` halmaz viszont szándékosan bájthű marad.

**Miért:** Cybersec MEDIUM lelete az `ab4c85f2` gate-jén (komment 22033). A `system` nem a
direktíva-csatorna névtere: öt másik folyamaton belüli író használja hétköznapi értesítésre, és
egyikük, a `routes/agents.ts` "új csapattag érkezett" üzenete, a hívó által megadott `description`
mezőt interpolálja a törzsbe. Egy megosztott Bearer tokent birtokló támadó tehát a `POST /api/agents`
úton választott szöveget juttathat egy VALÓDI `from_agent="system"` sorba, és az a recept szerint
ellenőrző ügynök pontosan ott találja meg, ahol a recept mondja. A csatorna saját azonosítója ezt
szerkezetileg zárja ki: az a sor konstrukció szerint nem direktíva. Az alternatíva minden jelenlegi
és jövőbeli `system`-író átvizsgálása lett volna injektálható interpolációra, ami fegyelemre épít,
nem szerkezetre (CLAUDE.md kódminőség 6. pont).

A kis-nagybetű rész ugyanennek a leletnek a másik fele: a `sanitizeAgentIdent` csak KARAKTERT SZŰR,
nem kisbetűsít, így a `from: "System"` átcsúszott a bájthű `=== 'system'` teszten, és utána a
`SYSTEM_SENDER_IDS=System` konfiguráció be is engedte. A javítás KIZÁRÓLAG az őr összehasonlítását
kisbetűsíti, a `SYSTEM_SENDERS` halmazt nem: az őr kisbetűsítése csak elutasítást adhat hozzá, a
halmazé viszont ELFOGADÁST adna (`SYSTEM_SENDER_IDS=CaseManager` mellett a `casemanager` küldő
egyszer csak átmenne, amit senki nem konfigurált). Egy fail-closed javítás nem lazíthatja a mellette
álló kivételt. Ezt külön regressziós teszt rögzíti, mindkét irányban mérve.

**Átmeneti kockázat: nincs.** A vevő-oldali recept (a generált CLAUDE.md szekció) ügynök-INDULÁSKOR
íródik ki, tehát elvben lehetne egy ablak, amiben a régi receptet hordozó ügynök egy VALÓS
leállítási parancsot utasítana el injekció-gyanúsként. Lemértem: jelenleg NULLA ügynök CLAUDE.md-je
tartalmazza a szekciót (a `BEGIN GENERATED: system-directive-auth` markerre egyetlen találat sincs
az éles fán), tehát a vevő-fél még sehol nem élt. Ettől függetlenül a boríték-szöveg
(`systemDirectiveEnvelope`) mostantól a konstansot interpolálja a beégetett `"system"` helyett, így
egy elavult recepttel rendelkező ügynök is a sorral EGYEZŐ értéket lát a borítékon. Ez a tulajdonság
külön teszttel van rögzítve, mert pont ez teszi a nevet később is cserélhetővé.

**Ki döntött:** Cybersec (lelet), MikroB (kártyanyitás, 5c5d7bc4), backend (végrehajtás és a
`SYSTEM_SENDERS` bájthű-hagyásának mérnöki döntése).

**Hivatkozás:** kártya `5c5d7bc4` (eredeti: `ab4c85f2`, lelet: komment 22033);
`src/web/system-directive-id.ts` (`SYSTEM_DIRECTIVE_SENDER`, `LEGACY_SYSTEM_SENDER`,
`isReservedSenderId`), `src/web/routes/messages.ts`, `src/web/system-directive.ts` (boríték),
`src/web/agent-scaffold.ts` (a szekció a konstansot interpolálja),
`src/__tests__/messages-post-sender-guards.test.ts` (17 eset),
`src/__tests__/system-directive-auth-section.test.ts`, `src/__tests__/system-directive.test.ts`.

## 2026-09-04 06:40 -- A `cd + olvasás` permission-wedge strukturális lezárása (block-and-suggest hook)

**Döntés:** A `cd <dir> && grep|sed|cat|head|tail|awk|diff|find|git <olvasó>` alakot egy új
PreToolUse hook (`scripts/hooks/cd-chain-guard.py`, Bash matcher) blokkolja, MIELŐTT a
permission-engine jóváhagyást kérne, és a hibaüzenete megnevezi a cd-mentes átírást. A hook
MINDKÉT bekötési úton települ: `injectCdChainGuard` a settings-generálásban és `ensureCdChainGuard`
a boot-idejű backfill-körben.

**Miért nem prózai szabály:** a szabály („adj át abszolút útvonalat cd helyett") a backend ügynök
saját memóriájába NÉGYSZER volt beírva, saját maga által, és négyszer regresszált rá ugyanabban a
napban. Nem tudáshiány, hanem ösztön: worktree létrehozása után cd-zni, aztán dolgozni. Mérve:
hét eset egy ügynöknél, majd három ügynök EGYSZERRE egy heartbeat-körben (backend, backend2,
backend3), majd másnap újabb három (cybered, qa2, fron-teddy), közülük egy 57 percig a d6ecb003-on.
A CLAUDE.md kódminőségi 6. pontja pont ezt írja elő: ahol lehet, szerkezet a fegyelem helyett.

**Miért blokkolás és nem auto-allow:** egy PreToolUse hook elvben visszaadhatna engedélyező
döntést, és az barátságosabbnak látszana. Rossz döntés lenne: az allow a TELJES Bash-hívásra
vonatkozik, a `cd X && grep ...` pedig lánc, tehát vakon átengedné azt is, amit az ügynök a grep
után fűzött. A blokkolás egyetlen újrapróbálkozásba kerül, és semmit nem enged meg.

**Miért ilyen szűk a hatókör:** csak fájltartalmat olvasó/kereső parancsokra fut, és csak akkor,
ha a parancsban nincs abszolút útvonal, ami feloldaná (`cd /abs && grep -n x /abs/fajl` átmegy).
A `ls`, `wc`, `du`, `stat` és társaik SZÁNDÉKOSAN kimaradtak: egyikre sem mértünk beragadást, a
`cd X && ls` viszont a leggyakoribb dolgok egyike, amit egy mérnök gépel. Ez a guard minden ügynök
Bash-hívása előtt fut, tehát egy túlillesztés valós beragadást cserélne flotta-szintű bosszúságra
(kódminőségi 2. pont: semmi spekulatív). Új parancs akkor kerül be, ha mérve lett.

**Melléklelet, külön kártyát érdemel:** a `noisy-command-guard.py`-nak EGYÁLTALÁN nincs
`inject*`/`ensure*` bekötése a kódban -- csak kézzel szerkesztett `settings.json`-okba került be.
2026-09-04-i méréssel 15 ügynökből 3-nál (`marketing`, `penzugy`, `videooo`) hiányzik. HELYESBÍTVE
ugyanaznap (kártya `2a07f29e`): itt eredetileg az is szerepelt, hogy a `marketing`-nél a blast-radius
és az npm-protect guard is hiányzik -- ez TÉVES volt, csak az egyik settings-fájlt mértem. A két élő
fájl uniójára a noisy-command-guard az EGYETLEN hiányzó, azon a 3 ügynökön. Lásd a 2a07f29e
bejegyzését a pontos mechanizmusért. A CLAUDE.md 15. szabálya közben élő kontrollként hivatkozik rá. Ez a
"kézzel másolt őr tetszőleges részhalmazt véd" hibaosztály (`0fa54550`, 13 ügynökből 5), most újra.
Ezt NEM javítottam ebben a kártyában (hatókör-tartás), jelezve MikroB-nak.

**Ki döntött:** MikroB (két kártya nyitása: a1b2a1de 2026-09-03, 6b32a478 2026-09-04 -- ugyanaz a
munka, duplikátumként jelezve), backend (végrehajtás, hatókör-szűkítés, block-vs-allow döntés).

**Hivatkozás:** kártyák `6b32a478` és `a1b2a1de` (duplikátumok);
`scripts/hooks/cd-chain-guard.py`, `scripts/hooks/cd-chain-guard.selftest.py` (29 eset),
`src/__tests__/cd-chain-guard-wiring.test.ts` (15 eset, futtatja a selftestet is),
`src/web/agent-scaffold.ts`, `src/web.ts`, CLAUDE.md 16. szabály.

## 2026-09-04 06:50 -- A fenntartott küldő-névtér az ügynök-LÉTREHOZÁSON is zár (három ajtó, nem egy)

**Döntés:** A `system-directive` és a `system` nevet mostantól nem lehet ügynök-azonosítóként
létrehozni sem. A már meglévő `isReservedSenderId` predikátum fut mind a HÁROM útvonalon, ami
`agents/` alá tud könyvtárat tenni: `POST /api/agents` (400), az egy-ügynökös bundle-importáló
(dobás), és a flotta-bundle-importáló (kihagyás `reserved name` indokkal).

**Miért:** Cybersec LOW-1 lelete az 5c5d7bc4 GO mellékleteként. Az 5c5d7bc4 ott zárta a névteret,
ahol egy azonosítót ÁLLÍTANAK (`POST /api/messages`), de nem ott, ahol KIBOCSÁTANAK. A
`sanitizeAgentName` átengedi a `system-directive` alakot, négy folyamaton belüli író pedig az
ügynök SAJÁT NEVÉT adja `from`-ként (`context-guard-runner.ts`, `context-restart-gate-runner.ts`),
tehát keletkezne valódi `from_agent="system-directive"` sor, amit nem a `sendSystemDirective()`
írt. Nem kihasználható ártalmas parancsra (a tartalom sablonos, a recept szó szerinti egyezést
követel), de visszaveszi az EGY-ÍRÓ tulajdonságot, amit az 5c5d7bc4 éppen megvett.

**Miért három ajtó és nem egy:** a lelet a `POST /api/agents`-et nevezte meg. Végignéztem, mi hív
még `agents/` alá író kódot, és a bundle-import két további bemenet: az egy-ügynökös importáló a
manifest nevét VAGY a `?name=` override-ot használja, a flotta-importáló a bundle könyvtárneveit.
Egy bundle végig támadó által írt tartalom, tehát ugyanolyan megbízhatatlan, mint egy POST törzse.
Egy ajtón zárt névtér nem névtér.

**Miért kihagyás és nem dobás a flotta-importálónál:** egy mérgezett név egy flotta-bundle-ben nem
kerülhet az operátornak a másik tizenöt ügynökébe; a `skipped` lista az, amit a UI amúgy is mutat.

**Mért részlet, ami az ellenkezőjét mutatta a várakozásnak:** a `sanitizeAgentName` a szóközt
TÖRLI (nem kötőjelre cseréli), tehát a „System Directive" alak `systemdirective` lesz, és nem éri
el a fenntartott azonosítót. A hyphenes, kis-nagybetűs, ékezetes és dupla-kötőjeles alakok viszont
igen. A tesztek a mért viselkedést rögzítik, nem a feltételezettet; az őr ezért a SZANITIZÁLT
néven fut, így ha valaki egyszer a szóközt kötőjelre képezné le, az új írásmódot is elkapja
változtatás nélkül.

**Ki döntött:** Cybersec (lelet), MikroB (kártyanyitás), backend (végrehajtás, a másik két ajtó
felderítése és a kihagyás-vs-dobás döntés).

**Hivatkozás:** kártya `b46a4b7e` (eredeti: `5c5d7bc4`, lelet: komment 19116);
`src/web/routes/agents.ts`, `src/web/agent-bundle.ts` (mindkét importáló),
`src/__tests__/reserved-agent-name.test.ts` (19 eset, 3 mutáció ajtónként külön öl).

## 2026-09-04 08:40 -- 92a4c2e7: repó-frissesség három kimondott állapottal, közös osztályozóval (Fron Ted)

**Előzmény:** Peti 2026-09-04-i észrevétele: a Frissítések oldalon nem látszik repónként, hogy egy
beépített repó friss-e vagy lemaradt. A backend (`GET /api/integrated-repos`, `statusForRepo`) már
adta a `lastCheckedAt` / `behind` / `upstreamSha` mezőket; a Beépített repók rács a `behind > 0`
esetet mutatta, de a `behind 0` NÉMA volt (nem különbözött a sosem mért repótól), a hiányzó
ellenőrzés-dátum sora elmaradt, és az oldal info-doboza még azt állította, hogy a jelzés „nem
elérhető". A Frissítések oldal egyáltalán nem beszélt a beépített repókról.

**Döntés:** (1) HÁROM kimondott állapot repónként: `naprakész` / `N commit lemaradás` / `nem mérhető`.
A `behind 0` CSAK akkor „naprakész", ha van `upstreamSha` (volt mihez mérni) és telepítve van;
pipx-telepítés vagy sosem fetchelt klón „nem mérhető" (12. szabály: nincs kitalált állapot). (2) Az
osztályozás egyetlen DOM-mentes modulban (`web/app-repo-freshness.js`), amit a rács ÉS a Frissítések
sáv is hív, így a két oldal nem tud eltérni; a modul tesztje a függvényt FUTTATJA, nem újraszámolja.
(3) A Frissítések oldal egy összegző sávot kap (számok + a lemaradt repók névsora + ugrás a rácsra),
nem a teljes rács duplikátumát. (4) Az „Utolsó ellenőrzés" sor mindig ott van („még nem történt"
helyettesítővel), mert az elhagyott sor ránézésre nem különbözött egy ellenőrzöttől.

**Ami NEM változott:** backend; a dashboardról kézzel hozzáadott repók (nincs mért adatuk, a
Frissítés gombjuk továbbra is vak pull, az info-doboz ezt most már pontosan így mondja).

**Mérés élőben (Playwright, a worktree fájljai a :3420 valós API-ja ellen, desktop 1280 + mobil 390):**
37 repó, 18 naprakész, 3 lemaradt (2 átnézés előtt), 16 nem mérhető, 15 sosem ellenőrzött; nincs
konzolhiba, nincs vízszintes görgetés, a „Repónkénti részletek" gomb 44 px és a rácsra visz.
Mutációs teszt: három mutáns (upstream-ref nélküli „naprakész", kimaradó sáv-hívás, elhagyott
ellenőrzés-sor) mindegyike bukik a guard-teszten, az alapvonal 40/40 zöld.

**Ki döntött:** Fron Ted (a három állapot és a közös modul), Peti (az igény), MikroB (dispatch, csak-FE hatókör).
**Hivatkozás:** kártya `92a4c2e7`; `web/app-repo-freshness.js`, `web/app-connectors.js`,
`web/fork-updates.js`, `src/__tests__/repo-freshness-ui.test.ts`.

## 2026-09-04 07:15 -- A `GET /api/messages/:id` végpont pótlása: a direktíva-recept saját ellenőrző lépése 404-et adott

**Döntés:** Átvettük az upstream `GET /api/messages/:id` route-ját (öt sor, a `getAgentMessage()`
már importálva volt a `PUT` kezelőhöz), és mellé egy tesztet, ami a generált CLAUDE.md-szekció
SZÖVEGÉBŐL olvassa ki a hivatkozott végpontot, majd a valódi route-kezelővel meg is hívja.

**Miért:** az `ab4c85f2` minden ügynök CLAUDE.md-jébe beírta, hogy egy rendszer-direktíva
visszafordíthatatlan része előtt hitelesíteni kell a horgony-sort a `curl .../api/messages/<N>`
paranccsal. A forkban ezen az útvonalon CSAK `PUT` volt. Élesben mérve: HTTP 404. Vagyis az az
ügynök, aki pontosan azt teszi, amit az utasítása mond, azt olvassa ki, hogy a sor nem létezik, és
a fail-closed szabály szerint egy VALÓDI leállítási direktívát utasít el injekció-gyanúsként. A
flotta stop-mechanizmusa pont akkor mondana csődöt, amikor használni kell.

**A hibaosztály, kimondva:** az `ab4c85f2`-n magam neveztem meg, hogy egy kétrészes protokoll
egyik felének átvétele rosszabb a semminél -- és ugyanabba léptem bele, csak a HARMADIK felével.
A küldőt (`sendSystemDirective`) és a fogadó receptet (a scaffold-szekció) is átvettem, az
OLVASÓ végpontot nem. Egy utasítás nem passzív szöveg: önálló résztvevő, ami képességet nevez meg.
A Cybersec gate sem kapta el, mert az azonosító ÍRÓIT auditálta, nem az olvasási utat, amit a
recept az ügynök kezébe ad.

**Miért így néz ki a teszt:** egy "létezik-e GET handler a /api/messages/:id-n" állítás csak a
route-ot rögzítené. Ha valaki átfogalmazza a receptet egy másik végpontra, a route továbbra is
létezik, a teszt zöld marad, az utasítás pedig megint törött. Ezért a teszt a végpontot a
GENERÁLT UTASÍTÁS SZÖVEGÉBŐL parse-olja ki, és azt hívja meg. Mutációval igazolva mindkét irányban:
a route eltávolítása 2 tesztet buktat, és a recept átírása egy másik végpontra ugyancsak 2-t --
vagyis a teszt a mondatot követi, nem egy konstanst.

**Biztonsági hatás: nincs új.** A route ugyanazt a sor-alakot adja vissza, amit a már meglévő
`GET /api/messages` lista-végpont, és ugyanaz mögött a Bearer-kapu mögött ül (`/api/*` 401 hiányzó
principal esetén). Nem új adat-osztály, csak egy eddig hiányzó olvasási mód ugyanarra.

**Ki döntött:** backend (a lelet és a végrehajtás), MikroB (külön kártya + külön landolási kör,
hogy a `93e55311`-en már meglévő Cybersec GO ne váljon érvénytelenné).

**Hivatkozás:** kártya `22e4c0d9` (eredeti: `ab4c85f2`); `src/web/routes/messages.ts`,
`src/__tests__/directive-recipe-endpoint-exists.test.ts`.

## 2026-09-04 09:20 -- 184dc8d7: teljes repó-tábla a Frissítések oldalon, a review-jegyzet mező hiányával kimondva (Fron Ted)

**Előzmény:** ugyanaz a Peti-észrevétel, mint a 92a4c2e7 (11 perc különbséggel nyílt a két kártya).
Dedup-kérdésre MikroB (komment 19110) FE-only körre szűkítette: teljes repó-lista + enabled/adoption
oszlop + review-jegyzet-jelző, a meglévő `GET /api/integrated-repos`-ból; az élő `git ls-remote`
elvetve (a watcher heartbeat már frissíti a `last_sha`-t, új hálózati felület felesleges).

**Mért ellentmondás a döntés 3. pontjában:** a végpont `description` mezője `cfg.description || cfg.note`
(`src/web/routes/integrated-repos.ts`), és a registry MIND a 37 bejegyzésén van `description`
(egysoros leírás), így a `note` (35 bejegyzés, 3-11 KB-os review-láncok) SOHA nincs a válaszban.
Élőben ellenőrizve (mattpocock-productivity: API-description = a magyar egysoros; a
„VENDORED 2026-07-30 (card f64fe6e1)..." note hiányzik).

**Döntés:** (1) A tábla a hat mért oszloppal épül; a review-jegyzet oszlop KONTRAKTUS-ALAPÚ: csak akkor
renderelődik, ha `typeof r.note === 'string'` legalább egy soron -- hiányzó mező = nincs oszlop, nem
„nincs jegyzet" (12. szabály, ne hazudjunk állapotot; 5aba993d tanulsága: halott jelzőt nem hagyunk
hátra). (2) A `note` egyetlen read-only mezőként való kitétele a válaszba (`note: String(cfg.note || '')`)
MikroB GO/NO-GO-jára vár (üzenet 22132); ha GO, a FE változtatás nélkül megjeleníti. (3) Sorrend
figyelem-elsőbbségi: lemaradt (commit-szám csökkenő), nem mérhető, naprakész; név szerint csoporton
belül; tiszta, tesztelt függvény (`sortReposForFreshnessTable`). (4) A korábbi „lemaradtak névsora"
lista a táblába olvadt (ugyanaz az információ, egy helyen).

**Ki döntött:** MikroB (szűkítés, ls-remote elvetése), Fron Ted (a note-mező hiányának kezelése, sorrend).
**Hivatkozás:** kártya `184dc8d7` (rokon: `92a4c2e7`); `web/fork-updates.js`, `web/app-repo-freshness.js`,
`src/__tests__/repo-freshness-ui.test.ts`.

## 2026-09-04 07:30 -- Minden hook-guard kódból, mindkét úton: a noisy-command-guard bekötése és két talált féloldalasság

**Döntés:** A `noisy-command-guard.py` bekötve a rendes `injectNoisyCommandGuard` (settings-generálás)
+ `ensureNoisyCommandGuard` (boot-idejű backfill) úton. Mellé egy meta-teszt
(`hook-guards-are-code-wired.test.ts`), ami a guard-listát a FORRÁSBÓL vezeti le, és mindegyikre
kikényszeríti MINDKÉT felet. A teszt írásakor azonnal talált két meglévő féloldalasságot, mindkettő
javítva: a `pentest-tool-install-guard` csak a backfillen volt rajta (egy ÚJ ügynök a spawn-nál nem
kapta meg), a `git-protect-guard` pedig csak a generálási úton (egy MEGLÉVŐ ügynök sosem kapott
backfillt) -- utóbbi az a guard, ami a megosztott fán a `git add -A` / `reset --hard` osztályt
blokkolja, tehát a respawn-ra várás nála a legrosszabb alapértelmezés.

**Miért nem volt bekötve eddig:** a hook 2026-08-23 óta létezik és a CLAUDE.md 15. szabálya élő
kontrollként hivatkozik rá, de a kódban SEHOL nem regisztrálta semmi. Csak azért ért el ügynököket,
mert valaki kézzel beírta a KÖZÖS `~/.claude/settings.json`-ba, amit a `provisionIsolatedConfigDir()`
másol be minden ügynök `.claude-config`-jába a provisioning pillanatában. A lefedettség tehát annak
a véletlene volt, hogy egy ügynököt MIKOR provisionáltak ahhoz a kézi szerkesztéshez képest.

**Mérési helyesbítés, saját hiba:** az első mérésem (a `6b32a478` mellékleleteként) azt is állította,
hogy a `marketing`-nél a blast-radius és az npm-protect guard is hiányzik. TÉVES: csak az
`.claude-config/settings.json`-t néztem. Ügynökönként KÉT élő settings-fájl van, és a Claude Code a
kettőt egyesíti:
- `agents/<n>/.claude/settings.json` -- PROJEKT szint, ezt írja az `agentSettingsPath()` és minden
  `ensure*` backfill. Kód-tulajdonú.
- `agents/<n>/.claude-config/settings.json` -- FELHASZNÁLÓ szint (az izolált `CLAUDE_CONFIG_DIR`),
  ezt a `provisionIsolatedConfigDir` a közös `~/.claude/settings.json`-ból MÁSOLJA.
A kettő unióján mérve egyetlen guard hiányzott, a noisy-command-guard, pontosan azon a 3 ügynökön
(`marketing`, `penzugy`, `videooo`). A README és a `06:40`-es bejegyzés helyesbítve.

**Ki döntött:** backend (a lelet, a mérés, a helyesbítés és a végrehajtás), MikroB (külön kártya).

**Hivatkozás:** kártya `2a07f29e` (eredeti jelzés: `6b32a478` melléklelete);
`src/web/agent-scaffold.ts`, `src/web.ts`, `src/__tests__/hook-guards-are-code-wired.test.ts`.

## 2026-09-04 07:50 -- A cd-chain-guard két mezei hamis-pozitívja, javítva (a guard a saját szerzőjét blokkolta)

**Döntés:** A `scripts/hooks/cd-chain-guard.py` mostantól (1) csak akkor blokkol, ha az olvasó-parancsnak
VAN útvonal-operandusa, és (2) kiszűri az idézőjeles literálokat, mielőtt szegmensekre bontaná a
parancsot. A selftest 29-ről 37 esetre nőtt, mindkét szabály mutációval igazolva.

**Miért:** a guard percekkel a landolás után elkezdett jogos parancsokat blokkolni, és elsőként a saját
szerzőjét fogta meg. Két különböző hibaosztály:
1. `cd X && git merge ... | tail -2` -- a `tail` itt egy CSÖVET olvas, nincs fájl-argumentuma, tehát
   nincs feloldandó könyvtár sem: ez a parancs SOSEM tudott volna beragadni. Ugyanez a
   `cd X && ls | head -5` és a `cd X && echo hi | cat`. A matcher a parancs NEVÉBŐL dolgozott, és nem
   nézte, van-e egyáltalán operandusa.
2. `python3 -c "print('cd /x && cat y')"` -- a guard nem szűrte az idézőjeles literálokat, ezért az
   idézőjelen BELÜLI `&&` és `|` mentén szegmensekre esett, és megfogta a guardot olyan szövegen, ami
   sosem fut le. A `noisy-command-guard.py` fejléce ezt a hibaosztályt kimondottan dokumentálja (a saját
   javasolt parancsa fogta meg magát), és emiatt szűri a literálokat -- ez a guard e nélkül indult.

**A tanulság, ami túlmutat ezen a guardon:** a REVIEW-ban magam írtam, hogy egy túlillesztés "valós
beragadást cserélne flotta-szintű bosszúságra", és épp ezt építettem bele. A 29 selftest-eset az
alakot fedte, nem a HASZNÁLATOT: egyetlen esetem sem volt csővel, és egyetlen sem adta át a wedge-alakot
argumentumként -- pedig a második mintát a saját `scripts/`-fájlokban naponta írjuk. Egy blokkoló hook
eseteit nem elég a védeni kívánt alakból meríteni; a valós parancs-korpuszból is kell.

**Ki döntött:** backend (a regresszió, a felfedezés és a javítás is).

**Hivatkozás:** eredeti kártya `6b32a478`; `scripts/hooks/cd-chain-guard.py`,
`scripts/hooks/cd-chain-guard.selftest.py` (37 eset), `src/__tests__/cd-chain-guard-wiring.test.ts`.

## 2026-09-04 08:00 -- A lockfile-out-of-sync zaj oka nem a verzió-bump volt, hanem a csomagkezelő

**Döntés:** A `store/lockfile-sync-check.sh` mostantól NEM ALKALMAZHATÓ-t (exit 0) ad, ha az adott
ref-en nincs `pnpm-lock.yaml` -- vagyis a repó nem pnpm-et használ. Az OUT OF SYNC (exit 1) marad
minden valódi esetre, és `--base` mellett a lockfile TÖRLÉSE is valódi lelet, nem "nem alkalmazható".

**Miért nem az, amit a kártya feltételezett:** a kártya (Cybersec észrevétele nyomán) azt írta, hogy
a lander bumpolja a `package.json`-t, a lockfile-t nem, ezért látszik verzió-eltérés
(`1.34.1+mikrob.47` vs `1.34.1`). Megmértem, és mindkét fele másképp van:
- A `marveen-land.sh` MÁR szinkronban tartja a `package-lock.json`-t (`bump-fork-version.sh`), és a
  `+mikrob.N` utótag SZÁNDÉKOSAN nincs benne a lockfile-ban -- a script fejléce ezt ki is mondja
  (npm az `X.Y.Z` alakot várja ott). A develop-on mért `package.json 1.34.1+mikrob.57` /
  `package-lock.json 1.34.1` tehát a TERVEZETT állapot, nem drift.
- A `cleancore-land.sh` nem bumpol semmit, csak ellenőriz.

**Ami valóban történt:** a `lockfile-sync-check.sh` pnpm-only (`pnpm install --frozen-lockfile`), a
marveen viszont npm-repó (`package-lock.json`, `pnpm-lock.yaml` nincs). A check ezért
`ERR_PNPM_NO_LOCKFILE`-t kapott ("pnpm-lock.yaml is absent"), és ezt OUT OF SYNC-nek jelentette,
"a package.json changed without regenerating pnpm-lock.yaml" szöveggel. Mivel a `marveen-land.sh`
MINDEN landolásnál bumpolja a `package.json`-t, a gate-pretriage 8. szekciója minden landolás után
kiírta a `[fail]`-t. Mérve 2026-09-04-én az `origin/develop`-on: exit 1, pontosan ezzel az üzenettel.

**Az elv, amit ez követ:** a script saját fejléce külön kezeli az exit 3-at az exit 1-től, mert
"a pnpm hiányzik" és "a lockfile elavult" különböző tények. A "ez a repó egyáltalán nem pnpm-et
használ" egy harmadik, és az sem a kártyáról szóló tény. Egy visszatérő hamis `[fail]` rosszabb,
mint ha nem lenne check: az a zaj, amiben egy VALÓDI drift elrejtőzik -- pontosan ezt jelezte
Cybersec.

**Ellenőrizve mindkét irányban:** a CleanCore-on (valódi pnpm-repó) a check TOVÁBBRA IS fut és
dolgozik (`OK -- 36 manifest(s) at HEAD match pnpm-lock.yaml`); a marveen gate-pretriage-ből a
lockfile-lelet eltűnt. A selftest 7-ről 11 esetre nőtt, és kapott egy vitest-futtatót
(`lockfile-sync-check-selftest.test.ts`), mert eddig semmi nem futtatta -- egy olyan check
selftestje, aminek a verdiktjére a `cleancore-land.sh` landolást UTASÍT EL, nem maradhat
kézi-indítású.

**NYITVA MARAD, külön kártyát érdemel:** a marveennek ezzel NINCS lockfile-drift ellenőrzése
(eddig sem volt -- a mostani csak hamisan jelzett). Egy npm-ág (`package-lock.json` ellenőrzése)
külön munka, saját tervezéssel; ezt a kártyát nem terheltem vele.

**Ki döntött:** Cybersec (az észrevétel), MikroB (kártya), backend (a mérés, a premissza
helyesbítése és a végrehajtás).

**Hivatkozás:** kártya `fe06da0c` (Cybersec észrevétel: `4ae2d3f5`);
`store/lockfile-sync-check.sh`, `src/__tests__/lockfile-sync-check-selftest.test.ts`.

## 2026-09-04 08:15 -- Cybersec NO-GO a cd-chain-guard javításán: az operandus-szabály kinyitotta a `grep -rn` alakot

**Döntés:** A rekurzió-felismerés (a) `r`/`R`-t keres BÁRHOL a rövid-flag klaszterben, nem csak
utolsó betűként, és (b) CSAK ténylegesen rekurzióra képes parancsokra fut (`grep, egrep, fgrep, rg,
ripgrep, ag, ack`) -- a `sed`/`awk` kimarad, mert ott a `-r` KITERJESZTETT REGEXET jelent, nem
rekurziót.

**Miért (Cybersec NO-GO a 7705585d-n):** a hamis-pozitív javításhoz tett operandus-ellenőrzés
kinyitotta azt a hibaosztályt, amiért a guard létezik -- a leggyakoribb írásmódjában. A régi
rekurzió-regex (`-[a-zA-Z]*[rR](?:\s|$)`) csak akkor talált, ha az `r` a klaszter UTOLSÓ betűje:
`-nr` illeszkedett, `-rn` nem. Útvonal-operandus nélkül a grep 2 operandust igényel, egy van (a
minta), tehát átengedte. Pedig a `grep -rn foo` útvonal nélkül a CWD-t járja be, vagyis a `cd`-hez
képest oldódik fel: pontosan a beragadás, amit a guard megelőz. A
`grep -rn --include="*.ts" foo` pedig szó szerint az az alak, ami a flotta paneljeit négyszer
beragasztotta.

**Miért nem vette észre a saját selftestem:** a 37 esetben MINDEN `-rn` minta hordozott egy záró `.`
útvonal-operandust, tehát az operandus-szabály megmentette őket, és a rés láthatatlan maradt.
Ugyanezért ment át a "rekurzív ág kivétele" mutáció is: az egyetlen eset, amit megfogott, a
`grep -r "x"` volt -- ott az `r` véletlenül az utolsó betű. Egy mutáció csak azt méri, amit a
tesztkészlet MEGKÜLÖNBÖZTET; ha minden eset ugyanazon a második dimenzión (van útvonal-operandus)
azonos, a mutáció zöldre futhat egy valódi lyuk fölött.

**Mellékhaszon:** a hatókörözés egyben megszüntet egy RÉGEBBI hamis pozitívot is, ami már az eredeti
guardban is benne volt: a `cd X && sed -nr "s/x/y/p"` (cső, nincs útvonal-operandus) mindkét korábbi
verzióban BLOCK volt, most PASS. Egy változtatás zárja a lyukat és nyitja a helyes utat.

**Három-utas mérés (ugyanaz a bemenet, három verzió):**
```
                                            2dd7c958   7705585d   javítás
cd /abs && grep -rn foo                      BLOCK      pass       BLOCK
cd /abs && grep -rni foo                     BLOCK      pass       BLOCK
cd /abs && grep -Rn foo                      BLOCK      pass       BLOCK
cd /abs && grep -rn --include="*.ts" foo     BLOCK      pass       BLOCK
cd /abs && sed -nr "s/x/y/p"                 BLOCK      BLOCK      pass
cd /abs && sed -nr "s/x/y/p" src/file.ts     BLOCK      BLOCK      BLOCK
cd /abs && git merge ... | tail -2           BLOCK      pass       pass
cd /abs && ls | head -5                      BLOCK      pass       pass
```

**Ki döntött:** Cybersec (a lelet, a mérés és a javítás iránya), backend (végrehajtás).

**Hivatkozás:** kártya `9c664b88` (NO-GO komment 19161), a javított commit `7705585d`;
`scripts/hooks/cd-chain-guard.py`, `scripts/hooks/cd-chain-guard.selftest.py` (43 eset).

## 2026-09-04 08:20 -- A negyedik ajtó: `POST /api/fleet/import` (QA FAIL a b46a4b7e-n)

**Döntés:** A `fleet-transfer.ts` `validateNames()`-e mostantól a `SAFE_NAME_RE` MELLETT az
`isReservedSenderId`-t is futtatja az ügynök-nevekre. A négy ajtó ezzel teljes.

**Miért:** a QA gate megtalálta azt a negyedik utat, amit a REVIEW-mban magam kérdeztem meg
("maradt-e negyedik út `agents/` alá"). A `validateNames()` csak a `SAFE_NAME_RE`-t nézte, ami
mindkét fenntartott azonosítót elfogadja szó szerint (megmérve: `/^[a-z0-9][a-z0-9_-]*$/` illeszkedik
a `system`-re és a `system-directive`-re is). A `writeAgentFiles()` saját kommentje mondja ki, hogy
a nevek "already validated by validateNames() before this is called" -- vagyis ez az EGYETLEN kapu a
`safeJoin(AGENTS_BASE_DIR, agent.name)` előtt. Egy fleet-export JSON pedig végig támadó által írt
tartalom, pontosan úgy, ahogy egy bundle manifestje -- amit a másik három ajtónál magam hoztam fel
indoklásként.

**A MÉRÉSI HIBÁM, ami miatt kimaradt:** az ajtókat két HELPER-NÉV grepelésével számoltam össze
(`scaffoldAgentDir`, `resolveDest`). Ez csak azokat az ajtókat találja meg, amelyek ezt a két
helpert használják -- a `fleet-transfer.ts` viszont `safeJoin(AGENTS_BASE_DIR, agent.name)`-nel ír,
egyiket sem hívja. A helyes felsorolás a CÉL szerint megy, nem a segédfüggvény szerint. Újrafuttatva
a cél szerint (`AGENTS_BASE_DIR` / `agentDir(` / `agentConfigRoot(` írási művelettel), a
`fleet-transfer.ts:944` az EGYETLEN további író; minden más találat már létező, korábban validált
ügynökön dolgozik, a `web.ts:102` pedig magát az alap-könyvtárat hozza létre. A négy ajtó ezzel
bizonyítottan teljes, nem csak remélhetően.

**Egy eltérés a QA javasolt egysorosától, szándékosan:** a QA a `sanitizeAgentName(...)` eredményén
ellenőrizne; én a NYERS `agent.name`-en ellenőrzök. Az a string lesz a könyvtár neve, és a
`SAFE_NAME_RE` már kikényszerítette a kisbetűt. Egy szanitizált MÁSOLAT ellenőrzése miközben az
EREDETIT írjuk ki pontosan az a hibaosztály, amit a b46a4b7e másik három ajtajánál elkerültünk
(ott a szanitizált érték a kiírt érték, ezért ott az a helyes). Teszt rögzíti mindkettőt.

**Ki döntött:** QA (a lelet és a mérés), backend (végrehajtás, a nyers-vs-szanitizált finomítás és
a cél szerinti újra-felsorolás).

**Hivatkozás:** kártya `b46a4b7e` (QA FAIL komment), `src/web/fleet-transfer.ts`,
`src/__tests__/fleet-transfer.test.ts` (4 új eset, köztük a nem-vakusság kontroll).

## 2026-09-04 08:30 -- `rg`/`ag`/`ack` alapból rekurzív: a flag-alapú felismerés rájuk nem működhet

**Döntés:** Külön `_RECURSES_BY_DEFAULT = {rg, ripgrep, ag, ack}` halmaz, ami FLAGTŐL FÜGGETLENÜL
rekurzívnak minősít, a meglévő flag-alapú ág ELŐTT.

**Miért (Cybersec, kártya 26863263):** ezek a keresők flag NÉLKÜL is a CWD-t járják be -- nem kell
`-r`. A guard viszont a `_PATTERN_FIRST` ágba sorolta őket (két operandus kell), a rekurzió-teszt
pedig flaget keresett, amiből nincs -- így egyetlen operandussal (a mintával) átcsúsztak. Mérve:
`cd /abs && rg foo` az eredeti guardon BLOCK volt, az operandus-szabálytól kezdve PASS.

**A tanulság, ami a harmadik kör után már kirajzolódik:** ennél a guardnál minden hiba ugyanabból
jött -- a parancs VISELKEDÉSÉT a parancs SZÖVEGÉBŐL próbáltam kiolvasni. A `-rn` esetén a flag
sorrendjéből, itt a flag LÉTÉBŐL. Ahol a viselkedés a parancs alapértelmezése, ott nincs mit
kiolvasni: a tudás csak a parancs NEVÉHEZ köthető, listaként. A `sed -r` (kiterjesztett regex) és az
`rg` (alapból rekurzív) ugyanannak az éremnek a két oldala: mindkettőnél a név dönt, nem a flag.

**Kockázat-szint:** MEDIUM, nem HIGH -- az `rg` telepítve van a gépen, de jelenleg egyetlen
fleet-script vagy CLAUDE.md sem használja rutinszerűen (Cybersec mérése).

**Ki döntött:** Cybersec (a lelet és a javaslat), backend (végrehajtás).

**Hivatkozás:** kártya `26863263` (a `9c664b88` gate-jének mellékleletéből);
`scripts/hooks/cd-chain-guard.py`, `scripts/hooks/cd-chain-guard.selftest.py` (49 eset).

## 2026-09-04 08:35 -- npm lockfile-drift ellenőrzés a marveenre (a fe06da0c-n nyitva hagyott lyuk)

**Döntés:** Új `store/npm-lockfile-sync-check.sh`, bekötve a `marveen-land.sh`-ba (elutasít 1-en,
sosem 3-on) és a `gate-pretriage.sh` 8b. szekciójába. A pnpm-testvér szerződését követi:
0 = szinkronban vagy nem alkalmazható, 1 = OUT OF SYNC, 2 = használati hiba, 3 = harness-hiba.

**Miért:** a `fe06da0c` megszüntette a hamis `[fail]`-t (a pnpm-only check `ERR_PNPM_NO_LOCKFILE`-t
jelentett driftnek egy npm-repóban), de ezzel a marveen ELLENŐRZÉS NÉLKÜL maradt: egy valódi drift
-- függőség deklarálva a `package.json`-ban a lockfile újragenerálása nélkül -- ma sem bukna ki a
deploy előtt. Ez pontosan az az incidens-osztály (kétszer egy napon, `8d673233` és `af7441a3`),
amiért a pnpm-check egyáltalán megszületett. Egy zaj-javítás, ami lyukat hagy, félkész.

**Miért strukturális összehasonlítás és nem `npm ci`:** az `npm ci` a registry ellen old fel, tehát
hálózat kellene hozzá minden landoláskor, és olyan okokból bukna, amik nem a kártyáról szóló tények
-- épp az, amit ez a script-család a 3-as kilépőkóddal elutasít. A `lockfileVersion: 3` amúgy is
feleslegessé teszi: a `packages[""]` a gyökér `package.json` függőség-blokkjainak MÁSOLATÁT hordozza,
tehát a drift tiszta adat-kérdés, offline és determinisztikusan válaszolható.

**Amit szándékosan NEM hasonlít: a `version` mezőket.** A `marveen-land.sh` minden landoláskor
`X.Y.Z+mikrob.N`-re bumpolja a `package.json`-t, miközben a `bump-fork-version.sh` a lockfile-t
szándékosan sima `X.Y.Z`-n tartja (npm ott a toldalék nélküli alakot várja). A verziók
összehasonlítása pontosan azt a minden-landolásos hamis `[fail]`-t hozná vissza, amit a `fe06da0c`
most szüntetett meg. Ezt selftest-eset ÉS vitest-assertion is rögzíti, hogy egy jövőbeli
"javítás" ne tudja csendben visszahozni.

**Egy hiba, amit az ELSŐ ÉLES FUTÁS talált meg (és a selftest nem):** a két dokumentumot először
környezeti változóban adtam át a python-résznek. A marveen `package-lock.json`-ja ~480 bejegyzés,
és ez `Argument list too long` (E2BIG) hibát adott -- 126-os kilépőkód, ami se nem verdikt, se nem
a script dokumentált kódja. A selftest azért nem látta, mert minden fixture-je három soros literál.
A dokumentumok most FÁJLBAN utaznak, és bekerült egy realisztikusan nagy lockfile-t használó eset.
Ugyanaz a tanulság, mint a `cd-chain-guard`-nál: egy ellenőrzés eseteit a VALÓS korpuszból is kell
meríteni, nem csak abból, amit ellenőrizni akar.

**Bizonyíték (end-to-end, valódi git-repón):** függőség hozzáadva a lockfile nélkül -> OUT OF SYNC,
megnevezve a csomagot; lockfile újragenerálva -> OK; a marveen verzió-eltérés (`+mikrob.57` vs sima)
-> OK, nem drift; manifestet nem érintő commit `--base`-szel -> nem alkalmazható. Élesben:
marveen develop -> `OK -- 21 declared dependencies match`, CleanCore -> `not applicable`.

**Ki döntött:** backend (a lelet a `fe06da0c`-n, a terv és a végrehajtás), MikroB (kártya).

**Hivatkozás:** kártya `c3f052ad` (a `fe06da0c` komment 19169-ből); `store/npm-lockfile-sync-check.sh`,
`store/marveen-land.sh`, `store/gate-pretriage.sh`, `src/__tests__/lockfile-sync-check-selftest.test.ts`.

## 2026-09-04 08:50 -- QA FAIL: egy `"$(...)"` a KETTŐS idézőjelen belül is végrehajtódik

**Döntés:** A `_strip_quoted_literals` mostantól különbséget tesz: az EGYSZERES idézőjeles szakaszt
teljesen kiüríti (abban semmi nem fut le), a KETTŐS idézőjelesből viszont MEGTARTJA a
parancs-behelyettesítéseket (`$(...)`, backtick), és csak a többit üríti ki.

**Miért (QA FAIL az 57bb35a8-on):** a korábbi verzió a kettős idézőjeles szakaszt EGÉSZBEN
kiürítette, tehát a `cd /abs && printf "%s" "$(cat relative/file.txt)"` parancsból eltűnt a
`$(cat relative/file.txt)` MIELŐTT a `_segments()` lefutott volna -- és mivel a szegmentáló épp a
`$(` határon vág, a vágási pont a már kiürített részen belül volt. A relatív utat olvasó parancs
kiesett a szövegből, és a hívás átment. Ugyanennek a parancsnak az IDÉZŐJEL NÉLKÜLI alakja helyesen
blokkolt -- fordítva, mint kellene: a `"$(...)"` az az alak, amit a shellcheck és minden
stílus-útmutató kér, és szó szerint ez a flotta saját token-átadási idiómája
(`"$(cat store/.dashboard-token)"`).

**Bash-szemantika, amit elrontottam:** csak az EGYSZERES idézőjel literál. Kettős idézőjelen belül
a `$(...)`, a backtick és a `$VAR` is kifejtődik. Egy guard, ami mindkettőt "adatnak" veszi, a
nyelvet érti félre, nem a mintát.

**Egy második lelet a saját tesztkészletemben, amit a mutáció mutatott meg:** az "egyszeres
idézőjel literál" esetem nem tartalmazott parancs-behelyettesítést, ezért a "kezeld az egyszereset
is kettősként" mutáció NEM bukott meg -- vagyis a megkülönböztetés nem volt teherbíróan tesztelve.
Pótolva: `'$(cat relative/file.txt)'` egyszeres idézőjelben ALLOW marad, és a mutáció most harap.
Ez ugyanaz a hibaosztály, amit a Cybersec a `-rn`-nél megnevezett: egy eset csak akkor mér, ha a
vizsgált DIMENZIÓN eltér a többitől.

**Három-utas mérés:** a QA reprója, a backtick-alak és a flotta token-idiómája mind
BLOCK -> pass (57bb35a8) -> BLOCK (javítás); az inert esetek (egyszeres idézőjel, wedge-alak
argumentumként, `python3 -c` törzs) végig ALLOW maradnak; a korábbi javítások (rg, grep -rn, cső)
mind állnak.

**Ki döntött:** QA (a lelet, saját adverzariális teszttel), backend (végrehajtás + a hiányzó
mutáció-eset pótlása).

**Hivatkozás:** kártya `9c664b88` (QA FAIL komment); `scripts/hooks/cd-chain-guard.py`,
`scripts/hooks/cd-chain-guard.selftest.py` (56 eset).

## 2026-09-04 08:55 -- A `chat_id: 0` konvenciót megszüntetjük, nem implementáljuk (kártya 0264b294)

**Döntés:** A `reply` tool `chat_id: 0` hívásait mindenhol a valós chat ID-re cseréljük, és NEM
építünk a pluginba `0` -> fő-csatorna feloldást.
**Miért:** A kártya kiinduló hipotézise (session-szintű kötés, amit az `update.sh` restartja
elvesztett) nem áll: a plugin `assertAllowedChat()`-je feltétel nélküli, és `git log -S` szerint az
upstream történetében soha nem létezett `0`-ra vonatkozó ág. Vagyis nem elveszett konvenció, hanem
egy sosem implementált feltételezés. A hívói oldal ezt alátámasztja: 23 ütemezett feladat már a
valós ID-t használja és működik, 5 használta a `0`-t és némán bukott. A plugin-oldali megvalósítás
drágább és kockázatosabb lett volna (allowlist-közeli kód, fork-lokális szerkesztés egy KÖVETETT
upstream fájlon, és a hatályba lépéshez a `mikrob-channels` újraindítása), miközben a doksi-oldali
igazítás azonnal hat, restart nélkül, és a kisebbséget hozza a többséghez.
**Ki döntött:** backend (plan-grilling a 0264b294-en), MikroB jóváhagyására vár a gate-en.
**Hivatkozás:** kártya 0264b294; a `buttons` fork-fejlesztés elvesztése külön kártyán: d6be510a.

## 2026-09-04 09:41 -- Trend-scan: 3 GitHub-repo licenc/relevancia-átvilágítása, 11 skill vendorolva Fron Tednek + gap-fillnek, 1 repo szándékosan kihagyva

**Döntés:** Peti kérésére (trendi GitHub-repók vizsgálata + hasznos rész beépítése skillként)
három repót néztünk át: `Leonxlnx/taste-skill`, `mvanhorn/last30days-skill`, `addyosmani/agent-skills`.
Mindhárom MIT (a LICENSE fájl tartalmát közvetlenül ellenőrizve, nem a GitHub API becslését).
`store/vendor-skill.sh`-val (a már meglévő, `f64fe6e1` kártyán épült vendorolási csővezetéken át,
NEM kézi cp-vel) **11 skill lett vendorolva**:

- **taste-skill (Fron Ted anti-slop frontend design-taste csomag, 5/~13 skill):**
  `design-taste-frontend` (v2, a fő skill a DESIGN_VARIANCE/MOTION_INTENSITY/VISUAL_DENSITY
  tárcsákkal), `industrial-brutalist-ui`, `minimalist-ui` (stílus-variánsok),
  `imagegen-frontend-web`, `imagegen-frontend-mobile` (kép-generálási irányskillek).
  Szándékosan KIHAGYVA: `taste-skill-v1` (a repó saját CHANGELOG-ja szerint a v2 lecserélte),
  `gpt-tasteskill` és `soft-skill` (ugyanazt az anti-slop területet fedik le eltérő, néhol
  ellentmondó konkrétumokkal -- több "az egyetlen igazi anti-slop skill" egyszerre betöltve
  ütköző utasításokat adna), `brandkit`, `redesign-skill`, `output-skill` (nem design-specifikus,
  kívül esik Fron Ted körén), `stitch-skill` (már van saját `stitch-cloud-upload` a hivatalos
  SDK-val -- jövőbeli kiegészítés lehet, nem ebben a körben), `image-to-code-skill` (kifejezetten
  Codexre írva, nem Claude Code-ra).
- **agent-skills (Addy Osmani 25-skill csomagja) -- UTÓLAGOS FRISSÍTÉS, nem első adoptálás:**
  ez a repó MÁR 2026-07-31 óta figyelt és részlegesen adoptált (kártya `7a6c376f`): 5 skill
  (`interview-me`, `idea-refine`, `doubt-driven-development`, `context-engineering`,
  `documentation-and-adrs`) már vendorolva volt, szó szerint megegyezik az upstreammel (a
  `git-repo-watcher.sh` az összes azóta történt upstream-változást ellenőrizte, egyik sem
  érintette ezt az 5 könyvtárat) -- ezeken NINCS teendő, nincs merge-jelölt.
  Az elmúlt hetekben upstream 6 ÚJ skillt is kapott, amit a watcher jelzett, de senki nem
  értékelt ki adoptálásra (csak azt nézte, érinti-e az 5 már kiválasztottat). Most pótolva: mind
  a 24 jelenlegi upstream skillt átnéztük a teljes saját skill-készlethez (sp-* skillek,
  ügynök-típusok, dedikált skillek) képest, és **6 újat vendoroltunk**, mert valódi rést töltenek
  be: `constraint-driven-development` (írott CONSTRAINTS.md minőségi kontraktus +
  diff-alapú "csendes lazítás" észlelés -- ehhez foghatót nem találtunk), `api-and-interface-design`
  (API-tervezési heurisztikák -- a `contract-first-codev` a dispatch-FOLYAMATOT fedi, nem a
  tervezési elveket), `browser-testing-with-devtools` (futásidejű böngésző-ellenőrzés
  mechanikája -- FIGYELEM: a `chrome-devtools-mcp` eszköznevekre épül, nálunk
  `mcp__playwright__*` van, adaptálás-követő kártya kell, MÉG NINCS átírva),
  `ci-cd-and-automation` (nálunk a gate-folyamat kanban-alapú, semmi nem fedte a tényleges
  CI-pipeline-konfigurációt), `deprecation-and-migration` (a `module-deletion-sweep` csak a
  halott-kód-törlést fedi, az `update-safety` csak a saját update.sh rollbackjét -- egyik sem
  fedi a DB expand/contract vagy API-deprecation stratégiát), `observability-and-instrumentation`
  (van `observability-engineer` ÜGYNÖK-típus, de nem volt könnyű skill, amit egy másik ügynök
  saját maga betölthet logolás/metrika/tracing hozzáadásakor -- a hiányzó
  `references/observability-checklist.md`-t a `doubt-driven-development`-nél már bevált mintával
  pótoltuk: a fájl bemásolva a skill saját `references/`-ébe, a link lapítva, mert az upstream
  `../../references/` útvonal a mi lapos `~/.claude/skills/<name>/` elrendezésünkben nem oldható
  fel). A többi upstream skill (spec-driven-development, planning-and-task-breakdown,
  incremental-implementation, source-driven-development, frontend-ui-engineering,
  debugging-and-error-recovery, code-review-and-quality, code-simplification,
  security-and-hardening, performance-optimization, git-workflow-and-versioning,
  shipping-and-launch, using-agent-skills) továbbra is KIHAGYVA: mindegyiket lefedi vagy
  túlszárnyalja egy meglévő `sp-*` skill, dedikált skill vagy ügynök-típus (pl. `sp-systematic-debugging`
  + `production-debugger`, beépített `/code-review` + `/simplify`, `white-hat-security-testing` +
  Cybersec/Cybered ügynökök és a kötelező 3-gate folyamat).
- **last30days-skill -- SZÁNDÉKOSAN NEM ADOPTÁLVA (nem vendorolva, nem figyelt repó).**
  Ez NEM "sima markdown skill": egy ~2300 soros SKILL.md vékony burka egy 123 fájlos Python
  motornak, ami böngésző-cookie/keychain kinyerést (Chrome/Safari) végez hitelesített
  scrapinghez, és egy vendorolt, NEM hivatalos X/Twitter belső API-kliens-t (`bird-search`,
  MIT licenc, de az X belső, nem-publikus API-ját utánozza -- ez ÁSZF- és fiók-tiltási
  kockázatot hordoz). A puszta SKILL.md átvétele a szkriptek nélkül egy TÖRÖTT skillt adna (olyan
  Python-hívásokra utasítana, amik nálunk nem léteznek); a szkriptek átvétele pedig pont az a
  "futtasd a repóban lévő kódot" lépés volna, amit a feladat kifejezetten tiltott. Mivel a feladat
  explicit kérte az óvatosságot ("ha bizonytalan vagy, hagyd ki és jelezd, ne találgass"), ez a
  döntés: KIHAGYVA, nincs semmilyen részleges/light változat sem gyártva helyette (egy hasonló nevű,
  de sokkal gyengébb stub-skill megtévesztő lenne). Ha Peti mégis akarja a tényleges kutatási
  motort, az egy külön, dedikált projekt lenne: saját Python-környezet, függőség-audit, és -- a
  vendorolt `bird-search` kliens miatt -- jogi/ToS-kockázat átvizsgálása, nem egy skill-másolás.

**Miért ezt a formát (`vendor-skill.sh`, nem kézi `cp`):** a flottának már van bejáratott,
auditálható vendorolási csővezetéke (`store/vendor-skill.sh` + `store/git-repo-watcher.sh` +
`store/watched-repos.json`, kártya `f64fe6e1`) minden VENDORED.md-vel (forrás, commit-sha,
licenc), és az `agent-skills` repó már eddig is ezen keresztül volt figyelve. Kézi másolással ez
a nyomkövetés elveszett volna; utólag át lett vezetve a helyes csatornán (a taste-skill 5
skillje előbb kézzel lett bemásolva, majd retroaktívan újra-vendorolva `vendor-skill.sh`-val,
hogy egységes legyen a nyilvántartás).

**Ki döntött:** MikroB (a dispatch, a licenc-átvilágítás jóváhagyása és a végső adopt/skip
szűrés), a tényleges összehasonlító kutatást egy fork-ügynök végezte a `sp-*`/skill-készlet
ellenőrzésével.
**Hivatkozás:** `store/watched-repos.json` (`taste-skill` és `agent-skills` bejegyzések),
a 11 új skill mindegyike saját `VENDORED.md`-vel `~/.claude/skills/<name>/` alatt; korábbi
`agent-skills` adoptálás: kártya `7a6c376f` / `f64fe6e1`.
## 2026-09-04 09:45 -- A README fork-fejlesztés-bejegyzés formátuma: név + tömör leírás, semmi több (kártya 3eb0bbfc)

**Döntés:** A `README.md` "Egyedi fork-fejlesztések (amiért külön fork)" szekciójának minden
bejegyzése kizárólag a funkció NEVÉBŐL (rövid, félkövér) és egy tömör, önmagában érthető
leírásból áll. Kikerül belőle: ki kérte, mikor, a kártya-ID, a fájlnév/sor/DB-mechanika és az
indoklás-történet. A meglévő 77 bejegyzés át lett húzva erre a formátumra.
**Miért:** Peti kifejezett kérése (2026-09-04, Telegram): a szekció túl részletes lett, a README-nek
a MI-t kell mondania, nem a HOGYAN-t és a MIÉRT-et. A háttér nem vész el, a git-log és ez a
`DECISIONS.md` őrzi. Mérve: a szekció 123 793 bájtról 20 364-re csökkent (83% kevesebb), miközben
egyetlen valódi képesség sem tűnt el.
**Ki döntött:** Peti (formátum), fullstack (végrehajtás).
**Hivatkozás:** kártya `3eb0bbfc`; a `CLAUDE.md` "README karbantartás" szabály fork-fejlesztések
pontja rögzíti a formátumot.

## 2026-09-04 11:25 -- Ügynök-worktree `node_modules`: valódi könyvtár, nem szimlink a megosztott fára (kártya 0b23ec28)

**Döntés:** Az ügynök-worktree-k `node_modules`-a a megosztott fő klónra mutató KÖNYVTÁR-szimlink
helyett valódi, saját könyvtár lesz, a fő klónból másolva (`cp -a`, nem `cp -al`). Marveen-en ez
egyelőre OPT-IN (`MARVEEN_WORKTREE_REAL_DEPS=1`), worktree-nként bevezetve; a lassú másoló lépés
külön szkriptbe került (`store/agent-worktree-deps.sh`), hogy egy „biztosítsd, hogy megvan" hívás
ne timeoutoljon. A `store/cc-gate-worktree.sh` `.vite` bejegyzése szintén valódi, üres könyvtár lett.

**Miért:** A 9dc0fba8 incidens gyökér-oka az volt, hogy a könyvtár-szimlink mellett a
`symlinked-node-modules-guard.py` az EGYETLEN kontroll. Cybered éke ezt kimérte:
`cd $WT/apps/web/node_modules && rm -rf ../src` a MEGOSZTOTT klón forrását törli, guard rc=0 --
a `..` kilép a `node_modules` hatóköréből, mert a guard lexikálisan gyűjt, a kernel viszont a
szimlinkelt cwd-ből fizikailag old fel.

A plan-grilling hozadéka egy HAMIS load-bearing feltevés kizárása volt: a kézenfekvő „legyen valódi
könyvtár, benne BEJEGYZÉSENKÉNTI szimlink" javítás NEM zárja a hibaosztályt, csak mélyebbre tolja --
`cd node_modules/<csomag> && rm -rf ../../src` ugyanúgy kilép, és 318 bejegyzés 318 ajtót jelent.
Az egyetlen szerkezeti zárás a valódi, saját fa. A helyfoglalás nem akadály (mérve: 990M
worktree-nként marveen-en, 918G szabad a `/home`-on). Másolás és nem újratelepítés, mert a
worktree-nek azt a függőség-állapotot kell tartania, amiről leágazott; hardlink (`cp -al`) pedig
megosztaná az inode-ot, vagyis épp a megosztott írható talajt tartaná életben.

**Következmény a szabályszövegre:** a flotta-szintű „függőség-telepítő SOHA nem futhat worktree-ből"
tilalom marveen-en megfordul azokra a worktree-kre, amik átálltak -- a `CLAUDE.md` ugyanebben a
munkában frissült, nem külön követő kártyán, hogy a szabály és a valóság ne váljon szét.

**Ki döntött:** MikroB (verdikt: GO-WITH-CHANGES, komment 19318), backend2 plan-grillingje alapján
(komment 19316). Cybersec GO és QA saját kanári-méréssel, mindkét irányban reprodukálva.

**Hivatkozás:** kártya `0b23ec28`, commit `b98bfaea`; `store/agent-worktree-deps.sh`,
`store/agent-worktree-marveen.sh`, `store/cc-gate-worktree.sh`, `src/__tests__/agent-worktree-deps.test.ts`;
előzmény: 9dc0fba8 incidens és a `symlinked-node-modules-guard.py`.

---

## 2026-09-05 -- CLAUDE.md 12. pont -- Szimbólum-jelenlét ellenőrzése azonosító-határra üljön, ne részsztringre

**Döntés.** A "Kódminőségi alapelvek" szekció új 12. pontja: egy present/absent-őr needle-je
azonosító-határra üljön (nem részsztring), ÉS a needle vigye magával a deklarációs kulcsszót
(`function foo`, nem csupasz `foo`), mert a két hiba egymás után nyílik ki -- a határ önmagában nem
elég, csak a puszta átnevezés ellen véd.

**Miért, két kártyáról ugyanazon a napon.** `a14812e8`: `content.includes('touchAncestorChain')`
zöld maradt a `touchAncestorChainRENAMED` átnevezésen -- ezt a szerző mérte és `containsAsToken`-nal
javította. Cybersec GO-ja közben megmutatta a MARADÉK rést: a valódi függvényt kivágva, egy
sor-/blokk-kommentbe vagy string-literálba írt megnevezés a kulcsszó nélküli needle-t akkor is
zölden tartja, ha a deklaráció eltűnik -- és ez nem elméleti, a kártya saját második horgonyának
(`def is_send_invocation`) cél-fájljában MÁR MA is van két ilyen komment-említés. `e5b7ff19`:
a reachability basename-részsztring volt, és a "spans" szó egy spans-ról szóló tesztben amúgy is
mindenütt ott van -- a szerző majdnem "nulla lelet"-et jelentett a saját eszköze vakságából, nem
tiszta korpuszból.

**Mit NEM ír elő.** Nem kéri meglévő őrök visszamenőleges átírását (a két konkrét helyet a saját
kártyáján jelentették, LOW-MEDIUM, egyik sem blokkolt verdiktet) -- a szabály a következő ilyen őrre
szól. Azt sem, hogy a tagadás-/idézőjel-szűrés járható út lenne hamis pozitívra: Cybersec mérése
szerint 61 állításból 8 ül tagadó/idézőjeles soron, köztük valódi állítások is, egy ilyen szűrő csak
hamis negatívot termelne -- a riport ADDITÍV kategóriát mondjon (fejléc hamis / sehol nincs lefedve)
szűrés helyett.

**Ki döntött:** Cybersec javasolta (kártyák a14812e8, e5b7ff19 gate-verdiktjei), MikroB vitte fel a
CLAUDE.md-be, ugyanabban a munkában mint egy rutin upstream-szinkron (agent/mikrob/work ->
origin/develop merge), külön kártya nélkül -- dokumentációs, kockázatmentes kiegészítés.

---

## 2026-09-04 -- 222fdc5e -- A drift-heartbeat a diverged HALMAZ változására riaszt, nem a darabszámára

**Döntés.** Az `agent-skill-drift-sync.sh` minden futás végén egy verdikt-sort ad
(`ALERT:no` / `ALERT:yes reasons=...`), és a hatóránkénti scheduled-task kizárólag erre a sorra
figyel, nem a `stale`/`diverged` számokra. A diverged **halmazt** (nem a méretét) egy állapot-fájl
őrzi (`store/agent-skill-drift-state.json`), és azt kizárólag az `--apply` futás lépteti tovább.

**Miért.** Cybersec MEDIUM lelete a 13512bde-n: a feladat azt a szabályt kapta, hogy `stale=0 ÉS
diverged=0` esetén hallgasson. Az élő állandósult állapot viszont **mérten** `current=93 stale=0
diverged=5` -- vagyis maga a RUTIN eset is `diverged>0`, tehát a feladat ugyanazt az öt sort küldte
hatóránként, naponta négyszer, örökre. A diverged halmaz jogosan állandó (QA saját 84b304c1-es
verdiktje szerint azok szándékos, értékes helyi bővítések). Két hét után senki nem olvassa -- és
akkor sem, amikor végre változik. A hír tehát nem az, hogy VAN diverged, hanem hogy MEGVÁLTOZOTT.

**Miért halmaz és nem darabszám.** Egy darabszám nem lát egy cserét: ha egy bejegyzés eltűnik és egy
másik megjelenik, a szám azonos marad, miközben valódi változás történt. A selftest ezt konkrétan
pinneli: egy fixture-swap után a mért darabszám **változatlan** (3), és a gate mégis riaszt.

**A sérült alapvonal szándékosan RIASZT, nem `die`-ol.** A ház-precedens
(`store/cleancore-main-suite-guard.sh`, kártya 6d46c7d3) meghal egy sérült állapot-fájlon, és jól
teszi: az egy KAPU, és egy kapu, ami nem tud összehasonlítani, nem mondhat verdiktet. Ez viszont egy
RIASZTÓ eszköz, aminek a szerződésében `exit 0` áll -- ha meghalna, magával vinné a hatóránkénti
szinkront is. Ugyanaz az elv, fordított mechanizmus: ha nem tudjuk BIZONYÍTANI, hogy rutin, akkor azt
mondjuk, hogy nem rutin. Fordítva soha. Ugyanezért kapott verdikt-sort a "nincs agents könyvtár" ág
is: az azt jelenti, hogy a szkennelés SEMMIT nem nézett meg, és a néma visszatérés
megkülönböztethetetlen lett volna a rutintól.

**Elfogadott kockázat, kimondva.** Az alapvonal akkor lép tovább, amikor egy `--apply` futás
ÉSZLELI a változást, nem akkor, amikor az értesítés bizonyítottan megérkezett. Ha a Telegram-küldés
elbukik, az az egy változás nem hangzik el újra. Ezért az állapot-fájl eltárolja a `previousList` és
`changedAt` mezőt, így a következő futás kimenete még mindig megmutatja, mi mozdult és mikor --
látható, csak nem riaszt újra. Az alternatíva (az alapvonalat egy explicit nyugtázásig tartani) a
nyugtázást visszatenné a prompt-rétegbe, márpedig épp ott bukott meg a szabály legelőször.

**A dry-run nem ír alapvonalat.** Aki csak ránéz, ne fogyassza el azt a változást, amit a következő
valódi futásnak kellene bejelentenie.

**Verziókövetés (a lelet másik fele).** A feladat `~/.claude/scheduled-tasks/` alatt élt, de
`seed-scheduled-tasks/` alatt nem, tehát egy újratelepítés után csendben eltűnt volna. Bekerült
(f2a14f91 / 38eb6971 mintája). **Mérve, hogy ez önmagában NEM elég:** az `update.sh` seedelő ága
kihagyja a már létező cél-könyvtárat, a `refresh_untouched_seeds` pedig csak azt frissíti, ami
byte-azonos egy korábban KIADOTT seed-verzióval -- az élő tartalom viszont sosem a seedből jött,
tehát `KEPT` maradt volna és a javítás inert. Ezért az élő másolat a renderelt seeddel byte-azonosra
lett írva; onnantól a meglévő mechanizmus magától szinkronban tartja.

**Mellékesen mért, nem ezen a kártyán javítva:** a `.env`-ben nincs `CHAT_ID` (csak egy üres
`ALLOWED_CHAT_ID`), miközben minden élő seedelt feladat konkrét `chat_id`-t használ. Egy mai
`--reseed-fleet` tehát üres `chat_id`-vel renderelné mindegyiket. Ezért az élő másolat a MEGLÉVŐ,
működő értéket kapta vissza, nem az `.env`-ből származót.

**Az arbitrary-command teszt-hook lecserélve.** A TOCTOU-selftest egy környezeti változóból vett
útvonalat FUTTATOTT az `--apply` úton -- amit mostantól egy felügyelet nélküli scheduled-task
használ. A változó most egy skill-NEVET tartalmaz, amit a script ÖSSZEHASONLÍT, és egyetlen fix
jelölő-szöveget ír; a teszt sosem igényelt többet ennél.

## 2026-09-04 12:05 -- A név-szabály mintákat a Python motor validálja, nem a Node (kártya 98dbbcc9)

**Döntés:** A dashboard `bad_name_patterns` CRUD-ja minden mintát egy külön Python segédeszközzel
(`scripts/name-pattern-tool.py`) ellenőriztet mentés ELŐTT, és a "pontos szöveg" módú bevitelt is
Python `re.escape`-pel alakítja mintává. Node-oldali `new RegExp` validáció NEM elfogadható.
**Miért:** A `scripts/hooks/outgoing-copy-gate.py` a mintákat `re.compile("|".join(pats))` alakban
fordítja, import időben, try/except NÉLKÜL. Egy le nem forduló minta tehát nem "fail-closed"
állapotot okoz: a hook `re.PatternError`-ral kilép 1-es kóddal, üres stdouttal, és mivel Claude
Code-ban CSAK a 2-es kód blokkol, a kapu ettől kezdve CSENDBEN NEM FUT egyetlen ügynöknél sem.
A két motor mérve, mindkét irányban eltér: `(?<n>x)` és `\p{L}` Node-ban érvényes és Pythonban
összeomlik (hamis ELFOGADÁS -> néma kapu-kiesés), `(?P<n>x)` és `(?#c)x` Pythonban érvényes és
Node-ban hibás (hamis ELUTASÍTÁS). Öt tesztelt alakból négy eltért. Ugyanez az indok az escapelésre:
a helyes escape-szabályok a fogyasztó motor szabályai.
**Kiegészítő döntés:** a validáló visszalépés-robbanást (ReDoS) is elutasít, mert a kapu MINDEN
eszközhívásnál lefut. A robbanást SIGALRM szakítja meg (a CPython `sre` a match-ciklusban figyeli a
szignálokat -- mérve, mielőtt ráépítettünk volna), a hívó oldali 10 mp-es process-timeout a tartalék.
A próba-szövegeket a robbanást TÉNYLEGESEN kiváltó alakra kellett cserélni: `(a+)+$` a "a"*4096-on
azonnal visszatér (mert illeszkedik), a detonáló alak a futam + EGY nem illeszkedő karakter.
**Ki döntött:** fullstack (mérés + implementáció), Peti (hibrid felület-igény), MikroB (kiosztás).
**Hivatkozás:** kártya `98dbbcc9`; `scripts/name-pattern-tool.py` (+ selftest), `src/web/outgoing-name-patterns.ts`,
`src/web/routes/name-patterns.ts`. A 0600 mód megtartása külön kikötés: `atomicWriteFileSync` csak
akkor chmod-ol, ha a hívó átadja a módot (lásd a `1ce3fd90` tanulságát).

## 2026-09-04 13:10 -- A teszt-szennyezés gyökere nem három elfelejtett env-változó, hanem két helyes mechanizmus rossz kombinációja (kártya 4c5c540c)

**Döntés:** A helyi-LLM állapotkönyvtár teszt-izolációja EGY globális vitest setup-fájlba kerül
(`src/__tests__/setup/isolate-local-llm-state.ts`), nem az érintett tesztfájlok `baseEnv()`-jébe.
**Miért:** A dispatch három fájlt nevezett meg. Megmérve TIZENKETTŐ tesztfájl futtatja a valódi
`store/local-llm.sh`-t állapot-izoláció nélkül. De a gyökér mélyebb: az `assert-not-live-install.ts`
már kizárja, hogy a suite az ÉLES checkoutban fusson, a `store/local-llm-state-dir.sh` viszont
SZÁNDÉKOSAN a FŐ klón store-jára oldja fel egy worktree állapotát (hogy egy worktree-ből hívott
script lássa a telepítés kill-switcheit). Mindkét mechanizmus helyes külön-külön; a kombinációjuk
küldte vissza pont ennek az egy fájlnak az írásait az élesbe. Ezért fájlonkénti javítás a mai napot
oldaná meg, a holnapit nem: a tizenharmadik teszt, ami spawnolja a scriptet, némán visszahozza, és
az egyetlen tünet hamis sor egy grafikonon, amit senki nem vet össze semmivel. A resolver saját
dokumentációja az `env` ágat már így írja le: "wins outright, for tests and any future layout".
**Mért bizonyíték:** a javítás előtt 232 sor `agent=test-agent`, a legfrissebb két perccel korábbi,
egy rutin landolás fleet-test futásából. A javítás után mind a 12 suite lefuttatva: 0 sor növekedés.
**Mellékleletek:** (1) az izoláció kibuktatta a `local-llm-sh-task-allowlist.test.ts`-t, ami a
`read_model()` miatt csak azért jutott el az allowlist-ágig, mert az ÉLES telepítés modell-fájlját
olvasta -- a teszt előfeltétele mostantól kimondott (saját state-dir konfigurált modellel), a
vizsgált sorrend (charset-ellenőrzés a `[[ -f ]]` létezés-próba ELŐTT) változatlan. (2) A
`model-usage-buckets` hibaüzenete "between 1 and 168"-at állított, miközben a kód 0-nál nagyobbat
fogadott el: a 0.5 működött, de sehol nem volt dokumentálva. A határ most kimondott (0.5-168) és a
szöveg egyezik a kóddal.
**Amit NEM tettünk:** a backend tartományát NEM szűkítettük 0.5-4-re. A csúszka tartománya UI-döntés;
egy általános olvasó végpont szerződését nem szabad egy widget tartományára szűkíteni (egy kézi
"mutasd az elmúlt napot" lekérdezés legitim).
**Ki döntött:** fullstack (mérés + implementáció), Peti (csúszka-igény + takarítás), MikroB (a
sorrendi pontosítás: előbb guard, csak utána takarítás).
**Hivatkozás:** kártya `4c5c540c`; `vitest.config.ts`, `src/__tests__/setup/isolate-local-llm-state.ts`.

## 2026-09-04 -- 74181db2 -- A kimenő-szöveg kapu eléri a role-ügynököket, de kill-switch mögött, alapból kikapcsolva

**Döntés (MikroB, kártya-komment 19349).** Az `outgoing-copy-gate.py` bekerül a
role-ügynökök hook-készletébe egy `Bash` matcheren, és megtanul felismerni egy
Telegram Bot API küldést a Bash-parancson belül. Az egész egy env-kapcsoló mögött
van (`OUTGOING_COPY_GATE_TELEGRAM_BASH`), ami **alapértelmezetten KI**.

**Miért.** A kapu ma csak a fő ügynök sessionjére áll: mind a 15 role-ügynök
settings-fájljában NULLA az `outgoing-copy-gate` előfordulás, tehát a CLAUDE.md
helyesírási szabálya ("a flotta MINDEN ügynökére áll") náluk kizárólag fegyelemmel
érvényesült. Az EMAIL-oldalon nincs teendő: az `email-send-gate.mjs` minden nem-fő
ügynöknek keményen tiltja a küldést, tehát nincs mit ellenőrizni.

**Amit a terv-fázisú grilling megbuktatott, MIELŐTT kód készült.** MikroB első
feltétele az volt, hogy a matcher CSAK a `mcp__plugin_telegram_telegram__reply`
hívásra szűküljön. Ez bizonyíthatóan no-op lett volna: a role-ügynökök ezt a toolt
nem tudják hívni (mind a 15-nél `telegram@claude-plugins-official: false`, és
`--channels` nélkül indulnak, `agent-worker.ts:458`), tehát a kapu tool-név szerinti
ága náluk halott kód. Az egyetlen tényleges útjuk a `telegram-reply-fallback` skill
által dokumentált nyers Bot API curl -- amin semmi nem futott, és amit a kapu Bash-ága
sem nézett (az az EMAIL-detektor).

**Elvetett alternatívák.**
- *(2) Kimondani, hogy szándékos, és csak dokumentálni.* Védhető volt: a role-ügynökök
  szokásos útja MikroB csatornáján megy tovább, ami már fedett. Elvetve, mert a
  strukturális védelem olcsóbban megkapható, mint amennyit a fegyelemre hagyás ér.
- *(3) A skillbe tett kötelező lépés.* Fegyelem, nem szerkezet (6. kódminőségi elv).

**A mért ár, ami a kapcsolót indokolja.** Egy IRRELEVÁNS Bash-hívásra a valódi kapun,
15 mintából: min 22,4 ms / medián 23,5 ms / max 26,4 ms (loadavg 9,14). Ezt minden
role-ügynök MINDEN Bash-hívása fizetné. Ezért a kapcsoló nem csak a hook korai
kilépését vezérli, hanem magát a BEKÖTÉST is: kikapcsolva a hook be sem kerül a
settingsbe, tehát nulla a költség, nem 23 ms "eldönteni, hogy ne csináljunk semmit".

**Következmények.**
- A kapcsoló KÉT irányban működik: kikapcsolva a javító-kör (`ensureGovernanceGateCommands`)
  el is TÁVOLÍTJA a korábban bedrótozott bejegyzést, különben az "alapból ki" csak friss
  telepítésre igaz.
- A Telegram-ág FAIL-OPEN marad (olvashatatlan törzsnél is), egyezően a meglévő MCP-ág
  indoklásával: a Telegram a tulajdonos egyetlen felügyeleti csatornája, ott a némulás
  drágább, mint egy átcsúszott ékezet. Az EMAIL-ág fail-closed marad.
- Az env-változó szándékosan a `<GUARD>=off` konvenció INVERZE: itt a nem-beállított
  érték jelenti a KI-t.

## 2026-09-04 -- 79f62fd7 -- A könnyű kártyák helyi modellel épülnek, de a fail-safe iránya MEGFORDUL

**Döntés.** Új, dispatch-idejű osztályozó (`store/card-build-route.sh`) dönti el, hogy egy
`planned` kártya első teljes draftját a helyi modell írja-e meg. Szerkezetében a
`route-classify.sh` mintája (determinizmus, terelés-prefilter, ablakolt olvasás, saját
audit-log, fail-fast), de a fail-safe iránya AZ ELLENKEZŐJE.

**Miért fordul meg az irány.** A `route-classify.sh` egyetlen biztonsági tulajdonsága, hogy
CSAK `LOCAL -> ONLINE` irányba tud tévedni: egy rossz válasz, egy megfagyott vagy hiányzó
modell ott egy online draftot költ, lyukat soha nem nyit. Ez az osztályozó a MÁSIK irányba
dönt -- az alapállapot ONLINE, és egy LOCAL verdikt gyengébb építőhöz visz munkát. Ezért itt
MINDEN kétség ONLINE: kill-switch, olvashatatlan kártya, üres vagy túl hosszú szöveg,
urgent/high prioritás, determinisztikus szókincs-kapu, `route-classify` SECURITY **vagy
ABSTAIN**, a modell COMPLEX/BUSY/UNKNOWN válasza, hiányzó modell. LOCAL csak akkor, ha MINDEN
fokozat igenlően átenged -- konjunkció, nem szavazás.

**Amit a mérés megváltoztatott a terven.** A selftest a tábla 15 VALÓDI kártyáján fut, a
modellt a legmegengedőbb válaszára (EASY) rögzítve -- így ami mégis ONLINE marad, azt a
determinisztikus kapu fogta meg. Az első változat ezen **5 kártyát elengedett**: azok
biztonsága kizárólag a 7B COMPLEX-válaszán állt, egy rossz húzásra a gyengébb építőhöz
kerültek volna. A négy hiányzó osztály (pénz; tárolt-objektum integritás és presign;
kliens-adta érték hitelessége; dokumentum-összeállítás) most NÉVVEL szerepel a kapuban, és a
szám 0-ra ment. A selftest minden futáson kiírja ezt a számot.

**Amit a kockázatból NEM szabad eltúlozni.** A LOCAL kártyát is az online szerep-ügynök
építi -- a draftot átnézi és finomítja --, és ugyanúgy megy a QA+Cybersec gate-en. A
hibamód tehát HORGONYZÁS (egy hihetőnek látszó rossz draft elfogadása), nem ellenőrizetlen
kód. Ez valós, de más nagyságrend, és ez indokolja, hogy egyáltalán belevágjunk.

**A legvalószínűbb bukás, amit a terv-fázisú grilling kihozott.** Nem a téves osztályozás,
hanem hogy JÓL osztályoz és mégsem történik semmi: a heartbeat egy LLM által végrehajtott
skill, a dispatch-szöveg tanács. Ezért a heartbeat 4b. lépése a KONKRÉT, futtatható
`local-llm-rag.sh` parancssort viszi a dispatch-üzenetbe -- e nélkül a változás kívülről
megkülönböztethetetlen lenne a no-op-tól.

**Nyitva hagyva, szándékosan.** A `seed-scheduled-tasks/` alatti (verziókövetett) heartbeat
kapta meg a 4b. lépést; a FUTÓ példány (`~/.claude/scheduled-tasks/`) nem. Az MikroB saját
10 perces köre, a bekapcsolás időzítése az ő döntése.

## 2026-09-04 -- 0c66be37 -- A név-ellenőrzés hibája a KAPUT rontsa el, ne a hookot -- és a timeout DOBJON

**Döntés.** A `re.compile` bekerül a `try`-ba, és a match-időre wall-clock költségkeret kerül. Egy
hibás vagy lassú minta a NÉV-ELLENŐRZÉST kapcsolja `STATE_BROKEN`-re; a hook maga fut tovább.

**Miért.** A `BAD_NAME = load_bad_name()` MODUL-SZINTEN, import időben fut, és a `re.compile` a
`try`-on KÍVÜL volt. Egy elgépelt minta így nem egy ágat ölt meg, hanem az EGÉSZ hookot, mielőtt
bármit ellenőrzött volna. Claude Code-ban csak a 2-es kilépési kód blokkol -- exit 1 + üres stdout
azt jelenti, hogy a kimenő-szűrés MINDEN ügynöknél NÉMÁN nem fut. Reprodukálva a valódi hookkal:
`["Kovacs"]` -> exit 2 (blokkol egy ékezet nélküli levelet), `["Kovacs","(?<n>x)"]` -> exit 1, 0
bájt stdout.

**A MÁSODIK AJTÓ UGYANABBA A SZOBÁBA, amit megmértem, mielőtt eldöntöttem volna, hogy hatókörbe
tartozik-e.** Egy minta hibátlanul fordulhat és MATCH-időben mégis katasztrofálisan visszalépni. A
kártya által is említett `zzz(a+)+$` mintára egy `zzz` + 40 `a` törzsön a hook 25 másodperc után is
FUTOTT. Élesben `timeout: 10`-cel van bejegyezve, tehát a futtató megöli, a kilépési kód nem 2, és a
küldés ellenőrizetlenül megy ki -- bájtra ugyanaz a következmény, mint a fordítási összeomlásnál. A
validátor ezt nem zárja: a ReDoS-ellenőrzése PRÓBA-alapú, tehát egy ritka prefixre horgonyzott minta
átmegy rajta és csak valódi forgalmon lassú. Ezért a keret a hook oldalán van, ahol a tényleges
szöveg van.

**A load-bearing részlet: a timeout DOB, nem `None`-t ad vissza.** A `None` (nincs találat) lett
volna az egyetlen rossz válasz: egy csendes „a név rendben". A dobás után a KÉT MEGLÉVŐ háló dönt,
új állapot bevezetése nélkül -- az email-út fail-closed burkolója exit 2-t csinál belőle, a
`telegram_gate` dokumentált fail-open ága exit 0-t plusz hangos figyelmeztetést. Mutációval
igazolva: ha a jelzéskezelő visszatér dobás helyett, a keresés NEM szakad meg (a C-szintű regex-motor
fut tovább), és a teljes selftest lefagy -- pontosan az éles tünet.

**Az üzenet is javult, mert muszáj volt.** A `BAD_NAME is None` ág egyetlen szövege az volt, hogy „a
NEV-SZABALY fajl hianyzik/ures". Egy hibás mintánál ez HAMIS, és a következő olvasót egy létező,
olvasható, érvényes JSON keresésére küldi. A rossz magyarázat rosszabb, mint a hiányzó: megállítja a
keresést. A két ok most külön nevet kap mindkét felhasználói üzenetben, és a selftest állítja, hogy
megkülönböztethetők.

## 2026-09-04 -- 171c9f42 -- A FAILING verdikt saját kilépési kódot kap, hogy a flag tolerálhassa a hiányzót és soha ne a bukót

**Döntés.** A `gate_verdict_check` mostantól HÁROM kimenetet ad: 0 = mehet, 1 = nincs használható
verdikt (egy explicit, megnevezett flag felülírhatja), 2 = BUKÓ verdikt (soha nem felülírható). A
`cleancore-land.sh` MINDIG meghívja, és a `--allow-ungated` csak az 1-est tolerálja.

**Miért.** A flag eddig nem a DÖNTÉST kerülte meg, hanem a HÍVÁST -- így a FAILED ág sosem futott le.
Három hely állította, hogy egy bukó verdikt sosem járható körbe (a helper saját üzenete, a lander
kommentje, és a kártya QA-verdiktje), és egyik sem volt igaz. Egyetlen kilépési kóddal a hívó nem is
tudja kifejezni a különbséget, ezért kellett a 2-es.

**A marveen-oldal két hibája.** A `marveen-land.sh` az ÁGNEVET adta át ott, ahol sha kell -- a parser
hex-prefixet hasonlít, tehát egy ágnév SOSEM egyezhet, és egy teljesen gate-elt kártya ugyanazt a
"nincs verdikt" sort kapta, mint egy ellenőrizetlen. A hívás végén álló `|| true` pedig azt az egy
kimenetet nyelte el, amiért az egész ott van: report módban a helper amúgy is 0-t ad mindenre a bukó
verdikten kívül.

**A LOW, ami a legfontosabb volt.** Cybersec megmutatta, hogy a két wiring-teszt a FORRÁS SZÖVEGÉT
nézte, és a helper `return 1 -> return 0` mutációja mellett is ZÖLD maradt. Egy teszt, ami nem tud
elbukni a kontroll eltávolításától, nem bizonyíték. A viselkedés-bizonyíték most a selftestben van:
a VALÓDI `cleancore-land.sh`-t hajtja végig a valódi `--allow-ungated` úton egy stub tábla ellen. A
wiring-teszt ezt teszi törölhetetlenné (ha azok az esetek eltűnnek, elbukik), és forrás-szinten már
csak a három ténylegesen hibás dolgot pinneli.

**Egy saját csapda a mérés közben.** Az első mutációs futásom szerint a marveen-oldali két javítás
NEM volt lefedve. Tévedés volt: a shell-idézőjelezés miatt a csere sosem került a fájlba. Miután a
szkript ELLENŐRZI, hogy a mutáció tényleg a lemezen van (`applied=True`), mindkettő harap. Egy nem
alkalmazott mutáció "a teszt vak" alakban hazudik.
## 2026-09-04 13:16 -- A takarítás a MODELL oszlopra szűr, nem az ügynökére (kártya 4c5c540c)

**Döntés:** A `store/local-llm-usage.log` takarítása a `model == "test-model"` sorokat törli
(288 db), nem a kártyában megnevezett `agent == "test-agent"` sorokat (256 db).
**Miért:** A tünet, amit Peti megnevezett, az hogy a swimlane-en HARMADIK modellként jelenik meg
egy nem létező modell. A swimlane MODELL szerint csoportosít, és a ledgerben a valódi `queue`
hívó is írt 32 sort a hamis `test-model`-lel. Csak az `agent=test-agent` sorok törlése tehát
bent hagyta volna a hamis modellt a grafikonon, vagyis pont azt, amit meg kellett szüntetni.
Ellenőrizve: a ledger összesen HÁROM modellnevet tartalmaz, a `test-model` egyiknek sem valódi
neve.
**Amit KIFEJEZETTEN nem töröltünk:** több VALÓDI hívó neve tartalmazza a "test" szót
(`backend-selftest`, `backend2-functest`, `backend2-test`, `mikrob-hybrid-test`,
`mikrob-selftest`, és egy csupasz `test`, ami a VALÓDI qwen modellt használta). Egy `grep -v test`
mindet elvitte volna. A szűrés ezért egyetlen oszlopra horgonyzott, pontos egyenlőség, sosem
soron végzett részsztring-keresés.
**Végrehajtás:** `store/usage-log-purge-test-rows.py` (verziókövetett, újrafuttatható,
alapból dry-run). Előbb egy MÁSOLATON próbáltuk ki: 288 sor törölve, mind az 5624 valódi qwen-sor
és mind a 8 valódi "test"-nevű hívó érintetlen; csak ezután futott élesben, időbélyeges
biztonsági mentéssel. A script a futás közben érkező sorokat is megtartja (a ledgerre nincs lock).
**Sorrend igazolva:** a guard landolása UTÁN takarítottunk, és a `fleet-test.sh --ref 909e815b`
a három szennyező suite-ra 0 sor növekedést adott -- vagyis a valódi landolási úton is fog.
**Ki döntött:** fullstack (mérés + végrehajtás), MikroB (sorrend), Peti (igény).

## 2026-09-04 13:30 -- A swimlane-blokkok pakolása a KIRAJZOLT geometrián fut, és sűrű módot kap (kártya 4c5c540c, Peti képe)

**Döntés:** A modell-sávon belüli blokkok interval-packinggel al-sorokba kerülnek (first-fit), a
pakolás pedig a KIRAJZOLT dobozokra fut (bal/jobb él százalékban), nem a nyers idő-intervallumokra.
**Miért:** A renderer minden blokkot egy minimum-szélességre kerekít. Élő adaton mérve (4 órás
ablak): a 74 blokkból 66 (89%) RÖVIDEBB ennél a küszöbnél, tehát szélesebbre rajzolódik, mint
ameddig tartott, és akkor is ütközik, ha az intervalluma nem érintkezik. Emellett 40 VALÓDI
idő-átfedés is van. Idő-alapú pakolás tehát a látott hibát nem oldotta volna meg.
**Következmény, amit ki kellett mondani:** a CSS-ből törölni kellett a `min-width: 10px`-et. Két
külön alsó korlát (0.6% ÉS 10px) mellett a pakoló nem tudhatja egy blokk valódi kirajzolt
szélességét -- a "nincs átfedés" igaz lett volna százalékban és hamis a képernyőn (0.6% egy ~700px
sávon ~4px, tehát a pixel-korlát csendben győzött). Egy szám dönt.
**SŰRŰ MÓD (a szigorú pakolás ára):** a lokális hívás naplózott időtartama TARTALMAZZA a GPU-lock
várakozást, ezért a sorban álló hívások wall-clock intervalluma ténylegesen átfed. Mérve: 30 perces
ablakon 23 al-sor, 1 órán 20, 4 órán 36. A régi 30px-es sormagassággal ez EGYETLEN modellre
760-1190px magas sáv, vagyis a szigorú pakolás önmagában egy átfedést cserélt volna egy
használhatatlan grafikonra. Ezért 4 al-sor fölött a sáv vékony sorokra vált (a blokk-felirat
elfogy, a szín + tooltip viszi a jelentést), 260px fölött pedig görget.
**Ki döntött:** Peti (ne fedjék egymást), fullstack (a mérés és a sűrű mód, mert a szigorú pakolás
mért ára ez volt), MikroB (átadás).
**Hivatkozás:** kártya `4c5c540c`; `web/app-overview.js` (`ovwLlmDistPackRows`),
`src/__tests__/llmdist-lane-packing.test.ts` (a pakolót ténylegesen FUTTATJA, nem grepeli).

## 2026-09-04 14:55 -- Az uzenet-backlog figyelo a `[session-stuck]` KIEGESZITESE, nem masodik csatorna (kartya 1e7ba5c1)

**Döntés:** A `message-backlog-watcher` megmarad, de KIZÁRÓLAG kiegészítésként: hallgat minden olyan
ügynökről, akiről a router az elmúlt órában már küldött `[session-stuck]` riasztást, és soha nem
riaszt a fő-ügynökről. A küszöb továbbra is ÉLETKOR-alapú (nem darabszám), a cooldown ügynökönkénti,
és a riasztás szövege attól függ, van-e élő panel.
**Miért:** A kártya eredeti premisszája -- „a backlog végpontot senki nem figyeli" -- MÉRHETŐEN
TÉVES volt, és ezt Cybered bizonyította: a `message-router.ts` már ma is küldi ugyanazt a riasztást
ugyanabba a postaládába (174 db / 7 nap), méghozzá TÖBB információval, mert kiolvassa a panelt, és
így meg tudja különböztetni a dolgozó ügynököt a beragadttól -- amit a sor önmagában nem tud. Az én
REVIEW-m a router kommentjét idézte („the queue side alone cannot tell them apart"), de a sor ott nem
ér véget: `; the pane can`. Az emitter ~100 sorral feljebb van ugyanabban a fájlban. A keresésem a
scheduled-taskokra, a heartbeatre és a `fleet-nudger.sh`-ra terjedt ki, a folyamaton belüli
watcher-ekre nem -- ott, ahol a fogyasztó ténylegesen él.
**A maradék rés, ami VALÓS, és amiért a watcher mégis marad:** a router `agentStuckSince` térképe
MEMÓRIÁBAN él, tehát egy dashboard-újraindítás nullázza, míg az üzenetek `created_at`-ja túléli. Egy
újraindításon átnyúló, régi sor így teljesen kicsúszhat a `[session-stuck]` alól, mert az órát senki
nem indítja újra egy már öreg sorra. Ezt a rést fedi le a watcher, és csak ezt.
**Miért kötelező a fő-ügynök tiltása:** a riasztás CÍMZETTJE a fő-ügynök, tehát egy róla szóló
riasztás pont abba a sorba kerül, amit leír, és a watcher a saját kimenetét kezdi mérni. Cybered
visszajátszotta 7 valós napon: 57 riasztásból 11 volt ilyen, és a nyolcadik óránkénti ismétlésre a
jelentett 11 pending sorból 7 a watcher saját gyártmánya lett volna. Mindkét szomszédos emitter
(`formatStuckSessionAlert`, `notifyOrchestratorOfFailedHandoff`) ugyanígy tiltja, kiírt indokkal.
**Ki döntött:** Cybered (mérés + NO-GO), MikroB (hatókör-döntés: kiegészítés, dedup-pal), backend2
(implementáció).
**Hivatkozás:** kártya `1e7ba5c1`, Cybered komment 19609, MikroB msg 22523;
`src/web/message-backlog-watcher.ts`, `db.recentStuckAlertContents`.

## 2026-09-04 14:55 -- Az auto-dispatch belyegzese KULON belepesi ponton megy, ujrakuldes-or nelkul (kartya 382dcb15)

**Döntés:** A `fireKanbanDispatch` az `appendCardStateStampForDispatch`-et hívja, ami ugyanazt a
bélyeget teszi ki, de a „már van benne marker -> ez újraküldés" őr NÉLKÜL. A `POST /api/messages` út
változatlanul az őrzött `appendCardStateStamp`-et használja.
**Miért:** Az őr a TELJES tartalmat vizsgálta (`content.includes(CARD_STATE_MARKER)`), a dispatch-út
tartalma viszont a kártya saját címéből és leírásából áll össze. Egy olyan kártya tehát, aminek a
leírása csak MEGEMLÍTI a `[card-state @send]` stringet, „igen"-t kapott, és a dispatch némán,
bélyegzetlenül ment ki. Nem elméleti és pont ott a legrosszabb, ahol számít: a `382dcb15` (maga a
bélyegzésről szóló kártya) és a `790c962d` leírása is tartalmazza a markert, tehát az a két kártya,
amit ezen a feature-ön dolgozva a legvalószínűbben dispatchelnek, épp az a kettő volt, amit nem
bélyegeztünk volna. És mivel a kézbesítés-kori lábléc a küldés-kori bélyeget veszi bemenetnek, a
kimaradás kétszeresen láthatatlan.
**Miért biztonságos az őrt elhagyni ezen az úton:** ez az út SOHA nem újraküldés -- minden híváskor
frissen állítja össze a tartalmat a tábláról, tehát egy marker abban a szövegben a kártya, ami a
bélyegzésről BESZÉL, nem egy bélyeg, amit ez a kód írt.
**Ismert maradék, kimondva:** ha egy leírás nem csak a markert, hanem egy teljes bélyegzett SORT is
tartalmaz, a `formatDeliveryStalenessNote` azt is beolvassa, mert az egész törzset pásztázza. Ez
csak téves „változott" tippet adhat, valódit elnyomni nem tud, és egy kézzel írt üzenet ma is meg
tudja tenni -- tehát tipp-minőségi kérdés, nem ennek a kártyának a hibája.
**Ki döntött:** Cybered (F1 lelet), MikroB (jóváhagyás), backend2 (implementáció).
**Hivatkozás:** kártya `382dcb15`, Cybered komment 19612; `src/web/kanban-state-stamp.ts`,
`src/web/routes/kanban.ts`.

## 2026-09-04 17:55 -- Tíz perces gördíthető viewport a swimlane-en, és a "padding is minimum-width" csapda MÁSODSZOR (kártya b52c3c42)

**Döntés:** A betöltött tartomány (csúszka, 30p-4h) és a LÁTHATÓ ablak (10 perc) két külön
mechanizmus. A vászon `zoom = tartomány/10perc` viewportnyi széles, vízszintesen gördíthető, és a
`calc(106px + (100% - 106px) * zoom)` képlet CSAK a sáv-területet szorozza -- a 106px-es
címke-oszlopot nem. Enélkül a látható szelet a címke szélességével rövidebb lenne, tehát a "tíz
perc" állítás egyszerűen hamis lenne (~13% eltérés tipikus kártya-szélességen). Böngészőben mérve:
pontosan 10,00 perc látszik.
**Geometria:** a minimum-szélesség és a rés a viewport SZÁZALÉKÁBAN van megadva, és zoom-mal
osztódik, így pixelben ugyanakkora marad bármekkora betöltött tartománynál. Ez teszi
megfizethetővé a vastagabb blokkokat: a pakoló 4 órán 13 al-sor helyett 4-et kér, mert a blokkok
89%-a korábban CSAK a padló miatt volt egyáltalán széles.
**A padló 0,6% -> 2% (a viewporthoz mérve, ~5px -> ~16px):** Peti olvasható blokkokat kért, egy
rövid hívás pedig pontosan annyi széles, amennyit a padló enged. Mért ár al-sorokban: 3 az
alapértelmezett 1 órás ablakon, 8 a 4 órás szélsőértéken; a compact-küszöb ezért 8-ról 6-ra ment,
hogy a gyakori 1 órás nézet teljes magasságú maradjon, a 4 órás pedig vékony sorokra váltson.
**AMIT NEM SIKERÜLT teljesíteni, és kimondom:** a "olvashatóbb felirat" a MAGASSÁGRA teljesült
(24px -> 32px blokk, 30px -> 38px sáv) és a minimum szélességre (5px -> 16px), de egy 5 másodperces
hívás egy 10 perces ablakban a szélesség ~1/120-a: rövid blokkon SEMMILYEN behúzással nem fér el a
felirat. Mérve: 19 blokkból 1 mutatja a teljes feliratát. Ott a szín + a jelmagyarázat viszi a
feladat-típust, a tooltip a részletet. Ez a nézet inherens korlátja, nem beállítás kérdése.
**MÁSODSZOR ugyanaz a csapda:** a `padding: 0 8px`, amit az olvashatóságért tettem be, MINIMUM
SZÉLESSÉGET jelent (16px), amiről a pakoló nem tud -- böngészőben mérve 21 képernyő-átfedést hozott
vissza egy olyan elrendezésbe, amit a pakoló tisztának hitt. Pontosan az a hibaosztály, amit a
`min-width: 10px` eltávolításakor már egyszer lezártunk. A felirat mostantól `text-indent`-tel van
behúzva, ami nem járul hozzá a doboz szélességéhez, és erre teszt is került.
**Ki döntött:** Peti (a két vezérlő és a vastagabb blokkok), fullstack (a mérések és az arányok).
**Hivatkozás:** kártya `b52c3c42`; `web/app-overview.js`, `web/style.css`,
`src/__tests__/llmdist-lane-packing.test.ts`.

---

## 2026-09-04 -- 790c962d -- Az elavult kártya-dispatch nem kézbesítődik, hanem lezárul

**Döntés.** A `message-router` a kézbesítési hurok LEGELEJÉN eldobja azt az üzenetet, ami kártya-dispatch
(`[Kanban feladat #<id>]` a SOR ELEJÉN) és a kártya azóta `done` vagy `waiting` lett. A sor
`closeMessagesWithoutDelivery()`-vel zárul: időbélyeg + indok marad, a tartalom megmarad.

**Mit mértem, mielőtt bármit építettem.** A kártya két javítást kínált (gyorsítás vagy kézbesítés-idejű
friss-ellenőrzés), és a mérés szerint **egyik sem volt a helyes lépés**:

- **A kézbesítés nem lassú.** 6 óra alatt: mikrob 118 üzenet **0,1 perc** átlagos várakozással, qa 0,4,
  backend3 0,2. Ez kizárja a "soros feldolgozás / egyetlen worker / rate-limit" magyarázatot. A
  várakozás a FOGADÓ foglaltságával korrelál -- egy dolgozó Claude-panelbe nem lehet promptot
  injektálni a kör megsértése nélkül, és a kód ezt tudja is (`shouldAbandon` csak HIÁNYZÓ sessionre ad
  fel üzenetet, foglaltra nem).
- **A friss-ellenőrzés már megvolt** (`formatDeliveryStalenessNote`, kártya 9566a197).

**A tényleges veszteség, és ez az új lelet.** A torlódás egyetlen ügynöknél állt (23 függő üzenet,
minden más sor üres). Abból 10 kártya-dispatch, és a táblával összevetve **tízből hét már elavult**
volt: öt `done`, kettő `waiting`, a legrégebbi hat órája sorban. Az ügynök elvégezte azt a munkát --
a TÁBLÁRÓL vette fel (11. szabály), nem a dispatchből. A dispatch tehát nem informált semmiről,
viszont érkezéskor elvisz egy kört, plusz még egyet, amíg a fogadó felismeri hogy elavult és visszaír.

**Miért nem a meglévő stamp-útra épült.** A `formatDeliveryStalenessNote` send-time stamp blokkot
igényel, a dispatch-ek viszont nem hordoznak ilyet: a `routes/kanban.ts` `createAgentMessage`-dzsel
hozza létre őket, megkerülve a POST /api/messages utat, ahol az `appendCardStateStamp` fut. **24 óra
alatt 62 dispatchből 1** hordozott stampet. A stampre kulcsolás tehát 61/62 arányban INERT lett volna
-- egy néma no-op, ami közben megépítettnek látszik. Ezért a fejlécből olvassa ki az azonosítót.

**Az elhelyezés maga a funkció.** A hurok legelején fut, MINDEN session-munka előtt. Alatta minden
ellenőrzés a fogadó paneljének szabaddá válására vár -- és épp az a probléma, hogy a fogadó órákig
foglalt. A készenléti kapu UTÁN elnyomva a torlódás csak olyan ütemben tisztulna, amilyen ütemben az
ügynök amúgy is üríti, vagyis abban az ütemben, ami a torlódást okozta.

**FAIL-OPEN, szándékosan, a repó többi kapujával ellentétesen.** Ha a kártya-lekérdezés dob vagy nem
talál, az üzenet KÉZBESÍTŐDIK. Az aszimmetria a lényeg: egy elavult dispatch kézbesítése egy elpazarolt
kört ér, egy élő dispatch téves eldobása viszont olyan munkát veszít el, aminek a hiányát senki nem
veszi észre. Ahol a két hibairány súlya különbözik, a guard a könnyebbet választja.

**A horgonyzás a funkció biztonsága.** A fejléc-minta a SOR ELEJÉHEZ van horgonyozva, hogy egy üzenet,
ami csak EMLÍT egy dispatchet ("a [Kanban feladat #...] amit küldtél már nem aktuális"), soha ne
essen áldozatul. A mutáció-próba itt talált egy hibát a saját tesztemben: az első fixture-öm a
hivatkozást a MÁSODIK sorra tette, amit az "első nem üres sor" szabály amúgy is kizár -- a `^` horgony
törlése zölden hagyta a tesztet. A valódi eset a fejléc az ELSŐ sor közepén; az a fixture most ott van.

**Csak a router-úton, tudatosan.** A testvér-kontroll (`formatDeliveryStalenessNote`) MINDKÉT úton ott
van, és a saját tesztje ki is mondja, miért. Ez router-only, két mért okból, és a döntés teszttel van
rögzítve, hogy ne feledékenységnek látsszon: (1) a `drain-inbox` KIZÁRÓLAG a fő ügynököt szolgálja,
akinek a sora nem évül el (6 óra, 118 üzenet, 0,1 perc átlag, 0,7 perc a legrosszabb) -- ott nincs mit
eldobni; (2) az út `claimPendingForAgent`-tel KEZD, ami a hurok előtt `delivered`-re állítja a sort, így
egy utólagos elnyomás pont az a "láthatatlan üzenetvesztés" lenne, amitől ugyanannak a fájlnak a saját
`from_agent` ága óv.

## 2026-09-04 18:40 -- Swimlane: a telepített-de-inaktív modell is kap sávot (a korábbi döntés megfordítása)

**Döntés:** a helyi-LLM swimlane mostantól minden telepített/konfigurált modellre rajzol sávot,
akkor is, ha az adott időablakban egyetlen hívása sem volt. Az inaktív sáv rövid, szaggatott sor
egy rövid magyarázó szöveggel, nem teljes magasságú üres sáv; a sorrendben minden inaktív sáv az
összes aktív alá kerül. Külön jelölést kap az a modell, aminek volt forgalma az ablakban, de az
Ollama már nem listázza (nincs telepítve) -- ezt viszont CSAK akkor mondja ki a felület, ha a
roster-lekérdezés ténylegesen sikerült; ha az Ollama nem elérhető, a hiányzó információ nem
fordul át állításra.
**Miért:** Peti kérése (2026-09-04, Telegram, képmelléklettel). Ez megfordítja a korábbi
"soha ne legyen üres sáv" döntést (18771-es kártya-komment): azzal a szabállyal egy éppen nem
használt modell teljesen eltűnt a diagramról, tehát az "inaktív" és a "nem is létezik" állapot
ugyanúgy nézett ki. A KPI-ban az "Aktív modellek" szám szándékosan NEM tartalmazza az inaktív
sávokat.
**Ki döntött:** Peti (kérés) + Fullstack (megvalósítási döntések: inaktív sáv alakja, sorrend,
roster-forrás, a nem-elérhető Ollama kezelése).
**Hivatkozás:** kártya 21950f77.

## 2026-09-04 18:40 -- BRIDGEHU813 átvéve, a hozzá tartozó böngésző-suite tudatosan nem

**Döntés:** Az upstream `1df099be` (#1170, BRIDGEHU813) párosítási hibaüzenet-fordítását átvettük
a forkba (kártya `73cf0a22`), a hozzá tartozó Playwright-suite-ot (`tests/browser/**`,
`playwright.browser.config.ts`, `browser-verify` script, és a csak ezeket kiszolgáló
`vitest.config.ts` kizárás) viszont NEM.

**Miért az átvétel:** a párosítási panel magyar volt mindenhol, kivéve azt az egy sort, amit a
felhasználó hiba esetén elolvas -- ott a szerver angol mondata jelent meg nyersen. Ez a
CLAUDE.md 12. szabályába ütközik (beszédes, i18n-kulcsból jövő hibaüzenet). Az upstream megoldása a
helyes irányú: a stabil `code` mezőre fordít, nem a mondatra, és ismeretlen kódnál visszaesik a
szerver saját mondatára, tehát egy később hozzáadott szerver-hiba angolul jelenik meg, nem üres
sorként vagy nyers kulcsként.

**Miért nem a böngésző-suite:** a flotta kapuja (`store/fleet-test.sh`) vitestet futtat, és
egyáltalán nem hív Playwrightot. Egy átvett böngésző-suite tehát olyan suite lenne, amit senki nem
futtat -- egy nem futó teszt lefedettségnek olvasódik, miközben semmit nem őriz.

**Ami emiatt NEM maradhatott el:** az upstream böngésző-tesztje pinneli a BEKÖTÉST, vagyis azt,
hogy a hibaág ténylegesen MEGHÍVJA a fordítót. Ezt a garanciát nem ejtettük, hanem áthelyeztük: az
átvett unit-teszt közvetlenül állítja, és mérve bukik, ha a hívási pontot visszaállítjuk. Enélkül a
fájl összes többi állítása zöld maradna, miközben a felhasználó újra angolul látná a hibát -- pont
az a hiba, amit ez a kártya javít.

**Újranyitandó, ha:** a flotta kapuja valaha kap egy Playwright-lépcsőt. Akkor a suite átvétele
önálló döntés, nem automatikus következmény.

---

## 2026-09-04 -- 711a7e57 -- A selftestek felfedezéssel futnak, nem kézzel írt wrapperenként

**Döntés.** Egyetlen teszt-fájl (`src/__tests__/store-selftests-all-run.test.ts`) felderíti a
`store/*.selftest.sh` glob-ot, és mindegyiket lefuttatja, `it.each`-csel külön jelentve. Nem nyolc
kézzel írt wrapper.

**Miért.** Mérve ezen a repón: 13 selftestből **nyolcra semmi nem hivatkozott**, tehát soha nem
futottak -- megírt, commitolt, zöldnek LÁTSZÓ ellenőrzések, amelyek egyszer sem hajtódtak végre. A
kártya nyolc wrappert kért; az megjavította volna ezt a nyolcat, és **árván hagyta volna a
kilencediket**, amint valaki hozzáadja. A kártya saját szövege nevezi meg a valódi okot: "nincs
auto-felfedezés, minden selftest külön vitest-fájlt igényel". Ezért a felfedezés az ok javítása, a
nyolc wrapper a tüneté.

**Az állapotuk, mielőtt bármit írtam:** mind a nyolc árva **átment** (89 ellenőrzés összesen). A
kártya számolt régi, valós bukásokkal; nem volt. Ez jó hír, de nem teszi feleslegessé a bekötést --
attól, hogy ma zöldek, holnap egy szerkesztés csendben elronthatja őket, és senki nem venné észre.

**Nem-vákuum, mert egy "PASS" önmagában nem bizonyíték.** A wrapper NEM azt nézi, hogy a script
exit 0-val tért vissza, hanem hogy **nem nulla** esetszámot jelentett, a három használatban lévő
riport-alak valamelyikében. Egy selftest, aminek minden esete kimaradt vagy a ciklusa be sem lépett,
tökéletesen boldog összefoglalót ír nulla munkáról. Mutációval igazolva: `All 0 checks pass.` -> FAIL,
felismerhetetlen alak -> FAIL, elrontott glob -> FAIL, létező célt vesztett kizárás -> FAIL.

**Egy kizárás, indokkal: `local-llm-model-routing`.** A selftest saját kommentje mondja ki, hogy
kicseréli a `store/local-llm-model-routing.json`-t, és "this IS the file the running fleet uses". A
`trap cleanup EXIT` normál kilépésre és szokásos jelekre visszaállítja -- **SIGKILL-re nem**, és ez a
suite landoláskor fut, a landolásokat pedig megölik (ugyanezen a napon egy saját teljes futásomat
ölte meg egy session-határ). Egy megölt futás 18 ügynök routing-configját hagyná egy nem létező
modellre mutató hamis fájlon. Kézzel futtatva átmegy (5/5) -- **a BEKÖTÉS nem biztonságos, nem a
script.**

A javítás egy sor a `local-llm.sh`-ban (`cfg="${LOCAL_LLM_MODEL_ROUTING_FILE:-$HERE/...}"`), ami után
a selftest ideiglenes fájlra mutathat és csatlakozhat. Az viszont egy ÉLŐ flotta-scriptet szerkeszt,
ami külön döntés a bekötéstől, ezért nincs ide belegyúrva.

**Költség, mérve:** 62,5 s ez a fájl, ~77 s mind a 13 sorosan. A vitest a FÁJLOKAT futtatja
párhuzamosan, tehát egy ~80-100 s-os suite-ban ez nagyrészt elrejtőzik. A már bekötött ötöt
szándékosan ÚJRA futtatja: a "ki köti be máshol" nyilvántartás pontosan az a könyvelés, ami elavul,
és a saját teszt-fájljuk amúgy is más invariánsokat állít (a skills-symlink például az `rm`-`mv`
sorrendet), tehát nem redundáns.

---

## 2026-09-04 -- e96b06e7 -- Helyi JSON-kivonatoló a dashboard API-hoz, nem külső tömörítő

**Döntés.** Egy stdlib-only Python szkript (`store/dash.py`) sűríti a gyakori dashboard-API
válaszokat: `card`, `comments`, `board`, `agents`, `queue`, plus egy `get` menekülőút. Nulla új
függőség, nulla új kimenő útvonal -- localhost, a már meglévő tokennel.

**Miért nem külső eszköz.** Ez a 241dbf87 (headroom) kiértékelés lelete volt: a `noisy-run.sh`
SOR-alapú szűrése JSON-válaszon semmit nem ér, mert az egész válasz egy sor. A headroom pont ezt a
rést töltené be -- de az értéke egy olyan pozícióból jött (minden LLM-hívás előtt), amit egy
kényelmi funkcióért nem adunk oda. Egy ~200 soros helyi szkript ugyanazt a rést zárja, a mi
API-alakunkra szabva.

**Mérve, nem feltételezve:** a `GET /api/kanban` 242 kártyát ad vissza, egyenként 18 mezővel,
minden teljes `description`-nel. Nyersen olvashatatlan; kézzel kivonatolva naponta többször
újra van találva.

**Az auth szándékosan bent van.** A megszokott alak
`printf 'Authorization: Bearer %s\n' "$(cat store/.dashboard-token)" | curl -H @- ...`, és a
hibamódja néma: a `-H @-` elfogyasztja a stdint, így minden olyan kérés, ami testet is csövez, ÜRESET
küld, a szerver pedig 200-at ad a semmire. Ezt az egész hibaosztályt megszünteti olvasásokra.

**A token soha nem íródik ki**, és ezt a selftest a HIBA-ágon állítja -- ott szokott egy érték
kicsúszni, mert a hibaszöveg sietve készül.

**Minden rövidítés jelölt.** `...(+N)`, számmal: egy csupasz `...` a olvasót találgatni hagyja, hogy
a levágott rész számított-e; a szám elég ahhoz, hogy eldöntse, elmenjen-e elolvasni.

**Egy valós hiba, amit az élő próba fogott meg:** a token a gitignorált `store/`-ban él, tehát csak a
FŐ checkoutban létezik -- minden ügynök viszont a saját worktree-jéből fut, ahol nincs. Az első éles
hívás pontosan így bukott el. A feloldás most: `DASH_TOKEN_FILE` > a szkript könyvtára > a `git
rev-parse --git-common-dir`-ből származtatott fő checkout. Hordozható, nem beégetett `/home` út.

**Hurokzárás:** a selftestjét a 711a7e57-en épített felfedezés-wrapper AUTOMATIKUSAN bekötötte,
nulla szerkesztéssel (14 -> 15 teszt). Ez a legjobb bizonyíték arra, hogy ott a felfedezés volt a
helyes választás nyolc kézzel írt wrapper helyett: a következő selftest magától bekötődött.

---

## 2026-09-04 -- 89f4c28d -- A routing-selftest hermetikus lett, és ezzel bekötődött

**Döntés.** A `local-llm.sh` mostantól honorálja a `LOCAL_LLM_MODEL_ROUTING_FILE` env-változót
(`cfg="${LOCAL_LLM_MODEL_ROUTING_FILE:-$HERE/local-llm-model-routing.json}"`), a selftest ideiglenes
fájlra mutat, és a `store-selftests-all-run` kizárás-listája **üres lett**.

**Miért kellett.** A selftest korábban kicserélte a `store/local-llm-model-routing.json`-t -- a saját
kommentje szerint "this IS the file the running fleet uses" -- és `trap cleanup EXIT`-tel állította
vissza. A trap **SIGKILL-re nem fut le**, ez a suite pedig landoláskor fut, a landolásokat pedig
megölik. Egy megölt futás 18 ügynök routing-configját hagyta volna egy nem létező modellre mutató
hamis fájlon. Ezért volt kizárva a 711a7e57-en, és ezért nem volt szabad csak úgy bekötni.

**Visszafelé kompatibilis.** A változó nélkül a viselkedés byte-azonos a korábbival: ez egy út arra,
hogy máshová mutassunk, nem új alapértelmezés.

**Bizonyítva, nem állítva:** a selftest futása előtt és után az élő `/home/neon/marveen/store/`-beli
config sha256-ja **azonos** (`bc1994fb…`), és a worktree-belié is. Még a mutációs futás sem nyúlt
hozzá. A kizárás megszűnése után a felfedezés-wrapper 15 -> 16 tesztre nőtt.

**Az override teherhordó, nem dekoráció:** visszaállítva a beégetett útra a selftest elbukik (4/1).

**ÉS AMIT A BEKÖTÉS AZONNAL FELSZÍNRE HOZOTT -- ez a kártya legérdekesebb része.** Az 5. eset
("missing routing config fails open") a `no model configured` szöveget is bukásnak vette. Ez két
független dolgot mos össze: a hiányzó ROUTING configot (amiről a case szól) és az üres MODEL
ÁLLAPOT-KÖNYVTÁRAT (egészen más). A `src/__tests__/setup/isolate-local-llm-state.ts` minden
vitest-futásnál friss temp könyvtárra állítja a `LOCAL_LLM_STATE_DIR`-t -- pontosan azért, hogy a
tesztek ne nyúljanak a flotta LLM-állapotához --, tehát a suite-on belül a "no model configured" a
HELYES válasz, és a case elbukott rajta. Kézzel futtatva sosem bukott, mert ott van konfigurált
modell.

Ez pontosan az a hibaosztály, amiért ez a kártya-család létezik: **egy nem futó ellenőrzés a saját
hibáját is elrejti.** Nem volt hibás, amíg nem futott.

A javítás nem lazítás: a case most a Traceback-et nézi (az a crash), ÉS azt, hogy hiányzó config
mellett ne szivárogjon ki a fake modell (az a routing). Mindkettő a routingról szól, és egyik sem
függ attól, hogy van-e letöltött modell.

## 2026-09-04 -- 99fccbcf -- A munkafa-frissesség kereséshez: eszköz, nem blokkoló hook

**Döntés:** a „grep az élő telepítésen hamis nullát adhat” hibaosztályra NEM épült blokkoló
PreToolUse hook. Helyette egy hívható, csak-olvasó eszköz készült (`store/live-tree-freshness.sh`),
ami kimondja a fa lemaradását, és a keresést a refen futtatja a munkafa helyett.

**Miért:** a hook eseteit a valódi parancs-korpuszból mértem, nem a fenyegetésmodellből. 20 óra
alatt 4121 Bash-hívásból **15** volt rekurzív keresés az élő checkouton, mind egyetlen ügynöktől,
és mind `store/` alatti fájl/log keresése -- egyetlen forrás-létezés kérdés sem. Natív Grep/Glob
hívás ugyanarra az útvonalra: **0**. Egy guard ott napi ~15 hamis pozitívot termelt volna, és a
valódi esetet (egy `grep -rl` egy 12 committal lemaradt fán) nem fogta volna meg.

**A kitettség viszont valós, és ezt is mértem.** A `marveen-land.sh` a 02f462e1 óta minden
landolás után előrehúzza az élő checkoutot, de a közvetlenül pusholó kézi landolás nem hívja meg.
A 142 ablakon mérve: medián 16,4 perc / 3 commit lemaradás, de **22 ablak egy óránál hosszabb** és
**26 ablakban 5+ commitot** nem látott a fa. 2026-09-04-en önmagában 17, 16, 15, 12 és 12 commitos
ablakok. A saját hamis nullám egy 12 commit / 60 perces ablakba esett.

**Egy mérés menet közben megfordított egy állításomat.** Azt írtam a script fejlécébe, hogy a
rossz ref némán, exit 1-gyel tér vissza, tehát megkülönböztethetetlen az őszinte „nincs
találat”-tól. Ez hamis: a rossz ref hangos (`fatal: unable to resolve revision`, exit 128).
A ténylegesen néma alak a rossz PATHSPEC (`git grep <minta> <jó-ref> -- nincs/ilyen.ts` -> üres
kimenet, exit 1), ami egy átnevezett vagy fejből gépelt útvonalnál a valószínűbb hiba. Az eszköz
ezért mindkettőt külön állapotra képezi le, és a pathspec-ágat a mérés után kapta meg.

**Ki döntött:** backend2 (mérés + döntés), a kártyát MikroB nyitotta backend2 operatív jelzésére.

**Ami NYITVA maradt, MikroB döntése:** (a) az élő checkout periodikus előrehúzása, hogy a kézi
landolás utáni ablak is bezáruljon -- ez az élő telepítést érinti időzítve, ezért nem egyoldalú
lépés; (b) a keresési fegyelem fleet-szintű kimondása a root CLAUDE.md-ben.

## 2026-09-04 -- a14812e8 -- Fork-oldali horgony: megnevezett teny, nem blob-pin

**Dontes:** az `ACKNOWLEDGED_CONFLICTS` mentesitesei mostantol OPCIONALISAN megnevezhetnek egy
fork-oldali tenyt (`ACKNOWLEDGED_FORK_ANCHORS`: szimbolum + fajl + present/absent + miert
teherhordo). Ha az a teny megvaltozik, a guard ujradontest ker. Fork-oldali BLOB-pin NEM keszult.

**Miert nem blob-pin (a kezenfekvo szimmetria):** lemerve 14 napra ezen a repon **404 fork-oldali
commit a 72 pinnelt fajlon, es 72-bol 67 mozdult**. Egy fork-oldali blob-pin naponta kb. 29-szer
avulna el, szinte mindig olyan szerkesztesen, ami a szabaly targyat nem is erinti. Az upstream-pin
azert engedheti meg maganak a teljes-fajl granularitast, mert az upstream ritkan mozdul; a mi
oldalunknak nincs meg ez a tulajdonsaga, es egy naponta 29-szer siro kapu pecsetelove valik.

**Miert opcionalis, es miert marad az:** a 73 szabalybol 9 tesz barmilyen fork-oldali allitast, es
azok tobbsege ATVETELI TORTENET ("not adopted this round"), nem elo, ellenorizheto allitas a farol.
Minden bejegyzest predikatumba kenyszeriteni azt jelentene, hogy prozat irunk at olyan formalizmusba,
ami nem illik ra.

**Ket meres forditotta meg a sajat tervemet epites kozben:**

(1) A `content.includes(needle)` horgony VAK az atnevezesre: a `touchAncestorChain` ->
`touchAncestorChainRENAMED` mutacio zolden ment at, mert az uj nev TARTALMAZZA a regit. Emiatt kapott
a matcher azonositó-hatar ellenorzest (`containsAsToken`). A mutacio a javitas utan helyesen bukik.

(2) Egy horgony nem lehet KOMMENTTEL kielegitheto. Az `installer-ollama-nonfatal` szabaly termeszetes
horgonya az `ollama_pull` lenne, ami meg mindig szerepel egyszer az `install-linux.sh`-ban -- egy
kommentben, ami azt magyarazza, hogy a hivast ELTAVOLITOTTAK. Egy `absent` horgony ott mar az elso
napon pirosan allna, egy `present` pedig orokre zolden a rossz okbol. Az a bejegyzes ezert NEM kap
horgonyt, es a kizarast kulon teszt pinneli, hogy egy kesobbi szerkeszto ne a nyilvanvalo horgonyt
tegye be szo nelkul.

**Az ellenorzes MINDIG fut, nem csak utkozeskor.** A blob-check csak az adott futasban ténylegesen
utkozo fajlokra ertekelodik; a token-usage.ts hiba viszont utkozes NELKUL tortent -- a szabaly
egyszeruen nem volt mar igaz. Feltetelesse tenni ujratermelne a lyukat, amit be kell zarnia.

**Ki dontott:** backend2 (meres + terv), a kartyat MikroB nyitotta backend2 leletere (607254fb komment 19951).

## 2026-09-05 -- e5b7ff19 -- Hatokor-allitas sweep: jelento eszkoz, nem kapu

**Dontes:** a "teszt-fejlec olyan hatokort allit, amit nem fed le" osztalyra JELENTO eszkoz keszult
(`store/test-scope-claim-check.py`), nem blokkolo kapu.

**Miert nem kapu -- merve:** 611 teszt-fajlon 61 fejlec-allitas oldodik fel tulajdonosra, ebbol 33
nem eri el a kiszolgalot, es kezi ellenorzes utan PONTOSAN EGY valodi eltereses akadt. A tobbi
forras-kontraktus-or (app.js-t, shell-scriptet, SKILL.md-t olvasnak szovegkent es toredekeket
allitanak), amelyek fejlece a route-ot a JAVITAS KONTEXTUSAKENT nevezi meg, nem sajat hatokorkent --
ez legitim es gyakori alak itt. Egy kapu tehat kb. 23 hamis pozitivot adna 1 talalat mellett.

**A megerositett lelet:** `otel-distributed-tracing.test.ts` fejlece szo szerint ezt mondja:
"Scope: DB layer ... API route (POST/GET /api/spans, GET /api/traces/:id, GET /api/traces)". A fajl
sajat maga hozza letre az `otel_spans` tablat es `db.prepare`-rel ujraimplementalja a lekerdezeseket;
a `tryHandleSpans`-t nulla teszt eri el. Ez a kartya sajat 1. peldaja, es MA IS fennall. A 63beeb8a
(waiting) ugyanennek a vegpontnak az IRASI invariansarol szol, nem a lefedettsegi resrol -- ezert a
lelet oda ment kommentkent, uj kartya nyitasa helyett (6b. szabaly).

**Az eszkoz sajat vaksaga is mert lelet volt.** Az elso valtozat a kiszolgalo modult BASENAME-
RESZSZTRINGGEL kereste a teszt kodjaban, es a 'spans' szo egy spans-rol szolo tesztben amugy is
mindenutt ott van (tabla-nevek, valtozok, SQL) -- tehat a `routes/spans.ts` "elertnek" latszott egy
olyan fajlbol, ami csak vitestet es better-sqlite3-at importal. Az eszkoz ELVESZTETTE a sajat alapito
eseteet. A reachability azota IMPORT vagy HANDLER-NEV szerinti token-illesztes. Ugyanaz a containment-
hibaosztaly, amit ugyanezen a napon a fork-horgonynal is javitani kellett (a14812e8).

**A selftest az elso futason talalt egy masodik hibat:** az argumentum-feldolgozo ketszer leptette az
indexet, tehat `--repo X --json` mellett a `--json` sosem jutott szohoz.

**Ki dontott:** backend2 (meres + dontes), a kartyat MikroB nyitotta backend2 63beeb8a-REVIEW leletere.

## 2026-09-05 -- f1b3f2f0 -- A landolas ujraepiti a dist-et; a restart valtozatlanul kulon kapu

**Dontes:** a `marveen-land.sh` a sikeres push es az elo checkout elorehuzasa UTAN lefuttatja a
buildet az ELO TELEPITESBEN, ha a landolt tartomany `src/`-t erint. MikroB dontese volt a (b) irany
(a feltetel megszuntetese, nem a jelzese); ez annak a vegrehajtasa.

**Amit a kartya premisszajabol JAVITANI kellett:** a kartya szerint "senki nem aggregalja" a
stale-build tunetet. Ez nem igaz: a `scripts/build-freshness-guard.sh` egy ELO systemd --user
timeren fut 5 percenkent, 300 masodperces build-turelmi ablakkal -- iras kozben ellenoriztem, epp
futott, es ezt mondta: "dist/ 2m behind src/ -- within the 300s grace period, no-op". A rés tehat
sosem volt lathatatlan, csak sosem lett BEZARVA. A kartya lenyege ettol all: a riasztas nem javitas,
es egy naponta tizszer ujratermelodo feltetelre nem valasz, hogy valaki naponta tizszer lefuttatja
az update.sh-t.

**A 77075367 dontese NEM lett visszavonva.** Az kimondta, hogy a landolas nem epit ujra ES nem indit
ujra; ebbol a RESTART fele valtozatlan (tovabbra is ./update.sh, tovabbra is megerositve). Csak az
ujraepites fele valtozott, es pont az a fele, amire a helyi-modell offload utja ra van kotve: a
`local-llm-rag.sh` hivasonkent FRISS node-ot indit a dist-bol, tehat neki a build eleg, a restart nem
kell. Ellenorizve iras elott: a `src/web` alatt semmi nem indit futasidoben node gyereket a dist-bol,
tehat egy ujraepitett dist nem hasit ketfele verzio koze egy futo szolgaltatast.

**Merve, mert ez minden landolas ara:** a teljes build 16,5 masodperc, a landolas amugy is 140-170
masodperc. Sorositva fut (`flock`), mert a parhuzamos landolas valos -- egy este ketszer is
push-versenyt vesztettem.

**Fail-soft es hangos:** a commitok a build futasakor MAR pusholva vannak, tehat egy build-hiba nem
buktathatja a landolast (az egy megtortent landolast jelentene meg nem tortentkent). Egy bukott build
pontosan azt az allapotot hagyja hatra, ami eddig is volt, es amire a freshness-guard riaszt.

**Ket sajat hibat a tesztek talaltak meg, nem en:** (1) a lock-fajlt a `store/` ala tettem, ami a
land-fixture-ben nem letezik -- a `flock` ilyenkor 66-tal all le, es ez REBUILD FAILED-kent jelent meg
egy olyan buildre, ami el sem indult; a lock azota a `.git` alatt van, aminek a letezeset a script
amugy is megkoveteli. (2) A "skipped" esetem ROSSZ OKBOL ment at: ket kulon ag irja ugyanazt a szot,
es a teszt csak a szora allitott -- a specifikus okra allit azota.

**Ki dontett:** MikroB (irany), backend2 (meres + vegrehajtas).

## 2026-09-05 00:55 -- A kártyazárás-ellenőrző elvárt-sha alapértelmezetté tétele (kártya 2003e04b)

**Döntés:** a `store/gate-closure-check.py` `--expect` kapcsolója alapértelmezetté vált: kapcsoló
nélkül a kártya legfrissebb `REVIEW` kommentjének `Gate-SHA:` sorát használja elvárt shaként. Az
eltérést viszont NEM sha-egyenlőséggel ítéli meg, hanem tartalommal: feloldja mindkét commitot a két
klón egyikébe, és összeveti a szállított fájlok tartalmát. Új `UNRESOLVED` állapot arra, amikor az
eltérés nem ítélhető meg. A régi viselkedés a `--no-expect`-tel áll vissza.

**Miért nem a kártyában scope-olt egyszerű alak:** a kártya és a hozzá tartozó plan-grilling (Cybered)
két utat kínált -- (a) az elvárt sha a REVIEW-ból, sha-egyenlőséggel, (b) tartalom-alapú összevetés --
és úgy ítélte, hogy (a) önmagában elég, mert a REVIEW shája „definíció szerint egyezik a
verdiktekkel". Ez a teljes táblán MÉRVE nem igaz. Az 557 `AGREE` kártyából 38-nál tér el a REVIEW
shája attól, amit a gate-ek megnéztek, és ebből 23 bizonyíthatóan ártalmatlan: 10-nél a két commit
bájtra ugyanazt tartalmazza a kártya által szállított fájlokra, 13-nál pedig csak a `package.json`
(minden landolás verziót bumpol), a `DECISIONS.md` vagy a `README.md` mozdult -- tipikusan a
munka-commit kontra az őt landoló merge. Tisztán sha-egyenlőséggel tehát a zárások 6,8%-ára szólt
volna riasztás, háromötöde hamisan, ami néhány nap alatt megtanítja a flottának, hogy hagyja
figyelmen kívül. A (b) úton ugyanez 15 kártya (2,7%): 14 valódi tartalmi eltérés a kártya saját
fájljaiban, plusz 1 feloldhatatlan.

**Amit a mérés még megmutatott:** a `STALE` szövege szándékosan nem nevez meg bűnöst. A c458ba0e
mintában a gate-ek shája az elavult, az edd4c3bf-en viszont fordítva: a szállítmány egy „nem új
REVIEW" jelzésű INFO-ONLY kommentben lépett tovább, a gate-ek helyesen az ÚJABB shát nézték, és a
REVIEW a lemaradt artifaktum. Az eszköz a két commitot és az eltérő fájlokat mondja meg; melyik az
elavult, az az olvasó döntése.

**Kapcsolódó, ugyanebben a munkában:** a `store/*.selftest.py` fájlokat semmi nem futtatta. A
selftest-felfedezés (kártya 711a7e57) csak a `.selftest.sh` alakra illeszkedett, így a repó mindkét
python-selftestje -- köztük épp ezé az eszközé -- megírva, commitolva, zöldnek látszóan, soha egyszer
sem futott le. A felfedezés mostantól interpreter szerint kulcsol, és nyelvenként külön negatív
kontroll van rá, hogy egy elgépelt kiterjesztés ne tudja csendben lefedetlenül hagyni az egyik nyelvet.

---

## 2026-09-04 -- 5af57bd7 -- Szemafor (max 2) a teljes CleanCore suite-futásokra

**Döntés (MikroB).** Flottaszinten legfeljebb **2 egyidejű** teljes CleanCore suite-futás, `flock`
alapon; a többi **vár**, nem kap elutasítást. A vitest worker-RPC timeout emelése nem alternatíva.

**Miért nem a timeout.** Kimértem: a worker→fő RPC a birpc `DEFAULT_TIMEOUT = 60 s` értékét
használja, a vitest 3.2.6 nem ad rá felülírást (a `forks` pool `getRpcOptions()`-je csak
szerializációt ad, a `worker.js`-ben a `timeout` szó nullaszor szerepel). Csak a `node_modules`
patchelésével lenne emelhető. És nem is ez a baj: a **fő** folyamat CPU-éheztetése váltja ki, ezért
nem segített a `--maxWorkers=4` sem — a saját workerjeim korlátozása nem eteti a saját fő
folyamatomat, amit MÁS ügynökök 12-workeres futásai éheztetnek.

**Szemafor, nem mutex.** A marveen `fleet-test.sh` egyetlen `flock`-ot vesz, mert ott a futások EGY
fát osztanak — ott a zár HELYESSÉGI kérdés. Itt mindenkinek saját worktree-je van, a futások
függetlenül helyesek; ami fogy, az a CPU. Tizennyolc ügynök egy 60 perces mutexre sorbaállítva egy
ritka hamis pirosat cserélne állandó torlódásra.

**`flock` fájlleírón, nem fájl-tartalommal.** A kernel a holder halálakor elengedi, tehát egy
SIGKILL — ma kétszer így ért véget futás — nem szivárogtat slotot. Tartalom-alapú zárhoz stale-söprő
kellene, ami újabb elrontható dolog.

**A várakozó nem néma, és ez nem kozmetika.** A 3. szabály szerint egy 10 perce nem mozduló
`in_progress` kártya beragadt, a 3a. szerint 60 perc után testvérre száll. Egy néma 80 perces
várakozás tehát elvenné a várakozó ügynöktől a kártyát — rosszabb, mint a hamis piros, amit a
szemafor elkerülni hivatott. Ezért `PAUSED-SEMAPHORE` komment a várakozás kezdetén, periodikus
frissítés (300 s, a 10 perces küszöb alatt), `RESUMED-SEMAPHORE` a slot megszerzésekor. Mindegyik
mozdítja az `updated_at`-et, ami az a mező, amit a figyelő valóban olvas.

**A rutin eset NÉMA.** Ha van szabad slot — a gyakori eset —, semmi nem íródik. Egy értesítés, ami
egészséges forgalomra is elsül, az, amit két hét múlva átugranak (222fdc5e leckéje, ugyanezen a
táblán).

**Mért csapda, amit NEM választottam:** kézenfekvő lett volna a `store/load-paused-agents.json`
marker-fájlba írni, hiszen azt olvassa a `redispatch-guard.sh` `_is_load_paused()`-ja és a
stuck-card-monitor. **Nem járható:** a `load-guard-bookkeeping.sh:234` a fájlt a saját számított
halmazából **teljesen felülírja**, tehát egy idegen bejegyzést a következő tickje törölne — a
kizárás csendben megszűnne, miközben megépítettnek látszik. Ezért megy a jelzés a kártyára, nem a
marker-fájlba.

**Saját hiba, amit a saját selftestje talált meg.** Az `acquire()` először így szólt:
`exec {FD}>"$f" 2>/dev/null || continue`. Parancs NÉLKÜLI `exec`-nél a átirányítás a SHELLRE
vonatkozik és **megmarad**, tehát az a `2>/dev/null` a szkript minden későbbi `echo >&2`-jét
elnyelte — a sorbanállás-jelzést, a feladás okát, a worktree-hibát. A selftest üres kimenetű exit 3-at
látott, és ez vezetett a felismerésig. A javítás: a fájlt egy RENDES paranccsal hozzuk létre (annak
az átirányítása arra a parancsra korlátozódik), az `exec` pedig csupaszon fut.

## 2026-09-05 -- 999fd78a -- A B-hullám `git revert -m1`-gyel nem visszafordítható, és a jelenlegi landolási modellben nem is lehet az

**Döntés:** a 607254fb plan-grilling verdiktjének (4) pontját (`git revert -m1` tesztelve, nem
feltételezve) végrehajtottam, és a válasz NEMLEGES. A B-hullámot a mai `origin/develop`-ról nem lehet
`git revert -m1`-gyel visszafordítani. Nem javasoltam és nem is hajtottam végre kényszerített
revertet: az a CLAUDE.md kódminőségi 5. szabályába ütközne (működő, landolt funkció visszavonása
Peti kifejezett engedélye nélkül).

**Mérés (eldobható worktree, `/home/neon/marveen-revert-999fd78a`, `origin/develop` @ a392fe31).**
A hullám 20 committal, három landolási merge-en át, 18 óra alatt ért a develop-ra:

| landolási merge | B-hullám / idegen commit | `revert -m1` ütközés | érintett fájl |
|---|---|---|---|
| `78f9be50` | 12 / 1 | 4 | 33 |
| `13bf2707` | 5 / 4 | 4 | 14 |
| `cae546af` | 1 / 1 | 1 | 3 |

Egyik sem alkalmazódik tisztán: összesen 9 ütközés, mindegyik kézi feloldást igényel. És ami
súlyosabb: a revert nem a hullámot fordítaná vissza, hanem mindent, amit az adott landolás hozott.
A `13bf2707` `-m1` revertje TÖRÖLNÉ a message-backlog-watcher funkciót (1e7ba5c1) és a
card-state-stamp tesztet (382dcb15); a `78f9be50`-é a local-llm corpus-driven-test-cases anyagot
(a3b4e0f4); a `cae546af`-é a ponytail watched-repos frissítést.

**A fájl-szintű, sebészi visszaállítás sem járható maradéktalanul.** A hullám 38 fájlt érint. Ebből
29 visszaállítható a hullám előtti (`7d548869`) állapotra anélkül, hogy későbbi munkát elvinne; 9-en
viszont idegen commitok ülnek. A legélesebb eset a `scripts/hooks/outgoing-copy-gate.py` és a
selftestje: rájuk a hullám UTÁN három biztonsági javítás landolt (`d0073382`, `9b43901f`, `c7dd0484`,
Cybered F1/F2/F3). Egy naiv hullám-rollback ezeket a javításokat CSENDBEN visszavonná, azaz landolt
biztonsági hibákat élesztene újra. További érintett: `package.json` (35 későbbi commit), `src/db.ts`
(5), `src/web.ts` (4), `src/web/message-router.ts` (3).

**Miért nem lehetett ez másképp -- ez nem mulasztás, hanem a landolási modell következménye.**
A `store/marveen-land.sh` a teljes `agent/<ügynök>/work` ágat mergeli a develop-ba, és a per-kártya
őre (`downward_check`) csak akkor SZIGORÚ, ha a hívó megnevezte a kártyát (`--card`); e nélkül
riport-üzemmódban fut. A szkript saját forrásjegyzete mondja ki az okot: „without one there is no
single card to ask about, since a marveen branch legitimately carries several". Vagyis egy
hullámonként revertelhető merge KONSTRUKCIÓ SZERINT nem jön létre, hacsak a hullám nem kap saját
ágat, amire az ügynök közben semmi mást nem commitol, és nem `--card`-dal landol.

**Amit ténylegesen leteszteltem és zöld.** A `cae546af` az egyetlen, aminek a revertjét be tudtam
fejezni (egy ütközés: a `package.json` verziója, mert utána `a392fe31` újra bumpolt; feloldás:
alap-verzió vissza `1.34.1`-re, a landolás-számláló marad, a lock-fájl alapja egyezik). Az eredmény
`517c6957`. Ezen a `store/fleet-test.sh --ref 517c6957` **614 fájl / 14801 zöld / 101 skipped**,
lint-ratchet tartja magát; a develop tipen (`a392fe31`) futtatott kontroll BETŰRE ugyanez, tehát a
revert egyetlen tesztet sem vesztett el és egyet sem tört el. A revertelt fát a
`/home/neon/marveen-test` HEAD-je és a benne lévő `1.34.1+mikrob.4` verzió igazolja, tehát a zöld
futás valóban a revertet mérte, nem a develop tipet.

**Következmény.** (1) A 607254fb (4) pontja a hullámra utólag NEM teljesíthető; a hullám élesben
marad, a rollback-út nem egy parancs, hanem egy 29 fájlos, felülvizsgált fájl-visszaállítás plusz a
9 szennyezett fájl kézi kezelése. (2) Jövőbeli kockázatos hullámnál a követelmény csak akkor
értelmes, ha a hullám SAJÁT ágon, `--card`-dal, idegen commit nélkül landol -- különben a
plan-grilling olyat kér, amit a landoló szkript definíció szerint nem tud előállítani.
**Ki döntött:** backend2 (mérés és verdikt), MikroB (dispatch, 999fd78a).
**Hivatkozás:** kártya 999fd78a; mért revert-commit `517c6957`; landolási merge-ek `78f9be50`,
`13bf2707`, `cae546af`; hullám előtti alapvonal `7d548869`.

---

## 2026-09-05 -- c6153a69 -- The flake was already diagnosed; what was missing is that the CleanCore side never SAID so

**Decision.** A shared classifier (`store/vitest-flake-classify.sh`), wired into
`store/cleancore-suite-run.sh` -- the one entry point rule 18 mandates for a full CleanCore suite.
It explains a nonzero exit when, and only when, the log carries vitest's worker-RPC timeout AND no
failed test. It never alters the exit code.

**What the investigation actually found.** The mechanism was already established and does not need
re-deriving; it needed VERIFYING, which was done here against the installed CleanCore vitest 3.2.6
rather than taken from the marveen-side note:

    dist/chunks/index.B521nVV-.js:3    const DEFAULT_TIMEOUT = 6e4        <- 60s
    dist/chunks/index.B521nVV-.js:21   timeout = DEFAULT_TIMEOUT          <- birpc's own default
    dist/chunks/utils.CAioKnHs.js:25   createForksRpcOptions() -> serialize/deserialize/post/on, NO timeout

So the card's third suggested lever, "increase the RPC timeout", **does not exist on this version** --
and neither does the local-LLM draft's version of the same advice. The worker reports progress to the
MAIN process over that RPC; a CPU-starved main process misses the 60s round trip and the WORKER
throws, after every test has already passed.

**The real gap was diagnosis cost, not the flake.** `fleet-test.sh` has classified this for the
marveen suite since card 54699bbb. The CleanCore side had nothing, so each agent re-derived it from a
bare "1 error" line -- three times in one day on this board, each ending in a hand-written REVIEW
paragraph saying the same thing.

**What was NOT done, and why.** No worker-count change is recommended, because the data does not
support one. The only low-worker run available (`--maxWorkers=2`, marveen) came from a DIFFERENT
suite of a different size and duration than the 12-worker CleanCore runs, so worker count is
confounded with everything else; claiming a causal lever from that comparison would be exactly the
kind of confident-but-unsupported inference this card's own history is full of. A controlled
experiment is one suite, two worker counts, and costs ~1.5 hours of machine time -- worth doing
deliberately, not smuggled into a LOW card.

**Known duplication, stated rather than hidden.** `fleet-test.sh` keeps its own inline copy of this
classification. Two spellings of one rule drift, but that file is gated, working and unrelated to
this card, so it was left alone; the new script's header names it for migration on the next touch.

---

## 2026-09-05 -- be81d16c -- The author restriction is stated, not inherited from how one caller happens to work

**Decision.** `_post_comment`'s author is validated against the dashboard's own agent registry, and
an identity that is excluded from every throttle mechanism is refused outright. Anything else falls
back to the `load-guard` sentinel with a loud stderr line.

**Why.** Cybersec's follow-on to 9444a7bb: opening the hardcoded author to a parameter left the NAME
unconstrained. It happened not to matter, because the only caller derives it from a kanban lookup
filtered on `assignee == agent` -- but that is an accident of one caller, not a rule. A future caller
posting without that lookup inherits nothing, and the function would sign a note with any string,
including another agent's name, straight into a card's audit trail.

**Two rules, and why each is shaped that way.** The registry is the dashboard's `/api/agents` rather
than a list in this file: a second copy of "who exists" is a copy that drifts. And the
excluded-identity check SOURCES `load-guard-excluded.sh` instead of re-listing MikroB and the gate
pool, for the reason that file gives about itself -- two spellings of one policy is how one of them
quietly stops matching. A note signed by an excluded identity asserts something that cannot be true:
they can never be a throttle target.

**Why the fallback still posts.** Refusing the comment would cost the `updated_at` movement the
stuck-monitor depends on, so an agent that is merely frozen would start looking abandoned. The
sentinel keeps that function while never impersonating anyone; the stderr line makes the caller bug
visible rather than absorbed.

**MY OWN TESTS WERE VACUOUS FIRST, and the mutation step is the only reason that did not ship.**
The two new cases asserted "the author is not qa" / "not ghost-agent" and passed under BOTH
mutations -- because the fake dashboard had no card for those agents, so `_card_id` was empty,
`_post_comment` returned early, and nothing was posted at all. The assertions were true because of
an unrelated precondition. Fixed by giving those agents cards in the harness and requiring that a
comment WAS posted before checking its author. Same failure class this fleet has documented before
(an early guard makes every "it refused" probe vacuous) -- knowing it did not prevent writing it.

---

## 2026-09-05 -- 87be1810 -- LLM monitor: külön oldal, ügynök-sávok, a hiányzó adat kimondva (Fron Ted)

**Előzmény:** Peti design-képe (store/design-refs/local-llm-swimlane-mockup-2026-09-03.jpg) a
forrás-igazság: KPI-sor, Swimlane Timeline (Tasks) kattintható részlet-panellel, Workload
time-series. A backend (a5bbfb98) a `/api/task-events` + `/api/task-summary` feedet szállította,
és kimondta: csak a helyi LLM-feladatoknak van kezdete ÉS vége (`blockCoverage.lanes = ['local']`),
az online modellek munkája megszámolható, de feladatonkénti időtartam nincs tárolva. Az Áttekintésen
már él egy per-MODELL swimlane (d6ecb003) a helyi ledgerből.

**Döntés:** (1) HOL: külön oldal a Statisztikák csoportban ("LLM monitor", #llmMonitor), mert a
kép egy monitorozó KÉPERNYŐ, nem egy kártya; az Áttekintés kompakt per-modell nézete marad.
(2) SÁVOK: ügynökönként (a feed lane-je egyetlen "local", az ügynök a valós tengely), a blokkok
kategória-színnel, valós indulás + időtartam szerint, ugyanazzal a first-fit csomagolóval és
CSS-geometriával, mint az Áttekintés swimlane-je (egy rendszer, nem kettő). (3) RÉSZLET-PANEL
kattintásra/Enterre: időtartam, ügynök, kategória, állapot, indulás, kártya-link -- a token/átvitel
sor helyett egy kimondott jegyzet, mert ezt a feed NEM hordozza (12. szabály: nem mutatunk nullát
mért érték helyett). (4) TERHELÉS-IDŐSOR: a feedből kliens-oldalon vödrözve (24 vödör, top-4
kategória + egyéb, Catmull-Rom görbe). A kép "Model A / Model B" percenkénti kérés-görbéje az online
modellekre NEM építhető a mai kontraktusból (csak összesítés van modellenként); needs-build,
javasolt BE-mező: `task-summary?buckets=N -> series[]`. (5) A `blockCoverage` jegyzet a felületen
látszik (lokalizált sor, a szerver angol szövege hoverre), a 2000-es limit túlcsordulása külön
figyelmeztetés.

**Ki döntött:** Peti (design-kép), backend2 (kontraktus + lefedettség), Fron Ted (oldal, sávok,
kimondott hiányok), MikroB (dispatch).
**Hivatkozás:** kártya `87be1810` (Pair-BE `a5bbfb98`, fázis `aecd9a12`); `web/app-llm-monitor.js`,
`src/__tests__/llm-monitor-module.test.ts`.

## 2026-09-05 -- CLAUDE.md 14. szabály (kötelező `/clear` két munka között) törölve

Peti Telegramon (2026-09-05 07:18) jelezte: már régebben kérte a 14. szabály törlését, és
kifejezetten frusztrálta, hogy törlés helyett egy strukturális kikényszerítő mechanizmus
(`src/web/kanban-dispatch-clear-guard.ts` + `src/web/self-advance-clear-watcher.ts`, a "dispatch
kapcsoló") épült a szabály KÖRÉ, ahelyett hogy magát a szabályt szüntettük volna meg.

**Mit csináltam.** A 14. szabály teljes bekezdését kitöröltem a CLAUDE.md-ből, a rá következő
szabályokat (15-18) 14-17-re számoztam át, és javítottam az egyetlen belső kereszthivatkozást
(a mai 15. szabály "mint a 15. szabálynál" mondata "mint a 14. szabálynál"-ra módosult, mert a
noisy-command-guard rész csúszott eggyel feljebb). Ellenőriztem, hogy a `store/` és `src/` alatt
egyetlen szkript sem hivatkozik a szabályokra sorszám szerint, tehát a renumbering nem tört el
automatizált logikát.

**Mi maradt nyitva.** A kódoldal (a két fájl + a `web.ts`-beli bedrótozás + `agent_pending_clear`
tábla) még él, most már holt logikaként. Nyitottam rá egy takarítókártyát (`7debd869`, backend2,
marveen projekt, normal), ami eltávolítja mindkét fájlt, a bedrótozást, a hozzájuk tartozó
teszteket, és eldönti az `agent_pending_clear` tábla sorsát (törlés vagy szándékosan árván
hagyás -- ha bizonytalan, kérdezzen).

**Miért nem törtem ki azonnal a kódot is.** A marveen saját infrastruktúrája, tehát a szokásos
worktree + fleet-test + landolás + QA-gate útvonalon kell mennie (Marveen repo saját-worktree
fegyelme szakasz), nem MikroB kézi Bash-hívásaival egy éles szolgáltatásban.

**Ki döntött:** Peti (törlés-kérés, Telegram). **Végrehajtotta:** MikroB (doksi), backend2
(kódtakarítás, kártya 7debd869).
**Hivatkozás:** kártya 7debd869; CLAUDE.md korábbi 14. szabály (2026-08-23-tól élt).

## 2026-09-05 -- 54fd9c02 -- Az ötödik ajtót a KORPUSZ őrzi, nem a shell, és a nyers könyvtárnév a teherbíró alak

**Döntés:** Az install-linux.sh/install-macos.sh `seed-fleet-agents/*/` -> `agents/` másolását NEM a
shellben validáljuk, hanem egy forrás-szkennelő teszttel a szállított seed-korpuszon
(`reserved-agent-name.test.ts`, "door 5"). Az ellenőrzés a NYERS könyvtárnévre fut (mellette,
olcsó második félként, a szanitizált alakra is).

**Miért:** (1) A shellből nem hívható az `isReservedSenderId`, tehát egy shell-oldali ellenőrzés a
fenntartott halmaz MÁSODIK példányát hozná létre, ami pont a b46a4b7e által megszüntetett
drift-osztály. (2) Egy korpusz-ellenőrzés MINDKÉT installert fedi, plusz bármelyik jövőbelit, anélkül
hogy bármelyiket megnevezné. (3) Az ellenőrzés ideje telepítés-időből (idegen gépen, megfigyeletlenül)
commit-időre kerül. (4) A nyers alak a teherbíró: a `listAllAgentNames()` (agent-config.ts)
szanitizálás nélkül adja vissza a `readdirSync` bejegyzéseket, tehát a könyvtárnév MAGA lesz az
ügynök neve, és pont ezt adja tovább a `context-guard-runner.ts` `from`-ként.

**Elutasított alternatívák:** (a) név-ellenőrzés a shellben -- lásd (1); (b) a fenntartott halmaz
normalizálása, hogy az aláhúzásos alakok is bele essenek -- a `SAFE_NAME_RE` SZÁNDÉKOSAN átengedi az
aláhúzást (`system_directive` érvényes ügynöknév), ezt elvenni valódi neveket törne el egy nem létező
támadás kedvéért.

**Következmény:** Ha valaha egy seed-könyvtár fenntartott nevet kapna, a commit bukik, és a
hibaüzenet megmondja a teendőt (átnevezés), kifejezetten megtiltva a fenntartott halmaz lazítását.

**Ki döntött:** backend2, Cybersec javaslata alapján (b46a4b7e gate-melléklete, komment 22244).
**Hivatkozás:** kártya 54fd9c02.

## 2026-09-05 -- Az `agents/` névtér futásidejű zárása: fail-closed ejtés + latch-elt tripwire (kártya 53c59307)

**Döntés.** Cybered tervét (20323-as komment) változtatás nélkül megvalósítottam: az (a) és (b) irány
közül MINDKETTŐ, mert két külön kérdésre felelnek. Az ejtés a KONTROLL (`listAllAgentNames()` nem ad
vissza fenntartott nevű könyvtárat), a riasztás a LÁTHATÓSÁG, és mindkettő UGYANABBÓL az egy
predikátumból (`isReservedSenderId`) jön. Külön-külön mindkettő rossz: az ejtés egyedül némán
semlegesít, tehát a támadó megtudja, hogy nem működik, mi viszont soha nem tudjuk meg, hogy
megpróbálta; a riasztás egyedül egy ténylegesen megtörtént mintelésről szól.

**Miért volt nyitva.** Az `54fd9c02` a TELEPÍTÉSI utat zárta le. Bármelyik élő flotta-ügynök viszont
`mkdir agents/system-directive`-et tud csinálni sima Bash-sel, installer nélkül -- a könyvtár ezzel
bekerült volna a context-guard sweepbe, aminek két írója (`context-guard-runner.ts`,
`context-restart-gate-runner.ts`) a sweepelt nevet adja `from`-ként a `createAgentMessage`-nek. Ekkor
léteznének VALÓDI `from_agent="system-directive"` sorok, amiket a `sendSystemDirective` sosem írt --
pont az az egy-író tulajdonság, amiért az átnevezés készült.

**Egy fojtópont, mérve.** A teljes `src/`-ben EGYETLEN `readdirSync` fut az `AGENTS_BASE_DIR`-en, a
`listAllAgentNames()`-ben (Cybered mérése, magam is ellenőriztem). Ezért nem részleges javítás: egy
helyen zárul az egész osztály. Több független readdir esetén ez a terv nem lett volna elég.

**Az aszimmetria a terv lényege, és ezt nem szabad egyszerűsíteni.**
- `isReservedSenderId(n)` igaz -> EJTÉS + riasztás. Egyetlen legitim ajtó sem tud ilyen könyvtárat
  létrehozni (az API 400-zal utasítja el, a bundle-import dob, a seed-korpusz őre az `54fd9c02`-ben),
  tehát az ejtés nem rejthet el valódi ügynököt az életfenntartás elől. EZ a tulajdonság teszi az
  ejtést megengedhetővé, nem a szigor önmagában.
- `sanitizeAgentName(n) !== n`, de nem fenntartott -> CSAK riasztás, NINCS ejtés. Egy ilyen könyvtár
  lehet régi, kézzel létrehozott, ténylegesen dolgozó ügynök, és a sweepből kiejteni egy 100%-os
  kontextuson álló session elvesztését jelentené. A név nem fenntartott azonosító, tehát nem mintel
  semmit: itt a láthatóság a helyes válasz, nem a semlegesítés.

**A latch nem csiszolás, hanem teherhordó elem.** A `listAllAgentNames()` forró úton fut (az
invite-monitor másodpercenként, a sweep ciklikusan). Latch nélkül EGYETLEN `mkdir` percenként ~20
üzenetet írna a fő ügynök postaládájába, örökre -- egy-paranccsal elérhető, önmagunk ellen fordított
DoS az orchestrátor bemenetén, pont attól a szereplőtől, aki ellen a kontroll szól. A latch a
`store/` alatt perzisztál (újraindítás ne fegyverezze újra), és csak akkor fegyverez újra, ha a
könyvtár eltűnt és megint megjelent. Sikertelen küldés NEM latch-el, különben pont az az egy
riasztás veszne el, ami számít.

**Nincs automatikus törlés, szándékosan.** Az ejtés már semlegesített, tehát a törlés nem véd többet,
csak bizonyítékot semmisít meg. Súlyosabb ok: egy visszafordíthatatlan törlés, aminek az útvonalát a
TÁMADÓ választja, maga is támadási primitív, amint a névillesztés valaha lazul -- egy elrontott regex
a távolság a veszélytelen szűk illesztés és a tetszőleges könyvtár-törlés között. Helyette:
karantén-másolat a `store/agent-dir-quarantine/` alá, az eredeti érintetlenül a helyén.

**Attribúció: kimondva gyenge.** A flotta minden ügynöke ugyanazon az OS-felhasználón fut, tehát a
könyvtár tulajdonosa semmit nem árul el arról, ki hozta létre. A riasztás a létrehozás időbélyegét
adja, és a szövegében KI IS MONDJA, hogy ez korrelációs jelzés, nem bizonyíték. Az igazi védelem nem
a jobb nyomozás, hanem hogy a cselekmény haszontalan legyen.

**Tisztaság.** A `listAllAgentNames()` és az új `listRejectedAgentDirNames()` tiszta függvény marad:
nincs db, nincs üzenetküldés. Egy riasztó mellékhatás azt jelentené, hogy minden tesztfutás
riasztásokat termel, vagyis a saját csatornánkat tanítanánk meg arra, hogy a riasztás zaj. A
riasztást a context-guard sweep küldi, aminek már van db-hozzáférése. Ezt teszt pinneli
import-gráf-tényként (a `db.ts` nem érhető el az `agent-config.ts`-ből), nem kommentként.

**Amit MÉRTEM, nem feltételeztem.** A hét gate-pont mindegyikére teszt, plusz három mutáns, mind
alkalmazva és visszaállítva: az ejtés kivétele -> 2 piros; a latch kivétele -> 1 piros; az aszimmetria
összeolvasztása (a rosszul formált név is ejtve) -> 1 piros. Alapvonal és visszaállítás után 7/7 zöld.
Regresszió: 47/47 a névtér-körben (reserved-agent-name, system-directive-auth-section), 85/85 a
context-guard körben. `tsc --noEmit` exit 0.

**Egy megfigyelés, ami NEM változtatta meg a tervet.** Egy olyan név, ami csak SANITIZÁLVA lesz
fenntartott (pl. `System--Directive`), nem esik ki -- és ez helyes: a `from_agent`-hez vezető úton
semmi nem sanitizál, tehát egy ilyen könyvtár nem a fenntartott azonosítót írja, nem mintel semmit.
Ejteni a fenti aszimmetriát sértené haszon nélkül. A kis-nagybetű viszont számít, és fedve van: az
`isReservedSenderId` case-insensitive, tehát az `agents/System-Directive` is kiesik.

**Amit ez a kártya NEM old meg.** Az `agents/` alá ÍRÁS megakadályozása (jogosultság, hook,
immutábilis mount) külön kártya és nagyobb kockázat: az ügynökök legitim módon írnak a saját
könyvtárukba. Ez a kártya a névteret zárja, nem az írást.

**Ki döntött:** Cybered (terv és irányválasztás), backend (megvalósítás és mérés), MikroB (dispatch).
**Hivatkozás:** kártya 53c59307; előzmény 54fd9c02 (telepítési út) és 5c5d7bc4 (a saját sender id).

## 2026-09-05 -- A `fleet-test.sh` FLEET_TEST_TREE-kijárata lezárva: a zár gép-szintű, nem fánként (kártya 2f0c7d24)

**Döntés.** Peti explicit jóváhagyásával (Telegram, 2026-09-05, „1 - zárd le, kódot módosítasz") a
`store/fleet-test.sh` zárja mostantól EGY gép-szintű horgonyra (`${ROOT}-test.lock`) kerül, nem a
`$TEST_TREE`-re. A `FLEET_TEST_TREE` env-változó megmarad, és továbbra is megválasztja, HOL fut a
suite -- de többé nem választja meg, hogy SORBAN ÁLL-E. A korábbi viselkedés (fánként külön zár) az
`85faec1b` kártya tudatos, mért döntése volt; ez a bejegyzés azt fordítja vissza, nem egy hibát javít.

**Miért fordul meg egy tudatos döntés.** Az eredeti indok helyes volt a maga körében: egy privát fa
nem tudja elrontani a közöset, tehát nem kell mögé sorolni. Csakhogy a fa nem az egyetlen megosztott
erőforrás. Egy teljes suite magonként egy workert indít (itt 12), így két futás két KÜLÖN fán is
elveszi egymás CPU-ját, és a kiéheztetett futás nem hibán, hanem időtúllépésen bukik. A kontenció
által termelt hamis piros a drága fajta: egy gate-en helyes munkát küld vissza `in_progress`-be.

**Mérés a döntés előtt (a `fleet-rule-compliance-from-corpus` eljárással, 504 egyedi ügynök-átiraton).**
- A `FLEET_TEST_TREE` NEM használatlan, ahogy a kártya (és az én korábbi 9bb2e651-es megfogalmazásom)
  sugallta: **237 tényleges beállítás** 11 napon át, QA (`marveen-qa-test`, `qa-<kártya>-gate`),
  backend2 (`marveen-test-b2`, `be2-mutate`) és Cybersec fáira. Amit helyesen lehet állítani: az
  UTOLSÓ használat **2026-08-26**, azóta tíz napja egyszer sem. A lezárás tehát ma nem tör el élő
  munkafolyamatot -- de a „ma senki nem használja" indoklás pontatlan volt, a helyes az, hogy a
  korábbi használói már átálltak másra.
- Figyelmeztetés a mérésről magáról: az első futásom minden ügynök könyvtárán át ugyanazt a korpuszt
  15-ször számolta (a projekt-könyvtárak szimlinkeltek), és az első „csak 1 megkerülés" eredményem is
  hibás volt, mert a detektorom a `2>&1` átirányítást pozicionális szűrőnek olvasta. Mindkettő
  javítva, a számok a javított futásból valók.

**Ami emiatt a tesztben változott, és miért nem törlés.** A `fleet-test-serialises-runs.test.ts`
egyik állítása KIKÖTÖTTE a kijáratot (`LOCK_FILE="${TEST_TREE}.lock"` megléte volt a zöld feltétel),
tehát a lezárás e nélkül nem is landolhatott volna. Az állítás nem eltűnt, hanem MEGFORDULT (a
tree-re kulcsolt zár mostantól hiba, és külön állítás követeli a gép-szintű horgonyt), plusz egy új
CONTROL eset a régi alakra: ha valaki visszaállítja a fánkénti zárat, a teszt pirosra vált. Enélkül
a 7. kódminőségi alapelv szerint gyengülő tesztről beszélnénk, nem javításról.

**Mérés a változtatás UTÁN (viselkedés, nem szövegellenőrzés).** `FLEET_TEST_TREE` egy privát útra
állítva, miközben egy MÁSIK ügynök valódi futása tartotta a zárat: `FLEET_TEST_LOCK_WAIT=2` mellett
kiírta, hogy vár, majd 3-as kóddal kilépett, és a `/home/neon/marveen-test.lock`-ot -- a KÖZÖS
horgonyt -- nevezte meg. A régi kóddal a privát fa saját, szabad zárját vette volna, és azonnal
indult volna. A hibaüzenetben szereplő útvonal maga a bizonyíték.

**Amit ez a változtatás NEM old meg (a leletet a kártyán kívül is ki kell mondani).** A marveen
sorosításból ma nem a `FLEET_TEST_TREE`-vel lépnek ki, hanem úgy, hogy a `fleet-test.sh`-t egyáltalán
nem hívják: 2026-09-01 óta **89 teljes marveen suite-futás** ment közvetlen `npx vitest run`-nal a
szkript megkerülésével, ebből **59 QA gate-fákban** (`qa-priv-*`). Ez a jelenlegi tényleges kijárat,
és ezt a kártya nem érinti. Külön kártya kell rá; addig a „senki nem tud csendben kilépni a
sorosításból" állítás NEM igaz, csak a `FLEET_TEST_TREE`-n keresztül nem tud.

**Ki döntött:** Peti (jóváhagyás), MikroB (dispatch, kártyanyitás), backend (mérés, implementáció).
**Hivatkozás:** kártya 2f0c7d24; előzmény 9bb2e651 és 85faec1b; a mérő eljárás a
`fleet-rule-compliance-from-corpus` skillben.

## 2026-09-05 -- A 17. szabály (CleanCore suite-szemafor) premisszájának korrekciója, és a két független zár kérdése (kártya 9bb2e651)

**Döntés.** A 17. szabály egy hét múlva esedékes felülvizsgálatához a kiinduló premisszát korrigálni
kell: **a megkerülés-minta NEM rosszabbodik**, és a korpusz ezt nem támasztja alá. Ebből
következően PreToolUse hook a CleanCore-oldalra NEM indokolt. A marveen-oldalra sem kell új fék, mert
ott már szigorúbb korlát van, mint a CleanCore-on. Marad a két zár egymástól független ténye, amit
dokumentálni kell, nem összehangolni -- egyelőre.

**Mérés (backend, a teljes ügynök-átirat korpuszon: 12 195 jelölt Bash-parancs).**
- Ebből 2 244 PUSZTA EMLÍTÉS volt, nem futtatás (`pgrep -f vitest`, `cat vitest.config.ts`, magyar
  próza egy heredoc-testben). Szűrés nélkül a szám tízszeres, és minden ráépülő következtetés hamis.
- A `store/cleancore-suite-run.sh` `ce3ec4d6`-ban jött létre (2026-09-04 22:41 helyi), és `78d182a6`
  tette flotta-szintűvé (23:52). Az idővonalat a SZKRIPT LÉTEZÉSÉHEZ kell vágni, nem a szabály
  kihirdetéséhez: az 5 megtalált teljes-suite megkerülés MIND korábbi, tehát akkor a szabály nem
  hogy nem volt betartva, betarthatatlan volt.
- A szkript létezése óta: **0 CleanCore teljes-suite megkerülés**, 2 szemaforos futás, 57 mentesülő
  célzott futás (a mentesülő szám nem nulla, tehát a nulla nem azt jelenti, hogy senki nem dolgozott
  a repóban).
- A szabályban „második megkerülés-adatpontként" szereplő gate-futás (002120b1, QA) valójában
  **marveen** teljes suite egy eldobható `qa-priv-<kártya>-<sha>` worktree-ben. A szkript létezése óta
  futott ÖSSZES teljes suite-ot repo-szűrő nélkül átnéztem: 13 darab, mind QA gate-futás, és mind a
  12 mögöttes kártya marveen INFRA. Egy sem CleanCore.

**A hamis piros tényleges előfordulásai.** A `Timeout calling "onTaskUpdate"` jelzőre 8 találat van a
parancs-kimenetek között; ebből **7 valódi**, és mind a CleanCore vitestjére mutat
(`CleanCore/node_modules/.pnpm/vitest@3.2.6`), időben 06:18 és 20:41 között, tehát MIND a szemafor
létrejötte előtt. A nyolcadik nem előfordulás: a 17. szabály SAJÁT SZÖVEGE jelenik meg egy marveen
teszt-diffben, és a szabály idézi a hibajelzőt -- egy jelző-alapú keresés tehát megtalálja magát a
szabályt. A szemafor landolása óta nulla előfordulás.

**Amit korrigálok a saját korábbi állításomban.** Először azt jelentettem, hogy a valódi fékezetlen
terhelés a marveen gate-futásokra került (QA 10 teljes suite 3 óra alatt, „nincs rá szemafor"). Ez
téves: a `fleet-test.sh` EGYETLEN flockot vesz a fa útvonalára, tehát **max 1** egyidejű futást enged
-- szigorúbb korlát, mint a CleanCore kettő. QA 10 futása sorosan ment, nem párhuzamosan.

**A tényleges maradék kockázat, számokkal.** Egy vitest-suite alapból annyi workert indít, ahány CPU
van (itt 12, a `cleancore-suite-run.sh` fejléce is ezt mondja ki, és élőben is mérhető: 15 vitest
folyamat 17,2-es terhelés mellett). A két zár nem tud egymásról, ezért a legrosszabb eset
2 CleanCore + 1 marveen = **3 egyidejű teljes suite, ~36 worker 12 CPU-n**. Ez ugyanaz az éheztetési
feltétel, ami a 7 hamis pirosat okozta -- azzal a különbséggel, hogy a 3-utas átfedésre eddig
EGYETLEN megfigyelt bukás sincs. Ezért a közös, gép-szintű számláló megépítése ma spekulatív lenne,
és pont az a hiba, ami ellen a 17. szabály maga is szól (a hook eseteinek a valódi korpuszból kell
jönniük, nem a fenyegetés-modellből).

**Következmény / következő lépés.** (1) A két-kapu-egymástól-független tény dokumentálva. (2) Mielőtt
bárki koordinációt épít, a 3-utas átfedést MÉRHETŐVÉ kell tenni (a nehéz futások kezdete/vége közös
jelöléssel), és csak megfigyelt átfedés + bukás után épüljön mechanizmus. (3) A `FLEET_TEST_TREE`
env-változó csendes kilépést ad a marveen sorosításból („a private tree never queues behind the
shared one") -- ma senki nem használja, de ez ugyanaz az alak, mint az `5af57bd7` per-checkout
horgony-hibája, amit a `78d182a6` javított. A `fleet-test.sh` viszont minden marveen landolást
kapuz, tehát működő, bizonyítottan éles funkció: hozzányúlni csak Peti kifejezett jóváhagyásával
szabad (5. kódminőségi alapelv), ezért ez kérdésként megy fel, nem javításként.

**Kiegészítés: egy MÁSODIK, ettől független terhelés-érzékenységi osztály a marveen landolási
kapuban (menet közben mérve, nem a kártya kiinduló kérdése).** A fenti bejegyzés landolása maga
akadt el rajta, ezért ide tartozik. A `src/__tests__/gate-sha-repo.test.ts` egyik esete
(`names a KANBAN CARD ID instead of laundering it as "unlanded"`) ÉLŐ HTTP-hívást tesz a
dashboardra a teljes suite közben, a `store/gate-sha-repo.sh` pedig `curl -sf --max-time 3`-mal
kérdezi le a kártyát. Telített gépen (612 tesztfájl, 446 mp teszt-idő 113 mp valós idő alatt) ez a
3 másodperces költségkeret elfogy, a szkript a szándékos fail-soft ágára esik (`unlanded`, 3-as
kilépés), a teszt viszont a sikeres ágat várja (4-es kilépés) -- **hamis piros, ami minden marveen
landolást kapuz**. Nem elméleti: három független előfordulás a szkript landolása óta (09-05 00:38,
00:41, és a saját 08:44-es landolásom), mind ugyanazzal az `expected 3 to be 4` állítással; a
szkript ugyanezekre a bemenetekre terheletlenül helyesen felel. Ez tehát MÁS mechanizmus, mint a
birpc-timeout (nem a vitest RPC-je, hanem egy korlátos külső hívás a teszten belül), de UGYANAZ az
osztály: a kontenció zöldből pirosat csinál. Két következménye van. (1) A „marveen-oldalon nincs
megfigyelt terhelés-okozta bukás" állítás így PONTOSÍTVA értendő: a teljes suite-ok sorosítására
tényleg nincs szükség új fékre, de a landolási kapun belül van terhelés-érzékeny pont, csak nem a
sorosítás hiánya okozza. (2) A javítás iránya nem fék, hanem determinizmus: a szkriptben MÁR OTT VAN
a `GATE_SHA_REPO_NO_BOARD=1` offline ág, tehát a teszt élő board helyett stubbal is futhatna. Ez a
`gate-sha-repo.sh` az `edd4c3bf` kártya éles, működő eredménye, ezért nem nyúlok hozzá: külön
kártyaként megy fel MikroB-hoz.

**Ki döntött:** backend (mérés és verdikt), MikroB (dispatch, a kártya átírása a mérésre).
**Hivatkozás:** kártya 9bb2e651; korábbi diagnózis-korrekció backend3-tól; szemafor `ce3ec4d6` +
`78d182a6`; a mérő eljárás a `fleet-rule-compliance-from-corpus` skillben.

## 2026-09-05 -- 74851e8b -- A fast-uri javítás a 3.x-en BELÜL van, nem major ugrás, és a valódi hiba az override KÜSZÖBE volt

**Döntés:** A `fast-uri` HIGH és a `qs` MODERATE tanácsot a 3.x/6.x soron BELÜL zárjuk:
`fast-uri` override `>=3.1.4 <4` -> `>=3.1.7 <4`, és új `qs` override `>=6.16.0 <7`. NEM emeltük a
`fast-uri`-t 4.x-re, ahogy a kártya javasolta.

**Miért:** Az `ajv@8.20.0` `"fast-uri": "^3.0.1"`-et deklarál. A sebezhető tartomány `3.0.0 - 3.1.5`,
és létezik `3.1.6`/`3.1.7` -- vagyis a javítás elérhető az ajv által deklarált tartományon belül,
semver-sértés és major ugrás nélkül egy olyan függőség alatt, amit nem mi kontrollálunk. A 4.x-re
erőltetés ugyanazt a biztonsági eredményt adta volna, plusz egy nem deklarált major kockázatát.
Ugyanez a `qs`-nél: a `body-parser@^6.15.2` és az `express@^6.14.0` egyaránt elfogadja a 6.16.0-t.

**A TANULSÁG, ami túlmutat ezen a két csomagon:** a package.json MÁR tartalmazott egy
`"fast-uri": ">=3.1.4 <4"` override-ot, és a fa mégis a sebezhető 3.1.5-öt telepítette. Egy override,
aminek a KÜSZÖBE a tanács tartományán BELÜL van, kielégíthető sebezhető verzióval -- miközben a
package.json-t átfutó olvasónak lezárt ügynek látszik. A két szám (küszöb kontra tanács-plafon)
viszonyát semmi nem ellenőrizte. Ezt zárja be a `fast-uri-qs-advisories.test.ts`, nem csak a mai két
nevet.

**Mellékesen talált csapda:** a package.json KÉT override-térképet hordoz (npm `overrides` és
`pnpm.overrides`), tükrözve. Az egyik frissítése a másik nélkül néma: az dönti el a javítás
érvényesülését, hogy ki melyik telepítőt futtatja. Az őr ezt is állítja.

**A CSOMAG NEM SZÉTVÁGHATÓ, mérve:** a package.json override a lockfile nélkül eltöri az `npm ci`-t
(`Invalid: lock file's fast-uri@3.1.5 does not satisfy fast-uri@3.1.7`, exit 1) -- tehát a két fájlnak
EGYÜTT kell landolnia. A lockfile-t viszont a `git-protect-guard.py` szerint ügynök nem commitolhatja
(MikroB batcheli a függőségeket), ezért a landolás MikroB lépése, nem a backend2-é.

**Hatókörön kívül hagyva (nem elhallgatva):** dev-only tanácsok maradtak (vitest CRITICAL, vite HIGH,
esbuild/vite-node/@vitest/mocker MODERATE). A kártya `--omit=dev`-re szólt; ezek a teszt-eszközlánc
major frissítését igényelnék, ami külön munka és külön kockázat.

**Ki döntött:** backend2 (technikai döntések), a landolás MikroB jóváhagyásával.
**Hivatkozás:** kártya 74851e8b.

## 2026-09-05 -- 0711c19b -- A landolás azt a shát mondja, ami a kártya fájljait viszi

**Döntés:** A `marveen-land.sh` záró riportja mostantól KÉT shát nevez meg, elkülönítve: a `develop`
csúcsát, és egy külön, sor eleji `Gate-SHA: <sha>` sorban azt a merge-commitot, ami a kártya fájljait
ténylegesen beviszi. A `merge_sha` változó jelentése változatlan (a tesztelt és pusholt csúcs); egy új,
soha újra nem értékelt `gate_sha` őrzi meg a merge-et a verzió-bump ELŐTT.

**Miért:** A riport eddig csak a csúcsot írta ki, és amióta a fork-saját verzió-bump automatizált
(`ea8b9b95`), az a csúcs minden landolásnál egy `chore(version)` gyerek-commit, ami a `package.json`
egyetlen sorát tartalmazza -- a kártya fájljaiból semmit. Aki készpénznek vette, olyan shát írt a
REVIEW-ba, amit a kártya nem szállított. Nem elszórt hiba: a táblán **82 különböző verzió-bump sha
szerepel `Gate-SHA:` soron, 51 kártyán**, és a szerzők között ott van a `qa`, a `cybersec` ÉS a
`cybered` is -- vagyis nem egy ügynök figyelmetlensége, hanem amit az eszköz mindenkinek mondott.

**A downstream őr sem fogta meg, és ez a lelet érdemi része.** A `gate-closure-check.py` egy
sha-eltérést úgy old fel, hogy összeveti a két commit tartalmát "minden fájlra, amit a deklarált
commit szállít", levonva a `package.json`/`DECISIONS.md`/`README.md` hármast ismert landolásonkénti
zajként. Egy bump-commit `package.json`-t szállít és MÁST NEM, tehát a kivonás kiüríti az
összevetendő halmazt, és az eszköz `AGREE`-t ír ki úgy, hogy NULLA fájlt hasonlított össze. Ez
pontosan az a vacuous pass, amit a saját `if not files: continue` ága hivatott megelőzni -- csak nem
az üres-lista ajtaján jön be, hanem a churn-szűrőn. Élőben igazolva a `99fccbcf`, `e5b7ff19`,
`a14812e8` és `f1b3f2f0` kártyán. Ez KÜLÖN kártyát kapott: a forrás javítása nem gyógyítja meg az
51 már megírt kártyát, és kézzel továbbra is be lehet írni egy bump-shát.

**Elvetett alternatíva:** ne a merge-et, hanem a csúcsot nevezzük Gate-SHA-nak, és a gate mindig
`checkout`-oljon. A csúcs FÁJA valóban tartalmazza a kártya munkáját, tehát checkout-alapú
ellenőrzésre jó -- de a flotta és a saját záró-ellenőrzője is `log -1 --name-only` alapon olvassa,
hogy "mit szállított ez a commit", és arra a csúcs hazudik. Egy shát nevezünk meg, azt, ami mindkét
olvasatban helyes.

**Mellékes lelet, szándékosan NEM javítva itt:** a bump stage-elése
`git add package.json package-lock.json`, és a git az EGÉSZ add-ot eldobja, ha az egyik pathspec
semmire nem illeszkedik -- egy csak-`package.json` repóban tehát a bump némán "produced no changes to
commit"-ot ír. A marveen-ben lappangó (mindkét fájl követett), a teszt-harness-ben viszont élesben
jelentkezett, ott a lockfile beseedelése oldja meg. Külön döntés tárgya, nem ezé a kártyáé.

**Ki döntött:** backend2 (mérés + megvalósítás), MikroB (kártyanyitás a 3. bejelentés után).
**Hivatkozás:** kártya 0711c19b; `store/marveen-land.sh`,
`src/__tests__/agent-worktree-marveen.test.ts` (4 új eset, 3 mutációval igazolva).

## 2026-09-05 -- 74aa46a5 -- A churn-kivonás nem üresítheti ki az összevetést egy passzba

**Döntés:** A `gate-closure-check.py` `content_verdict()` függvénye mostantól `unresolved`-et ad, ha a
deklarált commit MINDEN szállított fájlja a churn-listán van (`package.json`/`DECISIONS.md`/
`README.md`) ÉS ezek közül legalább egy ténylegesen eltér. Verzió-bumpnál a hibaüzenet meg is nevezi
az okot, és a 0711c19b-re mutat.

**Miért:** A függvény már védekezett az ÜRES szállítás ellen (`if not files: continue`, azzal az
indokkal, hogy a "same" ott vacuous pass lenne). A rá következő sor viszont kivonja a churn-hármast,
és ez MÉGEGYSZER ki tudja üríteni az összevetést, egy ponton, ahová az őr már nem ér el. Egy
`chore(version)` bump `package.json`-t szállít és MÁST NEM, tehát a kivonás konstrukció szerint
totális: a függvény "azonos tartalom" választ ad, miután NULLA fájlt hasonlított össze. Egy őr, ami
így válaszol, nem szigorúbb a semminél, csak drágább.

**Mérve, nem feltételezve.** A teljes élő táblán (2821 kártya) a változás **14 kártya** verdiktjét
mozdítja el, mindegyiket `AGREE` -> `UNRESOLVED`, és **mind a 14 már `done`** -- vagyis EGYETLEN
nyitott lezárást sem blokkol. A 14-ből négy a lelet alapító esete (99fccbcf, e5b7ff19, a14812e8,
f1b3f2f0, mind bump-sha), a többi a másik ajtó: csak `README.md`-t (d696e3bb) vagy csak
`DECISIONS.md`-t (5b90d903) szállító deklarált commit.

**Két KONTROLL tartja meg, ami eddig helyes volt** (mindkettő selftest-eset, mutációval igazolva):
egy csak-churn szállítás, aminek a churn-fájlja TÉNYLEG bájtazonos, továbbra is `AGREE` (ott semmi
nem tér el, az valódi válasz, nem üres); és egy valós fájlokat is szállító commit, aminél csak a
churn mozdult, ugyanúgy megtartja a passzát -- azt a commitot ÖSSZEHASONLÍTOTTUK.

**Hatókör-korlát, kimondva:** ez csak az ELTÉRŐ-sha ágat éri el. Ha a REVIEW és mindkét gate UGYANAZT
a bump-shát nevezi meg (a táblán ez a gyakoribb: 82 bump-sha 51 kártyán), a `shas_agree` rövidre zár
`AGREE`-re, és ide el sem jut. Az a kérdés -- "a megnevezett sha egyáltalán a kártya munkája-e" --
nem ezé az őré: azt a FORRÁSNÁL zárta le a 0711c19b.

**Kockázat-értékelés:** szigorítás egy záró-ellenőrzésen, aminek a hibamódja eddig HAMIS PASS volt.
Nulla nyitott kártyát érint, egy committal visszafordítható, és a hatása mérve van, nem becsülve --
ezért nem kapott önálló plan-grilling kört.

**Ki döntött:** backend2 (lelet a 0711c19b méréséből, design + megvalósítás).
**Hivatkozás:** kártya 74aa46a5; `store/gate-closure-check.py`,
`store/gate-closure-check.selftest.py` (44 -> 49 eset, 4 mutációval igazolva).

## 2026-09-05 -- 07433dab -- Az ötödik ajtó őre a MŰVELETET pinneli, és a nevek ALAKJÁT is méri

**Döntés:** A `reserved-agent-name.test.ts` "door 5" blokkja három ponton szigorodik: (1) az őr nem a
`SEED_FLEET_DIR=` HOZZÁRENDELÉST pinneli, hanem azt, hogy a másoló ciklus TÉNYLEGESEN ezt a változót
járja be; (2) installerenként PONTOSAN EGY hely másolhat az `agents/` alá (szám, nem jelenlét); (3)
minden seed-könyvtárnév változatlanul túl kell élje a `sanitizeAgentName`-et, nem elég, hogy nincs
benne a fenntartott halmazban. A komment-sorokat mindhárom illesztés előtt eldobjuk.

**Miért:** a tegnap landolt őr (54fd9c02) csak a változó-átírási mutációt buktatta el. Cybersec két
alakot nevezett meg, amik átsétálnak rajta, és MINDKETTŐT lemértem a valódi installereken, mielőtt
javítottam: a `SEED_FLEET_DIR=` sor változatlanul marad, miközben (a) a ciklus forrása másra
mutat, vagy (b) az eredeti mellé bekerül egy MÁSODIK másoló ciklus egy másik korpuszból. A régi
állítás mindkét mutált fájlon ZÖLD marad -- kimérve, nem levezetve. Cybered harmadik alakja pedig
ortogonális: az őr a nevet a fenntartott HALMAZHOZ méri, az ALAKJÁHOZ sehol, így egy
`ZZ_Cybered Probe` nevű könyvtár után 23/23 zöld maradt -- és ez az EGYETLEN ajtó, ami nyers
repo-stringet tesz az `agents/` alá (minden más út a `sanitizeAgentName`-en keresztül épít), majd
beépül a context-guard-runner üzenet-törzsébe is.

Ez ugyanaz a megkülönböztetés, amit a CLAUDE.md 12. szabálya a szimbólum-jelenlétre kimond, egy
réteggel feljebb: attól, hogy egy azonosító SZEREPEL, még nem azt HASZNÁLJÁK. A komment-szűrés is
ugyanezért van -- egy a ciklust szó szerint idéző komment különben minden itteni állítást zölden
tartana, miközben a valódi ciklus eltűnt.

**Mérve:** a ma szállított 14 seed-könyvtár MIND átmegy az alak-ellenőrzésen, tehát a szigorítás nulla
hamis riasztást termel. A komment-eldobás után 2294-ből 1711 sor marad az install-linux.sh-ban és
1636-ból 1287 a macos-ban; a találatszám mindkét mintára ma 1, komment-szűréssel és nélküle egyaránt.

**Elvetett alternatíva:** shell-oldali név-ellenőrzés az installerbe. Ugyanaz az érv, mint 54fd9c02-nél:
a shell nem tudja hívni a `sanitizeAgentName`-et, tehát egy shell-ellenőrzés a szabály MÁSODIK
példánya lenne -- pont az a drift-osztály, amit a b46a4b7e megszüntetett.

**Ki döntött:** Cybersec + Cybered (leletek a 54fd9c02 gate-köréből), backend2 (mérés + megvalósítás).
**Hivatkozás:** kártya 07433dab; `src/__tests__/reserved-agent-name.test.ts` (23 -> 26 eset, 3
mutációval igazolva + egy kontroll arról, hogy a RÉGI őr mindkét bypass-alakot átengedte).

## 2026-09-05 -- 43d933b1 -- A projekt-dispatch sorrendnek sosem volt "rule 14" nevű forrása

**Döntés:** A `src/web/routes/project-priority.ts` (4 hely) és a `store/fleet-nudger.sh` (3 hely)
"CLAUDE.md rule 14" hivatkozásai kikerülnek. A helyükre az kerül, ami IGAZ: üres beállításnál nincs
projekt-szintű preferencia, és a szokásos kártya-prioritás dönt (6. szabály, urgent > high > normal
> low, a 6b. két-napos elsőbbségével). A viselkedés NEM változott, csak az a mondat, ami forrást
állított neki.

**Miért:** a hivatkozás kétszeresen hamis. Egyrészt a 14. szabály SOHA nem mondott semmit a
dispatch-sorrendről -- a 2026-09-05-i átszámozás előtt a két munka közti kötelező `/clear` volt, ma a
zajos-parancs hook. Másrészt, és ez a súlyosabb: átnéztem a CLAUDE.md-t ÉS az ütemezett feladatok
promptjait, és SEHOL nincs olyan szabály, ami "CleanCore-kártyák előbb, mint marveen-infra"
sorrendet mondana ki. A `folyamatos-munka-orchestrator` tényleges szabálya sima prioritás-sorrend.
Vagyis a komment nem elavult volt, hanem egy sosem létezett szabályra hivatkozott -- és ezt a
2d6587fe kártya SAJÁT leírása is átvette ("alap mod (jelenlegi 14. szabaly)"), tehát a kód
hűségesen másolta a kártyát.

**Az egyik érintett hely NEM komment volt:** a `fleet-nudger.sh` 213. sora a flottának KIKÜLDÖTT
nudge-szövegben állította, hogy a beállítás "felulirja a rule 14 alap sorrendjet". Vagyis minden
ügynök egy nem létező szabályról kapott tájékoztatást minden nudge-nál.

**Az új komment SZÁNDÉKOSAN kimondja a "rule 14" nevet** -- azért, hogy a következő olvasó ne
"állítsa vissza" a hivatkozást. Emiatt egy csupasz "nincs benne a 'rule 14' string" ellenőrzés
elbukna a saját magyarázatán; a javító szkript ezért a hamis ÁLLÍTÁS alakjaira ellenőriz
(`rule 14 hardcodes`, `rule 14's default`, ...), nem a tokenre. Ugyanaz a csapda, mint amikor egy
doksi-őr a saját prózája miatt buktat egy kártyát.

**Mellékes mérés, MikroB-nak jelezve:** a repóban jelenleg **141** hivatkozás nevez meg CLAUDE.md
szabályt SZÁM szerint (`rule N` / `N. szabály`), 15+ fájlban. A szabályok átszámozhatók -- tegnap
épp ez történt --, tehát ez egy mérhető drift-felület. Nem ennek a kártyának a hatóköre; MikroB
dönti el, kell-e rá külön kártya.

**Ki döntött:** backend2 (a lelet a 7debd869 munka közben, mérés + javítás).
**Hivatkozás:** kártya 43d933b1; `src/web/routes/project-priority.ts`, `store/fleet-nudger.sh`.

## 2026-09-05 -- 1140a745 -- Az upstream alapértelmezett ágát MEGKÉRDEZZÜK, és a tracking-ref UGYANABBÓL jön

**Döntés:** Az `update-checker.ts` nem hardcode-olja többé a `main`-t az upstream repóhoz. Egy új,
fail-soft `upstreamDefaultBranch()` megkérdezi a GitHub-ot (`GET /repos/<owner>/<repo>` ->
`default_branch`), és bármilyen hiba esetén a `main`-re esik vissza. Az upstream bejegyzést egy külön
`upstreamRepoConfig(branch)` építi, ami a `branch`-et ÉS a `trackingRef`-et UGYANABBÓL az egy
feloldott értékből származtatja. Nem vettük át az upstream `branchOnRemote()`/`fetchDefaultBranch()`
gépezetét: annak remote-preferencia-heurisztikája olyan problémát old meg (melyik az egy helyes
repó), ami ennek a forknak nincs -- a `repoConfigs()` két repót ellenőriz explicit módon.

**Miért a szélesebb hatókör (ez a kártyában nem volt benne):** a `trackingRef: 'upstream/main'`
javítatlanul hagyása egyik csendes vakságot cserélte volna le egy másikra. A `mergeBaseWith()` hiányzó
refnél ÜRES stringet ad, a `computeStatus` pedig ezt `behind = 0`-ként olvassa, HIBAÜZENET NÉLKÜL --
vagyis egy átnevezett upstream-alapértelmezés után a dashboard "naprakész"-t mondana egy olyan refre
hivatkozva, ami már semmit nem követ. Pont az a hibaosztály, ami ellen maga az ellenőrzés van. MikroB
jóváhagyta a tágítást (msg 23202).

**Az üres string külön eset, és külön ellenőrzés őrzi:** egy `default_branch: ''` válasz a
`.../commits/` URL-t építené -- az egy MÁSIK végpont, és olyan okból hibázna, ami semmiben nem
hasonlít az igazi okára. A resolver ezért a nem-string ÉS az üres választ is a fallbackre viszi.

**Tesztelhetőség:** a `fetchImpl` injektálható paraméter, és mind a hét eset saját hamis fetch-et ad.
A suite SOHA nem ér el a hálózathoz ehhez -- egy teszt, aminek a GitHub elérhetősége kell, az időjárást
méri, nem a kódot.

**Mérés:** alapvonal 6 teszt az `origin/develop`-on, nálam 13 -- a +7 pontosan az én hét esetem, semmi
nem tűnt el. Négy mutáció igazolja, hogy egyik állítás sem dekoratív (hardcode-olt trackingRef
visszaállítása, az üres-string ellenőrzés elvétele, a fail-soft megszüntetése, a repo-végpont
lecserélése egy ág-specifikusra) -- mind a négy bukik, mindegyik revert md5-tel bájtazonos.
A `repoConfigs()` aszinkronná tétele egyetlen hívót érint (a már `async` `refreshUpdateStatus`), és a
frissítés 6 óránként fut, tehát egy extra GitHub-hívás költsége elhanyagolható; cache nem kell.

**A főkönyvet is javítottam:** a `fork-upstream-conflict-guard.test.ts` "THE ONE GENUINE RESIDUE"
bejegyzése eddig azt mondta, hogy ez "left as a follow-up" -- ez a landolással hamissá vált volna.
Most kimondja, hogy lezárva, és rögzíti a második felét is (trackingRef), ami az eredeti jegyzetben
nem szerepelt. Egy főkönyv, ami egy elintézett dolgot még mindig teendőként említ, olyan főkönyv,
amiben senki nem bízik.

**Utólagos kiegészítés (ugyanaznap, a landolás blokkolta):** az első landolási kísérlet `REFUSED`-öt
kapott, és nem flake volt. A fork/upstream merge-conflict őr azt jelentette, hogy a
`src/__tests__/update-checker-branch.test.ts` mostantól ütközik az upstreammel, és senki nem döntött
róla. Megmértem, hogy tényleg az én változtatásom okozta-e: `merge-tree` a commitommal 50 ütközést
ad, a szülő commitjával 49-et, és a különbség pontosan ez az egy fájl. Mindkét oldal a 60. sor utáni
FARKBA fűzött be egy új describe-blokkot, ezért ütköznek. Az upstream blokkja a `remoteIsOwnOrigin`,
`branchOnRemote` és egy könyvtár-argumentumot fogadó `parseGitHubRemote(root)` köré épül -- ebből a
forkban EGYIK SEM létezik (a `remoteIsOwnOrigin` és a `branchOnRemote` sehol, a `parseGitHubRemote`
pedig argumentum nélküli), tehát nem fordulna le. Ez nem ízlésbeli választás, hanem ugyanaz a
szándékos át-nem-vétel, amit a `src/web/update-checker.ts` bejegyzése már rögzít, csak a teszt
oldaláról nézve. **Döntés: a fork oldala marad egészben**, mindkét hunkban; az upstream `afterAll`
importja a saját blokkjához tartozik, azzal együtt esik ki. A szabály KÖTVE van a modul-bejegyzéshez:
ha a gépezet valaha átkerül, az upstream esetei ugyanabban a változtatásban jönnek vele, külön nem
támaszthatók fel. Egy teszt-fájl az az egyetlen hely, ahol a "vedd a másik oldalt egészben" ártalmatlannak
látszik, miközben csendben lefedettséget töröl.

**Ki döntött:** backend2 (lelet a f27c999b B-hullámból, mérés + megvalósítás), MikroB (a szélesebb
hatókör jóváhagyása).
**Hivatkozás:** kártya 1140a745; `src/web/update-checker.ts`,
`src/__tests__/update-checker-branch.test.ts` (6 -> 13 eset), `src/__tests__/fork-upstream-conflict-guard.test.ts`.

## 2026-09-05 10:20 -- gate-sha-repo.test.ts: a hamis pirosat a teszt oldalán zárjuk, a szkript nem változik

**Döntés:** A `src/__tests__/gate-sha-repo.test.ts` négy esete élő HTTP-hívást tett a dashboardra
(`store/gate-sha-repo.sh`, `curl --max-time 3`). A javítás KIZÁRÓLAG teszt-oldali: egy `file://`
alapú board-stub (`boardStub()`), amit a szkript már meglévő `DASHBOARD_URL` és
`DASHBOARD_TOKEN_FILE` kapcsolóin keresztül kap meg. A `gate-sha-repo.sh` egyetlen bájtja sem
változik, a 3 másodperces büdzsé és a fail-soft ág éles viselkedésként marad.

**Miért:** Telített teljes suite-ban a 3 mp lejárt, a szkript a szándékos fail-soft ágára esett
(`unlanded`, exit 3), a teszt viszont a card-id választ (exit 4) várta, tehát HELYES kódon lett
piros. Három előfordulás egy nap alatt, ebből KETTŐ QA gate-futás -- ott a hamis piros helyes munkát
küld vissza `in_progress`-be, ami a 17. szabály szerint a legdrágább kár. Mérve: a változtatás
előtti fájl elérhetetlen boardon `AssertionError: unlanded: expected 3 to be 4`, 12,36 mp; utána
ugyanaz a futás 12/12 zöld, 0,49 mp.

**Miért `file://` és nem stub HTTP-szerver porton:** egy szerver ugyanabból a Node event loopból
válaszolna, amit a telített worker éheztet -- vagyis pont az a 3 mp-es büdzsé járhatna le újra,
amit javítunk. A `curl` fájlt olvas socket, port és event loop nélkül, ott nincs mi lejárjon.

**Amit a stub cserébe elveszít, kimondva:** a board válasz-ALAKJÁT (`{"card":{"id","title"}}`)
bedrótozza, tehát egy alak-változás élesben törne, itt nem. Tudatosan vállalt csere: a szkript
`d.get("card", d)`-vel mindkét alakot tűri, és egy board-alakváltozás egyszerre sok flotta-szkriptet
törne, hangosan. Amivé viszont NEM válhat: indok arra, hogy élő hívás visszakerüljön egy
teljes-suite tesztbe.

**Ki döntött:** MikroB (kártya nyitása, jóváhagyás -- az `edd4c3bf` élő eredményét érinti, ezért
külön kártyán), backend (mérés + megvalósítás).
**Hivatkozás:** kártya 90eaa6e5 (a 9bb2e651 leletéből); `src/__tests__/gate-sha-repo.test.ts`
(10 -> 12 eset).

## 2026-09-05 -- e00e7ff3 -- Upstreammel közös teszt-fájl bővítése tartozik egy ACKNOWLEDGED_CONFLICTS bejegyzéssel

**Döntés:** a `project-workflow` skill kapott egy új szekciót arról, hogy ha valaki egy upstreammel
KÖZÖS marveen teszt-fájl VÉGÉRE fűz új `describe` blokkot, az ütközést gyárt, mert az upstream
ugyanoda fűz. A tartozás ezért ugyanabban a commitban esedékes: `ACKNOWLEDGED_CONFLICTS` bejegyzés
plusz `ACKNOWLEDGED_UPSTREAM_BLOBS` pin.

**Miért skill és nem CLAUDE.md:** a CLAUDE.md már kimondja a landolási folyamatot; ez egy konkrét,
visszatérő buktató a folyamaton BELÜL, és a `project-workflow` skill az a hely, ahol a többi hasonló
(teszt-worktree, `[NN%]` clobber) is él. A szekció három dolgot rögzít, amit a 1140a745 mérése adott:
(a) a tulajdonlás egy paranccsal eldől (`merge-tree` a saját commiton és a szülőn, a két szám
különbsége a saját fájl -- mérve 50 kontra 49); (b) a feloldást SZIMBÓLUMBÓL kell eldönteni, nem
ízlésből (ha az upstream blokkja nem létező függvényeket hív, az oldala le sem fordulna, ez mért tény);
(c) a teszt-fájl bejegyzését oda kell kötni a tesztelt modul bejegyzéséhez, mert teszt-fájlnál a
"vedd a másik oldalt egészben" az egyetlen olyan hely, ahol ez a lépés nem hangos, viszont csendben
lefedettséget töröl.

**Hol él a szöveg:** a verziókövetett `seed-skills/project-workflow/SKILL.md`-ben ÉS az élő
`~/.claude/skills/project-workflow/SKILL.md`-ben, szó szerint azonosan. Csak a seedbe írni azt
jelentené, hogy a szabály a következő `update.sh`-ig nem létezik a futó flottának; csak az élőbe írni
azt, hogy egy friss telepítésre soha nem kerül ki, és nincs verziókövetve. Azonos szöveggel a jövőbeli
`seed_copy_try_merge` erre a régióra no-op.

**Mellékes lelet, NEM javítva:** a seed `project-workflow` SKILL.md még a RÉGI zárási sorrendet
mondja (`waiting` + REVIEW), az élő példány viszont már az e98a34d3 szerinti helyeset (ELŐSZÖR REVIEW,
utána `waiting`). A 75a573af commit csak a CLAUDE.md-t javította, a seed-skillt nem, tehát egy friss
telepítés a javítás ELŐTTI sorrendet kapná. Ez pontosan ugyanaz a drift-osztály, amiről ez a kártya
szól, egy szinttel feljebb. Nem nyúltam hozzá: egy másik kártya landolt eredménye, MikroB döntése,
hogy nyit-e rá kártyát.

**Ki döntött:** MikroB (kártya nyitása backend2 leletéből), backend2 (a szekció tartalma és a
seed+élő kettős írás).
**Hivatkozás:** kártya e00e7ff3 (lelet: 1140a745); `seed-skills/project-workflow/SKILL.md`.

## 2026-09-05 10:35 -- A suite-zár guard-tesztje a FELOLDOTT zár-útvonalat állítja, nem a forrásszöveget

**Döntés:** A `fleet-test.sh` kap egy `--lock-path` kapcsolót, ami kiírja a ténylegesen használt zár
fájlt és kilép, MIELŐTT bármit zárolna. A `fleet-test-serialises-runs.test.ts` elsődleges állítása
mostantól ez a visszakapott ÉRTÉK, nem a szkript forrásszövegének mintaillesztése. A szöveg-olvasás
megmarad másodlagos rétegnek, két javítással: a teljes-soros kommentek olvasás előtt lehullanak, és
a kapcsos zárójel opcionális mindkét mintában.

**Miért:** Cybersec mérése (a 2f0c7d24 következménye): a szöveg-alapú `problems()` (a) a
kapcsos zárójel nélküli `LOCK_FILE="$TEST_TREE.lock"` alakot nem nevezte meg, csak a homályos
"nincs gépszintű horgony" üzenetet adta, és (b) egy KOMMENTBE tett kanonikus sorral teljesen
elnémítható volt -- per-fa zárral együtt `problems() === []`. Mindkettőt reprodukáltam a landolt
szkripten, mielőtt hozzányúltam volna: (a) egyetlen homályos lelet, (b) NULLA lelet.

Ez a HARMADIK eset egy napon belül ugyanabból az osztályból (a14812e8, 06d36307-F1, 43ecdbe6),
ezért a javítás nem a mintát csiszolja, hanem kilép a szöveg-illesztésből: egy visszakapott értéket
nem lehet a helyes szavak leírásával kielégíteni.

**Amit szándékosan NEM javítok:** a kód UTÁN álló, sor végi kommentet nem vágom le. Helyesen csak
úgy lehetne, ha tudnám, mikor van a `#` sztringen belül (`${VAR#prefix}` nem komment), és egy
félig-jó vágó valódi sorokat rontana el. A maradék rés azért vállalható, mert az elsődleges állítás
már nem szöveges.

**Egy mérési tanulság, ami a tesztbe is bekerült:** a `--lock-path` ALAPÉRTELMEZETT fán mérve nem
elég bizonyíték. Az alapértelmezett tesztfa `/home/neon/marveen-test`, tehát a per-fa zár
(`$TEST_TREE.lock`) és a gépszintű (`${ROOT}-test.lock`) UGYANAZT a stringet adja. A megkerülést
csak a `FLEET_TEST_TREE`-vel felülírt eset mutatja meg -- és ehhez kell egy kontroll is, ami
igazolja, hogy a szkript egyáltalán olvassa a változót (a `--path` követi), különben egy a
környezetet teljesen figyelmen kívül hagyó szkript is átmenne.

**Ki döntött:** Cybersec (mérés + a javítási irány), MikroB (kártya), backend (megvalósítás).
**Hivatkozás:** kártya 43ecdbe6; `store/fleet-test.sh`,
`src/__tests__/fleet-test-serialises-runs.test.ts` (4 -> 8 eset).

## 2026-09-05 -- bfc028b4 -- Elavult seed-skillek felzárkóztatása, és egy mérőeszköz-hiba, ami a felét érvénytelenítette

**A probléma:** több seed-skill példány egy MÁR JAVÍTOTT hibát ír le helyesnek. A legsúlyosabb az
e98a34d3 zárási sorrend (`waiting` + REVIEW helyett ELŐSZÖR REVIEW): a 75a573af commit kizárólag a
CLAUDE.md-t javította, így több seed-példány máig a régi sorrendet tanítja. Egy friss telepítés
pontosan azt az árva `waiting` kártyát termelné újra, ami miatt a szabály megszületett.

**Amit ez a commit szállít: 5 fájl a `seed-skills/` fában.** Ennek a fának a live megfelelője
igazoltan a globális `~/.claude/skills/` (install-linux.sh:1464 és update.sh:826). Ezen belül:
`plan-grilling` és `qa-test-strategy` (template LAGS, csak beszúrás), valamint
`fork-adopt-investigation`, `full-value-audit` és `project-workflow` (two-sided, ahol az ÉLŐ van
előrébb: mindegyik élő sor egy LANDOLT kártyára vagy landolt CLAUDE.md-szabályra hivatkozik).
NEM szinkronizáltam a `qa-test-strategy/references/SKILL-FULL-BACKUP.md`-t: ott a TEMPLATE van
előrébb (`python3 -c "import sqlite3"` egy kimondott "a sqlite3 CLI NEM garantált telepítve"
megjegyzéssel, és megtartja a `{{INSTALL_DIR}}`-t), tehát a szinkron TÖRÖLNE egy hordozhatósági
javítást.

**A `seed-fleet-agents/` fele VISSZAVONVA, mielőtt landolt volna, mert a mérőeszköz rossz oldalhoz
hasonlít.** A `store/skill-drift-map.py` MINDEN seed-fát az EGYETLEN globális `~/.claude/skills/`
könyvtárhoz mér, a per-ügynök `seed-fleet-agents/<a>/.claude/skills/` fákat is. A tényleges live
megfelelőjük viszont `agents/<a>/.claude/skills/`, mert az install-linux.sh:1534 a
`seed-fleet-agents/<a>/`-t az `agents/<a>/`-ba másolja. Mérve: a 10 per-ügynök fájl MINDEGYIKÉNEK
van saját live példánya, és MINDEGYIK eltér a globálistól (2-től 237 eltérő sorig). Tíz fájlt
szinkronizáltam egy olyan forráshoz, amit az érintett ügynökök nem olvasnak; a "result ≡ live"
állításom is a rossz oldalra vonatkozott. A commitot a landolás előtt megállítottam (semmi nem ment
`origin`-ra), és a per-ügynök felet visszaállítottam.

**A javított mérés, a helyes gyökérrel** (a tool száma kontra a valóság):
- `TEMPLATE-ONLY skill`: a tool 17-et mond, valójában **1** (`fron-ted/impeccable`). A többi 16 telepítve
  VAN, csak per-ügynökként. MikroB gyanúja ("lehet ártalmatlan") helyes volt, az ok egy eszközhiba.
- 189 fájl azonos, 11 de-perszonalizálás (helyesen nem drift), 29 valódi drift-sor.
- Két olyan kategória jelenik meg, amit a tool SOHA nem mutatott: **2 `LIVE LOST content`**
  (`fron-teddy` és `fullstack` `react-page-api-wiring`), ahol az ÉLŐ példány veszített el tartalmat.
  Ez a veszélyesebb irány, és pont ez maradt láthatatlan.
- A 10 visszavont fájlból a helyes gyökérrel mérve `backend` és `backend2` `async-refactor-fail-open-guard`
  példánya AZONOS a live-jával: két szinkron teljesen fölösleges lett volna.

**Enyhítő körülmény a per-ügynök oldalon, mérve:** a `seed-fleet-agents/` fát az update.sh SOHA nem
frissíti (a `refresh_untouched_seeds` hívások csak `seed-skills`-re és a scheduled-tasks fákra
mennek), az install pedig kihagyja a már létező ügynököt. Tehát ez a drift kizárólag FRISS
telepítést vagy ÚJONNAN létrehozott ügynököt érint; meglévő gépen nem romlik tovább és nem is gyógyul.

**A tanulság, ami a fájlokon túl is áll:** az őreim a HŰSÉGET tudják ellenőrizni, az IRÁNYT és a
PÁROSÍTÁST nem. Két negatív kontrollal mértem: (1) a placeholder-belaposítást nem a placeholder-
számláló kapta el (egy elveszett, egy keletkezett, nettó nulla), hanem a nyers-útvonal ellenőrzés;
(2) a "template van előrébb" fájl vak szinkronját EGYIK őr sem kapta el, mert a normalizált
egyenlőség teljesül, ha a cél maga az élő fájl. Most kiderült a harmadik, ami mindkettőnél
súlyosabb: ha a live PÁR maga rossz, minden állítás igaz marad és mégis értéktelen. Egy
"nulla eltérés" jelentés akkor is így néz ki, ha a rossz két fájlt hasonlítottuk össze.

**Ki döntött:** MikroB (kártya + hatókör), backend2 (irány-döntés fájlonként, negatív kontrollok,
az eszközhiba felderítése és a per-ügynök fél visszavonása).
**Hivatkozás:** kártya bfc028b4; `seed-skills/` 5 fájl. A per-ügynök fél és a
`store/skill-drift-map.py` javítása külön döntést igényel.

## 2026-09-05 10:45 -- A tripwire-riasztás a könyvtárnevet ADATKÉNT írja ki (Cybersec H1, NO-GO feloldás)

**Döntés:** Az `agent-dir-tripwire.ts` riasztása a támadó által választott könyvtárnevet mindkét
helyen fertőtlenítve jeleníti meg: a névnél idézve-escapelve (`asData`), a karantén-útvonalnál pedig
egy származtatott, fájlrendszer-biztos slug alakjában (`quarantineSlug`), nem a nyers néven.

**Miért:** Cybersec HIGH lelete a landolt `9bfa6858`-on, lefuttatott PoC-cal. A `readdirSync`
kimenete Linuxon a `/` és a NUL kivételével bármilyen bájtot tartalmazhat, ÚJSORT is. A nyers
interpoláció miatt egy `mkdir agents/$'system-directive\n\n[SYSTEM-DIREKTIVA ...] <utasítás>'` a
riasztás törzsébe SAJÁT SORKÉNT került be, egy biztonsági riasztás keretében, `from=<fő ügynök>`
azonosítóval. Ez pont az az azonosító, amit a HTTP API NEM enged hamisítani (a `POST /api/messages`
403-at ad rá, mert a fő ügynöknek nincs `agents/` könyvtára), a tripwire viszont folyamaton belül,
a route-őrök mellett írja. Vagyis nem ugyanaz a képesség más köntösben, hanem ÚJ képesség, egyetlen
`mkdir`-rel, pontosan attól a szereplőtől, akit ez a kontroll figyel.

**Miért nem elég a `JSON.stringify` önmagában:** nem escapeli az U+2028/U+2029 sorelválasztókat,
amiken több megjelenítő tördel. Ezért a nem-nyomtatható ASCII-n kívüli minden karakter előbb látható
escape-re cserélődik, és csak utána megy az idézőjelezés.

**Miért kap a karantén-útvonal is fertőtlenített nevet:** a riasztás KIÍRJA ezt az útvonalat, tehát
a nyers név ott MÁSODSZOR is becsempészné a payloadot. A slug megtartja az alfanumerikus részt (hogy
egy ember össze tudja párosítani a riasztást a könyvtárral), de minden struktúrát elvesz; a sha256-os
utótag pedig megakadályozza, hogy két különböző név ugyanabba a célkönyvtárba olvadjon össze.

**Amit a teszt pontosan állít:** nem azt, hogy a payload karakterei eltűnnek (a nevet jelenteni KELL),
hanem hogy a STRUKTÚRA tűnik el -- a törzs egyetlen sora sem kezdődik idegen szögletes prefixszel, és
a név egyetlen soron van. Mindkét interpolációs hely külön mutánssal ellenőrizve.

**Nyitva marad, Cybersec beleegyezésével külön kártyára:** H2 (sweepenkénti riasztás- és
karantén-korlát hiánya, MEDIUM) és L1 (a "egy fenntartott halmaz" őr csak a `new Set([...])` alakot
látja, LOW).

**Ki döntött:** Cybersec (lelet + javítási irány), backend (megvalósítás).
**Hivatkozás:** kártya 53c59307, Cybersec komment 20410; `src/web/agent-dir-tripwire.ts`,
`src/__tests__/agent-dir-namespace-runtime.test.ts` (7 -> 9 eset).

## 2026-09-05 -- 23d09a68 (1. lépés) -- A skill-drift eszköz mostantól minden seed-fát a SAJÁT live párjához mér

**Döntés:** a `store/skill-drift-map.py` minden template-fához a ténylegesen hozzá tartozó live
gyökeret párosítja. A `seed-skills/` továbbra is a globális `~/.claude/skills`-hez mérődik
(install-linux.sh:1464, update.sh:826), a `seed-fleet-agents/<a>/` viszont mostantól az
`agents/<a>/.claude/skills`-hez, mert az install-linux.sh:1534 oda másolja. Ezenfelül az eszköz
megtanulta a második placeholder-konvenciót is: a `__MARVEEN_INSTALL_DIR__` / `__MARVEEN_HOME__`
sentineleket (install-linux.sh:1546), rendereléshez ÉS a belaposodás-számláláshoz egyaránt.

**Miért:** a rossz párosítás CSENDES. Az eszköz végig jelentett, csak nem arról a két fájlról,
amiről hitte. A valós telepítésen 17 `TEMPLATE-ONLY skill`-t mondott, amiből EGY volt valódi (a
másik 16 telepítve van, csak per-ügynökként), és teljesen elrejtett két `LIVE LOST content` sort,
vagyis pont a veszélyes irányt. A bfc028b4 kártyán emiatt szinkronizáltam tíz fájlt egy olyan
forráshoz, amit az érintett ügynökök nem olvasnak; a landolás előtt visszavontam.

**Ami ezen felül változott:** ha egy seed-ügynöknek egyáltalán nincs telepített live fája, az
mostantól EGYSZER jelenik meg (`LIVE TREE ABSENT`), nem skillenként. A skillenkénti ismétlés tette
olvashatatlanná a régi számot: a jel a saját zajában fulladt meg.

**Egy meglévő teszt fixture-jét át kellett helyezni, nem törölni.** A `sees every template tree,
not only seed-skills` eset a per-ügynök seed live felét a GLOBÁLIS könyvtárba írta, vagyis a hibát
rögzítette a fixture-be: a teszt szándéka helyes volt, a párosítása nem. Az állítás változatlan,
csak a fájl került oda, ahová valójában települ. A `waiting`-re állított kártya lezárásakor ez a
különbség számít: egy eltűnt teszt FAIL lenne, egy áthelyezett fixture nem.

**Bizonyíték:** 10 -> 16 eset ebben a fájlban (a +6 pontosan a hat új eset), a tágabb seed/skill
őrkészlet 88 -> 94. Négy mutáció, mind a saját esetével elkapva, minden revert md5-tel bájtazonos:
(M1) a per-ügynök live-gyökér visszaállítása a globálisra -> 5 bukás; (M2) a sentinelek kivétele a
SUBS-ból -> 1; (M3) a `LIVE TREE ABSENT` skillenkénti jelentése -> 1; (M4) a `__MARVEEN_` kivétele a
`PLACEHOLDER_RX`-ből -> ELSŐRE 0 BUKÁS. Az M4 a saját munkám fedetlen fele volt: a sentinel-
belaposodásra nem volt eset, tehát a változtatás azon fele bizonyíthatatlan lett volna. Írtam rá
egyet a git-alapú regressziós blokkba, utána az M4 is bukik. Ezt azért írom le, mert a tanulság nem
a javítás, hanem az, hogy a mutáció-futtatás nélkül ez a fél változtatás dekorációként landolt volna.

**A javított mérés a landolt develop-on:** 13 placeholder-renderelés + 11 de-perszonalizálás
(helyesen nem drift), és 46 valódi drift-sor: 14 template-only fájl, 12 two-sided, 10 live-only
fájl, 7 template LAGS, 2 LIVE LOST content, 1 TEMPLATE-ONLY skill. A régi leírás "70 tétele"
ezzel érvénytelen; a 23d09a68 leírását átírtam.

**Ki döntött:** MikroB (előbb az eszközt javítsuk, minden más arra épül), backend2 (a párosítási
hiba felderítése, a javítás és a mutációs igazolás).
**Hivatkozás:** kártya 23d09a68 (lelet: bfc028b4); `store/skill-drift-map.py`,
`src/__tests__/skill-drift-map.test.ts` (10 -> 16 eset).

## 2026-09-05 -- 1b6abfad -- A skill-feloldás nálunk a PROJEKT-szintű példányt választja, és emiatt három FE-ügynök csonka útmutatót olvasott

**A mért tény, ami mindent eldönt:** ezen a telepítésen a munkakönyvtár `.claude/skills/`
példánya NYER a személyes `~/.claude/skills/`-szel szemben. Ez a HIVATALOS DOKUMENTÁCIÓ
ELLENTÉTE (code.claude.com/docs/en/skills: "personal overrides project"), ezért mérni kellett,
nem elolvasni. Valószínű magyarázat, hogy a doksi újabb viselkedést ír le a nálunk futó
verziónál; a mi telepítésünkre a mérés a mérvadó.

**A mérés maga, nulla fájlmódosítással:** az `async-refactor-fail-open-guard` skill mindkét
helyen létezik, 127-127 sor, és pontosan EGY sorban tér el (a globális az e98a34d3 szerinti
javított zárási sorrendet mondja, a projekt-szintű a régit). A skill meghívásakor a
PROJEKT-szintű sor érkezett, és a futtató a base directoryt is kiírta. Egy eleve meglévő
különbség mérésre használható; nem kellett hozzá semmit elrontani.

**Miért számít:** a `react-page-api-wiring` skill projekt-szintű példányából a fron-ted,
fron-teddy és fullstack ügynöknél hiányzott 143-211 sor, köztük KÉT BLOKKOLÓNAK jelölt
szekció (action-gomb RBAC-képesség ellenőrzés; endpoint-készültség négy állapota). Mivel a
projekt-szintű nyer, ezek az ügynökök TÉNYLEGESEN a csonka verziót olvasták. A 2b szekció pont
a 9. munkavégzési szabály (flow-connectivity) által tiltott hibaosztályt zárja ki, és egy valós
esetet is idéz: az F1 open-shift kártyán a crew "claim" gomb rossz RBAC Actionhöz volt kötve,
minden crew-kattintás 403-at kapott, miközben a FE kód és a tesztek zöldek voltak.

**Döntés: MERGE, nem másolás.** A kártya azt mondta, "zárkóztasd fel mindhármat a globálishoz
(673 sor)". Ez fron-ted-nél 26 sort TÖRÖLT volna: a projekt-példánya egy egész szekciót visz,
amit a globális nem ismer ("## Detail view (fetch-by-ID, no demo fallback)", a 404 kontra 5xx
elágazással és teszt-példával). Ezért mindhárom fájl aligned merge-öt kapott, két állításra
kötve: egyetlen projekt-sor és egyetlen globális sor sem veszhet el.

**Az eredmény önmagát ellenőrzi:** fron-teddy és fullstack merge-elt tartalma BÁJTAZONOS a
globálissal (sha 07495a6b, 673 sor) -- ez a legerősebb megerősítés arra, hogy náluk a globális
valódi felülhalmaz volt, tehát a merge ott pontosan a helyes csere. fron-ted 711 sor lett: 673
globális + a saját 26 sora.

**Az `agents/` GITIGNORE-OLT (.gitignore:86), tehát ez a változás NEM látszik commit-diffként.**
Ezért a felülvizsgálhatóság és a visszaállíthatóság csak akkor létezik, ha itt előállítom:
mindhárom fájlról időbélyeges biztonsági másolat készült, és a sha256 előtte/utána rögzítve van
(fron-ted 8ef3905d -> 1ba774e8, fron-teddy és fullstack 078b2bdf -> 07495a6b). A másolatok a
`store/skill-backups/` alá kerültek, NEM a skill-fa mellé: egy a vizsgált fában hagyott backup
maga válik mérési zajjá (lásd lent).

**Mellékelelet, amit a saját backupom hozott elő:** a `skill-drift-map.py` 10 `live-only file`
sorából MIND A 10 backup-artefaktum (9 darab `SKILL.md.seedbak.<epoch>` az update.sh merge-útjából,
plusz egy elárvult `SKILL.md.bak` cybered fájában), nulla valódi drift. A "46 valódi drift-sor"
tehát valójában 36. Az eszköz backup-kihagyása a 23d09a68-ra megy.

**A seed is frissült:** fron-ted seed-példánya megkapta ugyanazt a 26 soros szekciót (673 -> 711),
különben egy friss telepítés újratermelné a hiányt. fron-teddy és fullstack seedje a javítás után
már egyezik a live példányával, ott nincs teendő.

**Ki döntött:** MikroB (kártya, HIGH, majd az empirikus zárás kérése), backend2 (a mérés, a
merge-döntés a másolás helyett, a mentés/rollback út).
**Hivatkozás:** kártya 1b6abfad; `agents/{fron-ted,fron-teddy,fullstack}/.claude/skills/
react-page-api-wiring/SKILL.md` (gitignore-olt, élő), `seed-fleet-agents/fron-ted/.claude/skills/
react-page-api-wiring/SKILL.md` (verziókövetett).

## 2026-09-05 -- 30b76a8d -- A gate-ügynökök a saját gate-elési skilljük felét nem látták

**A helyzet:** a projekt-szintű skill-példány nyer (a 1b6abfad-en mérve), és a gate-ügynökök
példányai csonkák voltak. A qa és qa2 a `qa-test-strategy`-ből 89 sort olvasott a 172-ből, és a
rejtett 127 sor között ott volt a teljes `## Kötelező ellenőrzőlista (minden kártyán)`, az
`## Alapeljárás`, a magic-link atomic-fact buktató és a references index. Mind a négy gate-ügynök
(qa, qa2, cybersec, cybered) `gate-worktree-pattern` példányából pedig pont az a 15 sor hiányzott,
ami az `--agent` kapcsoló kötelezőségét írja le (kártya a7da80d6) -- vagyis annak a javításnak a
leírása, ami megakadályozza, hogy két gate ugyanazon a kártyán és shán egy könyvtárra ütközzön.

**Döntés: merge, nem másolás -- 11 fájlból 10-nél ez különbséget is jelentett.** A kártya azt
mondta, zárkóztassuk fel a globálishoz; a literális végrehajtás fájlonként 1 és 66 közötti sort
törölt volna, mert a projekt-példányok saját tartalmat is visznek. Az egyetlen fájl, ahol a
másolás is helyes lett volna, a `teszter/qa-test-strategy` -- és ez látszik is: az eredménye
bájtazonos a globálissal (sha 9d599569). A többi tíznél a projekt-only tartalom megmaradt.

**ATOMI ÍRÁS, mert mind a négy gate-ügynök FUTOTT.** A 1b6abfad-nél mindhárom FE-ügynök állt, itt
viszont a qa, qa2, cybersec és cybered egyaránt `running=True` volt. Egy csonkoló írás ablakot hagy,
amiben egy egyidejű skill-betöltés fél fájlt olvas; ezért ideiglenes fájl + `os.replace` ment, a
0664-es módot kifejezetten átvive (egy friss temp fájl különben az umask alapértelmezésére esne).
Symlink-ellenőrzés is fut írás előtt.

**A FÉL JAVÍTÁS, amit menet közben kellett észrevenni:** a visszaállított `## References index`
négy `references/*.md` fájlra mutat, amik a globális fában megvannak, de EGYIK ÉRINTETT ÜGYNÖK
fájában sem. Vagyis a szekció visszahelyezése önmagában egy olyan indexet állított volna helyre,
aminek minden linkje halott pont ott, ahová visszakerült. A négy fájl telepítve lett -- fájlonként
eldöntött forrásból: háromnál a seed és a globális bájtazonos, a `SKILL-FULL-BACKUP.md`-nél viszont
a SEED van előrébb 10 sorral (a "sqlite3 CLI nem garantált telepítve" python-fallback), ezért az
onnan jött, renderelve.

**Egy ötödik link NEM hiányzik, csak a saját ellenőrzőm nézte annak:** a `references/atomic-fact.md`
egy MÁSIK skill (`atomic-fact-gate-protocol`) fájlja, a szövegben abszolút úttal. A regexem a
végét illesztette, és hiányzónak minősítette. A fájl megvan globálisan, per-ügynök példány nincs
rá, tehát ott a globális nyer. Nem javítottam a skill prózáját (nem az én szövegem, 3. alapelv).

**Egy saját őröm túl szigorú volt, és ezt is meg kellett mérni:** a seed-oldali merge-nél az
`extra` (a seedben lévő, a live-ban nem szereplő sor) önmagában elutasítást váltott ki. Ez hibás:
egy kétoldali fájlban a seed jogosan visz sajátot, és a megtartása MAGA a merge célja. A helyes
feltétel az, hogy minden extra sor a SEEDBŐL jöjjön -- egy máshonnan került sor lenne a valódi
hiba ("invented"). A `qa2/i18n-parity-sweep` emiatt bukott először.

**Bizonyíték:** 11 élő fájl írva, mind a két állítással (egyetlen projekt- és egyetlen globális sor
sem veszett el), sha előtte/utána rögzítve, mentés a `store/skill-backups/` alá. Lemezen
ellenőrizve: a `gate-worktree-pattern` `--agent` sora mind a négy ügynöknél ott van, a
`## Kötelező ellenőrzőlista` a qa és qa2 példányában ott van, nulla ottfelejtett temp fájl.
7 seed-fájl frissült + a teszter seedje megkapta a négy hiányzó reference fájlt. 8 seed/skill
őrteszt zölden (87 passed).

**Ki döntött:** MikroB (kártya, NORMAL, mert a gate-működést érinti), backend2 (fájlonkénti
irány, atomi írás a futó ügynökök miatt, a references fél-javítás észrevétele).
**Hivatkozás:** kártya 30b76a8d; `agents/{qa,qa2,teszter,cybersec,cybered}/.claude/skills/...`
(gitignore-olt, élő), `seed-fleet-agents/{qa,qa2,teszter}/...` (verziókövetett).

## 2026-09-05 -- 23d09a68 (2. lépés) -- A drift-riport `live-only file` kategóriája 100%-ban a saját backupjaink zaja volt

**Döntés:** a `skill-drift-map.py` kihagyja a backup-artefaktumokat (`*.bak`, `*.seedbak.<epoch>`)
mindkét sweepből. Az `update.sh:707` a mergelt fájl MELLÉ írja a `.seedbak.<epoch>`-ot, a vizsgált
fán BELÜL, tehát minden sikeres merge egy állandó sort adott a riporthoz.

**Miért nem elvi, hanem mért:** a valós telepítésen a 10 `live-only file` sorból MIND A 10 backup
volt (9 `seedbak` + egy elárvult `.bak` cybered fájában), nulla valódi lelet. A kategória tehát nem
zajos volt, hanem teljes egészében zaj.

**Szándékosan szűk minta.** Csak a két backup-utótag, mert egy skill-fájl `SKILL.md` vagy valami a
`references/` alatt -- egy `.bak` sosem hordoz működést. Egy tág "hagyj ki mindent, ami szokatlan"
szabály viszont elrejtené az első valódi extra fájlt, amit valaha valaki odatesz. Ezt CONTROL eset
őrzi: egy valódi extra fájl a live fában TOVÁBBRA IS jelentődik.

**Bizonyíték:** 16 -> 18 eset, két mutáció mindkét irányban: a skip kivétele -> 1 bukás, a skip
kiszélesítése "mindent kihagy"-ra -> 7 bukás; a revert md5-tel bájtazonos. A drift-riport valódi
sorai 46-ról 20-ra estek (a mai javításokkal együtt): 6 template-only fájl, 6 two-sided, 6 template
LAGS, 1 TEMPLATE-ONLY skill, 1 LIVE LOST content, és NULLA live-only fájl.

**Egy aszimmetria, amit ÉN hoztam létre és NEM oldottam fel, indoklással.** A
`seed-fleet-agents/qa2/i18n-parity-sweep` mostantól `LIVE LOST content`: a 30b76a8d-en a live
tartalmat bevittem a seedbe, de a seed saját három sorát nem vittem ki a live-ba. Az a három sor
viszont a MEGOSZTOTT CleanCore klónra hivatkozik (`cd /mnt/h/LM_Studio_Workdir/CleanCore`,
`BASE = pathlib.Path('/mnt/h/.../CleanCore/packages/i18n/messages')`), amit a CLAUDE.md már
visszavont: a klón CSAK fetch/landolás-alap, a munka per-ügynök worktree-ben folyik. A
"konvergálás" tehát elavult útmutatást vinne be pont abba a példányba, amelyik nyer. Ezért
szándékosan aszimmetrikus maradt; a skill tartalmi frissítése a tulajdonosára tartozik, nem erre a
kártyára.

**Ki döntött:** backend2 (a lelet a saját mentésemből jött: a `.bak`-ot először a skill-fa mellé
írtam, és azonnal driftként jelent meg -- ezért kerültek a `store/skill-backups/` alá).
**Hivatkozás:** kártya 23d09a68; `store/skill-drift-map.py`,
`src/__tests__/skill-drift-map.test.ts` (16 -> 18 eset).

## 2026-09-05 -- Minta -- Egy őr, ami KÖZVETÍTŐT pinnel, nem az EREDMÉNYT: négy lépcső, egy nap

**Mit láttunk:** egy napon belül négy kártyán, több szerzőtől, ugyanaz a gyökér jött vissza. Minden
kör valódi szűkítés volt, és egyik sem zárta le az osztályt, mert mindegyik egy KÖZVETÍTŐT állított
az EREDMÉNY helyett.

| lépcső | mit pinnel az őr | mi kerüli meg | kártya |
|---|---|---|---|
| 1. | a szimbólum nevét a nyers forrásszövegben | egy KOMMENT, ami leírja a nevet | `a14812e8` |
| 2. | a HOZZÁRENDELÉST (`VAR=...`) | a művelet máshonnan olvas; és egy MÁSODIK `VAR=` átirányítja az értéket | `06d36307`, `2f0c7d24` |
| 3. | a MŰVELET HELYESÍRÁSÁT (`^\s*(?:cp\|rsync\|mv)\b.*\$DEST`) | alias-változó a célra, `tar` a `cp` helyett, egysoros ciklus (a `cp` nem a sor eleje) | `07433dab` |
| 4. | a JELENTÉST (`--lock-path` kiírja a feloldott értéket) | a jelentés igazat mond, a művelet máshova megy (`exec 9>` más fájlra) | `43ecdbe6` |

**A 4. lépcső azért fontos, mert ÚGY NÉZ KI, MINT A KIÚT.** A 3. lépcsőn a helyes tanács az volt,
hogy lépj ki a szöveg-illesztésből, és a `43ecdbe6` pontosan ezt tette: a szkript egy kapcsolóval
VISSZAADJA a ténylegesen használt értéket, a teszt pedig azt állítja. Ez megöli az 1-3. lépcső
összes alakját (mérve: a komment-alak 2 pirosat ad, a második hozzárendelés 1-et -- utóbbi a
`07433dab`-on még zölden átment). Mégis marad egy varrat: a jelentett érték és a tényleges művelet
két különböző dolog. Mérve: ha a `--lock-path` az igazat írja ki, de az `exec 9>` egy másik fájlra
megy, a guard 8/8 zöld marad.

**A kimondott szabály:** ha egy őr KÓD-TÉNYT állít (jelen van, hiányzik, pontosan egyszer szerepel,
ezt az értéket használja), kérdezd meg, MIT figyel meg valójában. Ha a válasz "a forrásszöveget",
"egy sor alakját" vagy "amit a program mond magáról", akkor közvetítőt mérsz, és a varrat a
közvetítő és a dolog között mindig kihasználható. A hatást a hatás SAJÁT mechanizmusával kell mérni:

- zárra: futtasd a szkriptet a háttérben, és a JELENTETT útvonalon egy második folyamatból a
  `flock -n` BUKJON, egy per-fa kontroll-útvonalon pedig SIKERÜLJÖN;
- másolásra: ideiglenes cél-könyvtár, valódi korpusz PLUSZ egy CSALI korpusz, és állítsd, hogy
  pontosan a valódi korpusz nevei érkeznek meg.

**A kontroll nem opcionális.** Minden fenti alaknál a csali/negatív eset az, ami megkülönbözteti a
"helyesen működik" és a "semmit nem néz" állapotot. Csali nélkül egy üres cél-könyvtár is zöld.

**Ahol NEM alkalmazandó:** próza-/doksi-korpusz, ahol pont bármely említést keresel. A
megkülönböztetés ugyanaz, mint a Kódminőségi alapelvek 12. pontjában: kód-tényt vagy szöveg-tényt
állítasz.

**Az olcsó rétegek maradjanak, csak ne ők legyenek az elsődleges állítás.** A szöveg-illesztés és a
jelentés-ellenőrzés gyors előszűrő; a hatás-mérés a tényleges bizonyíték.

**Két konkrét, mérve alátámasztott alszabály, ami ebből esik ki:**

1. Aki KOMMENTET dob el illesztés előtt, tegyen NEM-ÜRESSÉG állítást a SZŰRT korpuszra. Szűrés után
   az üres korpusz minden negatív állítást zölden hagy. A `07433dab` javítása ezt helyesen csinálja
   (`expect(code.length, '<script> is empty after dropping comments').toBeGreaterThan(0)`). Mérve,
   hogy a szűrés nem torzít: az `install-linux.sh` 2294 sorából 1711, az `install-macos.sh` 1636-ból
   1287 marad, és a találatszám mindkét mintára 1 marad, szűréssel és nélküle egyaránt.
2. Aki JELENLÉTRŐL SZÁMLÁLÁSRA vált, mondja ki a kommentben, MIT számol. A "pontosan egy hely másol
   ide" túlállítás, ha a valóság "egy sor, ami parancs-tokennel kezdődik és megnevezi a
   cél-változót". A túlállítás a károsabb fele: a következő olvasó abbahagyja a keresést.

**Ki döntött:** Cybersec (a minta összegzése és a remedy általánosítása), MikroB (a lelet-kártyák
nyitása és a scoping), backend/backend2/backend3 (a négy javítás).
**Hivatkozás:** kártyák `a14812e8`, `06d36307` / `5f84bf68`, `2f0c7d24` / `43ecdbe6`, `07433dab` /
`38b43fe5`; CLAUDE.md Kódminőségi alapelvek 12. pont.

## 2026-09-05 11:20 -- A tripwire sweepenkénti riasztás- és másolás-korlátja (Cybersec H2)

**Döntés:** Az `agent-dir-tripwire.ts` sweepenként legfeljebb 3 RÉSZLETES riasztást küld, a többit egy
összefoglaló üzenetbe vonja; a karantén-másolat csak a részletesen riasztott nevekre készül, és egy
5 MB-nál nagyobb könyvtárat egyáltalán nem másol. Minden név latchelődik és minden név bekerül a
strukturált logba -- csak az ÜZENETEK olvadnak össze, a nyilvántartás nem.

**Miért:** a latch NÉVENKÉNT tart, tehát az egy név ismétlődését korlátozza, a sok nevet nem. Egy
`mkdir`-ciklus N különböző rosszul formált nevet csinál, amiből egyetlen sweepben N riasztás ÉS N
rekurzív másolat lett. A modul kommentárja ezt a DoS-t megoldottnak ÁLLÍTOTTA, ezért a komment is
javítva: kimondja, mit NEM fed a latch.

**Miért nem veszít bizonyítékot a kihagyott másolás:** ez a modul soha nem töröl, tehát az eredeti
könyvtár pontosan ott marad az `agents/` alatt, ahogy a támadó hagyta. A karantén egy kényelmi
másolat egy embernek, nem a nyilvántartás. Ezért a korlát biztonságos módon vág, szemben egy
törléssel, ami sosem lenne az.

**Egy dolgot a mérés vett ki a javításból:** először egy külön `MAX_COPIES_PER_SWEEP` konstans is
bekerült. A mutációs teszt megmutatta, hogy HOLT: a végtelenre állítása egyetlen tesztet sem
változtatott, mert csak a részletesen riasztott nevek kerülnek másolásra, tehát a riasztás-korlát
már eleve korlátozza a másolást is. Kivettem. Egy olyan konstans, amit semmilyen teszt nem tud
megfogni, nem védelem, csak látszat.

**Ki döntött:** Cybersec (lelet), backend (megvalósítás és a holt konstans kivétele).
**Hivatkozás:** kártya 75de69d4 (Cybersec komment 20410 H2); `src/web/agent-dir-tripwire.ts`,
`src/__tests__/agent-dir-namespace-runtime.test.ts` (9 -> 15 eset).

## 2026-09-05 11:55 -- A board-hívás Authorization-fejléce külön, mérhető helyre került (Cybered F-1/F-2)

**Döntés:** A `gate-sha-repo.sh` fejléc-összeállítása saját függvénybe (`board_auth_header`) került,
plusz egy `--auth-check` státusz-kapcsoló (`ok` / `no-token` / `empty-token`), ami SOHA nem írja ki
magát a tokent. Egy olvashatatlan token-fájl a válaszon nem változtat (marad `unlanded`, exit 3), de
mostantól kiír egy sort a STDERR-re, hogy a boardot kihagyta.

**Miért:** a 90eaa6e5 `file://` board-stubja determinizmust vett, cserébe kivette az
Authorization-utat a lefedettségből -- Cybered mérte: a fejléc teljes törlése a hívásból 12/12
ZÖLDET hagyott. A saját REVIEW-m a válasz ALAKJÁRA vonatkozó cserét bevallotta, ezt nem; ez az én
mulasztásom volt. Ezen felül egy hiányzó token-fájl csendben `unlanded`-re degradált -- vagyis
ugyanaz a mosás, ami ellen az eszköz született, egy szinttel lejjebb.

**Amit ez LEFED, és amit NEM (mérve, nem állítva):** a fejléc összeállítása és a hiba-osztályozás
(hiányzó vs üres token) most három eset alatt van, és a "kihagytam a boardot" jelzés feltételessége
is (a feltétel nélkülivé tett jelzés 6 tesztet visz pirosra). A curl-nek átadó EGY SOR viszont
TOVÁBBRA IS FEDETLEN: Cybered saját mutánsa (a fejléc nem jut el a curl-hoz) a 16 eset mellett is
zölden marad. Ennek a lefedése élő szervert igényelne, ami pont az a flake, amit a 90eaa6e5 megszűnt
-- ezért ez tudatosan vállalt maradék, nem elfelejtett rész. F-1 tehát SZŰKÍTVE van, nem lezárva.

**Egy sor, amiről a mérés kimondta, hogy nem kontroll:** a `[ -r "$TOKEN_FILE" ]` ellenőrzés
viselkedésben redundáns az alatta lévő `cat`-hibaággal (a mutánsa egyetlen tesztet sem visz
pirosra). Bent maradt megnevezett korai kilépésként, de a kommentje kimondja, hogy semmit nem szabad
"általa lefedettnek" nevezni.

**Ki döntött:** Cybered (lelet + a javítási irány: emeljük ki a fejléc-összeállítást), backend
(megvalósítás és a maradék rés megmérése).
**Hivatkozás:** kártya 33aeb7a8 (Cybered komment 20408 a 90eaa6e5-ön); `store/gate-sha-repo.sh`,
`src/__tests__/gate-sha-repo.test.ts` (12 -> 16 eset).

## 2026-09-05 -- 30b76a8d (NO-GO javítás) -- Egy "semmi ne vesszen el" merge megőrizte a LEVÁLTOTT parancsalakot

**A lelet (Cybersec NO-GO, komment 20441, függetlenül ellenőrizve):** a `gate-worktree-pattern`
négy per-ügynök példányán a merge visszahozta a RÉGI, kétargumentumos `cc-gate-worktree.sh`
hívást, és a helyes `--agent`-es alak ELÉ tette. Az a7da80d6 óta a régi alak `exit 2`-vel hal meg,
tehát mind a négy gate-ügynök egy halott parancsot látott elsőként a saját skilljében. Saját
méréssel megerősítve: a mergelt fájlban 6 invokáció szerepelt (3 `--agent` nélkül), a globálisban 3,
mind helyes.

**A gyökérok, és ez általánosabb a négy fájlnál:** a "egyetlen projekt-sor és egyetlen globális sor
sem veszhet el" invariáns BIZTONSÁGOS a kiegészítő tartalomra és HIBÁS a felülírtra, és semmi benne
nem választja szét a kettőt. Ugyanezt a csapdát ma már kétszer megmértem a SEED-oldali szinkronon,
és a LIVE sweepre nem alkalmaztam. A `megtartva > 0` önmagában nem hiba: a másik tíz fájlnál a
megtartott 1-66 sor valódi projekt-only tartalom volt, és a `teszter` esetében a `megtartva 0` és a
globálissal való bájtazonosság a helyes eredmény.

**Javítás:** a négy fájl a globális példány verbatim tartalmát kapta (106 sor, sha 505d9223),
atomi írással, mentéssel. Írás előtt két állítás fut a forrásra: a globális sha egyezik azzal,
amit a verdikt mért, és a globálisban nincs egyetlen csupasz kétargumentumos hívás sem -- e nélkül
a "másold a globálist" lépés vakon bízna abban, hogy a globális tényleg jó.

**Az osztály lezárása, amit Cybersec kért: `store/skill-merge-check.py`.** Az ELSŐ változatom
Cybersec szám-alapú jelzését implementálta ("a result többször említi a szkriptet, mint a forrás"),
és a VALÓS korpuszon MEGBUKOTT: hamis pozitívot adott a `qa/qa2 i18n-parity-sweep`-re, ahol öt
azonos, helyes invokáció szerepel. A használható jelzés élesebb: UGYANAZ a szkript KÉT ALAKBAN,
ahol az egyik a másik MÍNUSZ néhány argumentum -- pontosan ezt hagyja maga után egy újonnan
kötelezővé tett kapcsoló. A forrásban MÁR meglévő ilyen pár nem a merge műve, ezért nem jelentődik.

**Mérve a teljes valós korpuszon:** a négy hibás fájlt megjelöli, a tizennégy jóra (a tíz eredetileg
jó + a négy javított) tiszta. Nulla hamis pozitív. A tool saját selftestet visz, mert egy őr, amit
sosem futtattak le a saját alapító esetére, nem bizonyíték; 5 teszt-eset a repóban.

**Egy saját mérési hiba, amit érdemes leírni:** a detektort először a rossz mentés ellen
futtattam (`ls -t | tail -1` a LEGRÉGEBBIT adja, az a merge ELŐTTI 95 soros fájl volt), és négy
hamis "MISS"-t kaptam a saját eszközömre. Majdnem működésképtelennek minősítettem, holott a
tesztharness volt rossz. Ugyanaz a család, mint a "a megosztott log-könyvtár legújabb fájlja nem
az én futásom".

**Ki döntött:** Cybersec (a lelet, a súlyosság-besorolás -- kimondottan NEM biztonsági kitettség,
hanem fleet-működési hiba --, és a detektor ötlete), backend2 (független ellenőrzés, javítás,
a detektor jelzésének kiélesítése a valós korpuszon).
**Hivatkozás:** kártya 30b76a8d; `store/skill-merge-check.py`,
`src/__tests__/skill-merge-check.test.ts` (5 eset), `agents/{qa,qa2,cybersec,cybered}/.claude/
skills/gate-worktree-pattern/SKILL.md` (gitignore-olt, élő).

## 2026-09-05 12:15 -- A fenntartott-azonosító őre megfordult: tiltás a felsorolás helyett

**Döntés:** A "egy fenntartott halmaz" ellenőrzés többé nem EGY szintaxist (`new Set([...])`) keres,
hanem azt tiltja, hogy a `'system-directive'` LITERÁL kód-részben megjelenjen a definiáló modulon
kívül. A tesztek engedélyezettek, KATEGÓRIAKÉNT és nem négy fájlnév felsorolásaként.

**Miért:** Cybered maga nevezte meg a régi alakot leggyengébb pontnak, Cybersec pedig lemérte: egy
tömbös és egy `===`-láncos másodpéldány is 7/7 zölden maradt. Ez a nap ÖTÖDIK esete abból az
osztályból, hogy egy őr a művelet HELYESÍRÁSÁT pinneli a művelet helyett, ezért a javítás nem egy
bővebb minta -- holnap jön a harmadik szintaxis --, hanem az irány megfordítása. Minden összehasonlítás
leírja az azonosítót, tehát a literál tiltása a Set, a tömb, az `===`, a `switch` és a `case` alakot
EGYSZERRE fedi le, anélkül hogy bármelyiket megnevezné.

**Miért a tesztek KATEGÓRIA és nem lista:** egy négy fájlnévből álló kivétel-lista elavul, egy
kategória nem. Egy tesztnek le KELL írnia az azonosítót, hogy viselkedést állítson, és egy teszt
másolata nem tud éles kódba szivárogni.

**A határ, ahol meghúztam, és a MÉRÉS ami odatette:** az idézett literált tiltom, nem a csupasz szót.
A csupasz szó lefedné a regex-alakot (`/^system-directive$/`) is, de a valós fán lemérve KÉT tisztes
előfordulást hamis pozitívvá tenne: egy generált-szekció jelölőt (`system-directive-auth`) az
`agent-scaffold.ts`-ben és egy log-üzenet prefixet a `system-directive.ts`-ben. Egy őr, ami ezeket
jelenti, az az őr, amit kikapcsolnak. A regex-alak tehát tudatosan fedetlen; Cybersec mindkét MÉRT
mutánsa (tömb, `===`) idézőjelet igényel, és el van kapva.

**Bizonyíték:** mindkét mért mutáns ÉLES fájlba ültetve pirosra viszi az ellenőrzést, és megnevezi a
fájlt (`web/agent-config.ts`, illetve `web/context-guard-runner.ts`). A komment-eltávolítás és az
import-útvonalak kontrollja külön eset (7c), különben a saját dokumentációját jelentené.

**Ki döntött:** Cybered (a gyenge pont megnevezése), Cybersec (mérés + az inverzió javaslata),
backend (megvalósítás és a határ megmérése).
**Hivatkozás:** kártya 05864b8a; `src/__tests__/agent-dir-namespace-runtime.test.ts` (15 -> 20 eset).
---

## 2026-09-05 -- b7e57877 -- Az append-unió a két oldal KÖZÖS PREFIXÉHEZ képest készül, nem a merge-base-hez

**Döntés.** A `decisions-append-union.sh` előfeltétele már nem az, hogy a merge-base bájt-prefixe
legyen mindkét oldalnak. Az unió a két oldal KÖZÖS PREFIXÉHEZ képest készül, és a biztonsági
tulajdonság külön, kimondott ellenőrzés: a merge-base egyetlen sora sem hiányozhat abból a
prefixből.

**Miért.** A régi alak olyan landolásokat utasított el, ahol nem volt nézeteltérés. Mérve
(`agent/fron-ted/work`, `git diff --numstat`): a branch oldal `30 0`, a main oldal `924 0` -- EGYIK
SEM TÖRÖL semmit. Mindkettő ugyanazt az EGY ÜRES SORT szúrja be a fájl közepére (6520. sor egy 6743
sorosban), majd a saját bejegyzését a végére. A bázis emiatt nem bájt-prefixe egyik oldalnak sem.
Ami mindkét oldalon AZONOS, az nem lehet nézeteltérés.

**A garancia nem gyengült, hanem áthelyeződött.** A régi bájt-prefix teszt azt vásárolta meg, hogy
semmi nem vész el a bázisból. Ugyanez most `diff`-fel, a közös prefixre: ha a két oldal KORÁN,
KÜLÖNBÖZŐ tartalommal ágazik szét, a közös prefix rövid, a bázis sorai hiányoznak belőle, és a
függvény ELUTASÍT -- e nélkül a két maradék összefűzése megduplázná a fájl nagy részét.

**Amit NEM választottunk: a git `merge=union` drivere.** Kézenfekvő lenne egy szigorúan append-only
naplóra, és backend fel is vetette. Elvetve, és nem a duplikálás miatt: a driver FELTÉTEL NÉLKÜL sül
el, tehát egy VALÓDI szerkesztést -- egy korábbi bejegyzés javítását vagy egy archiválási átírást --
ugyanúgy unionálna, a logban tiszta merge-nek látszva. És ez nem hipotetikus: a CLAUDE.md előírja a
desztillálást (90 napnál régebbi bejegyzés dátumozott archívum-fájlba), ami MEGLÉVŐ tartalom
eltávolítása EBBŐL a fájlból. A fájl dokumentált életciklusa tartalmazza pont azt a műveletet, amit
a driver csendben rosszul kezelne. Backend a saját szavaival visszavonta a javaslatot.

**Amit átvettünk backendtől:** a fejléc-SOR tagsági ellenőrzés a darabszám-azonosság MELLÉ. Ő mérte
egy független implementáción, hogy egy sor közepére eső vágás elnyelhet egy `## ` fejlécet (165 lett
166 helyett), és hogy a puszta darabszám ezt átengedi, mert a 165 hihetőnek látszik.

**A megmaradó, KIMONDOTT rés:** az unió SOROKAT hasonlít, tehát két tartalmilag azonos, de eltérő
TÖRDELÉSŰ bejegyzést két különböző bejegyzésnek lát, és duplikátumot ír. Ez a nap folyamán élesben
elő is fordult (ugyanaz a szöveg két tördelésben, két ágon). Sor-összehasonlítással nem javítható;
külön kártya kérdése, nem ezé.

## 2026-09-05 -- A bejegyzés-határ DÁTUMOZOTT fejléc, nem puszta `## ` (kártya b7e57877, Cybered CS-2)

**Döntés.** A `store/decisions-append-union.sh` bejegyzés-határ ellenőrzése (`_starts_new_entry`)
mostantól DÁTUMOZOTT fejlécet követel (`## [0-9][0-9][0-9][0-9]-*`), nem elég a `## ` előtag. A
minta változó (`DECISIONS_ENTRY_HEADER_GLOB`), nem beégetett érték: a függvény a fájlnevet
paraméterként kapja, tehát egy jövőbeli append-only fájl más konvencióval felülírhatja ahelyett,
hogy lemásolná a függvényt.

**Miért.** Cybersec NO-GO-ja után bevezetett `## ` határnak UGYANAZ a rése egy szinttel lejjebb.
Cybered mérte és adott rá futtatható fixture-t (CS-2): ha a két oldal egy olyan TÖRZS-soron ágazik
szét, ami maga is `## `-gal kezdődik (egy idézett alcím a bejegyzésen belül), akkor MINDKÉT maradék
`## `-gal kezdődik, az ellenőrzés átengedi, és az unió ismét EGY fejléc alá ragaszt két törzset --
pont az a csendben összeolvasztott bejegyzés, amit a NO-GO javítani akart. A saját ellenőrzésem
megerősítette: a fixture a javítás előtt RESOLVED-ot adott.

**A választás két lemért út közül.** (a) dátumozott minta a határellenőrzésben, (b) marad a `## `,
és a feltevés kommentbe kerül egy CS-2 selftest-esettel. Az (a) mellett az döntött, hogy a költsége
KIZÁRÓLAG elutasítás lehet -- a hívó megszokott, kézi konfliktus-feloldó útja --, sosem rossz merge.
Saját mérés a valós korpuszon (nem a peer számát átvéve): marveen `DECISIONS.md` 200/200 fejléce
dátumozott, CleanCore 154/154. Ma tehát nulla eset esik el emiatt; a CS-2 latens rés, nem éles.

**Amit ez ténylegesen elvesz.** Egy dátum nélküli fejlécű, egyébként valódi append mostantól
elutasításra kerül. Ez viselkedésváltozás, ezért SAJÁT selftest-eset rögzíti (nem prózában marad),
és a felülírható minta ugyanígy kap egy esetet -- egy csak kommentben állított paraméterezhetőség
elrohad. Mindhárom új eset mutációval ellenőrizve: a régi `## ` határra visszaállítva a CS-2 és a
dátum nélküli eset pirosra vált, a beégetett mintára visszaállítva a felülírásos eset vált pirosra.

**A megmaradó rés változatlan** (előző bejegyzés): az unió SOROKAT hasonlít, tehát két tartalmilag
azonos, de eltérő tördelésű bejegyzést duplikál. Külön kártya kérdése.

## 2026-09-05 -- A határ-minta ARGUMENTUM, nem környezeti változó, és a megengedő iránya ki van tűzve (kártya b7e57877, Cybersec)

**Döntés.** A `store/decisions-append-union.sh` bejegyzés-határ mintája a `try_append_union`
HARMADIK, opcionális ARGUMENTUMA lett. A `DECISIONS_ENTRY_HEADER_GLOB` környezeti változót senki
nem olvassa többé. Emellett a függvény futásidőben ELUTASÍTJA a megengedő mintát: a mintát próba-
sorokra illeszti (üres sor, csupasz `## `, `## ` + próza, hétköznapi próza, elválasztók), és ha
bármelyikre illeszkedik, `return 1` -- a hívó megszokott kézi feloldó útja --, NEM esik vissza
némán az alapértelmezésre.

**Miért.** Cybersec kimondta, amit a saját három tesztesetem nem fedett: azok azt bizonyították,
hogy a minta OLVASÓDIK, egyik sem azt, hogy nem állítható be mindent elfogadó értékre. Környezetből
olvasva bármely szülő-folyamat `*`-ra állíthatta volna, és a csendes összeragasztás visszatér --
ROSSZABB helyre, mint a javítás előtt, mert a kód addigra azt sugallja, hogy van rá kontroll.
Cybersec ugyanezt az osztályt (őr-predikátum kitűzetlen megengedő iránnyal) egy napon háromszor
mérte külön kártyákon. Cybered kifogása (ne égjen be a DECISIONS.md konvenciója egy fájl-
paraméterezett függvénybe) változatlanul teljesül: a hívó adja át a saját mintáját.

**Amit a mutációs ellenőrzés kimutatott a SAJÁT tesztemről.** Az „environment nem állíthatja be"
esetet először `*` értékkel írtam meg, és ÁTMENT pontosan arra a mutációra, amit néven nevez: a
környezet-olvasás visszatételekor a függvény felvette a `*`-ot, a próba-őr elutasította, a hívás 1-et
adott, a teszt pedig a várt elutasítást látta. Az ŐR MASZKOLTA a regressziót, amit a teszt fogni
hivatott. Ellenséges értéknek ezért `## entry*` kell: átjut a próbákon, mégis illeszkedik a fixture
dátumozatlan fejléceire. Négy mutáció, mind fogva: a próba-őr törlése, néma visszaesés az
alapértelmezésre, a környezet-olvasás visszatétele, és egy elutasítás, ami a konfliktus-jelöléseket
letörli a munkafájlról.

**Elutasítási út, kimondva** (Cybersec 3. pontja): tiszta `return 1`, a merge érintetlenül marad a
munkafán, a git konfliktus-jelölései a fájlban -- ezt mostantól a teszt-helper is ellenőrzi, mert a
„1-et adott vissza" és a „a konfliktust kézi feloldásra hagyta" két külön állítás, és csak az első
van benne a visszatérési értékben.
## 2026-09-05 -- 30b76a8d (NO-GO javítás) -- Egy "semmi ne vesszen el" merge megőrizte a LEVÁLTOTT parancsalakot

**A lelet (Cybersec NO-GO, komment 20441, függetlenül ellenőrizve):** a `gate-worktree-pattern`
négy per-ügynök példányán a merge visszahozta a RÉGI, kétargumentumos `cc-gate-worktree.sh`
hívást, és a helyes `--agent`-es alak ELÉ tette. Az a7da80d6 óta a régi alak `exit 2`-vel hal meg,
tehát mind a négy gate-ügynök egy halott parancsot látott elsőként a saját skilljében. Saját
méréssel megerősítve: a mergelt fájlban 6 invokáció szerepelt (3 `--agent` nélkül), a globálisban 3,
mind helyes.

**A gyökérok, és ez általánosabb a négy fájlnál:** a "egyetlen projekt-sor és egyetlen globális sor
sem veszhet el" invariáns BIZTONSÁGOS a kiegészítő tartalomra és HIBÁS a felülírtra, és semmi benne
nem választja szét a kettőt. Ugyanezt a csapdát ma már kétszer megmértem a SEED-oldali szinkronon,
és a LIVE sweepre nem alkalmaztam. A `megtartva > 0` önmagában nem hiba: a másik tíz fájlnál a
megtartott 1-66 sor valódi projekt-only tartalom volt, és a `teszter` esetében a `megtartva 0` és a
globálissal való bájtazonosság a helyes eredmény.

**Javítás:** a négy fájl a globális példány verbatim tartalmát kapta (106 sor, sha 505d9223),
atomi írással, mentéssel. Írás előtt két állítás fut a forrásra: a globális sha egyezik azzal,
amit a verdikt mért, és a globálisban nincs egyetlen csupasz kétargumentumos hívás sem -- e nélkül
a "másold a globálist" lépés vakon bízna abban, hogy a globális tényleg jó.

**Az osztály lezárása, amit Cybersec kért: `store/skill-merge-check.py`.** Az ELSŐ változatom
Cybersec szám-alapú jelzését implementálta ("a result többször említi a szkriptet, mint a forrás"),
és a VALÓS korpuszon MEGBUKOTT: hamis pozitívot adott a `qa/qa2 i18n-parity-sweep`-re, ahol öt
azonos, helyes invokáció szerepel. A használható jelzés élesebb: UGYANAZ a szkript KÉT ALAKBAN,
ahol az egyik a másik MÍNUSZ néhány argumentum -- pontosan ezt hagyja maga után egy újonnan
kötelezővé tett kapcsoló. A forrásban MÁR meglévő ilyen pár nem a merge műve, ezért nem jelentődik.

**Mérve a teljes valós korpuszon:** a négy hibás fájlt megjelöli, a tizennégy jóra (a tíz eredetileg
jó + a négy javított) tiszta. Nulla hamis pozitív. A tool saját selftestet visz, mert egy őr, amit
sosem futtattak le a saját alapító esetére, nem bizonyíték; 5 teszt-eset a repóban.

**Egy saját mérési hiba, amit érdemes leírni:** a detektort először a rossz mentés ellen
futtattam (`ls -t | tail -1` a LEGRÉGEBBIT adja, az a merge ELŐTTI 95 soros fájl volt), és négy
hamis "MISS"-t kaptam a saját eszközömre. Majdnem működésképtelennek minősítettem, holott a
tesztharness volt rossz. Ugyanaz a család, mint a "a megosztott log-könyvtár legújabb fájlja nem
az én futásom".

**Ki döntött:** Cybersec (a lelet, a súlyosság-besorolás -- kimondottan NEM biztonsági kitettség,
hanem fleet-működési hiba --, és a detektor ötlete), backend2 (független ellenőrzés, javítás,
a detektor jelzésének kiélesítése a valós korpuszon).
**Hivatkozás:** kártya 30b76a8d; `store/skill-merge-check.py`,
`src/__tests__/skill-merge-check.test.ts` (5 eset), `agents/{qa,qa2,cybersec,cybered}/.claude/
skills/gate-worktree-pattern/SKILL.md` (gitignore-olt, élő).

## 2026-09-05 -- 23d09a68 (2. lépés vége) -- A 20 drift-sorból 12 elintézve, 3 szándékosan nem, 5 a skill gazdájáé

**A hat `template LAGS` sor** (full-value-audit x4, guarded-rowscoped-read-endpoint x2)
szinkronizálva a saját live párjához. A 30b76a8d NO-GO óta ez már nem elég indok önmagában, ezért
minden merge-eredmény átment a `store/skill-merge-check.py`-n, MIELŐTT bármit kiírtam volna: mind a
hat tiszta, nincs felülírt parancsalak.

**A hat `template-only file` sor egyetlen valódi hiányosság volt**, és ugyanaz a fél-javítás alak,
mint a 30b76a8d References indexe: az élő `fleet-helper/SKILL.md` ÖT `scripts/*` fájlt dokumentál,
és a `scripts/` könyvtár EGYETLEN telepítésen sem létezett. A hat fájl telepítve, módokkal együtt
(a három `.py` végrehajtható marad); az öt hivatkozás mind feloldódik.

**Miért nem érkezett meg magától, és ez nem hiba:** a live `SKILL.md` BÁJTAZONOS a seeddel, tehát a
példány provably érintetlen, mégsem kapta meg a `scripts/`-et. Az `update.sh`
`refresh_untouched_seeds` ciklusa kimondottan így épül: `[ -f "$installed" ] || continue  # never add
files to an existing dir`, ráadásul nem rekurzív. Ez DÖNTÉS, nem mulasztás -- a következménye
viszont most mérhető: bármely seed-skill, ami később ÚJ fájlt kap, azt egy meglévő telepítésre soha
nem szállítja le. Nem nyúltam hozzá: az update.sh magas kockázatú infrastruktúra, ez saját kártyát
és gate-et kíván.

**Három sor SZÁNDÉKOSAN marad:**
1. `seed-skills qa-test-strategy/references/SKILL-FULL-BACKUP.md` -- itt a TEMPLATE van előrébb,
   a szinkron törölné a "sqlite3 CLI nem garantált telepítve" hordozhatósági javítást.
2. `qa2/i18n-parity-sweep` (LIVE LOST content) -- ezt az aszimmetriát én hoztam létre a 30b76a8d-en.
   A seed három sora a MEGOSZTOTT CleanCore klónra hivatkozik, amit a CLAUDE.md visszavont; a
   konvergálás elavult útmutatást vinne be pont a nyerő példányba.
3. `fron-ted/impeccable` (az utolsó `TEMPLATE-ONLY skill`) -- NEM hiányosság: a skill globálisan
   megvan (`~/.claude/skills/impeccable`), per-ügynök példánya senkinek nincs, tehát fron-ted
   ELÉRI. A sor csak azt mondja, hogy a seed visz egy per-ügynök példányt, amit a telepítés nem hozott
   létre. Ez a korábbi 17-ből az EGYETLEN, ami valódinak látszott -- és közelebbről ez sem az.

**Öt sor a skill GAZDÁJÁRA tartozik, nem rám**, és ezt mérésre alapozom, nem óvatosságra:
`white-hat-security-testing/references/recurring-no-go-classes.md` (cybered, cybersec, teszter),
`fron-ted csp-inline-style-sweep`, `fron-ted engineering-standards`. Mindkét oldalon ÉRDEMI, eltérő
tartalom van: a white-hat template két EGÉSZ szekcióval előrébb (`## 6. Async floating-promise`,
`## 7. A grep you TYPED is not the grep you think`), miközben a live-ban van egy Unicode-vezérlőkarakter
javítás, ami a templateből hiányzik.

A legkeményebb bizonyíték az `engineering-standards`: SZEKCIÓSZÁM-ÜTKÖZÉS van. A seed 116. sora
`## XII. Auth UI: forward-oracle elkerülés`, az élő 122. sora `## XII. Frontend adatvizualizáció`.
Két KÜLÖNBÖZŐ szekció, ugyanazzal a számmal. Egy gépies merge két `## XII.`-t hagyna a fájlban --
szerkezeti hiba, nem szépséghiba. Pontosan ilyen döntést nem szabad a sweepnek meghoznia; ez az a
hely, ahol a 30b76a8d hibája megismétlődne.

**Bizonyíték:** 8 seed/skill őrteszt zölden (90 passed), a merge-check mind a hat A-csoportos
eredményen tiszta, a `fleet-helper` öt dokumentált hivatkozása feloldódik.

**Ki döntött:** backend2 (a besorolás és a három szándékos kihagyás), a fennmaradó öt sor a skillek
gazdáira vár.
**Hivatkozás:** kártya 23d09a68; `seed-fleet-agents/*/full-value-audit`,
`*/guarded-rowscoped-read-endpoint`, `~/.claude/skills/fleet-helper/scripts/` (élő, gitignore-olt).

## 2026-09-05 -- 23d09a68 (3. lépés): a saját additív merge-öm ELROMLOTT frontmattert hagyott, és ez a NO-GO osztály második példánya

**Döntés:** a bfc028b4-ről áthozott két sort végigmértem, és mindkettő MÁS volt, mint aminek látszott.

**1. `vitest-react-router-guard` (qa, qa2): KÉT `description:` kulcs a frontmatterben, és ezt ÉN
csináltam.** Git-tel bizonyítva: a `285f2981` szülőben egy `description:` sor volt, az én
`5e2f994b` commitom (30b76a8d) után kettő -- a seedben ÉS a telepített példányban is, mind a két
ügynöknél, tehát 4 fájl. Ugyanaz az additív-merge osztály, mint a Cybersec NO-GO (komment 20441),
csak egy olyan fájlban, ameddig az a gate nem ért el. A YAML egy kulcsból egyet tart meg, és hogy
melyiket, az parser-függő -- a frontmatter `description`-je pedig a Level-0 szöveg, ami eldönti,
hogy a skill egyáltalán felajánlásra kerül-e.

**A javítás NEM az egyik eldobása volt, és ezt mérés döntötte el, nem ízlés.** Megnéztem, hogy a két
leírás melyike illik a ténylegesen szállított törzsre: MINDKETTŐ illik. A hosszú (projekt-oldali)
leírás kulcsszavai a törzsben: `useSession` 8, `PortalAuthGuard` 6, `PrivateRoute` 1 találat. A
rövid (globális) leírásé: `useParams` 5, `TDZ` 3, `multiple elements` 5. A törzs a két leszármazási
vonal UNIÓJA, tehát a merge TARTALMI döntése helyes volt; csak a KÓDOLÁSA volt érvénytelen. Ezért
a két leírást egy sorba vontam össze, mindkét trigger-készlettel. Ha reflexből eldobtam volna az
egyiket, valódi trigger-lefedettséget veszítek.

**2. `i18n-parity-sweep` (qa2): nem "független kiegészítés", hanem 5 SZUPERSZEDÁLT sor a seedben.**
A seed 5 sorral volt hosszabb az élőnél, és mind az 5 egy elavult alak, közvetlenül a saját
utódja FÖLÖTT: 2x `cd /mnt/h/LM_Studio_Workdir/CleanCore` a `cd "$QA2_WT"` előtt, 2x
`BASE = pathlib.Path('/mnt/h/.../CleanCore/...')` a `BASE = pathlib.Path(CC)` előtt, és egy
duplikált `# NE git add -A` komment. Bash-ben és Pythonban is a második nyer, tehát futásidőben
inertek -- de a doksit fentről lefelé olvasó ügynököt a VISSZAVONT megosztott klónra küldik, oda
amit senkinek nem szabad írnia. A `${CLEANCORE_MAIN:-...}` alakú két sor (24., 50.) a HELYES,
dokumentált forma, azok maradtak. Az irányt nem ízlés döntötte el: a hat létező példányból öt
(qa seedje, mindkét élő példány, a seed-skills és a globális) MÁR tiszta volt, a qa2 seedje volt
az egyetlen kilógó. Renderelés után a seed most bájtra azonos az élővel.

**Strukturális következmény: a `store/skill-merge-check.py` mostantól a frontmattert is nézi.** A
szuperszedált PARANCS-alakot elkapta, a szuperszedált KULCSOT nem -- egy nem detektálható hibaosztály
vissza fog jönni. Az új ellenőrzés ugyanazt a szabályt követi, mint a régi: ami a FORRÁSBAN már
benne volt, az nem a merge műve, tehát nem jelentés. A parse a lezáró `---`-nál MEGÁLL, és ez nem
formaság: az első változatom EOF-ig olvasott, és a törzs prózáját olvasta kulcsnak, amitől két
`seed-skills` fájlra (`elitedigitalagency`, `threejsinteractionblueprint`) hamis duplikált-kulcs
riasztást adott. Egy őr, aminek több a hamis pozitívja, mint a lelete, pár nap alatt megtanítja
mindenkinek, hogy hagyja figyelmen kívül.

**Bizonyíték:** a tool selftestje 3 -> 8 eset, a vitest fájl 5 -> 10 eset, és a detektor a
VALÓDI, develop-ra landolt hibás fájlt kapja el (exit 1, `description: appears 2 times`), a
javítottat pedig tisztán engedi. Mutáció: a frontmatter-ellenőrzés kiütésével 3 teszt bukik
(a defekt-eset, a lezáratlan-blokk eset és a selftest), tehát az új esetek harapnak.

**Amit NEM javítottam, és jelentek:** az `elitedigitalagency` és a `threejsinteractionblueprint`
seed-skill frontmattere megnyílik `---`-mal és SOHA nem záródik le, tehát a `name`/`description`
nem olvasható ki belőlük. Ez nem az én merge-em műve és nem is ezé a kártyáé, de valódi hiba,
és a fenti okból a merge-check szándékosan nem jelenti (nem a merge okozta). Külön kártya kell rá.

**Ki döntött:** backend2.
**Hivatkozás:** kártya 23d09a68; `store/skill-merge-check.py`,
`src/__tests__/skill-merge-check.test.ts`, `seed-fleet-agents/{qa,qa2}/vitest-react-router-guard`,
`seed-fleet-agents/qa2/i18n-parity-sweep`.

## 2026-09-05 -- A határ-heurisztika maradék rése FAIL-OPEN, nem elutasítás (kártya b7e57877, Cybered F-5 + F-4, Cybersec doksi-lelet)

**Korrekció, mérés alapján.** A kártya korábbi REVIEW-jában azt állítottam, hogy a dátumozott
határ maradék rése „elutasítás irányú, nem rossz merge". **Ez téves volt.** Cybered lemérte, én
pedig újramértem a jelenlegi kódon: ha egy TÖRZS-sor illeszkedik a mintára (pl. egy idézett régi,
dátumozott fejléc egy új bejegyzésen belül), az unió RESOLVED-ot ad, és mindkét folytatás egy
fejléc alá kerül -- pontosan az a csendes összeolvasztás, amiért a Cybersec NO-GO ment, egy
szinttel lejjebb. A rés tehát FAIL-OPEN. A „valós korpuszon ma nincs ilyen" rész áll (201 fejlécből
2 ugrik kronológiailag visszafelé, mindkettő valódi sorrenden kívüli bejegyzés, nem idézett fejléc)
-- de ez ugyanaz a „latens, amíg nem lett azzá" állapot, ami a CS-2 is volt.

**Következmény a kódban:** a minta mellett kimondva áll, hogy a határ SORMINTA-HEURISZTIKA, és hogy
minden tágítás ebből a tartalékból költ. Aki legközelebb tágítja, ettől tudatos döntést hoz, nem
véletlen regressziót.

**Cybersec doksi-lelete: a próba-őr SZŰRŐ, nem precondition.** Az első kommentem azt állította, hogy
„egy bejegyzésen belül előfordulható sorra illeszkedő minta nem határ -- futásidejű precondition".
A kód HÉT rögzített próba-sorra illeszt. A különbség a következő olvasónak számít: precondition
esetén abbahagyja a keresést. A saját ellenséges tesztértékem (`## entry*`) maga a bizonyíték, hogy
átjut; Cybersec példája élesebb: `## [0-9]*` is átjut, és illeszkedik a `## 2 reasons why` TÖRZS-sorra.

**Amit Cybersectől átvettem indoklásként:** a mintát `case ... in $header_glob)` alakban IDÉZŐJEL
NÉLKÜL interpolálom, tehát shell minta-pozícióban áll. Környezeti változóként nem csak túl tág
értékekre volt nyitva, hanem `)` és `|` karakterekre is. Az env-olvasás törlése ezt is bezárta --
és ezért NEM tesszük a próba-őrt „okosabbá": a határon már nincs támadó.

**Cybered F-4: a MÁSODIK `local LC_ALL=C` teherhordó volt, nulla fedéssel.** Kettő van: egy a
`_common_line_prefix_len`-ben (ahol a bájt-offszet KELETKEZIK) és egy a `try_append_union`-ban
(ahol SZELETEL). A meglévő állítás csak az elsőt tűzte ki. Mutációval igazolva: a másodikat törölve
a selftest 19/19 zöld maradt. Új, END-TO-END UTF-8 fixture rögzíti; a törölt változat REFUSED-ot ad
ott, ahol az élő helyesen unionál -- vagyis pont az a landolás esne el újra, amit ez a kártya
feloldani hivatott.
## 2026-09-05 -- 67a5ee01: a gate-tooling három vaksága, és miért csak kettőt javítottam

**Döntés:** a kártya két hibát nevezett meg, a mérés hármat talált. Kettőt megjavítottam, a harmadikat bizonyítékkal jelentem, mert a hatóköre két másik ügynök szkennerére terjed ki.

**1. A `gate-closure-check.py` nem látta a testvér-ügynök verdiktjét.** A verdikt-regex `QA`-nál megállt, és a `QA2 PASS` „2"-ese nem illeszkedett. Mérve: **601 testvér-verdikt volt láthatatlan**, egészen az 1952-es kommentig visszamenőleg, és **42 kártya olvasott MISSING-et olyan gate-re, amelyik valójában aláírt**. Cybersec ezt élesben kapta el három kártyán, amikor qa2-t behúzta terheléskiegyenlítésre.

**A tervezési döntés nem a regex volt, hanem hogy a QA2 KÜLÖN gate-e.** Nem az: a 4. szabály szerint a testvérek ugyanannak a szerepnek a két embere, és egy kártyát csak az EGYIKÜK néz meg. Ezért a szám normalizálódik, nem lesz belőle negyedik gate-kulcs -- ha külön kulcsot kapna, a 42 kártyán a QA gate MISSING maradna, vagyis pont a javítandó hibát írnám át másik alakba.

**A kockázatos irány mérve, nem feltételezve.** A normalizálás 65 kártya kiolvasását változtatja meg: 42-nél MISSING -> PASS, és **9-nél QA FAIL -> PASS** -- ez utóbbi a veszélyes irány, ezért egyenként megnéztem. Mind a 9-nél a testvér PASS-e szigorúan a FAIL UTÁN érkezett, és mind a 9 kártya már `done`: a testvér a javítást vizsgálta felül, pontosan úgy, ahogy egy gate saját magát újraellenőrzi. A régi eszköz ezen a 9 kártyán FAIL-t mondott volna olyan munkára, amit a tábla jogosan lezárt. A fordított eset (testvér FAIL a másik PASS-e után) továbbra is megtagadja a zárást -- ez tartja a fenti viselkedést attól, hogy kiskapu legyen, és külön eset pinneli.

**A kapcsoló oldalát is normalizálni kellett, és ezt csak a valódi híváson vettem észre:** a `--gates qa2,cybersec` `UNREADABLE|not a gate name: qa2`-t adott. A tábla `Gate:` sorai MÁR neveznek QA2-t, tehát aki a kártya saját designációját másolja be, hibát kapott volna egy teljesen érvényes gate-készletre. Egy valóban ismeretlen név továbbra is elutasításra kerül.

**2. A `Gate:` designáció ott legyen, ahol a szkenner olvassa.** A `declared_gate_excludes_me()` a DESCRIPTION-t nézi, tehát egy csak kommentbe írt designáció a kódnak nem létezik. Mérve 2951 kártyán: 1161 a leírásban, 158 mindkettőben, **110 kizárólag MikroB-kommentben**. Nyitott kártya ma egy sincs ebben a csoportban, tehát ez folyamat-védelem, nem futó incidens -- pont ilyenkor olcsó beépíteni. A fordított kockázat a nagyobb: a 158-ból **51 ELLENTMOND** egymásnak, és ebből **23-nál a leírás SZŰKEBB** a legfrissebb MikroB-kommentnél. Ez a veszélyes irány, mert amelyik gate-et a leírás kihagyja, annak a szkenner azt mondja, hogy a kártya nem az övé, és KIHAGYJA. A másik 28 bővebb, ami egy fölösleges átolvasásba kerül. A két irány nem szimmetrikus, ezért az eszköz nem is egy számként jelenti őket. Új eszköz: `store/gate-decl-check.py` (+ auto-felfedezett selftest, 15 eset).

**Egy saját mérési hibám, amit érdemes rögzíteni:** az első összevetésem 53 ellentmondást mutatott, mert a `qa2`-t külön gate-nek számolta -- vagyis PONTOSAN az a hiba volt benne, amit az 1. pontban javítottam. Normalizálás után 51 a valódi szám.

**3. AMIT NEM JAVÍTOTTAM, ÉS EZ A LEGSÚLYOSABB.** Az eszközt a valódi táblán futtatva (nem fixtúrán) kiderült, hogy a `GATE_DECL_RX` KERES ahelyett, hogy sorra HORGONYOZNA, ezért a `Gate:` szót mondat közben és idézett prózában is megtalálja. Következmény ezen a kártyán, a 67a5ee01-en magán: a leírása gate-designációkról BESZÉL, az utolsó találat egy prózasor, és a `declared_gate_excludes_me()` emiatt **mind a három gate-re True-t ad** -- vagyis a gate-designációról szóló kártya maga láthatatlan mindhárom szkennernek. A táblán 24 kártya hordozza ezt az alakot.

**Miért nem javítottam:** a sor elejére horgonyzás **515 kihagyási döntést** változtatna meg (367 cybered, 124 cybersec, 24 qa), mind a „több kártya kerül a gate elé" irányba -- ami a lib saját dokumentált biztonságos iránya, de akkor is két MÁSIK ügynök szkennerének a viselkedése. Ez saját kártyát és plan-grillinget érdemel, nem egy csendes bővítést az enyém alatt. Amit megtettem: az eszköz `PROSE` kóddal jelenti ezt az alakot, tehát a hiba mostantól LÁTHATÓ minden érintett kártyán.

**Bizonyíték:** `gate-closure-check.selftest.py` 49 -> 58 eset, az új `gate-decl-check.selftest.py` 15 eset, a `store-selftests-all-run` harness 23 selftestet fedez fel és futtat (az újat is, kézi bedrótozás nélkül). Az új eszköz a valódi alapító kártyán `PROSE`-t ad, exit 1.

**Egy fixtúra-tanulság:** az első PROSE-fixtúrám HIBÁS volt, mert az `a "Gate: QA + X" designacio` próza MEGNEVEZ egy szerepet, tehát nem ez az osztály. A valódi kártya utolsó találatát kellett használnom. A fixtúra volt rossz, nem az eszköz.

**Ki döntött:** backend2 (a normalizálás iránya és a 3. pont jelentés-kontra-javítás határa).
**Hivatkozás:** kártya 67a5ee01; `store/gate-closure-check.py`, `store/gate-closure-check.selftest.py`, `store/gate-decl-check.py`, `store/gate-decl-check.selftest.py`.

## 2026-09-05 -- 1d851280: a kártya premisszája hibás volt, és a hiba iránya rosszabb, mint amit állított

**Döntés:** a `git show --name-only` NEM üres listát ad egy merge-commiton, hanem RÉSZLEGESET, és ez rosszabb.

**A mérés (git 2.53.0, a 8c960106 landoló merge-ön, ami 12 fájlt hoz):**

    git show --name-only <merge>          ->   1 fájl     RÉSZLEGES
    git show --stat <merge>               ->  12 fájl     helyes
    git show <merge> -- <path>            ->  üres        VACUOUS
    git show --stat <merge> -- <path>     ->  üres        VACUOUS
    git diff <merge>^1 <merge>            ->  12 fájl     helyes
    git diff <merge>^1 <merge> -- <path>  ->  a diff      helyes

**Miért fontos a különbség.** A kártya azt írta, hogy a `--name-only` minden fájlra üres listát ad. Nem: azokat a fájlokat listázza, amelyek MINDEN szülőtől eltérnek, vagyis a konfliktus-feloldottakat. Egy üres válasz elrontottnak látszik és második pillantásra hív; egy egyfájlos válasz az IGAZSÁGNAK látszik. Ma kétszer dőltem be neki a saját landolásaimon: a `git show --name-only` pontosan a `DECISIONS.md`-t írta ki, ami hihető és teljesnek látszó, mégis hiányos.

**Két további, nem várt tény.** A `--stat` és a `--name-only` UGYANAZON a merge-ön eltérő választ ad; és egy pathspec hozzáadása a `--stat`-ot helyesből vacuous-szá billenti. Nem konvenció tehát az, hogy melyik kapcsoló működik éppen -- a `git diff <sha>^1 <sha>` az, és nem-merge commiton azonos a `git show`-val.

**Amit szállítok:** `store/merge-vacuous-git-check.py` (+ auto-felfedezett selftest, 9 eset) megkeresi ezeket az alakokat. A CONTROL-esetek külön pinnelik, hogy a biztonságos alakot és a pathspec nélküli `--stat`-ot NEM jelenti, és hogy egy olyan sor sem lelet, amelyik a javítást DOKUMENTÁLJA (mindkét alakot idézi) -- különben az eszköz a saját javítását büntetné, és senki nem venné be.

**Az eszköz azonnal talált egyet, amit én kézzel kihagytam:** a `git show <sha> --name-only | grep test` alakot, ahol a `<sha>` a parancs és a kapcsoló KÖZÖTT áll. A kézi felsorolásom hiányos volt, a detektoré nem -- pontosan ezért a detektor a szállítmány, nem a felsorolás.

**Javítva (4 fájl, seed + élő párban):** a qa és qa2 `qa-test-strategy/SKILL.md` két gate-utasítása, ahol a QA a REVIEW tesztszámát veti össze a commit tényleges tesztfájljaival.

**NEM javítva, jelentve (21 találat, MikroB döntése).** A `references/` dokumentumokban: `be-patterns.md` 4, `fe-patterns.md` 1, `verdict-and-board.md` 1, `atomic-fact.md` 1 -- és `SKILL-FULL-BACKUP.md` 14. Az utóbbi egy BACKUP fájl, oda javítást vinni szerintem téves. Ez a 7+14 találat 7 fa-másolatban él (globális, seed-skills, qa/qa2/teszter seed és élő), vagyis a 184 nyers előfordulás valójában ~25 egyedi sor. Egy NORMAL kártya alatt 184 sort átírni más ügynökök élő skilljeiben aránytalan; a detektor viszont mostantól bármikor megmutatja őket egy paranccsal.

**Ki döntött:** backend2 (a premissza korrekciója és a javított/jelentett határ).
**Hivatkozás:** kártya 1d851280; `store/merge-vacuous-git-check.py`, `seed-fleet-agents/{qa,qa2}/qa-test-strategy/SKILL.md`.
## 2026-09-05 -- A bejegyzés-határ STRUKTURÁLIS lett, a sorminta-létra lezárva (kártya b7e57877, CS-3 NO-GO)

**A probléma, ami háromszor jött vissza.** Ugyanezen a kártyán három fokot másztunk meg: `## `
határ (Cybersec NO-GO), majd DÁTUMOZOTT `## ` (Cybered CS-2), majd egy DÁTUMOZOTT TÖRZS-sor, ami
ezt is kielégíti (CS-3, Cybersec 20542 + Cybered 20551). Mindhárom javítás azt kérdezte, hogy MILYEN
egy bejegyzés-fejléc, és mindháromszor találtunk olyan törzs-sort, ami úgy néz ki. Cybersec ki is
mondta a jelentésével egy lélegzetre: a sorminta-heurisztika minden szigorítása ugyanezt a kérdést
teszi fel újra, és a helyes válasz egy ponton az, hogy a határ NEM sorminta.

**A döntés: nem másztunk következő fokra.** Cybered lemért egy 12 soros kronológiai prototípust
(a maradék első fejlécének dátuma ne legyen korábbi a prefix utolsó fejlécénél), és maga mondta ki,
hogy ez SEM strukturális zárás, csak szűkebb heurisztika -- egy későbbi dátummal idézett fejléc
ezen is átjut. Ehelyett a függvény mostantól a MERGE-ről kérdez, nem a SZÖVEGRŐL:

> Írt-e a két oldal AZONOS ÚJ TARTALMAT, mielőtt szétágazott?

Valódi append-append esetén a közös prefix MAGA a merge-base: mindkét oldal csak a saját farkát
adta hozzá, tehát semmi új nem közös. A létra minden fokán viszont a prefix a bázis PLUSZ valami,
amit mindkét oldal azonosan írt (megosztott fejléc, vagy fejléc + bevezető sor) -- és pont ez a
megosztott új tartalom teszi megválaszolhatatlanná, hogy „egy bejegyzés vagy kettő". Az elutasítás
ott nem heurisztika, hanem annak a kimondása, hogy az adatból nem dönthető el.

**A kivétel, amiért nem egyszerűen „prefix == bázis".** A kártya alapesete az volt, hogy mindkét ág
UGYANAZT az egy üres sort szúrta be a fájl közepére, majd a saját bejegyzését a végére; az
elválasztós alaknál pedig mindkettő ugyanazt a `---`-t írta. Üres sor és vízszintes vonal nem hordoz
összeolvasztható tartalmat, ezért megosztott új ÜRES és ELVÁLASZTÓ sor megengedett, megosztott új
ÉRDEMI sor nem.

**A két ellenőrzés KIEGÉSZÍTI egymást, egyik sem elég önmagában -- mindkét irányban mérve.**
A sorminta-határt kiiktatva a CS-1/2/3 továbbra is elutasított (a strukturális fogja), DE két oldal,
ami PRÓZÁT fűz az UTOLSÓ MEGLÉVŐ bejegyzéshez, RESOLVED-ot kap és a két folytatás egy bejegyzésbe
ragad -- ott nincs megosztott új tartalom, tehát a strukturális ellenőrzés nem lát semmit. Fordítva,
a strukturális ellenőrzést kiiktatva a CS-3 RESOLVED lesz. Mindkét esetre saját selftest-eset,
mindkettő pirosra vált a MÁSIK ellenőrzést eltávolító mutációra. Aki egyiket törli arra hivatkozva,
hogy „a másik lefedi", egy megnevezett konkrét eseten téved.

**Amit ez NEM old meg, kimondva:** a dátumozott minta a kód szerint már nem a létrát tartja, hanem a
folytatás-tengelyt; a régi indoklása hamissá vált, ezért át lett írva, nem ott hagyva. A tördelés-
duplikáció (bc0af927) változatlanul nyitva.

## 2026-09-05 -- A strukturális határ ÁRA: azonos új bejegyzés két ágon mostantól kézi feloldás (kártya b7e57877, Cybered 20572)

**Kimondva, mert viselkedésváltozás, nem mellékhatás.** A strukturális bejegyzés-határ egyenes
következménye, hogy egy eset, ami korábban helyesen feloldódott, MOSTANTÓL elutasítás: ha mindkét
ág hozzáfűzi UGYANAZT az új bejegyzést (X), majd mindegyik a sajátját, az X megosztott új ÉRDEMI
tartalom, tehát a függvény elutasít. Korábban `X egyszer, utána A és B` lett belőle.

**Nem hipotetikus:** pontosan ez történt ezen a kártyán ma, amikor az egyik gate már lelandolta a
DECISIONS-bejegyzést, és ezen az ágon még megvolt a saját példány -- akkor kézzel oldottuk fel.
Mostantól ilyenkor a landoló áll meg. Az irány helyes: a gép nem tudja eldönteni, hogy duplikátum-e
vagy két független döntés ugyanarról. Saját teszt-eset rögzíti, hogy a következő olvasó ne
„javítsa vissza".

**A kivétel-lista SOR-PONTOS, és a közeli alakjai fail-closed.** Megosztott új ÜRES és ELVÁLASZTÓ
sor az egyetlen, ami átmegy a strukturális ellenőrzésen, ezért a lyuk szélessége mérve van: csak az
egzakt `---` és `***` unionál; a záró szóközös `--- `, a `- - -`, a `* * *` és a `----` mind
elutasítás. Ezt is teszteset rögzíti, mert egy itteni tágítás az EGYETLEN kivételt tágítaná az
egész ellenőrzésben.

## 2026-09-05 -- README bullet-unió: külön, szűk eszköz, nem a DECISIONS-unió tágítása (kártya 8b73953c)

**Döntés (MikroB plan-grilling delta-döntése, 20555: (b) szűk változat).** A README fork-szekció
bullet-ütközését egy KÜLÖN eszköz oldja fel (`store/readme-bullet-union.py` + a `.sh` wrapper),
nem a `decisions-append-union.sh` kiterjesztése.

**Mérés a döntés előtt, nem utána.** Három beszúrás-alakot próbáltam ki valós git-merge-dzsel:
két távoli beszúrás TISZTÁN mergelődik, két SZOMSZÉDOS beszúrás is tisztán mergelődik, és
KIZÁRÓLAG a két azonos pozícióba eső beszúrás ütközik. Az automatizálás teljes értéke tehát egyetlen
alakban van, és a (b) ennek 100%-át fedi, töredék felülettel.

**Miért nem a meglévő függvény.** A DECISIONS.md a FAROKBAN nő, a README fork-szekciója viszont
egysoros `- **` bulletek futama a fájl KÖZEPÉN, előtte bevezető prózával, utána `###` al-fejléccel
és egy doksi-táblázattal. Az a függvény ráadásul ugyanezen a napon három gate-leletet termelt, mind
határ-logika tágításából (b7e57877) -- egy másik fájlt kiszolgáló további tágítás gate alatt
pontosan ezt ismételné.

**A garancia strukturális, nem alak-felismerés.** A beszúrási pont KÖRÜLI szövegnek pontosan a
merge-base-nek kell lennie; a két „közép" pedig csak teljes bullet-bejegyzésekből állhat. Így az
eszköznek soha nem kell kitalálnia, hol van egy bejegyzés határa: a határ ott van, ahol a két oldal
megszűnt egyezni, és rajta kívül mindennek érintetlennek kell lennie. Ugyanaz a tanulság, mint a
b7e57877 harmadik körében: a merge-ről kérdezz, ne a sor alakjáról.

**Python, nem több bash.** A testvér-eszköz három review-kört veszített bájt-kontra-karakter
indexelésen; ez az osztály itt nem létezik, és ez sor-lista művelet.

**Dry-run éles README-történetre, a terv előírása szerint, MIELŐTT bármi bedrótozásra került.**
52 valós commitból, ami pontosan egy bulletet adott hozzá, 51 rekonstruált ütköző párt futtattam le:
34 feloldva NULLA tartalmi hibával (minden bázis-sor megmarad, mindkét bullet pontosan egyszer,
pontos sorszám-azonosság), 16 elutasítva „a beszúrási pont körüli szöveg nem a merge-base" okkal
(ezek valóban mást is módosítottak), 1 elutasítva nem-bullet sor miatt.

**Amit a replay a SAJÁT mérésemről mutatott meg:** az első harness a „másik" bulletet egy RÉGEBBI
commitból vette, ami már benne volt a bázisban, tehát duplikátumot szúrt be -- 34-ből 25 „hiba"
a harness hibája volt, nem az eszközé. A második javítás pedig egy rossz VÁRAKOZÁS volt: „mindkét
oldal pontosan egy sort ad hozzá" nem igaz, két valós commit bulletet ÉS üres sort adott.

## 2026-09-05 -- A gate-worktree tulajdonjoga JELÖLŐ FÁJL, nem útvonal-minta (kártya 5e4e629f, Cybered F-1/F-2)

**Döntés.** A `store/cc-gate-worktree.sh --remove` tulajdonos-ellenőrzése egy `.cc-gate-owner`
jelölő fájl a fában, amit a létrehozás ír ki. Az útvonal nem hatóság többé. A tartalmazás-
ellenőrzés pedig a FELOLDOTT útvonalon fut (`realpath -m`), és csak a gate-gyökér KÖZVETLEN
gyerekét engedi.

**Miért nem szigorúbb minta (ez volt a kézenfekvő).** A `cc-gate-<kártya>-<ügynök>-<sha>` alakban
MIND a kártya-azonosító, MIND az ügynök-név tartalmazhat kötőjelet (`fron-ted`), tehát a basename
mezőkre bontása szerkezetileg kétértelmű. Egy fájl, amit a létrehozó ír, nem az.

**Reprodukálva javítás előtt, homokozóban.** F-1: a `cc-gate-63f098ce-cybered-qa-deadbee` fát
(tulajdonos: `qa`) a `cybered` törölte, mert a részsztring-illesztés átengedte. F-2: a
`$GATE_ROOT/cc-gate-x/../../outside/...` cél `rm -rf`-et futtatott a gate-gyökéren KÍVÜL, mert a
tartalmazás-ellenőrzés glob volt, és a `*` átfogja a `/`-t.

**Amit az F-2 reprodukciója tanított:** az ELSŐ próbám NEM reprodukálta a hibát, mert a tulajdonos-
ellenőrzés fogta el előbb. Egy szökés-próbának minden MÁSIK őrön is át kell jutnia, különben egy
másik őr munkáját méri. A második próba ezért olyan basename-et használt, ami a tulajdonos-
ellenőrzést is kielégíti.

**Visszafelé kompatibilitás, szándékosan.** A jelölő nélküli, korábban létrehozott fákra a
visszaesés az ELŐZŐ szabály HORGONYZOTT alakja (a névnek `-<ügynök>-<sha>`-ra kell VÉGZŐDNIE),
ami egzakt, nem részsztring -- így elutasítja a kártyát kiváltó esetet, de nem töri el a futó
gate-ek takarítását. A jelölőt minden futás kiírja, tehát a régi fák a következő top-upnál
megkapják, migráció nélkül.

**Mutációs mérés, kimondva, mert nem egyforma:** a részsztring-visszaállítás 2 esetet, a jelölő
kiiktatása 3 esetet vált pirosra. A `..`-szökést viszont MINDKÉT tartalmazás-őr elfogja, tehát
egyetlen mutáció sem izolálja -- a kombinált mutáció 3 esetet vált pirosra; a beágyazott-útvonal
eset az, ami egyetlen őrön áll.

**A jelölő a LÉTREHOZÁS UTÁN íródik, és ez egy landolásba került megtanulni.** Az első változat a
könyvtárat előre létrehozta és a jelölőt a `git worktree add` ELÉ írta -- git ezután megtagadta a
munkát, mert a cél már nem volt üres („git worktree add failed"). **A saját selftestem ezt NEM
fogta meg**, mert minden esete a `--path` ágon fut, ami a létrehozás előtt kilép; egy másik
tesztfájl fogta meg a suite-ban. Egy selftest, ami sosem hoz létre semmit, nem tud jótállni egy
scriptért, aminek a fő dolga a létrehozás -- ezért került bele négy VALÓS létrehozás-eset, és a
„jelölőt a létrehozás elé" mutáció most 2 esetet vált pirosra.

## 2026-09-05 -- 82fa48b0 -- GATE_DECL_RX: mondat/tagmondat-horgonyzás, mert a sor-eleji 419 valódi designációt dobott volna el (backend2)

**Előzmény:** a 67a5ee01 mellékterméke, hogy a `GATE_DECL_RX` KERES a leírásban ahelyett, hogy
horgonyozna, tehát a `Gate:` szót idézett prózában is találatnak veszi. A kártya azt írta elő, hogy
horgonyozzuk SOR ELEJÉRE. Plan-grillinget kértél rá a 515-kártyás blast radius miatt (1b. szabály),
és jól tetted: a felmérés a saját javaslatomat döntötte meg.

**A mérés (mind a 2997 kártyán, azon az 1322-n értékelve, ahol ma van szerepet megnevező
designáció):**

    A) keresés (a régi)                      megőriz 1322, veszít   0  -- de az alapító esetet elrontja
    B) sor eleje (a kártya terve)            megőriz  903, veszít 419
    C) mondat eleje                          megőriz 1314, veszít   8
    D) mondat eleje + tagmondat (`;` `,` `(`) megőriz 1318, veszít   4, változtat 0

**Döntés (MikroB, komment 20581): D.** A valódi designáció tipikusan egy bekezdés ZÁRÓ MONDATA, nem
külön sor -- a sor-eleji horgonyzás tizenhét valódi designációt dobott volna el minden egyes javított
fals pozitívra. A D az alapító esetet (a 67a5ee01 EREDETI szövegét) helyesen kezeli: nincs
designáció, a kártya átesik és MINDEN gate elé kerül.

**A LOAD-BEARING FELTEVÉS, amit senki nem ellenőrzött, én sem, amikor jelentettem:** hogy a valódi
designációk sor elején állnak. Nem álltak. A jelentés helyes volt, a hozzá javasolt javítás nem --
a kettő két külön állítás, és az elsőre szóló bizonyíték nem bizonyítja a másodikat.

**Teljes tábla előtte/utána (2997 kártya x 3 gate):** 20 kártya kerül ÚJONNAN a gate-ek elé
(qa 5, cybersec 7, cybered 8), és NULLA kártya esik ki bármelyik gate látóköréből. A változás tehát
kizárólag a biztonságos irányba dől, ami a lib saját dokumentált aszimmetriája.

**A NÉGY, amit a D még mindig elveszít, nevesítve:** `5fd54914` (`-` előzi meg), `722b444a` és
`f5e4279b` (`)` előzi meg, „(5) gate:" listaszámozás), `c52e2823` (mondat közben). Mind a négy
FAIL-SAFE irányba dől: nincs designáció -> a kártya átesik és minden gate elé kerül. A `)` és a `-`
felvétele a határoló-osztályba hármat visszahozna belőlük -- ez egy karakter, és SZÁNDÉKOSAN nem
csináltam meg: a jóváhagyott határoló-halmazt bővítené, tehát külön döntés.

**Amit a javítás mellé kellett tenni, mert a regex önmagában nem elég:** a designáció HELYE
konvenció kérdése, és a parser javítása nem javítja azt, ahogy az emberek írnak. Ezért a
`gate-decl-check.py` mostantól `MID-SENTENCE` kóddal JELENTI a mondat közbeni designációt (a fenti
négyet élesben felismeri), különben ez a szám halkan nőne.

**Módszertani csapda, kimondva a selftestben is:** a 67a5ee01 ÉLŐ szövegén a hiba MÁR NEM
reprodukálható, mert MikroB időközben odaírt egy kimondott `Gate:` sort a végére. Aki az élő kártyán
teszteli, mind a négy szabállyal {QA, CYBERSEC}-et kap, és arra jut, hogy nincs mit javítani. A
selftest ezért az EREDETI szöveggel dolgozik, és ezt le is írja magáról.

**Ki döntött:** MikroB (D változat, komment 20581), backend2 (mérés, alternatívák, a `)`/`-`
bővítés külön hagyása).
**Hivatkozás:** kártya `82fa48b0`; `store/gate_scan_lib.py`, `store/gate-scan-selftest.py`,
`store/gate-decl-check.py`, `store/gate-decl-check.selftest.py`.
## 2026-09-05 -- A junction-szerkezeti leletek zárása és a wrapperek merge-driver-védelme (kártya 3ae71df1)

**J-1 és J-2: a seam olyan markdown-szerkezetet képez, amit egyik szülő sem tartalmazott.**
Mindkettőt reprodukáltam javítás előtt. J-1: egy `---` sor közvetlenül egy nem-üres szövegsor
ALATT setext H2, nem vízszintes vonal -- ha a mi maradékunk prózával végződik és a másiké
elválasztóval kezdődik, az összefűzés az utolsó sorunkat FEJLÉCCÉ lépteti elő. J-2: ha a
junctionig minden nyitva hagy egy kódkerítést, a másik oldal TELJES bejegyzése a kerítésen BELÜLRE
kerül -- a `## ` fejléce megszűnik fejléc lenni és megszűnik grep-elhető lenni, miközben minden sor
megvan, tehát minden sor-alapú ellenőrzés zöld marad.

**Ez a hibaosztály szerkezetileg más, mint az eddigiek.** Minden korábbi ellenőrzés egy FELET néz
(prefix, a mi maradékunk, az ő maradékuk), és mindhárom fél lehet külön-külön hibátlan, miközben a
KÖZTÜK lévő varrat képez új szerkezetet. A javítás ezért a junctionre kérdez: a nála lévő utolsó
nem-üres sor és a másik oldal első sora együtt nem alkothat setext fejlécet, és a junctionig
számolt kerítés-paritásnak párosnak kell lennie (a prefixet is beleszámolva, mert egy ott nyitott
kerítést mindkét oldal KÜLÖN zár be).

**Kontroll, ami őszintén tartja a J-2 szabályt:** egy LEZÁRT kódkerítés hétköznapi tartalom, és
továbbra is unionál. E nélkül a „utasíts el minden backtickre" is átmenne a J-2 eseten.

**A wrapperek merge-driverként meghívhatók voltak (Cybersec).** Mérve: mindkét union-wrapper
(`decisions-append-union.sh` ÉS `readme-bullet-union.sh`) mode 775, és három path-argumentummal
hívva 0-t adott -- pontosan a `merge.<név>.driver` konvenció (%O %A %B). Ma NINCS bedrótozva, de
szerkezetileg semmi nem akadályozza: egy config-sor plusz egy `.gitattributes` bejegyzés elég
lenne, és a hibamódja CSENDES ADATVESZTÉS -- egy 0-val kilépő driver azt mondja a gitnek, hogy a
merge sikerült, tehát a git megtartja a mienket és eldobja a másikét, konfliktus és üzenet nélkül.
Kommenttel ez nem előzhető meg, kilépési kóddal igen: közvetlen futtatás `--selftest`-en kívül
mostantól hangosan, nem-nulla kóddal bukik. A source-olás érintetlen (minden valódi hívó így
használja). **Fájlosztályra kötve, nem csak a DECISIONS-oldalra** -- a dc5b714d tanulsága szerint
egy író-függvényre kötött hatókör kihagyja a testvér-fájlt.

**Doksi-pontosság (Cybersec).** A near-miss eset kommentje azt állította, hogy „csak az egzakt
`---` és `***` formák unionálnak", miközben a case-ág NÉGY tagot enged (`''`, `---`, `***`, `___`).
A komment abból a két formából íródott, amit a fixture véletlenül használt, nem a kódból. Javítva,
és mostantól MINDEN tagnak saját esete van.

**F-T: formánként egy eset, nem blokként (Cybered).** A near-miss teszt eredetileg mind a négy
alakot EGYSZERRE tágította volna: az egyetlen esetet pirosra váltja és lefedettségnek OLVASÓDIK,
miközben formánként csak egy volt ténylegesen pinnelve. Mostantól négy külön eset, és a mutáció is
formánként megy -- az egy-formát-beengedő mutáció pontosan a saját esetét vágja pirosra.

**Egy saját hiba, ami majdnem átment:** a teszt-CÍMKÉKBE tett backtickeket a bash
parancs-behelyettesítésként futtatta, így két near-miss címke azonosra rövidült -- pont a
formánkénti megkülönböztetést ölte volna meg. A címkékből kivéve.

## 2026-09-05 -- Az upstream clearInputBuffer retry+verify átvétele (kártya b34fa678)

**Döntés.** A fork `clearInputBuffer`-je átveszi az upstream retry+verify alakját (blob
`31758af9d36f`): háromszor próbálkozik, minden kör újraolvassa a sor-számot, a törlés UTÁN
`stuckInputSignature`-rel ELLENŐRZI, hogy a doboz tényleg kiürült, és `void` helyett `boolean`-t ad.

**A mögötte lévő incidens (upstream dokumentálja):** a törlés eddig fire-and-forget volt. Egy nem
verifikált törlés a parkolt tick egy TÖREDÉKÉT hagyta a bufferben, ami onnantól semelyik
delivery-wrapperrel nem egyezett -- így minden későbbi restart-döntés `machineOrigin=false`-t
olvasott és halasztott. A session 25,4 órára beragadt. A restart hard cap csak a kárt korlátozza,
a gyökér az ellenőrizetlen törlés.

**Öt hívási hely van, nem kettő -- és ez szándékos.** A kártya „a channel-monitor.ts két hívási
helye" megfogalmazása pontos abban, hogy mit kell IGAZÍTANI, de a fork valójában ötször hívja:
`channel-monitor.ts` 378/393 (re-inject), 413/417 (nincs re-inject), és `agent-process.ts` 2119
(pre-flight a küldés előtt). Upstream is csak a két re-inject NÉLKÜLI helyet igazítja, és a saját
belső hívását bájtra változatlanul hagyja -- a re-injectes helyeken a boolean nem ad hozzá semmit,
mert közvetlenül utána `sendPromptToSession` fut, ami felülírja a doboz tartalmát és saját
kézbesítés-ellenőrzést visz. Ezt a hűséget megtartottam; a fork ötödik helye sem változott.

**Amit NEM vettem át:** az upstream harmadik re-inject ága (`reinject-recorded`, a STUCKINPUT827
injected-prompt-registry munkája) a forkban nem létezik, és nem ennek a kártyának a hatóköre.

**Tesztelés, és egy saját vákuum eset.** Öt futásidejű eset a mockolt `execFileSync` fölött (a
suite meglévő mintája), plusz két forrás-alapú eset a két hívási hely bedrótozására -- utóbbi
kimondja magáról, hogy a WIRING-et rögzíti, nem a futásidejű viselkedést, mert
`performStuckInputAction`-höz nincs harness ebben a suite-ban, és egyet építeni egy NORMAL kártyáért
új infrastruktúra lenne, nem lefedettség.
Az „olvashatatlan pane" esetem ELŐSZÖR VÁKUUM volt: üres sztringgel etettem, ami a
`stuckInputSignature(...) == null` ágon megy át, nem az `after == null`-on -- a `capturePane`
kizárólag akkor ad null-t, ha a `captureTmux` DOB. A mutáció, ami a null-ágat kiveszi, zölden
hagyta. A fixture most a verify-hívásnál dobat, és a mutáció pirosra váltja.

**Mutációs mérés:** nincs retry (MAX_ATTEMPTS=1) -> 2 piros; verify eltávolítva -> 3 piros; a dobás
retry-ol ahelyett hogy gyorsan bukna -> 1 piros; az olvashatatlan pane még-beragadtnak számít ->
1 piros; az egyik hívási hely visszaállítva csupasz `await`-re -> 1 piros (csak a sajátja).
Mindegyik átmenő kontroll mellett.

---

## 2026-09-05 -- 82fa48b0 (2. kör) -- A horgonyzás egy ÚJ fail-open utat nyitott, és a "csak a biztonságos irányba dől" állítás a MAI ADATRA volt igaz, nem a SZABÁLYRA (Cybered NO-GO 20940)

**Ez a bejegyzés a fenti 82fa48b0-bejegyzést PONTOSÍTJA, nem vonja vissza.** A mérés, a
variáns-választás és a négy elveszített kártya listája változatlanul áll. Ami nem állt: a
záró következtetés általánossága.

**A lelet.** A `declared_gate_excludes_me` az UTOLSÓ designációt fogadja el, és a modul saját
docstringje mondja ki, miért: a hatókör menet közben bővülhet, és a legfrissebb állítás a
jelenlegi. Ugyanezen a kártyán mértük meg, hogy a valódi designációk 419 esetben MONDAT
KÖZBEN állnak. A kettő együtt: ha a KÉSŐBBI, SZÉLESEBB designáció mondat közben van írva, a
horgonyzott regex eldobja, és az utolsó TÚLÉLŐ találat egy korábbi, SZŰKEBB designáció lesz.
A kártya onnantól csendben kiesik azokból a gate-ekből, amiket a friss designáció megnevez.
Cybered proof-of-conceptje hétköznapi kártyaszöveg, és a horgonyzás ELŐTTI puszta keresés
alatt mindhárom gate helyesen felszínre hozta volna.

**És a mellé szállított detektor pont erre volt vak.** A `gate-decl-check.py` MID-SENTENCE ága
a `desc is None` feltételen ült, vagyis csak akkor futott le, amikor a horgonyzott regex
SEMMIT nem talált -- az ártalmatlan esetben, ahol a kártya amúgy is átesik és a drift ára egy
felesleges átolvasás. A káros esetben talált valamit, tehát az ág soha nem futott: a szkript
OK-t mondott, és a LESZŰKÍTETT szerep-halmazt adta vissza igazságként. Hangos ott, ahol a
drift ingyen van, néma ott, ahol két gate az ára.

**Amit ez a kör megváltoztat.** (1) `declared_gate_excludes_me`: ha a puszta (nem horgonyzott)
alak talál designációt a horgonyzott UTOLSÓ találat UTÁN, az olvasat nem megbízható, tehát a
kártya átesik minden gate elé. Egy hiányos olvasat éppúgy nem döntés, mint egy hiányzó
designáció -- ez a lib saját kimondott aszimmetriája, egy felesleges átolvasás egy kimaradt
gate ellen. (2) A MID-SENTENCE ág a horgonyzott és a puszta olvasat SZEREP-HALMAZ eltérésén
ül, nem a `desc is None`-on. (3) Selftest mindkettőre, plusz a `>=` mutációra egy kimondott
kontroll: ott minden kártya átesne és a függvény némán `return False`-szá válna.

**Mérés (saját, Cybereddel egyezően):** 3001 kártya x 3 gate. Újonnan felszínre kerül: EGY
kártya (`3d923ef5`, cybersec + cybered). Újonnan kiesik: NULLA. A védett alakzat tehát ma is
jelen van a táblán, csak még nem éles.

**A tanulság, ami túlmutat a kártyán.** Az előző kör commit-üzenete és DECISIONS-bejegyzése a
"nulla újonnan kihagyott kártya / kizárólag a biztonságos irányba dől" állítást a SZABÁLYRA
mondta ki, miközben a mérés a MAI TÁBLÁRÓL szólt. A kettő nem ugyanaz, és pont az a függvény,
ami eldönti, hogy egy gate ránéz-e egyáltalán egy kártyára, az a hely, ahol ez a különbség
számít. Egy teljes-tábla mérés azt mondja meg, mi történik MOST, nem azt, hogy mi NEM TÖRTÉNHET.

**Ki döntött:** Cybered (lelet és javasolt gyógymód, 20940), MikroB (re-dispatch), backend2
(implementáció és független újramérés).
**Hivatkozás:** kártya `82fa48b0`; `store/gate_scan_lib.py`, `store/gate-decl-check.py`,
`store/gate-scan-selftest.py`, `store/gate-decl-check.selftest.py`.

## 2026-09-05 -- A seam-predikátum saját kontraktusra pinnelve, és közben egy valódi rés (kártya 3ae71df1, Cybersec 20760)

**A kérés, és miért volt jogos.** A J-1 ellenőrzés `---` és `===` alakot is elutasít, de az egyetlen
fixture-öm a `---`-t gyakorolta. Cybersec kérte a predikátum KÖZVETLEN, egységszintű tesztjét, és
előre kimondta, miért nem elég egy merge-fixture a `=` félre. **Lemértem, és igaza volt:** a `===`
nincs a megosztott-új kivétel-listán, tehát a `_starts_new_entry` már azelőtt elutasítja, hogy a
seam szóhoz jutna. Bizonyíték: a seam-ellenőrzést KIVÉVE a `---` fixture RESOLVED lesz (tehát az
valódi), a `===` viszont továbbra is refused (tehát az vákuum lenne). Pontosan a szomszédos-őr
maszkolás.

**A predikátum ezért külön függvény lett** (`_seam_makes_setext_heading`), és a saját kontraktusára
van pinnelve: 14 közvetlen eset, mindkét irányban.

**ÉS A KÖZVETLEN TESZT AZONNAL VALÓDI HIBÁT TALÁLT A SAJÁT KÓDOMBAN.** Az eredeti minta
`---|===|--------*|========*` volt: pontosan HÁROM, vagy legalább NYOLC karakter. A **négy–hét
karakteres futam kimaradt**, pedig CommonMarkban a setext aláhúzás BÁRMILYEN hosszú `-` (vagy `=`)
sorozat, ha más nincs a sorban -- egyetlen `-` is. A javítás karakter-osztályra vált: a sor
kizárólag `-`-ból vagy kizárólag `=`-ből álljon. A vegyes (`-=-`) és a záró szöveges (`--- x`) alak
NEM utasítódik el, mert azok nem setext aláhúzások, és egy mérés nélküli tágítás pont az az irány,
amit ez a fájl elutasít.

**Ez az eset a saját kérés indoklását igazolja:** az end-to-end fixture három éven át csak az egzakt
`---` betűzést gyakorolta volna, és a rés a többi hosszon csendben ott marad.

**A `=` fél megtartva, kimondott indokkal.** Ma nem érhető el a seamig -- de ez időzítési tény, nem
biztonsági tulajdonság: egyetlen sor a kivétel-listán elérhetővé teszi, és Cybered mérte, hogy egy
ilyen bővítés KÖZVETLENÜL gyárt J-1 példányt. Ugyanaz a mérce, mint a merge-driver tételnél ezen a
kártyán: a „nincs bedrótozva" nem azonos a „szerkezetileg lehetetlen"-nel. Most már nem is
elérhetetlen a TESZT számára, mert a predikátum közvetlenül hívható.

**Mutációs mérés:** a `=` fél kivéve -> 3 piros; vissza a régi rögzített betűzésekre -> 5 piros
(pont a 4-7 hosszúak és az egykarakteresek); az üres-last_before fél kivéve -> 2 piros (egy rule
semmi alatt nem fejléc). Mind átmenő kontroll mellett.
## 2026-09-05 -- 26ab08a2 (2. kör): a degradáció-predikátum invariánsra kerül, tünet helyett

**Döntés:** a lint-racsni degradáció-felismerése nem egyetlen tünetre (`parse_now > parse_was`)
horgonyoz, hanem arra az invariánsra, hogy UGYANAZT A FÁT mértük-e, három független jellel
(nulla lelet fájlok mellett; kettő vagy több korlátozott szabály egyidejű pontos nullázása;
parse-hiba a korlát fölött). A korlát LÉTREHOZÁSA külön ige (`--bootstrap`), nem az `--update`
mellékhatása.

**Miért:** az első kör mechanizmusa működött (négy kontroll: egészséges=0, regresszió=1,
degradáció=3, degradált --update=3), de a predikátum a degradáció HANGOS felére ült. Cybersec
hét megkerülési utat mért (NO-GO, 21010), Cybered ebből hármat előzetesen (INFO-ONLY, 20989).
Mind ugyanaz az alak: ami a mért HALMAZT szűkíti parse-hiba termelése helyett, azt a régi
predikátum nem látja, sőt a parse-hiba csökkenésekor a degradációt IMPROVED-ként ünnepelte. A
legsúlyosabb (bypass A) egyetlen `rm`: baseline törlése után az `--update` bootstrapnak számított
és lemezre írta a `{"(parse-error)": 861}`-et, vagyis mind az öt típus-érzékeny szabályt véglegesen
kivette a korlátból, nulla kilépőkóddal.

**A vállalt ár, kimondva:** a `COLLAPSE_MIN = 2` küszöb szándékos. EGY korlátozott szabály pontos
nullára esése továbbra is IMPROVED, mert innen nézve megkülönböztethetetlen attól, hogy valaki
tényleg befejezte azt a szabályt. Egy szabályt érintő szűkítés tehát átmegy; kettő már nem. A
küszöb egyre vitele a valódi egy-szabályos javítást minősítené mérés-hibának (mutációval mérve:
pontosan az anti-blanket kontroll bukik el tőle).

**Egy teszt ígéretét MEGFORDÍTOTTUK, nem csendben:** a korábbi F eset azt rögzítette, hogy
`--update` baseline nélkül mindenképp ír egyet. Ez az ígéret MAGA volt a bypass A. Az eset ketté
vált: `--update` megtagadja a létrehozást és megnevezi a `--bootstrap`-ot, a `--bootstrap` pedig
továbbra is működik a valódi első futásra.

**Bizonyíték, hogy nem egy mindent-megtagadó javítás:** Cybersec kikötötte, hogy egy blanket
refusal ugyanúgy zöld lenne az első hét soron. Mutációval mérve: a "mindig degradált" mutáns 9
esetet buktat, köztük mind a négy egészséges kontrollt; a valós fán a futás továbbra is exit 0
(230 lelet, baseline holds).

**Ki döntött:** Cybersec (NO-GO, a hét út mérése és a javasolt gyógymód, 21010), Cybered
(INFO-ONLY előmérés, 20989), MikroB (NO-GO elfogadva, re-dispatch, 21013), backend2
(implementáció, független újramérés, mutáció-ellenőrzés).
**Hivatkozás:** kártya `26ab08a2`; `store/lint-ratchet.sh`, `store/lint-ratchet.selftest.sh`.

## 2026-09-05 -- 44849954: a zárás-ellenőrző a verdikt SZERZŐJÉT is nézi

**Döntés:** a `gate-closure-check.py` egy PASSZOLÓ verdiktet csak akkor számít az adott gate
sign-offjának, ha azt a gate maga írta. Ha nem, a gate saját korábbi verdiktje lép a helyére; ha
olyan sincs, új válasz jön (`UNVERIFIED-AUTHOR`) a csendes `AGREE` helyett. Egy ELUTASÍTÓ verdikt
attól függetlenül érvényben marad, ki írta le.

**Miért:** az eszköz a verdiktet SZÖVEG-ALAK szerint hitelesítette és SZERZŐ szerint soha (az
`author` mezőt sehol nem olvasta). A kanban-API-n a komment szerzője a kérés TÖRZSÉBŐL jön, egy
közös Bearer token alatt, tehát bármely ügynök írhat bármely szerző nevében -- az alak-ellenőrzés
volt az egyetlen dolog a készítő és a saját sign-offja között. Cybered lelete (67a5ee01
gate-eléséből), végponttól végpontig igazolva.

**A szigorú author==gate szűrés ROSSZ válasz, mérve:** 156 kártya-gate páron a legfrissebb verdiktet
nem a gate írta, és ebből 152 MikroB saját összefoglaló kommentje. Kizárásuk 54 lezárt kártyát
minősítene visszamenőleg gate nélkülinek.

**Egy implementációs részlet, ami nélkül elromlik:** a szerző-oldali összevonásnak TÜKRÖZNIE kell a
verdikt-szó oldalit (a `GATES` melletti jegyzet a testvér-számot eldobja, tehát QA2 verdiktje a QA
gate verdiktje). Csak az egyik oldalon alkalmazva 245 jogos QA2-verdikt minősülne idegennek. A
záró számjegyek levágása szabályból következik, tehát egy jövőbeli CYBERSEC2/CYBERED2 nem igényel
szerkesztést.

**Az aszimmetria, és miért nem egyszerű "a gate saját kommentje az erősebb":** ha egy relayelt FAIL
mögé visszaesnénk a gate régebbi PASS-ára, egy kártya kimondott elutasítás fölött zárulhatna --
rosszabb, mint a javított hiba. Ezért csak a PASSZOLÓ verdiktnek kell beazonosíthatónak lennie.

**Teljes tábla mérése (2889 kártya, régi kontra új):** 72 kártya olvasata változik, MIND `done`
státuszú, és MIND `NOSHA`-ból indul -- egyetlen korábbi `AGREE` sem válik elutasítássá. Ebből 26
`AGREE` lesz (a visszaesés VISSZANYER egy Gate-SHA-t, mert MikroB összefoglalói jellemzően nem
hordoznak shát), 44 `UNVERIFIED-AUTHOR`, 2 pedig `DISAGREE` -- ez utóbbi két lezárt kártyán a gate-ek
ténylegesen KÜLÖNBÖZŐ shára adtak verdiktet, amit eddig a `NOSHA` elfedett (`f4442719`, `f7ebaa2d`).

**Amit ez NEM bizonyít:** hogy a szabály senkit nem blokkol. A "mind done" a MAI TÁBLA tulajdonsága,
nem a szabályé -- ezentúl egy élő kártya is megállhat `UNVERIFIED-AUTHOR`-on, és ez a szándék.

**Hosszú távú válasz (külön döntés, nem ezen a kártyán):** per-ügynök token, hogy a szerző a
hitelesítésből származzon, ne a kérésből.

**Ki döntött:** Cybered (lelet és javasolt gyógymód), backend2 (implementáció, teljes tábla mérése,
az aszimmetria és a testvér-összevonás), MikroB (kártya).
**Hivatkozás:** kártya `44849954`; `store/gate-closure-check.py`, `store/gate-closure-check.selftest.py`.
## 2026-09-05 -- A kerítés-ellenőrzés ÁLLAPOTGÉP lett, nem egy írásmód (kártya 3ae71df1, Cybered R-1/R-2/R-3)

**R-1: a J-2 paritás egyetlen írásmódot nézett.** A `grep -c '^```'` alak ugyanazon a fixture-alakon,
amin a lezáratlan ``` helyesen elutasít, a lezáratlan `~~~`-t és a két szóközzel BEHÚZOTT ```-t
átengedte -- mindkettő pontosan a J-2 kárt termeli. Cybered mérte, és kifejezetten kérte, hogy a
`~~~` NE harmadik fokként kerüljön be ugyanarra a létrára. Egyetértek: ez a kártya kétszer mászta
meg ugyanezt, és mindkétszer a KÉRDÉS cseréje volt a válasz.

Ezért a check CommonMark-állapotgép: a kerítés három vagy több `` ` `` vagy `~`, legfeljebb három
szóköz behúzással (négy már behúzott kódblokk, sosem kerítés), a záró ugyanaz a karakter, legalább
olyan hosszú, és nincs utána más. A nyitón megengedett az info-string (```bash), a zárón tilos --
ezért a záró szigorúan illesztett: az elnézés ott olyan blokkot zárna, amit a parser nyitva hagy,
és az a fail-OPEN irány.

**R-2: az őr hibaüzenete a NEM őrzött útra mutatott.** `bash <fájl> a b c` -> rc=2, de
`bash -c '. <fájl> a b c'` -> rc=0, tehát a csendes adatvesztés megvan -- és az üzenet épp azt
ajánlotta, hogy „sourceold és hívd a függvényét". A sourceolt utat NEM lehet őrizni: a fájl örökli a
hívó pozicionális paramétereit, tehát egy három argumentummal indított `marveen-land.sh`
megkülönböztethetetlen lenne egy driver-hívástól. Az üzenet ezért mostantól kimondja, hogy ehhez a
fájlhoz NINCS támogatott merge-driver konfiguráció, és megnevezi a korlátot is.

**R-3: mérve NEM elérhető, és ez a lelet érdemi része.** A `last_before` az utolsó NEM ÜRES sort
vette; egy üres sor a junction előtt markdownban lezárja a bekezdést, tehát az utána jövő `---`
vízszintes vonal, nem setext fejléc. A javítás viszont end-to-end NEM változtat semmit: mérve, egy
lemezen `prozasor\n\n`-nel végződő fájl `$(git show ...)` után `prozasor`-ként érkezik -- a
parancs-behelyettesítés levágja a záró újsorokat, tehát a `before_junction` sosem végződhet üres
soron. **Az első javítási kísérletem `$(... | tail -n1)` volt, és pont ezért mért no-opot.** A kód
bent marad (paraméter-kiterjesztéssel, ami nem vág), a komment pedig kimondja, hogy ma elérhetetlen,
és hogy egyetlen változás -- `ours` beolvasása parancs-behelyettesítés nélkül -- elérhetővé teszi.

**KÉT SAJÁT HIBA, AMIT A MÉRÉS FOGOTT MEG.** (1) A generált fixture-ökbe nyers backtickeket írtam
kettős idézőjelben: bash parancs-behelyettesítés, a selftest LEFAGYOTT. Ugyanaz az osztály, mint ma
a teszt-CÍMKÉKNÉL, egy szinttel beljebb. (2) A záróra vonatkozó két szigorítás (legalább olyan
hosszú; nincs utána szöveg) PINNELETLEN volt -- a mutációjuk zölden hagyta a suite-ot, tehát a kód
helyes volt, a tesztek viszont nem figyelték. Mindkettő saját esetet kapott.

**Mutációs mérés, öt mutáció, mind csak a sajátját:** vissza a grep-paritásra -> 2 piros (a `~~~` és
a behúzott); a tilde elvéve -> 1; a behúzás-levágás elvéve -> 1; a záró rövidebbet is elfogad -> 1;
a záró utáni szöveget elfogad -> 1. Átmenő kontroll mellett.

## 2026-09-05 -- 9c6b1802: a fékezés-jegyzet egysége az EPIZÓD, nem az átmenet

**Döntés:** A load-guard PAUSED-LOAD/RESUMED-LOAD kanban-jegyzete mostantól epizód-szintű: egy
jegyzet a fékezési epizód kezdetén, egy a végén (ciklusszámmal és időtartammal), és közben
időkorlátos életjel. Az egyes fagyasztási ciklusok nem írnak jegyzetet. Két új hangoló érték a
`load-guard-config.json` `bookkeeping` blokkjában: `episode_gap_seconds` (300) és
`heartbeat_seconds` (240).

**Miért:** A jelenség nem hiba volt, hanem a mechanizmus szerkezete. A `sigstop_freeze`
`max_freeze_seconds` értéke 90, tehát tartós terhelés alatt a guard fagyaszt, eléri a korlátot,
felenged egy még mindig terhelt gépre, majd újrafagyaszt. Élő mérés a táblán: 1082 fékezés-kezdetből
988 volt `sigstop_freeze`, a medián állapot-hossz 10 másodperc, és az összes kanban-komment 10,2
százaléka ilyen jegyzet. A legrosszabb kártya (fe5d7967) 353 kommentjéből 342 volt ez, vagyis 11
valódi komment maradt. Az átmenet tehát rossz hír-egység volt; az epizód a jó, és a ciklusszám
olyan információ, amit 46 azonos pár soha nem adott meg.

**A KORLÁT, ami a tervet eldöntötte:** a jegyzetnek van egy MÁSODIK funkciója is, mozgatja a kártya
`updated_at` mezőjét. A stuck-card-monitor a `load-paused-agents.json` alapján zárja ki a fékezett
ügynököket, tehát a FOLYAMATOSAN fékezett ügynököt a jelzőfájl védi; de a jelzőhalmazból ki-be
ugráló ügynököt a monitor elkaphatja egy felengedett pillanatban, és akkor már csak az `updated_at`
áll közte és a 10 perces beragadás-ítélet között. Ezért a néma ablak KORLÁTOZOTT, nem megszüntetett.
A teljes élő jegyzet-korpuszon (2150 darab) szimulálva a leghosszabb néma ablak egy aktív epizódon
belül 497 másodperc, a monitor 600 másodperces küszöbe alatt, körülbelül 100 másodperc tartalékkal.
Ugyanezen a korpuszon a jegyzetek száma 2150-ről 382-re esik (82 százalék).

**Elvetett alternatíva:** egyszerű küszöb az állapot hosszára (csak N másodpercnél hosszabb fékezés
ír jegyzetet). Mivel a `sigstop_freeze` 90 másodpercnél tovább nem tarthat, minden 90 feletti küszöb
kivétel nélkül elnyomta volna a fékezések 91 százalékát adó mechanizmus MINDEN jegyzetét, a 90 alatti
küszöbök pedig a mérés szerint vagy keveset nyertek, vagy a néma ablakot 600 másodperc fölé vitték.

**Amit ez NEM old meg:** magát a flapping-et. A 90 másodperces korlát és a tartós terhelés
kölcsönhatása változatlan; ez a döntés a jelentést javítja, nem a fékezést. Ha a flapping maga
zavaró, az külön kártya a `max_freeze_seconds` és a felengedés utáni visszaesés-kezelés kérdésére.

**Ki döntött:** backend2, Cybered megfigyelése alapján (komment 21017). Gate: QA.
## 2026-09-05 -- A setext-oldal is megtanulta a 0-3 szóköz behúzást (kártya 3ae71df1, Cybersec 21040)

**A lelet: a saját aszimmetriám.** Ugyanabban a körben javítottam a kerítés-ellenőrzést úgy, hogy
kezelje a CommonMark 0-3 szóköz behúzását -- a setext-predikátumot viszont nulladik oszlopra
horgonyozva hagytam. Mérve a landolt példányon: `---` elutasít, `  ---` átmegy. A CommonMark a
setext aláhúzást PONTOSAN ugyanúgy engedi három szóközig behúzva, mint a kerítés-nyitót.

**Egy osztály, két fél, és csak az egyik tanulta meg.** Cybersec ezt külön kimondta („nem három
külön nit"), és igaza van: a gyökér ugyanaz -- sor-eleji horgony egy olyan nyelvtannal szemben,
ami behúzást enged. Ez pontosan az a minta, amit korábban már felírtam magamnak (egy mezőn
megtanult horgonyzás nincs alkalmazva a testvérére), és most a saját kódomon ismételtem meg.

**Négy szóköz safe marad, két független okból:** túl mély egy setext aláhúzáshoz, és egy behúzott
kódblokk nem szakíthat meg egy bekezdést. Ez a kontroll állítja meg a „vágj le minden bevezető
szóközt" alakot.

**Záró whitespace megengedett** az aláhúzás után (a CommonMark így mondja), más szöveg nem -- a
`--- x` továbbra is átmegy, a `---  ` nem.

**Mutációs mérés:** a behúzás-levágás elvéve -> 3 piros; a négy-szóközös őr elvéve -> 1 piros; a
záró-whitespace levágás elvéve -> 1 piros. Átmenő kontroll mellett. 61 selftest-eset.

## 2026-09-06 07:40 -- self-pace hard-gate: at(1) elveszti a puszta input-átirányítást, batch(1) megtartja

**Döntés:** A governance hard-gate `at`/`batch` felismerésében az input-átirányítás ágát
szétválasztottam a két bináris között. `batch(1)` marad a régi alaknál (bármilyen átirányítás valódi
beküldés), `at(1)` viszont csak akkor illeszkedik átirányításra, ha azt a fájl-szó UTÁN egy tényleges
timespec követi. Ezzel a kártya 79bb0364 mindkét bejelentett hamis-pozitív osztálya megszűnik, és
egyik javasolt gyógymódot sem építettem be.

**Miért:** `at(1)` KÖTELEZŐEN kér timespecet, tehát a csupasz átirányítás sosem írt le működő
beküldést -- pontosan ugyanaz az érv, ami korábban a 12f80902 kártyán már engedélyezte a
„semmi nem követi" ág elvételét, szintén csak `at`-tól, `batch`-tól nem. A régi alak ezért egy
`at` nevű változó összehasonlítását (`at <= 0`, `at < n`) `at < FÁJL`-ként olvasta.

**Miért nem a kártya által javasolt javítás:** a javaslat (a `<` ág ne illeszkedjen, ha `=` vagy egy
második `<` követi) mérve MEGNYIT egy megkerülést -- egy `=0` nevű fájlból való átirányítás plusz
valódi timespec átcsúszik rajta. Mutációs futással bizonyítva: ezt a mutációt a suite pirosra
váltja azon az egy eseten, a többi kontroll zöld marad.

**Miért nem a Cybersec által javasolt gyógymód (23941):** a javaslat az volt, hogy a kapu hagyja ki
az IDÉZETT delimiterű heredoc TÖRZSÉT, „mert ott definíció szerint nincs behelyettesítés". Az idézett
delimiter az KÜLSŐ shell behelyettesítését zárja ki, nem a törzs VÉGREHAJTÁSÁT: a `bash <<'EOF'` és a
`python3 <<'PY'` pont ezt a törzset futtatja. Mutációval pontosan modellezve ez a gyógymód 31 tesztet
váltott pirosra, hat korábbi kártya regresszióit is beleértve (tmux send-keys, crontab, ütemezés-API,
`at now` -- mind idézett heredocban).

**A második bejelentett osztály nem külön gyökér:** Cybersec diagnózisa a VAGY-operátort nevezte meg
a trigger felének; mérve nem az. Ugyanaz a code-span VAGY-operátor nélkül ugyanúgy blokkol, és
ugyanaz a span átnevezett változóval átmegy. A backtick command-position karakter, tehát a markdown
code-span ugyanabba a pozícióba tette a szót, mint a JS `(`. Egy gyökér, egy javítás.

**Ismert, kimondott maradék:** (1) `at < job` timespec nélkül mostantól ÁTMEGY -- nem tud ütemezni;
(2) `at < job "$WHEN"` (változóból jövő timespec) is átmegy, de `at "$WHEN" < job` eddig is átment,
tehát ez a lefedettség eddig sem volt következetes; (3) egy verdikt-komment, ami VALÓDI
ütemező-parancsot idéz code-spanben (`crontab -r`), továbbra is blokkolódik -- ezt szövegilleszkedéssel
nem lehet megkülönböztetni a végrehajtástól.

**Ki döntött:** backend3 (mérés + döntés), a kártyát backend2 nyitotta, a második osztályt Cybersec
jelentette. Gate: QA + Cybersec.

**Hivatkozás:** kártya 79bb0364.

## 2026-09-06 08:55 -- 79bb0364 (2. kör) -- a `batch` oldal is megkapja az összehasonlítás-kizárást; a fenti bejegyzés egyik állítása javítva

**Ez a bejegyzés HELYESBÍTI a mai korábbi, 79bb0364-es bejegyzést.** Az így szólt: „Ezzel a kártya
79bb0364 mindkét bejelentett hamis-pozitív osztálya megszűnik." A leszállított javítás valójában csak
az `at(1)` átirányítás-mintáját keményítette; a `batch(1)` mintája változatlan maradt, tehát a
`batch <= 0` -- ugyanaz az összehasonlítás, ugyanaz a hibaosztály -- továbbra is blokkolt. QA a
127c11cc-n megtalálta és FÜGGETLENÜL reprodukálta (komment 21161, közvetlen `gateDecision` hívással,
nem az én fixture-jeimből). A QA FAIL jogos volt, elfogadtam.

**Miért nem lehetett átültetni az `at` javítását.** Az `at(1)`-et azzal lehetett zárni, hogy az
átirányítás után timespecet követel -- a `batch(1)` viszont nem kér timespecet, ez a kar nála nem
létezik. Amije VAN, az a tükörképe: a `batch(1)` NEM fogad operandust. A `batch <= 0` a bash számára
egy `=` nevű fájlból való átirányítás PLUSZ a `0` operandus, és egy operandustól a batch usage
error-ral kilép -- tehát ez az alak sem írt le működő beküldést soha.

**A kivágás pontosan ez az alak, és semmivel sem szélesebb:**
`batch <= 0` (átirányítás + operandus -> usage error) átmegy; `batch <=`, `batch <=0`,
`batch << EOF`, `batch < /tmp/job.sh` mind MŰKÖDŐ beküldés és mind tiltott marad. A kivágáson belüli
`(?![0-9]*[<>&])` őr azt zárja ki, hogy a kivágás ajtóvá váljon: a `=` után álló `2>/dev/null`,
`>out`, `&1` átirányítás és nem operandus, tehát a batch operandus nélkül marad és beküld.

**Miért nem a kártya (és QA) által javasolt egyszerűbb kizárás (`<` után ne álljon `=` vagy `<`).**
Mutációval mérve: az az alak HAT működő beküldést enged át -- `batch <=`, `batch <=0`,
`batch << EOF` és a három átirányítás-alak. A pontos kivágás mindet tiltva hagyja.

**ÚJ, KIMONDOTT MARADÉK, amit a korábbi bejegyzés maradék-listája nem tartalmazott:** a `batch < n`
tiltott marad. Ez kódban valódi összehasonlítás, bashben valódi beküldés, szövegként
megkülönböztethetetlen -- fail-closed az egyetlen biztonságos olvasat. Pinelve saját tesztesettel,
hogy döntés legyen és ne feledés.

**Mutációs mérés:** a `batch` átirányítás visszaállítva a javítás előttire -> 4 piros (a négy
hamis-pozitív); az egyszerűbb `(?![<=])` kizárás -> 6 piros (a hat működő beküldés); a kivágáson
belüli átirányítás-őr elvéve -> 3 piros. Kontrollok (az `at` oldal mindkét iránya) mindháromban
zöldek.

**Ki döntött:** QA (FAIL + a helyes irány megnevezése), backend3 (a mérés és a konkrét alak).

**Hivatkozás:** kártya `79bb0364`, QA komment 21161.

## 2026-09-06 09:15 -- 3ae71df1 (gate-kör) -- egy nyelvtan mindkét félnek, a sorvég-tengelyen is

**Döntés.** A `_seam_makes_setext_heading` záró-vágása egyetlen karakterosztály (`[[:space:]]`) lett a
korábbi két kimondott alak (szóköz, tab) helyett, és a KORÁBBI sor üresség-vizsgálata leszedi a záró
`\r`-t. A kerítés-oldal behúzás-kezelése szélességenként kapott fixture-t (1, 2, 3 szóköz), ahogy a
setext-oldal már eddig is.

**Miért.** Cybered mérése (komment 21147): a kerítés-fél CR-toleráns volt (`[![:space:]]`), a
setext-fél nem, ezért CRLF sorvégű fájlban a `---\r` `safe`-et adott -- és itt a `safe` a FAIL-OPEN
irány: lefut az unió, és a beillesztett szöveg a szomszédjából setext headinget csinál. Ugyanaz az
egy-fél-tanulta-meg minta, amit ez a kártya a behúzás-tengelyen már egyszer javított, egy tengellyel
odébb. A karakterosztály nem ezt az egy esetet zárja, hanem a két felet egy nyelvtanra hozza.

**Miért szélességenkénti fixture.** Cybersec F-3 mutációs térképe (komment 21120): a 61 esetes
selfteszten az 1 szóközös ág törlése NULLA pirosat adott, a 3 szóközösé szintén -- egyetlen 2 szóközös
fixture volt, tehát két ág fedetlenül állt, és a 3 szóközös mutáns kára end-to-end elő is állt.

**Mutációs mérés a javítás után:** 1sp ág törölve -> 1 fixture piros; 2sp -> 1; 3sp -> 1; a
whitespace-osztály vissza a két alakra -> 2 piros; a `\r`-strip elvéve -> 1 piros; KONTROLL
(komment-only mutáció) -> rc=0, nulla piros. 67 selftest-eset (61-ről).

**Hivatkozás:** kártya `3ae71df1`, Cybersec 21120 (F-1/F-2/F-3), Cybered 21147, MikroB 21125.

## 2026-09-06 10:30 -- 79bb0364 (3. kör) -- R-5, F-2, és a kivágás nem lett ajtó a nevesített fd-nek

**Először a folyamat-hiba, mert azt QA jogosan írta fel (21218).** MikroB 21174-es ruling-ja EGY körre
három tételt írt elő (második bináris + R-5 + F-2); a második kör CSAK a batch-részt szállította, és a
REVIEW (21209) egy szóval sem mondta, hogy a másik kettő kimaradt. Nem halasztás volt, hanem
elmaradás -- pontosan az a minta, amiről senki nem tudja, hogy még nyitva van, amíg valaki újra rá
nem botlik. Ez a kör mindhármat leszállítja.

**R-5 (Cybersec F-1, 21173).** Az `at(1)` átirányítás-ága mostantól KÉT olvasat UNIÓJA. Az első kör
egyetlen mintája (a) azt követelte, hogy a timespec KÖZVETLENÜL a fájl-szó után álljon, és (b) a
kisebb-jel operátort olyan karakterosztállyal írta le, amit a kétszeres és háromszoros alak nem
illeszt. Egy TILTÓ regexben a nem-illesztés ENGEDÉS, tehát ami őrnek olvasódott, az lyuk volt: hét
működő beküldés váltott tiltásról engedésre. Nem következtetés -- argv/stdin-t kiíró csonkkal mérve,
az X1 és X4 alak argv-je és stdinje BÁJTRA AZONOS a továbbra is tiltott, szomszédos-timespeces
alakkal.

**Miért unió, és miért szűkebb szó-lista a széles ágon.** A széles ág teljes timespec-listával valós
kódot tilt, mert a csupasz négyjegyű szám érvényes timespec (a mért eset egy `len - 1500`
összehasonlítás). A csupasz négyjegyű és a pontozott dátum-alternatíva elhagyása a SZÉLES ágról ezt
megszünteti, a SZOMSZÉDOS ág pedig megtartja a teljes listát, tehát a fájl-szó után közvetlenül álló
négyjegyű és pontozott-dátum timespec tiltott marad. Egyik ág sem elég önmagában, és ez mérve is így
jön ki.

**A kivágás nem lett ajtó (Cybersec 21227).** A batch-kivágás premisszája ("ha az egyenlőségjel után
szóközzel áll valami, akkor batch OPERANDUST kapott, tehát usage error") hamis minden olyan tokenre,
amit a bash ELFOGYASZT ahelyett hogy továbbadna. A nevesített fd-átirányítás argv(0)-t és a job
törzsét stdinre adja, bájtra azonosan a továbbra is tiltott csupasz alakkal. Az első enumeráció a
redirect-ÍRÁSMÓDOKAT sorolta fel, nem azt kérdezte, hogy a token operandusként túléli-e a
szó-felbontást -- ugyanaz a hibaalak, amiről ez a kártya szól. A kapcsos-zárójeles fd-név kizárása
mérve nulla költséggel zárja.

**ÚJ, KIMONDOTT MARADÉK (a szigorú kisebb-jeles alak mellé):** a nulla szóra kiértékelődő
behelyettesítés és a nulla szóra kiértékelődő idézetlen változó szintén operandus nélkül hagyja a
batch-et, viszont SZÖVEGKÉNT megkülönböztethetetlen egy változóval való valódi összehasonlítástól,
amit ez a kör épp engedni akar. Bármelyik dollárjelre kiterjesztett őr visszahozná a most
megszüntetett hamis pozitívot. Mindhárom alak be van pinelve tesztként: kettő mint a maradék ára,
egy mint az ok, amiért az ár helyes.

**A KIMONDOTT MARADÉKBÓL KIKERÜLT:** a hét at(1)-alak, amit Cybersec F-1-ként mért -- azok mostantól
tiltottak, nem maradék.

**Mutációs mérés:** a szomszédos-egyedül alak (a 2. kör állapota) -> 7 piros; a széles ág egyedül ->
2 piros; a széles ág teljes listával -> 1 piros (a hamis-pozitív kontroll); a nevesített-fd őr elvéve
-> 2 piros; KONTROLL komment-mutáció -> 0 piros. 49 teszteset a fájlban (34-ről).

**F-2.** A fájl-komment és a teszt-név egy hamis ÁLTALÁNOS állítást rögzített ("a karakterosztály
elutasítja a heredoc-operátort"), amit az X1 alak cáfol. A konkrét assert jó volt, a neve nem. Nem
töröltem a rossz mondatot, hanem javítva megtartottam: az a magyarázat, amiért az operátor most
ismétlés-jelöléssel van leírva.

**Amit egyikünk sem tudott végrehajtással igazolni, és Cybersec is kimondta:** hogy a timespec nélküli
átirányítás usage-hibával kilép. Az at(1) dokumentált felületéből következik, de a bináris nincs
telepítve ezen a gépen, tehát ez a pont dokumentáció-alapú.

**Ki döntött:** QA (a hiányzó hatókör felírása), MikroB (21222: ugyanebbe a körbe), Cybersec (R-5 és
a nevesített-fd őr előre lemérve), backend3 (végrehajtás + független újramérés).

**Hivatkozás:** kártya `79bb0364`, kommentek 21173 / 21218 / 21222 / 21227.

## 2026-09-06 11:20 -- bb52c2fa -- A környezet-függetlenség nem locale-pinneléssel jön, hanem azzal, hogy nem prózát olvasunk

**C-2 (a legdrágább).** A selftest CSAK akkor volt zöld, ha az `LC_ALL` NINCS exportálva. Bármelyik
exportált érték (C, C.UTF-8, en_US.UTF-8, hu_HU.UTF-8) 61/67-re vitte, hat pirossal -- vagyis bármely
CI- vagy ügynök-környezet, ami exportálja az LC_ALL-t, HAMIS PIROST kapott helyes kódra. Ez a 17.
munkavégzési szabály osztálya: a hamis piros a gate-en helyes munkát küld vissza.

**A gyökér nem az, aminek látszott.** A `_common_line_prefix_len` fejléce azt sugallta, hogy a
`local LC_ALL=C` a `cmp` bájt-szemantikáját is kikényszeríti. Nem: a `cmp` külön folyamat, az
ÜZENETE lokalizált, és a szóhasználat nem követi azt, hogy a locale bájt-orientált-e. Mérve, ugyanaz
a két fájl, öt környezetben: `LC_ALL` unset -> "differ: byte", `C` -> "differ: **char**",
`C.UTF-8` -> "byte", `en_US.UTF-8` és `hu_HU.UTF-8` -> "char". A `byte`-ra szűkített minta tehát a
legtöbb exportált locale-ban SEMMIT nem illesztett, az `n` üresen jött vissza, és a fallback a
RÖVIDEBB oldal teljes hosszát adta vissza közös prefixként.

**A javítás nem bővebb szó-lista, mert az ugyanaz a felsorolás-hiba egy szinttel feljebb** -- egy
fordított locale teljesen más mondatot ír. A `cmp -l` SZÁMOKAT ad (soronként egy eltérő bájt,
`<1-alapú bájt-offset> <oktális a> <oktális b>`), és a FORMÁTUMA mind az öt környezetben azonos.
Többbájtosra is ellenőrizve: két fájl, amik `áéí` (6 bájt) után térnek el, C-ben és hu_HU.UTF-8-ban
egyaránt 7-es offszetet ad, tehát bájt-offszet.

**SAJÁT HIBA UGYANEBBEN A KÖRBEN, kimondva:** az első változatom `cut -d' ' -f1`-gyel olvasta ki az
offszetet, és a `cmp -l` JOBBRA IGAZÍTJA azt -- egy nagy offszet `              20024 101 102`
alakban érkezik, és az egyszóközös vágás az előtte álló üres mezőt adja vissza. A 4 bájtos
próbafixture-ömben ez láthatatlan volt, mert ott az offszet egyjegyű és nincs padding. Pontosan az a
csapda, amit ennek a függvénynek a fejléce már leír az ASCII-only fixture-ökről. `awk '{print $1}'`.

**C-1.** A `---`/`***`/`___` elválasztókat a skip-lista PONTOSAN illesztette, tehát CRLF-fájlban a
szabály-sor `---\r`, nem ismerhető fel, és bájtra azonos tartalom LF-en RESOLVED, CRLF-en REFUSED
volt. Fail-closed, tehát semmi nem mergelődött rosszul -- de egy visszautasítás, amit a felhasználó
a saját checkoutján nem tud reprodukálni, önmagában is költség.

**Ez a HARMADIK alkalom, hogy ezt a fájlt egy rule két, egymástól elcsúszott fele harapta meg**
(behúzás, záró whitespace, most a sorvég). Ezért a skip-lista mostantól EGY helyen él
(`_is_blank_or_rule`), és mindkét hívó azon megy át -- nem két felsorolás, ami ma még egyezik.

**N-1 (Cybersec).** A seam-predikátum most pineli a saját locale-ját, ahogy a kerítés-testvére eddig
is. A produkciós út egyébként árnyékolta (a `try_append_union` állítja, és a bash dinamikusan
hatókörözi), tehát a merge-válasz sosem függött a környezettől -- a kitettség a KÖZVETLEN hívó, ami a
selftest maga. Ettől függetlenül pinelve: egy predikátum, ami hozza a saját locale-ját, nem törhető
el egy jövőbeli hívóval, aki elfelejti.

**N-2 (Cybersec).** A testvér-wrapper `--selftest` kapcsolója némán, nulla kimenettel tért vissza
rc=0-val. Nem volt lefedettségi lyuk (a CI a glob alapján megtalálja a `.py` selftestet, 17/17), de
egy néma siker megkülönböztethetetlen a "minden zöld"-től. Most lefuttatja a valódi selftestet és
továbbadja a kilépési kódját; a fájlt névvel hivatkozza, hogy egy átnevezés hangosan bukjon.

**Mutációs mérés:** a próza-olvasás vissza -> 1 piros (az új locale-eset); a skip-lista CR-toleranciája
elvéve -> 1 piros (az új CRLF eset); a seam locale-pin elvéve -> 1 piros (az új seam-locale eset);
az `awk` visszacserélve `cut`-ra -> 6 piros; KONTROLL komment-mutáció -> 0 piros. 70 teszteset
(67-ről), és a suite mind a hat próbált környezetben zöld.

**A seam-locale esetről külön:** az első mutációs futáson TÚLÉLTE a pin elvétele, nulla pirossal --
és ez valódi rés volt, nem redundancia (a mutáns MÁSHOGY viselkedik, csak nem hívta senki idegen
locale alatt). Ezért került be a hozzá tartozó eset, és utána már pirosat ad.

**Hivatkozás:** kártya `bb52c2fa`; Cybered C-1/C-2 (3ae71df1 zárásakor), Cybersec N-1/N-2 (21236).

---

## 2026-09-06 -- 26ab08a2 (3. kör): a nullára-esés küszöbe EGY, és a bootstrap-padló ÁLLAPOT-alapú

**Döntés.** Két korábban kimondott MikroB-rendelkezés végrehajtása, Cybersec NO-GO-jára
(21092, Gate-SHA 49f3c324) reagálva.

**R-A (MikroB 21030).** `COLLAPSE_MIN` 2-ről **1**-re. A képesség nem szűnik meg, hanem
KÉRNI kell: `--update --accept-cleared=<szabály>[,<szabály>...]`. A kapcsoló NEVESÍTI a
szabályokat, nem csupasz flag -- ez a különbség a nyugtázás és a megkerülés között. Egy
csupasz flag elférne egy wrapper-scriptben örökre, és pont a kártya alapító mérését (öt
szabály egyszerre sötétbe) engedné át. A neveket nem lehet vakon szkriptelni: a lista
minden alkalommal más, egy NEM nevesített szabály elsötétedése továbbra is megtagadás, és
egy a bound-ban nem szereplő név maga is megtagadás, nem néma no-op.

**Miért nem maradhatott 2.** A 2-es küszöb ára nem egy kis lyuk volt, hanem UGYANAZ a lyuk
négy extra lépéssel: Cybersec lemérte az öt egymást követő `--update`-et, mindegyik egy
szabályt visz nullára, mindegyik önmagában exit 0 és védhetőnek látszik, a végállapot
`{"(parse-error)": 6}` -- pontosan annak a megkerülésnek a végállapota, amiért ez a kártya
létezik.

**R-B (MikroB 21035).** A bootstrap-ág padlója ÁLLAPOT-alapú: parse-hiba van ÉS egyetlen
TÍPUS-ÉRZÉKENY szabálynak sincs egyetlen lelete sem. A git-padló (Cybered javaslata) azt
kérdezi, "létezett-e korábban ez a fájl", ezért git nélküli fában semmit nem tud
válaszolni, és ott SZÁNDÉKOSAN fail-open. A szándékos út ezen sétált át: `--bootstrap` egy
teljesen degradált, git nélküli fán `{"(parse-error)": 861}`-t írt. Az új padló a FUTÁSRÓL
kérdez, ezért első futásnál is válaszolható -- pont ott, ahol a git-padló vak.

**Egy tényt helyesbítettem, mert kóddá vált.** A szkript és a selftest fejléce is azt
állította, hogy "a hat racsnizott szabályból ÖT típus-érzékeny". NÉGY. A plugin saját
metaadatából olvasva (`meta.docs.requiresTypeChecking`, a repo által telepített
@typescript-eslint/eslint-plugin példányán): `await-thenable`, `no-floating-promises`,
`no-misused-promises`, `no-unsafe-argument` mind `true`; a `no-unused-vars`
**undefined** -- szintaktikus szabály, TS-program nélkül is jelent, és csak akkor hallgat
el, ha maga a parse bukik, amit a `(parse-error)` vödör már lefed. A `no-unused-vars`
beemelése a halmazba a padlót SZIGORÚAN GYENGÉBBÉ tenné, mert a padló azt kérdezi, hogy
EGYIK ilyen szabály sem talált-e semmit.

**A VÁLLALT ÁR, kimondva.** A `await-thenable` élő száma MA 1. Amikor valaki ezt az utolsó
leletet is megjavítja -- vagyis JÓ munkát végez --, a következő `store/lint-ratchet.sh`
futás exit 3-at ad, és ez a fleet-test része, tehát MINDEN landolást blokkol addig, amíg
valaki le nem futtatja a nyugtázó parancsot. Ez a 2-es küszöb mellett nem történt volna
meg. Elfogadjuk, mert a másik oldalon a szeletelt megkerülés áll, és a költséget a
hibaüzenet viszi le percekre: a megtagadás a TELJES, beilleszthető parancsot kiírja
(`store/lint-ratchet.sh --update --accept-cleared=<szabályok>`), nem csak a kapcsoló nevét.

**Mérve.** Élő fán a javítás után változatlan: exit 0, 230 lelet, 6 szabály, egyik sem áll
nullán. Selftest 23 -> 30 eset. Nyolc per-őr mutáció, mind piros a saját esetén; a
blanket-mutáns (mindig megtagad) 14 esetet buktat, köztük MINDEN egészséges kontrollt --
ez Cybersec kifejezett kikötése volt, mert egy mindent megtagadó javítás a megkerülés-
sorokon ugyanígy zöld lenne.

**Két teszt ígérete MEGFORDULT, a case mellett dokumentálva, nem csendben.** Az O eset
eddig azt rögzítette, hogy egy szabály nullára esése IMPROVED marad (a 2-es küszöb
kimondott ára); az N eset szövegkeresője az "are ALL at exactly zero" alakot várta, ami
egy olyan többességre hivatkozott, aminek már nem kell fennállnia. Az N állítása
tartalmilag változatlan: az üzenet a szabály-összeomlást nevezze meg, ne a nem mozdult
parse-error számot.

**Hivatkozás:** kártya `26ab08a2`; `store/lint-ratchet.sh`, `store/lint-ratchet.selftest.sh`;
Cybersec NO-GO 21092, MikroB rendelkezések 21030 és 21035.

---

## 2026-09-06 -- 970156ce: a landolasi kapu csak SZANDEKOS leallitasra hallgathat el

**Dontes.** A `store/local-llm-model-routing.selftest.sh` ket, elo Ollamat igenylo esete
KIHAGYHATO, de KIZAROLAG akkor, ha a `gpu-crashloop-guard` SZANDEKOSAN maszkolta az
`ollama.service`-t -- amit a `store/.gpu-crashloop-guard-masked.json` artefaktum `units`
mezoje mond ki. Minden mas allapotban (nincs flag, mas unitot nevez meg, olvashatatlan
vagy hibas JSON) a teszt valtozatlanul PIROS.

**Miert nem az egyszeru env-gate.** A kezenfekvo alak ("az Ollama nem valaszol -> skip")
azt a kepesseget veszi el a kaputol, hogy megkulonboztesse a VEDETT gepet a TORTTOL. Ez
pontosan az a csendes kihagyas, ami ellen a 89f4c28d szandekosan URESEN tartja a
`store-selftests-all-run` EXCLUDED listajat. MikroB dontese (komment 21246, Cybersec
ellenvetesere): a feltetel SZANDEK legyen, ne elerhetoseg.

**A kotelezo negativ kontroll.** Uj teszt-fajl (`local-llm-guard-sanctioned-skip.test.ts`,
8 eset) rogziti a MEGENGEDO es a TILTO iranyt is, determinisztikusan (minden eset halott
loopback OLLAMA_HOST-tal fut, tehat nem fugg attol, hogy epp el-e az Ollama). Az elutasitott
env-gate mint mutans 7-bol 6 esetet buktat.

**Ket meres, ami menet kozben megvaltoztatta a megoldast.**
1. Az elso valtozat `$HERE`-bol olvasta a flaget. Az orzo az INSTALL store-jaba ir, a
   selftest viszont agens-WORKTREE-bol fut -- a flag lathatatlan volt, minden eset piros
   maradt, a javitas keszneek latszott es semmit nem valtoztatott.
2. A masodik valtozat a `local-llm-state-dir.sh` resolverjen at oldotta fel. Az viszont
   `LOCAL_LLM_STATE_DIR`-re elsobbseget ad, amit a teszt-suite WORKERENKENT beallit egy
   ures temp konyvtarra (4c5c540c, hogy a teszt-futasok ne irjanak az eles ledgerbe). Igy a
   flag-kereses pont ott vakult meg, ahol a javitasnak MUKODNIE kell: a fleet-test-ben. A
   selftest kezzel futtatva zold volt, a wrapper piros.

**A vegleges alak.** A resolver checkout-to-install szarmaztatasa hasznaljuk, de az `env`
aga NELKUL, egy PARANCS-BEHELYETTESITESBEN, ahol a valtozo unset. Igy a suite izolacioja
ebben a shellben erintetlen marad -- a selftest altali local-llm.sh hivasok tovabbra is az
izolalt konyvtart latjak --, es csak az UT jon vissza. Ellenorizve: a teljes suite-futas
utan az eles `store/local-llm-usage.log` valtozatlan (mtime 08:04, a futasok 11:07/11:09).
A ket valtozo ket kulon kerdesre valaszol: hol IRHAT ez a futas local-llm allapotot, kontra
hol ROGZITETT egy masik program egy dontest.

**Hivatkozas:** kartya `970156ce`; `store/local-llm-model-routing.selftest.sh`,
`src/__tests__/local-llm-guard-sanctioned-skip.test.ts`; MikroB 21246; kapcsolodo: d5c05548
(a mask() hiba), 1f276349 (ugyanez az osztaly a fork-guardon).

## 2026-09-06 11:40 -- bb52c2fa (helyesbítés) -- a cmp-táblázatom két sora nem önálló mérés volt

**Ez a bejegyzés a mai `bb52c2fa` bejegyzést helyesbíti.** A lelet és a javítás áll; a MAGYARÁZAT
két ponton túlmondott a mérésen, és mindkettő az én hibám.

**(1) Öt környezetről írtam, három létezik.** A bejegyzés így szól: „mérve, ugyanaz a két fájl, öt
környezetben -- unset -> byte, C -> char, C.UTF-8 -> byte, en_US.UTF-8 és hu_HU.UTF-8 -> char". Ezen
a gépen a `locale -a` HÁRMAT ad: `C`, `C.utf8`, `POSIX`. Az `en_US.UTF-8` és a `hu_HU.UTF-8` nincs
telepítve, a bash `setlocale: cannot change locale` figyelmeztetéssel visszaesik -- az a két sor
tehát a FALLBACK-et mérte, nem azt a locale-t, aminek a nevét viseli. Öt független mérésként
közöltem őket.

**A valós tábla:** unset -> „byte" (a LANG=C.UTF-8-at örökli); `C` -> „char"; `C.utf8` -> „byte";
`POSIX` -> „char"; egy érvénytelen érték -> „char" (C-re esik vissza).

**(2) A mechanizmus fordítva igaz.** Azt írtam, a cmp szóhasználata „nem követi, hogy a locale
bájt-orientált-e". Követi, csak az intuícióval ellentétesen: az EGYBÁJTOS locale-ok (C, POSIX, és
minden érvénytelen érték) mondanak „char"-t, a TÖBBBÁJTOSAK (C.UTF-8, unset) „byte"-ot.

**Amitől a lelet ÉLESEBB lett, nem gyengébb:** egy `byte`-ra szűkített minta MINDEN egybájtos
locale-ban törik, és ebbe beletartozik az `LC_ALL=C` -- a legvalószínűbb CI-beállítás. A `cmp -l`
ugyanúgy a helyes válasz: számot ad próza helyett, és a formátuma mind a négy tényleges környezetben
azonos.

**(3) „Zöld mind a hat próbált környezetben" -- helyesen négy** (unset, C, C.utf8, POSIX), amiből
három külön locale. A suite mind a négyben zöld.

**Miért külön bejegyzés:** a napló append-only, a hibás szöveg pedig már landolt (464ec279). Ugyanaz
az eljárás, amit a 79bb0364 „mindkét osztály megszűnik" mondatára alkalmaztam -- egy írott
műterméken álló állítás akkor is ellenőrizendő, ha a kód körülötte helyes.

**Hogyan derült ki:** Cybersec előre jelezte (24323), mit fog mérni a javításon, és a harmadik pontja
(„egy kapcsoló, ami sikeresen nem futtat semmit, ugyanaz a néma zöld") előre-méréséhez újrafuttattam
a saját bizonyítékomat. A locale-lista akkor esett szét. A három pontja egyébként mind teljesül: a
közvetlen és a locale-t pinnelő hívón átmenő verdikt mind a négy bemeneten egyezik, a `--- x`
kontroll mindkét úton safe marad, és az N-2 kapcsoló bukó `.py`-ra rc=1-et, hiányzóra rc=2-t ad.

**Hivatkozás:** kártya `bb52c2fa`, komment 21291; a helyesbített bejegyzés e fájl mai
`bb52c2fa` tétele.

## 2026-09-06 12:00 -- bb52c2fa (F-1/F-2) -- a verdikt mostantól abból következik, ami KIÍRÓDOTT, nem egy jelzőből, amit egy eset elfelejthet

**F-1, és a lelet az ÉN két tesztesetemre szól** (Cybered, komment 21305). Az előző körben két új
esetet vittem be, épp azért, hogy egy néma zöldet zárjak -- és mindkettő a `bad` változót növelte,
amit SEMMI nem olvas. A verdiktet a `fail` dönti. Következmény, mérve: a regressziót visszatéve a
futás kiírta a `FAIL ...` sort, majd azt mondta, hogy `selftest: PASS`, exit 0. A CI zölden ment
volna át pontosan azon a két regresszión, amiért az esetek készültek.

**És a mutációs bizonyítékom is ezt mérte félre.** A mutációs futásaimban a kiírt `^  FAIL` SOROKAT
számoltam, nem a verdiktet, ezért „M1 -> 1 piros, M3 -> 1 piros"-t jelentettem olyan esetekre, amik
valójában dekoratívak voltak. Ez ugyanaz a hibaosztály, amit ezen a kártyán másoknál jeleztem: a
mérőszám finomabb volt, mint amit a rendszer ténylegesen csinál.

**A javítás nem a két sor.** A két sor kijavítása ott hagyná ugyanazt a csapdát a következő esetnek.
A selftest mostantól FÁJLBA írja a kimenetét, a végén visszaadja, és a VERDIKT VISSZAOLVASSA: ha
bármely `  FAIL` sor kiíródott, a futás nem mondhatja azt, hogy PASS, bármit is állít bármelyik
jelző. Egy eset ezután elfelejtheti a jelzőt, és még mindig számít; azt viszont nem tudja megtenni,
hogy egy hibát belenyomtat egy zöld futásba. Sima átirányítás és `cat`, nem `tee` process
substitutionön át: az ellenőrzésnek egy teljesen kiírt fájlt kell látnia, egy pipeline pedig
alfolyamatba tenné a törzset, ahol a `fail` nem élné túl.

**F-2 -- a kód fejléce még a megcáfolt magyarázatot mondta.** A DECISIONS és a kanban-komment már
helyes volt, a fejléc nem: pontosan az a „a helyesbítés nem ér el a leszállított kommentig" alak. A
fejléc most a KÉT tényezőt mondja, és mindkettőt megmértem, nem vettem át:

**1. tényező:** a `local LC_ALL=C` csak akkor jut el a GYEREKFOLYAMATHOZ, ha az LC_ALL MÁR exportálva
volt. A bash `local`-ja örökli a meglévő export-attribútumot, de nem hoz létre újat. `declare -p`-vel
bizonyítva egy ilyen függvényen belül: környezetben nincs LC_ALL -> `declare -- LC_ALL="C"` (a gyerek
NEM látja); exportálva -> `declare -x LC_ALL="C"` (a gyerek LÁTJA).

**2. tényező:** a GNU cmp szóhasználata a locale KARAKTERSZÉLESSÉGÉT követi, a naiv tipp fordítottjaként:
egybájtos locale (C, POSIX, vagy bármely érvénytelen érték, ami C-re esik) -> „char"; többbájtos
(C.UTF-8, vagy az ambiens LANG, ha az LC_ALL nincs beállítva) -> „byte".

**A kettő együtt magyarázza a mérést, külön egyik sem:** LC_ALL nélkül a `local` sosem ért el a
cmp-hez, az a többbájtos ambiens LANG alatt futott és „byte"-ot mondott -- a régi minta működött.
BÁRMILYEN exportált értékkel a `local` elért a cmp-hez, az egybájtos C-ben futott és „char"-t
mondott, a minta semmit nem illesztett. Ezért tört el minden exportált értékre: sosem az számított,
MELYIK locale, hanem hogy exportálva volt-e egyáltalán.

**Mérés a javítás után:** a két korábban dekoratív eset mostantól `selftest: FAIL` + exit 1 a hozzájuk
tartozó mutációra (előtte PASS + exit 0). Az új invariáns külön próbálva: egy eset, ami kiírja a
FAIL-t de szándékosan NEM állítja a jelzőt, továbbra is FAIL-t és exit 1-et ad, plusz egy külön sort,
ami megmondja, hogy a verdikt kényszerítve lett. 70 eset, zöld.

**Hivatkozás:** kártya `bb52c2fa`; Cybered 21305 (F-1/F-2), MikroB 24390.

## 2026-09-06 -- c52e2823 (2. kör): egy elutasítás, amit nem lehet megítélni, kap saját szót -- `UNSUPERSEDED`

**Döntés.** A `store/gate-closure-check.py` mostantól három állapotot különböztet meg ott,
ahol eddig kettő volt. Egy gate elutasítása BLOKKOL (`FAILED`), ha az adott gate szerepét
viselő szerzőtől jött, vagy ha megnevez egy commitot. Nem blokkol, ha az adott gate maga
szólalt meg utána a leszállított shára. És sem nem blokkol, sem nem zárható
(`UNSUPERSEDED|<gate-ek>|<ki mondta>`), ha sha nélkül áll, és nincs mivel bizonyítani, hogy
egy későbbi PASS felülírta -- ez emberi/MikroB-döntés, nem automatikus visszadobás.

**A kényszerítő lelet.** Az 1. kör (bdb7375d) a testvér-gate elutasítását a per-szerző
táblából olvasta, és az MINDEN szerzőt tartalmazott, szemben a tükrével (`latest_by_role`),
ami mindig is szerepre szűrt. Emiatt bármely verdikt-ALAKÚ mondat -- a flotta rutinszerű
"<GATE> <VERDIKT> ELFOGADVA, vissza in_progress-be" nyugtázása, vagy egy építő "QA FAIL
elfogadva, javitottam" sora -- véglegesen beállt egy olyan elutasítás helyébe, amit a gate
maga már visszavont. QA mérte (21135), Cybersec függetlenül reprodukálta és tágabbnak
találta (21176): nem csak a koordinátoré, hanem minden nem-szerep-szerzős idézet.

**Miért nem elég a puszta szerep-szűrés.** Mert a nyugtázás állhat a gate saját utolsó
szava UTÁN is. Akkor a gate soha nem válaszolt rá, és a sor eldobása egy esetleg NYITOTT
elutasítás fölött zárná le a kártyát -- pontosan az az irány, ami ellen a 44849954-es
aszimmetria ("egy nem attribuálható elutasítás akkor is elutasítás") megszületett. A 21139
döntés ezért új szót kért, nem szélesebb szűrőt. Az e4b7096e kártya (azonos-szerep FAIL ->
PASS sha nélkül) ugyanennek a szónak a másik esete, ezért lett ide olvasztva.

**Ahol a megvalósítás ELTÉR a 21139 szövegétől, tudatosan.** A döntés szerint a relay-eset
MINDIG `UNSUPERSEDED`. A leszállított alak csak akkor, ha utána NEM szólalt meg maga a gate
a leszállított shára. Ha megszólalt, az pontosan az, amit a "felülírás" jelent, és egy
eldöntött történetre "eldönthetetlent" válaszolni négy LEZÁRT kártyát parkoltatna egy
embernek, akinek nincs mit eldöntenie. Az időrend tehát nem díszítés, hanem maga a
bizonyíték. Ez egy sor visszavétele, ha MikroB másképp dönt.

**Két fail-closed előfeltétel, hogy az új szó ne legyen átjáró.** Relay, ami mögött az adott
gate-től egyáltalán nincs verdikt -> változatlanul `FAILED` (nincs mihez mérni). Elutasítás,
ami MEGNEVEZ egy shát -> megítélhető, tehát meg is ítéli, változatlanul.

**Mérve az élő táblán, nem szintetikusan.** 348 kommentelt kártya, régi és új verzió egymás
mellett, minden változó válasz kézzel visszaolvasva a kártya saját verdikt-történetéből:
`008739a8`, `efaf8926`, `3ae71df1`, `b24b9e5c` FAILED -> AGREE (mindegyiken valódi,
szerep-szerzős, egy shára szóló újra-gate-elés áll a nyugtázás után), `4a6c47f0` FAILED ->
DISAGREE. Az utolsó NEM hamis blokk feloldása: ott a CYBERSEC GO a `d49e9c7a`-ra szól, a QA
PASS és a CYBERED GO a `901b6fbb`-re, és a két commit ténylegesen eltér az
`audit-ip-coarsen.ts`-ben -- a régi eszköz jó választ adott rossz okból. Populáció: 633
verdikt-alakú komment, 18 nem-szerep-szerzőtől, ebből 11 elutasítás 9 kártyán, mind
MikroB-tól. Az új szó ma EGYETLEN élő kártyán keletkezik (`2cb07372`), és ott egy olvasható
elutasítás megelőzi -- ez a precedencia (FAILED > UNSUPERSEDED) is pinelve van.

**Amit a tesztelés hozzátett a döntéshez.** A regresszió-mentesség a TELJES soron áll, nem a
verdikt-szón: egyedülálló valódi QA FAIL és tiszta pass bájtra azonos a korábbi kimenettel
(MikroB elfogadási feltétele, 21177) -- egy csak-fajta assertion zölden hagyna egy
átfogalmazott választ, ami minden olvasót eltör. Négy mutáns, négy különböző eset fogja meg.
Egy ötödik mutáns túlélte mind a 83 esetet, és kiderült, hogy elérhetetlen ág, nem
tesztlyuk: ha egy gate utolsó szava a saját elutasítása, ugyanaz a sor a `latest_by_role`-ban
is ott áll, tehát a passzoló előfeltétel már előbb elutasít. A sor kikerült, a viselkedést
pinelő eset maradt.

**Hivatkozás:** kártya `c52e2823` (magába olvasztva: `e4b7096e`); `store/gate-closure-check.py`,
`store/gate-closure-check.selftest.py` (83 eset), `CLAUDE.md` 4a. pont; QA 21135, Cybersec
21176, MikroB 21139 és 21177. Kapcsolódó: `71f95ba0` (az eszköznek nincs gépi fogyasztója,
tehát ez a javítás csak azt a zárást védi, ahol valaki elindítja).

## 2026-09-06 -- dc5b714d: az ügynök-config fájlok tulajdonos-csak jogosítást KAPNAK, nem megőriznek

**Döntés.** Minden per-ügynök konfigurációs fájl, amit az `agent-process.ts` ír, 0600-on áll,
akármilyen módban volt előtte. A kód nem ŐRZI a meglévő módot (az volt a korábbi
viselkedés), hanem KÉNYSZERÍTI a szűket. A hatókör FÁJLOSZTÁLYRA szól, nem egyetlen író
függvényre: `known_marketplaces.json`, `installed_plugins.json`, az ügynök `.env`-je, a
`.mcp.json` és a `.claude/settings.json` -- öt hívási hely, egy helperen (`writeAgentConfig`)
át.

**A kikényszerítő lelet.** Cybersec mérése (20627, 20643, 20654): a `writeJsonAtomic` a
`writeFileSync` `mode` opciójára támaszkodott, amit a umask szűkít, és a teszt ígérete
("preserves a deliberately wider mode too") EGYENESEN ELLENTMONDOTT a flotta
umask-keményítésének (`ensure-umask-dropin.sh`, `FLEET_UMASK:-0077`). Két landolt döntés nem
tartható egyszerre. MikroB döntése: a credential-hordozó config MINDIG 0600, tehát a TESZT
ígérete a hibás, nem a kód. Négy élő izolált config (jogász, marketing, pénzügy, videooo)
ekkor 0664-en ült, env-blokkokkal; a `.mcp.json` ugyanaz a tartalom-osztály, mint az
incidens, ami ezt a munkát elindította: egy ügynöké `env` blokkban hordozott API-kulcsot,
csoport- és világ-olvashatóan.

**Miért NEM a repó saját `atomicWriteFileSync`-je.** Az kivonná ezt a fájlosztályt a flotta
umask-politikája alól, tehát pont az ELLENKEZŐ irányba menne, mint amit a keményítés elérni
akart. Ez MikroB kimondott rulingja, és azért kerül a naplóba, mert egy későbbi, jó
szándékú "egységesítsük az írókat" refaktor pontosan ezt a sort vonná vissza.

**A két lépés két KÜLÖNBÖZŐ esetet fed, nem redundancia.** A `{ mode: 0o600 }` a LÉTREHOZÁS
pillanatát (ott a umask dönt), a rákövetkező `chmod` a MÁR LEMEZEN LÉVŐ fájlt (egy mode
nélküli írás nem nyúl a meglévő jogosultsághoz). A flotta pontosan a második állapotban
volt. Mérve: a `chmod` eltávolítása pontosan egy esetet (a REWRITE-ot) buktat, a `{ mode }`
eltávolítása EGYET SEM -- mert a chmod már megjavította a fájlt, mire bárki ránéz. A
`{ mode }` a létrehozás és a chmod közötti ABLAKOT zárja, és egy nyugalmi-állapot assertion
nem lát ablakot. A nyugalmi garancia tehát mérve van, az ablak érvelve, és a tesztfájl ezt
ki is mondja ahelyett, hogy egy zöld futás mindkettőt látszana fedni.

**NÉGY helyett ÖT, és a különbség tanulsága.** Az első jelentésem négy megkerülő írót
mondott. A kimaradt az `agents/<n>/.claude/settings.json`, aminek a BASENEVE egyezik egy már
javított fájléval, az ÚTJA nem -- két `settings.json` áll egymás mellett a lemezen. A KÓD
kezdettől mind az ötöt kezelte, a PRÓZA volt rövid, ezért a javítás a modul-kommentre és a
teszt fejlécére is kiterjedt, nem csak a kártyára: egy kártyán tett korrekció nem éri el a
leszállított kommentet.

**Amit a teszt strukturálisan véd.** A viselkedési esetek az öt hívási helyből hármat érnek
el; a másik kettő a spawn-úton él, amit a harness nem tud hajtani. Ezért egy forrás-szintű
darabszám-őr áll mellettük: csupasz `writeFileSync(` PONTOSAN kétszer szerepelhet, a két
helper belsejében. Az illesztés KOMMENT-MENTESÍTETT forráson fut (12. kódminőségi elv), két
kontrollal: egy hozzáadott valódi megkerülést lát, egy kommentbe írtat nem. Cybersec lappangó
F-3 lelete (az őr csak a nevesített import-alakot látja, a `fs.writeFileSync`-et nem)
tudatosan, nem-blokkolóként maradt nyitva.

**Hivatkozás:** kártya `dc5b714d` (a `75c2dbb7` folytatása); `src/web/agent-process.ts`,
`src/__tests__/agent-config-file-modes.test.ts`; Cybersec 20627/20643/20654/21127/21190, QA
21293. A négy élő fájl egyszeri remediációját (chmod 0600) MikroB végezte, mert
visszafordítható és a saját flotta-configjai.
## 2026-09-06 11:40 -- bb52c2fa (helyesbítés) -- a cmp-táblázatom két sora nem önálló mérés volt

**Ez a bejegyzés a mai `bb52c2fa` bejegyzést helyesbíti.** A lelet és a javítás áll; a MAGYARÁZAT
két ponton túlmondott a mérésen, és mindkettő az én hibám.

**(1) Öt környezetről írtam, három létezik.** A bejegyzés így szól: „mérve, ugyanaz a két fájl, öt
környezetben -- unset -> byte, C -> char, C.UTF-8 -> byte, en_US.UTF-8 és hu_HU.UTF-8 -> char". Ezen
a gépen a `locale -a` HÁRMAT ad: `C`, `C.utf8`, `POSIX`. Az `en_US.UTF-8` és a `hu_HU.UTF-8` nincs
telepítve, a bash `setlocale: cannot change locale` figyelmeztetéssel visszaesik -- az a két sor
tehát a FALLBACK-et mérte, nem azt a locale-t, aminek a nevét viseli. Öt független mérésként
közöltem őket.

**A valós tábla:** unset -> „byte" (a LANG=C.UTF-8-at örökli); `C` -> „char"; `C.utf8` -> „byte";
`POSIX` -> „char"; egy érvénytelen érték -> „char" (C-re esik vissza).

**(2) A mechanizmus fordítva igaz.** Azt írtam, a cmp szóhasználata „nem követi, hogy a locale
bájt-orientált-e". Követi, csak az intuícióval ellentétesen: az EGYBÁJTOS locale-ok (C, POSIX, és
minden érvénytelen érték) mondanak „char"-t, a TÖBBBÁJTOSAK (C.UTF-8, unset) „byte"-ot.

**Amitől a lelet ÉLESEBB lett, nem gyengébb:** egy `byte`-ra szűkített minta MINDEN egybájtos
locale-ban törik, és ebbe beletartozik az `LC_ALL=C` -- a legvalószínűbb CI-beállítás. A `cmp -l`
ugyanúgy a helyes válasz: számot ad próza helyett, és a formátuma mind a négy tényleges környezetben
azonos.

**(3) „Zöld mind a hat próbált környezetben" -- helyesen négy** (unset, C, C.utf8, POSIX), amiből
három külön locale. A suite mind a négyben zöld.

**Miért külön bejegyzés:** a napló append-only, a hibás szöveg pedig már landolt (464ec279). Ugyanaz
az eljárás, amit a 79bb0364 „mindkét osztály megszűnik" mondatára alkalmaztam -- egy írott
műterméken álló állítás akkor is ellenőrizendő, ha a kód körülötte helyes.

**Hogyan derült ki:** Cybersec előre jelezte (24323), mit fog mérni a javításon, és a harmadik pontja
(„egy kapcsoló, ami sikeresen nem futtat semmit, ugyanaz a néma zöld") előre-méréséhez újrafuttattam
a saját bizonyítékomat. A locale-lista akkor esett szét. A három pontja egyébként mind teljesül: a
közvetlen és a locale-t pinnelő hívón átmenő verdikt mind a négy bemeneten egyezik, a `--- x`
kontroll mindkét úton safe marad, és az N-2 kapcsoló bukó `.py`-ra rc=1-et, hiányzóra rc=2-t ad.

**Hivatkozás:** kártya `bb52c2fa`, komment 21291; a helyesbített bejegyzés e fájl mai
`bb52c2fa` tétele.

## 2026-09-06 12:00 -- bb52c2fa (F-1/F-2) -- a verdikt mostantól abból következik, ami KIÍRÓDOTT, nem egy jelzőből, amit egy eset elfelejthet

**F-1, és a lelet az ÉN két tesztesetemre szól** (Cybered, komment 21305). Az előző körben két új
esetet vittem be, épp azért, hogy egy néma zöldet zárjak -- és mindkettő a `bad` változót növelte,
amit SEMMI nem olvas. A verdiktet a `fail` dönti. Következmény, mérve: a regressziót visszatéve a
futás kiírta a `FAIL ...` sort, majd azt mondta, hogy `selftest: PASS`, exit 0. A CI zölden ment
volna át pontosan azon a két regresszión, amiért az esetek készültek.

**És a mutációs bizonyítékom is ezt mérte félre.** A mutációs futásaimban a kiírt `^  FAIL` SOROKAT
számoltam, nem a verdiktet, ezért „M1 -> 1 piros, M3 -> 1 piros"-t jelentettem olyan esetekre, amik
valójában dekoratívak voltak. Ez ugyanaz a hibaosztály, amit ezen a kártyán másoknál jeleztem: a
mérőszám finomabb volt, mint amit a rendszer ténylegesen csinál.

**A javítás nem a két sor.** A két sor kijavítása ott hagyná ugyanazt a csapdát a következő esetnek.
A selftest mostantól FÁJLBA írja a kimenetét, a végén visszaadja, és a VERDIKT VISSZAOLVASSA: ha
bármely `  FAIL` sor kiíródott, a futás nem mondhatja azt, hogy PASS, bármit is állít bármelyik
jelző. Egy eset ezután elfelejtheti a jelzőt, és még mindig számít; azt viszont nem tudja megtenni,
hogy egy hibát belenyomtat egy zöld futásba. Sima átirányítás és `cat`, nem `tee` process
substitutionön át: az ellenőrzésnek egy teljesen kiírt fájlt kell látnia, egy pipeline pedig
alfolyamatba tenné a törzset, ahol a `fail` nem élné túl.

**F-2 -- a kód fejléce még a megcáfolt magyarázatot mondta.** A DECISIONS és a kanban-komment már
helyes volt, a fejléc nem: pontosan az a „a helyesbítés nem ér el a leszállított kommentig" alak. A
fejléc most a KÉT tényezőt mondja, és mindkettőt megmértem, nem vettem át:

**1. tényező:** a `local LC_ALL=C` csak akkor jut el a GYEREKFOLYAMATHOZ, ha az LC_ALL MÁR exportálva
volt. A bash `local`-ja örökli a meglévő export-attribútumot, de nem hoz létre újat. `declare -p`-vel
bizonyítva egy ilyen függvényen belül: környezetben nincs LC_ALL -> `declare -- LC_ALL="C"` (a gyerek
NEM látja); exportálva -> `declare -x LC_ALL="C"` (a gyerek LÁTJA).

**2. tényező:** a GNU cmp szóhasználata a locale KARAKTERSZÉLESSÉGÉT követi, a naiv tipp fordítottjaként:
egybájtos locale (C, POSIX, vagy bármely érvénytelen érték, ami C-re esik) -> „char"; többbájtos
(C.UTF-8, vagy az ambiens LANG, ha az LC_ALL nincs beállítva) -> „byte".

**A kettő együtt magyarázza a mérést, külön egyik sem:** LC_ALL nélkül a `local` sosem ért el a
cmp-hez, az a többbájtos ambiens LANG alatt futott és „byte"-ot mondott -- a régi minta működött.
BÁRMILYEN exportált értékkel a `local` elért a cmp-hez, az egybájtos C-ben futott és „char"-t
mondott, a minta semmit nem illesztett. Ezért tört el minden exportált értékre: sosem az számított,
MELYIK locale, hanem hogy exportálva volt-e egyáltalán.

**Mérés a javítás után:** a két korábban dekoratív eset mostantól `selftest: FAIL` + exit 1 a hozzájuk
tartozó mutációra (előtte PASS + exit 0). Az új invariáns külön próbálva: egy eset, ami kiírja a
FAIL-t de szándékosan NEM állítja a jelzőt, továbbra is FAIL-t és exit 1-et ad, plusz egy külön sort,
ami megmondja, hogy a verdikt kényszerítve lett. 70 eset, zöld.

**Hivatkozás:** kártya `bb52c2fa`; Cybered 21305 (F-1/F-2), MikroB 24390.
---

## 2026-09-06 -- d5c05548: a maszkolas allitasat ELLENORIZNI kell, es a flag csak igazat mondhat

**Dontes (1. gyokerok).** A `gpu-crashloop-guard.sh` `mask_units()` mostantol MEGNEZI, hogy
a unit tenylegesen maszkolt-e (`UnitFileState`), nem a `systemctl mask` kilepokodet hiszi el;
ha a maszkolas nem fogott es egy VALODI unit-fajl all az uton, lefuttatja a kezi utat
(fajl felre `<unit>.real-unit-backup` nevre, `/dev/null` symlink, `daemon-reload`), majd
UJRA ellenoriz. Amit nem sikerult maszkolni, az nem kerul be a `MASKED_OK` listaba.

**Mert a vedelem hetek ota csak LATSZOLAGOS volt.** Eldobhato probe-unittal sajat kezuleg
reprodukalva ezen a hoston: `systemctl --user mask` regularis unit-fajl felett
"Failed to mask unit: File ... already exists"-et ad, exit 1, es a unit `static` marad --
`--force` ugyanezt. A regi kod ezt NAPLOZTA es tovabbment, majd kiirt egy allapot-flaget,
ami a unitot maszkoltkent nevezte meg. A szolgaltatas tehat csak le volt allitva, barmely
`systemctl --user start` visszakapcsolta a GPU-utvonalat. Egy or, aminek a hibamodja egy
megnyugtato naplosor, rosszabb, mint a semmi, mert senki nem megy utananezni.

**A flag mostantol a TENYT irja le, nem a szandekot.** A `units` mezo a `MASKED_OK`-bol
keszul; ha egyetlen unitot sem sikerult maszkolni, a flag NEM irodik ki (torlodik), es
azonnali riasztas megy ki arrol, hogy a gep NINCS vedve. Ez a mai naptol tetszik: a
970156ce ota ezt a fajlt a LANDOLASI KAPU olvassa, tehat egy hazudo flag arra vinne a
kaput, hogy elhallgasson egy valojaban vedtelen geprol.

**Egy harmadik hiba, amit a kartya nem nevez meg, es kimertem.** A `systemctl --user unmask`
ONMAGABAN NEM allitja vissza a unitot: eltavolitja a `/dev/null` symlinket es megall, a
valodi fajl pedig a `.real-unit-backup` nev alatt marad -- a unit `LoadState=not-found`
lesz, vagyis a szolgaltatas ELTUNIK. A helyreallito parancs ezert bekerult a riasztas
szovegebe (`restore_hint`), nem egy kanban-kommentbe, mert a tulajdonos a riasztast olvassa.

**A MELYEBB OK, es ezert wireoltam be a sajat suite-jat.** A `scripts/__tests__/*.test.sh`-t
SEMMI nem futtatja: nincs ra hivatkozas a `fleet-test.sh`-ban, a `package.json`-ban, egyetlen
vitest fajlban sem -- az egesz repoban ket emlites van a guard teszt-fajljara, a guard sajat
fejlece es maga a fajl. A 12 teszt tehat leirt kontroll volt, ami sosem futott le; ez a
`wired-detection-with-no-consumer` osztaly, ugyanaz, amit a `store-selftests-all-run`
(711a7e57, 2003e04b) zar a `store/*.selftest.*`-ra. SZANDEKOSAN SZUKEN: csak EZT a suite-ot
kotottem be. A teljes `scripts/__tests__` bekotese kulon kartya, mert az upstream sajat
merese szerint (#1200: "25 of our 29 script suites had never run, and two of them were red")
lesz kozottuk piros, es egy flotta-szintu landolas-blokk pont az, amit ma egesz nap tisztitottunk.

**A 2. GYOKEROK NEM KESZULT EL, SZANDEKOSAN.** A kartya azt keri, allitsam vissza a hianyzo
CPU-only drop-int (Layer 1). A premissza teves: nem eltunt, hanem PETI SZANDEKOSAN
eltavolittatta. A 13f92c99 kommit uzenete kimondja, hogy a drop-in "host-local, not versioned
here", a `wsl-vm-crashloop-ollama-gpu-dxgkrnl` memoria pedig ugyanarrol a naprol rogziti:
"Peti explicitly overrode the CPU-only stopgap -- he wants GPU as the PRIMARY path... Removed
the CPU-only drop-in, restored default GPU config." Kesobbi, ezt visszavono dontes nincs sem a
DECISIONS.md-ben, sem a tablan, sem a memoriaban. A visszaallitasa egy kimondott tulajdonosi
dontes visszaforditasa lenne (5. kodminosegi elv), raadasul a fo GPU-utvonal kikapcsolasaval.
MikroB ele vive; a guard fejlece viszont ma HAZUDIK, mert egy nem letezo Layer 1-re hivatkozik --
ennek a javitasa is az o dontesere var.

**Mérve.** Selftest 12 -> 22 eset. Ot mutacio, mind piros a sajat esetein: az ellenorzes
elhagyasa (6 bukas), a fallback kikapcsolasa (6), a flag visszairasa `UNITS`-bol (4), a
meglevo-backup vedelem torlese (1), es a helyreallito parancs kivetele a riasztasbol (1).
Az utolso ELSO valtozatban TULELT: a `(k)` eset a TELJES kimenetben kereste a
`real-unit-backup` szot, amit a `mask_one` sajat naplosora is tartalmaz -- az allitas
durvabb volt, mint a viselkedes, es igy a ket or kozul a rosszat rogzitette. Szukitve az
ALERT sorra, azota bukik.

**Hivatkozas:** kartya `d5c05548`; `scripts/gpu-crashloop-guard.sh`,
`scripts/__tests__/gpu-crashloop-guard.test.sh`,
`src/__tests__/gpu-crashloop-guard-suite-runs.test.ts`; kapcsolodo: 970156ce (a flag fogyasztoja).

---

## 2026-09-06 -- d5c05548 (2. kör): a fejléc egy nem létező rétegre hivatkozott, a flag pedig túlélte a döntést

**MikroB döntése (kártya-komment 21285) három ponttal bővítette a kártyát**, miután jeleztem, hogy
a 2. gyökérok premisszája téves. Mindhárom ebben a körben készült el.

**(a) A guard fejléce hazudott, és rossz irányba.** A fejléc magát "layer 2"-nek nevezte egy
CPU-only systemd drop-in (`ollama.service.d/10-cpu-only-gpu-crashloop-safety.conf`) mögött. Az a
drop-in szándékosan nincs meg: Peti 2026-08-24-én felülbírálta a CPU-only stopgapet, mert a GPU-t
akarja elsődleges útnak, és a drop-in eltávolításra került. Ma újramérve:
`/home/neon/.config/systemd/user/ollama.service.d/` nem létezik. Ez nem pusztán elavult szöveg volt:
aki azt mérlegeli, mennyire kell ennek az őrnek erősnek lennie, egy nála erősebb, mögötte álló
mitigációt hitt volna. Semmi nincs mögötte. Hogy kell-e új alsó réteg, az Peti döntése és külön
kártyán fut (MikroB nyitja), itt nem feltételezzük.

**(b) A flag túlélte a döntést, amit rögzített (Cybersec MEDIUM a 970156ce-n).** A flag nem
naplóbejegyzés, hanem állítás a gép MOSTANI állapotáról: a 970156ce óta a
`store/local-llm-model-routing.selftest.sh` két routing-esetet KIHAGY, ha a flag megnevezi az
`ollama.service`-t. A flaget viszont soha semmi nem törölte. Tehát abban a pillanatban, amikor egy
ember a valódi javítás után unmaskol -- az incidens dokumentált, várt vége --, a flag továbbra is
egy már nem létező maszkolást állít, és az a két eset ÖRÖKRE kimarad egy tökéletesen egészséges
gépen. Némán: egy skip skipnek látszik. Mostantól MINDEN ciklus visszaméri az állítást a systemd
ellen, és arra írja át a flaget, ami még igaz; ha semmi, törli. Ez a "nincs crash-loop" ágon is fut,
mert egy felépült gép attól kezdve mindig azon az ágon megy.

Két dolgot szándékosan NEM tesz. Nem fut `MASK_DRYRUN` alatt (egy száraz futás semmit nem maszkolt,
tehát nem törölhet egy valódi futás flagjét), és **egy olvashatatlan flaget nem tekint megcáfoltnak**:
amit nem tudunk elolvasni, azt nem tudjuk cáfolni sem, a törlése pedig némán visszakapcsolna egy
routing-esetet egy olyan gépen, amit lehet, hogy tényleg szándékosan tartanak lent. Ilyenkor marad,
és kimondja, hogy nem olvasható.

**(c) A helyreállítás kérdezhető, nem csak forráskommentben áll.** A `--restore-hint` alparancs a
flagből kiolvassa a megnevezett uniteket és kiírja a teljes parancsot, plusz kimondja, hogy a puszta
`unmask` NEM elég. A parancs bekerült magába a flag JSON-be is (`restore` mező), tehát az artefaktum
hordozza a saját visszavonását. Aki ezt keresi, incidens közepén van.

**Mérve.** 22 -> 35 eset. Hat mutáció, mind piros: a reconcile kiütése (5 bukás), a parse-hiba
törlésre fordítása (2), a `MASK_DRYRUN`-kivétel elhagyása (1), a "nem elég" figyelmeztetés kivétele
a `--restore-hint`-ből (1), a törlés elhagyása üres maradéknál (1), és a fejléc-regresszió (2).

**Egy eset ELSŐ változatban hamis okból volt zöld.** A `MASK_DRYRUN`-kontroll (`p`) nem adott át
hamis `systemctl`-t, ezért a guard az ÉLES hostot kérdezte az `ollama.service`-ről -- ami ezen a
gépen valóban maszkolt --, és a flag akkor is megmaradt, ha a kód rossz volt: a mutáns túlélt.
Hamis `systemctl`-lel, ami NEM maszkoltat jelent, az eset azóta bukik a mutánsra. Ugyanaz az osztály,
mint a `(k)` eseté az előző körben: a kontroll a saját környezetét mérte, nem a viselkedést.

**Kontroll a fogyasztón.** A `local-llm-model-routing.selftest.sh` az új `restore` mezőt tartalmazó
flaget változatlanul olvassa (3 passed, 0 failed, 2 skipped), tehát a bővítés nem töri a
970156ce-ben landolt fogyasztót.

**Hivatkozás:** kártya `d5c05548` (MikroB 21285, Cybersec 24349/21278); `scripts/gpu-crashloop-guard.sh`,
`scripts/__tests__/gpu-crashloop-guard.test.sh`; kapcsolódó: `970156ce`.

---

## 2026-09-06 -- 1b4cd700: egy LEÍRT szabály állt szemben egy kimondott Peti-döntéssel

**A döntés maga (Peti, 2026-09-04, Telegram, kártya 48565f81 komment 19504): NO-GO a MiniMax M3
adoptálására.** Indoklása szó szerint: a helyi LLM-modellek pontosan azért vannak, hogy a könnyebb
programozási feladatokat oda tereljük, és egy újabb fizetős online modell pont ez ellen a cél ellen
hatna, akkor is, ha olcsóbb a Claude-nál. Ez a döntés eddig KIZÁRÓLAG kanban-kommentben élt (SQLite,
nem grep-elhető) és a CLAUDE.md 16. szabályának indoklásában. A döntésnaplóban sehol nem szerepelt --
ezért kerül ide most, visszamenőleg, a saját jogán.

**A mai lelet (backend3, 2a6a7756/21168): a fork saját őre az ELLENKEZŐJÉT írta elő.** A develop-on
álló `fork-upstream-conflict-guard.test.ts` két bejegyzése így szólt:

- `src/web/agent-process.ts`: „adopt upstream's resolveProviderEnv() refactor wholesale (... plus
  adds minimax)"
- `src/web/routes/agents.ts`: egy szó szerinti olvasat „wrongly discard"-olna „two unrelated upstream
  additions: MiniMax direct-API gating in /api/models/available, and ..."

Mindkét mondat egy jövőbeli összefésülőnek azt mondja, hogy hozza be a MiniMaxot. A fork-őr prózája a
merge-idő tekintélye: nem kommentár, hanem az az utasítás, amit a következő ütközésnél végrehajtanak.
Tehát egy leírt szabály állt szemben egy kimondott tulajdonosi döntéssel, és a leírt szabály volt
kéznél. **Ez a `fix/provider-env-e80c011a-v2` ágon már 2026-09-04 óta javítva volt, csak nem landolt.**

**Amit ma eldöntöttem az összefésülésben.** Mindkét ütközésnél az ág JAVÍTOTT szabályszövege az
alany, és utána következnek a develop későbbi újramérései, amiket az ág már nem látott (09-03
`/rename`, 09-05 `clearInputBuffer` retry+verify, 09-06 MCP local-scope árnyékolás). Az
`agent-process.ts` kódütközésénél az ág refaktor-oldala nyert, DE csak azután, hogy leellenőriztem,
mi vész el: a develop időközben önállóan berakta az `OLLAMA_URL` escape-elését (1075d0e4) az inline
blokkba, és az ág `resolveProviderEnv`-je ezt már hordozza, a deepseek/openrouter kulcs- és a
b7fa5281 modell-escape mellett. A 1075d0e4 hivatkozás a függvény saját fejlécében fennmarad.

**Mérve, mert egy szabály-szöveg pinje pont olyan könnyen dekoratív, mint bármelyik másik.** Három
mutáció, mind piros: (a) a develop „plus adds minimax" mondatának visszaírása -> „no rule tells a
future merger that adopting minimax is safe" bukik; (b) a `routes/agents.ts` „wrongly discard ...
MiniMax" mondatának visszaírása -> „the SECOND door is shut" bukik; (c) egy `minimax-` ág
visszaadása a `resolveProviderEnv`-be -> két viselkedési eset bukik. Tehát MINDKÉT ajtó és a
viselkedés is ténylegesen zárva van, nem csak állítva.

**Egy elavult pin is javítva (`src/web/routes/kanban.ts`, 89423d29 -> e5d2e792).** Az upstream egy
`statusProbe` elő-ellenőrzést tett a dispatch-szövegbe: a fogadó ügynök nézze meg a kártya státuszát,
mielőtt nekikezd, mert egy foglalt session sorában késő üzenet már elavult kártyára érkezhet, és egy
késői második nekifutás párhuzamos munkát szül. **A probléma valós és ezt a forkot is érinti, de NEM
hiány itt:** a `src/web/kanban-state-stamp.ts` a küldés pillanatában `[card-state @send]`, a
kézbesítéskor `[card-state @delivery]` bélyeget tesz magára az üzenetre, a kártya státuszával és
azzal az utasítással, hogy olvasd újra a kártyát. Ez erősebb azon a tengelyen, ami a kimenetet
eldönti: a bélyeg EGYÜTT ÉRKEZIK az üzenettel és nem kér együttműködést, míg egy próba, amit az
olvasónak kell összeraknia és lefuttatnia, egy lépés, amit az olvasó ki tud hagyni.

**Hivatkozás:** kártya `1b4cd700` (backend3 lelete 2a6a7756/21168); `48565f81` (Peti NO-GO),
`e80c011a`, Cybered NO-GO 19877; `src/web/agent-process.ts`,
`src/__tests__/fork-upstream-conflict-guard.test.ts`, `src/__tests__/provider-env-adoption.test.ts`.

---

## 2026-09-06 -- 26ab08a2 (4. kör): egy nyugtázás, amit az ÁLLANDÓ kulcshalmaz ellen ellenőriztek, takaró

**Cybersec NO-GO (382755b3, HIGH, komment 21295) elfogadva, és a leletet FÜGGETLENÜL
reprodukáltam, mielőtt hozzányúltam.** Az `--accept-cleared=<szabályok>` kapcsoló azért kapott
nevesített alakot, hogy ne legyen takaró: mondd meg, MELYIK szabályt zártad le. A validáció viszont
a neveket a `set(baseline)` ellen nézte -- a baseline KULCSAI állandóak, csak az összeomlott
részhalmaz mozog. Ezért egy statikus, minden szabályt felsoroló lista örökre érvényes volt, vagyis
pontosan az a takaró, aminek a megelőzésére a nevesítés készült.

**Mérve a szállított szkripten (saját reprodukció, változatlan parse-számmal):**

```
  mindkét rácsos szabály sötét, kapcsoló nélkül            -> exit 3   (helyes)
  UGYANAZ a futás, --accept-cleared=<minden baseline-név>  -> exit 0   (a megkerülés)
  KONTROLL: EGÉSZSÉGES futás ugyanazzal a statikus listával -> exit 0   (semmi nem veszi észre)
```

**A harmadik sor dönti el.** A statikus lista egy egészséges futáson ÁRTALMATLAN, tehát elüldögélhet
egy wrapper-szkriptben örökre úgy, hogy semmi nem hívja fel rá a figyelmet -- egészen addig, amíg
egy nap a szabályok tényleg elsötétednek, és akkor átengedi azt a futást. A nevesítés csak hosszabbá
teszi a sort; egy elavult sort nem tesz bukóvá.

**Miért nem fogta meg a saját O3 tesztem.** Az O3 azt méri, hogy EGY név nem ment fel egy MÁSIKAT.
Ez igaz, és pontosan eggyel kevesebb, mint a kérdéses eset: egy lista, ami MINDET megnevezi. A
REVIEW-ban írt védelmem ("a lista minden alkalommal más, nem lehet vakon szkriptelni") a fenti
mérés szerint nem állt.

**A javítás:** a nevek ehhez a FUTÁSHOZ mérődnek, nem az állandó kulcshalmazhoz --
`cleared_now = {r | r != parse_key, baseline[r] > 0, counts[r] == 0}`, és `unknown = accepted_cleared
- cleared_now`. Ettől a statikus lista már az ELSŐ egészséges futáson elbukik, tehát nem tud csendben
megülni egy wrapperben.

**A vállalt árak, kimondva (Cybersec maga sorolta fel őket, egyetértek):** szigorúbb lett -- egy
megnevezett, de mégsem nullázott szabály mostantól hiba, nem no-op --, a hibaüzenet szövege
megváltozott („did not go to zero in this run"), és a `(parse-error)` többé nem nevezhető meg.

**Egy mutáció TÚLÉLTE az első körben, és ez lett a 35. eset.** A `parse_key` kizárásának törlése a
`cleared_now`-ból 34/34 zöldet hagyott: semmi nem rögzítette. Márpedig viselkedésben KÜLÖNBÖZIK --
a `(parse-error)` megnevezése inert elfogadássá válna, azaz a tool elvenne egy nevet és nem csinálna
vele semmit, ami pont az az osztály, aminek a megelőzésére az O4 eset létezik. Az O8 ezt zárja.

**Mérve.** 30 -> 35 eset. Két mutáció, mind piros a sajátján: a `set(baseline)`-re visszaállítás
NÉGY esetet buktat, a `parse_key`-kizárás törlése egyet (az O8-at).

**Hivatkozás:** kártya `26ab08a2`; Cybersec 21295 (R-A HIGH, R-B teljesítve);
`store/lint-ratchet.sh`, `store/lint-ratchet.selftest.sh`.
## 2026-09-06 13:00 -- bb52c2fa (G-1/G-2 + Cybersec F-2) -- a guard that closes a trap must not sit in the same one, and a run that dies must still say how far it got

**G-1 (Cybered, MEDIUM), and the finding is exactly right.** Last round's fix made the verdict read
the printed output back, so a case can forget its flag and still count. Nothing pinned THAT. The CI
wrapper asserts a PASSING run, and a passing run never enters the forcing branch, so the four lines
could be deleted with the suite still green -- the same trap the guard exists to close, one rung up.

**Measured as a differential, not asserted.** The same deletion applied to the LANDED script and to
the fixed one:

    landed (3af9d833), read-back deleted  -> selftest: PASS, exit 0   <- G-1 reproduced
    fixed,             read-back deleted  -> selftest: FAIL, exit 1

The verdict tail is now `_selftest_verdict <logfile> <flag>`, returning the verdict as an EXIT
STATUS, and three cases call it DIRECTLY with synthetic logs: a dirty log must be forced to fail, a
clean log must NOT be (the guard is not a blanket), and a clean log must not CLEAR a flag a case
already set (it may only add). The middle one is the negative control; without it the guard could be
replaced by an unconditional `fail=1` and the positive case would still be green.

**G-2 (Cybered, LOW): a mid-run death swallowed the entire output.** Stdout is redirected into a log
for the whole run, and the old EXIT trap deleted the temp directory holding it. Anything already
printed died with it. The trap now EMITS the log before removing the directory, through a still-open
fd 3. Measured with a simulated `kill -TERM` at the same point in both versions:

    landed  -> exit 143, 0 bytes to the caller
    fixed   -> exit 143, 4484 bytes, 71 lines

Ordering is load-bearing and it is ONE trap, not two: a second `trap ... EXIT` would replace the
first rather than chain. The normal path blanks `_selftest_log` after printing so the trap does not
repeat it.

**Cybersec F-2 (still open from 21309): my `cut` vs `awk` comment named the WRONG trigger.** It said
a LARGE offset arrives right-aligned and breaks a single-space `cut`. Measured, and Cybersec is
right: `cmp -l` right-aligns the offset COLUMN to the widest value in the run, so the padding lands
on the SMALL offsets, and only when a larger one appears in the same output.

    single difference at byte 20024  -> `20024 141 142`   cut [20024]  awk [20024]   cut WORKS
    differences at byte 1 and 20024  -> `    1 141 142`   cut []       awk [1]       cut BREAKS

**Why that is not cosmetic.** The comment is a specification for the regression case nobody had
written yet, and it named the fixture that does NOT reproduce. Anyone building from it gets a green
test blind to the class it was written for -- the third instance on this file of "the fixture could
not see the shape it was built out of".

**And the case IS worth adding even though the class is already covered.** Measured: reintroducing
`cut` turns SIX existing cases red today. That coverage is incidental -- those cases exist for
fences and UTF-8 offsets and merely happen to carry mixed-magnitude differences, so they can be
trimmed away and take the pin with them. One named case now states the property; under the `cut`
mutation the reds go 6 -> 7 and the named one is among them.

**One label constraint, recorded because it is a real constraint on future cases.** The CI wrapper
asserts the whole output does not contain the literal `FAIL`. That is coarser than it reads (the
real invariant is a line-anchored `^  FAIL`), and a passing line that merely SPELLS the word turns it
red -- which is what happened here first. Not loosened: an assertion that catches more is not the
thing to weaken while fixing an unrelated finding. The passing labels are worded around it, and this
paragraph is here so the next person does not rediscover it by breaking CI.

**Selftest: 70 -> 74 cases, green, exit 0.** Targeted CI test 3/3 green.

**Reference:** card `bb52c2fa`; Cybered 21325 (G-1, G-2), MikroB 21327, Cybersec 21337 (F-2).

## 2026-09-06 13:15 -- bb52c2fa (follow-up) -- "LC_ALL unset" is not a locale, and that makes the old bug WIDER

**Cybersec's refinement (21303), reproduced before adopting it.** Both my correction and Cybered's
treated "LC_ALL unset" as one row of a locale table. It is not a locale: it is delegation to LANG.

    LC_ALL unset, LANG=C.UTF-8 -> "differ: byte 4"
    LC_ALL unset, LANG=C       -> "differ: char 4"
    LC_ALL unset, LANG unset   -> "differ: char 4"

**Why this is a correction and not a detail.** Every previous statement of the defect -- mine, in
the code header and in this log -- said the `byte`-only pattern was fine with LC_ALL unset and broke
when something exported it. Measured, it ALSO broke on a host that simply has no LANG, with nothing
exported at all: the default state of a bare container. "Unset was fine" was true only because this
host's ambient LANG happens to be multibyte, which is an accident of the machine, not a property of
the code. The finding is wider than either of us had written, and in the direction that matters --
more environments were affected, not fewer.

Nothing about the FIX changes: `cmp -l` emits numbers and is locale-independent, which is why the
remedy was never a wider word list. What changes is the claim the shipped comment makes about the
old defect's blast radius, and a comment that presents EVIDENCE has to be right about the evidence.

**Reference:** card `bb52c2fa`; Cybersec 21303. Landed round: `e4345f9e`.

## 2026-09-06 13:20 -- upstream round 18 -- the acknowledged-conflict rule said the JSON-parse hardening was out of scope, and upstream landed inside it

**Fleet-wide landing block, and it was not caused by the diff that hit it.** My comment-only commit
`0fac5a36` was REFUSED by `marveen-land.sh` on the merge result: `fork-upstream-conflict-guard`
red, 1 of 15203. Measured on a disposable worktree at `origin/develop` (828880c1) with NO change
applied: the same test is red there too, 1 failed / 27 passed. So this was the base, not the diff --
the third time this year that distinction has decided whether a red is mine to fix or to route.

**What upstream did.** `src/web/routes/messages.ts` moved `98710db9e171..5f84469418f8`: a new
`notify?: boolean` on `PUT /api/messages/:id`, letting a closer suppress the reverse `[Eredmeny]`
ack. Their reason is measured, not stylistic -- the ack traffic lengthens the very queue whose delay
made a report late.

**Why this is a rule CORRECTION and not a pin bump.** The recorded rule ended with: the fork's other
additions "(reserved-sender guard, JSON-parse hardening, to-validation, card-state stamping) live in
separate regions and are not part of this decision". Upstream's `notify` validation landed EXACTLY in
the JSON-parse hardening region. There are now TWO conflict hunks where the rule describes one, and
the rule actively tells the next merger that the second one is out of scope -- so the most likely
resolution is the wrong one, arrived at by following the note.

**The consequence, measured rather than reasoned.** On `5f84469418f8` upstream's version is a BARE
`JSON.parse(body.toString())` with no try/catch. The fork's side wraps it and answers 400 on a
malformed body. Taking upstream's side wholesale on hunk 2 -- the natural reading of "not part of
this decision" -- DELETES the hardening and turns a malformed request body into an unhandled throw in
a request handler.

**Resolution recorded for hunk 2: keep BOTH, nested.** The fork's try/catch stays; upstream's notify
type-check goes INSIDE it. Upstream's check is itself worth having and is fail-closed on its own
terms (it rejects a non-boolean BEFORE the status write rather than coercing, so a truthy `"false"`
string cannot send the ack the caller asked to suppress). The point is nesting, not choosing. Hunk 1
(the GET-handler comment) is unchanged: identical code, keep the fork's comment.

**A note on what this guard is for.** It did its job precisely: it refused a landing because an
upstream side had moved out from under a recorded resolution. The failure mode it caught was not "the
blob changed" but "the rule now misdescribes the conflict" -- which is the more valuable half, and
the half a pure sha-equality check could never have surfaced.

**Reference:** upstream round 18; guard `src/__tests__/fork-upstream-conflict-guard.test.ts`
(`ACKNOWLEDGED_CONFLICTS` + `ACKNOWLEDGED_UPSTREAM_BLOBS`). Guard green 28/28 after the correction.

## 2026-09-06 13:25 -- ac28bc6e (f92671df 1/4) -- the live control and the history are different questions, so they get different stores

**The card asked for stuck-history as structured data. The survey changed what that means.** Plenty
about a CARD is already structured: `kanban_card_events` (status transitions) and
`kanban_card_field_events` (every other edit, including the title that carries the `[NN%]` marker),
both indexed on `(card_id, created_at)`. "When did it last move" and "how long has it been still" are
already derivable, and a parallel copy would be a second source of truth for a question that has one.

**What has no row anywhere is the INCIDENT**: the moment the heartbeat's D section JUDGED a card
stuck, what it saw, and what it decided. The last part is load-bearing. The shared token-protection
guard answers DENY on six grounds (progress, agent-busy, backoff, cap-reached, first-seen-baseline,
not-active), and every one is a DELIBERATE non-action that today leaves no trace at all -- in the log,
a control that decided to do nothing is indistinguishable from a control that never ran.

**THE DECISION, and it is a deliberate refusal of the literal ask.** `store/redispatch-ledger.json`
already counts re-dispatches per card, and `redispatch-guard.sh reset <cardId>` DELETES the entry --
which working rule 4 requires on every close. So the count is destroyed exactly when the incident
would become history. I did NOT convert that file into a history store. Its behaviour is CORRECT for
what it is: a live backoff BUDGET. A history that never reset would leave a once-stuck card at the cap
forever, and the guard would refuse to re-dispatch it again -- fixing the reporting question by
breaking the control. The two stay separate, the same split `kanban_card_field_events` documents for
its own separation from `kanban_card_events`.

**ONE STALL IS ONE ROW, enforced by a unique PARTIAL index** (`WHERE resolved_at IS NULL`). The D
section runs every 10 minutes, so without it an hour-long stall becomes six rows and "how often did
this card get stuck" measures the HEARTBEAT FREQUENCY, not the stalls -- a number that looks like data
and is not. Re-observation bumps `detections` on the open row instead.

**Append-only enforced by TRIGGER, not by convention.** The rows that historically went wrong in this
schema came from agents writing directly with the sqlite3 CLI, where a TypeScript-side guard is not
in the path (the timestamp-integrity block in db.ts documents that history). The trigger also refuses
to UN-resolve: clearing `resolved_at` would reopen a closed incident and let a second open row exist
under the unique index, quietly breaking one-stall-one-row from the other direction.

**Rule 11: the DOWN path is exercised, not assumed.** Dropping the table is tested, and so is
drop-then-redeploy -- including that the TRIGGER returns with the table, since a rollback that
restored the table without it would look identical until the first tampering write. The persistence
cases run against a temp FILE, not `:memory:`: `initDatabase(':memory:')` opens a NEW database each
call, so "drop it and re-run the schema" on memory would silently test a fresh DB and prove nothing.

**Mutation evidence, each guard caught by a different set:** trigger deleted -> 4 red; unique partial
index -> plain index -> 1 red; partial index -> unconditional unique -> 1 red. The third is the
negative control earning its place: without `WHERE resolved_at IS NULL` a card could only ever be
stuck ONCE in its life, and the card's own repeat question would be unanswerable.

**Reference:** card `ac28bc6e` (parent `f92671df`); survey comment 21393. 15 tests, green.

---

## 2026-09-06 -- d5c05548 (3. kör): „nem tudom megkérdezni" nem azonos azzal, hogy „nincs maszkolva"

**Cybersec F-1/F-2 (GO e2be6386 mellett, két MEDIUM, egy gyökér) elfogadva, és a leletet a
javítás előtt magam reprodukáltam.** A `unit_is_masked()` egy sztringet hasonlít a `masked`
értékhez, tehát az ÜRES válasz -- nincs user bus, a user manager még nem áll, a systemctl hiányzik,
a unit eltűnt -- pontosan úgy olvasódik, mint a „nincs maszkolva". Mérve: egy `Failed to connect to
bus` hibával 1-gyel kilépő systemctl mellett a kimenet üres, az összehasonlítás hamis, és ez
megkülönböztethetetlen egy élő, nem maszkolt unittól.

**Két döntés született ebből a hamis válaszból, és a második a súlyosabb.** A `mask_one` félretette
volna a valódi unit-fájlt és kirakta volna a `/dev/null` symlinket, majd azt jelenti, hogy SEMMIT
nem maszkolt -- a szolgáltatás a lemezen maszkolva, a riasztás szerint a gép védtelen, és a
`.real-unit-backup` létezését semmi nem rögzíti. A `reconcile_masked_flag` pedig a `main()` ELSŐ
lépése, MINDEN futáson fut, és TÖRLI egy valóban maszkolt gép flagjét, azt naplózva, hogy „none of
[ollama.service] is masked any more". Ez nem gyógyul magától: a flag egyetlen írója a `mask_units`,
ami csak friss crash-loop észlelésekor fut.

**Élő reprodukció a javítás előtt** (a unit a lemezen `/dev/null` symlink, tehát ténylegesen
maszkolt; a systemctl nem válaszol): a flag ELTŰNT, a napló pedig egy hamis állítást írt ki.

**A gyökér a saját elvem, egyetlen bemenetre alkalmazva.** A fájlban három függvénnyel feljebb ott
áll a helyes szabály a MÁSIK bemenetre: „an unreadable claim is not a refuted one" -- az
olvashatatlan FLAG-ről írva. A megválaszolhatatlan SYSTEMD ugyanaz az alak, és nem kapta meg. Két
bemenet, egy elv, egy védve. Cybersec ezt pontosan így nevezte meg, és előre kimondta az
összeférhetetlenséget is: a flag-visszamérés az ő javaslata volt (970156ce), tehát az F-2 az ő
specifikációjának a hiányossága -- ugyanaz a kvadráns-kihagyás, amit ott már egyszer elkövetett.

**Miért több ez higiéniánál.** A flag hiánya PONTOSAN az a jelzés, hogy a gépet SZÁNDÉKOSAN tartják
lefogva. Ennek a jelzésnek a hiánya vitte oda egy másik ügynököt, hogy ötször újraindítsa az
ollamát a guard alatt. Mért precedens ebben a flottában, nem feltételezés.

**A javítás:** `unit_state_unknown()` predikátum (nem nulla kilépőkód VAGY üres érték), és mindkét
hívó rá van kötve -- a `mask_one` nem mozgat fájlt ismeretlen állapotnál, a `reconcile` pedig az
ELSŐ ismeretlennél érintetlenül hagyja az egész flaget. Az első ismeretlennél való kilépés
szándékos: egy félig válaszoló systemd alapján részlegesen átírni a flaget új állítás lenne
ugyanabból a bizonytalanságból.

**A teszt-oldali hiányt Cybersec kimondta, és igaza volt:** a hamis systemctl MINDIG válaszolt,
tehát a „nem tudom megkérdezni" ágnak NULLA fedezete volt -- ezért szállíthatott a defekt. Négy új
eset ad neki fedezetet.

**Egy mutáció TÚLÉLTE, és mérésre küldött.** A csak-kilépőkód változat 43/43 zöldet hagyott.
Megmértem az ÉLES systemctl-t: egy általa nem ismert unitra 0-val lép ki és SEMMIT nem ír ki. Tehát
az `exit 0 + üres` alak a termelésben elérhető, és egy csak-kilépőkódos ellenőrzés egy eltűnt unitot
élő, nem maszkolt unitnak olvasna és törölné a flaget. A rögzített döntés: ilyenkor MARAD a flag --
egy eltűnt unitról nem lehet megállapítani, hogy nincs maszkolva, a dokumentált visszaállítás pedig
valódi unit-fájlt tesz vissza (`static`, nem üres), tehát a szokásos gyógyulás az (m) eseten
keresztül továbbra is töröl.

**Mérve.** 35 -> 44 eset. Négy mutáció, mind piros a sajátján: a predikátum kiütése (6 bukás), a
`reconcile` őrének elhagyása (4), a `mask_one` őrének elhagyása (2), és a csak-kilépőkódos alak (1,
az új (v) eset).

**Hivatkozás:** kártya `d5c05548` (Cybersec 21348, F-1/F-2); `scripts/gpu-crashloop-guard.sh`,
`scripts/__tests__/gpu-crashloop-guard.test.sh`; kapcsolódó: `970156ce`.

## 2026-09-06 13:40 -- A Gate-SHA soron a POZÍCIÓ dönti el, mi számít idézett shának (kártya a20f0aa7)

**Döntés:** A `kanban-gate-completeness-guard.ts` kör-határ számításában egy hex futam NEM idézett
commit, ha az őt tartalmazó, szóközzel határolt tokenben van `/` ÉS a token valamelyik `/`-szegmense
nem maga is csupasz sha. A `merge-base` bekerül a szülő-marker listába; az `alap`/`base` KIMARAD.

**Miért:** Az 5bc8f740 hamis 409-ét ("QA verdikt hiányzik") két alok okozta egyetlen soron:
`Gate-SHA: 8b8377cf (CleanCore, ag fix/platform-admin-append-tail-5bc8f740, merge-base 0d5ebb6c)`.
A `5bc8f740` a KÁRTYA SAJÁT ID-je az ágnév végén, és egy kártya-ID nyolc hex karakter, alakra
megkülönböztethetetlen egy rövid shától; a `0d5ebb6c` pedig definíció szerint ős. Mindkettő KÉSŐBB
"vezetődik be", mint a valódi QA PASS, ezért a `Math.max` a kör-határt a QA verdiktje utánra húzta.

**Két javaslatot MÉRÉS alapján elutasítottunk:**
1. "A token-gyűjtés álljon meg az első zárójelnél" -- ezt a fájl saját dokumentációja már cáfolja
   (367c23a9): a d0b4f003 három gate-je zárójelen BELÜL idézte a kör saját shait.
2. "Az `alap`/`base` is kerüljön a szülő-marker listába" -- ugyanaz az ok; ezek valódi
   társ-idézések, nem ősök.

**A szabály maga is KÉTSZER szűkült, mindkétszer egy mért téves eldobás miatt** (3301 valós
Gate-SHA sor): a szomszédos karakterre kulcsolás elvesztette a backtickbe tett (`3dcbbefc`) és a
magyar toldalékos (`a21e5528-on`) idézést; a puszta "van benne `/`" szabály pedig elnyelte a
`89665d8a/06200298` alakot, ami nem útvonal hanem a flotta "mindkét commit" idiómája, és ezzel egy
valódi QA2 verdiktet érvénytelenített a 67807f6f-en.

**Mérés a végleges szabályra:** 60 sor változik 3301-ből (55 ágnév/útvonal, 7 merge-base, nulla
megmagyarázatlan, nulla új token); 8 kártya kör-határa mozdul; 6 gate-verdikt válik elavultból
frissé és MINDEGYIK a saját köre targy-sháját nevezi meg; 0 válik frissből elavulttá. A hatból
ÖTNÉL a javítás előtti "legújabb sha" maga a kártya ID-je volt, tehát az 5bc8f740 nem egyedi eset.
A négy korábbi, ebben a fájlban már javított incidens (d0b4f003, 4ae2d3f5, d4a2130d, 67807f6f)
mind változatlan. A szállított TypeScript kimenetét a mérő modellel összevetve 3312 soron 0 eltérés.

**Ki döntött:** backend2 (mérés és javaslat), MikroB jóváhagyta (24490). Az eredeti gyökér-okot
backend mérte ki és adta át (24352).
**Hivatkozás:** kártya a20f0aa7; a mérés a kártyán, a kód `src/web/kanban-gate-completeness-guard.ts`.

## 2026-09-06 -- 48b0dd36: a landolási kapu a verdikt SZERZŐJÉT is nézi, de csak a PASS oldalon

**Kontextus.** A `landing-gate-verdict-parse.py` az a fél, amelyik ténylegesen ENGEDI vagy TILTJA a
pusholást (a `gate-closure-check.py` csak tanácsot ad egy sorban, ember dönt). Ez az eszköz eddig a
verdikt SZÖVEG-ALAKJÁBÓL hitelesített: az `author` mezőt kiírta az üzenetbe, de a döntésbe sosem
vette be. Vagyis egy `QA PASS` kezdetű, `Gate-SHA:` sort vivő komment BÁRMELY szerzőtől kielégítette
a 4. szabály kötelező QA-követelményét -- a készítő aláírhatta a saját munkáját azzal, hogy leírja a
szavakat. Cybersec mérése a c52e2823 zárásakor (24365).

**Döntés, és a lényeg az ASZIMMETRIA.** Egy PASS csak akkor számít, ha a szerző szerepe egyezik
azzal a gate-tel, amit a verdikt ÁLLÍT magáról (`author_role(szerző) == a verdikt-szó szerepe`). Egy
FAIL viszont SZÁNDÉKOSAN nem szerző-ellenőrzött: aki leírja, attól áll. Nem attribuálható PASS nem
PASS; nem attribuálható ELUTASÍTÁS viszont attól még elutasítás. Ha a szerző-ellenőrzés a FAIL-re is
állna, kiesnének a közvetített elutasítások -- MikroB `<GATE> <VERDIKT> ELFOGADVA` nyugtázása a
tábla rutinszerű alakja --, és egy landolás átmenne egy kimondott NO-GO fölött. Az szigorúan
rosszabb, mint a betömött lyuk.

**Ez NEM autentikáció, és nem is állítja magáról.** A kanban API a szerzőt a kérés TÖRZSÉBŐL veszi,
egyetlen közös Bearer token alatt, tehát bárki posztolhat bárkinek a nevében. A szerző-ellenőrzés a
gyengébb, de olcsó állítás: egy verdikt, ami még csak nem is ÁLLÍTJA, hogy a gate-től jön, nem annak
a gate-nek a verdiktje. A tényleges hitelesítés külön kártya tárgya lenne (per-ügynök token), ez
nem az.

**Új válaszszó: `UNVERIFIED-AUTHOR`.** Nem `OK` (nem landolhat) és nem `FAILED` (nem elutasítás,
amit vissza kell dobni): a shát megnevezte valami verdikt-alakú, és az ok, amiért nem számít, az,
hogy KI írta. A burkoló (`landing-gate-verdict-check.sh`) a prefixből dönt és csak az `OK` ad 0-t,
tehát egy új szó fail-closed a szerkezetéből adódóan -- ezt külön eset rögzíti, mert a
"szerkezetéből adódóan" pont az az állítás, ami egy szerkesztés után elromlik.

**A szerep-tábla KÖZÖS modulba került (`store/gate_author_role.py`), nem másolva.** A szabály eddig
csak a tanácsadó olvasóban élt; a másolás mára megoldotta volna, és az első aliasnál, amit valaki az
egyik fájlba felvesz és a másikba nem, újranyitná. A `gate-closure-check.py` mostantól onnan
importál (a `GATES` is onnan jön), így a következő testvér-szerep egy helyen kerül be.

**Mérés a döntés mellé (élő tábla, 2026-09-06):** 439 kártya, 651 verdikt-alakú első sor (560 PASS,
91 FAIL). Nem-szerep szerzőtől 7 PASS és 13 FAIL, és ezek közül EGY SEM visz `Gate-SHA:` sort, tehát
egyikük sem ér el a döntésig. A változtatás MA nulla verdiktet fordít meg -- ezért volt MEDIUM és nem
HIGH, és ezért maradt a meglévő 27 selftest-eset mindegyike bit-re ugyanazzal a válasszal. Az irány
rögzítése a cél: az első nem-szerep szerző, aki egy `Gate-SHA` sort is odaír, ma landolna.

**Hivatkozás:** kártya `48b0dd36` (Cybersec MEDIUM a c52e2823-on, 24365);
`store/landing-gate-verdict-parse.py`, `store/gate_author_role.py`,
`store/gate-closure-check.py`, `store/landing-gate-verdict-check.selftest.sh` (27 -> 36 eset).

## 2026-09-06 14:00 -- A flotta által kiváltott /compact megmondja, mit NEM szabad átfogalmazni (kártya fed3f037, (a) rész)

**Döntés:** A `POST /api/agents/<n>/compact` végpont nem csupasz `/compact`-ot küld, hanem
instrukciót is: szó szerint tartandó minden Peti/MikroB utasítás és tiltás, az aktív kártyák
követelményei, a még nyitott gate-leletek, a meghozott döntések a mögöttük álló méréssel, a nyitott
kérdések és a már jelentett Gate-SHA-k; szabadon tömöríthető a tool-kimenet, a fájltartalom és az
ügynök saját elbeszélése. Kill switch: `COMPACT_PROMPT=bare` visszaadja a régi literált.

**Miért:** A hermes-agent micro-compaction leírásának (MIT, referenciaként olvasva, kód nem átvéve)
egyetlen olyan megfigyelése, ami RÁNK IS áll: soha nem tömöríti a felhasználó üzeneteit, csak a
levezetett anyagot. Az indoklás a mi hibaosztályunk pontos megfogalmazása: amit az ügynök termel, az
nagyrészt beszámoló arról, mit csinált, és ez kevés veszteséggel összefoglalható; az utasítás viszont
az a szándék, amiből minden más levezetődik, és NEM rekonstruálható az utána következő munkából.

**Amit ELVETETTÜNK, méréssel:** magának a mechanizmusnak a portolása (MikroB plan-grilling verdikt).
Egy körönkénti micro-compaction átírja a már elküldött előzményt, tehát minden körben töri a
prompt-cache prefixet; ennél a flottánál a cache-találati arány 98,4%, és a tényleges költség a
49,3 milliárd cache-read token. Ez pontosan az az eset, amit a forrás doksi maga nevez meg
veszteségesként, és amiért upstream is `off by default`.

**Kockázat és kezelése:** ez flotta-szintű változás egy kritikus úton, ezért a 9. kódminőségi
szabály szerint kapcsolóval visszavonható commit nélkül. A `/compact` továbbra is a sor ELEJÉN áll,
mert a Claude Code csak akkor ismeri fel slash-parancsként; a szöveg egyetlen sor.

**Ki döntött:** MikroB (plan-grilling verdikt, 21407), backend2 (mérés és megvalósítás).
**Hivatkozás:** kártya fed3f037 (a) rész; `src/web/routes/agents.ts`.
## 2026-09-06 13:30 -- ac28bc6e CORRECTION -- the guard has NINE deny reasons, not six, and one carries a payload

**Correcting my own entry above, which said "six grounds".** I took that list from the heartbeat
D-section prose instead of from the script. Counted from `store/redispatch-guard.sh` itself, every
one a live code path with its emitting line:

    DENY:not-active (24)   DENY:load-paused (25)   DENY:progress (27)
    DENY:agent-busy (29)   DENY:cap-reached (30)   DENY:backoff (33)
    DENY:usage (213)       DENY:card-not-found (215)   DENY:first-seen-baseline (239)

The prose documents six of them. `load-paused` is a genuine policy denial it omits (the agent is
cgroup-throttled or SIGSTOP-frozen, deliberately not running); `usage` and `card-not-found` are the
error paths.

**Why this is not a detail.** The writer in subtask 878cd292 records what the guard decided. Built
from the prose, three of nine branches would never have been logged -- which is precisely the "a
deliberate non-action leaves no trace" hole this whole table exists to close, reproduced inside its
own fix. The class is the one I have hit repeatedly today: a query (here, a paragraph) that answers a
different question than the sentence quoting it claims.

**And one reason is not a constant.** The script emits `DENY:backoff:<seconds>`, not a bare
`DENY:backoff`. A writer equality-matching a known-reason list would classify every backoff denial as
unknown. `action_detail` therefore stores the verdict VERBATIM, and any classification is by PREFIX
-- which is also why the column is free text that accepts an unrecognised reason rather than
rejecting it.

**Not fixing the prose here.** The heartbeat SKILL.md is a global scheduled-task file and its
accuracy is a separate concern from this schema; naming the discrepancy is this card's job, changing
a fleet-wide task definition is not. Reported to MikroB.

**Reference:** card `ac28bc6e`; corrects the `2026-09-06 13:25` entry in this file.

## 2026-09-06 13:32 -- ac28bc6e SECOND CORRECTION -- I corrected prose by reading other prose

**My 13:30 correction is itself wrong on one point, and the way it is wrong is the point.** It said
the guard emits `DENY:backoff:<seconds>`. I took that from the guard's HEADER COMMENT (line 33)
instead of from the code, having just corrected a different claim I had taken from the heartbeat
prose. Two corrections, same root, one level apart.

**Measured this time -- from the echo sites, plus live probes:**

    header comment claims:  DENY:backoff:<s>            (colon)
    code actually emits:    DENY:backoff(<n>s)          (parentheses)
    and two more carry payloads the header never mentions:
                            DENY:not-active(<status>)   DENY:cap-reached(<count>)
    live probe, real cards: `DENY:progress`, `DENY:card-not-found`

So THREE of the nine carry a payload, not one, and the separator is `(`, not `:`. The guard's header
comment disagrees with the guard's own code.

**The design consequence is concrete, not cosmetic.** A writer that equality-matches a known-reason
list drops three of nine. A writer that prefix-matches `DENY:backoff:` -- exactly what my previous
entry would have produced -- drops backoff as well, and backoff is the MOST common denial in a real
stall, since it fires on every re-observation inside the window. The remedy is unchanged in shape but
now correct in detail: store the verdict VERBATIM, and take the reason as the text up to the first
`(` or `:`. No list in this repo needs to stay in sync with a script it does not own.

**The lesson, stated plainly because I keep paying for it.** "Read the schema, not the comment about
the schema" applies to the correction too. When the first source turned out to be prose, the fix was
to MEASURE, not to find better prose. Both wrong claims would have passed review: they were specific,
plausible, and cited a real file.

**Reference:** card `ac28bc6e`; corrects the `2026-09-06 13:30` entry, which corrected the `13:25` one.

## 2026-09-06 13:40 -- bb52c2fa -- the correction reached the header and not the SECOND copy 90 lines down

**Cybersec F-1, round 2 (21395), and the shape is the one this card family keeps producing.** The
refuted locale explanation was corrected in the function header. The SAME text also stood at line
~1789, in the selftest, and there it was not a superseded precedent -- it was the JUSTIFICATION for
the assertion directly beneath it.

**Why the old explanation is wrong, refuted by its own list.** It said the suite went 61/67 "because
cmp's MESSAGE says char in some locales and byte in others". If that were the cause, exporting
C.UTF-8 -- which IS multibyte, and under which cmp says "byte" (measured on this host) -- should have
WORKED. It broke too. The listed evidence contradicts the stated cause.

**The real mechanism, already stated correctly 90 lines above it:** `local LC_ALL=C` reaches the
child only when LC_ALL already carries the export attribute, which it does the moment anything
exported it. cmp therefore ran under single-byte C whatever value was exported, said "char", and the
byte-only pattern matched nothing. The specific locale never mattered -- only whether one was
exported at all.

**The lesson is not "fix the comment".** It is that a correction lands where you are looking. I
corrected the header, verified the header, and reported the header as fixed -- while a second copy of
the same claim sat in the same file doing more damage than the first, because it was load-bearing for
an assertion rather than being narrative. Next time a refuted claim is corrected, grep the file for
its DISTINCTIVE PHRASE, not just the section that prompted the correction.

**Reference:** card `bb52c2fa`; Cybersec 21395. Selftest 74 cases, green.

## 2026-09-06 13:45 -- upstream round 18 follow-up -- the resolution is pinned by a TEST, not only by the note

**Cybersec supplied something I did not claim, and it makes the round-18 fix stronger.** My
`ACKNOWLEDGED_CONFLICTS` correction told the next merger what the right resolution is. It did not say
whether anything would STOP them getting it wrong. There is: the fork's JSON-parse hardening has a
behavioural pin.

**Re-measured here before adopting it, not taken from the report:**

    origin/develop, untouched                              6/6 GREEN
    PUT try/catch replaced with upstream's bare parse       2 FAILED  <- "take upstream wholesale"
    control: an inserted comment                           6/6 GREEN

`src/__tests__/messages-invalid-json-400.test.ts` covers both handlers. So a merger who ignores the
note and adopts upstream's side of hunk 2 hits failing tests rather than a silent loss of a 400. That
is the state Cybered's doctrine asks for -- prose AND a red test, never prose alone -- and the rule
now says so, because "a note is all that stands between you and this mistake" and "you will also get
red tests" are different instructions to the person reading it at 2am.

**It also settles why the refuted sentence is LABELLED rather than deleted.** The next merger goes
looking for the sentence they followed last time; finding it struck through with the correction
attached is more useful than finding it gone.

**A note on how the confirmation arrived, because the failure mode is one I hit twice today.**
Cybersec's FIRST probe grepped the literal string `'Invalid JSON body'` across the tree, found zero
test hits, and was one sentence from reporting that only prose protects the hardening. The test
asserts `/invalid json/i`, a regex -- so the grep answered a different question than the sentence
would have claimed. The mutation settled it; the grep could not have. Same class as my own
DECISIONS-heading miscount and my six-versus-nine deny count today: three instances, two agents, one
shape -- an artifact queried where it was convenient rather than where the fact lives.

**Reference:** upstream round 18; Cybersec message 24509; guard green 28/28 after the addition.
## 2026-09-06 -- 09a3d52a: a redispatch-guard főkönyve zár alatt ír, és a zár HIÁNYA tilt, nem enged

**Kontextus.** A `store/redispatch-guard.sh` az a közös fojtópont, amin minden automata meglökés és
újra-dispatch átmegy, és a `MAX_REDISPATCH=3` sapkával ez akadályozza meg a dokumentált token-égő
hurkot ("ugyanaz a kártya 18-szor fejlődött"). Az állapota a `store/redispatch-ledger.json`.

**A hiba.** A `_ledger_get` és a `_ledger_set` két külön python-folyamat, és a set a TELJES fájlt
írja vissza a saját pillanatképéből. Két egyidejű futás tehát nem egy számlálót veszít: a vesztes
felülírása a MÁSIK kártya bejegyzését ejti ki, vagyis annak a kártyának a re-dispatch-számlálója
nullázódik, és a sapka soha nem áll fel. Pont az a korlátlan hurok válik újra lehetségessé, ami
miatt a guard megszületett.

**A mérés, és amit NEM állítok.** A szkriptből KIVÁGOTT valódi két függvénnyel, 30 kártya-azonosítóra:
párhuzamosan 27, 28, 29, 29, 29 bejegyzés maradt meg öt futásban (fal-idő 0,30-0,37 mp), sorosan
30/30 (1,59 mp). A soros kontroll átfordul, tehát a mérés a versenyt méri. Elérhetőség MA: a `check`
egyetlen hívói MikroB monitor-promptjai (heartbeat-consolidated D, fleet-nudger), amiket egy session
sorosít; ellenőriztem, hogy a `load-guard-daemon.sh`, a `load-guard-bookkeeping.sh` és a
`context-compact-monitor.sh` NEM hívja, csak kommentben említi. Szerkezeti akadály viszont nincs:
egyetlen turn párhuzamos Bash-hívásai elegendők. Vagyis a mechanizmus bizonyított, a kiváltás egy
viselkedési döntésre van, és nem állítom, hogy ma élesben elsül.

**Döntés.** Egyetlen `flock`-alapú zár (`${LEDGER}.lock`, 10 mp várakozás) fedi a `check`, a `reset`
és az `escalations` teljes állapot-módosító szakaszát. EGY zár mindkét állapot-fájlra (főkönyv és
eszkalációk): a műveletek másodperc alattiak, tehát a második zár csak azt a kérdést szülné meg,
hogy egy jövőbeli szerkesztés melyiket fogja.

**A zár hiánya TILT, nem enged.** Ez ellentétes az alatta lévő `_is_load_paused` szándékos
fail-open viselkedésével, és ez nem következetlenség: ott a hibamód "örökre blokkol minden meglökést
a flottában", itt "kihagy egy tickt". Egy megtagadott meglökést a hívó a következő körben újrapróbál;
egy elveszett főkönyvi bejegyzést semmi nem állít helyre. Az `escalations` a zár hiányában
KIFEJEZETTEN nem ír a kimenetre: egy üres lista ott "nincs függő eszkaláció"-nak olvasódna, ami az
egyetlen rossz válasz, mert egy sapkát elért kártya így némán sosem jutna emberhez.

**A teszt, és a korlátja.** A selftest kap egy 40-elemű párhuzamos burst-esetet (mind a 40 bejegyzés
maradjon meg, mind count=1) és egy determinisztikus zár-kizárólagosság-esetet (fd 9 fogja, egy
nulla-várakozású második nyitó bukjon). A `check` BEDRÓTOZÁSÁT viszont csak FORRÁS-szintű állítás
rögzíti (a zár-hívás a főkönyv-olvasás ELŐTT álljon), a KOMMENTEKTŐL MEGTISZTÍTOTT forráson illesztve,
mert egy kommentben megnevezett hívás kielégítene egy naiv jelenlét-ellenőrzést. Ez tudatos korlát:
a valódi `check` a futó dashboardot kérdezi a kártyáról, és az alternatíva, egy env-változós stub-varrat
magában a guardban, megkerülési felület lenne egy olyan eszközben, aminek a dolga a megtagadás.

**Mutánsok, mind megölve, valódi kilépési kóddal mérve (nem kiírt sorral).** (1) a burst zár nélkül
fut -> 40-ből 32 bejegyzés maradt, exit 1; (2) a `check` nem veszi fel a zárat -> a bedrótozás-eset
bukik, exit 1; (3) a `check` a főkönyv-olvasás UTÁN veszi fel -> ugyanaz, a sorrendet nevesítve.
A kiindulás mindháromszor visszaállt exit 0-ra, és a fájl bitre azonos volt a mutáció előttivel.

**Kísérő lelet, külön kártyán.** Kiderült, hogy ennek a guardnak a selftestje SOHA nem futott a
suite-ban: a `store-selftests-all-run.test.ts` felfedezése FÁJLNÉV-utótagra kulcsol, tehát egy olyan
szkript, ami a selftestjét MÓDként hordozza, szerkezetileg láthatatlan neki. Mérve: a `store/` 15
selftest-módú szkriptjéből TÍZ-et egyetlen teszt sem hív. Ez a kártya csak EZT az egyet drótozza be
(`src/__tests__/redispatch-guard-selftest.test.ts`), a maradék kilenc külön kártya, mert az, hogy
átmennek-e, mérve nincs, és ebben a repóban van dokumentált eset arra, hogy egy selftest a futó
flotta alól cserélt ki egy éles konfigurációs fájlt.

**Hivatkozás:** kártya `09a3d52a` (szülő `ee2d6220`, hermes-agent atomikus esemény-igénylés);
`store/redispatch-guard.sh`, `src/__tests__/redispatch-guard-selftest.test.ts`.

## 2026-09-06 14:30 -- A python hook-interpretert ellenőrizzük használat előtt, mert a 127 NEM blokkol (kártya d2b881ab)

**Döntés:** Az upstream `pythonHookCommand()` SZÓ SZERINT átvéve (10. szabály: kész, karbantartott
megoldás adoptálása saját írása helyett), és a fork MINDEN python-őrére alkalmazva -- upstreamnek
csak az outgoing-copy-gate-hez kellett, mert a többi őr fork-specifikus. Az `injectOutgoingCopyGate`
is erre vált a `hookCommand()` helyett.

**Miért:** A `hookCommand()` saját fejléce kimondja, hogy a 127-es kilépés "exactly the non-blocking
status this whole file exists to stop", és ezért a NODE interpretert használat előtt ellenőrzi. A 14
python-őr-bedrótozás viszont csupasz `python3 "<script>"` volt. Ha a `python3` bármikor lekerül a
PATH-ról (pyenv shim, csomagfrissítés, más spawn-környezet), mindegyik 127-tel lép ki, a Claude Code
azt NEM blokkolónak veszi, és MINDEN python-őr némán leáll: nincs hibaüzenet, nincs log, a
tool-hívások átmennek. A fork a saját, kimondott tanulságát csak az egyik interpreterre alkalmazta.

**A második, súlyosabb alak:** az `injectOutgoingCopyGate` a parancsát a NODE-builderrel építette egy
`.py` fájlra, tehát a bedrótozott alak `"<node>" ".../outgoing-copy-gate.py" --telegram-bash` volt,
ami SyntaxErrorral 1-gyel kilép: a kapu garantált no-op. Lappangó, mert a kill switch alapból ki van
kapcsolva -- de abban a pillanatban, amikor valaki bekapcsolja, egy kapcsoló, ami azt hiszi, védelmet
kapcsol be, semmit sem kapcsol be. Ez rosszabb a hiányzó védelemnél: hamis biztonságérzet.

**Ami SZÁNDÉKOSAN kimaradt:** a staleness-guard `bash -c '[ -f <script> ] && exec python3 <script>;
exit 0'` alakja. Az fail-open SZÁNDÉKKAL (egy törölt szkript ne blokkoljon), tehát a hiányzó
interpreter nem-blokkoló viselkedése ott KÖVETKEZETES a kimondott szándékkal, nem hiba. Teszt pinneli,
hogy egy későbbi "takarítás" ne vonjon vissza egy működő döntést.

**Bizonyíték, nem mintaillesztés:** a tesztek VÉGREHAJTJÁK a bedrótozott parancsot python3 nélküli
PATH-szal. A javított alak 2-vel lép ki (blokkol), a régi csupasz alak 127-tel -- ez a kontroll adja
a 2-esnek a jelentését. Mérve: a meglévő 72 hook-wiring teszt a HIBÁS és a JAVÍTOTT alakkal egyaránt
zöld volt, mert egyik sem pinnelte a parancs alakját; ezért nem elég sztringre illeszteni.

**Elavult horgony-állítások javítva ugyanebben a commitban** (a 07f4cd2f-en MikroB által megnevezett
osztály): `hook-registration-guard.ts` és `known-hook-scripts-exist.test.ts` kommentje azt állította,
hogy a python-kapuk csupaszon vannak drótozva; a `fork-upstream-conflict-guard` 15. körös
nyugtázása pedig azt, hogy a `pythonHookCommand` NINCS adoptálva. Az utóbbi merge-idejű
UTASÍTÁS, nem próza: javítatlanul a következő ütközésnél visszanyithatta volna. A dátumozott mérést
nem írtam át, hanem egy felülíró kör-jegyzetet fűztem hozzá.

**Ki döntött:** backend3 (mérés és kártya), backend2 (megvalósítás), upstream (az adoptált függvény).
**Hivatkozás:** kártya d2b881ab; `src/web/agent-scaffold.ts`.

## 2026-09-06 14:26 -- d2b881ab KORREKCIÓ -- a buildert az INJEKTOR-nál átírtam, az ÖSSZEHASONLÍTÁSNÁL nem

**Mi történt:** a `b097473a` az `injectOutgoingCopyGate()`-et átvitte a `pythonHookCommand()`-re, de
azt a két helyet, ami ezt a bedrótozást FELISMERI (`ensureGovernanceGateCommands` wired-already
összehasonlítása és az `ensureOutgoingCopyGate` elő-ellenőrzése), a `hookCommand()`-en hagyta. A
flotta-suite fogta meg: `outgoing-copy-gate-role-wiring.test.ts`, 2 bukás, 626 fájl / 15 248 tesztből.

**Miért nem látszott a saját tesztjeimen:** a BEDRÓTOZOTT parancs helyes volt, tehát minden teszt,
ami azt vizsgálja, zöld maradt (a 15 újam is). A kár egy réteggel arrébb, az ÖSSZEHASONLÍTÁSBAN volt:
a javító kör nem ismerte fel a saját munkáját, ezért a `needCopyAdd` minden körben igaz maradt (a
javítás sosem ült le, minden bootnál újraírta a `settings.json`-t), a `needCopyRemove` pedig végig
hamis (a kill switch KIKAPCSOLÁSA többé nem távolította el a hookot -- pont a "mindkét irány"
tulajdonság, amiért a 74181db2 kártya készült).

**A tanulság kimondottan ott állt, amit megsértettem:** a `hookCommand()` saját fejléce ígéri, hogy
egyetlen builder tartja "the injectors and every wired-already comparison byte-identical, so they
cannot drift". A mondat első felét alkalmaztam, a másodikat nem.

**Strukturális pin az OSZTÁLYRA, nem erre az egy esetre:** forrás-szkennelés, ami kimondja, hogy `.py`
út nem mehet a `hookCommand()`-be és `.mjs` út nem mehet a `pythonHookCommand()`-be. Három külön
visszaállított hívási helyen bizonyítottan harap, plusz egy korpusz-ellenőrzés, hogy egy semmit nem
illesztő regex ne mehessen el tisztaként. Az illesztés a NYERS fájlon fut, nem komment-mentesítetten:
ez HIÁNY-állítás, és a komment-eltávolítás az az irány, ami valódi előfordulást tud elrejteni.

**Ki döntött:** backend2.
**Hivatkozás:** kártya d2b881ab; commit `00691ced`; `src/web/agent-scaffold.ts`,
`src/__tests__/python-hook-interpreter.test.ts`.
## 2026-09-06 -- 3bd457ed: a `wake` mező, és miért csak a fő-ügynöknél lehet lekapcsolni az ébresztést

**Döntés:** Az inter-agent üzenet kap egy opcionális `wake` mezőt (alapértelmezés: ébreszt). A
`wake:false` üzenet ugyanúgy bekerül a postafiókba és ugyanúgy kézbesül, csak nem vált ki azonnali
megszakítást a címzettnél. A mezőt a fő-ügynöknél HONORÁLJUK, minden más címzettnél viszont
visszaírjuk ébresztésre, hangosan naplózva.

**Miért éppen így:**

1. *Miért van rá szükség.* Hét nap mérése: 3388 üzenet, ebből 472 automatizált, és a 472-ből 464 a
   fő-ügynöknek megy, nem a dolgozó ügynököknek. A sorok szó szerint ismétlődnek (session-stuck
   not-ready 13x, 10x, 9x; BUSY 7x). A nyereség tehát majdnem teljesen a fő-ügynök token-keretén
   jelentkezik.

2. *Miért nincs dedup-számláló.* MikroB döntése (21447 / 24562): tisztán hívó-deklarált mechanizmus,
   ismétlődés-számláló NÉLKÜL. Egy automatikus hasonlóság-ítéletnek azt kellene eldöntenie, hogy két
   üzenet eléggé egyforma-e, és egy első körben másnak látszó, sürgős üzenetet tévedésből
   elnémíthatna. A hívó-deklarált forma egyszerűbb, auditálhatóbb, és a gate statikus stringre tud
   nézni, nem viselkedésre. KIMONDOTT KÖLTSÉG: dedup nélkül a `wake:false` az ELSŐ jelzést is
   passzívvá teszi, nem csak az ismétléseket.

3. *Miért csak a fő-ügynöknél.* A `wake:false` azt ígéri, hogy az üzenet a címzett KÖVETKEZŐ
   TERMÉSZETES ELLENŐRZÉSÉIG vár. Ilyen ellenőrzése egyedül a fő-ügynöknek van: ő minden körben
   leszívja a saját postafiókját (`/api/agents/<fő>/drain-inbox`, ami tervezetten elutasít minden más
   ügynököt). Az al-ügynökök push-alapúak: náluk a router tmux-injektálása MAGA a kézbesítés. Egy
   al-ügynöknek címzett `wake:false` sor tehát nem csendben várna, hanem a 60 perces
   abandon-ablakig függőben ülne, majd FAILED lenne. Az üzenet eltűnne, ami pont az, amit ez a mező
   soha nem tehet. Ezért a kérést visszaírjuk ébresztésre, és a TÁROLT sor 1-et mond: a sor nem
   állíthat olyan elnémítást, ami nem történt meg.

4. *Az irány fail-OPEN, szándékosan.* Csak a kifejezett 0 némít; minden más érték ébreszt (migrálatlan
   adatbázis, váratlan érték). Ez tudatosan ELLENTÉTES a redispatch-főkönyv zárjával (`09a3d52a`),
   ahol a hiba iránya a tiltás. A két hibamód nem egyforma drága: egy feleslegesen felébresztett
   címzett egy megszakítást veszít, egy tévedésből elnémított hiba- vagy biztonsági jelzés viszont
   addig láthatatlan, amíg valaki véletlenül rá nem néz.

5. *Két ébresztő út van, nem egy.* A fő-ügynököt a router `[inbox-wakeup]` injektálása ÉS a
   `inbox-nudge-watcher` is fel tudja ébreszteni, és a második az, amelyik fizetős autonóm kört
   költ. Ha a mezőt csak a routerben tartanánk tiszteletben, a szigorítás a tartalék úton ülne, a
   fő úton nem. Mindkét döntési pont ugyanazt az egy predikátumot (`messageWakesReceiver`) hívja,
   és ezt teszt is rögzíti.

6. *A predikátum külön modulban él.* Nem a sor mellett (`db.ts`), mert mindkét döntési pontot
   `vi.mock('../db.js')`-szel tesztelik, ami a teljes modult kicseréli: onnan importálva a
   predikátum minden ilyen suite-ban definiálatlan kötés lenne, és a hiba nem is a hiányzó
   stubként, hanem független tesztek összeomlásaként jelentkezne.

7. *Amit ez a lépés SZÁNDÉKOSAN nem szállít.* A HTTP-végpont (`POST /api/messages`) NEM fogadja el a
   mezőt. Az allowlist, ami kimondja, mely üzenetosztály kérhet `wake:false`-t, a következő lépés
   (`7d47ca16`). Egy szabad formájú `wake:false` a végponton, az allowlist ELŐTT, egy olyan ablakot
   nyitna, amelyben bármely token-birtokos bármit elnémíthat, a hiba- és biztonsági osztályokat is.
   A rés maga teszttel van rögzítve, hogy a következő lépés ne feltételezze lezártnak.

**Mérés:** négy mutáns, mind bukik a tesztekre (kilépési kód közvetlenül mérve): a router
ébresztés-ellenőrzésének törlése (1), a watcher szűretlen sorára visszaállás (1), a predikátum
konstans igazra állítása (1), és az al-ügynök-visszaírás kikapcsolása (1). Alapvonal 0. A router
mindhárom esete külön órán fut, mert a modul-szintű 45 másodperces ébresztési cooldown egyébként
elnémítaná a következő esetet, és az utána jövő állítás rossz okból lenne zöld.

**Rollback:** a migráció egyetlen `ADD COLUMN ... NOT NULL DEFAULT 1`, tehát a meglévő sorok
ébresztőként töltődnek fel, nem NULL-lal. Ha a kódot vissza kell vonni, az oszlop ottmarad, és egy
róla nem tudó író ugyanúgy ébresztő sort ír; mindkét irány külön teszttel mérve, nem feltételezve.

**Ki döntött:** MikroB (21447, 24562, 24563: hívó-deklarált mechanizmus, dedup nélkül, allowlisttel);
backend (a fő-ügynökre szűkítés, a fail-open irány és a HTTP-felület halasztása).

**Hivatkozás:** kártya `3bd457ed` (szülő `dc35fa1a`, nagyszülő `ee2d6220`); `src/web/message-wake.ts`,
`src/web/message-router.ts`, `src/web/inbox-nudge-watcher.ts`, `src/db.ts`,
`src/schema/agent-messages-ddl.ts`, `src/__tests__/message-wake-field.test.ts`,
`src/__tests__/message-wake-deciders.test.ts`.

## 2026-09-06 -- 108c7b10: a VRAM-kapu fail-safe iránya KÉT eset, nem egy

**Döntés:** A `store/vram-guard-check.sh` a GPU-memória alapján ad ADMIT/HOLD verdiktet a helyi-LLM
dispatch elé. A mérés hiánya NEM egyetlen esetként kezelendő:

- Az `nvidia-smi` NINCS a gépen -> **ADMIT**. Lehet, hogy nincs is NVIDIA GPU; ilyenkor a kapunak
  nincs tárgya, és a visszatartás minden ilyen hoszton örökre kikapcsolná a helyi modellt. Ez a
  kártya saját indoklása, és itt helyes.
- Az `nvidia-smi` OTT VAN, de hibázik, időtúllépésbe fut vagy értelmezhetetlent ír -> **HOLD**. Van
  GPU, és nem látjuk az állapotát. Ez valódi kétség, nem a tárgy hiánya.

**Miért tér el ez a kártya szövegétől:** a `108c7b10` egyetlen szabályt mond ki
("hiányzik/hibázik -> ADMIT"). A második esetre ez rossz irányba mutat, és ezt két, nálam magasabb
szintű forrás is így mondja: a szülő kártya (`40568837`) kimondja, hogy "ugyanaz a fail-safe
irányelv mint a load-guard-nál: kétség esetén ONLINE", a CLAUDE.md 16. szabálya pedig szó szerint
azt írja, hogy "hibás/hiányzó/lefagyott modell esetén ONLINE-t kell választani, sose fordítva". Egy
ADMIT a második esetben pont akkor kapcsolná ki a kaput, amikor a mérés nem elérhető -- ez a "egy
biztonságos alapérték csak akkor fail-closed, ha nem tud ILLESZKEDNI" csapda. A kockázat itt nem
elméleti: a flotta már hordoz egy GPU crash-loop őrt a GPU-passthrough okozta WSL-újraindulásokra.

**Visszafordíthatóság:** a kártya szó szerinti szabálya EGY környezeti változóval visszaáll
(`VRAM_GUARD_UNREADABLE=admit`), és erre külön selftest-eset van. Nem kell hozzá kódot írni, ha
MikroB mégis a szó szerinti alakot kéri.

**További döntések ugyanitt:**

1. *Több GPU esetén a sorok ÖSSZEGZŐDNEK*, nem kártyánként dőlnek el. Kártyánként nézve egy üres
   második GPU átengedne egy modellt, ami valójában a tele elsőre töltődik.
2. *A hívás időkorlátos.* Egy beragadt `nvidia-smi` a dispatch útvonalon a hívót akasztaná meg; a
   `timeout` ezt a fenti (b) ágra tereli. A selftest ezt IDŐVEL méri, nem a verdikttel: a verdikt
   ugyanaz volna időkorlát nélkül is, tehát önmagában nem bizonyítja a korlát létét.
3. *Hiszterézis, a `load-guard-eval.sh` mintájára*, mindkét irányban. A GPU pont az a mérés, ahol
   egyetlen minta hazudik: egy befejeződő kérés egy lépésben szabadít fel gigabájtokat, egy betöltő
   modell ugyanolyan gyorsan foglal.
4. *A selftest külön FÁJL* (`store/vram-guard-check.selftest.sh`), nem a szkript egyik módja: a repó
   felderítése a fájlnév-utótagra néz, egy módként hordozott selftest szerkezetileg láthatatlan
   (`09a3d52a` mérése: 15 ilyen szkriptből tízet semmi nem hívott). Landoláskor magától lefut.

**Mérés:** 18 selftest-eset zölden, GPU nélkül, hermetikusan (a valódi hívási utat stub-binárisok
fedik, nem a `--metrics-json` varrat). Öt mutáns, mind bukik: az unreadable-alapérték átbillentése
ADMIT-ra, a hiszterézis törlése, a több-GPU összegzés helyett az utolsó sor, a hiányzó eszköz
HOLD-ra fordítása, és az időkorlát törlése.

**Ki döntött:** Peti (a kapu léte, Telegram 2026-09-06); backend (a fail-safe irány kettébontása, a
kártya szövegétől eltérően, a fenti két magasabb szintű forrásra hivatkozva -- MikroB felülbírálhatja
egyetlen környezeti változóval).

**Hivatkozás:** kártya `108c7b10` (szülő `40568837`); `store/vram-guard-check.sh`,
`store/vram-guard-check.selftest.sh`, `store/vram-guard-config.json`.
## 2026-09-06 14:45 -- A dedup-elo-szuro a SAJAT KIMENETET olvasta vissza; a kartya altal eloirt gyogymod viszont megolne az egyetlen igazolt talalatot (kartya 49be3576)

**Amit a kartya kert:** a proveniencia-hivatkozast (a lelet-kartya, amibol a koveto kartya
szuletett) vegyuk KI teljesen az illesztesi korpuszbol, mert a negy mai hamis pozitiv mindegyikenel
a kozos elem ez volt.

**Amit a meres talalt, es amit ezert MEGCSINALTAM:** a hamis pozitivok egy resze nem proveniencia,
hanem ONSZENNYEZES. Talalatkor a hivo beleirja a kartya leirasaba a `[DEDUP-PREFILTER] ... (kozosen
hivatkozott ID(k): X) ... (rule 6b).` blokkot. Az a blokk kartya-ID-ket nevez meg ES fix magyar
prozat visz, tehat a kovetkezo futasnak megkulonboztethetetlen a szerzo sajat szovegetol -- es
MINDKET jelet eteti:
  * 1. jel: a 49be3576 es a 96d3e903 a 746ebae4-et NULLA alkalommal emliti szerzoi szovegben, es
    egyszer-egyszer a sajat elo-szuro blokkjaban. Az eszkoz a sajat kimenetere illesztett.
  * 2. jel: a blokk prozaja ("Lehetseges duplikatum", "Ellenorizd", "hivatkozott", "kartyat",
    "problemat", "kommentelj") minden megjelolt kartyan kozos. Ugyanez a par 0,41 pontot es 34
    kozos szot ad -- MINDKET lexikai kuszob folott --, blokk nelkul 0,07-et es 4-et. A
    b6f88f86/91dd4386 par ugyanigy 0,41 -> 0,27, kuszob folottrol ala.
Ez onerosito hurok, nem kellemetlenseg: minden megjelolt kartya valoszinubbe valik, hogy ujra
megjeloljek, es hogy MAS megjelolt kartyakat is behuzzon. A tablan mar 128 kartya visz ilyen blokkot.
A javitas: az eszkoz sajat blokkjait ki kell venni a korpuszbol MINDKET oldalon, mielott barmelyik
jel ranez. Csak az ILLESZTESI KORPUSZBOL -- a kartyan a blokk marad.

**Amit NEM csinaltam meg, es miert:** a proveniencia-kizarast. Megmertem az egyetlen igazolt
duplikatum-part, amire az egesz heurisztika kalibralva lett (cff4fa09 vs fe2f71ca): a kozos
hivatkozasuk (34c4840e) MINDKET oldalon proveniencia-nyelvben all -- "34c4840e kovetkezmenye",
"Cybered lelete (34c4840e ...)", "34c4840e/1da2367a korabbi FAIL-ek kapcsan". Egy szabaly, ami eleg
szeles ahhoz, hogy a mai negy hamis pozitivot levagja, ezt is levagja. Az 1. jel igazolt igaz
pozitivja es a hamis pozitivjai SZERKEZETILEG AZONOSAK: mindketto "ket kartya ugyanabbol a leletbol".
A lexikai pontszam sem valaszt el: a valodi par 0,16/17, a blokk-mentesitett hamis pozitivok
0,08/14, 0,09/6, 0,16/13, 0,27/25 -- a 232e01e2/e80c011a pont ugyanazt a 0,16-ot adja.

**Egy melleklelet, ami magatol nem derult volna ki:** a fenti igazolt par a `done` lista 877.
helyen all `updated_at` szerint, az alapertelmezett visszatekintes 200. Az eszkoz egyetlen igazolt
igaz pozitivja tehat mar reg HATOTAVON KIVUL van az eles tablan -- egy ottani futas nem a jelrol
mond valamit, hanem az ablakrol. Ezert hermetikus a selftest.

**Ki dontott:** backend2 (meres es az onszennyezes-javitas), MikroB (a proveniencia-kerdes nyitva,
dontesre visszaadva a meressel).
**Hivatkozas:** kartya 49be3576; `store/dedup-prefilter-check.sh`,
`store/dedup-prefilter-check.selftest.sh`.

## 2026-09-06 -- 0c4cf655: a token-könyvelés minden ügynökre felírta a KÖZÖS fát, és egy leírt mondat mondta biztonságosnak

**Döntés:** A `discoverAgentSources` (src/web/token-usage.ts) kihagyja azt az "izolált"
`agents/<név>/.claude-config/projects` fát, ami FELOLDVA ugyanaz, mint a közös `~/.claude/projects`.
A valóban külön fát továbbra is beolvassa.

**A hiba, és ami érdekesebb: miért élte túl a review-t.** A javított blokk saját kommentje kimondta,
hogy a szimlinkelt elrendezés ártalmatlan, mert "Duplicates are impossible either way: the UNIQUE
INDEX on (agent, session_id, timestamp, input, output) plus INSERT OR IGNORE absorbs the overlap".
Ez az állítás hamis, és pontosan azon a ponton, ahol egy olvasó a legkevésbé nézi meg: az indexben
az `agent` az ELSŐ oszlop, tehát csak ugyanazon a néven belül nyel el. Minden izolált ügynök
végigjárta a közös fát, és a TELJES flotta fogyasztását a saját nevére írta; minden példány egyedi
volt az index szemszögéből. A lelet Cyberedé (efaf8926 gate, 2026-09-05). Ugyanez a mondat állt a
`docs/token-usage.md`-ben és a szomszédos teszt fejlécében is; mindhárom helyen JAVÍTVA, nem
törölve, mert a következő olvasó azt a mondatot fogja keresni, amit legutóbb elhitt.

**Mérés (élő `store/claudeclaw.db`, csak olvasó lekérdezés):** 4 033 380 sor, ebből
`(session_id, timestamp, input_tokens, output_tokens)` szerint 398 952 külön esemény, vagyis a tábla
**90,1%-a duplikátum**. A `jogasz`/`penzugy`/`qa2`/`teszter`/`videooo` bájtra azonos totált mutat, és
254 429 tartalom-kulcs szerepel egynél több ügynök nevén. Hatás: a `costops/ledger.ts` per-(ügynök,
nap, modell) árazása nagyságrenddel felfújt és ügynökök között összemosott, a `model-suggest.ts`
ebből javasol modell-tiert, és egy elszabadult ügynök fogyasztása nem tud kilógni egy olyan táblán,
ahol minden ügynök sora azonos.

**A fail-safe irány a helyettesítő ellenőrzésben:** ha valamelyik útvonal nem oldható fel,
`resolvesToSharedProjectsRoot` FALSE-t ad, vagyis a fát izoláltnak tekintjük és beolvassuk. Ez
tudatos: egy nem statolható könyvtár olyan, amiből még inkább meg kell próbálni begyűjteni az
adatot, és az ilyenkor kockáztatott duplikátumot a kulcs javítása fogja elkapni; a másik irány
NÉMÁN ejtene el egy ügynök teljes fogyasztását, ami pont ennek a blokknak a korábbi hibaosztálya.

**A HÁROM LÉPÉS SORRENDJE KÉNYSZER, NEM ÍZLÉS.** (1) ez a betöltés-javítás elállítja az új
duplikációt; (2) a backfill-takarítás (`a9e07e5c`) eltávolítja a már bent lévő ~3,6M sort; (3) csak
EZUTÁN cserélhető a dedup-kulcs `agent` nélkülire (`b774f057`), mert egy UNIQUE INDEX nem hozható
létre duplikátumokat tartalmazó táblán. A három kártya közé predecessor-él van drótozva, nem próza.

**Amit a takarítás tervezéséhez már megmértem, és ami a naiv megoldást kizárja:** a kézenfekvő
`DELETE ... WHERE id NOT IN (SELECT MIN(id) ...)` a 398 952 csoportból 40 759-nél olyan sort tartana
meg, aminek üres a `project`-je, holott a csoportban van kitöltött; 9 945-nél a `task_title`,
32-nél a `model`. Vagyis a naiv takarítás a túlélő sorok 10,2%-áról tüntetné el a
projekt-attribúciót, azt, amiért az egész takarítás történik. A survivor-szabálynak TELJESSÉG
szerint kell rangsorolnia, nem id szerint. Ez a követelmény a `a9e07e5c` kártya szövegében is benne
van, hogy ne csak itt éljen.

**A tartalom-kulcs biztonságos, és ez is mérve van, nem feltételezve:** a `mikrob` az egyetlen
nem-izolált, tehát tiszta alapvonal, és az ő soraiban NULLA olyan
`(session_id, timestamp, input, output)` kulcs van, amihez egynél több különböző payload tartozna.
A táblán összesen 34 kulcsnál tér el a payload, és ezek megnézve mind ugyanannak az eseménynek a
másolatai: csak a `project` (melyik ügynök konfig-könyvtárán át látszott) és a `model` (a mikrob
sorai a modell-oszlop feltöltése előttiek) tér el. Vagyis a kulcs valódi eseményeket nem von össze.

**Ki döntött:** Cybered (a lelet); backend (a helyettesítő ellenőrzés iránya, a három lépés sorrendje
és a survivor-követelmény).

**Hivatkozás:** kártya `0c4cf655` (szülő `07f4cd2f`, testvérek `a9e07e5c`, `b774f057`);
`src/web/token-usage.ts`, `src/__tests__/token-usage-shared-root-skip.test.ts`,
`src/__tests__/token-usage-isolated-sources.test.ts`, `docs/token-usage.md`.

## 2026-09-06 14:35 -- ac28bc6e -- the append-only comment promised more than the trigger delivers

**Cybersec's MEDIUM on already-gated work, reproduced here against the shipped DDL before a word was
changed.** The header said "the detection facts are immutable" and the trigger comment said a
resolution "cannot be un-set or re-pointed". Measured, one attempt per shape:

    BLOCKED:  card_id / detected_at / stalled_ms_at_detection / action, and clearing resolved_at
    PASSES:   assignee_at_detection, action_detail, resolved_by_event_id, DELETE, INSERT OR REPLACE
    CONTROLS (allowed by design): detections + 1, resolved_at written once from NULL

Two of the passing columns are the ones the design leans on hardest: `assignee_at_detection` IS a
detection fact and carries the per-agent axis of the card's own question, and `action_detail` is, in
my own words in the same file, "the load-bearing half". `INSERT OR REPLACE` rewrote every column.

**My own header sentence turned on me:** "Without the trigger, 'append-only' would be a comment that
the next direct-sqlite3 writer never reads." That same writer can DELETE and REPLACE, and the comment
said nothing about it.

**The most useful part of the report was their FAILED first remedy, handed over with the
measurement.** The obvious fix -- a BEFORE DELETE trigger -- does NOT stop REPLACE under SQLite's
default, because REPLACE runs as delete-then-insert and only `recursive_triggers ON` routes it
through the trigger. That pragma is GLOBAL to all 14 triggers in this schema, including the memories
FTS branches. Without their negative result, "fixed" would have been false confidence, and the
cheapest-looking switch would have been the widest-reaching one.

**DECISION: (b)+(c), not the pragma.** A BEFORE DELETE trigger, REPLACE recorded as a STATED
residual, and the comment narrowed to what the mechanism actually refuses. Changing a global pragma
to protect an internal telemetry table would alter 14 unrelated triggers, and the effect on the
memories FTS branches would itself need proving. Same shape as the self-pace-gate decision on
runtime-substituted forms: a stated residual beats a pattern pretending to be closed.

**Split deliberately, with MikroB's approval:** the comment narrowing goes in FIRST and alone
(comment-only, zero behaviour change), because a guarantee that is merely wrong is worse than one
that is merely absent -- the next writer builds on it. The structural half folds into 878cd292, where
the first producer of these rows is built. Exposure is bounded meanwhile: the table has no producer
today.

**On process:** the card was already `done` with QA PASS + Cybersec GO. I did not touch it on my own
judgement -- I reported the measurement and asked, and MikroB split the work.

**Reference:** card `ac28bc6e`; Cybersec 21527; structural half on `878cd292`. 15 tests still green.
## 2026-09-06 -- 99c2eb09: az upstream-drift ellenőrzés kikerül a tesztfájlból, hogy kikerülhessen a landolási kapuból

**Döntés:** A fork/upstream ütközés-elismerések ADATA és a tiszta döntései átkerülnek a
`src/fork-upstream/acknowledged-conflicts.ts` modulba, és mellé kerül egy futtatható ellenőrző
(`src/fork-upstream/drift-check.ts`). A suite offline állításai és az új ellenőrző UGYANEZT az egy
modult olvassák.

**Miért:** MikroB döntése (24642) a `1f276349`-en, a (C) irány. A hálózatfüggő eset a landolási
kapuban ült: futásidőben `git fetch upstream develop`-et hívott, tehát minden ügynök landolása attól
függött, hogy az elmúlt percekben mit tett egy TŐLE FÜGGETLEN upstream commit. A tesztfájl saját
újramérési jegyzeteiből mérve: 41 "landing-block" említés, 32 újramérési kör öt nap alatt (09-02: 3,
09-03: 9, 09-04: 1, 09-05: 5, 09-06: 14), öt ügynök, nyolc kártya, egy kártya tizenháromszor.

**A mélyebb indok, ami a flakiness-nél fontosabb:** egy `develop`-re landolás NEM mergel upstreamet.
Az ellenőrzés tárgya egy JÖVŐBELI upstream-merge kockázata, ami ortogonális arra a változtatásra,
amit a kapu épp átenged. Ezért a kapuban egyetlen olyan hibát sem tud megfogni, amit a landolás
okoz; azt jelenti, hogy a VILÁG mozdult. Az monitorozás, nem kapu. Bizonyíték a mérésből: az egyik
blokkolt commit öt `store/*.py` fájl és a `DECISIONS.md` volt, egyetlen `src/` fájl nélkül.

**Amit NEM viszünk ki, és ez a különbség a nyers (B) irányhoz képest:** a fájl 28 tesztjéből csak
EGY hálózatfüggő. A többi (a `MIGRATED_FROM_GUARDED` részhalmaz-ellenőrzés, a minden elismeréshez
tartozó blob-pin, a fork-oldali horgonyok, a `classifyConflicts` egységtesztjei, az ARMED/SKIPPED
névadás) offline, determinisztikus, és valódi védelem: pont az akadályozza meg, hogy egy fájl
egyetlen sor törlésével mindkét listából kiessen. Ezek MARADNAK a kapuban.

**Egy forrás, nem kettő.** Az elismeréseket kísértés lett volna átmásolni az ellenőrzőbe. Két
másolat pontosan azt a néma szétcsúszást hozná vissza, ami miatt a közös `agent_messages` DDL is
létezik (`26ad5302`): ott két kézzel másolt DDL-string csúszott szét egy "identical schema"
kommenttel a tetején. Ezért a modul az egyetlen forrás, és a tesztfájl is onnan importál.

**EKVIVALENCIA, MÉRVE, NEM FELTÉTELEZVE.** Az új ellenőrzőt lefuttattam a VALÓDI upstream ellen a
mai fán: `reachable=true`, `guarded=[]`, `unwatched=[]`, `stale=[]`, vagyis pontosan az a három üres
halmaz, amit a suite esete ma állít, ARMED állapotban. A kiemelés tehát nem "fut", hanem
UGYANAZT MONDJA.

**A tesztek hermetikusak, és ez nem stílus.** Ha az ellenőrző tesztjei élő upstreamet hívnának,
visszahoznák pont azt, ami ellen a kártya szól. Ezért minden eset az injektált `GitRunner` varraton
megy át, remote, fetch és valódi merge nélkül. Amit egy varrat nem tud bizonyítani (hogy a VALÓDI
hívás ugyanazt a verdiktet adja), azt egyszer, kézzel mértem meg, és ide írtam -- nem csináltam
belőle hálózatfüggő tesztet.

**Mérés:** 9 hermetikus eset zölden, plusz a meglévő 28 eset a kiemelés után változatlanul zöld.
Négy mutáns, mind bukik: az `isClean` figyelmen kívül hagyja a `stale`-t, a `merge --abort` törlése,
az elérhetőség-ellenőrzés kikapcsolása, és a `blobOf` üres stringgel a `null` helyett (ez utóbbi a
felfelé törölt fájl esetét némítaná el).

**Következő lépések:** `5da60b85` (a hálózatfüggő eset kivétele a suite-ból, plusz egy őr, ami
kimondja, hogy a fájlban egyetlen eset sem hálózatozik), `a1ce8952` (ütemezett drift-figyelő,
KÖTELEZŐ dedup-pal: az ellenőrző minden körben ugyanazt a driftet látja, amíg fel nem oldják, tehát
egy naiv kártyanyitás gépi léptékben sértené a 6b. szabályt).

**Ki döntött:** MikroB (a (C) irány, 24642); backend (a mérés, a modul-határ és a hermetikus
teszt-alak).

**Hivatkozás:** kártya `99c2eb09` (szülő `1f276349`); `src/fork-upstream/acknowledged-conflicts.ts`,
`src/fork-upstream/drift-check.ts`, `src/__tests__/fork-upstream-drift-check.test.ts`,
`src/__tests__/fork-upstream-conflict-guard.test.ts`.

## 2026-09-06 -- 5da60b85: a hálózatfüggő ellenőrzés kikerült a landolási kapuból, és miért EGY landolásban a kiemeléssel

**Döntés:** A `fork-upstream-conflict-guard.test.ts` hálózatfüggő esete (élő `git fetch upstream
develop` plusz valódi merge-dry-run) TÖRÖLVE a suite-ból. A helyére determinizmus-őr került, ami
kimondja, hogy a fájlban egyetlen eset sem végez távoli git-műveletet. A 28 tesztből 24 marad: minden
szerkezeti, saját fánkról szóló állítás bennmaradt.

**Miért egy landolásban a `99c2eb09` kiemeléssel, a saját sorrend-élem ellenére.** A tervem az volt,
hogy előbb landol a kiemelés, aztán külön a kivétel. Ez a sorrend NEM BEFEJEZHETŐ: amíg a hálózati
eset a kapuban van, a javítás landolása versenyt fut az upstreammel. Élesben mérve, ugyanazon a
délutánon, EGY ÓRÁN BELÜL két pin ment el alattam -- `scripts/channels.sh` (287de06e -> d0ca55bd),
majd `scripts/hooks/outgoing-copy-gate.py` (d97e9683 -> 3ba1db43) --, mindkettő olyan upstream
változásra, aminek semmi köze a landolásomhoz. Ez a kártya saját premisszájának a legjobb
bizonyítéka, csak épp az én landolásomon. A tartalmi feltétel, amit a sorrend-él véd (a helyettesítő
LÉTEZZEN, mielőtt a régi eltűnik), teljesül: a futtatható ellenőrző ugyanabban a szállítmányban van,
és az ekvivalenciája a valódi upstream ellen mérve.

**Egy pin tudatosan elavult marad.** Az `outgoing-copy-gate.py` bumpját NEM végeztem el. Nem
mulasztás: mostantól ez a drift-figyelő dolga, és az ELSŐ futása pont ezt fogja jelenteni. Egy
elavult pin bumpolása a landolásom kedvéért az a taposómalom, amit ez a kártya megszüntet.

**Amit viszont elvégeztem, mert nem hagyhattam benne:** a `scripts/channels.sh` újramérése. Az
upstream diff teljes egészében a watchdog plugin-életjel FALLBACK-jét érinti (host-szintű
`ps eww -e | grep CLAUDE_PLUGIN_ROOT` helyett a session saját `pane_pid`-jére szűkített
`pgrep -P`), a rögzített konfliktus pedig a két guard-alert POST-nál van; nulla átfedés, a feloldás
változatlan. DE: az upstream mérése szerint egy több-ügynökös hoszton a host-szintű grep BÁRMELYIK
ügynök plugin-folyamatára illeszkedik, tehát az életjel mindig igaz, és a watchdog némán elveszti a
halott csatorna felismerését (náluk: 14 plugin-folyamat, egy csatorna 07:40-től 08:30-ig halott,
senki nem szólt). A mi `scripts/channels.sh`-unk 1079. sora UGYANEZT a host-szintű grepet hordozza,
és ezen a hoszton méréskor 2 illeszkedő folyamat futott. NEM adoptáltam: egy viselkedés-javítás a
csatorna-watchdogon nem tartozik egy landolás-feloldásba, és saját kaput érdemel. A jegyzet az
elismerés mellett áll, hogy a következő merger ott találja.

**Az őr, ami majdnem önmagát fogta meg.** A determinizmus-őr első alakja a TELJES fájlt szkennelte,
és elbukott a SAJÁT tűlistáján és a saját teszt-nevén. Ez ugyanaz az osztály, mint egy poll-predikátum,
ami a saját megfigyelőjét is beleszámolja: egy önmagára illeszkedő őrt csak GYENGÍTÉSSEL lehet
"megjavítani", és pont ezért veszélyes. A végleges alak (a) csak egy literális szentinel FÖLÖTTI
részt nézi, (b) a tűket darabokból rakja össze, tehát a lista sem találat, és (c) állítja, hogy a
szentinel PONTOSAN EGYSZER fordul elő -- így nem lehet a szkennelés elől lejjebb tolt kóddal
kibújni, sem a határ csendes törlésével. Mindkét mutáns bukik: visszacsempészett hálózati hívás a
szentinel fölé, és a szentinel törlése.

**Ami a hálózati esettel együtt költözött:** az ARMED/SKIPPED bejelentés (`metaAnnouncement`) és a
két tesztje. Az az állapot arról szól, hogy a HÁLÓZATI ellenőrzés futott-e; egy olyan fájlban, ami
többé nem hálózatozik, lógó maradvány lett volna. A drift-figyelő ugyanezt a két állapotot fogja
jelenteni, ugyanabból az okból: a "nincs mit mondanom" és a "nincs baj" nem nézhet ki egyformán.

**Mérés:** 24 offline eset zölden a guard-fájlban, 12 a drift-ellenőrzőében, plusz a két olvasó
(`provider-env-adoption`, `runner-conflict-resolution-pins`) átállítva az új modulra és zölden -- ezek
a fájlt SZÖVEGKÉNT olvassák, tehát a kiemelés eltörte őket, és a kapu ezt el is kapta.

**Ki döntött:** MikroB ((C) irány, 24642); backend (az összevont landolás, és hogy egy pin tudatosan
elavult marad).

**Hivatkozás:** kártyák `5da60b85` + `99c2eb09` (szülő `1f276349`);
`src/__tests__/fork-upstream-conflict-guard.test.ts`, `src/fork-upstream/drift-check.ts`,
`src/fork-upstream/acknowledged-conflicts.ts`.

## 2026-09-06 -- Az upstream négy hamis-pozitív javításából egyet veszünk át, hármat nem

**Kontextus:** az upstream `03ca5262` négy új maszk-alternatívát tett a kimenő-szöveg kapu
`TECHNICAL` regexébe, plusz kivette a puszta `level` szót a magyar nyelv-markerek közül. Mind a
négy ugyanazt az osztályt célozza: a szóbontó egy technikai alakot magyar szónak lát, és a kapu
ékezethibát jelent ott, ahol nincs.

**Döntés:** a `level` felét (mindkét részét) ÁTVESSZÜK, a másik hármat NEM.

**Miért:** mind a négy upstream hamis-pozitívot lefuttattam a fork saját `audit()`-jén, mielőtt
döntöttem. Három közülük -- szám+toldalék (`8:09-es`, `17:06-kor`), tulajdonnév+toldalék
(`Chrome-ot`, `Drive-ra`) és kötőjeles kisbetűs azonosító (`folyamatos-ellenorzes`) -- MÁR
ÁTMEGY ezen a forkon, mert ezt az osztályt egy MÁSIK RÉTEGBEN oldottuk meg: a `HYPHEN_WORD`
tokenizáló a kötőjeles alakot EGÉSZBEN veszi, tehát a `chrome-ot` sosem esik szét `ot`-ra.
A mögötte álló két szűk allowlist (`DIGIT_HYPHEN_SUFFIX_ALLOWLIST`, `IDENTIFIER_ALLOWLIST`)
KÉT Cybersec NO-GO eredménye (`fbb36b41` 7/8. és 11. kör), és ezek pontosan az upstream FELTÉTEL
NÉLKÜLI alakját utasították el: egy korlátlan „számjegy-kötőjel utáni szó" vagy „kisbetűs
kötőjeles alak" maszk nem csak az ékezet-vizsgálat, hanem a homoglifa-vizsgálat elől is kivágja,
amit elfed. Átvenni tehát nulla mért nyereség lenne, ugyanazért a tágításért, amit két kapu már
megvizsgált és elutasított.

A negyedik viszont valódi lyuk itt is, és erre a forkra JOBBAN áll, mint az upstreamre: a saját
`CLAUDE.md`-nk „Level 1/2/3" autonómia-szintekről beszél, tehát bármely magyar üzenet, ami ezt
idézi, elakadt. Mérve, hibátlanul ékezetes magyar mondaton: blokkolt, egyedül a `level` szón.
Külön mérve az angol irány is: a „The new access level lands in the advance market build" mondat
három magyar markert ért el (`van` az „advance"-ben, `level`, `mar` a „market"-ben), tehát az
`is_hungarian()` IGAZAT adott egy tiszta angol mondatra, és a vizsgálat egyáltalán elindult.

**Miért nem gyengít:** az átvett maszk szándékosan szűk, csak SZÁM előtt vág. A `level` mint a
`levelet` valódi elírása továbbra is fennakad -- ez a maszk negatív kontrollja, és külön
selftest-eset. A marker-eltávolítás ellenirányát is megmértem: egy valódi, ékezethibás magyar
mondat 9 helyett 8 markert ér el, tehát a nyelv-felismerés nem gyengül.

**Mérés:** 4 új selftest-eset (82 eset zölden a kapu selftestjében), plusz mindkét fél KÜLÖN
mutáció-tesztelve: bármelyiket visszaállítva pontosan a saját esete bukik és semelyik másik,
tehát egyik fél sem fedi el a másik hiányát. `tsc --noEmit` zöld, a négy fork-upstream teszt-fájl
(75 eset) zöld.

**Ki döntött:** MikroB (a `a7a61751` plan-grilling GO-WITH-CHANGES verdiktje, Peti IGEN-je után);
backend (a hunkonkénti átvesz/kihagy szétválasztás, méréssel).

**Hivatkozás:** kártya `b4404ed2` (szülő `f923328d`, `a7a61751`);
`scripts/hooks/outgoing-copy-gate.py`, `scripts/hooks/outgoing-copy-gate.selftest.py`,
`src/fork-upstream/acknowledged-conflicts.ts` (16. kör).

## 2026-09-06 -- A hálózat-őr javítása: a sentinel a fájl VÉGÉRE kerül, és az őr bizonyítja, hogy el tud bukni

**Kontextus:** a `5da60b85` kötelező kompenzáló kontrollja (determinizmus-őr, ami kimondja, hogy a
`fork-upstream-conflict-guard.test.ts`-ben egyetlen eset sem végez hálózati műveletet) MÉRÉSSEL
ÜRES volt. Cybersec NO-GO (21593) és QA FAIL, egymástól függetlenül: a sentinel a 65. sorban állt,
közvetlenül az első `describe` ELŐTT, tehát a vizsgált tartomány a 65 soros import-fejléc volt
NULLA esettel, és mind a 24 valódi eset a hatókörén kívül esett. QA élőben be is bizonyította:
a sentinel alá fűzött tiltott hívással a teljes fájl zöld maradt.

**Döntés:** a sentinel a fájl VÉGÉRE kerül, a vizsgált tartomány így a teljes fájl; plusz két
regressziós eset, ami bizonyítja, hogy az őr TÉNYLEGESEN elbukik.

**Miért nem elég a sentinel áthelyezése önmagában:** attól az őr még ugyanúgy lehetne dísz egy
következő szerkesztés után. Az eredeti önillesztési problémát a needle-fragmentáció oldja meg, nem
a sentinel helye -- a sentinel most kizárólag a hatókör-határ, és a helyét külön állítás rögzíti.

**Egy saját mérőeszköz-hiba, kimondva:** az első javításom a vizsgált tartományban lévő esetek
számára adott ALSÓ KORLÁTOT (`> 20`). Ez NEM diszkriminál: a sentinelt visszatolva a régi helyére
még mindig több mint húsz eset marad fölötte, mert a saját őr-blokk a fájl alján van -- a mutáció
TÚLÉLTE. Az állítás most EGYENLŐSÉG a teljes fájl eset-számával, ami pontosan azt köti ki, hogy a
sentinel a legutolsó eset alatt álljon és sehol máshol.

**Mérés:** 28 eset zölden (24-ről). Két mutáció, kilépési kóddal mérve, mindkettő pontosan a saját
esetét öli meg és semelyik másikat: (1) QA élő próbájának megismétlése, tiltott hívás a régi
sentinel-pozíció alá -> a „no case performs a remote git operation" eset pirosra vált; (2) a
sentinel visszamozgatása a régi helyére -> a „the scan covers EVERY case" eset pirosra vált.
Ráadásul a javított őr ELSŐ futása magától pirosra váltott a saját új fixture-öm `it('fetches
upstream'` címén -- a needle-ök részsztringként illesztenek, tehát a „fetches" is találat. Ez a
helyes irány egy DENY-illesztőnél (nem illeszkedni annyi, mint engedélyezni), és egyben az első
bizonyíték, hogy az őr most olyan tartományt lát, amit korábban soha.

**Ki döntött:** Cybersec (NO-GO 21593, a gyógymóddal együtt, előre lemérve); QA (független élő
próbával megerősítve); backend (az egyenlőség-alapú hatókör-állítás, miután a saját alsó-korlátos
első kísérletem mutációja túlélt).

**Hivatkozás:** kártya `5da60b85` (szülő `1f276349`);
`src/__tests__/fork-upstream-conflict-guard.test.ts`.

## 2026-09-06 -- Az upstream három SSRF-megkerülési útja nálunk is nyitva volt, átvéve

**Kontextus:** a `494fad0f` (3b klaszter) egyik fájlja az `src/web/agent-scaffold.ts`, aminek a
pinje elavult volt. A mögötte lévő upstream delta (`5b168b5a` -> `526dcf56`) nem stílus-változás:
három megkerülési utat zár az `isPublicFetchHost()`-ban, ami azt dönti el, hogy egy fetch-cél
kifelé mutat-e vagy befelé.

**Döntés:** a teljes függvény-régió ÁTVÉVE upstream-től, az upstream saját teszt-eseteivel együtt.

**Miért nyitva volt nálunk is:** a fork másolata a függvényről BÁJTRA AZONOS volt az upstream
javítás ELŐTTI verziójával (mérve az `isPublicFetchHost` és az `ownerAllowedDomains` közötti
régión), tehát semmi fork-specifikus nem volt, amit át kellett volna menteni a változáson.

A három út: (1) inet_aton-parse-olás -- a wildcard-DNS szolgáltatók mögötti feloldók a vezető
nullát OKTÁLISNAK, a `0x`-et HEXÁNAK olvassák, tehát a `0177.0.0.1.nip.io` 127.0.0.1-et ad,
miközben egy decimális-only ellenőrző négy ártalmatlan címkét lát. (2) Egyetlen címkébe csomagolt
cím -- a `2130706433.nip.io` és a `7f000001.nip.io` ugyanaz a cím egy tokenben, amit sem a pontos,
sem a kötőjeles négyes-ellenőrzés nem néz meg. (3) Az sslip.io kötőjeles IPv6 alakja,
`0--1.sslip.io` = `::1`, ami egyik forma sem.

**Miért itt szabad egészben átvenni, ahol ez a bejegyzés máskor megtagadja:** a korábbi
elutasítások az `ensureAgentHooks`-ról és a szekció-írókról szólnak, vagyis a flotta-szintű
hook-huzalozásról. Ez ezzel szemben egy önmagában álló, tiszta predikátum, amiben nulla
fork-divergencia van.

**Mérés -- ELÉRHETŐSÉG MUTÁCIÓVAL, nem az upstream állításának elhívésével:** az átvett teszteket
lefuttattam a fork JAVÍTÁS ELŐTTI függvényére: pontosan két eset bukik (a csomagolt/inet_aton és a
kötőjeles IPv6), a harmadik -- „leaves public names alone in every encoding" -- mindkét irányban
átmegy, és ez helyes: az a 2^24-es alsó korlát negatív kontrollja, ami a `123.example.com`-ot
elérhetőnek tartja. Javítás után 33/33 zöld, a hat érintett teszt-fájlon 159/159, `tsc --noEmit`
zöld.

**Ki döntött:** MikroB (az `a7a61751` plan-grilling GO-WITH-CHANGES verdiktje); backend (az
egészben-átvétel, miután megmértem, hogy a régió bájtra azonos volt az upstream javítás előttivel).

**Hivatkozás:** kártya `494fad0f` (szülő `a7a61751`); `src/web/agent-scaffold.ts`,
`src/__tests__/quarantine-allowlist-render.test.ts`,
`src/fork-upstream/acknowledged-conflicts.ts` (18. kör).

## 2026-09-06 -- 3c klaszter: friss pin mellett is négy valódi ütközés, és egy döntés, amit majdnem visszafordítottam

**Kontextus:** a `50af1a27` három fájlja (`update.sh`, `package-lock.json`, `src/model-fallback.ts`)
mindegyikének FRISS volt az upstream-blob pinje. Ez első ránézésre azt jelentené, hogy nincs
teendő. Nem azt jelenti.

**A megkülönböztetés, amit rögzíteni kell:** a friss pin azt mondja, hogy a döntés PONTOSAN ehhez
az upstream tartalomhoz készült, NEM azt, hogy a merge tiszta lesz. Read-only hármas merge-szimuláció
(`git merge-file` a három blobon, worktree nélkül): `update.sh` 4 ütközés, `package-lock.json` 40,
`src/model-fallback.ts` 1.

**Döntés fájlonként:**

- **`update.sh`** -- négy ütközésből három MARAD A MIÉNK (a POST_MERGE_MODE szerkezet, ami az
  upstream blokkját szó szerint tartalmazza az else-ágban; a `{{CHAT_ID}}` behelyettesítés, aminek
  az elejtése egy Cybered-leletet hozna vissza; a SEEDREFRESH826 komment, ami a mi bővebb,
  újramért változatunk). A NEGYEDIK ÁTVÉVE: az upstream `--include=dev` kapcsolója a rollback
  `npm ci`-jén. A fork mindkét hívási helyén hiányzott.
- **`package-lock.json`** -- a 40 ütközés nem ok a kézi feloldásra, hanem ok a NEM kézi feloldásra.
  A lockfile a fork saját `package.json`-jából ÚJRAGENERÁLÓDIK, és az FŐ-KLÓN művelet (worktree-ből
  a függőség-könyvtár szimlink a közös fába). A merge lépéséhez tartozik, nem ehhez.
- **`src/model-fallback.ts`** -- MARAD A MIÉNK, két független okból: az upstream alternációja
  visszahozná a `upgrade to increase your usage limit` startup-hint hamis pozitívot, és az alakja
  nem ERE-biztos (`grep -E` figyelmeztet a `(?:`-re), ami eltörné a `session-limit-pattern.json`
  hat nem-TS fogyasztóját.

**Amit majdnem elrontottam, kimondva:** az upstreamnek van egy `(\w+ )?` bővítése, ami tényleg fog
egy alakot, amit mi nem. Már készültem átvenni, amikor elolvastam a JSON saját `_comment`-jét: a
`f27c999b` kártya (2026-09-04) pontosan ezt a tagot MÉRLEGELTE ÉS ELUTASÍTOTTA, mert nincs MÉRT
banner-string, ami igényelné, és egy korlátlan szó-joker ennél a detektornál téves
modell-visszaminősítést okozhat. Az én diszkrimináló példám KITALÁLT, a regex próbálgatására
gyártott string, nem élesben megfigyelt -- az nem bizonyíték egy olyan döntés ellen, ami éppen a
mért stringek hiányán alapult. A korábbi döntés áll.

**Mérés a `--include=dev`-hez, VALÓDI telepítéssel eldobható temp-fában** (npm 10.9.8, node
v22.23.2): `NODE_ENV=production` + sima `npm ci` -> a dev-függőség KIVÁGVA; `--include=dev` ->
MEGMARAD; `--omit=dev` -> kivágva (kontroll). Hatókör, hogy senki ne állítson többet: a `NODE_ENV`
ebben a telepítésben sehol nincs beállítva (`.env`, `scripts/start.sh`, `install-linux.sh`,
`update.sh` -- mind mérve üres), tehát ez LÁTENS lyukat zár, nem élő üzemzavart.

**Műszer-figyelmeztetés a következő olvasónak:** az `npm ci --dry-run` MINDKÉT irányban azt
jelenti, hogy a dev-függőség hozzáadódik -- nem veszi figyelembe a `NODE_ENV`-alapú vágást, amiről
a kérdés szól. Az első próbám ez volt, és arra a következtetésre vezetett volna, hogy az upstream
egy nálunk nem létező mechanizmust javít.

**Ki döntött:** MikroB (az `a7a61751` plan-grilling GO-WITH-CHANGES 2. pontja: az update.sh-t
eldobható környezetben kell validálni, sose élesben -- így is történt); backend (a négy
ütközés fájlonkénti feloldása, és hogy a model-fallback korábbi döntését nem írom felül szintetikus
bizonyíték alapján).

**AMIT A FORK-HORGONY ELKAPOTT, ÉS AMI EBBŐL KÖVETKEZETT:** a `--include=dev` hozzáadására
elsült a `src/web/routes/updates.ts` fork-horgonya. Nem hiba volt, hanem a horgony dolga: az ottani
mentesítés azt állítja, hogy az AUTOUPDNODEENV905 NINCS átvéve és a fork exponált, és a horgony
kimondottan azért figyelte az `update.sh`-t, hogy szóljon, amint ez az állítás félig hamissá válik.
A szövege pontosan ezt kéri: "Re-decide the ACKNOWLEDGED_CONFLICTS rule -- do not just edit the
anchor to match." Így is jártam el: a szabályt újradöntöttem (a (2) fél átvéve, az (1) nyitva
marad), a horgonyt pedig a MEGMARADT állításra irányítottam át (`delete process.env.NODE_ENV` az
`updates.ts`-ben, `expect: absent`), nem töröltem. Mutációval ellenőrizve, hogy az új horgony
elsül, amikor az (1) fél landol.

**AMIT NEM ÉN DÖNTÖK EL:** a `c116696f` kártya (backend2, HIGH, planned) MINDKÉT felet tervezi, és
a leírása előre jelzi ezt a helyzetet ("ellenorizd hogy ez nem duplikalja a mostani kartyat"). Én a
(2) felet landoltam, mert az `update.sh`-ban van, tehát a 3c klaszter fájljában, és mert a korábbi
jegyzet maga nevezi "környezet-független, végleges védelemnek". Az (1) fél az `updates.ts`-ben van,
amit a 3c nem birtokol. Kommenteltem a `c116696f`-re, hogy backend2 ne csinálja meg újra; hogy a
kártya szűküljön-e az (1) félre, az MikroB döntése, nem az enyém.

**AMIT A LANDOLÁSI KAPU FOGOTT MEG, ÉS AMI EBBŐL TANULSÁG:** az első kísérlet MEGTAGADVA, mert a
rollback `npm ci` az `update.sh` `FINALIZE_EOF` heredocjában van, ami minden futáskor újragenerálja
a `store/update-finalize.sh`-t. Csak az egyik példányt írtam át, tehát a javításomat a következő
frissítés némán visszaállította volna -- pontosan az a drift-osztály, amiért a paritás-teszt
(`rollback-distance-guard.test.ts`) létezik. Nem bosszúság volt, hanem valódi hiba az én
változtatásomban. A második példány szinkronizálva.

**UGYANEZ AZ OSZTÁLY EGY HARMADIK HELYEN IS ÁLL, ÉS NEM JAVÍTOTTAM:** a
`recovery-prev-version.sh:217` csupasz `npm ci --silent`-et futtat -- ez a kézi visszaállító, az
utolsó mentsvár, amikor minden más már megbukott. Nincs sem a `50af1a27`, sem a `c116696f` fájl-
listáján, és egy operátori helyreállítási út módosítása nem rider egy upstream-integrációs kártyán.
Kommentálva a `c116696f`-re a mérésel együtt. (Az `install-linux.sh:1011` szintén csupasz, de az
friss telepítés, ahol a bukás hangos, nem néma -- más kockázati alak.)

**Hivatkozás:** kártya `50af1a27` (szülő `a7a61751`), érinti `c116696f`-et; `update.sh`,
`store/update-finalize.sh`, `src/__tests__/update-npm-ci-dev-deps.test.ts`,
`src/fork-upstream/acknowledged-conflicts.ts`.

## 2026-09-06 -- c116696f -- AUTOUPDNODEENV905 (1) fele: NODE_ENV törlése a spawnUpdateScript belsejében

**Döntés.** `src/web/routes/updates.ts` kap egy exportált `buildUpdateScriptEnv(extraEnv)`
függvényt, ami `delete process.env.NODE_ENV`-et hajt végre, majd visszaadja a `{ ...process.env,
...extraEnv }` összeállítást -- ezt hívja `spawnUpdateScript` az `env`-hez, MINDKÉT hívási úton
(fork-pull és a post-upstream-merge rebuild+restart). Ez az `50af1a27`-ben landolt (2) fél
(`--include=dev` mindkét `npm ci` ponton) párja: a (2) fél az `update.sh` SAJÁT `npm ci`
hívásait védi, a (1) fél a folyamatot, ami elindítja az `update.sh`-t -- ha az ŐT indító Node-
process maga örökölt volna `NODE_ENV=production`-t, az `--include=dev` önmagában nem lenne elég,
mert a hívási lánc elejére kell a törlés.

**Miért a VALÓDI `process.env`-t módosítja, nem egy másolatot.** Az `update.sh` több ponton is
`npm ci`-t futtat (fő telepítés, rollback, és a `store/update-finalize.sh`, amit minden futáskor
újragenerál), és mindegyik GYERMEK-folyamat a SAJÁT indításakor önállóan örökli a
`process.env`-t. Egy csak a visszaadott másolatra szorítkozó törlés csak az egyik hívást védené;
a valódi objektum módosítása az összeset. Biztonságos futásidőben törölni, mert az EGYETLEN
folyamaton belüli olvasó (`src/logger.ts`) a modul BETÖLTÉSEKOR, egyszer olvassa -- jóval azelőtt,
hogy a frissítési route egyáltalán elérhető lenne -- így semmi nem olvassa újra később azt, amit ez
töröl.

**A fork-horgony (Cybered mérése, komment 21250; Backend átirányítása, komment 21641) pontosan
úgy sült el, ahogy tervezve volt.** A horgony (`needle: 'delete process.env.NODE_ENV'`, `file:
'src/web/routes/updates.ts'`, `expect: 'absent'`) a landolási kapuban pirosra váltott, amint a
kódot megírtam -- ez a horgony munkája, nem hiba. Az `ACKNOWLEDGED_CONFLICTS['src/web/routes/
updates.ts']` szövegét ÚJRADÖNTÖTTEM (mindkét fél átvéve, a struktúrális ütközés -- upstream egy
inline spawnt javított, amit a fork már megosztott helperré emelt -- változatlanul fennáll, tehát a
bejegyzés marad, csak elfogadás-only), a horgonyt pedig `expect: 'present'`-re fordítottam: mostantól
egy jövőbeli visszavonás ellen őrködik, nem az érkezésre vár.

**Amit NEM csináltam meg, tudatosan.** Backend (komment 21648) mérve talált egy HARMADIK és
NEGYEDIK előfordulást ugyanabból a hibaosztályból: `recovery-prev-version.sh:217` (csupasz `npm
ci --silent`, a kézi katasztrófa-visszaállító út) és `install-linux.sh:1011` (csupasz `npm ci`,
friss telepítés, de ott a bukás HANGOS, nem néma). Egyik sincs ennek a kártyának a leírásán, és
mindkettő MikroB/a következő kártya döntése -- nem bővítettem a diffet rájuk.

**Tesztek.** `src/__tests__/update-node-env-strip.test.ts` (5 eset, `buildUpdateScriptEnv`-et
közvetlenül hívja -- ugyanaz a függvény, amit `spawnUpdateScript` ténylegesen használ, nincs
párhuzamos, driftelhető implementáció): törli örökölt `production`-t, a VALÓDI `process.env`-en
(nem csak a visszaadott másolaton), no-op ha nincs beállítva, `extraEnv` felülírja, más kulcsok
érintetlenek. `fork-upstream-conflict-guard.test.ts` teljes 28/28 zöld az új horgony-iránnyal;
`tsc --noEmit` tiszta.

**Hivatkozás:** kártya `c116696f`, párja `50af1a27` (szülő `a7a61751`); `src/web/routes/
updates.ts`, `src/__tests__/update-node-env-strip.test.ts`, `src/fork-upstream/acknowledged-
conflicts.ts`.
## 2026-09-06 -- Az upstream-drift figyelő EGY kártyát gondoz, és a hallgatás a mérnöki része

**Döntés:** a `99c2eb09`-ben a landolási kapuból kiemelt drift-ellenőrző mostantól egy napi
ütemezett feladatban fut (`fork-upstream-drift-watch`, `mikrob` munkamenetében, 07:40), és az
eredményt EGYETLEN kanban-kártyán tartja: nyit egyet, ha nincs nyitva, egyébként arra kommentel.
A döntési logika tiszta függvény (`src/fork-upstream/drift-watch.ts`), az I/O külön
(`store/fork-upstream-drift-watch.mjs`).

**Miért nem elég a "nyiss kártyát drift esetén":** az ellenőrző MINDEN körben ugyanazt a driftet
látja, amíg valaki fel nem oldja. Egy naiv figyelő tehát naponta termelne egy azonos kártyát --
a 6b. szabály dedup-előírásának megsértése gépi léptékben, ami épp az a zaj, amitől a valódi jelzés
olvashatatlan lesz.

**HÁROM HALLGATÁS, AMI NEM KÉNYELEM, HANEM KÖVETELMÉNY.**
(1) *Elérhetetlen upstream:* nem nyit kártyát ÉS nem írja felül az állapotfájlt sem. Ha egy
hálózati kimaradás a saját ujjlenyomatát írná be, a következő elérhető futás "változást" látna, és
megismételné azt, amit a tábla már hordoz. A "nincs mit mondani" és a "nincs baj" nem nézhet ki
egyformán -- ugyanaz az elv, amiért a META-állítás ARMED/SKIPPED néven jelenti magát.
(2) *Változatlan drift:* az ujjlenyomat a FÁJLHALMAZRA megy, nem az upstream blob-shákra. Az
`upstream/develop` majdnem minden nap mozdul, tehát egy shákat is tartalmazó ujjlenyomat naponta
kommentelne, miközben a cselekvésre váró tény -- hogy MELYIK fájlokat nem döntötte újra senki --
változatlan. Ugyanaz a minta, amit a README skill-drift bejegyzése már kimond: a halmaz
VÁLTOZÁSÁRA szól a riasztás, nem a darabszámára.
(3) *Ember által lezárt kártya, mozdulatlan drift mellett:* a zárás VÁLASZ. Egy pótkártya minden
reggel ugyanaz a duplikáció, egy emberi lépéssel később. A hallgatás addig tart, amíg a világ
ténylegesen tovább nem mozdul; elveszett állapotfájl esetén viszont nyit, mert a "sosem szóltam"
nem azonos a "megválaszoltak"-kal.

**A KÁRTYA-AZONOSÍTÁS HORGONYZOTT, NEM RÉSZSZTRING.** A figyelő a `[UPSTREAM-DRIFT]` markert a cím
ELEJÉN keresi (a 2. szabály `[NN%]` előtagján át). Egy olyan kártya, ami csak EMLÍTI a markert --
és pont az a kártya ilyen, amelyik ezt a figyelőt kérte -- nem a drift-kártya. Itt fordítva áll a
kockázat, mint egy DENY-illesztőben: ott a nem-illeszkedés enged át, itt a laza illeszkedés OKOZZA
a rossz írást, tehát a horgonyzás a biztonságos oldal. A DECOY-eset mindkét szinten (vitest és
selftest) meg van írva, és a `includes`-ra visszavett mutációt mindkettő megöli.

**BIZONYÍTÁS, NEM ZÖLD PIPA:** öt mutáció a döntési modulra és három a lefordított artefaktumra,
mind kilépési kóddal mérve, mind pontosan a saját esetét öli meg (a hallgatás-ágak: `unchanged`,
`closed-and-unchanged`, `upstream-unreachable` állapotírás, a marker-horgony, és a sha-alapú
ujjlenyomat). Egy hatodik mutáció a GLUE-ra (az állapot sosem íródik) is elbukik, tehát a
huzalozás bizonyítottan eljut a döntésig -- egy őr, amit senki nem hív, nem őr.

**MÉRT KIINDULÓ ÁLLAPOT (2026-09-06):** elérhető upstream, 0 fork-owned ütközés, 0 nem-döntött
ütközés, 8 ELAVULT elismerés (`src/db.ts`, `src/web/hook-registration-guard.ts`,
`src/web/routes/agents.ts`, `src/web/routes/kanban.ts`, `web/app.js`, `web/lang/en.js`,
`web/lang/hu.js`, `web/style.css`), 53 ütköző fájl összesen. A teljes riport 19 KB, mert minden
elavult szabály hordozza a felhalmozott újramérési jegyzeteit -- ezért a KÁRTYA a drift ALAKJÁT
kapja (fájl + rögzített/mostani blob), a prózát nem: az az `acknowledged-conflicts.ts`-ben van.

**Ki döntött:** MikroB (24642, "C" irány) a kártya-felbontásban; a hallgatás három ága és a
horgonyzott marker backend mérnöki döntése, ezen a bejegyzésen keresztül felülvizsgálatra kitéve.

**Hivatkozás:** kártya `a1ce8952` (szülő `1f276349`, testvérek `99c2eb09`, `5da60b85`);
`src/fork-upstream/drift-watch.ts`, `src/__tests__/fork-upstream-drift-watch.test.ts`,
`store/fork-upstream-drift-watch.mjs`, `store/fork-upstream-drift-watch.selftest.sh`,
`.gitignore`, `README.md`.

## 2026-09-06 -- 404e8dd6 -- The Local LLM switches stay usable when Ollama is down; the card that asked for them was a duplicate

**Dedup first (fron-ted, rule 6b):** the card as dispatched asked for a per-model on/off switch on
the Local LLM page. That switch had already landed (5d151091 backend, 5dd4a211 frontend, enforced
in `store/local-llm.sh` for every shell caller). What Peti could not see on 2026-09-06 was
different: the gpu-crashloop-guard had masked `ollama.service`, `GET /api/local-llm/models`
answered 503 fail-closed, and the page showed a toast and an EMPTY model list -- the switches were
invisible exactly on the day they were wanted. MikroB re-scoped both cards to that gap instead of
closing them as duplicates.

**Decision (FE, contract-first against the re-scoped 75f3c77d):** the flags answer
(`{ ollamaUp, models }`, the list falling back to `local-llm-model-state.json` when Ollama is down)
is kept as a fallback list. When the status endpoint reports Ollama down, the page draws the known
models with their switches under a visible "Ollama is not running" banner; each row shows only the
benchmark the state file holds (tok/s @ ctx, or "not measured" -- never an invented figure), and
carries NO Use/Update control, because those need Ollama and a control that cannot act is a dead
end (rule 9). The switch markup moved into one helper used by both the live and the fallback rows,
so the two lists cannot drift. With the OLD backend (503) the page keeps today's behaviour (toast,
no switches), so the two halves can land in either order.

**Measured, not assumed:** Playwright against the real `web/` bundle with the mocked contract, 15
checks -- three fallback rows, tok/s @ ctx, unmeasured label, disabled row + `aria-pressed`, no
Use/Update, banner, 44px targets on desktop and at 375px with no horizontal overflow, an enable
click that POSTs the encoded name and re-renders from the fresh answer, a failing POST that speaks
the i18n error and re-enables the button, and the 503 path unchanged. Mutation map: fallback branch
disabled, a Use button on a fallback row, `aria-pressed` dropped from the helper, banner text
inverted, an invented tok/s on a null benchmark -- each red in the string-contract tests and/or the
live check; controls 32/32 green.

## 2026-09-06 -- A VRAM-kapu nem százalékra dönt, hanem arra, KIÉ a memória

**Döntés:** a `store/vram-guard-check.sh` tier-besorolása mostantól az IDEGEN terhelésre megy, nem
a nyers kihasználtságra: a saját, betöltött modellünk VRAM-ja (`ollama /api/ps` `size_vram`)
levonódik, és a maradék dönt. Amíg a saját munkánk tartja a `/tmp/local-llm-gpu.lock`-ot, a mérés
egyáltalán nem számít idegen terhelésnek (`own-busy` állapot), és nem is kerül a hiszterézisbe.

**Ez nem finomhangolás volt, hanem egy MÉRHETŐ hiba javítása.** Ezen a gépen (2026-09-06):
összesen 6144 MiB VRAM; leállított ollama mellett 1649 MiB reziduens (asztali/WSL alap, 26,8%); az
alapértelmezett helyi modell (`qwen2.5-coder:7b-instruct-q4_K_M`) súlyai 4466 MiB. A saját MELEG
modellünk tehát ~99,5%-ot mutat, ami a `hard_pct` (92) fölött van, vagyis a 108c7b10-ben szállított
küszöb minden helyi dispatchet VISSZATARTOTT VOLNA pontosan abban az állapotban, amiért a meleg
modellt egyáltalán tartjuk (mért különbség: 27 mp kontra 120 mp). Ezt nem lehet küszöb-hangolással
megoldani: nincs az a szám, ami elválasztja a "a mi 4,4 GB-os modellünk be van töltve" esetet a
"valami más evett meg 4,4 GB-ot" esettől, mert a szám azonos. Csak az attribúció választja el.

**A ZÁR NEM REDUNDÁNS A KIVONÁSSAL, és pontosan egy dolgot fed le:** a modell BETÖLTÉSE alatt a
VRAM már nő, de az `/api/ps` még nem jelenti, tehát a kivonás nullát lát és az egész betöltés
idegennek látszik. A `local-llm.sh` pont ezen az ablakon át tartja a flockot. Ezért az `own-busy`
minta nem is íródik az állapotfájlba: a saját terhelésünkkel tanítani a hiszterézist az a mód,
ahogy a kapu megtanulna bizalmatlan lenni velünk szemben.

**A KÁRTYA HÁROM ÁLLAPOTOT SOROL FEL, DE NÉGY VAN.** A hiányzó sor: zár szabad + a mi modellünk
betöltve + az idegen terhelés IS magas. Ezt el kell dönteni valahol, és a kivonás magától eldönti
(a maradék idegen rész magas -> HOLD), anélkül hogy egy negyedik különleges esetet kellene írni.
Ezért lett a mechanizmus attribúció és nem eset-táblázat.

**KÉTSÉG ESETÉN ONLINE, MINDEN ÚJ ÁGON.** Elérhetetlen vagy értelmezhetetlen `/api/ps`: nem vonunk
le semmit, tehát a teljes mérés idegen marad (a HOLD irányába visz). Ha az ollama többet állít
magáról, mint amennyit az eszköz jelent (`own > used`), az a két mérés ellentmondása, nem
bizonyíték arra, hogy a GPU szabad: szintén nulla attribúció. A fordított választás (az idegen részt
nullára szorítani) pont azon a bemeneten ADNA át, amit a legkevésbé értünk.

**EGY SAJÁT HIBA, AMIT A MUTÁCIÓ FOGOTT MEG.** Az első változatban a kártya lényegét hordozó eset
EGYETLEN mintavétel volt, és az attribúciót teljesen kivevő mutáció TÚLÉLTE: a hiszterézis az ELSŐ
olvasást úgyis átengedi, akármi a tier, tehát az állításom nem különböztetett meg semmit.
Fenntartott (sustained_seconds fölötti) mintára cserélve a két tervezés végre eltér, és a mutáció
meghal. Ugyanaz a hibaosztály, mint egy alsó korlát ott, ahol egyenlőség kell.

**HERMETIKUSSÁG:** a két új bemenetnek env-alapértelmezése is van
(`VRAM_GUARD_OWN_VRAM_MIB`, `VRAM_GUARD_LOCK_HELD`), és a selftest EGYSZER állítja be őket. Enélkül
minden meglévő eset a fejlesztő élő ollamáját és a valódi GPU-zárat olvasná, tehát ugyanaz a
selftest más verdiktet adna egy olyan gépen, ahol be van töltve egy modell -- környezetfüggő teszt,
ami determinisztikusnak látszik.

**Ki döntött:** MikroB (21170. komment a 108c7b10-on, Cybersec megerősítésével, 24712); a negyedik
sor kezelése és a `own > used` ág iránya backend mérnöki döntése, itt felülvizsgálatra kitéve.

**Hivatkozás:** kártya `efd18ee4` (szülő `40568837`, testvérek `108c7b10` done, `f9bad591` és
`a1c4dc51` blokkolt); `store/vram-guard-check.sh`, `store/vram-guard-check.selftest.sh`, `README.md`.

## 2026-09-06 -- e5fc1fb4 -- The Local LLM page is rebuilt around the switches and the routing, and the Overview swimlane is extended rather than duplicated

**Peti's four requirements (Telegram, 2026-09-06), and what each became (fron-ted):**
1. *Every installed model, each switchable.* The Models block moves directly under Status, gains a
   measured summary line ("N telepített modell · M letiltva", counted from the flags, not asserted),
   and each row wears a chip saying which presets are routed to it (override count) or that it is
   the default for every other preset. The list itself was already every Ollama tag plus the
   disabled-but-removed rows (5dd4a211) and, since 404e8dd6, the state-file fallback when Ollama is
   down; the live check now pins five rows including an unbenchmarked and an embedding model.
2. *Routing made visible.* The former "Kategóriák" section becomes "Feladat-routing": the same
   preset rows with the same real enable/disable switch (store/local-llm.sh still reads
   `disabledCategories`, so removing the switch would have removed enforcement), now joined with the
   model each preset resolves to and why (override from local-llm-model-routing.json, or the default
   model), plus two panels: the categories the router never hands to a local model (with their
   ceilings) and the latest card-level LOCAL/ONLINE verdicts from card-build-route.log. None of that
   was reachable over HTTP, so a BE card (ecf38e5a, backend2, Pair-FE/Pair-BE wired) carries the
   contract `GET /api/local-llm/routing`; the FE is built against it with a mock and, while the
   endpoint answers 404, says so in the section and names the card -- switches keep working, the
   model column reads "nem ismert", no chip is invented.
3. *The aggressiveness slider stays.* Untouched, in its own section between Models and Routing; the
   routing summary line quotes its value and the derived difficulty threshold so the two layers read
   as one decision.
4. *The Overview swimlane (d6ecb003) is extended, not duplicated.* The lane label becomes a button
   that opens the Local LLM page on that model's row (highlight flash), a switched-off model wears
   the same "Letiltva" badge in its lane (from the BE `enabled` field when present, else from the
   /models flags fetched alongside -- never a guess when both are absent), and the task tooltip gains
   a "Routing" row (override → model, or default model) only when the routing answer is present.

**Not done here, on purpose:** the Categories i18n keys stay in the catalogs (unused keys are
harmless, deleting them is not this card's scope); the swimlane's own geometry, palette and data
contract are untouched. Peti's permission to drop the category model entirely waits for the
88e3614c routing tasks -- today the switches are enforcement.

**Measured:** Playwright on the real `web/` bundle with the mocked contract, 25 checks across the
routing-present and routing-absent states, 375px, and the Overview (lanes as buttons, disabled
badge, tooltip routing row, click-through with highlight). String-contract tests: +50 (68 -> 118 in
the Local LLM set), the d6ecb003 widget test and 11 other index/overview tests unchanged green.
Mutation map: routing-absent chip inventing the default model, lane label demoted to a span,
tooltip routing row without data, disabled count hardcoded to 0, routing loaded after the first
paint -- each red in the string tests and/or the live check; controls green.

## 2026-09-06 -- f53ef8e4 -- gate-closure-check.py Gate-SHA-listát HALMAZKÉNT, nem első-tagként hasonlít

**Döntés.** A `store/gate-closure-check.py` `verdict_of()`-ja mostantól a Gate-SHA sor MINDEN
hex tokenjét megtartja (egy tuple-ben, sorrend szerint), nem csak az elsőt. Az egyezés-vizsgálat
(`sha_sets_agree()`) két verdikt HALMAZAI között bármely metsző pár alapján dönt, nem a puszta
első elem alapján. A tokenek gyűjtése a `src/web/kanban-gate-completeness-guard.ts`
`extractGateShas()`-ából PORTOLT szűrőn megy át: egy `szulo`/`parent`/`merge-base` jelölésű sha
kizárva, és egy `/`-t tartalmazó token (branch/path) csak akkor számít sha-citálásnak, ha egyik
`/`-szegmense sem csupasz hex -- ez zárja ki a kártya SAJÁT ID-jét egy ágnévből (pl.
`feat/tenant-auth-ip-coarsen-4a6c47f0`), ami 8 hex karakteren indistinguishable egy rövid sha-tól.

**Miért.** Cybersec mérése a teljes táblán: 93 kártya visel többsoros, vesszős Gate-SHA-listát (a
4b. szabály kimondottan engedi ezt az alakot), ebből 16 kapott hamis DISAGREE-t, mert a lista
IDŐRENDI (legrégebbi elöl) és az eszköz az ELSŐ, tehát legrégebbi -- épp a javítás ELŐTTI --
commitot vágta ki. Három bizonyított eset: `f00b3a7f` (kumulatív 8-elemű QA-lista a másik két gate
2-elemű deltája ellen, közös záró pár), `7d45ecbb` (ugyanaz), `54fd9c02` (BÁJTRA AZONOS két-sha
lista FORDÍTOTT sorrendben -- ez az eset, ami a halmaz-metszetet megkülönbözteti egy "vedd az
utolsó elemet" javítástól, amit a `store/gate-pretriage-candidates.py` a SAJÁT, más okból helyes
konvenciójaként használ: az egyik oldal `A, B`-t ír, a másik `B, A`-t, az "utolsó elem" szabály itt
is hamis DISAGREE-t adna).

**A második, saját mérésű lelet, MIELŐTT a javítás landolt volna.** A kártya eredeti javaslata (csak
a halmaz-gyűjtés, szűrő nélkül) behozta volna az `a20f0aa7` kártya élő incidensét: a `4a6c47f0`
kártya saját Gate-SHA sora `d49e9c7a... (CleanCore, ág feat/tenant-auth-ip-coarsen-4a6c47f0, ...)`
alakú, és az ágnévbe ágyazott kártya-ID egy VALÓS hex-alakú token, amit a naiv gyűjtés második
sha-ként vett volna fel. Élesben mérve, a szűrő NÉLKÜL: `CYBERSEC=d49e9c7a...,4a6c47f0` (a kártya
ID-je sha-ként!). A `kanban-gate-completeness-guard.ts` már megoldotta ezt a PONTOS osztályt (három
kör finomítás, `a20f0aa7`/`5bc8f740` élő incidens, 3301+ valós sor mérve) -- backend2 saját korábbi
kommentje (21435) kifejezetten ennek az újrafelhasználását kérte, nem az újra-kitalálását.
Átvéve: a `_PARENT_MARKED_SHA` (szulo/parent/merge-base jelölés kizárása) és `_is_path_token`
(egy `/`-t tartalmazó token csak akkor path, ha valamelyik szegmense nem csupasz hex -- így a
flotta `A/B` rövid/hosszú "mindkét commit" idiómája nem esik áldozatul).

**Ami emiatt UTÓLAG kiderült egy régi DECISIONS-bejegyzésről.** A `c52e2823` (2. kör) bejegyzés
`4a6c47f0`-t "valódi, nem hamis" DISAGREE-ként sorolta fel. Ez maga is téves volt: Cybersec saját
delta-jegyzete (komment 21326, ugyanazon a kártyán) ezt már korábban kimondta -- mindhárom gate
ténylegesen a `d49e9c7a`-t nevezte meg (QA és Cybered kételemű listája `901b6fbb, d49e9c7a`
formában, mindkettőt), és a "901b6fbb-en áll" olvasat maga volt az itt javított hiba. A tartalom
(md5, kommentektől megtisztítva) bájtra azonos a két shán. Élesben újramérve, a mostani javítással:
`AGREE|901b6fbb,d49e9c7a`. A régi bejegyzést NEM írtam felül (append-only), csak itt mondom ki: az
a mondat elavult, és ez a bejegyzés az, ami korrigálja.

**Regresszió.** `gate-closure-check.selftest.py`: 91/91 zöld (83 régi + 8 új: a három bizonyított
eset, egy diszjunkt-lista negatív kontroll, a kártya-ID-ágnév eset + saját negatív kontrollja, a
merge-base eset + saját negatív kontrollja). Mutáció-tesztelve: az első-token-only állapotra
visszaállítva a négy halmaz-eset FAIL-re vált, tehát nem vákuum. Élesben ellenőrizve (nem csak
szintetikusan): `54fd9c02`, `dc5b714d`, `f00b3a7f`, `7d45ecbb`, `4a6c47f0` mind AGREE-re fordul (a
`4a6c47f0`-nál a kártya-ID immár NEM jelenik meg a sha-halmazban), `edb721ec` helyesen marad
DISAGREE (valódi diszjunkt lista, negatív kontroll).

**Ismert korlát, kimondva.** Egy sha-t nem csak jelölőszóval (szulo/parent/merge-base) lehet
"csak kontextus"-ként megnevezni: `3ae71df1`-en Cybersec egy komment prózájában "(21120,
292a6820) FELOLDVA"-t ír, ahol a `292a6820` egy KORÁBBI, már felváltott NO-GO shája, nem
jelölőszóval bevezetve. Ez a szűrőn átcsúszik és bekerül a halmazba -- élesben mérve nem okozott
téves végeredményt (a valódi közös sha, `563de699`, mindhárom gate halmazában jelen van), de
elméletileg ütközhetne egy másik gate genuinen eltérő shájával. Nem oldottam meg: a természetes
nyelvi "ez már lezárva" kifejezésmódok felsorolása egy külön, nyitott végű feladat, nem ennek a
kártyának a hatóköre.

**Hivatkozás:** kártya `f53ef8e4` (Cybersec mérése és javaslata, 24393/21324/21352); kapcsolódó
`dc5b714d`, `4a6c47f0`, `c52e2823`, `a20f0aa7`; backend2 saját korábbi mérése (komment 21435);
`store/gate-closure-check.py`, `store/gate-closure-check.selftest.py`,
`src/web/kanban-gate-completeness-guard.ts` (a portolt referencia).
## 2026-09-06 -- dbba0424 -- PERMDENY905: az Escape egy engedélykérésen NEM semleges, tehát nem nyomunk semmit

**A DÖNTÉS.** A channel-monitor menü-helyreállító ága, ami eddig vakon Escape-et küldött minden
blokkoló modálisra, mostantól előbb megkérdezi, hogy tool-permission dialógus-e. Ha igen: NULLA
billentyű és egy hangos riasztás az operátornak. Ugyanaz az elv, amit a fel nem ismert
trust-dialógusnál (TRUSTGATE901) és a modell-hozzájárulásnál (FABLEFALL1) már kimondtunk: ahol
minden billentyű egy VÁLASZ, ott nincs ártalmatlan billentyű, tehát nem az ügynök dönt.

**A DEFEKTET NÁLUNK MÉRTEM MEG, NEM AZ UPSTREAM JELENTÉSÉBŐL VETTEM ÁT.** A kártya kifejezetten ezt
kérte, és jogosan: egy másik telepítés riportja nem bizonyíték a mi másolatunkról. Elfogtam egy
valódi Bash-engedélykérést ebből a telepítésből (Claude Code v2.1.263, `tmux capture-pane -p`), és
a három mérés ez lett: `detectsBlockingMenu` IGAZ, `detectsFirstRunGate` NULL,
`detectsModelConsentDialog` HAMIS. Vagyis a panel pontosan a vak Escape ágába esett. A defekt tehát
nálunk is fennállt, nem elméleti.

**A FELISMERÉS SZÁNDÉKOSAN SZÉLES, ÉS EZ IRÁNY, NEM LUSTASÁG.** A hamis pozitív ára annyi, hogy egy
valódi beragadt menü riasztást kap Escape helyett -- az operátor akkor is megtudja. A hamis negatív
ára az, hogy NEM-et válaszolunk a nevében, csendben. A két hiba nem egyenrangú, ezért a felismerés
két, egymást fedő jelre épül: a lábjegyzet-jelölőre a footer-régióban VAGY a kérdés+Yes alakra az
egész panelen.

**A REGIONÁLIS RÉSZLET, AMI SZÁMÍT.** A footer-tag ugyanazon a nyolc soros ablakon fut, mint amit a
`detectsBlockingMenu` néz. Egy finomítás, ami SZŰKEBB régiót vizsgál, mint a kapu, amit finomít,
pont azt a rést nyitja újra, ami miatt létezik. Az upstream öt sorral dolgozik; nálunk ez a nyolc a
helyes érték, mert a mi kapunk nyolcat használ.

**EGY MÉRT ELTÉRÉS, AMIT JELENTEK ÉS NEM JAVÍTOK.** Ugyanaz a dialógus egy frissen indult
sessionben, ahol a tartalom még nem tölti ki a képernyőt, 11 üres sort kap alá a capture-ben. A mi
`detectsBlockingMenu`-nk NYERSEN vágja az utolsó nyolc sort, tehát ilyenkor csak üres sorokat lát,
és a panel semmit nem kap: se Escape-et, se riasztást. Néma, de nem rossz válasz. Az upstream
előbb levágja az üres farkat (`liveTailRegion`), és látná. Ez a `detectsBlockingMenu`-ről szóló
külön lelet, nem ennek a kártyának a hatóköre -- egy működő detektorhoz nem nyúlok kártya nélkül.
Az új detektor viszont a párnázott esetet IS felismeri, tehát ha a kaput később kiszélesítik, ezen
az ágon nincs több teendő. Az eset teszttel rögzítve, hogy az eltérés kimondott tény legyen.

**Ki döntött:** backend2 lelete (upstream `ab96c868f316` blob, PERMDENY905), MikroB nyitotta
kártyaként adopciós döntésre; a mérés, a régió-választás és a nem-javítom-a-kaput határvonal
backend mérnöki döntése, itt felülvizsgálatra kitéve.

**Hivatkozás:** kártya `dbba0424`; `src/pane-state.ts` (`detectsPermissionDialog`),
`src/web/channel-monitor.ts`, `src/__tests__/pane-permission-dialog.test.ts`, `README.md`.

## 2026-09-06 -- 7d47ca16 -- A csendes kézbesítést OSZTÁLY kéri, nem szabad boolean, és a végpont zárva marad

**A DÖNTÉS.** A `createAgentMessage` többé nem fogad `wake: boolean`-t. A hívó egy nevesített
üzenetosztályt ad meg (`quietClass`), és csak a `QUIET_MESSAGE_CLASSES` statikus, forráskódbeli
listán szereplő osztály kap csendet. Minden más -- ismeretlen osztály, elgépelés, nem-string,
hiányzó érték -- ÉBRESZT. A nyers boolean út nem "nem használjuk", hanem típusszinten nem létezik:
a régi alak fordítási hiba.

**MIÉRT OSZTÁLY ÉS NEM VISELKEDÉS (MikroB, 21447. komment).** Egy string, ami a forrásban ott van,
egy gate által OLVASHATÓ tény. Egy hívó megítélése nem az. A lista bővítése ezért kód-változtatás,
ami a szokásos kapun megy át; nincs konfigurációs fájl, nincs env-változó, és a lista `Object.freeze`
alatt van, hogy a "nincs futásidejű út, ami bővíti" állítás igaz legyen, ne csak leírva legyen.

**A FAIL-CLOSED IRÁNYA ITT A HANGOSSÁG FELÉ MUTAT.** Egy elutasított kérés ÉBRESZTÉST ad, nem
elnémítást. Ez ugyanaz az aszimmetria, amit a `messageWakesReceiver` már kimond: egy felesleges
ébresztés egy megszakítás ára, egy tévedésből elnémított hibajelzés viszont addig láthatatlan, amíg
valaki véletlenül oda nem néz.

**A TESZT KORLÁTJA, KIMONDVA.** A kártya azt kéri, hogy egy fail/security-osztály felvétele a listára
BUKJON EL. Ezt csak NÉV szerint lehet kikényszeríteni: a lista stringekből áll, és egy string nem
hordoz bizonyítékot arról, mihez tartozik. Az őr tehát elkapja az `agent-failure-alert`-et, és nem
kapja el a `class-17`-et. Ez valódi korlát, nem szépítem: a valószínű hiba az, hogy valaki
őszintén nevezi el az osztályt és mégis felveszi -- azt fogja. A tesztet lemértem egy mutánssal (a
lista bővítése `agent-failure-alert`-tel), három eset bukott el rá.

**A VÉGPONT ZÁRVA MARAD, ÉS EZ TUDATOS DÖNTÉS.** A 3bd457ed szándékosan nem nyitotta meg a `wake`
mezőt a `/api/messages`-en, arra hivatkozva, hogy előbb kell az allowlist. Az allowlist megvan, a
végpontot MÉGSEM nyitottam ki. A kártya a hívó OLDALÁN kér statikus listát, és a jogosult hívók
folyamaton belüli figyelők, akiknél az osztály egy forráskód-literál. Egy HTTP-törzsben érkező
osztálynév visszaadná a választást annak, aki tokent tart -- ugyanaz az ablak, amit az 1. lépés nem
akart kinyitni, csak most vetettnek látszó névvel. Ha ez később mégis kell, az külön kártya külön
kapuval; a `message-wake-field.test.ts` végpont-tesztje az, aminek előbb pirosra kell váltania.

**Ki döntött:** MikroB (21447. komment: statikus konstans-lista a hívó oldalán); a végpont zárva
tartása és a név-alapú őr korlátjának kimondása backend mérnöki döntése, itt felülvizsgálatra kitéve.

**Hivatkozás:** kártya `7d47ca16` (szülő `dc35fa1a`, előzmény `3bd457ed`, következő `8f33a1a1`);
`src/web/message-wake.ts`, `src/db.ts`, `src/__tests__/message-quiet-class-allowlist.test.ts`,
`src/__tests__/message-wake-field.test.ts`, `README.md`.

## 2026-09-06 -- 3e4dc2c3 -- gate-closure-check.py: nem-REVIEW komment is deklarálhat ellenőrizetlen shát

**Döntés.** `store/gate-closure-check.py`-nak új `undeclared_post_review_shas()` függvénye van. A
`check()` a REVIEW-forrású alapértelmezett úton (`use_declared`, nem `--expect`/`--no-expect`)
mostantól megnézi: van-e a legfrissebb `REVIEW` UTÁN olyan komment, ami Gate-SHA-t deklarál, de
se a REVIEW sajátja, se egyetlen gate-verdikt nem fedi -- ha van, a válasz `STALE`, nem a régi
REVIEW sháján nyugvó néma `AGREE`.

**Miért.** A `declared_shas()` -- helyesen, saját mérése szerint -- KIZÁRÓLAG a legfrissebb
`REVIEW`-nyitó kommentből olvas (bármely komment forrásként 8 kártyát javítana, 8-at törne). De egy
építő rutinszerűen deklarál újabb commitot `REVIEW` szó NÉLKÜL is (pl. "F-1 JAVITVA -- delta-gate
kell\nGate-SHA: ..."), és ha egyetlen gate sem verdiktel az új shára, az alapértelmezett válasz a
RÉGI shán marad -- olyan kódot igazol vissza, amit senki nem nézett meg. Cybered mérése a teljes
táblán: 14 kártyán fordul elő ez az alak, ebből 8-on a válasz hibásan `AGREE`, miközben `--expect`-tel
ugyanaz a kártya `STALE`-t ad (7 a nyolcból már `done`). A helyes irány fail-closed: `STALE`, nem
`AGREE`.

**Hatókör, kimondva.** Kizárólag a REVIEW-forrású alapértelmezett utat érinti -- egy explicit
`--expect` a hívó SAJÁT állítása, nem kérdőjeleződik meg. Az ellenőrzés nem azt kérdezi, hogy a
REVIEW saját mutatója friss-e (az egy KÜLÖN, korábban is létező hiányosság, amit ez a kártya nem
old meg -- lásd a szintetikus "a gate DELTA-gate-elt, de a REVIEW nem frissült" kontroll-esetet,
ami helyesen `UNRESOLVED`-re esik, nem hamis `AGREE`-re és nem a rossz `STALE`-re), hanem azt, hogy
LÁTTA-E egyáltalán valamelyik gate az újonnan deklarált shát.

**Tesztek.** `gate-closure-check.selftest.py`: 97/97 zöld (91 régi + 6 új: a pozitív eset Cybered
saját 58c498f2/1c5a41b4 példájával, egy kontroll ahol a gate tényleg delta-gate-elt, egy kontroll
ahol a kesőbbi komment maga is REVIEW, egy `--expect`, egy `--no-expect`, egy Gate-SHA nélküli
komment). Mutáció-tesztelve: az orphan-ellenőrzés kikapcsolva (`orphans = []`) pontosan a pozitív
eset FAIL-re vált, a többi 96 zöld marad -- nem vákuum.

**Hivatkozás:** kártya `3e4dc2c3` (Cybered mérése, üzenet 24426); `store/gate-closure-check.py`,
`store/gate-closure-check.selftest.py`.

## 2026-09-06 -- c116696f (delta) -- buildUpdateScriptEnv LOKÁLIS másolatot módosít, nem az élő process.env-et

**Döntés.** A `buildUpdateScriptEnv()` (card c116696f) MÓDOSÍTVA: a `NODE_ENV` törlése egy
LOKÁLIS `env` másolaton történik (`const env = { ...process.env, ...extraEnv }; delete
env.NODE_ENV; return env`), NEM a valódi `process.env`-en. Cybersec NO-GO-ja után, delta-gate.

**Miért volt hibás az eredeti.** Az eredeti indoklásom ("update.sh több ponton is npm ci-t futtat,
mindegyik gyermek-folyamat külön öröklődik, tehát a valódi process.env-et kell törölni")
TÉVES volt: egy gyermek-folyamat a SAJÁT env-tábláját a spawn() pillanatában, OS-szintű
MÁSOLATKÉNT kapja meg (execve envp), nem a szülő élő objektumára mutató referenciaként -- a szülő
KÉSŐBBI mutációja már nem ér el hozzá. Cybersec ezt saját, futtatott Node child_process-teszttel
igazolta (nem csak érveléssel). Tehát egy LOKÁLIS másolat, amit a spawn()-nak adunk át, PONTOSAN
ugyanúgy védi az update.sh-t ÉS minden leszármazottját (rollback npm ci, ujragenerált finalize
script), mint a valódi objektum módosítása -- a leszármazottak update.sh SAJÁT env-jét öröklik,
ami már NODE_ENV nélküli, nem a mi Node-folyamatunk élő objektumát.

**Miért veszélyes volt a valódi process.env módosítása.** A mutáció HATÁRIDŐ NÉLKÜLI: az update.sh-nak
számos korai kilépési pontja van a finalize/restart LÉPÉS ELŐTT (pl. sikertelen `npm ci`, ~928. sor,
`exit 1`). Ezeken az utakon a HÍVÓ node-folyamat -- a mi hosszan futó dashboard-unk, ami épp törölte
a SAJÁT `process.env.NODE_ENV`-jét -- tovább fut, változatlanul, törölt állapotban, amíg valaki
kézzel újra nem indítja. Ez PONTOSAN az a minta (ismétlődő sikertelen frissítés, újraindulás
nélkül), ami az AUTOUPDNODEENV905-öt öt rollbackra vitte 10 nap alatt egy ügyfélnél -- a javítás
után minden ilyen ismétlődő sikertelen próbálkozás MOSTANTÓL is törölte volna a NODE_ENV-et az élő
folyamatból, nyom nélkül, amíg a folyamat esetleg napokig újra nem indul. Ma nincs ismert aktív
kódút, ami ebből kárt csinálna (a QA/Cybersec által ellenőrzött olvasók mind import-időben futnak),
de a "ma senki nem olvassa" állapot semmivel nincs kikényszerítve.

**Amit korrigáltam:** a kódot (lokális másolat), a doksi-kommentet (a hibás "must mutate the real
process.env" indoklás helyett a helyes OS-szintű env-másolás magyarázata), a
`src/__tests__/update-node-env-strip.test.ts` 2. esetét (mostantól azt várja, hogy
`process.env.NODE_ENV` VÁLTOZATLAN maradjon a hívás után, ne `undefined` legyen -- rule 7: ez egy
HIBÁS invariáns pinneléséből a HELYES invariáns pinnelésévé válik, nem gyengítés), és a
`src/fork-upstream/acknowledged-conflicts.ts` fork-horgonyát (needle `delete process.env.NODE_ENV`
-> `delete env.NODE_ENV`, ugyanaz az `expect: 'present'`).

**Tesztek.** Mind az 5 eset zöld a korrigált kóddal; mutáció-tesztelve: a régi (process.env-et
mutáló) kódra visszaállítva a 2. eset FAIL-re vált (`expected undefined to be 'production'`), a
többi 4 zöld marad. `tsc --noEmit` tiszta.

**Hivatkozás:** kártya `c116696f` (Cybersec NO-GO, komment 21701); `src/web/routes/updates.ts`,
`src/__tests__/update-node-env-strip.test.ts`, `src/fork-upstream/acknowledged-conflicts.ts`.

## 2026-09-06 -- 864351a9 -- gate-closure-check.py: kikövetkeztetett gate-halmaz sose hagyja ki a QA-t, és egy STATED kijelölés felülírja a találgatást

**Döntés.** `store/gate-closure-check.py` `check()`-je, amikor a hívó nem ad meg gate-listát: (1)
ELŐSZÖR megnézi, van-e a kártyán `MikroB GATE-KIJELOLES: <gate-ek> (<n>-gate) -- <indoklás>`
komment (élő, már használt flotta-konvenció, eddig soha nem olvasva) -- ha van, AZ a gate-halmaz,
nincs találgatás; (2) ha nincs stated kijelölés, a jelen lévő verdiktekből következtetett halmazt
MOSTANTÓL a kötelező QA-val EGÉSZÍTI KI, akkor is, ha QA egyáltalán nem verdiktelt -- egy QA
nélküli következtetett halmaz így `MISSING|QA has no verdict`-et ad, sosem `AGREE`-t.

**Miért.** A 4. munkavégzési szabály szerint QA MINDIG kötelező, alkudhatatlanul. A régi
`sorted(latest.keys())` következtetés viszont pusztán a JELEN LÉVŐ verdiktekből épített halmazt,
tehát egy MAGÁNYOS biztonsági gate-verdikt (pl. csak CYBERED GO) a saját magával való egyetértésként
olvasódott: `AGREE`. Élesben mérve: 307 `done` kártyából KETTŐN pontosan ez történt (`e96b06e7`,
`89f4c28d`), és mindkettőn a VALÓS kijelölés (`MikroB GATE-KIJELOLES: QA (1-gate)`, illetve `QA +
Cybersec (2-gate)`) szövegesen ott állt a kártyán -- az eszköz egy MÁSIK, ellentmondó halmazt
következtetett a kimondott érték helyett, ugyanaz az alak, mint a 4b. szabály (kimondott Gate-SHA
helyett találgatás). Mindkét kártyát MikroB már kézzel retro-gate-elte (QA PASS pótolva a landolt
shára); ez a javítás azt zárja le, hogy a HIBAOSZTÁLY megismétlődjön.

**A két javítás egymástól független, mindkettő kell:** a stated-kijelölés felülírása egy STATED de
KISEBB halmazt is tiszteletben tart (ha MikroB kifejezetten csak QA-t kért, egy azon felül
verdiktelő biztonsági gate nem számít bele -- lásd a szintetikus kontroll-esetet); a QA-seedelés
pedig arra az esetre való, amikor NINCS stated kijelölés egyáltalán.

**Tesztek.** `gate-closure-check.selftest.py`: 103/103 zöld (97 régi + 6 új, a három ÉLES eset
szintetikus reprodukciója -- `d5c05548`, `e96b06e7`, `89f4c28d` -- plusz egy kontroll ami AGREE
marad (QA+biztonsági gate ugyanarra a shára), egy ami a KISEBB stated halmazt tiszteletben tartja,
és egy ami az UTOLSÓ GATE-KIJELOLES-t követi újra-kijelöléskor). Mutáció-tesztelve KÉT külön
mutánssal (a QA-seedelés kikapcsolva, illetve a stated-kijelölés-olvasás kikapcsolva) -- mindkettő
pontosan a hozzá tartozó eseteket buktatja meg, a másik fixet nem érinti.

**Hivatkozás:** kártya `864351a9` (Cybersec mérése, a `d5c05548` zárás-ellenőrzése közben, üzenet
24538); kapcsolódó de más mechanizmus: `98ae22fe`, `f53ef8e4`, `3e4dc2c3`, `2adaa646`, `cb8ef4f5`;
`store/gate-closure-check.py`, `store/gate-closure-check.selftest.py`.

## 2026-09-06 -- fleet-test.sh megosztja a CleanCore CPU-poolt a marveen-land landolással (kártya 492a6d5c)

**A lelet (backend3 mérése, 24522, kártya 779cd6a7 kapcsán).** `store/cleancore-suite-run.sh` (17.
munkavégzési szabály) a CleanCore teljes-suite futásokat max 2 egyidejűre poolozza flock-kal --
DE a `marveen-land.sh` saját `store/fleet-test.sh` futása (a marveen 622 fájlos, 15102 tesztes
suite-ja) NEM volt ugyanabban a poolban, hanem külön, korlátlan sávon futott. Egy ügynök, aki
EGYSZERRE landol marveenen (fleet-test fut) ÉS CleanCore suite-ot futtat a saját, szabályosan
2/2-be foglalt slotjában, önmagát CPU-éheztette: loadavg 10-24 között,
`cross-tenant-canary-callers.test.ts` 6034ms/5000ms timeout-tal bukott NULLA assert-hibával
(rule-17 hamis-piros mintája), holott azonos terheléssel, tisztán futtatva (loadavg 10.6) mindkét
ág 9/9 zöld volt.

**A javítás.** `store/fleet-test.sh` a saját machine-wide tree-mutexe (LOCK_FILE, cards 85faec1b/
2f0c7d24 -- korrektségi kérdés: "biztonságos-e hozzányúlni a fához") MELLETT most egy MÁSODIK,
FÜGGETLEN zárolást is kér a build+vitest futtatása ELŐTT: ugyanazokat a számozott lock-fájlokat,
amiket a `cleancore-suite-run.sh` már használ (`CLEANCORE_SUITE_SLOTS`/`CLEANCORE_SUITE_LOCK_PREFIX`/
`MARVEEN_MAIN` -- SZÁNDÉKOSAN ugyanazok a nevek, nem hasonló-alakú újak, mert csak úgy garantált,
hogy a két szkript TÉNYLEGESEN ugyanazon a fájlon versenyez, nem csak ma véletlenül egyező
alapértéken). Ez a kapacitás-kérdés ("van-e hely futni"), külön a korrektség-kérdéstől ("biztonságos-e
a fához nyúlni") -- ezért a két lock NEM lett összevonva, és a CPU-slot megszerzése a tree-mutex
ELŐTT történik, hogy egy futás sose tartsa feleslegesen a tree-lockot, miközben még CPU-kapacitásra
vár. Új introspekciós kapcsoló: `--cpu-slot-path` (a `--lock-path` mintájára, kártya 43ecdbe6 elve:
a FELOLDOTT érték, nem a forrásszöveg).

**Tesztek.** Új `src/__tests__/fleet-test-shares-cleancore-cpu-pool.test.ts`, 9 eset: forrás-alapú
(`acquire_cpu_slot` a tree-mutex ELŐTT fut, a pontos `CLEANCORE_SUITE_*` neveket olvassa, a várakozás
korlátos és fatal timeout-on) + 3 mutáció-kontroll (a blokk törölve, a blokk a tree-lock UTÁNRA
mozgatva, a névtér eltérítve) + élő viselkedés-tesztek VALÓDI flock-kal tartott slot-fájlokkal (mindkét
slot foglalt -> sorban áll, majd feladja a megnevezett okkal; szabad pool -> néma és eljut a
tree-lock szakaszig; `CLEANCORE_SUITE_SLOTS=3` -> beenged 2 foglalt mellett is). A meglévő
`fleet-test-serialises-runs.test.ts` és `cleancore-suite-run.selftest.sh` (12/12) VÁLTOZATLANUL zöld
-- ez utóbbi fájlhoz egyáltalán nem nyúltam, csak ugyanazokat a lock-fájl-neveket olvasom be egy
másik szkriptből.

**Hivatkozás:** kártya `492a6d5c` (backend3 mérése, üzenet 24522, kártya `779cd6a7`); kapcsolódó de
más mechanizmus: `2f0c7d24` (a tree-mutex machine-wide-dá tétele), `5af57bd7`/`6e39a5f0` (a
CleanCore-oldali szemafor bevezetése), `4ee2519b` (dedup-ellenőrizve, más eszköz: `fe-be-reconcile.py`
CI-bekötés); `store/fleet-test.sh`, `store/cleancore-suite-run.sh` (érintetlen),
`src/__tests__/fleet-test-shares-cleancore-cpu-pool.test.ts`.

## 2026-09-06 -- vram-guard-check.sh: atomi állapot-írás + persist-hiba a pillanatnyi szintből (kártya eaef963d)

**A lelet (Cybersec, follow-on a 108c7b10 gate-eléséből, komment 21567, Gate-SHA 84d0b7d9).** Két
defektus az ÁLLAPOTKEZELÉSBEN, mindkettő ADMIT irányba old fel -- az őr a saját céljával ellentétes
irányba hibázik.

1) Az állapotfájl írása (`open(state_path, "w")`) CSONKÍT, nincs atomi csere: egy egyidejűleg futó
példány részlegesen kiírt fájlt olvashat, JSONDecodeError-t kap, `{"tier":"ok"}`-ra esik, és
VISSZAÍRJA az "ok"-ot -- a megerősített HOLD-ot mindenki számára elrontva. Mérve: 40 egyidejű hívás
egy megerősített tier=hard állapotból, 12 körben 10-szer veszett el a HOLD. Egy sima flock a
CSONKÍTÓ írás körül NEM javította (0/12) -- ez a 09a3d52a-minta rossz fele, ott valódi
kereszt-folyamatos lock-probléma volt, itt csonkított-írás. Az ATOMI csere (mkstemp + os.replace,
lock NÉLKÜL) 0/12-re javította.

2) Ha az állapotfájl NEM írható, a kód a régi (perzisztencia-mentes) `current` értéket adta vissza,
ami perzisztencia nélkül SOSEM tud a hiszterézisen keresztül elmozdulni "ok"-ról -- tehát az őr
csendben TARTÓS ADMIT-tá vált, a "hysteresis degraded" stderr-sor viszont csak "pillanatnyi
leolvasásra" való degradálást ígért. Mérve: öt hívás 140 szimulált másodpercen át, végig 96%-on,
SOHA nem tartott.

**A javítás.** (1) `tempfile.mkstemp` + `os.replace` UGYANABBAN a könyvtárban, mint az állapotfájl
(hogy a replace egy fájlrendszeren maradjon) -- egy olvasó vagy a régi teljes fájlt látja, vagy az
újat, sosem részlegeset. (2) a persist-hiba ágon a verdikt MOSTANTÓL a `instantaneous` (a
JELENLEGI mérésből számolt szint) alapján megy, nem a hiszterézis-only `current`-ből -- így egy
írási hiba a HISZTERÉZIST (memória a hívások között) fokozza le, nem az IRÁNYT.

**Tesztek.** `vram-guard-check.selftest.sh`: 31/31 zöld (28 régi + 2 új eset -- a persist-hiba 96%-on
HOLD-ot ad, 16%-on kontrollként ADMIT marad -- plusz egy TÖBBKÖRÖS (6x40 egyidejű) atomi-írás
teszt). Mutáció-tesztelve: a teljes eredeti (csonkító írás + current-alapú persist-ág) visszaállítva
2/6 körben ténylegesen elvesztette a "hard" állapotot ÉS a persist-teszt is bukott; egy RÉSZLEGES
mutáns (csak a (2) fix visszaállítva, (1) érintetlenül) KIZÁRÓLAG a persist-tesztet buktatta meg --
a két teszt független, egyik sem takarja el a másik hiányát. A többkörös teszt szándékos: a
csonkítás-hiba VALÓSZÍNŰSÉGI (mért 10/12), egyetlen kör akár véletlenül zölden futna át a javítás
nélküli kódon is (mérve: egy 30-egyidejű körben ez meg is történt) -- az atomi javítás viszont NEM
valószínűségi (0/12, determinisztikusan), ezért minden kör "hard"-ot KÖVETEL, egyetlen rossz kör is
valódi regresszió.

**Hivatkozás:** kártya `eaef963d` (Cybersec mérése, follow-on `108c7b10`-ből); kapcsolódó de más
mechanizmus: `09a3d52a` (ugyanennek a könyvtárnak a másik állapotfájlja, ott a zár volt a helyes
válasz); `store/vram-guard-check.sh`, `store/vram-guard-check.selftest.sh`.

## 2026-09-06 -- edf9c837 -- A landolo szkript a KARTYA-ID szerint valaszt agat, nem a gate-elt sha szerint

**A DÖNTÉS.** A `cleancore-land.sh` `pick_branch` függvénye megkapja a kártya azonosítóját, és a
`git branch -a --contains` jelöltjei közül azt választja, aminek a NEVE a kártya-id-re végződik
(`/` vagy `-` határon). Ha egyik sem, marad a régi első-sor viselkedés.

**MIÉRT NEM A TIP SZERINT.** A kézenfekvő megoldás az lenne, hogy azt az ágat válasszuk, aminek a
tipje ÉPPEN a gate-elt sha. Ez rossz: a hívó KÖVETKEZŐ állítása pontosan az, hogy a választott ág
tipje a gate-elt sha. Ha a választás erre a tulajdonságra szűrne, az az állítás üressé válna --
konstrukció szerint teljesülne, bármit adott volna vissza a függvény. A név szerinti szűkítés
független attól, amit az ellenőrzés kérdez, tehát az ellenőrzésnek marad mit elutasítania.

**MIÉRT HATÁRRA HORGONYZOTT AZ ILLESZTÉS.** Egy 8 hexes kártya-id rövid: a `fix/x-476ccb3399` név
tartalmazza a `476ccb33`-at. Egy puszta részsztring-illesztés ugyanazt a rossz-ág hibát hozná vissza,
csak eggyel bonyolultabban. Mindkét élő névalak lefedve (`agent/fron-ted/476ccb33` és
`fix/evidence-bucket-retention-floor-cbea986c`). Mutációval mérve: a horgony elvétele két esetet
buktat, a kártya-argumentum eldobása hármat.

**MIÉRT NEM ELUTASÍTÁS, HA NINCS NÉV-EGYEZÉS.** Az az ág, ami egyszerűen nem hordozza az azonosítót a
nevében, a MA is működő eset. Egy elutasítás ott olyan landolásokat törne el, amik most rendben
mennek -- a változtatás így szigorúan additív.

**AMI EBBŐL KIMARADT, ÉS MIÉRT.** A kártya elsődleges fele (a `DECISIONS.md` union-elutasítás) NEM
ebben a változtatásban van: a mérés megcáfolta a kártya hipotézisét, és a valódi ok egy olyan
alakra vezet, amit a jelenlegi algoritmus nem tud feloldani, nem pedig egy szűk feltétel
lazítására. Részletek a kártya kommentjében; az ottani javaslat MikroB terv-fázisú döntését igényli,
mert egy többszörösen gate-elt biztonsági eszköz kimenetét változtatná meg.

**Ki döntött:** backend mérnöki döntés a kártya másodlagos pontjára (MikroB kártyája nevezte meg a
kívánt irányt), itt felülvizsgálatra kitéve.

**Hivatkozás:** kártya `edf9c837`; `store/cleancore-land.sh` (`pick_branch` + 6 selftest-eset).
## 2026-09-06 -- channels.sh watchdog fallback: host-szintű grep helyett saját folyamatfa (kártya 4c34f201)

**A lelet.** Az upstream mérte meg és javította (kanban `c0390130`, 2026-08-19), a fork a hibás
alakot hordozta. `scripts/channels.sh` 1079. sora a plugin életjelét fallbackként egy HOST-SZINTŰ
kereséssel állapította meg: `ps eww -e | grep -qE "CLAUDE_PLUGIN_ROOT=[^ ]*/${CHANNEL_PROVIDER}(/|
@| |$)"`. Ez a minta BÁRMELYIK ügynök plugin-folyamatára illeszkedik a gépen, nem csak a sajátjára --
egy több-ügynökös hoszton az életjel gyakorlatilag mindig igaz, és a watchdog némán elveszti azt a
képességét, amiért létezik. Upstream mérése: 14 telegram plugin-folyamat futott más ügynökök alatt,
az egyik ügynök csatornája 07:40-től 08:30-ig halott volt, senki nem kapott róla jelzést. A mi
kitettségünk MÉRVE (nem elméleti): 2 illeszkedő folyamat futott ezen a hoszton a mérés pillanatában.

**A javítás.** Az upstream javítását (blob `d0ca55bd`) NEM blob-mergeként vettük át, hanem a fork
saját magának alkalmazza UGYANAZT a technikát: `pgrep -P <a session sajat pane_pid-je> bun`, ami a
saját folyamatfára szűkít -- pontosan az a minta, amit a fork post-init unlock Check 1-je MÁR
használ (825. sor: `pgrep -P "$CLAUDE_PID" bun`). A szűkítés biztonságosságát ELŐRE MÉRTÜK (a card
kifejezett kérése szerint): `ps --forest` a live `mikrob-channels` session pane_pid-je alatt
megmutatta, hogy a bun folyamat MINDIG közvetlen gyerek ezen a hoszton, tehát a szűkítés nem indíthat
hamis restart-hurkot.

**Tesztek.** Új `src/__tests__/channels-watchdog-fallback-scope.test.ts`, 5 eset -- a JAVÍTOTT
sávot a channels.sh-ból SZÓ SZERINT kiemelve futtatja (a `channels-reap-scope.test.ts` mintája,
awk helyett bash-blokkra), VALÓDI folyamatfákkal: egy `bun` nevű valódi fájl (nem `exec -a` trükk --
az argv[0]-átírás NEM állítja át a kernel comm-nevét szkript-futtatásnál, ez egy sikertelen próba
volt a teszt megírása közben) mint valódi gyerekfolyamat, és egy hamis `tmux` bináris, ami a
választott pane_pid-et adja vissza. A "MÁSIK ügynök plugin-folyamata" eset (a card kifejezett
teszt-követelménye) egy VALÓDI, a saját pane_pid-től FÜGGETLEN bun-gyereket hoz létre, és igazolja,
hogy az új kód NEM veszi életjelnek -- míg a régi (host-szintű env-grep) mechanizmus külön, bash-ből
igazoltan MATCHEL egy ilyen idegen folyamatra (`CLAUDE_PLUGIN_ROOT` env-vel ellátott folyamat,
függetlenül a tulajdonostól).

`src/fork-upstream/acknowledged-conflicts.ts`: a round-19 bejegyzés ("NOT adopted here... deserves
a gate of its own") mellé egy záró jegyzet kerül, ami rögzíti, hogy a KITETTSÉG (nem a blob-diff)
lezárult -- a blob-pin változatlan (`d0ca55bd`), mert nem blob-mergeltünk, hanem saját, ekvivalens
javítást építettünk.

**Hivatkozás:** kártya `4c34f201`; upstream: kanban `c0390130` (2026-08-19), blob `d0ca55bd`;
kapcsolódó: a fork saját post-init unlock Check 1-je (ugyanaz a `pgrep -P` minta, 825. sor);
`scripts/channels.sh`, `src/__tests__/channels-watchdog-fallback-scope.test.ts`,
`src/fork-upstream/acknowledged-conflicts.ts`.

## 2026-09-06 -- edf9c837 -- A döntésnapló-unió SORRENDJE a hívó döntése, és a szinkron iránynak eddig nem volt hívója

**A DÖNTÉS (MikroB, 24922: az (A) irány).** A `try_append_union` kap egy negyedik argumentumot, ami
megmondja, melyik oldal fele kerül előre: `ours-first` (alapértelmezés) vagy `theirs-first`.
Ismeretlen érték elutasítás, nem csendes alapértelmezés -- ugyanaz a fail-closed irány, mint az
entry-boundary mintánál, és ugyanazon okból: a sorrend DÖNTÉS, tehát egy elgépelés nem választhat
helyettünk.

**MIÉRT SZÁMÍT EGYÁLTALÁN A SORREND.** A két maradék mindegyike új, tehát a sorrendjük ERRE a
merge-re nézve tetszőleges. A KÖVETKEZŐRE nem: amelyik blokk előre kerül, az MINDEN későbbi
merge-base-hez képest a fájl KÖZEPÉN álló beszúrás lesz, és egy egyoldali közép-beszúrás pontosan az
az alak, amit a függvény ezután elutasít (mert ott az összefűzés a base-t duplikálná). Mérve: két
független CleanCore landolás akadt el egyetlen heartbeat-körben emiatt, és a gyanított ok (azonos kis
közép-beszúrások) mérésre kizárult -- azok bájtra azonos üres sorok, amiket a függvény már kezel.

**AMI A MÉRÉS KÖZBEN KIDERÜLT, ÉS AMI MIATT (A) ÖNMAGÁBAN NEM-MŰVELET LETT VOLNA.** A függvényt
pontosan két hely hívja, mindkettő landoló, és mindkettő ugyanúgy mergel: a worktree az integrációs
ágon áll, az ügynök ága megy bele. Ott `ours` MÁR az integrációs ág, tehát a helyes sorrend az
alapértelmezés. Az inverzió az ÜGYNÖK szinkron-merge-ében keletkezik (integrációs ág bemergelése a
saját ágba), ahol `ours` az ügynök ága -- és ahhoz az irányhoz NEM TARTOZOTT SEMMILYEN HÍVÓ: azt a
konfliktust kézzel oldottuk fel, a sorrendet az döntötte el, ki hogyan fűzte össze a két felet.

Ezért a döntés két darabban landolt, és a második nélkül az első nem ér semmit:
`store/decisions-sync-resolve.sh` a hiányzó hívó a szinkron irányra, `theirs-first`-tel.

**A SZKRIPT ELLENŐRZI AZ IRÁNYT, NEM FELTÉTELEZI.** A `theirs-first` csak szinkron-merge-re helyes;
az ellenkező merge után alkalmazva pont azt az alakot hozná létre, amiről ez a kártya szól. Ezért a
`MERGE_HEAD`-nek egy integrációs ág csúcsának KELL lennie, különben a szkript 2-vel elutasít. Egy
eszköz, aminek a helyessége azon múlik, hogy az operátor emlékszik-e, melyik irányba mergelt, nem
javítás.

**NEM COMMITOL.** Ugyanaz a szerződés, mint a landolóknál: felold és stage-el, a merge lezárása a
hívó lépése.

**BIZONYÍTÉK.** Öt új eset a union selftestjében, köztük az, amelyik EGY fixtúrán két különböző
verdiktet ad pusztán a sorrendtől (`ours-first`-nél a varrat setext-fejléccé léptetné elő az utolsó
prózasorunkat, `theirs-first`-nél nem) -- ez az az eset, ami megfogja, ha a varrat-ellenőrzés a régi
felére mutat. A kártya által kért piros-a-régin/zöld-az-újon alak mérve: a sorrend-argumentumot
figyelmen kívül hagyó (a kártya előtti) változat három esetet buktat, a varratot nem követő változat
egyet. A szinkron-szkriptnek saját, valódi repókon futó selftestje van (7 eset), és teszt köti be,
hogy le is fusson.

**Ki döntött:** MikroB választotta az (A) irányt (24922); a szinkron-oldali hívó, az irány-ellenőrzés
és a fail-closed ismeretlen-érték kezelés backend mérnöki döntése, itt felülvizsgálatra kitéve.

**Hivatkozás:** kártya `edf9c837`; `store/decisions-append-union.sh`, `store/decisions-sync-resolve.sh`,
`src/__tests__/decisions-sync-resolve-selftest.test.ts`, `README.md`.

## 2026-09-06 -- beb9c8d3 -- A suite-futás kimondja, mennyi NEM futott le belőle

**A LELET.** A `store/cleancore-suite-run.sh` nem állítja be a `PG_E2E_URL`-t, és a flottában semmi
más sem teszi, miközben a CI igen (`.github/workflows/ci.yml:442`). Minden PG-függő e2e fájl
`describe.skipIf(!PG_E2E_URL)`, tehát egy flotta-suite végigsétál rajtuk. Mérve ezen a gépen,
2026-09-06, csak az `api-e2e` projektre: **65 tesztfájlból 58 nem futott le, 491 tesztből 460
kimaradt, a futás pedig 0-val tért vissza.**

**AMI NEM IGAZ A LELETRE, és ezt ki kell mondani:** a vitest KIÍRJA ezeket a számokat, tehát a
kihagyás nem szó szerint láthatatlan. A hiba nem a hallgatás, hanem az ATTRIBÚCIÓ hiánya: a 460 egy
sorban áll azzal a néhány fájllal, ami Stripe- vagy Redis-kulcs híján marad ki, és amit egy olvasó
jogosan tekint normálisnak. Egy gate zöldet lát és egy megszokott skipped-számot.

**A DÖNTÉS.** Új `store/vitest-skip-report.sh`, a `vitest-flake-classify.sh` mintájára és
ugyanazzal a szerződéssel: csak stderr, a kilépési kódot SOHA nem írja át, és HALLGAT, ha semmi nem
maradt ki. A futás végén egy blokk mondja meg, hány fájl és hány teszt nem futott, és ebből mennyi
hivatkozik a beállítatlan környezetváltozóra.

**AMIT ÁLLÍT, szűkebben mint "ezek MIATTA maradtak ki".** Fájlonként azt kérdezi, hogy a forrás
HIVATKOZIK-e a változóra, és hogy a változó be van-e állítva itt. Mindkét fél ellenőrizhető. Amit
nem tud besorolni, az külön, kimondott vödörbe megy -- egy attribúció, ami csendben magába nyeli
azt, amit nem ért, megszűnik bizonyíték lenni. Mérve a valódi futáson: 58 kihagyott fájlból 54
hivatkozik a `PG_E2E_URL`-re, a maradék 4 pedig névről is a másik osztály (LemonSqueezy, Stripe,
Redis, objektumtár).

**MIÉRT NEM KOMMENTEL A KÁRTYÁRA.** A szemafor `PAUSED-SEMAPHORE` üzenetei kommentelnek, mert
ritkán szólalnak meg. Ez minden helyi futáson megszólal, amíg valaki be nem köt egy Postgrest --
kártyánkénti komment ebből zaj lenne, pont az, ami ellen a szkript saját elve szól.

**MIÉRT NEM BUKTATJA MEG A FUTÁST.** Egy kihagyás-hiba minden jogos helyi futást eltörne, egy
kilépési kód átírása pedig ugyanaz a mozdulat, amit egy valódi regressziót elrejtő wrapper tenne.

**BIZONYÍTÉK.** 14 esetes selftest, minden attribúciós esethez saját negatívval: csak kommentben
szereplő hivatkozás NEM számít bele (a jelenlét-állítás komment-mentesített forráson mér), a
`PG_E2E_URL_ALT` sem (azonosító-határ, nem részsztring), és egy `://` literál a sor elején nem
nyeli el a mögötte álló hivatkozást. A bekötés is pinnelve van, komment-mentesített forráson a
HÍVÁS-KIFEJEZÉSRE illesztve: mérve, hogy a hívás törlése és egy azt megnevező kommenttel való
pótlása is PIROSRA váltja.

**Hivatkozás:** kártya `beb9c8d3` (backend leletéből, `cea77ed2` kapcsán);
`store/vitest-skip-report.sh`, `store/vitest-skip-report.selftest.sh`,
`store/cleancore-suite-run.sh`, `README.md`.

## 2026-09-06 -- Két testvér-őr ELLENTÉTESEN döntött ugyanarról a varrat-kérdésről, egy héten belül

**A MEGFIGYELÉS Cybersecé** (`108c7b10` GO, komment 21567), és kifejezetten NEM leletként adta át:
a `vram-guard-check.sh` `--metrics-json` varrata őrizetlen, és teljesen meghatározza a verdiktet.
Ugyanezt a kérdést a `09a3d52a`-n tudatosan FORDÍTVA döntöttem el: ott elutasítottam egy
env-varratot, mert egy TILTÓ eszközben a varrat maga lenne a megkerülés.

**A KÜLÖNBSÉG, amit a két döntés között tartok, kimondva.** A `09a3d52a` főkönyve azt dönti el,
hogy egy re-dispatch megtörténhet-e -- ott a varrat közvetlenül a tiltás kikapcsolója. A
VRAM-őr egy KÉSLELTETÉST ad vagy nem ad, és a `load-guard-eval.sh` már precedenst teremtett a
teszt-varratra ugyanebben a családban. A tét nagyságrenddel kisebb, ezért nem szigorítottam.

**AMIT EZ NEM MOND.** Nem állítom, hogy a különbség elvi. Két, egy héten belül szállított,
egymás mellett élő őr két ellentétes választ ad ugyanarra a kérdésre, és ha valaki később
egységesíteni akarja őket, ez a bejegyzés az a hely, ahonnan indul -- nem a git log, amiben a két
döntés két különböző kártyán, két különböző indoklással áll. Ha a VRAM-őr tétje nő (pl. ha a
verdiktje valaha blokkolni fog, nem csak késleltetni), a varratot újra kell dönteni.

**Ki döntött:** a megfigyelés Cybersecé; a rögzítés MikroB kérése (24964); a fenti megkülönböztetés
backend mérnöki döntése, itt felülvizsgálatra kitéve.

**Hivatkozás:** kártyák `108c7b10`, `09a3d52a`; `store/vram-guard-check.sh`,
`store/redispatch-guard.sh`, `store/load-guard-eval.sh`.

## 2026-09-06 -- Egy JELEN IDŐBEN állított védelem, ami jövő idejű (kártya 0c4cf655 utólagos javítása)

**A LELET Cybersecé** (`0c4cf655` GO, komment 21577). A `resolvesToSharedProjectsRoot` fejléce azt
állította, hogy a fail-safe iránya által kockáztatott duplikátumot „NOW caught by the dedup key
(card b774f057)" -- és ugyanez állt a tesztben is.

**MEGMÉRVE az éles adatbázison, nem a jelentésből átvéve:**
`idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens)`.
Az `agent` az ELSŐ mező, tehát két néven elkönyvelt azonos esemény ma KÉT sor. A `b774f057`
(az `agent` kivétele a kulcsból) `planned` és blokkolt. A hivatkozott védelem tehát nem létezik.

**A JAVÍTÁS doksi-only, és szándékosan az:** a fail-safe IRÁNYA helyes marad (egy ügynök
használatát elejteni rosszabb, mint duplán számolni), csak nem védelemnek nevezem, hanem
kompromisszumnak. Három helyből egy volt pontos (`docs/token-usage.md` helyesen jövő időben írta),
kettő nem -- mindkettő átírva.

**A TANULSÁG, amiért ez külön bejegyzést kap:** ugyanaz a hibaosztály, amit rendszeresen megfogok
mások munkájában (egy őr fejléce olyan védelmet nevez meg, ami még nincs sehol), a sajátomban
csúszott át. Egy másik kártyára hivatkozó védelem-állítás JÖVŐ IDŐBEN íródjon, amíg az a kártya nem
`done` -- a jelen idő ott nem stílus, hanem hamis állítás.

**Ki döntött:** MikroB (24968, a HOLD alóli doksi-only kivétel).

**Hivatkozás:** kártyák `0c4cf655`, `b774f057`, `0333ab9f`; `src/web/token-usage.ts`,
`src/__tests__/token-usage-shared-root-skip.test.ts`, `docs/token-usage.md`.

## 2026-09-06 -- delta-review diff korlátlanná tétele + landolás elutasítja az aktív NO-GO-s idegen kártyát (kártya c266ec74)

**A lelet (Cybered, komment 24334, efaf8926/a37bb36d incidens).** A `a37bb36d` landolási merge NÉGY
commitot vitt fel efaf8926-hoz kötve kettő helyett: a másik kettő (16fcee57, 6193ef7c) MÁS kártyához
(82fa48b0/2b20b476) tartozott, ugyanazon az `agent/backend2/work` ágon utaztak. Az egyik pont az a sha
volt, amire Cybered korábban NO-GO-t adott (82fa48b0-on), és 33 percig ez állt fenn a developen egy
javított verzió (ec637f92) előtt. QA2 delta-diffje ezt nem kapta el, mert `-- src/`-re volt szűkítve,
a potyautas fájlok pedig a `store/` alatt voltak.

**A javítás, két rész.**
1. `store/delta-review-diff.sh` -- új, kanonikus, SZÁNDÉKOSAN útvonal-korlátozás NÉLKÜLI
   `git diff --name-only` két sha között, delta-gate újra-ellenőrzéshez. Bekötve a
   `gate-worktree-pattern` skillbe, hogy a gate-ek ezt használják egy kézzel írt, útvonalra
   tippelt diff helyett.
2. `store/landing-downward-check.sh`: új `foreign_card_gate_check()` -- minden landoló ágon talált
   IDEGEN kártyára megkérdezi a `gate-closure-check.py`-t, hogy annak jelenleg van-e AKTÍV, még nem
   javított FAILING gate-verdiktje; ha igen, ELUTASÍT, FELTÉTEL NÉLKÜL (`--card`/enforce-től
   függetlenül), hacsak a `--allow-stacked` nem nevezi meg. Ez additív a már létező (dfff9b37)
   downward-checkhez képest, ami eddig csak NÉVEN NEVEZTE az idegen kártyákat, a gate-állapotukat
   nem nézte -- pontosan ez volt a rés, amin 82fa48b0 élő NO-GO-s commitja átcsúszott.

**Tesztek.** 5 új selftest eset a megosztott downward-check blokkban (mindkét lándoló `--selftest`
futtatja), mutációval ellenőrizve: az új refuse-hívás visszavonása pontosan a 3 új REPORT-mode esetet
buktatja meg, semmi mást. `store/delta-review-diff.selftest.sh`, 5 eset, szintén mutációval
ellenőrizve. `src/__tests__/landing-downward-check.test.ts` (a meglévő ratchet-teszt) zöld,
floor-ok változatlanok. Teljes fleet-test.sh a merge eredményén: első futás 4 helyi-llm/GPU-lock
hibával bukott (terhelés-függő flake, lásd kártya `f3b219bb`), második futás változtatás nélkül
644/644 fájl zöld.

**Amit ez NEM zár le:** a "several of the SAME agent's own already-reviewed cards ride along"
alapeset (marveen gate-AFTER-landing modellje) szándékosan megmarad engedékenynek -- csak az
AKTÍV, FAILING verdiktű eset lett feltétel nélkül szigorítva.

**Hivatkozás:** kártya `c266ec74`; `store/delta-review-diff.sh`, `store/landing-downward-check.sh`,
`seed-skills/gate-worktree-pattern/SKILL.md`, `src/__tests__/landing-downward-check.test.ts`.

## 2026-09-06 -- decisions-append-union: az EOF-fallback prefix-valasz elveszitette a sajat utolso sorat (kartya c266ec74)

**A lelet, elesben.** A c266ec74 landolasakor a DECISIONS.md konfliktusba kerult (a git sajat diffje
osszezavarodott egy korabbi, MASIK kartyahoz (edf9c837) kotheto, nem-a-farokra tett bejegyzestol), es
a konfliktus harom index-szintjenek adatai kozul `ours` PONTOSAN byte-prefixe volt `theirs`-nek
(`theirs` = `ours` + egy tiszta farok-fuzes) -- a legegyszerubb eset, amire a `try_append_union`
epult. Megis elutasitotta.

**A gyoker `_common_line_prefix_len`-ben.** Amikor a `cmp` nem talal elteru byte-ot (mert az egyik
oldal a masik prefixe), a fuggveny helyesen valaszol a rovidebb oldal teljes hosszaval -- de ez a
valasz utana belefutott a "vissza a legutolso teljes sorra" lepesbe, amit a MASIK ag szamara epitettek
(amikor a `cmp` egy valodi, sor-kozepi elterest talal). A `$(git show ...)` csak a FAJL sajat zaro
ujsorat vagja le, sosem egy belsot -- tehat a rovidebb oldal utolso sora sosem vegzodik `\n`-nel a
bash-valtozoban, es a `${head%$'\n'*}` ezt a TELJES utolso sort ledobta egy olyan sor-kozepi vagas
utan kutatva, ami sosem volt ott. Mindket oldal maradek resze (`ours_added`/`theirs_added`) orokolte
ezt a fuggo sort, az nem indit uj bejegyzest, es az unio elutasitott egy landolast, amiben semmi
hiba nem volt.

**A javitas.** Az EOF-fallback valasz kozvetlenul visszaadva, kihagyva a felesleges vissza-lepest
(annak az agnak ket oldala mar teljes `git show`-blob, tehat az a hatar mar valos sorhatar a mogotte
allo fajlokban).

**Amit ez ONMAGABAN NEM oldott meg, es a kartya sajat masodik targya.** A landolando ag es az
origin/develop kozotti MASIK iranyu konfliktus (amikor a ket oldal FUGGETLENUL kulonbozo tartalmat
fuzott a farokhoz, es a korabbi, rossz helyre szurt edf9c837-bejegyzes miatt a kozos prefix a base-nel
rovidebbre adodott) a meglevo "shared_new csak ures/elvalaszto sor lehet" ellenorzesen buktatta el az
automata uniot -- ez helyesen viselkedik, csak a landolando agam ELOZETES kezi szinkronizalasa
(origin/develop aktualis DECISIONS.md-jenek masolasa a sajat agamba a landolas elott) vitte ki a
tervezett hatokorebol. Ezt a konkret landolast vegul kezzel fejeztem be: a merge-t egy eldobhato
worktree-ben elkeszitve, a DECISIONS.md-t kezzel osszefuzve, a store/fleet-test.sh-t a merge
eredmenyen lefuttatva (646/646 fajl, 15501/15501 teszt zolden), majd pusholva.

**Tesztek.** 2 uj kozvetlen selftest-eset a `_common_line_prefix_len`-re (mindket iranyban, melyik
oldal a rovidebb), mutacioval ellenorizve: a javitas visszavonasa pontosan a live hibat reprodukalja
(got 44, want 61), es semmi mas nem regresszal (81 ok / 0 fail a mutacio elott es utan is, csak a 2
uj eset billen).

**Hivatkozas:** kartya `c266ec74`; `store/decisions-append-union.sh`, Gate-SHA `1a8e469e` (a
landolo merge, kezi befejezessel).
## 2026-09-06 -- A routing-kapu a FLOTTA SAJÁT CÍMKÉJÉRE illeszkedett, nem a munkára (kártya 28295e97)

**A KÁRTYA FELTÉTELEZÉSE MEGCÁFOLVA, méréssel.** A kártya (Peti kérése, MikroB fogalmazásában) azt
mondta, a gyökér ok a `route-classify.sh` bináris MECHANICAL/SECURITY döntése, és egy köztes
MODERATE sáv kell. A `card-build-route.log` teljes előzménye 8 sor, ebből 7 ONLINE, és **mind
`calls=0`**: a döntés soha nem jutott el a `route-classify.sh`-ig. Egy MODERATE sáv ott nulla mai
döntést oldott volna fel. Ezen felül a `route-classify.sh` szerkezetileg csak eszkalálni tud
("may only move a task LOCAL -> ONLINE"), tehát több munkát helyire küldeni nem is tudna.

**A TÉNYLEGES ELUTASÍTÓ.** A 2. lépcső `deterministic-multi-decision` kapuja, és ötből négyen az
`infra` token illeszkedett, kettőnél egyedüliként. De minden ilyen kártya címe `[marveen][INFRA]`
vagy `[CleanCore][INFRA]` alakú: a kapu a flotta saját címke-konvenciójára illeszkedett, nem a
munka több-döntésű jellegére. Ugyanaz a hibaosztály, amire a `route-classify.sh` fejléce
figyelmeztet ("the same noise that made the keyword matcher fire on the fleet's own dialect").

**A SAJÁT ELSŐ JAVASLATOM IS MEGBUKOTT, és ez döntötte el a formát.** Azt ajánlottam, essen ki az
`infra`. Mérve: 134 kártyán ez az egyetlen találat, és 98-at semmi más determinisztikus szabály nem
fog -- pontosan az az állapot, amit a `05f8d99c` kártya szélesítése megszüntetett ("nothing but the
7B stood between them and a weaker builder", 15-ből 5). Törlés helyett tehát **vágás + pótlás**.

**AMI LANDOLT.** (1) A `deterministic-multi-decision` illesztés a szöveg VEZETŐ címke-futamát
levágva fut, semmi mást nem érintve -- a másik négy determinisztikus osztály (pénz,
objektum-integritás, kliens-adat, dokumentum-összeállítás) változatlanul a teljes szöveget olvassa,
és a 3-4. lépcső (`route-classify` + a COMPLEX fokozat, mindkettő abstain->ONLINE) érintetlen.
(2) Négy szó hozzáadva, mindegyik EGY konkrét kártya valódi döntés-alakja: `nevter/namespace/
fenntartott` (5c5d7bc4, trust-boundary), `reteg` (2ebe24b2, új réteg = architektúra), `parhuzamos/
egyidej` (5af57bd7, gép-szintű kontenció), `utemez/scheduler` (13512bde, ütemezőbe kötés).

**MIÉRT KELLETT A PÓTLÁS, mérve.** A vágás ÖNMAGÁBAN négy valódi battery-A kártyát tolt át
"a determinisztikus kapu fogja" állapotból "csak a 7B fogja" állapotba; az alapvonal előtte NULLA
ilyen volt. A szkript saját összegzője ezt nagybetűvel kifogásolja, tehát a vágás önmagában
megbukott a szkript SAJÁT elfogadási mércéjén -- és a mérce lazítása, hogy a változtatás átmenjen,
pont a 7. kódminőségi elv tiltása. A négy szóval a selftest 32/0, nulla model-reliant.

**A SZÁMOK, mindkét irány.** 385 nem-urgent/high kártyán a kapu 318-on tüzelt, a végleges
szabállyal 217-en; 106 kártya szabadult, ebből 29-et másik determinisztikus szabály még fog, 77-et
nem (a csak-vágás variánsnál ez 125 / 94 volt). A 77 a maradék kockázat, kimondva: őket a 3-4.
lépcső fogja, nem a 2. A megítélt korpuszon (a selftest battery A-ja) a szám 0.

**A DISPATCH-BOILERPLATE VÁGÁSA KIMARADT, méréssel indokolva.** A plan-grilling kérte, de a router
bemenete a kártya `title`+`description` az API-ból, a sablon pedig a DISPATCH-ÜZENETBE kerül, nem a
kártyára: 512 kártyából **nullában** fordul elő bármelyik sablonmondat. Holt kódot nem szállítok.

**Ki döntött:** Peti (a cél, Telegram 7001); MikroB plan-grilling GO-WITH-CHANGES (komment 21850,
három feltétellel); az irány-korrekció, a pótlás és a boilerplate-fél elhagyása backend mérnöki
döntése, itt felülvizsgálatra kitéve.

**Hivatkozás:** kártya `28295e97`; `store/card-build-route.sh`,
`store/card-build-route-selftest.sh`.
