---
name: video-production-repurposing
description: Videó gyártás/vágás és rövid-formátumú repurposing — jump-cut, felirat, B-roll terv, legjobb-klip azonosítás transzkriptből, YouTube-optimalizálás (cím/thumbnail/hook/retention). Use for video editing plans, Shorts/TikTok repurposing, YouTube optimization. A `video-analysis-reproduction` skill meglévő videót ELEMEZ; ez a skill ÚJ videót/klipet TERVEZ/GYÁRT. Triggerek: "vágás", "video editing", "felirat", "B-roll", "shorts", "repurpose", "YouTube optimalizálás", "thumbnail", "retention script".
---
# Video Production & Repurposing

## Mikor használd
Videótartalom gyártásának/vágásának tervezésekor, hosszú videóból rövid klip (Shorts/Reels/TikTok) kivágásakor, vagy YouTube-videó cím/thumbnail/hook optimalizálásakor. Ha a feladat egy MEGLÉVŐ videó elemzése/dokumentálása (nem gyártás), az a `video-analysis-reproduction` skill.

## Eljárás

### 1. Vágási alaptechnikák (terv, nem futtatás -- az FFmpeg/Whisper-alapú eszközlánc a végrehajtási réteg)
- **Jump-cut:** szünetek, töltelékszavak (ő, hát, szóval) kivágása -- pörgősebb tempó, retention-növelő.
- **Caption/felirat stílus:** legtöbb platformon (mobil, hang nélküli autoplay) a felirat NEM opcionális -- burn-in felirat kell, nem csak platform-natív closed caption.
- **B-roll terv:** minden 8-12 másodperces beszéd-szegmenshez tervezz vizuális váltást (kép, grafika, kontextus-felvétel) -- a vágatlan "talking head" a legnagyobb retention-vesztő.
- **Speed ramp:** lassú/magyarázó rész normál tempó, ismétlődő/köztes rész felgyorsítható (1.2-1.5x), a kulcs-pillanat sose.

### 2. Legjobb-klip azonosítás hosszú videóból (repurposing)
1. Transzkript időbélyeggel (ha nincs, a `video-analysis-reproduction` skill generálja).
2. Jelölj minden önmagában-érthető, 30-60 másodperces szegmenst, amiben van: konkrét állítás/adat, érzelmi csúcspont, vagy "aha"-pillanat.
3. Rangsorolj: hook-erősség (az első 3 másodperc önmagában megállítja-e a görgetést) + lezártság (nem igényel korábbi kontextust).
4. Top 3-5 szegmens jelölése kivágásra, mindegyikhez saját hook-cím javaslattal.

### 3. Hub / Hero / Help repurposing-modell
| Típus | Cél | Formátum |
|---|---|---|
| **Hero** | Nagy elérés, márkaépítés | Ritka, magas produkciós érték, hosszú-forma |
| **Hub** | Rendszeres elköteleződés | Rendszeres kadencia, közepes produkció, sorozat-jelleg |
| **Help** | Keresés-vezérelt, evergreen | How-to, gyakori kérdés megválaszolása, SEO-barát cím |

Egy hosszú videóból tipikusan: 1 Hero-vágás (a fő narratíva) + 3-5 Help-klip (önálló, kereshető alkérdések) + 1-2 Hub-poszt (rövid, gyakori-formátumú kivonat).

### 4. YouTube-specifikus optimalizálás
- **Cím:** konkrét ígéret, kulcsszó elöl, ne clickbait-csalás (retention-t rombolja, ha a tartalom nem tartja be).
- **Thumbnail:** 1 fókuszpont, kontrasztos, arc+érzelem ha releváns, olvasható kis méretben is (mobil-nézet teszt kötelező).
- **Hook (első 3-15 mp):** azonnal mondd ki, mit kap a néző és miért maradjon -- ne "szia, ma arról fogunk beszélni hogy" bevezetéssel indíts.
- **Retention-görbe olvasása:** ha a lemorzsolódás egy adott ponton ugrásszerű, azt a szegmenst nézd meg elsőként a következő vágásnál (mi történt ott: hossz, téma-váltás, CTA).
- **Shorts vs. hosszú-forma stratégia:** Shorts = felfedezés/új néző szerzés; hosszú-forma = mélység, monetizáció, hűséges közönség megtartása -- mindkettő kell, más célra.

### 5. Platform-specifikációk (repurposing checklist)
- **Aspect ratio:** 9:16 (Shorts/Reels/TikTok), 1:1 (feed), 16:9 (YouTube hosszú-forma) -- ne csak crop-old a hosszú-formát, komponáld újra a fókuszt.
- **Felirat burn-in:** minden rövid-formátumú klipen kötelező (néma autoplay a norma).
- **Hossz:** platform-optimalizált (Shorts/Reels ~15-60s a legjobb retention-sávban, TikTok tolerálja a hosszabbat is trend-függően -- ellenőrizd az aktuális platform-ajánlást gyártás előtt).

## Kimenet
1. Vágási terv (jump-cut pontok, B-roll igény, caption-stílus).
2. Repurposing-klip lista: időbélyeg-tartomány, hook-cím, cél-platform, Hub/Hero/Help besorolás.
3. YouTube-optimalizálási csomag (cím-variánsok, thumbnail-koncepció, hook-szöveg) ha hosszú-forma videóról van szó.
4. Retention-diagnózis, ha van meglévő analytics-adat.

## Buktatók
- Crop-olt (nem újrakomponált) hosszú-forma klip rövid-formátumon -- a fókusz kiesik a keretből, gyenge retention.
- Felirat nélküli rövid-klip -- a néma-autoplay közönség lemorzsolódik az első másodpercben.
- Clickbait cím, amit a tartalom nem old be -- rövid távon kattintás, hosszú távon retention és csatorna-hitelesség vész el.
- Repurposing csak mennyiségi cél alapján ("vágjunk ki 10 klipet"), lezártság/hook-erősség vizsgálat nélkül -- gyenge klipek hígítják a csatorna átlagos teljesítményét.

## Ellenőrzés
- A vágási terv minden 8-12 mp szegmenshez tervez vizuális váltást.
- Minden repurposing-klip önmagában érthető (nincs "ahogy korábban mondtam" jellegű függőség).
- YouTube-csomag esetén cím + thumbnail + hook mind megvan, nem csak a cím.
- A cél-platform aspect ratio és felirat-igénye figyelembe van véve.

## GitHub-first döntés (Peti szabály 2026-07-12)
Léteznek kész, karbantartott video-eszközlánc skillek (FFmpeg+Whisper natural-language vágás, Remotion-alapú motion graphics, YouTube-csatorna teljes toolkit), de ezek futtatható kódot/külső eszközfüggőséget (FFmpeg, Whisper modell, Remotion runtime) hoznak be, amit a jelen feladat (tervezési/stratégiai réteg) nem igényel, és a due diligence (licenc, karbantartottság, futtatási környezet) meghaladná a feladat arányát. Döntés: **adapt** -- a domén-keretrendszert (repurposing-modell, retention-diagnózis, platform-specifikáció) vettem át saját megfogalmazásban; ha később tényleges automatizált vágás indokolt, a `6missedcalls/video-editing-skill` (Bash+FFmpeg+Whisper) az elsődleges jelölt code-szintű adoptálásra.

## Források
- https://github.com/AgriciDaniel/claude-youtube (csatorna-audit, video SEO, retention script, Shorts-optimalizálás, Hub/Hero/Help repurposing)
- https://github.com/6missedcalls/video-editing-skill (natural-language vágás: trim, jump-cut, caption, speed change -- Bash+FFmpeg+Whisper)
- https://github.com/digitalsamba/claude-code-video-toolkit (AI-natív videógyártási eszközlánc)
- https://github.com/haidrrrry/claude-remotion-skill (Remotion-alapú motion graphics, B-roll, caption, sound design)
