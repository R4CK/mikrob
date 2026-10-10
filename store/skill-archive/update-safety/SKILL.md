---
name: update-safety
description: >
  MikroB rendszerfrissítés (update.sh) biztonsági szabályai és rollback/
  recovery-mechanizmus. Trigger: update.sh futtatása előtt/után, script
  szerkesztése a store/-ban, tracked fájlon lokális módosítás ütközik egy
  bejövő pull-lal, vagy vissza kell állni egy korábbi verzióra.
---

# Rendszerfrissítés update-biztonsága és recovery -- SZABÁLY (Peti 2026-07-05)

A MikroB rendszer az `./update.sh`-val frissül (git `pull --ff-only origin <branch>` + `npm ci`/rebuild + service-restart). Szabályok, hogy egy frissítés SOHA ne akadjon el lokális módosítás miatt, és mindig legyen visszaút:

- **Update-biztos módosítás:** a futó rendszert érintő lokális változtatás ne blokkolja a frissítést. A runtime/lokális adat GITIGNORED helyre megy (`store/`, `.env`, `dist/`) -- ezeket az ff-only pull nem érinti. Követett (tracked) fájlba tett lokális szerkesztés, ami ütközne a bejövő update-tel, TILOS uncommitolva hagyni (az ff-only pull elakad rajta); commitold+pushold a saját branchre, vagy tartsd gitignored/local fájlban. Az `update.sh` az untracked változtatásokat auto-stasheli, de a tracked-uncommitted divergál -- ezt kerüld.
- **Operatív scriptek verziókövetése (KÖTELEZŐ, Peti 2026-07-06):** minden futtatható operatív script (`*.sh`, kód-jellegű `*.py`) VERZIÓKÖVETETT és fel van tolva originra -- akkor is, ha egyébként gitignored runtime-mappában (`store/`) él. Egy javítás, ami CSAK gitignored helyen van, NINCS mentve: nem verziózott, nincs backup, egy fresh checkout / új gép elveszíti. A `store/` adata (DB, tokenek, state JSON) marad ignorált; a scriptekre kivétel van (`store/*` + `!store/*.sh`). Titok SOHA nincs beágyazva a scriptbe (a tokent runtime-ban `cat store/.dashboard-token`-nel olvassa). Egy ilyen script szerkesztése/javítása UGYANABBAN a munkában commit+push (ez az update-biztosság is: az unpushed tracked változás megakasztaná az ff-only pullt). Ha egy fix csak `store/`-ban landolt, told fel a forkba, mielőtt késznek jelented. (Portabilitás: a scriptek most abszolút `/home/neon/marveen` utakat visznek -- egy-deployment OK; több hostnál paraméterezni kell.)
- **Rollback-pont:** az `update.sh` minden frissítéskor rögzíti a frissítés ELŐTTI verziót `store/.update-history`-ba (`update <branch> FROM_SHA TO_SHA`). Ez a recovery célpontja. (store/ gitignored, nem blokkol pullt.)
- **Recovery script:** `./recovery-prev-version.sh` -- visszaáll egy korábbi, működő verzióra (detached checkout + szükség szerint `npm ci`+rebuild + build-marker + service-restart, a `store/` adat érintetlen marad). Használat: `--list` (rollback-pontok), `checkpoint "megjegyzés"` (jelenlegi HEAD known-good jelölése, non-destruktív), `--to <sha>` (adott commit), argumentum nélkül az utolsó update előtti verzió, `--dry-run` (terv, nincs változás), `--yes` (nincs megerősítés). **FIGYELEM:** a valós rollback ÚJRAINDÍTJA a MikroB szolgáltatást (és vele a `mikrob-channels` sessiont) -- ezt Peti futtatja manuálisan, vagy külön ablakból; MikroB magától NE indítson éles rollbackot (megölné a saját sessionjét), csak `--dry-run`/`--list`/`checkpoint`.
