---
name: humanize-writing
description: AI-generált szöveget emberi hangzásúvá alakít — AI-kliséket felismer és eltávolít, ritmust variál, specifikusságot injektál, brand-voice-t alkalmaz. Triggerek: "emberibbé teszi", "humanize", "robotosan hangzik", "AI-szag", "természetesebbé", "írj úgy mint egy ember".
---
# Humanize Writing (AI-tartalom emberiesítése)

## Mikor használd
Ha szöveg robotosan hangzik, AI-klisékkel teli, egyforma mondatritmusú, vagy hiányzik belőle a konkrétság és személyiség.

## Eljárás

### Mód 1: Diagnózis (előbb ezt)
Auditáld a szöveget 7 AI-ujjlenyomat alapján:

| Kategória | Példa AI-tell |
|---|---|
| Feltöltőszavak | "kétségtelenül", "fontos megjegyezni", "ne feledjük" |
| Sablonos zárlat | "Összefoglalva..." / "Remélem, segített..." |
| Egyforma mondathossz | Minden mondat 18-22 szavas |
| Vague állítás | "sok vállalat", "tanulmányok szerint", "jelentősen javult" |
| Gondolatjel-túlzás | Em dash minden második mondatban |
| Hamis bizonyosság | "Ez egyértelműen a legjobb megközelítés" |
| Listalás-mánia | Minden választ 5 pontos lista követ |

Adj 0-100 emberiesség-pontszámot és listázd a fő problémákat.

### Mód 2: Humanizálás
Konkrét helyettesítések:

**Feltöltőszavak kiváltása:**
- "kétségtelenül" → töröld, vagy adj konkrét bizonyítékot
- "fontos megjegyezni" → mond el amit mondani akarsz, kommentár nélkül
- "különböző" → nevezd meg őket
- "jelentős" → add meg a számot

**Mondatritmus variálása:**
- Rövid mondatok mellé hosszabb. Aztán néha egy egymondatos.
- Töredéket is lehet. Hangsúlyhoz.
- Kérdés → felelet struktúra az egyhangúság ellen.

**Specifikusság injektálása:**
- "sok vállalat" → "a Stripe és a Notion is"
- "tanulmányok szerint" → "A Nielsen 2024-es adatai szerint..."
- "62%-kal nőtt" a "gyorsabb lett" helyett

**Személyiség hozzáadása:**
- Közvetlen megszólítás ("te" nem "felhasználók")
- Vélemény kimondása ("Ezt gondolom: ...")
- Stratégiai kitérő zárójelben (mellékgondolat, ahogy embereknél is előfordul)

### Mód 3: Brand voice alkalmazása
Ha kapsz brand voice példákat:
1. Azonosítsd a ritmus-mintát (mondathossz, írásjelek, hangnem)
2. Vedd ki a brand-specifikus fordulatokat
3. Alkalmazd következetesen az új szövegre

## Kimenet
1. Diagnosztika esetén: pontszám + hibajegyzék.
2. Humanizálásnál: átírt szöveg és rövid magyarázat mit változtattál.
3. Ha teljes újraírás kell (pontszám < 30): jelzed, és megcsinálod.

## Buktatók
- Ne távolíts el minden struktúrát -- listának helyük van, csak ne legyen mindig lista.
- A "természetesség" nem egyenlő a pongyolasággal. Tiszta, tömör szöveg is lehet emberi.
- Brand voice nélkül ne találj ki egyet -- kérd el a mintát, vagy dolgozz semleges stílusban.
- Overcorrection: ha mindent töredékekre vágsz, az is mesterséges lesz.

## Ellenőrzés
- Kiállja a hangos felolvasás tesztet (megakadsz valahol)?
- Minden állítás konkrét (nincs "sok" vagy "jelentős" számok nélkül)?
- Változó a mondathossz?
- Nincsenek AI-specifikus feltöltőszavak?
