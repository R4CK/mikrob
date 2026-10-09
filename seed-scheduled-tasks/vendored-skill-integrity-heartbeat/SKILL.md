---
name: vendored-skill-integrity-heartbeat
description: 6 orankent lefuttatja a store/vendored-skill-integrity.py-t, hogy egy vendorolt skill helyi, nem-sanctioned modositasa ne maradjon csendben eszrevetlen (kartya 14216622, Cybered kovetkezmeny a da47b612-n). Csak akkor ir Telegramra, ha a script ALERT:yes verdiktet ad.
---

Futtasd le: python3 {{INSTALL_DIR}}/store/vendored-skill-integrity.py --quiet

MIERT FUT EZ (kartya 14216622, Cybered MEDIUM kovetkezmeny a da47b612-n). A da47b612 secret-gate
kivetele (ket JWT-alaku helyorzo a testing-api-for-broken-object-level-authorization vendorolt
SKILL.md-ben) kompenzalo kontrollkent eppen ezt a szkriptet nevezte meg: "egy kesobbi helyi
modositas (valodi titok is) ott jelez". Csakhogy semmi nem futtatta rendszeresen -- se ez a feladat
nem letezett, se fleet-test, se CI, kizarolag a sajat --selftest-je fixturan. A kompenzalo kontroll
tehat csak papiron allt.

## A DONTEST A SCRIPT HOZZA

A kimenet UTOLSO sora egy verdikt, pontosan ugyanaz a konvencio mint az
agent-skill-drift-sync-heartbeat-nel:

- `ALERT:no unsanctioned=0` -> **MARADJ CSENDBEN.** Ne irj Telegramra. Ez a rutin eset.
- `ALERT:yes unsanctioned=N` -> kuldj EGY rovid Telegram uzenetet Petinek (reply tool, chat_id
  {{CHAT_ID}}, MarkdownV2, `Flotta:` projekt-taggel).

## Ha ALERT:yes, mit irj

A kimenetben a `UNVERIFIABLE` es `UNSANCTIONED DELTA` blokkok soroljak fel, melyik vendorolt
konyvtar erintett. Ket eset van, es kulonbozik mit kell tenned:

- **UNVERIFIABLE** (hianyzo watch clone, vagy `git archive` hiba) -- ez infrastruktura-hiba, nem
  tamper: a watch-clone konyvtar hianyzik vagy serult. Jelezd, ne probald magad helyben javitani.
- **UNSANCTIONED DELTA** -- egy vendorolt fajl tartalma eltert a pinnelt upstream commithoz kepest,
  es ez NINCS a `store/vendored-skill-sanctioned.json` bazisvonalban. Ket alapvetoen kulonbozo ok
  lehet mogotte: (a) egy korabban mar eldontott, dokumentalt lokalis adaptacio (lasd a VENDORED.md
  sajat FORK NOTE-jat, ha van), amit csak elfelejtettek `--record`-dal rogziteni -- ilyenkor
  JAVASOLD Petinek/MikroB-nak az ujra-rogzitest, de NE futtasd `--record`-ot magad, az egy dontes;
  (b) egy valodi, eddig eszre nem vett modositas (akar titok is) -- ilyenkor ez biztonsagi lelet,
  escalald Cybered/Cybersec fele, ne intezkedj felette egyedul.

Ne fuss le a fo {{MAIN_AGENT_ID}} session helyett kulon dispatch-csal, ez sajat onallo futtatas,
nincs kanban-kartya-kotes, nem kell hozza inter-agent uzenet.
