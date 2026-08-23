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
