# Részletes modulterv – <termék / terület neve>

<!--
KITÖLTHETŐ SABLON. Forrás: Peti "modulterv-reszletes.pdf" (49 oldal, md5 2151fc69...),
a felépítés és a mélység 1:1 abból jön; a teljes mintaszöveg: modulterv-minta-szoveg.txt
(a "1. core" és "2. time_tracking" fejezet a legjobb kitöltött példa).
Szabály: minden <...> helyére konkrétum kerül. Ami nem ismert: [?] jelölés + a
"Implementáció előtt tisztázandó" fejezetbe felvenni. Üres szakasz nem maradhat:
ha egy modulnál tényleg nincs tartalom (pl. nincs állapotgép), írd ki: "Nincs – <indok>".
-->

<dátum> (frissítve <dátum>) · <a projekt tényleges stackje: nyelv · backend · adatbázis · frontend> · Célpiac: <országok / iparágak>

Hatókör: <mi van benne>. **Nincs benne:** <kifejezett kizárások, pl. saját bérszámfejtés, integráció X ebben a fázisban>.

## Mit tartalmaz ez a dokumentum

| Rész | Tartalom |
|---|---|
| <1> | <modul_a>, <modul_b>, ... |
| <2> | ... |
| <n> | Modulok és fázisok összefoglalása · Modulok közötti szerződések · Implementáció előtt tisztázandó |

## Közös konvenciók (egyszer, itt; a modulok nem ismétlik)

- Minden modul azonos sablon szerint: cél · funkciók · adatmodell · állapotgép · beállítások · jogosultságok · API · események · képernyők · élhelyzetek · elfogadási kritériumok · fázis.
- **F-azonosító:** `<KÓD>-NN` (pl. `TT-01` = time_tracking 1. funkciója). A teszt-, kártya- és jegyhivatkozás erre épül.
- **Elfogadási kritérium:** `EK-<KÓD>-N: Adott …; amikor …; akkor …` – közvetlenül tesztté alakítható, mérhető (szám, státuszkód, állapot).
- **Kötelező oszlopok** minden táblán: `id, created_at, updated_at, created_by, updated_by`; többtenantos projektnél `tenant_id` is, és a tenant-izoláció módja (pl. RLS, scope-szűrő) kimondva.
- **Törlés:** mozgásadat nem törölhető; soft delete csak törzsadaton. Audit- és eseménytáblák csak beszúrhatók (append-only).
- **Audit:** minden írási végpont auditált.
- **Beállítás:** üzleti érték nincs kódba égetve; DB-ben tárolt alapérték + kemény határ, és ahol a projektnek van tenant/ügyfél-szintje, ott felülírás a határon belül.
- **Állapot a valós kódhoz mérve:** minden funkció, tábla és végpont mellett `megvan` / `részleges` / `hiányzik` (a migrációk, domain-modulok és a README funkciólista alapján). Csak a delta tervezendő.
- **Forrás-megjegyzés:** <honnan jönnek az állítások>; bizonytalan pont `[?]`; jogi/munkajogi hivatkozás élesítés előtt jogászi validálásra jelölve.

---

## <N>. <modul_kód> – <Modul magyar neve> (<kötelező | opcionális | prémium>)

### <N>.1 Cél
<2–3 mondat: mit old meg, kinek, mire épül (mely modulokra támaszkodik), és mi az, amire más modulok építenek belőle.>

### <N>.2 Funkciók

| # | Funkció | Leírás | Állapot |
|---|---|---|---|
| <KÓD>-01 | <név> | <konkrét viselkedés: mezők, opciók, szabályok, korlátok> | <megvan/részleges/hiányzik> |
| <KÓD>-02 | | | |

### <N>.3 Adatmodell
<!-- NEM kivonat: oszlop + típus + kényszer + index, a projekt adatbázisának típusaival. -->
```
<tabla>(id <PK-TÍPUS>, [tenant_id <TÍPUS> NOT NULL FK,] <oszlop> <TÍPUS> [NULL] [DEFAULT …],
        status TEXT CHECK (status IN ('<a>','<b>')),
        created_at <IDŐBÉLYEG>, updated_at <IDŐBÉLYEG>, created_by <FK>, updated_by <FK>,
        UNIQUE([tenant_id,] <kulcs>))
  INDEX (<…>)
  Izoláció: <többtenantnál a tenant-szűrés módja; egyébként: n/a>
```
Szabályok: <pl. átfedő érvényesség tilos (validáció + DB-kényszer/ellenőrző lekérdezés); valid_to NULL = nyitott végű; a tábla append-only>.
Migráció: <forward + tesztelt rollback útja>.

### <N>.4 Állapotgép – <entitás>
```
<állapot1> ──(<kiváltó esemény / szereplő>)──► <állapot2> ──(…)──► <állapot3>
    │                                                                   ▲
    └──(<alternatív út>)───────────────────────────────────────────────┘
<állapot2> ──(<visszalépés>)──► <állapot1>
```

### <N>.5 Beállítások
| Kulcs | Szint (platform/tenant) | Alapérték | Kemény határ | Leírás |
|---|---|---|---|---|
| <kulcs> | <platform+tenant> | <érték> | <min–max> | <mit szabályoz> |

### <N>.6 Jogosultságok
`<resource>.view|create|edit|delete`, `<resource>.<speciális_művelet>` …
| Szerep | Jogosultságok | Hatókör (tenant/telephely/csapat/saját) |
|---|---|---|
| <superadmin> | | |
| <tenant-admin> | | |
| <vezető> | | |
| <dolgozó> | | |

### <N>.7 API
```
GET    /api/<erőforrás>?<szűrők>                 → <válasz alakja>
POST   /api/<erőforrás>                          {<fő mezők>}   → 201 | 422 <mikor>
GET|PATCH /api/<erőforrás>/{id}
POST   /api/<erőforrás>/{id}/<művelet>           {…}            → <válasz>
```
Minden írási végpont auditált. Hibakódok: <422 validáció, 409 ütközés, 403 hatókörön kívül, …>.

### <N>.8 Események
Kibocsát: `<EseményNév>` (→ <mit vált ki, ki fogyasztja>), …
Fogyaszt: `<EseményNév>` (<forrásmodul>) → <mit csinál rá>.

### <N>.<9…> <Modulspecifikus fejezet, ha kell>
<!-- Pl. "Audit hash-lánc", "Számítási sorrend", "Szabálykatalógus", "Biztonság", "Technikai megoldás".
     A mintában ezek a 8. és a Képernyők között állnak. Ha nincs ilyen, töröld ezt a blokkot és
     számozd tovább. -->

### <N>.<k> Képernyők
<Képernyő 1> (<fő elemek>) · <Képernyő 2> (<fülek / szűrők / tömeges műveletek>) · …
Menü-elhelyezés: <hol érhető el a navigációban, szerepenként> (user-flow-menu-design).

### <N>.<k+1> Élhelyzetek
- **Visszamenőleges módosítás:** <mi történik, mit számol újra; zárt periódusba nem ír, hanem korrekciós tételt tesz a nyitottba>.
- **Zárt periódus:** <…>
- **Ismétlés / idempotencia:** <kulcs, ami miatt nem duplikál>.
- **Párhuzamosság:** <két egyidejű írás esete>.
- **Törlés / kilépés / újra belépés:** <…>
- <további, modulra jellemző eset>

### <N>.<k+2> Elfogadási kritériumok
- **EK-<KÓD>-1:** Adott <konkrét kiinduló állapot számokkal>; amikor <művelet>; akkor <mérhető eredmény: szám, státuszkód, állapot, keletkező sor>.
- **EK-<KÓD>-2:** Adott …; amikor …; akkor <hibaág: pl. 422 az ütköző időszak megjelölésével>.
- **EK-<KÓD>-3:** <audit / jogosultság / tenant-izoláció ága>.

**Fázis:** <F?> (<mi kerül ebbe>), <F?> (<bővítés>). Függ: <modulok>.

---

## <M>. Modulok és fázisok összefoglalása

| Fázis | Modulok | Kimenet |
|---|---|---|
| F0 | <platform-váz, alapok> | <mit tud a rendszer a fázis végén> |
| F1 | <…> | <pl. használható MVP egy pilot-ügyfélnek> |

## <M+1>. Modulok közötti szerződések

| Interfész | Szolgáltató | Fogyasztó | Null-implementáció (ha a modul nincs bekapcsolva) |
|---|---|---|---|
| `<Interfész>::<metódus>(<paraméterek>)` | <modul> | <modulok> | <pl. mindig false / üres lista / 0> |

## <M+2>. Implementáció előtt tisztázandó
- <nyitott kérdés, [?]-lel jelölt pontok, kinek kell eldönteni / honnan jön a válasz>
- <jogászi validálást igénylő pontok>
