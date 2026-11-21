---
name: humanize-writing
description: AI-generált szöveget emberi hangzásúvá alakít -- AI-kliséket felismer és eltávolít, ritmust variál, specifikusságot injektál, brand-voice-t alkalmaz. Triggerek: "emberibbé teszi", "humanize", "robotosan hangzik", "AI-szag", "természetesebbé", "írj úgy mint egy ember", i18n EN forrásszöveg, UI-mikroszöveg, landing copy, kampány szöveg.
version: "2.0.0"
---
# Humanize Writing (AI-tartalom emberiesítése)

## Mikor használd

Ha szöveg robotosan hangzik, AI-klisékkel teli, egyforma mondatritmusú, vagy hiányzik belőle a konkrétság és személyiség.

**Kötelező használat (fron-ted, fron-teddy):** minden commitolható, user-facing EN forrásszöveg (UI-mikroszöveg, hibaüzenet, empty state, placeholder, button label, onboarding copy, landing) átmegy ezen a skillon fordítás előtt.

**Kötelező használat (marketing):** minden végleges kampány-, landing- és social szöveg, brand-voice mintával.

**SOHA nem humanizálunk:** jogi/compliance/terms/privacy szöveget -- ott a pontosság és a kötelező formula a prioritás.

## Output-mód szabályok (KÖTELEZŐ)

Az alábbiak humanizálás közben érintetlenek maradnak:
- i18n kulcsok: `auth.error.invalidCredentials`, `common.submit` stb.
- Interpolációs helykitöltők: `{{userName}}`, `{count}`, `%s`, `{0}`
- Kód-blokkok és inline code: `` `komponens` ``, ` ```...``` `
- URL-ek és linkek
- Technikai azonosítók, version számok, SHA-k

Csak a természetes nyelvi részeket érintsd. Ha egy kulcs értéke egy teljes mondat, a kulcsot nem, a mondatot igen.

## Eljárás

### Mód 1: Diagnózis (előbb ezt)

Auditáld a szöveget az alábbi AI-ujjlenyomatok alapján. Adj 0-100 emberiesség-pontszámot és listázd a fő problémákat.

| Kategória | Példa AI-tell |
|---|---|
| Feltöltőszavak | "kétségtelenül", "fontos megjegyezni", "ne feledjük" |
| Sablonos zárlat | "Összefoglalva..." / "Remélem, segített..." |
| Egyforma mondathossz | Minden mondat 18-22 szavas |
| Vague állítás | "sok vállalat", "tanulmányok szerint", "jelentősen javult" |
| Gondolatjel-túlzás | Em dash (--) minden második mondatban |
| Hamis bizonyosság | "Ez egyértelműen a legjobb megközelítés" |
| Listalás-mánia | Minden választ 5 pontos lista követ |
| not-X-but-Y sablon | "Not just a tool, but a partner in your journey" |
| Egysoros chatbot zárlat | "Hope this helps!", "Let me know if you need anything else!" |
| Mély mondás | "At the end of the day, it's all about connection." |
| Hosszú felvezetés | 3+ bevezető mondat mielőtt eljut a lényeghez |
| Szalmabáb-vita | "You might think X. But actually..." (valódi ellenvetés nélkül) |
| Ismétlődő mondatkezdés | "It is... It is... It is..." / "This is... This is..." |
| Halmozott óvatoskodás | "It might potentially perhaps be worth considering..." |
| Szenvedő szerkezet / alanyhiány | "It can be seen that..." / "It is recommended to..." |
| Homályos kapcsolat | "This is why..." / "That said..." tényleges ok-okozat nélkül |
| -va/-ve lógó mellékmondat (HU) | "Figyelembe véve ezt, az eredmény..." (ki veszi figyelembe?) |
| Névtelen tekintély | "Experts say...", "Research shows...", "Studies suggest..." |
| Díszítő félkövér / fejléc | **Bold** minden harmadik mondatban, ## fejléc triviális mondathoz |
| Chatbot-maradvány | "Sure!", "Of course!", "Certainly!", "Great question!" |
| Tudáshatár-kimentés | "As an AI, I don't have..." / "I cannot provide..." szükségtelenül |
| Fejléc-ismétlés | Fejléc: "How to Get Started" -> 1. mondat: "Getting started is easy..." |
| Előző verzióról írás | "Based on the previous version..." / "As mentioned before..." |

### Mód 2: Humanizálás

Konkrét helyettesítések az azonosított problémákra:

**Feltöltőszavak kiváltása:**
- "kétségtelenül" -> töröld, vagy adj konkrét bizonyítékot
- "fontos megjegyezni" -> mond el amit mondani akarsz, kommentár nélkül
- "különböző" -> nevezd meg őket
- "jelentős" -> add meg a számot

**Mondatritmus variálása:**
- Rövid mondatok mellé hosszabb. Aztán néha egy egymondatos.
- Töredéket is lehet. Hangsúlyhoz.
- Kérdés -> felelet struktúra az egyhangúság ellen.

**Specifikusság injektálása:**
- "sok vállalat" -> "a Stripe és a Notion is"
- "tanulmányok szerint" -> "A Nielsen 2024-es adatai szerint..."
- "62%-kal nőtt" a "gyorsabb lett" helyett

**Személyiség hozzáadása:**
- Közvetlen megszólítás ("te" nem "felhasználók")
- Vélemény kimondása ("Ezt gondolom: ...")
- Stratégiai kitérő zárójelben (mellékgondolat, ahogy embereknél is előfordul)

**not-X-but-Y eltávolítása:**
- "Not just a tool, but a partner" -> "A tool that X-et csinál neked."
- Kerüld a kontrasztpárt, ha nincs mögötte valódi különbség.

**Chatbot-zárlat felváltása:**
- "Hope this helps!" -> töröld, vagy zárd a tényleges utolsó gondolattal.
- "Let me know if..." -> csak ha tényleg vársz visszajelzést és indokolt.

**Mély mondások eltávolítása:**
- "At the end of the day, it's all about X." -> töröld, és mond el konkrétan mit jelent X.
- Általában az ilyen mondatok a bekezdés legelejére vagy végére kerülnek -- ott keresd.

**Felvezetés rövidítése:**
- Ha az első 2-3 mondat nem visz közelebb a lényeghez, töröld.
- Az olvasó ideje értékes.

**Szalmabáb-vita eltávolítása:**
- "You might think X. But actually..." -> ha X valódi ellenvetés, foglalkozz valóban vele; ha nem, hagyd el az egész felütést.

**Ismétlődő mondatkezdések feloldása:**
- Várd fel a lista minden mondatkezdőjét, és ha 2+ ugyanolyan -> egyik átfogalmazás, másik rövidítés.

**Halmozott óvatoskodás csökkentése:**
- "It might potentially perhaps be worth considering" -> "Érdemes megfontolni" vagy konkrétabb állítás.
- Egy bizonytalansági marker elég mondatonként.

**Szenvedő szerkezet / alanyhiány javítása:**
- "It can be seen that..." -> "Látható, hogy..." vagy "A szám azt mutatja..."
- "It is recommended to..." -> "Javasoljuk, hogy..." / "Csináld így:"
- Magyar: "Figyelembe véve ezt" -> "Ha ezt figyelembe vesszük"

**Homályos kapcsolat eltávolítása:**
- "This is why..." -> csak ha az ok valóban ki van fejtve előtte; ha nem, fejtsd ki vagy töröld a kötőszót.
- "That said,..." -> általában törölt

**Névtelen tekintély felváltása:**
- "Experts say..." -> vagy nevesítsd (melyik szakértő, mikor), vagy töröld.
- "Research shows..." -> "A Forrester 2024-es felmérése szerint..." vagy töröld.

**Díszítő bold / fejléc eltávolítása:**
- Ha a félkövér nem tereli a figyelmet kulcsinformációra, töröld.
- Ha minden harmadik mondat félkövér, egyik sem kiemelés.
- Fejléc csak valódi szekció-elválasztóhoz kell.

**Chatbot-maradványok eltávolítása:**
- "Sure!", "Of course!", "Certainly!" -> töröld, kezdd el rögtön a választ.
- "Great question!" -> töröld.

**Tudáshatár-kimentés csökkentése:**
- Ha a szöveg nem ígér olyat amit nem tud teljesíteni, az "As an AI..." disclaimer nem kell.
- Csak akkor hagyd meg, ha valóban releváns korlátot kommunikál.

**Fejléc-ismétlés eltávolítása:**
- Ha az első mondat parafrazeálja a fejlécet: töröld a mondatot, vagy add hozzá az első új infót.

**Előző verzióról írás kiirtása:**
- "As mentioned before..." -> töröld; ha fontos, mondj el összefoglalót.
- "Based on the previous version..." -> pontosítsd vagy töröld.

### Mód 3: Brand voice alkalmazása

Ha kapsz brand voice példákat:
1. Azonosítsd a ritmus-mintát (mondathossz, írásjelek, hangnem)
2. Vedd ki a brand-specifikus fordulatokat
3. Alkalmazd következetesen az új szövegre

### Mód 4: Tény-megőrzési önellenőrzés (kötelező átírás után)

Mielőtt leadod az átírt szöveget, ellenőrizd:
1. Minden konkrét szám, dátum, névemlékezés ugyanaz maradt-e?
2. Semmilyen állítás nem fordult-e meg (pl. "nem ajánlott" -> "ajánlott")?
3. Ha kétséges, vesd össze az eredeti forrásmondattal.

Ha tény megváltozott: javítsd vissza és jelezd a változtatás okát.

## Kimenet

1. Diagnosztika esetén: pontszám + hibajegyzék.
2. Humanizálásnál: átírt szöveg + rövid magyarázat mit változtattál.
3. Ha teljes újraírás kell (pontszám < 30): jelzed, és megcsinálod.

## Buktatók

- Ne távolíts el minden struktúrát -- listának helyük van, csak ne legyen mindig lista.
- A "természetesség" nem egyenlő a pongyolasággal. Tiszta, tömör szöveg is lehet emberi.
- Brand voice nélkül ne találj ki egyet -- kérd el a mintát, vagy dolgozz semleges stílusban.
- Overcorrection: ha mindent töredékekre vágsz, az is mesterséges lesz.
- i18n-kulcsokat, interpolációkat, kódot, linkeket SOHA ne érintsd.
- Jogi/compliance szöveget SOHA ne humanizálj.
- A tény-megőrzési önellenőrzés (Mód 4) nem formalitás -- mért esetek vannak ahol az átírás megfordított egy állítást.

## Ellenőrzés

- Kiállja a hangos felolvasás tesztet (megakadsz valahol)?
- Minden állítás konkrét (nincs "sok" vagy "jelentős" számok nélkül)?
- Változó a mondathossz?
- Nincsenek AI-specifikus feltöltőszavak?
- i18n-kulcsok és interpolációk sértetlenek?
- Tények egyeznek az eredetivel (Mód 4)?

## Referenciák

- `references/ai-patterns-hu.md` -- Magyar szólista és példák
- `references/ai-patterns-en.md` -- EN szólista (i18n forrásszövegekhez)
