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
## 2026-08-23 21:30 -- A self-pace kapu megnézi, mit futtatna egy shell (kártya ec20dd23)

**Döntés:** a `self-pace-gate.mjs` (1) parancs-pozíció-osztálya kiegészül a shell-kulcsszavakkal és a zárójel-csoporttal, (2) a `bash|sh|zsh|dash|ksh -c` és `eval` argumentumát, valamint stdin-ből programot olvasó fogyasztó (`| bash`, `xargs bash -c`) esetén az idézett literálokat kicsomagolja, és a TELJES meglévő ellenőrzést lefuttatja rajtuk (a `gateDecision` önmagát hívja rekurzívan, nem másolja a checkeket).
**Miért:** a `maskInertLiterals` kiüríti az idézett részeket a horgonyzott vizsgálat előtt -- ez teszi a prózát inertté, és mindenhol máshol ez a helyes. De egy `bash -c` argumentum NEM inert: az MAGA a program. Vagyis pont az az egyetlen szerkezet, aminél az idézőjel azt jelenti, hogy „ezt futtasd", volt az, amibe a kapu nem nézett bele.
**Irány:** ez a változás TÖBBET tilt, tehát a hibamódja nem lyuk, hanem akadállyá váló kapu. Ezért a jóhiszemű halmaz (olvasó forma, próza, grep, runbook-olvasás, commit-üzenet, wrapperen belüli próza) külön mérve és mutációval kikényszerítve -- a „mindig csomagold ki az idézett literálokat" mutáns 12 tesztet dönt.
**Mért kiterjedés:** a jelentett 8 megkerülés mellé a fix közben további 14 azonos osztályú alak került elő (sh/zsh/dash -c, bash -lc, `| bash`, `| sh`, `xargs sh -c`, elif/while/until, zárójel-csoport, beágyazott wrapper). Mind a 23 zárva.
**Testvér-kapu megmérve, NEM érintett:** az `email-send-gate.mjs` mind a négy próbát (csupasz, `bash -c`, `eval`, `then`-ág) helyesen tiltja, tehát nem kell rá külön kártya.
**Ki döntött:** Backend (implementáció), Cybersec élő lelete alapján (442f3289 gate).
**Hivatkozás:** kártya ec20dd23.
