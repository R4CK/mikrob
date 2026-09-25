---
name: agent-skill-drift-sync-heartbeat
description: 6 orankent lefuttatja a store/agent-skill-drift-sync.sh --apply-t, hogy egy elo agent sajat .claude/skills/<nev>/SKILL.md masolata ne maradjon csendben elavult egy seed-skills fixe utan (kartya 13512bde, Cybersec kovetkezmenye a 84b304c1-hez). Csak akkor ir Telegramra, ha a script ALERT:yes verdiktet ad.
---

Futtasd le: bash {{INSTALL_DIR}}/store/agent-skill-drift-sync.sh --apply --telegram

A tool sajat biztonsagi logikaja garantalja, hogy soha nem irja felul csendben egy szandekosan elteroen (diverged) modositott elo skill-masolatot -- kizarolag a bizonyithatoan csak-elavult (stale, byte-azonos egy korabban kiadott verzioval) masolatokat szinkronizalja --apply alatt. Ezert biztonsagos itt kozvetlenul --apply-jal futtatni, nincs szukseg elozetes dry-run jovahagyasra.

A script MASODIK ellenorzest is fut: klon-csaladon (backend<->backend2<->backend3, qa<->qa2, fron-ted<->fron-teddy) belul HIANYZO skilleket is keres, nem csak elavult tartalmat (kartya a6abb230, Peti panasz 2026-09-18 -- a gyoker-ok az volt, hogy a seed-fleet-agents/<klon> forrasok maguk is elavultak/hianyosak voltak). Ez is --apply alatt additivan potolja a hianyt (sosem ir felul meglevo konyvtart), ugyanazzal a futo-agent-fail-closed vedelemmel mint a stale-szinkron.

**KARANTEN-MEGKERULES JAVITVA (kartya 85521c7e, Cybersec lelet a6abb230-on, 2026-09-25):** a hianyzo-skill masolas FORRASA korabban egy testver ELO, gitignore-olt .claude/skills/ konyvtara volt, NEM a kovetett seed -- egy git-ben nem szereplo skill (pl. curl|sh-t kero install-utasitas, vagy a skill-mappabol KIFELE mutato symlink) igy --apply alatt at tudott terjedni a teljes klon-csaladra, megkerulve a CLAUDE.md skill-karanten szabalyat. Merve elesben: pontosan ez tortent egy futason. Ket lepesben javitva: F1 (azonnali stopgap) ideiglenesen dry-run-ra kenyszeritette a hianyzo-skill agat; F2 (a tenyleges javitas) a masolas forrasat `seed-fleet-agents/<klon>`-ra allitotta (kovetett, reviewelt masolat -- egy csak-ELO-ben letezo, seedbe nem kerult skill mostantol RIPORT, sose masolat), es minden masolast megtagad, ha a forras egy, a sajat konyvtarabol KIFELE mutato symlinket tartalmaz (meg a kovetett seedbol is). A hianyzo-skill ag ISMET aktivan masol --apply alatt, a fenti ket vedelemmel.

## A DONTEST A SCRIPT HOZZA, NE SZAMOLGASS

A kimenet UTOLSO sora egy verdikt. **Kizarolag ezt nezd, ne a darabszamokat:**

- `ALERT:no ...` -> **MARADJ CSENDBEN.** Ne irj Telegramra. Ez a rutin eset.
- `ALERT:yes reasons=... ...` -> kuldj EGY rovid Telegram uzenetet Petinek (reply tool, chat_id {{CHAT_ID}}, MarkdownV2, `Flotta:` projekt-taggel).

MIERT IGY (kartya 222fdc5e, Cybersec MEDIUM lelete a 13512bde-n). Ez a feladat korabban azt a szabalyt kapta, hogy `stale=0 ES diverged=0` eseten hallgasson. Az elo allandosult allapot viszont **merten** `current=93 stale=0 diverged=5` -- vagyis a RUTIN eset maga is `diverged>0`, tehat a feladat ugyanazt az ot sort kuldte hatoraankent, naponta negyszer, orokre. A diverged halmaz jogosan allando (QA sajat 84b304c1-es verdiktje: azok szandekos, ertekes helyi bovitesek, nem hibak). Ket het utan senki nem olvassa -- es akkor sem, amikor vegre valtozik. A hir tehat nem az, hogy VAN diverged, hanem hogy MEGVALTOZOTT a halmaz; ezt a script maga tartja szamon egy allapot-fajlban (`store/agent-skill-drift-state.json`), es a darabszam helyett a HALMAZT hasonlitja (egy darabszam nem lat egy cseret, ahol egy bejegyzes eltunik es egy masik megjelenik).

## Ha ALERT:yes, mit irj

A `reasons=` mezo mondja meg, mirol szol az uzenet. Ird meg roviden, ne masold be a teljes kimenetet:

- `stale-synced` -- tenylegesen szinkronizalt elavult masolatokat: soroljad fel az agent/skill parokat.
- `diverged-set-changed` -- a script kiirja a `diverged set was:` es `diverged set now:` sorokat. Az UJ vagy ELTUNT tetelekrol irj, ne a teljes listat ismeteld. A diverged nem automatikusan hiba (lehet szandekos runtime-patch, lasd a CLAUDE.md "Skill patch" konvenciojat) -- csak jelezd, NE intezkedj felette, MikroB vagy Peti dontsenek.
- `concurrent-write-skipped` -- egy elo skill-fajl konkurrens irassal utkozott a sync alatt; emeld ki, erdemes ujra futni legkozelebb.
- `no-baseline` -- ez az elso futas az allapot-fajl ota. Egyszeri, EGY sorban emlitsd meg, ne reszletezd.
- `baseline-unreadable` -- az allapot-fajl serult. A script szandekosan riaszt ilyenkor ahelyett hogy csendben "nincs alapvonal"-ra esne vissza: jelezd, mert ez azt jelenti, hogy egy valtozast eppen NEM tudtunk osszehasonlitani.
- `no-agents-dir` -- a script SEMMIT nem vizsgalt meg. Ez a legkomolyabb eset: nem "tiszta", hanem "nem futott le rendesen". Jelezd hibakent.
- `missing-synced` -- egy klon-csaladon beluli hianyzo skillt potolt egy testver masolatabol: a `missing set:` blokk sorolja fel az agent/skill parokat, azt is megmondja szinkronizalt-e vagy futo-agent miatt kimaradt. Soroljad fel roviden, ugyanugy mint a stale-synced esetet.
- `missing-running-agent-skipped` / `missing-undetermined-agent-skipped` -- ugyanaz a fail-closed logika mint a `running-agent-skipped`/`undetermined-agent-skipped` eseten, csak a hiany-potlasra: a cel-agent fut (vagy nem allapithato meg), ezert a masolas kimaradt, a kovetkezo futas ujraprobalja. Emeld ki, ne intezkedj felette.

Ne fuss le a fo {{MAIN_AGENT_ID}} session helyett kulon dispatch-csal, ez sajat onallo futtatas, nincs kanban-kartya-kotes, nem kell hozza inter-agent uzenet.
