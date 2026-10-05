---
name: module-spec-design
description: KÖTELEZŐ sablon és mélység minden modul tervezéséhez (Peti szabály 2026-10-02). Használd, amikor egy új modult, egy versenytárs-elemzésből jövő hiányzó funkciót, vagy egy meglévő modul bővítését kell megtervezni (adatbázis + funkció szint). Triggerek: "modulterv", "tervezd meg a modult", "részletes modul terv", "hiányzó modulok", "gap analízis után terv", "module spec", "design the module".
---
# Modulterv-sablon (Peti szabály, 2026-10-02, Telegram 10045)

Peti a "modulterv-reszletes.pdf" (munkaidő-SaaS részletes modulterv, 49 oldal) felépítését és
mélységét tette kötelező mércévé: "a jövőben ilyen szinten és mélységében kérem megtervezni a
modulokat! Ez szabály legyen!". A minta teljes szövege: `references/modulterv-minta-szoveg.txt` (csak a helyi telepítésen,
szándékosan nincs a publikus repóban: Peti belső dokumentuma; ha hiányzik, a `MODULTERV-SABLON.md` elég)
(a core / time_tracking fejezet a legjobb példa, 2-5. oldal).

**Kitölthető sablon (KÖTELEZŐ kiindulópont, Peti 2026-10-05, Telegram 10491):**
`references/MODULTERV-SABLON.md` – a PDF felépítése 1:1 (dokumentum-fejléc, közös konvenciók,
modulonkénti 12 fejezet + opcionális modulspecifikus fejezet, fázis-összefoglaló, modulok közötti
szerződések null-implementációval, "Implementáció előtt tisztázandó"). Másold le, és minden `<...>`
helyére konkrétum kerül. Előtte, ha a döntés még nincs meg, `writing-prds` / `problem-definition`
adhatja a cél- és EK-alapot; a modulterv formája akkor is ez a sablon.

## Mikor használd
- Bármely új modul vagy modulbővítés tervezésekor, MIELŐTT kártyára bontod.
- Versenytárs-/gap-elemzés után a kiválasztott modulokra.
- Ha egy kártya "tervezd meg"-et kér, a kimenet ebben a formában készül.

## Kötelező felépítés MODULONKÉNT (sorrend kötött)
1. **Cél** – 2-3 mondat: mit old meg, kinek, mire épül.
2. **Funkciók** – táblázat, minden sorban F-azonosító (`<MODULKÓD>-NN`, pl. `TT-01`), név, leírás.
   A teszt- és kártyahivatkozás erre az azonosítóra épül.
3. **Adatmodell** – táblák oszlopokkal és típusokkal (`tabla(id, tenant_id, ..., created_at)`), UNIQUE/FK/CHECK,
   indexek, és a szabályok (pl. "átfedő érvényesség tilos"). Többtenantos projektnél minden tenant-tábla
   `tenant_id` + kimondott izoláció (pl. RLS), a mozgásadat nem törölhető (csak törzsadat soft delete), audit/esemény-táblák
   append-only. Migráció tesztelt rollbackkel (11. kódminőségi elv).
4. **Állapotgép** – ASCII-diagram a fő entitás(ok) állapotairól és átmeneteiről (ki/mi váltja ki).
5. **Beállítások** – platform-szint (superadmin) + tenant-szint, DB-ben, beégetett érték nélkül (14. elv);
   alapérték és kemény határ.
6. **Jogosultságok** – `resource.action` lista, RBAC-szerepenként, hatókörrel (tenant/telephely/csapat).
7. **API** – végpontlista (metódus, út, fő paraméterek, válasz), írási végpont auditált.
8. **Események** – kibocsátott és fogyasztott domain-események, mit váltanak ki.
9. **Képernyők** – oldalak/nézetek listája, és hova kerülnek a menüben (user-flow-menu-design).
10. **Élhelyzetek** – visszamenőleges módosítás, zárt periódus, ismétlés/idempotencia, párhuzamosság, törlés/kilépés.
11. **Elfogadási kritériumok** – `EK-<KÓD>-N: Adott ...; amikor ...; akkor ...` formában, közvetlenül tesztté alakítható.
12. **Fázis** – melyik ütemezési fázisba esik, függőségekkel.

## Dokumentum-szintű elemek
- Fejléc: dátum, stack, hatókör (mi NINCS benne), tartalomjegyzék modulonként.
- Közös konvenciók egyszer, az elején (kötelező oszlopok, audit, törlési szabály, F-/EK-azonosító).
- Forrásmegjegyzés: honnan jön az állítás, bizonytalan pont jelölve ([?]); jogi pontok jogászi validálásra jelölve.

## Projekt-kötés (MINDEN projektre, nem csak mopsionra -- Peti 2026-10-05, Telegram 10496)
- A tervet a VALÓS kódhoz/sémához mérd (migrációk, domain-modulok, README funkciólista), ne fejből.
  Ami már létezik: jelöld (`megvan` / `részleges` / `hiányzik`), és csak a deltát tervezd.
- Minden user-facing funkcióhoz Pair-FE (8. munkavégzési szabály), contract-first (8b).
- A kártyára bontás az F-azonosítók mentén történik (Fázis -> Feladat -> alfeladat).

## Buktatók
- A "kivonat" szintű adatmodell NEM elég: oszlop + típus + kényszer kell, különben a backend találgat.
- Az EK legyen mérhető (konkrét szám, státuszkód, állapot), ne "működjön jól".
- Ne másold a minta Laravel/MySQL részleteit: az adott projekt tényleges stackjére fordítsd (mopsionnál pl. TypeScript, Postgres, RLS).
