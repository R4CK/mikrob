---
name: contract-review-redline
description: Szerződés-review és redline — klauzula-kockázat besorolás, piaci benchmark, tárgyalási stratégia (mit engedj, mit tarts). Use for contract review, redlining, negotiation stance, NDA/vendor/SaaS-subscription agreement analysis. Not a substitute for a licensed attorney. Triggerek: "szerződés review", "redline", "contract review", "NDA", "tárgyalási stratégia", "risk clause", "milyen klauzulát fogadjak el".
---
# Contract Review & Redline

## Mikor használd
Beérkező szerződés (vendor, SaaS subscription, NDA, partner-megállapodás) átnézésekor, redline készítésekor, vagy tárgyalási álláspont kialakításakor. A `legal-compliance-review` skill a MI dokumentumainkat (ToS/PP/DPA) fedi; ez a skill a MÁSOK által küldött szerződéseket.

## Disclaimer (mindig mondd ki érdemi kimenetnél)
AI vagy, nem ügyvéd; ez nem jogi tanács. Nagy tétű / hosszú távú kötelezettséget keletkeztető szerződéshez humán ügyvéd kell. Ez első körös szűrés és kockázat-térkép, nem végső jóváhagyás.

## Eljárás

### 1. Klauzula-leltár
Azonosítsd a szerződés összes érdemi klauzuláját és típusát:
indemnification, liability cap, termination (for cause / for convenience), auto-renewal, IP ownership/license, non-compete/non-solicit, governing law + jurisdiction, SLA + credits, data processing (ha releváns, keresztreferencia a `legal-compliance-review` GDPR/nDSG szekciójával), payment terms, confidentiality survival period.

### 2. Kockázat-besorolás klauzulánként
| Szint | Jelentés | Akció |
|---|---|---|
| **Favorable** | A mi érdekünket szolgálja vagy piaci standard, ránk nézve | Nincs teendő |
| **Neutral** | Piaci standard, nincs egyoldalú hátrány | Nincs teendő, dokumentáld |
| **Unfavorable** | Piaci standardtól eltér a mi kárunkra | Redline javaslat + indoklás |
| **Dealbreaker** | Elfogadhatatlan kockázat (pl. korlátlan felelősség, egyoldalú IP-átruházás) | Kötelező redline, eszkaláld emberi döntéshez |

### 3. Piaci benchmark -- gyakori dealbreaker minták
- **Korlátlan/aszimmetrikus felelősség** -- a másik fél felelőssége korlátozott, a miénk nem. Kérj szimmetrikus cap-et (tipikusan 12 havi díj).
- **Egyoldalú, indoklás nélküli megszüntetés** a másik fél javára, nekünk csak "for cause". Kérj szimmetriát vagy minimum értesítési időt (30-90 nap).
- **IP work-for-hire klauzula hiánya** vagy homályos megfogalmazása -- lásd `legal-compliance-review` IP assignment checklist.
- **Auto-renewal rövid lemondási ablakkal** (pl. 90 nap a lejárat előtt) -- rejtett elköteleződés, jelöld.
- **Kizárólagosság (exclusivity)** ellenszolgáltatás nélkül vagy aránytalan hosszra.
- **Tág, aszimmetrikus indemnification** (mi indemnifikálunk mindent, ők semmit).

### 4. Redline formátum
Minden javasolt módosításnál:
1. Eredeti szöveg (idézve).
2. Probléma (miért kockázatos, 1-2 mondat).
3. Javasolt új szöveg vagy konkrét változtatás.
4. Fallback pozíció, ha a másik fél elutasítja (mit engedhetünk el kényelmetlenség nélkül).

### 5. Tárgyalási stratégia -- mit tarts, mit engedj
- **Mindig tarts:** felelősség-szimmetria elve, IP a mi munkánkra, adatvédelmi minimum (DPA megléte).
- **Engedhető, ha ellentételezett:** hosszabb fizetési határidő, kisebb SLA-credit, rövidebb konfidencialitási túlélési idő.
- **Sosem engedd:** korlátlan felelősség, kizárólagosság ellenszolgáltatás nélkül, a mi ügyfél-adatunk másik fél tulajdonába kerülése.

## Kimenet
1. Klauzula-leltár táblázat kockázati szinttel.
2. Redline-lista a fenti formátumban, csak unfavorable/dealbreaker klauzulákra.
3. Tárgyalási összefoglaló: mit kérjünk elsőként, mi a fallback, mi az abszolút határ.
4. Nyitott kérdések, amik humán ügyvédet igényelnek.

## Buktatók
- Ne "javíts" piaci-standard klauzulát csak mert szokatlanul hangzik -- csak a valós kockázatot jelöld.
- Egy dealbreaker-klauzula elsiklása (pl. korlátlan felelősség egy alárendelt bekezdésben) nagyobb kár, mint tíz apró stiláris észrevétel -- súlyozz kockázat szerint, ne mennyiség szerint.
- Ne állíts jogi bizonyosságot piaci benchmarkról -- ez tájékozódási pont, nem szabvány.

## Ellenőrzés
- A disclaimer szerepel.
- Minden érdemi klauzula be van sorolva (favorable/neutral/unfavorable/dealbreaker).
- Minden unfavorable/dealbreaker klauzulához van konkrét redline-javaslat és fallback.
- A tárgyalási összefoglaló egyértelmű prioritási sorrendet ad.

## GitHub-first döntés (Peti szabály 2026-07-12)
Kész, karbantartott contract-review Claude-skill létezik nyílt forráson (pl. CUAD-alapú risk-detection, 14-skill jogi csomagok), de ezek kis, nemrég indult személyes repók bizonytalan licenc/karbantartási előélettel -- kód-szintű átvétel helyett a bennük leírt DOMÉN-keretrendszert (klauzula-taxonómia, kockázati skála, redline-formátum) adaptáltam saját megfogalmazásban. Döntés: **adapt**, nem adopt -- ha később egy konkrét repó due diligence-e (licenc, karbantartottság, biztonság) megfelel, code-szintű integráció megfontolható.

## Források
- https://github.com/evolsb/claude-legal-skill (CUAD risk-detection benchmark, F1 ~0.62 clause extraction -- kontextus az AI-alapú review megbízhatósági határairól)
- https://github.com/zubair-trabzada/ai-legal-claude (contract review / risk analysis / negotiation strategy skill-struktúra)
- https://github.com/anthropics/claude-for-legal (hivatalos Anthropic legal plugin-csomag, commercial-legal:review)
