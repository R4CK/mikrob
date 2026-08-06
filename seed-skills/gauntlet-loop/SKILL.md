---
name: gauntlet-loop
description: Run a build-measure-criticize-improve loop that judges output BLIND against a concrete reference bar and re-dispatches the biggest gap until it passes. Use for ambitious "make it triple-A / match this reference" work where quality is judged by comparison, not just tests -- design builds, feature parity vs a target, "make it as good as X". Wraps the fleet's own gates + loop-engineering. Triggers on "gauntlet loop", "gauntlet", "match this reference", "blind compare", "make it AAA", "iterate until it beats the reference", "hasonlítsd a referenciához".
---
# Gauntlet Loop

Matt Shumer-féle multi-agent minta (Claude Code + Opus 5). A prompt nem ad ÚJ képességet -- STRUKTÚRÁT ad, ami újra és újra ráveszi a modellt, hogy a meglévő képességét a végsőkig hajtsa. A fleet meglévő szabályaira (project-workflow gate-ek, loop-engineering) ül rá; ez a distilláció a KÉT új elemet emeli be, amit a sima gate-folyamat nem tartalmaz: (1) BLIND összehasonlítás egy KONKRÉT referencia-etalonhoz, (2) záró INTEGRÁCIÓS pass.

## Mikor használd
- A cél "AAA/triple-A", vagy "legyen olyan jó mint <konkrét referencia>", vagy "érd el ezt a minőségi szintet" -- ahol a minőséget ÖSSZEHASONLÍTÁS dönti el, nem csak zöld teszt.
- Van (vagy generálható) KONKRÉT etalon: screenshot, referencia-oldal, jóváhagyott design, mintakimenet, spec-példa. Etalon nélkül ne indítsd -- előbb szerezz/generálj egyet.
- Hosszú, felügyelet nélkül futó minőség-hajsza (design build, feature-paritás, játék/UI polish).
- NE használd tiszta pass/fail determinisztikus feladatra (arra sima teszt-loop elég), sem etalon nélküli nyílt kutatásra.

## A hét lépés (a lead ügynök = MikroB orchestrálja)
1. **Cél + referencia-sáv befogadása.** A lead megkapja az ambiciózus célt ÉS a konkrét minőség-etalont (a "bar"). Ha nincs etalon: generálj/keress egyet (pl. `frontend-design-research` awwwards referencia, jóváhagyott mockup, mintakimenet) MIELŐTT loopolsz.
2. **Dekompozíció.** A lead a munkát a legkisebb ÖNÁLLÓAN építhető ÉS önállóan ítélhető darabokra bontja (project-workflow 1. szabály: Fázis->Feladat->alfeladat->lépés). Eldönti mi megy párhuzamosan, mi szekvenciálisan.
3. **Builder kiosztás.** Külön builder ügynökök (role-agentek) építik a darabokat. Megkapják a specet + a darab-feladatot, de NEM a kritikus szerepét.
4. **Friss-kontextusú kritika.** KÜLÖN sub-ügynök (a builder munkáját NEM látta belülről) nézi meg -- a valós artefakthoz, a referenciához és a spechez fér hozzá, de a builder indoklásaihoz/döntéseihez NEM. (A fleet gate-jei: QA/Cybersec/Cybered -- a szerző sosem ítéli a sajátját, 4. szabály.)
5. **Blind összehasonlítás.** A kritikus a kimenetet ÉS a referenciát EGYMÁS MELLETT, vakon hasonlítja (melyik melyik nélkül), hogy csökkentse a jóváhagyási torzítást és OBJEKTÍVEN felszínre hozza a LEGNAGYOBB eltérést. Ez az új elem a sima gate-hez képest: nem csak "megfelel-e", hanem "veri-e a referenciát".
6. **Pass/fail re-dispatch.** Ha a kimenet VESZÍT az összevetésben: a kritikus megnevezi a LEGNAGYOBB értelmes eltérést és visszaadja a buildernek javításra (project-workflow 4a: azonnal `in_progress` + re-dispatch a bug/gap-jelentéssel). Ha nyer: a darab továbblép.
7. **Iteráció + stop.** A ciklus ismétlődik amíg: a siker-kritérium teljesül, VAGY a javulás túl kicsi a költséghez, VAGY egy határ tüzel (idő/token/próbálkozás-cap). A stop-szabályok KÖTELEZŐK (loop-engineering: success ÉS failure ÉS hard cap).
8. **Integrációs pass.** Egy ZÁRÓ friss ügynök az EGÉSZ artefaktot nézi: konzisztencia, korrektség, illeszkedés az eredeti célhoz -- kisimítja a függetlenül javított darabok közti ütközéseket. (project-workflow 5: fázis-auto-close ELŐTT ez a végső egész-ellenőrzés.)

## Loop-engineering keret (a Gauntlet a PROMPT-minta; ez a RENDSZER-fegyelem)
A 8 lépést a fleet meglévő infrastruktúrája teszi megbízhatóvá -- ne építs újat, kösd rá:
- **Trigger/ütemezés:** scheduled-tasks (dashboard scheduler), inbound Peti-üzenet, orchestrator-tick.
- **Perzisztens memória:** kanban `[NN%]` + memória-tierek + napi napló (nem context-only -- compaction/crash túléli).
- **Eszköz/megfigyelés:** teszt, log, screenshot, metrika visszacsatolva (a "measure" valós, nem vélemény).
- **Budget-határok:** 5 órás + heti kvóta-cap, token/próbálkozás-cap (loop-engineering stop-szabály).
- **Eszkaláció:** ismételt bukás / hiányzó etalon / bizonytalanság -> Peti (Telegram).
- **Verifikáció:** a gate-ek (QA/Cybersec/Cybered) + a blind-compare a truth-source; a puszta zöld teszt NEM elég bizonyíték.

## Buktatók
- **Etalon nélkül nincs Gauntlet.** A blind-compare a lényeg; referencia-sáv nélkül visszaesik sima gate-re. Előbb szerezz etalont.
- **A kritikus NE lássa a builder indoklását** -- különben átveszi a torzítást. Friss kontextus kötelező (a fleet gate-modellje már ezt csinálja).
- **A legnagyobb EGY eltérésre fókuszálj re-dispatchkor**, ne szórd szét 10 apró javításra -- gyorsabb konvergencia.
- **Az integrációs pass nem kihagyható:** a függetlenül javított darabok ütköznek; a végső egész-ellenőrzés fogja meg.
- **Stop-szabály nélkül runaway + kvótaégés.** Mindig success + failure + hard cap.

## Ellenőrzés
- Volt konkrét referencia-etalon, és a kritika VAKON hasonlított hozzá.
- A szerző egyik gate-en sem ítélte a sajátját.
- Volt záró integrációs pass az egész artefaktra.
- A loop mind a három stop-ágat definiálta (success/failure/cap), és a haladás kanban `[NN%]`-ben követhető.
