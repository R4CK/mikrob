# Beragadás-történet (`stuck_incidents`)

> Kártyacsalád: `f92671df` (fázis) → `ac28bc6e` (1/4, séma) → `878cd292` (2/4, író) → `d05d72b3`
> (3/4, feloldás-detektálás) → `a2c452ff` (4/4, lekérdezés + ez a doksi).

## Hol él az adat

Egyetlen tábla: `stuck_incidents` (séma: `src/db.ts`, `initDatabase()`). Egy sor egy **beragadás-
incidenst** ír le: mikor detektálta a rendszer, mit döntött róla, és (ha van) mikor és mi oldotta
fel. A tábla **append-only**: a detekciós tények (`card_id`, `detected_at`, `stalled_ms_at_detection`,
`action`) egy `BEFORE UPDATE` trigger által védettek, és egy `BEFORE DELETE` trigger tiltja a sor
törlését. A pontos, mért határok (mit NEM véd a trigger, és miért maradt szándékosan nyitva az
`INSERT OR REPLACE` reziduál) a séma DDL-je feletti kommentben vannak dokumentálva -- ott, nem itt,
hogy egyetlen forrás legyen a mechanizmus tényleges garanciáira.

## A `action` oszlop lehetséges értékei

| `action` | Mit jelent | Ki írja |
|---|---|---|
| `redispatch` | A guard ALLOW-ot adott -- a kártyát újra megbökték. | `redispatch-guard.sh check` (878cd292) |
| `none_denied` | A guard DENY-t adott VALAMI okból (`action_detail` mondja meg pontosan melyikből -- pl. `DENY:agent-busy`, `DENY:backoff(1200s)`). Egy szándékos nem-cselekvés, ami így nyomot hagy. | ugyanaz |
| `none_other` | A guard nem tudta kiértékelni a helyzetet (ma: `DENY:ledger-busy` -- másik folyamat tartotta a lockot). Se nem döntés, se nem hívási hiba. | ugyanaz |
| `sibling_handover` | MikroB a heartbeat D szekcióban egy beragadt kártyát a felelős ügynök testvérére ruházott át (3a. munkavégzési szabály), a sima `reset` helyett. | `redispatch-guard.sh sibling-handover` (878cd292 utólagos kiegészítése) |

Amit a tábla **nem** tárol sorként: `DENY:usage` és `DENY:card-not-found` -- ezek HÍVÁSI HIBÁK (rossz
paraméterezés, nem létező kártya), nem döntések egy kártyáról. Beszámítanák magukat "hányszor döntött
úgy a rendszer, hogy nem avatkozik be" kérdésbe, ami hamis adatot adna.

## A ledger és a történet SZÁNDÉKOSAN külön van

`store/redispatch-ledger.json` (a guard saját állapota) és `stuck_incidents` **két különböző
kérdésre válaszolnak**, és összevonásuk elrontaná mindkettőt:

- **A ledger egy ÉLŐ KONTROLL**: a guard backoff/cap-budgetje kártyánként (hány újrabökés történt,
  mikor volt az utolsó). `redispatch-guard.sh reset <cardId>` (a 4. munkavégzési szabály szerint
  minden kártya-zárásnál kötelező) **törli** a bejegyzést -- ez a HELYES viselkedés a ledger
  szempontjából: ha nem törölné, egy egyszer beragadt kártya örökre a sapkán ülne, és a guard sosem
  engedélyezne rá újabb újrabökést.
- **A `stuck_incidents` egy TÖRTÉNET**: minden beragadás-incidens megmarad, feloldva vagy sem, azért
  hogy a "mikor ragadt be, mennyi ideig, mi oldotta fel, hányszor ismétlődött" kérdések egyáltalán
  megválaszolhatók legyenek.

Ha a kettő egy táblát/fájlt osztana meg: a `reset` hívás (ami a ledgernek KELL, hogy törölje az
állapotot) pontosan azt a pillanatot törölné a történetből, amikor az incidens véget ért -- a
kontroll és a napló ugyanazon az adaton veszekedne. A `kanban_card_events` / `kanban_card_field_events`
szétválasztás (élő audit vs. történet) ugyanezen okból külön tábla két helyen ebben a kódbázisban;
ez a harmadik.

## Feloldás-detektálás: nincs külön "resolve" hívás

`resolved_at`/`resolved_by_event_id`/`resolved_by_event_table` nem egy új explicit írási úton
töltődik ki -- az visszahozná pontosan azt a "elfelejthető prompt-lépés" problémát, amit a
detekció-oldali (878cd292) író megszüntetett. Ehelyett `maybeResolveStuckIncident()` (`src/db.ts`)
BE VAN DRÓTOZVA a MÁR MEGLÉVŐ írási utakba:

- `updateKanbanCard` / `moveKanbanCard` egy `kanban_card_events` sort ír, amikor a kártya
  `in_progress`-ből `waiting`-be vagy `done`-ba lép -- ez az EGYIK minősítő esemény.
- `updateKanbanCard`-on belül `recordKanbanFieldChanges` egy `kanban_card_field_events` sort ír,
  amikor a `title` (a `[NN%]` haladásjelző) vagy az `assignee` változik -- ez a MÁSIK.

Az első ilyen esemény, ami a detekció UTÁN történik, feloldja az incidenst: `resolved_at` az esemény
időbélyege, `resolved_by_event_id` + `resolved_by_event_table` az esemény azonosítója ÉS a tábla neve
(mindkettő kell -- a két esemény-tábla saját, független autoincrement id-teret használ, tehát egy
csupasz szám önmagában nem mondja meg, melyik táblában keresd). Race-safe és idempotens a
`WHERE resolved_at IS NULL AND detected_at < ?` feltétel miatt: egy második minősítő esemény
ugyanarra a kártyára egyszerűen no-op.

**Kimondott korlát:** a `src/web/fleet-transfer.ts` föderációs bulk-importja (történelmi replay egy
másik rendszerből) NEM váltja ki a feloldás-detektálást -- importált régi eseményekhez nem
rekonstruálódik visszamenőleg a feloldás. Ez egy tudatos, dokumentált határ, nem hiányzó eset.

## Lekérdezés: a négy kérdés egy hívással

`GET /api/stuck-incidents?cardId=<id>&agent=<név>` (mindkét szűrő opcionális, kombinálhatók;
`Authorization: Bearer <store/.dashboard-token>` szükséges, mint minden `/api/*` végponthoz).

```json
{
  "incidents": [
    {
      "id": 12, "cardId": "878cd292", "assignee": "backend3",
      "detectedAt": 1788700000, "action": "none_denied", "actionDetail": "DENY:agent-busy",
      "detections": 3, "resolvedAt": 1788703600, "durationSeconds": 3600, "ongoing": false,
      "resolution": { "table": "kanban_card_events", "eventId": 501, "description": "status: in_progress -> done" }
    }
  ],
  "repeatCountForCard": 2,
  "repeatCountForAgent": 5
}
```

- **Mikor ragadt be** -> `incidents[].detectedAt`.
- **Mennyi ideig** -> `incidents[].durationSeconds` (`resolvedAt - detectedAt`, vagy -- ha az
  incidens még nyitva van, `ongoing: true` -- a hívás pillanatáig eltelt idő; SOSE egy külön tárolt
  oszlopból, mindig a két meglévő időbélyegből számolva).
- **Mi oldotta fel** -> `incidents[].resolution` (`null`, ha még nyitva van; `description` a
  feloldó esemény SAJÁT oszlopaiból építve -- egy törölt/nem létező cél-sorra `description: null`,
  sose dobott hiba).
- **Hányszor ismétlődött** -> `repeatCountForCard` (ugyanaz a KÁRTYA, függetlenül attól, hogy adtál-e
  `agent` szűrőt is) és `repeatCountForAgent` (ugyanaz az ÜGYNÖK, az összes kártyáján, függetlenül a
  `cardId` szűrőtől). A két számláló szándékosan FÜGGETLEN a másik szűrőtől -- "hányszor ragadt be ez
  a kártya" nem szűkülhet csendben "...amíg épp ennél az ügynöknél volt"-ra.

`incidents` maga MINDKÉT megadott szűrőt alkalmazza egyszerre (ha mindkettő meg van adva), csak a két
`repeatCount*` mező néz külön-külön.
