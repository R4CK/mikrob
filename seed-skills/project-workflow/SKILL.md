---
name: project-workflow
description: The mandatory team workflow for any non-trivial project — Phase/Task/Subtask decomposition, Kanban ownership + progress %, 10-minute stuck detection, and author-cannot-verify sign-off. Use whenever the user assigns a multi-step project or feature to the fleet. Encodes the standing rules and the full agent team roster.
---
# Project Workflow (csapat-szabályok)

## Mikor használd
Bármilyen nem-triviális feladatnál/projektnél, amit a felhasználó ad. Ezek KÖTELEZŐ szabályok, nem opcionálisak.

## A 4 szabály
1. **Felbontás Fázis -> Feladat -> alfeladat -> al-alfeladat (4+ szint).** Minden munkát LEGALÁBB négy szinten bontasz le, és az alfeladatokat tovább bontod konkrét lépésekre, ahányszor szükséges. A Kanbanon ez rekurzív parent/child kártyákkal valósul meg (`parent_id`): Fázis = top, Feladat = gyerek, alfeladat = unoka, al-alfeladat/lépés = dédunoka (mélyebben is, ha a feladat indokolja). Nagy/kockázatos alfeladatnál (pl. hash-lánc, offline-sync, provisioning, auth) a 4. szint kötelező.
1b. **Terv-fázisú grilling KÖTELEZŐ kockázatos/nehezen-visszafordítható Fázis/Feladat-kártyánál, MIELŐTT `in_progress`-be kerül vagy dispatch elmegy (kártya 1161c9ed, a gstack-értékelés (C) mintája, kártya 6249d0a6).** A `plan-grilling` skill (közösségi átvétel, mattpocock/skills, MIT) MÁR LÉTEZIK, de eddig senki nem hívta -- 0 hivatkozás volt ebben a skillben és a CLAUDE.md-ben, tehát a képesség megvolt, csak nem volt bedrótozva a kötelező folyamatba. A helyes lépés a MEGLÉVŐ bekötése, nem új review-lánc építése (gstacknek 4 külön szekvenciális review-parancsa van erre; nekünk egy skill elég, ami mind a 8 tengelyt egy menetben lefedi). Mielőtt egy 1. szabály szerint felbontott Fázis- vagy Feladat-kártyát `in_progress`-be teszel: fuss le a `plan-grilling` skillel a terven, PONTOSAN azoknál a kártyáknál, ahol a skill saját kritériuma szerint indokolt (kockázatos, nehezen visszafordítható, architektúra/design döntés, vagy "sounds fine, de nincs stressz-tesztelve") -- a skill saját Pitfalls-szakasza szerint TRIVIÁLIS/jól ismert/könnyen visszafordítható munkánál kihagyandó, a grillingnek ára van. A verdiktet (GO / GO-WITH-CHANGES / RETHINK + a load-bearing feltételezés + a legvalószínűbb bukási pont) röviden írd a kártya leírásába vagy egy kommentbe, MIELŐTT a munka elindul.
2. **Felelős + százalék + színes ügynök-label a kártyán, láthatóan.**
   - Felelős: a kártya `assignee` mezője (látszik a UI-ban).
   - Százalék: a kártya CÍMÉBE tett `[NN%]` marker (pl. `Login form [40%]`), mert nincs natív progress mező. Frissítsd PUT-tal ahogy halad.
   - **Színes label:** minden kártyára tedd rá a felelős ügynök `@<agent>` SZÍNES labeljét, hogy a táblán színnel is látszódjon kié a feladat. A labelt egyszer hozd létre ügynökönként (`POST /api/kanban/labels` {name:"@backend", color:"#3b82f6"}); a paletta 6 szín: `#3b82f6 #0ea5e9 #10b981 #14b8a6 #8b5cf6 #64748b`. **Kártyához CSATOLNI a MEGLÉVŐ label ID-jével:** `POST /api/kanban/<cardId>/labels` body `{"labelId":"<label-id>"}` -- NEM `{name,...}` és NEM `{label,color}` (azok 404 / "Címke nem található"). A meglévő labelek + ID-k: `GET /api/kanban/<cardId>/labels`. Az @<agent> labelek többnyire már léteznek, csak csatolni kell.
3. **10 perces beragadás-detektálás.** Ha egy in_progress kártya százaléka/`updated_at`-je 10 percig nem mozdul, valószínűleg beragadt. Beavatkozol: megnézed mi a blokk, újraindítod (re-dispatch az assignee-nek, vagy átveszed/átruházod). A `stuck-card-monitor` ütemezett feladat ezt 5 percenként ellenőrzi és jelez.
3b. **A DISPATCH-UZENET ELAVULHAT -- a statusz ujraolvasasa az ELSO lepes (kartya ffaa4ff1).** Egy dispatch a tabla akkori allapotara keszul, a cimzett viszont percekkel-orakkal kesobb olvassa el, kulonosen ha epp mas munkan van. Mire odaer, a kartya lehet kesz, mas kezeben, vagy ujranyitva egy mas leletttel. Harom ugynok futott ebbe egy nap alatt; a koltseg vagy egy mar elkeszult dolog ujraepitese, vagy egy kor verifikacio.
   - **Kuldoi oldal (automatikus, nem kell rá emlekezni):** a `POST /api/messages` a kuldes pillanataban hozzafuzi minden hivatkozott kartya `status`-at es `updated_at`-jat (`[card-state @send]` blokk). Ez SZERVER-oldalon tortenik, tehat egy elfelejtett kezi bekezdés nem hianyzik belole.
   - **Fogadoi oldal (ez a KOTELEZO szabaly):** barmely dispatch/nudge/re-dispatch feldolgozasanak ELSO lepese a kartya FRISS allapotanak lekerdezese (`GET /api/kanban` + szures id-re), MIELOTT barmilyen munka -- olvasas, epites, agent-inditas -- elkezdodne. Ha a stamp es a friss allapot elter, a friss nyer, es a dispatch elavult: ne epitsd ujra, hanem jelezd vissza.
   - A stamp HINT, nem engedely es nem zar. Nem helyettesiti az ujraolvasast: azert van, hogy az elavulas SZEMBETUNJON, ne azert, hogy megsporolja az ellenorzest.
4. **Készterméket csak NEM a készítő ellenőrizhet — KOCKÁZAT-ALAPÚ gate-tiering (csapat-szabály 2026-07-05).** Minden kész kártyát MINIMUM 2 független ügynök ellenőriz; a készítő SOHA nem ellenőrzi a sajátját. A gate-pool 3 tagú: **QA** (funkcionális), **Cybersec** (per-finding, STRIDE/OWASP), **Cybered** (adverzariális kill-chain). MikroB TTE-feladata (állandó orchestrátor-kötelesség) kártyánként kiválasztani/váltogatni a gate-tagokat a kártya kockázata szerint:
   - **QA: MINDIG** (minden kártyán, ez az egyik a 2-ből). Nem alkudható.
   - **Cybersec:** ha a kártya trust-boundaryt érint — auth, publikus/unauth endpoint, RBAC, multi-tenant scope, pénz, PII, file-upload, superadmin, crypto. Tiszta belső domain-logikánál (nincs új támadási felület) helyette a másik gate-taggal rotál.
   - **Cybered:** magas-tétű kártyákra + release/mérföldkő előtt — publikus write path, auth/session, superadmin, internet-facing. Ekkor **mind a 3** fut.
   - **Alap eset (2 gate):** QA + a kockázatnak leginkább megfelelő biztonsági gate (Cybersec vagy Cybered), rotálva. **Magas-kockázat (3 gate):** QA + Cybersec + Cybered.
   A befejező ügynök `waiting` + "REVIEW" komment. DONE csak akkor, ha MINDEN kijelölt gate PASS/GO. Bármelyik bukása -> vissza `in_progress` reprodukálható jelentéssel. MikroB orchestrálja és a PASS-ok után zárja. A puszta zöld teszt NEM bizonyíték (magic-link 151/151 zöld + 2 MAJOR).
5. **Fázis/szülő automatikus lezárása.** Ha egy szülő-kártya (fázis, feladat, alfeladat) MINDEN gyereke `done` és nincs több tennivaló, a szülőt is `done`-ra teszed. Minden gyerek-lezárás után ellenőrizd felfelé rekurzívan: ha az volt az utolsó nyitott elem, zárd a szülőt is.
6. **Frontend-pairing (csapat-szabály 2026-07-05).** Minden USER-FACING feature/funkció (új feature, pl. versenytárs-elemzésből; VAGY user-facing viselkedést változtató bugfix) mellé MikroB AUTOMATIKUSAN létrehoz egy párosított **Fron Ted** frontend-kártyát (`@fron-ted`, a feature gyereke/testvére, backend kártyára hivatkozva). Két lépés: (1) user flow / IA a `user-flow-menu-design` skillel (hol él a navigációban, teljes journey, minden állapot); (2) frontend UI a `frontend-design-research` skillel, a backendhez drótozva + bekötve az app menü/navigációjába. A user flow-t Fron Ted maga generálja. QA a flow-teljességet + elérhetőséget is gate-eli. Tisztán belső/infra munkánál (adapter, migráció, type-fix -- nincs UI) NINCS pairing. Minden feature-dispatchnél és lezárásnál ellenőrizd: van-e a feature-nek Fron Ted frontend-kártyája; ha nincs, hozd létre.

## Eljárás (új projekt indításakor)
1. Hozz létre egy Fázis-szintű parent kártyát projektenként (assignee, `[0%]`).
2. Bontsd Feladatokra (child, `parent_id` = fázis), mindegyikhez assignee + `[0%]`.
3. Nagy Feladatot bonts alfeladatokra (unoka kártyák). A `/api/kanban/<id>/breakdown` LLM-breakdown segíthet.
4. Munka közben frissítsd a `[NN%]`-t és az állapotot. Kész -> `waiting` + REVIEW komment.
5. MikroB/QA ellenőriz -> `done`. Bukás -> vissza `in_progress` precíz bug-jelentéssel.

## Csapat-roster (subagent_type -> szerep)
**Mérnöki (dev team):**
- `fullstack-mvp-builder` — app/MVP nulláról
- `backend-architect` — skálázható backend/infra
- `frontend-component-engineer` — production UI komponensek
- `fron-ted` (**Fron Ted**) — frontend + awwwards/dribbble design-kutatás, mindig a legújabb megoldás
- `codebase-auditor` — kódbázis audit (read-only)
- `production-debugger` — éles bug / root cause
- `performance-optimizer` — sebesség/memória/skálázás
- `clean-architecture-refactorer` — kuszából tiszta architektúra

**Üzleti / minőség:**
- `qa-engineer` — teszt + független sign-off (DONE jog, nem saját munkára)
- `marketing-strategist` — pozicionálás, GTM, copy
- `legal-counsel` — jogász: ToS, Privacy, DPA, GDPR, IP
- `finance-officer` — pénzügy: unit economics, burn, runway, árazás

**Koordináció:** MikroB (te) vagy a CEO/CTO szerep — felbontás, kiosztás, beragadás-kezelés, végső ellenőrzés.

## Buktatók
- Százalék nincs natív mezőként -> címbe tett `[NN%]`. Ne próbálj nem létező progress oszlopot írni.
- A 4. szabály megsértése (önellenőrzés) a leggyakoribb csúszás. Mindig más ellenőriz.
- Beragadt kártya néma marad -> ezért kell az ütemezett monitor; ne csak manuálisra hagyatkozz.
- Az assignee-nek futnia kell (tmux session), különben a dispatch nem ér célba.
- **`[NN%]` PUT-frissítés NE clobberölje a címet (2026-07-02, saját hiba):** egyetlen kártyát a `GET /api/kanban/<id>` NEM ad vissza (nem-JSON) -> ha onnan olvasod a jelenlegi címet, üres string jön, és a `PUT {title: "..."}` FELÜLÍRJA az egész címet (elveszik a valós cím). Helyesen: a jelenlegi címet a `GET /api/kanban` LISTÁBÓL szűrd id-re (python), a régi `[NN%]`-t regexszel strippeld, tedd rá az újat, ÚGY PUT-old. Fail-safe: ha a base-cím üres, NE PUT-olj (különben clobber). A description-t nem érinti a title-PUT.

## Ellenőrzés
- Minden aktív kártyán van assignee ÉS `[NN%]` a címben.
- Done kártyát nem a készítője mozgatta.
- A stuck-monitor ütemezett feladat aktív (`/api/schedules`).
