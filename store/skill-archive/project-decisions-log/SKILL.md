---
name: project-decisions-log
description: Maintain a per-project, git-tracked, grep-able DECISIONS.md that captures every significant decision/conversation outcome (business decisions, architecture choices, approvals/rejections) with date + reason + reference. Periodically distills the oldest entries into a dated archive so the live file stays short. Use whenever a real decision is made (Peti approval/rejection, MikroB plan-grilling verdict, architecture choice), and periodically to check if distillation is due. Triggers "decisions log", "döntésnapló", "DECISIONS.md", "distill decisions".
---

# Project decisions log

## Mikor használd

- Amikor egy ÉRDEMI döntés születik: Peti jóváhagyás/elutasítás, MikroB plan-grilling verdikt, architektúra-választás, "legyen X" / "maradjon így" típusú válasz. A kanban-kártya kommentje NEM elég önmagában (SQLite-ban van, nem grep-elhető a repóban) -- ugyanaz a döntés a projekt gyökerének `DECISIONS.md`-jébe is bekerül.
- Amikor egy projekt `DECISIONS.md`-je egy küszöb fölé nő (lásd Desztillálás lent).
- Amikor Peti vagy bárki a "mi történt eddig ezzel a projekttel" kérdést teszi fel -- ez a fájl az elsődleges, grep-elhető forrás, nem a memória-visszakeresés.

## Fájlformátum

Minden projekt gyökerében (nem a `store/`-ban, a repó tetején, git-trackelt): `DECISIONS.md`.

Append-only. Minden bejegyzés:

```markdown
## YYYY-MM-DD HH:MM -- <rövid cím>

**Döntés:** <mi dőlt el, egy-két mondatban, a végeredmény, nem a mérlegelés>
**Miért:** <az indok, a döntéshozó szemszögéből>
**Ki döntött:** Peti | MikroB | <ügynök neve> (plan-grilling verdikt esetén nevezd meg)
**Hivatkozás:** kártya-ID(k), commit-sha, vagy mindkettő
```

Új bejegyzés MINDIG a fájl VÉGÉRE kerül (kronologikus, nem visszafelé) -- ez teszi lehetővé, hogy egy egyszerű `tail`/`git log -p` is elég legyen a legutóbbi döntésekhez, és a diff olvasható maradjon.

**Ez EGY KORÁBBI döntés delta-javítására/folytatására is vonatkozik, kivétel nélkül (kártya 375a81c1, mért 2026-09-29: 5 mopsion-landolás bukott egyetlen reggelen, mert a delta-bejegyzés a KAPCSOLÓDÓ korábbi bejegyzés MELLÉ került, nem a fájl végére).** Ha egy bejegyzés egy korábbi döntés folytatása/javítása/pontosítása, az ÚJ bejegyzés akkor is a fájl VÉGÉRE megy -- a kapcsolatot a cím vagy a szöveg mondja ki (`## <dátum> -- <kártya> -- <korábbi cím> masodik delta-javitasa`, vagy "lásd a <dátum>-i <cím> bejegyzést"), SOHA nem a szerkesztő pozíciója a fájlban. Az ok strukturális, nem stílus: két ág, ami UGYANANNAK a korábbi bejegyzésnek a szomszédjába szúr be egyszerre, VALÓDI git-ütközést kap (szomszédos/átfedő hunk), még ha mindkét oldal tiszta hozzáadás is -- a `decisions-append-union.sh` ilyet jogosan nem old fel automatikusan, mert nem az ÖSSZEFŰZÉS a kérdés, hanem hogy MELYIK bejegyzés kerüljön ELŐBBRE, és ezt a döntést a szerkesztő pozíciója hallgatólagosan, ellenőrizhetetlenül hozza meg. A `store/decisions-tail-append-guard.sh` ezt a landolás ELŐTT, a kártya-ágon SZERKEZETILEG ellenőrzi (a merge-base fájlja bájtra pontos előtagja-e a kártya-ág fájljának) -- egy mid-file beszúrás így beszédes hibaüzenettel elutasítódik, mielőtt a landoló script egyáltalán megpróbálná a merge-t.

## Mit NEM ide írj

- Folyamatban lévő munka státusza (az a kanban).
- Kódrészletek, implementációs terv (az a kártya leírása / a kód maga).
- Bármi, ami már dokumentálva van a README "Teljes funkciólista" szekciójában (user story, user flow, FE-státusz) -- az MARAD az egyetlen forrás a funkció-szintű dokumentációra, ezt a fájlt nem duplikáljuk. A `DECISIONS.md` a DÖNTÉSEKRŐL szól, nem a funkciókról.

## Desztillálás (memória hot/warm/cold mintája)

Ha a `DECISIONS.md` egy adott projektben 90 napnál régebbi bejegyzést tartalmaz VAGY 150 sor fölé nő:

1. Vágd le a 90 napnál régebbi (vagy a legrégebbi, amíg a fájl 100 sor alá nem kerül) bejegyzéseket a fájl ELEJÉRŐL.
2. Írd őket egy dátumozott archívum-fájlba: `DECISIONS-ARCHIVE-<ÉÉÉÉ>-Q<negyedév>.md` (pl. `DECISIONS-ARCHIVE-2026-Q3.md`), ugyanazzal a formátummal, hozzáfűzve ha már létezik.
3. A `DECISIONS.md` tetejére (a megmaradt legrégebbi bejegyzés elé) írj egy egysoros jegyzetet: `<!-- Korábbi bejegyzések: lásd DECISIONS-ARCHIVE-<...>.md -->`.
4. Commitold mindkét fájlt egy `docs(decisions): distill entries older than 90 days into archive` típusú commitban.

Ez NEM automatikus scheduled-task alapból -- MikroB vagy egy ügynök akkor futtatja, amikor egy `DECISIONS.md`-t szerkeszt és észreveszi, hogy a küszöb átlépve. Ha egy projekt gyakran nő, érdemes rá dedikált heti scheduled-taskot nyitni (lásd a `dream-engine` mintáját).

## User manual összeállítás

A `user-manual-assembler` skill (külön) a README "Teljes funkciólista" szekciójából állít össze felhasználói kézikönyvet -- ez a `DECISIONS.md`-től FÜGGETLEN lépés, mert a kézikönyv a funkciókról szól (mi hogyan működik MOST), nem a döntések történetéről (miért lett úgy, ahogy lett).

## Buktatók

- Ne írj bele folyamatban lévő vitát/mérlegelést -- csak a LEZÁRT döntést, a végeredménnyel.
- Ha egy döntést később felülírnak (mint a presign-kártya "marad LOW, nem épül" -> "legyen a és b"), ÚJ bejegyzés kerül a végére, a régi NEM törlődik -- a döntéstörténet maga is érték (látszik, hogy változott a helyzet/prioritás).
- SOHA ne szúrj be egy delta/folytatás-bejegyzést a kapcsolódó korábbi bejegyzés MELLÉ, még akkor sem, ha az szerkesztőben "logikusabbnak" tűnik (kártya 375a81c1) -- ez nem stiláris, két párhuzamos ág ugyanoda-szúrása VALÓDI landolási ütközés, amit az auto-union szándékosan nem old fel. A kapcsolatot mindig a cím/szöveg mondja ki, a bejegyzés helye mindig a fájl vége.
