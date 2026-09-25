---
name: user-manual-assembler
description: Assemble a clean, user-facing manual document from a project's README "Teljes funkciólista" section (user story + user flow + FE-status per feature, RBAC-role breakdown), grouped by module/feature, and cross-check that every documented flow has an automated test covering it. Use when Peti or anyone asks for a user manual, when the feature list is updated, or periodically to verify the manual stays in sync with the README source of truth.
---

# User manual assembler

## Cél

A README "Teljes funkciólista" szekciója (kötelező minden git-repós projektnél, lásd CLAUDE.md
"Teljes funkciólista karbantartás" szabály) az EGYETLEN forrás a funkció/user story/user flow
adatra. Ez a skill ebből állít össze egy olvasható, felhasználó-orientált kézikönyvet -- nem
duplikálja a forrást, hanem ÁTFORDÍTJA a fejlesztői "user story + user flow + FE-státusz" formátumot
egy végfelhasználónak szóló, modul/funkció szerint csoportosított dokumentummá.

**Sosem veszítse szem elől a célt:** minden kiadott kézikönyv-szakasznak világosan kell mondania (a)
mi ÉRHETŐ EL ma a projektben (nem mi van tervezve), (b) hogyan ÉRI EL a felhasználó (konkrét
navigációs útvonal, nem elvont leírás), (c) mi a hozzáférés szintje (RBAC-szerep szerint, ha az adott
funkció szerepfüggő).

## Eljárás

1. Olvasd be a projekt README-jét, a "Teljes funkciólista" ÉS a "Szerepkörönkénti user story és user
   flow" szekciót.
2. Csoportosítsd modul/funkció szerint (ne RBAC-szerep szerint elsődlegesen -- a szerep-specifikus
   eltéréseket az adott funkció alszakaszaként mutasd, ahogy a README is teszi).
3. Minden funkcióhoz írd meg:
   - Egy rövid, felhasználóbarát leírás (nem a fejlesztői user story szó szerint, hanem átfogalmazva
     "Ezzel tudod... " stílusban).
   - A pontos user flow lépéssorát (honnan indul, mit kattint, mit lát).
   - Ha `van`/`nincs`/`részleges` a FE-jelölés a forrásban: ez KÖTELEZŐEN átkerül a kézikönyvbe is --
     egy "nincs" vagy "részleges" funkciót NE mutass késznek, jelöld "hamarosan" vagy hagyd ki teljesen
     (Peti döntse el melyiket, kérdezd meg ha nincs korábbi konvenció).
4. **Flow-teszt kereszt-ellenőrzés (Peti szabály 2026-08-20, KÖTELEZŐ):** minden a kézikönyvben
   szereplő flow-hoz keress egy hozzá tartozó automatizált tesztet (e2e/integration/unit -- amelyik a
   projekt teszt-piramisában a flow szintjének megfelel). Grep-eld a teszt-könyvtárat a flow kulcsszavai
   szerint (endpoint név, oldal-komponens név, user story kulcsszó). Ha egy dokumentált flow-hoz NINCS
   találat: jelöld a kézikönyv-generálás kimenetében (`## ⚠️ Teszteletlen flow-k` szekció), NE hallgasd
   el, és nyiss rá kanban-kártyát a felelős QA-nak/tesztelőnek (rule 9 flow-connectivity kiegészítése:
   a kapcsolódás-teljesség MOST a teszt-lefedettséget is jelenti, nem csak a bekötést).
5. Az output egy `docs/USER-MANUAL.md` (vagy honosított `docs/FELHASZNALOI-KEZIKONYV.md`) a projekt
   gyökerében, git-trackelve -- ez maga is a README-forrásból generált, tehát a README a definíciós
   forrás marad, a kézikönyv a levezetett termék.

## Mikor fusson újra

- Minden alkalommal, amikor a README "Teljes funkciólista" szekciója érdemben változik (új funkció,
  FE-státusz-váltás) -- ugyanabban a munkában, definition-of-done részeként (mint a README-karbantartás
  szabály általában).
- Periodikusan (pl. heti scheduled-task, ha a projekt aktívan fejlődik), hogy a "Teszteletlen flow-k"
  szekció ne maradjon el napra-készen tartva akkor sem, ha senki nem indította kézzel.

## Buktatók

- NE fordíts szó szerint fejlesztői zsargont a kézikönyvbe (endpoint-nevek, belső azonosítók) --
  a célközönség a végfelhasználó, nem a fejlesztő.
- Egy funkció, aminek a README szerint `nincs` FE-je, de a kézikönyv mégis kész funkcióként mutatja
  be, hamis elváráskeltés -- ez önmagában hiba a kézikönyv-generálásban, nem csak a forrásban.
- A "minden flow-hoz teszt kell" kereszt-ellenőrzés HAMIS-NEGATÍV lehet, ha a teszt-fájl más
  kulcsszavakat használ mint a user flow leírása -- szélesítsd a keresést (szinonimák, az endpoint
  URL-je, a komponens fájlneve) mielőtt "nincs teszt"-et jelentenél.
