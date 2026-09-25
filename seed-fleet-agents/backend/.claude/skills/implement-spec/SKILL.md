---
name: implement-spec
description: Implement a large specification (a Fázis kanban card with its Feladat/alfeladat children) by fanning out parallel background subagents, each in its own ephemeral worktree when file-disjoint, merging results back into your own agent branch, then running the normal gate flow. Use when a Fázis has multiple independent, unblocked child cards ready at once (the "frontier") and you want to build several in parallel instead of one at a time. Adapted from mattpocock/skills' implement-spec (GitHub PR model) to this fleet's single-branch-per-agent + kanban + gate model.
---

# Implement Spec

## Mikor használd

Egy Fázis kártyának 2+ FÜGGETLEN, dispatchelhető (nem blokkolt) Feladat/alfeladat gyereke van egyszerre — a "frontier". Ahelyett hogy egyesével, szekvenciálisan építenéd őket, ezzel a skillel párhuzamosan futtathatod a függetleneket.

NE használd: ha a Fázis gyerekei szekvenciálisan blokkolják egymást (mindig csak 1 dispatchelhető van), vagy ha bizonytalan vagy a fájl-átfedésben — akkor szekvenciális építés a biztonságos alapértelmezés.

## Miért más ez, mint az upstream verzió

Az eredeti (mattpocock/skills) GitHub PR-munkafolyamatra épül: ticketenkénti branch, draft PR, merger subagent. Ez a flotta más modellt használ: EGY közös ág ügynökönként (`agent/<neved>/work`), kanban-kártyák ticketként, és egy landoló script (`cleancore-land.sh` / `marveen-land.sh`) ami gate-elt SHA-t vár és maga ellenőrzi a merge-et mindkét irányban.

A kulcs-kockázat, amit ez a skill kizár: két subagent, ami UGYANAZT a fájlt szerkeszti egy megosztott worktree-ben, csendben felülírhatja egymást (élő, reprodukált incidens ezen a flottán, lásd `branch-switch-on-a-shared-tree-races-plain-file-io` és `dc185b52` memória). Ezért a párhuzamosítás feltétele a fájl-diszjunktság, nem a ticket-függetlenség önmagában.

## Eljárás

1. **Olvasd be a Fázis-t és gyerekeit.** `curl` a kanbanra, gyűjtsd össze a Fázis (parent_id) ALÁ tartozó Feladat/alfeladat kártyákat és állapotukat.

2. **Határozd meg a frontier-t.** Azok a gyerek-kártyák, amik `planned` és NINCS blokkoló komment/cím rajtuk (nincs `BLOKKOLT-*` prefix), és a `parent_id`-ból nincs még nyitott, rájuk mutató blokkoló testvér.

3. **Fájl-scope becslés minden frontier-ticketre, MIELŐTT bármit párhuzamosítanál.** Minden ticket leírásából/címéből azonosítsd, mely fájlokat/modulokat érinti valószínűleg (ha nem egyértelmű a leírásból, egy gyors grep/Explore-kereséssel deríts rá — ez OLCSÓ, a hibás párhuzamosítás DRÁGA). Két ticket csak akkor mehet egyszerre, ha a becsült fájlhalmazuk DISZJUNKT. Ha bizonytalan vagy akár egyetlen fájl átfedésében is, tedd őket egymás után, ne egyszerre.
   - Kivétel, ami NEM számít átfedésnek: mindkettő csak OLVASSA ugyanazt a fájlt (nem írja). Az igazi kockázat az egyidejű ÍRÁS.
   - Megosztott append-only fájlok (DECISIONS.md, README.md egyes szakaszai) MINDIG átfedésnek számítanak commit-időben, de ez NEM tiltja a párhuzamos munkát — csak azt jelenti, hogy a merge-lépésnél (7. lépés) union-olni kell őket, nem szó szerint másolni. Ez a szokásos landolási tapasztalat (lásd Fron Ted 949c5dce merge-e), nem hiba.

4. **Diszjunkt csoportokra bontva, indíts Agent tool subagenteket `isolation: "worktree"`-vel, PÁRHUZAMOSAN egy üzenetben.** Minden subagent egy ticketet kap, a teljes kártya-szöveget + a Fázis kontextusát a promptban (a subagent nem ismeri az előzményedet). Explicit mondd ki a promptban: "dolgozz csak a <fájl/modul>-ban, semmi máshoz ne nyúlj". A subagent a saját worktree-ágán commitol, NEM landol, NEM zár kártyát.
   - Kutatás/exploráció jellegű alfeladatokhoz (nincs fájlírás) subagent isolation NÉLKÜL is mehet, azok sosem ütköznek.
   - Diszjunkt csoportok közötti sorrend nem számít; egy csoporton belül (átfedő ticketek) szekvenciális maradsz.

5. **Minden subagent visszatérése után olvasd el az eredményét (path + branch a tool-válaszban).** Ne higgy vakon a subagent "kész" állításának — nézd meg a diffet te magad, mielőtt beolvasztod (lásd `tmux-pane-narrative-is-not-completion-proof` és a testing-traps memória-témát: egy subagent zöld tesztje sem bizonyíték egyedül).

6. **Olvaszd be mindegyik eredményt a SAJÁT ágadba, egyesével, szekvenciálisan (még ha a build párhuzamos is volt).** `git merge --no-ff <subagent-branch>` a saját worktree-dben, egyenként. Ha konfliktus van (jellemzően DECISIONS.md/README.md), old fel unionnal (mindkét oldal új sorai megmaradnak), ahogy a szokásos landolási gyakorlat diktálja. Futtasd a típusellenőrzést/tesztet MINDEN egyes beolvasztás után, ne csak a végén — így egy hibás merge azonnal, nem az ötödik után derül ki.

7. **A Fázis child-kártyáit a szokásos módon zárd:** minden beolvasztott ticket kártyáját tedd `waiting`+REVIEW-ra a saját, normál módon (Gate-SHA a te saját ágad commitjára mutasson, NEM a subagent worktree-jének elszigetelt ágára — a subagent munkája a te ágadba olvadt, onnantól a te commitod felel érte).

8. **Amikor minden ticket landolt/gate-elt, a Fázis-kártyát MikroB zárja** (5. munkavégzési szabály: minden gyerek `done` → szülő auto-close).

## Buktatók

- **Ne párhuzamosíts fájl-átfedő ticketeket "majd figyelek rá" alapon.** A memória tele van pontosan ezzel a hibaosztállyal (konkurens Read/Edit/Write ugyanarra a fájlra, csendes adatvesztés). Ha bizonytalan, szekvenciális.
- **A subagent worktree-je NEM landolási cél.** Csak a te saját ágad landol (`cleancore-land.sh`/`marveen-land.sh`), a subagent munkája oda kerül BE, nem külön.
- **Ne bízz a subagent önjelentésében gate-döntésnél.** A te saját olvasásod/tesztfuttatásod a bizonyíték, nem a subagent szövege.
- **A landolás/gate a te saját sessiónod egy pontja marad, nem párhuzamosítható** — egyszerre csak egy ág landol egy repóra nézve (lásd a shared-checkout git szabályokat).

## Ellenőrzés

- Minden párhuzamosított ticket-pár file-scope-ja ténylegesen diszjunkt volt (utólag is ellenőrizhető: `git diff --name-only` a két branch-en, nincs metszet).
- Minden beolvasztás után futott típusellenőrzés/teszt, nem csak a legvégén.
- A Fázis minden gyereke a szokásos Gate-SHA/REVIEW/waiting konvenciót követi lezáráskor, még ha a build maga párhuzamos volt is.
