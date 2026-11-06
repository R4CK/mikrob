---
name: clean-room-product-analysis
description: Clean-room, fekete-doboz termék-elemzés egy IDEGEN (nem saját) appon vagy weboldalon, kívülről, felhasználóként, Playwright-tal, module-spec-design formátumú funkcionális spec kimenettel. Triggerek: "elemezd a versenytársat", "clean-room elemzés", "nézd át a X appot kívülről", "mit csinál ez a termék", "versenytárs funkció-spec", "gap-elemzés egy külső termékről". NEM ez a skill a saját (REA) termékünk elemzésére -- arra a reverse-engineer-anything skill.
version: "1.0.0"
---

# Clean-room termék-elemzés (2. üzemmód)

Forrás: `agents/elemzo/CLAUDE.md` "2. üzemmód - Clean-room termék-elemzés" szekciója (Peti
12051, 2026-10-23) -- ez a skill ANNAK a már jóváhagyott eljárásnak a betölthető, kereshető
csomagolása, nem új szabály. Ha a két szöveg valaha eltérne, a CLAUDE.md a mérvadó, és ezt a
fájlt kell hozzá igazítani, nem fordítva.

## Mikor használd

Amikor egy CÉL appot vagy weboldalt kell funkcionálisan megérteni úgy, hogy MI NEM vagyunk a
tulajdonosa -- versenytárs-elemzés, gap-elemzés egy iparági megoldásról, "mit csinál ez a
termék" kérdés. Ha a cél a SAJÁT kiszállított termékünk, ez nem ez a skill: ott a
`reverse-engineer-anything` (1. üzemmód) a helyes eszköz, és forráskód/bundle-olvasás ott
megengedett, itt NEM.

## Mielőtt elindulsz: hatókör és engedély

1. **Csak a nyilvánosan, normál felhasználóként elérhető felület.** Nincs fizetős fal
   átlépése, nincs idegen fiókba bejelentkezés, nincs ToS-sértő automatizálás.
2. **robots.txt és ToS gyors ellenőrzése.** Ha a cél felület láthatóan tiltja az automatizált
   bejárást (robots.txt, ToS-szöveg, rate limit válasz, captcha), MEGÁLLSZ és jelzel -- nem
   kerülöd meg semmilyen technikával.
3. **Credential/regisztráció kérdés.** Ha a bejáráshoz bármilyen hitelesítő adat, fizetős
   előfizetés, login-automatizálás vagy saját regisztráció kellene: ELŐBB szólsz Peti-nak és a
   MikroB Főnöknek, és megvárod a döntést. Credential sosem kerül nyersen kódba vagy promptba.
4. Ha ezen a ponton bármi kérdéses ("valószínűleg oké" érzés), az NEM engedély -- megállsz és
   kérdezel, nem indulsz el találgatással.

## Eljárás (Playwright bejárás)

Az MCP Playwright toolok (`mcp__playwright__browser_*`) deferred módon érkezhetnek: előbb
`ToolSearch` a pontos névvel vagy a `playwright`/`browser` kulcsszóval, mielőtt hívod őket.

1. **Navigáció + snapshot.** `browser_navigate` a cél kezdőoldalára, utána `browser_snapshot`
   (accessibility-tree) -- ez a bizonyíték alapja, nem a vizuális kép.
2. **Flow-k végigjárása emberléptékben.** Regisztráció, onboarding, fő use case, beállítások,
   hibás út, üres állapot -- mindegyik elejétől a végéig, lassan, nem párhuzamos rohammal.
3. **Állapot-leltár minden képernyőn:** loading / empty / error / success / permission, a
   navigáció/IA szerkezete, validációk, visszajelzések. Mobil ÉS desktop méret
   (`browser_resize`) -- az állapot-leltár méretenként eltérhet.
4. **Bizonyíték rögzítése minden lépésnél:** `browser_take_screenshot` (BELSŐ munkapéldány,
   nem publikálható anyag), `browser_network_requests` a flow után, `browser_console_messages`
   hibáknál. Ezek a [MEGFIGYELÉS] hivatkozásaid, nem a kimenet részei.
5. **`browser_evaluate`/`browser_run_code_unsafe` idegen célon NEM eszköz a visszafejtéshez.**
   Csak akkor, ha a bejáráshoz technikailag kell (pl. scroll-pozíció), sosem kiszállított kód
   kinyerésére.

## Tilos dolgok (MEGSZEGHETETLEN, nincs kivétel)

- **Nincs forráskód- vagy bundle-olvasás.** Nincs view-source, nincs DevTools-alapú JS-bundle
  vizsgálat, nincs decompile, nincs source map halászás.
- **Nincs asset- vagy szövegátvétel.** A screenshot és a hálózati log BELSŐ bizonyíték, soha
  nem kerül ki a kimenetbe képként, ikonként, markup-ként vagy szövegként. A specben csak annyi
  idézet szerepelhet, amennyi egy megfigyelés azonosításához feltétlenül kell, és az
  idézetként jelölve.
- **Nincs belépés nem-nyilvános részbe** (admin felület, jogosultsági szint, amihez nincs
  normál-felhasználói hozzáférésünk).
- **Nincs rate-limit megkerülés** -- ha a cél korlátoz, az a korlát, nem egy akadály, amit ki
  kell kerülni.
- **Design-másolás nincs.** A spec funkcionális leírás, a látványt a flotta tervezi újra.

Ha egy kérés ezekbe ütközne, megtagadod, egy mondatban megmondod miért, felajánlod a
clean-room bejárást mint megengedett alternatívát (ha a kérés eredetileg visszafejtés lett
volna), és szólsz a MikroB Főnöknek.

## Kimenet: funkcionális spec a module-spec-design sablonnal

A `module-spec-design` skillt TÖLTSD BE és kövesd a sablont (cél, F-azonosítós funkciólista,
adatmodell, állapotgép, beállítások, jogosultságok, API, események, képernyők, élhelyzetek,
EK-k, fázis). A spec a MEGFIGYELT viselkedést a SAJÁT termékünk nyelvére fordítja, nem a cél
termék szavaival írja le.

Kötelező kiegészítők, amik a module-spec-design sablonban nincsenek benne eleve:

- **Keret és módszer**: mikor, milyen felületen, milyen mélységig jártad be, mit NEM láttál.
- **Jelölés minden állításnál**: `[MEGFIGYELÉS]` (bizonyíték: konkrét Playwright lépés,
  hálózati kérés vagy képernyőkép-azonosító), `[KÖVETKEZTETÉS]` (mely megfigyelésekre épül +
  biztonság: magas/közepes/alacsony), `[ISMERETLEN]` (mi hiányzik, mivel lenne
  megállapítható). Jelölés nélküli mondat nem kerül ki a kimenetből.
- **Szándékos eltérések**: mit NEM veszünk át a cél termékből, és miért.
- **Jogi átnézésre váró pontok**: amit a jogásznak külön ki kell emelni.
- **Nyitott kérdések**: amit kívülről nem lehetett eldönteni.

A adatmodell-mezőket KÖVETKEZTETÉSKÉNT jelölöd (a cél termék belső adatmodelljét sosem látod
közvetlenül, csak a felületen keresztül következtetsz rá).

## A spec útja (nem opcionális, nem ugorható)

1. Megírod a specet (fentiek szerint).
2. **A jogász (legal-counsel) átnézi.** Ez a lépés sosem hagyható ki, és nem a te döntésed
   átugorni.
3. A jóváhagyott specből a flotta épít saját kódot és saját designt.
4. Te nem építesz. Kérdésre magyarázol, a specet pontosítod, kódot a célfunkcióhoz nem írsz.

## Zárás előtti visszanézés (kötelező, minden spec előtt)

1. Minden állítás jelölt (`[MEGFIGYELÉS]`/`[KÖVETKEZTETÉS]`/`[ISMERETLEN]`)? Jelölés nélküli
   mondatot javítsd.
2. Minden `[MEGFIGYELÉS]` mellett konkrét, visszakereshető bizonyíték van (nem "a bejárás
   során", hanem melyik lépésben, melyik screenshoton)?
3. Minden `[KÖVETKEZTETÉS]` visszavezethető a felsorolt megfigyelésekre, nincs rejtett
   feltételezés?
4. Átvettél bármi idegen anyagot (kód, asset, szöveg, design-részlet)? Ha igen, vedd ki.
5. Átlépted a hatókör határát (bejelentkezés, fizetős fal, nem-nyilvános rész)? Ha igen, a
   spec ezt nyíltan mondja ki, nem hallgatja el.
6. Van titok a kimenetben (token, belső URL, ügyféladat)? Ha igen, maszkold vagy vedd ki.
7. Mi hiányzik még -- egy bekezdésben, és mi lenne a következő lépés.

A visszanézés eredménye a spec végén "Visszanézés" szekcióként kerül be.

## Buktatók

- A screenshot és a raw network log csábít arra, hogy "csak gyorsan" bekerüljön a kimenetbe
  bizonyítékként -- ez már asset/szövegátvétel, ha a cél termék felületének képe vagy
  szövege szó szerint megjelenik a specben. A screenshot MARAD a belső munkakönyvtárban, a
  specbe csak a belőle levont funkcionális állítás kerül, jelöléssel.
- "A robots.txt/ToS nem töltődik be" nem jelenti azt, hogy a bejárás engedélyezett -- ez
  megállás és jelzés, nem átengedés (lásd fent, 2. pont).
- Ne csomagold a specet kártyákra bontásként a jogászi átnézés előtt -- a kártyára bontás a
  JÓVÁHAGYOTT spec utáni lépés.

## Ellenőrzés

Egy próbabejárás saját, nem-idegen felületen (pl. mopsion.com, ahol az átvétel-tilalom nem
releváns kockázat, csak a MECHANIKA tesztelendő) spec-vázat ad: jelölt állítások, a
module-spec-design kötelező szekciói mind kitöltve vagy `[ISMERETLEN]`-ként jelölve, és nincs a
kimenetben szó szerint átvett UI-szöveg.
