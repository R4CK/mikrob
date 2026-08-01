# Marveen — MikroB fork

![Marveen Banner](banner.png)

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5+Vector-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Anthropic-D97757?logo=anthropic&logoColor=white)](https://claude.ai/code)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed-000000?logo=ollama&logoColor=white)](https://ollama.com/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Slack](https://img.shields.io/badge/Slack-Socket_Mode-4A154B?logo=slack&logoColor=white)](https://api.slack.com/)
[![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)](https://discord.com/developers/docs/intro)

> Önállóan dolgozó AI-ügynökflotta, Claude Code-ra építve.

Ez a [Marveen](https://github.com/Szotasz/marveen) (Szota Szabolcs) saját fork-ja: **MikroB**, egy CEO/CTO alkatú fő-ügynök és egy szerep-alapú ügynökcsapat, amely Telegramon kommunikál, önállóan dolgozik, és a munkát kockázat-alapú review-gate-eken vezeti át. A fork a bázishoz képest főleg **üzemeltetési robusztusságban, biztonságban és flotta-workflow-ban** tér el (lásd [Jelenlegi fejlesztések](#jelenlegi-fejlesztések)).

Ez a repo a **háttérszolgáltatásokat** adja; a Telegram-kommunikációt a Claude Code Channels kezeli.

## Funkciók

- **AI ügynökcsapat**: több szerep-ügynök (backend, frontend, QA, biztonság, üzleti), külön memóriával és személyiséggel; MikroB koordinál
- **Kockázat-alapú review-gate-ek**: minden kész kártyát min. 2 független ügynök ellenőriz (QA mindig + biztonsági gate a kockázat szerint); a készítő sosem sajátot
- **Mission Control dashboard**: http://localhost:3420 — memória, kanban, ügynökök, ütemezés, Vault, terminál
- **Inter-agent kommunikáció**: az ügynökök közös SQLite üzenetsoron delegálnak egymásnak
- **Kanban**: AI auto-bontás, swimlane, WIP-limit, card-aging, Gantt-nézet, kártya-esemény audit
- **Memória**: hot/warm/cold/shared tier, hibrid keresés (FTS5 + `nomic-embed` vektor, RRF), napi napló, salience decay
- **Heartbeat + fokozatos autonómia**: csendes háttér-monitorozás, csak fontosnál szól
- **Ütemezett feladatok**: cron-alapú task/heartbeat futtatás
- **Vault**: MCP-titkok + SSH-kulcsok/szerverek titkosított kezelése (AES-256-GCM)
- **Öntanulás**: az ügynökök skilleket írnak/patch-elnek a munkájukból (progressive disclosure)

## Egyedi fork-fejlesztések (amiért külön fork)

Ezek a MikroB-fork saját fejlesztései a Marveen-bázison felül — főleg a **flotta-workflow, a review-gate-ek és a platform-robusztusság** rétegében (a fleet-szabályok a `templates/CLAUDE.md.template`-be építve, `5d42edf`):

- **Kockázat-alapú review-gate rendszer**: minden kész kártyát min. 2 független ügynök ellenőriz — **QA mindig**, plusz a kockázat szerint **Cybersec** (trust-boundary: auth, publikus endpoint, RBAC, pénz, PII, file-upload) és/vagy **Cybered** (magas-tétű: publikus write path, session, superadmin). A készítő SOHA nem ellenőrzi a sajátját; MikroB kártyánként rotálja a gate-tagokat, és csak PASS/GO után zár.
- **Teljes értékű audit protokoll**: kötelező leltár (MINDEN gomb + endpoint) → RBAC pozitív/negatív (fail-closed) → superadmin-folyamatok → minden API + DB-művelet → optimalizálás számokkal → STRIDE/OWASP + WCAG + i18n + reziliencia. Semmi nem implicit: ami nincs tesztelve, az „töröttnek" számít.
- **Fleet-workflow**: 4+ szintű Fázis→Feladat→alfeladat bontás (parent/child kanban), felelős + `[NN%]`-marker + színes ügynök-label, 10 perces beragadás-detektálás, **park-idle** (a tétlen ügynököt leállítja a kvóta védelmére), **frontend-pairing** (user-facing feature automatikusan kap Fron Ted UI + user-flow kártyát), **flow-connectivity** (minden user-flow a valós backend-funkciókhoz drótozva — nincs dekoratív/no-op gomb, nincs zsákutca; a QA-gate is ellenőrzi).
- **Kvóta-menedzsment**: 5 órás session-limit figyelés + banner-detektálás, **heti-limit dinamikus küszöbbel** (90/92/95% a resetig hátralévő idő szerint) az új-fejlesztés-stophoz, 5h05m **auto-resume countdown** ami a **banner tényleges reset-idejét** használja (nem vak +5h05m), a limitelt — akár parkolt — ügynök a resetkor magától visszatér; beragadt limit-modál Esc-elése a valós resetkor.
- **npm-only csomagkezelő-őr (`preinstall`)**: ez a repó npm-projekt (a `package-lock.json` a követett lockfile, az `update.sh`/`install-*.sh`/`recovery-prev-version.sh` mind `npm ci` + `npm rebuild better-sqlite3 --build-from-source` + `npm run build`). Egy idegen csomagkezelő viszont csendben lecserélheti egy ÉLŐ szolgáltatás függőségi fáját: 2026-07-31-én egy elkóborolt `pnpm install` átvette a `node_modules`-t (az npm csomagokat a `node_modules/.ignored`-ba tolta), és mivel a pnpm alapból blokkolja a függőségek build-scriptjeit, a **better-sqlite3 natív bindingja sosem fordult le** — a következő újraindítás „Could not locate the bindings file" hibával **crash-loopolt** (~10 újraindítás). A `scripts/assert-npm-package-manager.mjs` `preinstall`-őr ezt hangossá teszi: **kizárólag POZITÍV pnpm/yarn jelre** utasít el (a `npm_config_user_agent` alapján), ismeretlen/hiányzó agent esetén **átenged** — egy téves pozitív ugyanis magát az `update.sh`-beli `npm ci`-t blokkolná, ami rosszabb lenne annál, amit véd.
- **Update-biztonság + recovery**: `update.sh` ff-only pull + auto-stash + rollback-pont (`store/.update-history`), `recovery-prev-version.sh` korábbi known-good verzióra (a `store/` adat érintetlen); **fork-tudatos verzió-ellenőrzés** (az update-checker a tracked branchet — `develop` — kérdezi, nem a hardkódolt `main`-t).
- **Upstream-drift banner az áttekintésen**: a dashboard **áttekintés-nézetének tetején FRISSÍTÉS-BANNER** jelenik meg, ha a felmenő alap (Szotasz/marveen) előrébb jár a forknál (`N új frissítés elérhető` + a meglévő Frissítések oldalra vezető akció, reszponzív + touch-barát). Rule 10 (GitHub-first, nincs duplikáció): NEM ír új ellenőrzést — a MÁR meglévő `update-checker.ts` upstream-behind eredményét vezeti ki, ami úgyis folyamatosan (15 percenként, `startUpdateChecker`) összehasonlítja a forkot mindkét bekötött repóval (felmenő Marveen + MikroB fork, `6af2e7c`). A `/api/overview` a `getUpdateStatus()` cache `marveen`-repo `behind`-ját olvassa.
- **WSL-natív üzemeltetés**: cross-platform Node-pin (Linux/WSL rendszer-node fallback a better-sqlite3 ABI-hoz), **Windows-boot autostart** (WSL-en belül systemd + linger, Windows-oldali indító); az installer a `sqlite3` és `jq` CLI-t is telepíti (a scheduled task-ok ezekre támaszkodnak).
- **Többrétegű self-healing (befagyás-védelem)**: a channels-session befagyását több, egymástól független réteg kapja el, sebészi recovery-vel (SOHA nem WSL-szintű újraindítás egy komponens-akadásért). (1) A dashboard in-process channel-monitorja respawnolja a süket paneleket; (2) három **független systemd --user guard-timer** — `channel-watchdog` (süket keepalive → csak a channels-panel respawn, 5 perc), `stuck-modal-guard` (beragadt `/mcp` modál zárása, 1 perc), `disk-space-guard` (scratch-takarítás + riasztás, 1 perc) — ezek akkor is futnak, ha a dashboard halott; (3) egy **Windows-oldali WSL-watchdog** (Scheduled Task, 5 perc) a TELJES VM-akadásra: kívülről próbálja a liveness-t (dashboard 200 + friss keepalive), és csak tartós (≈15 perc) akadás után indítja újra a distrót. Reprodukálható installerek (`scripts/install-guard-timers.sh`, `scripts/install-wsl-watchdog.sh`), amiket az `install-linux.sh` és a `startup.sh` is hív → **újrainstall és minden boot után magától települ/self-heal**. A beszélgetés egy respawnt is túlél a continuity-ledger révén.
- **Verziókövetett operatív scriptek + tracked CLAUDE.md**: a monitor-scriptek (`store/*.sh`: kvóta, beragadás, pre-dispatch) trackeltek, és a projekt-szabályok forrása, a **`CLAUDE.md` is verziókövetett** (nem gitignored) — a runtime-adat (DB, token, state) ignorált marad.
- **Öntanuló skill-flotta**: 77 seed-skill, köztük 4 mély kód-elemző (`code-comprehension`, `function-explanation`, `refactoring-support`, `defensive-security-analysis`) és egy **i18n-locale lint-guard** (CI-ben bukik a hardkódolt `hu-HU` locale-ra); az ügynökök a visszatérő gate-hibákból tanulnak és patchelik a saját skilljeiket.
- **Projekt-agnosztikus skillek (kötelező szabály)**: egyetlen skill sem tartalmazhat projekt/termék nevet — a skillek általános, újrafelhasználható tudás, hogy a fork bármely projektre telepíthető legyen (a kliens-termék neve nem szivárog a seed-skillekbe). A `skills/skill-index.sh` opcionális könyvtár-argumentumot fogad (a `seed-skills/` index külön regenerálható). Kivétel csak funkcionális artefakt (pl. a `store/claudeclaw.db` tényleges fájlnév és a `Szotasz/marveen-marketplace` valós plugin-marketplace ID). A `seed-fleet-agents/` NEM hardkódol telepítés-specifikus abszolút utat: `__MARVEEN_INSTALL_DIR__` / `__MARVEEN_HOME__` **portability-sentinelt** ship-el, amit az installer `cp` után a valós `INSTALL_DIR`/`HOME`-ra old fel — így a guard-hookok bármely telepítési úton működnek, és nem szivárog a telepítő username-je.
- **Dedikált e2e-tesztelő ügynök (T Eszter)**: külön flotta-ügynök az élő, böngészős e2e tesztelésre (Playwright MCP, valós Chromium). RBAC-hierarchikus, user-story-vezérelt módszertan: a teszt-entitásokat fentről lefelé építi (a legtöbb jogosultságú szereptől — pl. cég = CEO-regisztráció — a legkisebb felé), funkciónként/flow-nként min. 5 user story, mindegyik pozitív (jogosult végigviszi) + negatív (jogosulatlan **szerver-oldali fail-closed**) bizonyítékkal. NEM gate-tag: e2e-t hajt végre, a bizonyítékait a QA gate használja. A perszóna + a fő skill (`e2e-rbac-hierarchical-testing`) verziókövetve a `seed-fleet-agents/`-ben (reseed-durable).
- **Per-ügynök skill-hozzárendelés (közös + célzott)**: a skillek kétszintűek — **közös** (`~/.claude/skills/`, minden ügynök) és **egyéni/célzott** (`agents/<ügynök>/.claude/skills/`, csak az adott ügynökök). Egy skillt használhat több ügynök is, de nem mindenki (pl. az e2e-skill csak T Eszter + QA mappájában). Egy napi ütemezett rutin (`skill-besorolas-napi`) az ÚJ skilleket besorolja közös vagy célzott-ügynök kategóriába.
- **Egységes ügynök-elnevezés**: az agresszív red-team ügynök neve mindenütt **Cybered** (display-név + agent-id egységesítve).
- **Dashboard-redesign**: ügynök running-ring animációk (saját session vs subagent), per-ügynök státusz-színek.
- **Lokális-LLM offload rendszer (WSL GPU)**: a flotta a jól körülhatárolt, mechanikus kód/szöveg-részfeladatokat egy helyi Ollama-modellre (GTX 1660 Ti, `qwen2.5-coder:7b`) offloadolja Claude-token helyett — `store/local-llm.sh` (nyers kliens) + `store/local-llm-rag.sh` (memória-RAG wrapper, `--caller`/`--source` attribúcióval), `local-llm-offload` skill. A dashboard **Lokális LLM** menüpontja: státusz (ollama/modell/GPU/quota-bridge), egy-kattintásos modellcsere + `ollama pull` frissítés, kurált coding-modell-ajánlások (GPU-fit jelzéssel) + élő HuggingFace GGUF-kereső, élő log + futó feladatok, gyorsteszt, és egy **Használat-mérő** (valós fleet-hívások: agentenként/mód/kód, az UI-próba kizárva, csak metaadat). **Ghost vészmód-híd** (`quota-bridge`): kvóta-fagyáskor a helyi modell + memória-RAG felel a Telegramon a resetig. Heti-limit 90% felett: minden kódolás a helyi modellre (draft), a verifikáció a reset utánra halasztva.
- **Update-biztos közösségi átvétel + git-repo-watcher**: a bevált nyílt-forrású skillek/eszközök átvétele KIZÁRÓLAG additív fork-fájlként (új `seed-skills/`, `store/*.sh`, MCP a repón kívül) — sosem felmenő core-fájl szerkesztésével, így az `update.sh` ff-only pull tiszta marad. A `store/git-repo-watcher.sh` (+ `git-repo-watcher` scheduled task) figyeli a bekötött upstream repókat: a szöveg-adoptációk (skill/doc) azonnal ff-frissülnek, a külső **futtatható kód** viszont változáskor csak DETEKTÁL + STAGE + FLAG-el (gyors supply-chain/integritás-ellenőrzés + Peti-értesítés) — sosem fut vakon kompromittálható upstream commit a flottán. Első átvétel: `plan-grilling` skill (MIT).
- **CostOps + heti-limit % gauge**: havi költség-főkönyv (`src/costops/`: fix-költségek + budget-ek a konfigból a `cost_sources` ledgerbe, `/api/costs/*` + Költségek dashboard-oldal), plusz egy **heti Claude-limit % gauge az áttekintésen**. Mivel a heti-% programmatikusan nem olvasható megbízhatóan (a token scope hiányzik — nincs fantázia-auto-olvasás), ez **MANUÁLIS pillanatkép** (`store/weekly-limit-snapshot.json`, `/api/costs/weekly` GET/POST): az operátor rögzíti a usage-képernyőn látott heti %-ot, a gauge küszöb-színnel (90/95 sáv) jelzi, **beszédes needs-input állapottal** ha nincs adat (12. szabály), reszponzív + touch-barát (13. szabály). **Auto-olvasás + enriched snapshot (card a91c6039):** egy dedikált, Max-előfizetéssel belépett `/usage` panelből (`mikrob-usage-probe`, MikroB-vezérelt send-keys) a `store/weekly-usage-panel-read.sh` kiolvassa MINDEN sávot; a parse pure + unit-tesztelt (`store/weekly-usage-parse.sh` + `.test.sh`). A `WeeklyLimitSnapshot` (`src/costops/weekly-limit.ts`) enriched: a canonical heti `pct`/`resetAt` (stop-rule) mellett `session` + `fable` (`{pct,resetAt}`) + `promo` (a +50% heti promo szövege) + `source:'panel'` — mind additív és backward-compatible (régi snapshot is olvasható). A `/api/costs/weekly` változatlan route-tal szolgálja ki (a `...snap` spread viszi a plusz mezőket). A widget-redesign (manuális vezérlők KI, minden sáv informatívan) a párosított Fron Ted FE-kártyán. **Reboot-túlélő auto-login (2026-07-31):** a probe **izolált credential-tárban** él (`CLAUDE_CONFIG_DIR=~/.claude-usage-probe`), így a megosztott credential-rotáció nem löki ki; reboot után viszont a tmux panel eltűnik, ezért a `weekly-usage-panel-read.sh` a panel hiányát érzékelve **magától újraéleszti** a panelt az izolált tárból (a ~1 hónapos refresh token csendben frissíti az access tokent), és CSAK akkor kér Petitől böngészős `/login`-t, ha maga a refresh token is lejárt — nincs több felesleges reboot-utáni belépés.
- **Publikus fleet-digest endpoint** (`GET /api/public-digest`): egyetlen, szándékosan **unauth** read-only státusz-végpont, ami CSAK nem-azonosító **aggregált** adatot ad (ügynök-DARABSZÁM running/total, verzió, név, timestamp) — SOHA nem szivárogtat ügynök-nevet/id-t, utat, tokent, PII-t vagy flotta-topológiát (a `/api/*` többi része pont ezért Bearer-gated). Fail-closed: bármely hibára minimális `{ ok:false }`. A trust-boundary tesztek a payload-alakot rögzítik, hogy egy jövőbeli szivárgó mező bukjon.
- **Offload-vezérlés + proaktív offload-mód**: a Lokális-LLM offload manuálisan hangolható a dashboard **offload-mennyiség csúszkájával** (perzisztens config, jelölt optimum-ponttal), amit a `local-llm-offload` skill élőben olvas és modulál — a csúszka valódi viselkedést vezérel, nem dekoratív. A csúszka mellett egy **kódolási-nehézségi küszöb legördülő** (card afcfe93e): az agresszivitás %-hoz egy rendezett, CSAK-kódolási nehézségi taxonómia (triviális < izolált < modul < feature < architektúra) tartozik — magasabb % → nehezebb feladat is helyben. A küszöb `auto` (a csúszkából származtatott) vagy explicit választás, de **a 7B megbízható határánál (`module`) KEMÉNYEN sapkázva**: még a 100% sem enged többet, mint amit a modell reálisan tud — a `feature` (több-fájlos) és az `architektúra`/wiring MINDIG online (Claude) marad (a legördülő csak `module`-ig kínál szintet, egy stale/kézzel írt magasabb config-érték is `module`-ra klampol). A `store/local-llm-rag.sh --difficulty <szint>` a küszöb ELLEN kapuz: a küszöbnél nehezebb feladatot NEM draftol helyben (exit 8, beszédes üzenet). Egy **proaktív offload-flag** (`store/local-llm-offload-active.json`) a heti-limit ALATT is bekapcsolja, hogy minden ügynök aktívan a helyi modellre adja a mechanikus kód-részeket; ez a `shared-memory-inject` SessionStart-hookon keresztül minden ügynök minden sessionjébe automatikusan bekerül (strukturális kikényszerítés, nem lágy direktíva). A dashboard **kétmodell-egyértelmüsítése** külön jelzi a KÓD/offload-modellt (`qwen2.5-coder`) és a memória-embedding-modellt (`nomic-embed-text`).
- **Gemini API kulcs (bring-your-own-key) integráció**: opcionális, felhasználó-adta Gemini API kulcs a dashboard Settings/Integrációk menüjében — AES-256-GCM-titkosított tárolás, **probe-validáció mentés előtt** (fail-closed: rossz kulcs sose kerül a vaultba), a nyers kulcs SOHA nem jut kliensre/logba/URL-be (csak maszkolt). Megfelelőség-tudatos: a felhő-modell opt-in a saját kulccsal (alapból lokális marad), a UI-ban a Google-feltételek + adatvédelmi figyelmeztetés (ingyenes-tier adathasználat) elérhető; kódolásra jogszerűen használható (versengő-modell-tilalom betartva).
- **Host-restart-osztályozás + bot-token health-guard**: a self-healing réteg két read-only diagnosztikai watchdoggal bővült — a host-restart-watchdog megnevezi az előző leállás okát (OOM-kill / poweroff / crash / unknown, `journalctl -b -1` + wtmp fallback), és egy periodikus (15 perces systemd-timer) **bot-token health-guard** külön 401/revoked-riasztást ad, ha a channel-token lejár/visszavonják (a token SOHA nem kerül argv-be/logba).
- **Projekt-prioritás a kiosztásnál (14. szabály)**: a valódi projekt-(termék-)feladatok mindig magasabb dispatch-prioritást élveznek a nem-projekt (infrastruktúra/fork-integráció/meta) munkánál — nem-projekt kártya csak akkor kap szabad ügynököt, ha nincs dispatchelhető projekt-feladat.
- **Per-kontakt kommunikációs kalibráció (`contact-calibration-profile` skill)**: egy ügynök egy visszatérő emberi kontaktushoz igazíthatja a kommunikációt egy gépi-olvasható profil alapján — nyelv/verbozitás/tiltott fordulatok + egy fogalom-tudásgráf (0-3 szint + `requires`/`kind_of`/`builds_on`/`related` élek): a level-0 fogalmat a legközelebbi ismert szomszédhoz horgonyozva magyarázza, a level-3-at nem magyarázza. Az ügynök session-kezdéskor Read-eli, és beszélgetési jelekre (megkérdezi „mi az X" / helyesen használja / nem érti) Edit-eli — nincs backend-kód/endpoint, csak a meglévő fájl+memória mechanizmus (update-safe: a per-kontakt adat a gitignored `store/contact-profiles/`-ban él, a `docs/contact-profile.template.json` sablon és a skill verziókövetett). RULE-10 adaptáció a `latnaborsodi/marveen` donat-profile mintából, de-perszonalizálva.
- **Token-égés elleni re-dispatch guard** (`store/redispatch-guard.sh`): mielőtt bármely monitor (stuck-card, fleet-nudger, gate-reconciler, folyamatos-munka) meglökne vagy újra-dispatchelne egy kártyát, egy közös guardon kell átmennie. Liveness-check (2 mintás tmux-diff + queue/spinner-jel → ha az ügynök dolgozik, `DENY:agent-busy`), progress-check (ha a kártya `updated_at`-je nőtt → `DENY:progress` + a számláló nullázódik), kártyánkénti exponenciális backoff (600s·2^n) és HARD CAP 3 (utána nem próbál újra, EGYSZER Petinek eszkalál). Közös atomikus ledger (`store/redispatch-ledger.json`), hogy a négy monitor ne írja felül egymást; a token a headerfile-ból olvasva (0600), sosem argv-ben. Ez zárja ki a „lassú-de-élő kártyát 18x újra-fejlesztjük" token-spirált. Mind a négy monitor-prompt bekötve, seedelve is (friss install is kapja).
- **Server-oldali brand-bake**: a dashboard a konfigurált `BRAND_NAME`-et (`.env`) már az ELSŐ paintbe besüti a tab-title + mobil-topbar + oldalsáv-brand slotokba (nem csak a PWA-`apple-mobile-web-app-title`-be), így soha nem villan fel és nem ragad be egy cache-elt vagy stale-bundle „Marveen" default; a kliens `initSidebarBrand()` fetch már csak megerősíti. Cache- és script-timing-független, a meglévő apple-title-kezelés mintájára (`src/web/routes/static.ts`).
- **Lokális-LLM GPU-hangolás + mért bizonyíték** (card 7041c165): az Ollama-szolgáltatás `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0` beállítással fut. A flash-attention a KV-kvantálás ELŐFELTÉTELE; a q8_0 felezi a KV-gyorsítótárat, és a felszabaduló VRAM-ban több transformer-réteg marad a GPU-n a CPU helyett. A 6 GiB-os GTX 1660 Ti-n **mérve** (3 futás/pont, azonos prompt, `store/local-llm-bench.sh`): ctx 4096 → GPU-arány 82→84%, KV 224→119 MiB, 29,1→31,7 tok/s (+9%); ctx 16384 → 73→79%, KV 896→476 MiB, 24,4→27,4 tok/s (+12%); ctx 24576 → 67→73%, KV 1344→714 MiB, és használható marad. A benchmark-script újrafuttatható, tehát az állítás ellenőrizhető, nem hitre épül.
- **Gate pre-triage (helyi, determinisztikus)** (`store/gate-pretriage.sh`): a QA/Cybersec gate ELŐTT lefutó, ingyenes, gép-oldali első kör, ami a visszatérő mechanikus hiba-osztályokat listázza (nincs teszt a változott kódra, tesztek által nem hivatkozott új export, vacuous `.not.toBe` assertion, újonnan skippelt teszt, parancssorba került titok, CSP-t sértő inline style, biztonsági megjegyzés nélküli migráció, tsc-állapot + az a csapda, hogy a tsconfig kizárja a teszteket). **Sosem ad verdiktet** (`verdict: null`, nincs PASS/FAIL/GO szó a kimenetben) — a gate bemenete, nem helyettesítője; a tiszta riport annyit jelent, hogy az olcsó csapdák tiszták. A találatok **net-new** számításúak: egy csak ÁTMOZGATOTT minta `info`, nem `warn` — különben minden path-refaktor riasztana, és a gate-ek megtanulnák figyelmen kívül hagyni. **Bekötve a gate-folyamatba** (`store/gate-pretriage-card.sh <cardId>`, card 83191d8d): a `gate-reconciler` ütemezett feladat ezt futtatja, mielőtt egy gate-et dispatchelne — kiszedi a kártya REVIEW-jából a commitot és a repót (CleanCore vagy MikroB), lefuttatja a pre-triage-t, és egy `verdict:null` INPUT kommentet ír a kártyára (idempotens: commit-onként egyszer). Így a QA/Cybersec a mechanikus tényekből indul, nem online tokenért deríti ki őket.
- **Lokális-LLM auto-router kimenet/policy jel-család** (`src/local-llm-router.ts`): az offload-router a mechanikus-vs-online döntésnél a veszélyes authz/policy-megfogalmazásokat (access-default, scope-drop, validáció-kliensre-tolás, jogosultság-emelés) ONLINE-ra kényszeríti — a döntés a jel-CSALÁDRA általánosít, nem a szó szerinti stringre (34 angol paraphrase-re 0 tévesztés friss, sose-jelentett megfogalmazásokon is; a mechanikus izolált kód-darabok továbbra is LOCAL-ok). A local output DRAFT-only marad, kötelező MikroB+gate újra-ellenőrzéssel: a router draft-MOTORT választ, sosem bizalmat (nincs auto-approve/gate-skip rákötve).
- **Rate-limit kulcs-normalizálás keményítés**: az IP-alapú rate-limit kulcs a PARSE-olt IPv6-csoportokból bontja ki az IPv4-mapped címeket (`::ffff:a.b.c.d` és `a.b.c.d` azonos kulcs), szigorú `::ffff:0:0/96` range-check-kel és pontos /56-collapse-szel — bezárja az IPv6-reprezentáció-váltogatásos rate-limit-bypasst anélkül, hogy IPv4-kizárásos DoS-t nyitna (valós exportált függvényen, nem-vakuum regresszió-teszttel igazolva).
- **Beépített repók oldal — teljes adoptáció-lista + install-állapot**: a dashboard „Beépített repók" oldala (`/api/integrated-repos` a `store/watched-repos.json` felett) MINDEN adoptált fejlesztést listáz — a kézzel hozzáadott GitHub-repókat ÉS a korábbi/új vendorolt skilleket, MCP-ket, eszközöket (a FE union-t mutat, korábban csak a — üres — manuális listát olvasta). Az endpoint `adoption` + `pinnedVersion` + származtatott `installed` mezőt is ad, így a **pipx-adopciók** (code-review-graph, graphify) `cloned=false` DE `installed=true` — a UI „✓ telepítve (pipx <ver>)" jelzéssel, nem tűnik hiányzónak. A `~/.claude/external/` alatti, `external-repos-daily-sync`-kel naponta pull-ozott repók is megjelennek.
- **Adopt-9 közösségi átvétel + Karpathy kódminőségi alapelvek (Peti 2026-07-31)**: 6 doc/skill/index repo (anthropics/skills, shanraisshan/claude-code-best-practice, jqueryscript/awesome-claude-code, VoltAgent/awesome-agent-skills, alirezarezvani/claude-skills, FlorianBruniaux/claude-code-ultimate-guide) klónozva a **repón kívülre** (`~/.claude/external/`) + `VENDORED.md` + napi sync + registry — a Szotasz/marveen ff-only update ezért sértetlen. A 3 **futtatható** eszköz (atlassian-labs/mcp-compressor, ooples/token-optimizer-mcp, yamadashy/repomix) NEM települ vakon: `pending-audit` a registryben, Cybersec-gate ELŐBB (supply-chain, rule 10). Andrej Karpathy 4 kódminőségi alapelve (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution) **ötletként beolvasztva a `CLAUDE.md`-be** (minden ügynökre) — a forrás-repo stale + nincs LICENSE fájl, ezért nem vendorolt, csak az elvek, attribúcióval.
- **mcp-compressor: csak-könyvtár adopció, GO-ra zárva (card b92c10d4, Peti Opció C)**: az `@atlassian/mcp-compressor` N-API tömörítő modulja KÖZVETLENÜL hívva (compression API), a `serve` út (és a hozzá tartozó ~330 sebezhető Rust-crate-lánc) SOHA nem fordul le — prebuilt addon, pinelt verzió (`0.31.7`), `--ignore-scripts`, a csomag a repón KÍVÜL él (`store/mcp-compress.sh`, verziókövetett ops-script). Cybersec a végleges GO-t a saját méréssel zárta (a nyolc OSV-advisory nem érhető el a betöltött library-felületről) + a pinelt verzió a RUN-úton is asszerttálva van, fail-closed (`212207b`). Kísérő: `store/mcp-compressor-watch.sh` upstream-verzió-figyelő (re-gate trigger, ha a felmenő csomag frissül).
- **Lokális-LLM offload: 44 kategória + éjszakai batch (2026-07-31)**: az offloadolható mechanikus feladat-taxonómia 15-ről 44 kategóriára bővült (kód: regex, TS-típusok, schema-validator, refaktor, bugfix-draft, code-explain, naming, json-transform, sample-data; backend/infra: crud-adapter, sql-migráció-draft, api-kliens, dockerfile, yaml-config, shell-script, cron-expr, env-doku; frontend/minőség: a11y-check, responsive-check, pr-review; doksi: doc-draft, docstring, dep-diff, i18n-keys, release-notes, action-items, hibaüzenet→i18n). Mind DRAFT-only. Egy napi 03:00-s **éjszakai batch-runner** a GPU üresjáratát használja ki: a mechanikus backlogot (in_progress + top-N planned, aminek nincs még draftja) online-token nélkül ledarálja a 7B-re, a heti kvótától függetlenül.
- **Heti-% modell-lépcső, per-ügynök a SAJÁT bázisáról (card 5d2002b5, Peti 2026-08-01)**: ahogy a heti Claude-keret %-a nő, minden szerep-ügynök egy lépcsővel lejjebb lép a modell-létrán (a munka NEM áll le, csak olcsóbb modellen fut) — két állítható küszöbön (alap 75%/85%). A létra **egyetlen forrásból** jön (`src/model-catalog.ts`: `CLAUDE_MODELS` + `MODEL_LADDER`), ugyanabból, mint az ügynök-modellválasztó dropdown — egy új modell egy szerkesztéssel megjelenik mindkettőben, nincs külön hardcode-olt lánc. A lépés **per-ügynök, a saját bázis-modelljéről** relatív (`weeklyTargetModel(base, tier)` = `ladderIndexOf(base) + tier`, a létra végére clampelve): egy Opus-bázisú és egy Haiku-bázisú ügynök ugyanazon a tier-en KÜLÖNBÖZŐ modellre lép — a korábbi kód abszolút lánc-indexet használt, ezért mindenkit ugyanarra a modellre tolt (ez volt a bug). A bázis **tartósan perzisztált** (`store/model-tier-baseline.json`, az első leléptetéskor rögzítve): egy dashboard-restart alatt leléptetett ügynök is a SAJÁT bázisára áll vissza a heti resetkor, nem a globális primaryre. A dashboard **Modell-lépcső** panelje read-only ügynök-állapotot mutat (bázis-modell, aktuális tier, tényleges modell — `GET /api/costs/model-fallback/agents`); a két %-küszöb csúszka szerkeszthető marad. mikrob-channels kivétel (sosem lép le). A banner-alapú (usage-limit) fallback változatlan; a két tengely „lejjebb a létrán győz" szabállyal kombinálódik.
- **Lokális-LLM offload: +8 DRAFT-only kategória (52-re bővítve, card b82f952f, Peti COSTOPS)**: a token-spóráshoz a jól-körülhatárolt, FUZZY vagy review-elhető (nem determinisztikus) preset-taxonómia 44-ről 52-re bővült 8 új kategóriával: `user-story` (feature+szerep → user story-k), `acceptance-criteria` (Given/When/Then, pozitív+negatív), `edge-cases` (tesztelendő edge-case-ek), `log-summary` (zajos logok → incidens-digest), `keywords` (szöveg → kulcsszavak kereséshez/memóriához), `alt-text` (kép-kontextus → screen-reader alt), `faq` (feature/doksi → GYIK), `commit-split` (diff → logikai commit-bontás). Mind DRAFT-only (a MikroB+gate re-verifikál élesbe menés előtt), generatív/ítélet-jellegű (nem escaping/regex/aritmetika — az kód marad), és titok/PII-mentes. Anatómia: egy `store/local-llm-skills/<name>.txt` preset (system blokk `---` `{{INPUT}}`) + HU leírás (`src/web/routes/local-llm.ts`) + EN tükör (`store/local-llm-rag.sh`); a dashboard `/api/local-llm/categories` a lemezről listázza őket automatikusan.
- **Lokális-LLM dashboard: az összes offload-kategória vezérlése (card 0c054ebf)**: a **Lokális LLM** oldal új **Kategóriák** szekciója az összes `--task` preset-et listázza élőben (`GET /api/local-llm/categories`, forrás: `store/local-llm-skills/*.txt` a lemezről, sosem hardcode-olt UI-lista), hívásszámmal + utolsó-használattal, és egy valódi be/ki kapcsolóval (`POST /api/local-llm/categories`, `disabledCategories` tömb a `local-llm-offload-active.json`-ban). A kapcsoló **nem dekoratív**: a `store/local-llm.sh` a közös funnel-ponton (minden `--task` hívás, közvetlen vagy `local-llm-rag.sh`-n át) ellenőrzi ugyanazt a configot, kikapcsolt kategóriánál exit 9-cel jelez (ugyanaz a kód mint a `--auto` router "menjen online" jele), hiányzó/hibás config esetén fail-open (nem gátló kapu, csak opt-out). Mellékesen javítva: a `local-llm-rag.sh` no-verify útja korábban feltétel nélkül `exit 0`-t adott, ami elnyelte volna ezt az exit 9-et a flotta alap hívási útján — most a valós kilépő kódot adja tovább.

### Dokumentáció-index

| Funkció | Lap |
|---------|-----|
| Heartbeat + fokozatos autonómia | [docs/heartbeat-autonomy.md](docs/heartbeat-autonomy.md) |
| Memória-rendszer (FTS5 + vektor + RRF) | [docs/memory-system.md](docs/memory-system.md) |
| Kanban (auto-breakdown, swimlane, WIP-limit, card-aging) | [docs/kanban.md](docs/kanban.md) |
| Ügynök-flotta + inter-agent | [docs/agent-fleet.md](docs/agent-fleet.md) |
| Föderáció (több példány összekötése, dashboard-menüvel) | [docs/federation.md](docs/federation.md) |
| Skill-factory (öntanulás) | [docs/skill-factory.md](docs/skill-factory.md) |
| Channels (Telegram / Slack) | [docs/channels.md](docs/channels.md) |
| Printing-press CLI-k | [docs/printing-press-cli.md](docs/printing-press-cli.md) |
| Skool CLI | [docs/skool-cli.md](docs/skool-cli.md) |
| connectors.hu | [docs/connectors-hu.md](docs/connectors-hu.md) |
| Vault & titkosítás | [docs/vault.md](docs/vault.md) |
| Dream-engine | [docs/dream-engine.md](docs/dream-engine.md) |
| Háttér-feladatok | [docs/background-tasks.md](docs/background-tasks.md) |
| Ütemezett feladatok | [docs/scheduled-tasks.md](docs/scheduled-tasks.md) |
| Költöztetés (másik gépre) | [docs/MIGRATION.md](docs/MIGRATION.md) |
| Beszélgetés-folytonosság | [docs/conversation-continuity.md](docs/conversation-continuity.md) |
| Channel reply-guard | [docs/channel-reply-guard.md](docs/channel-reply-guard.md) |
| Telegram haladásjelző | [docs/telegram-progress-indicator.md](docs/telegram-progress-indicator.md) |
| Új asszisztens onboarding | [docs/onboarding-uj-asszisztens.md](docs/onboarding-uj-asszisztens.md) |

> A fork emellett követi a felmenő Marveen kiadásait is (pl. **v1.19.0**: SSH Vault, owner-gated terminál-input, kanban kártya-esemény audit, dashboard auth-keményítés). Legutóbb integrálva: **v1.27.0** (2026-07-31, kártya `266d8248`) — merge-base diffből, egyenkénti `cherry-pick -x`-szel, sosem blanket merge-dzsel: worker-session halál-detektálás + naplózás (`worker-liveness.ts`, #801), az onboarding-varázsló a VALÓS agent-id-t oldja fel a függő párosítások előtt (#802), a telepítő a SZOLGÁLTATÁSOKNAK is ad auth-credentialt és **fail-closed** ha nincs (#799), a teljes lánc a `WEB_PORT`-ot követi a fix 3420 helyett (#800), a quarantine-reader fetch-allowlistje a tulajdonos egress-gate-jéből származik (#797), plusz egy dashboard-komment javítás (#805). A `v1.27.0` release-rollup commit (`489b35a`) szándékosan KIMARADT: ugyanezeket a változásokat csomagolja, átvétele duplikálna. Előtte: **v1.26.0** (2026-07) — a fork-divergencia megőrzésével átvéve: kiszervezett auth-gate (`resolveAuth`/`requiresAuth` — per-device dashboard-kulcsok + opcionális felhasználónév/jelszó böngésző-login, a Bearer-token út byte-azonos marad, a fork `/api/public-digest` unauth-kivétele megőrizve), oldalsáv-menü csoportosítás (a fork `Lokális LLM` menüpontja a RENDSZER csoportba fűzve), verziózott statikus asszetek cache-elhetősége, upstream-drift branch-figyelmeztetés a Frissítések oldalon, `remote-enroll` eszköz (device-SSH-kulcs onboarding), plusz telepítő/ütemező javítások (WSL home-clone, node@22 launchd-pin, apt-lock kivárás, token-usage költségtábla #737).

## Öntanulás & Seed-ek

Az ügynökök automatikusan tanulnak a munkájukból: komplex feladat vagy hiba-recovery után újrahasznosítható skill-t (receptet) írnak maguknak, a meglévőket pedig célzottan patch-elik. A skillek token-hatékonyan, 3 szinten töltődnek (progressive disclosure). A flotta-szintű skillek és ütemezett feladatok a `seed-skills/` és `seed-scheduled-tasks/` mappából terjednek minden telepítésre (idempotens: a meglévő testreszabást nem írja felül) — a fork saját seed-fleet-agents/ (T Eszter perszóna + skillek) is ugyanígy verziókövetett és reseed-durable.

→ **Részletek:** [docs/skill-factory.md](docs/skill-factory.md)

## Architektúra

- **Memória rendszer** — SQLite, hot/warm/cold tier, hibrid keresés (FTS5 + vektor), napi napló
- **Kanban** — SQLite (`kanban_cards`, `kanban_comments`), parent/child bontás, esemény-audit
- **Heartbeat monitor** — csendes háttérellenőrzés (naptár, email, kanban, kvóta, beragadás)
- **Web dashboard** — admin felület a memória/kanban/ügynök/ütemezés/Vault kezeléséhez
- **Inter-agent kommunikáció** — ügynökök közötti üzenetsor

## Telepítés (ebből a forkból: `R4CK/mikrob`)

Ez a fork saját telepítendő — NEM a felmenő `Szotasz/marveen`.

### macOS / Linux

```bash
git clone https://github.com/R4CK/mikrob.git
cd mikrob
./install-linux.sh
```

Alapértelmezés szerint a dashboard a 3420-as porton indul (`http://localhost:3420`). Egyedi port beállításához:

```bash
./install-linux.sh --port 3421   # vagy: WEB_PORT=3421 ./install-linux.sh
```

### Windows (WSL) — a fork elsődleges környezete

```powershell
git clone https://github.com/R4CK/mikrob.git
cd mikrob
.\install-windows.ps1
```

A telepítő beállítja a WSL-t (Ubuntu) és azon belül telepíti a rendszert. Ha a PowerShell wrapper elakad, nyisd meg az Ubuntu-t és a WSL shellben futtasd közvetlenül a Linux-telepítőt:

```bash
git clone https://github.com/R4CK/mikrob.git && cd mikrob && ./install-linux.sh
```

### Linux / macOS

```bash
git clone https://github.com/R4CK/mikrob.git
cd mikrob
./install.sh
```

A telepítő végigvezet: függőségek, Claude Code bejelentkezés, Telegram bot, a bot/márka neve, szolgáltatások indítása. Frissítés a forkból: `./update.sh` (ff-only pull az `origin`-ról).

### Branding (env)

Két független beállítás (`.env`):

| Kulcs | Mi ez | Default |
|-------|-------|---------|
| `BOT_NAME` | a fő ügynök megjelenített neve | `Marveen` |
| `BRAND_NAME` | a termék neve a dashboard fejlécében | `BOT_NAME` |

A `MAIN_AGENT_ID` (a `BOT_NAME` ASCII slug-ja) és `SERVICE_ID` (a `BRAND_NAME` slug-ja) automatikusan származik. Ha `BRAND_NAME == BOT_NAME`, a systemd/launchd unit-nevek byte-azonosak a márkázatlan telepítéssel — a helyben történő frissítés nem törik el.

## Használat

### Dashboard

http://localhost:3420 — memória, kanban, ügynökök, ütemezés, Vault, terminál.

### Csatorna

Ez a fork öt csatorna-providert támogat: **Telegram** (alapértelmezett), **Slack**, **Discord**, **Google Chat**, **Microsoft Teams**. A telepítő Telegram/Slack/Discord közül kér választást; a `CHANNEL_PROVIDER` env-kulcs manuálisan is átállítható a többire. Csatornaváltáshoz futtasd újra a `./install-linux.sh`-t, vagy szerkeszd a `.env`-et és indítsd újra a szolgáltatást (`./scripts/stop.sh && ./scripts/start.sh`).

→ **Részletek + provider-specifikus lépések:** [docs/channels.md](docs/channels.md)

### Ágensek

A Csapat oldalon hozhatsz létre újat. Mindegyik ügynök saját:
- csatorna-botot (Telegram/Slack/Discord/stb.)
- személyiséget (`SOUL.md`)
- utasításokat (`CLAUDE.md`)
- memóriát és skilleket kap

### Bot profilkép

A telepítő pixel-art avatart generál és elküldi a beállítási utasításokkal. Egyedi kép beállításához:

1. Tedd a fájlt `agents/<ÜGYNÖK_NEVE>/avatar.png` alá (png/jpg/jpeg/webp)
2. Indítsd újra a szolgáltatást (`./scripts/stop.sh && ./scripts/start.sh`)

A dashboardon (Csapat oldal) is cserélhető: kattints a bot kártyájára, válassz a galériából vagy tölts fel sajátot.

### Ütemezések

task (mindig szól) vagy heartbeat (csak fontosnál) — lista, napi idővonal, heti nézet.

### Vault

A titkokat/SSH-kulcsokat a Vault-oldalon kezeled (AES-256-GCM); a `.mcp.json`-ben csak `vault:SECRET_ID` referenciák állnak, a Scan & Import megtalálja a meglévő plaintext kulcsokat.

→ **Részletek:** [docs/vault.md](docs/vault.md)

### Ágens monitorozás

A `scripts/monitor_agents.sh` egyetlen tmux `monitor` session-be fogja össze az összes futó ügynök session-jét (iTerm2 Control Mode-dal, `-CC`, minden ügynök külön tabként). Automatikusan felderíti a futó `agent-*` és `<szolgáltatás>-channels` session-öket; a monitor session törlése az ügynök-session-öket nem érinti, csak a linked-window referenciákat szünteti meg.

```bash
./scripts/monitor_agents.sh
```

### Frissítés és visszaállás

```bash
./update.sh                      # ff-only pull + rebuild + service-restart, rollback-pont mentése
./recovery-prev-version.sh --list        # elérhető rollback-pontok
./recovery-prev-version.sh --dry-run     # mit tenne (nincs változás)
```

A valós rollback újraindítja a szolgáltatást — éles visszaállást a tulajdonos futtat manuálisan.

### Remote access key enrollment

A helper that lets an operator enroll a single device's SSH public key with a tightly restricted `authorized_keys` entry, then hands back a copyable connection bundle. Each device carries its own revocation id (`marveen-remote:<uuid>`) so access can be replaced or removed per device.

Run it with the public key line as a single quoted argument:

```bash
npm run remote-enroll -- "ssh-ed25519 <base64 key> marveen-remote:<uuid>"
# optional flags:
npm run remote-enroll -- --host 203.0.113.10 --port 2222 "ssh-ed25519 <base64 key> marveen-remote:<uuid>"
```

The public key line must be exactly three fields (type, key, comment) with no `authorized_keys` options and no extra fields. Only `ssh-ed25519` keys are accepted, and the comment must be `marveen-remote:<uuid>` (uuid v4).

It appends (or replaces, when the same id is re-enrolled) this restricted line to the invoking user's `~/.ssh/authorized_keys`:

```
restrict,port-forwarding,permitopen="127.0.0.1:3420",command="/bin/false" ssh-ed25519 <base64 key> marveen-remote:<uuid>
```

`restrict` disables pty, agent, and X11 forwarding; the forced command is `/bin/false`; and the only endpoint the key may open is `127.0.0.1:3420`. The write is atomic (temp file plus rename) and guarded by an `authorized_keys.lock` file so concurrent runs cannot corrupt the list. `~/.ssh` is created 0700 and `authorized_keys` 0600 when missing; if either already exists with looser permissions the tool warns instead of changing them silently.

After enrolling, it prints a base64 connection bundle between clearly marked delimiters. The bundle carries the host, SSH port and user, the fixed remote port (3420), the device id, the machine's `ssh-ed25519` host key, and -- by default -- the dashboard bearer token (`DASHBOARD_TOKEN` env or `store/.dashboard-token`), so the connecting app can authenticate against the dashboard without a separate step. A token-bearing bundle is a SECRET: hand it over on a private channel only, never by email or shared chat. Pass `--no-dashboard-token` to emit a token-free bundle (the device user must then obtain the dashboard access URL out of band). If no token can be found the tool warns and emits a token-free bundle. The host key is looked up in the known public-key locations (`/etc/ssh`, `/private/etc/ssh`, Homebrew and `/usr/local` prefixes) and, when none of those files exist -- as on stock macOS -- read from the running SSH server itself via `ssh-keyscan` on loopback. The connecting side requires the host key, so if it cannot be obtained from any source the tool exits with an error instead of printing an unusable bundle; start the SSH server (macOS: System Settings > General > Sharing > Remote Login) and re-run. When `--host` is not given, the tool prints a hint to verify the resolved address is the one the device will reach.

To revoke a device, delete the line whose comment matches its id (`marveen-remote:<uuid>`) from `~/.ssh/authorized_keys`.

### Leállítás / indítás

```bash
./scripts/stop.sh
./scripts/start.sh
```

### VPS / AWS EC2 telepítés (szerver)

Linux VPS-en (Ubuntu 22+, Debian 12+) az `./install.sh` automatikusan az `install-linux.sh`-t futtatja. Headless szerveren a bejelentkezéshez OAuth token kell, mert nincs böngésző.

```bash
# 1. A SAJÁT gépeden (ahol van böngésző):
claude setup-token
# Másold ki a generált tokent (sk-ant-oat01-...)

# 2. A VPS-en (ebből a forkból telepíts):
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
cd ~
git clone https://github.com/R4CK/mikrob.git
cd mikrob
./install.sh    # automatikusan install-linux.sh-t futtat
```

A token 1 évig érvényes. Ne állíts be `ANTHROPIC_API_KEY`-t mellé.

**Fontos VPS-specifikus tudnivalók:**
- **RAM**: legalább 2 GB ajánlott (t3.small). 1 GB-os gépen az npm build swap nélkül elbukhat -- a telepítő figyelmeztet és felajánl swap-létrehozást.
- **claude.ai MCP-k**: ha a claude.ai fiókodban sok MCP connector van engedélyezve, a headless claude session megpróbálja betölteni mindet, ami instabilitást okozhat. Telepítés előtt tiltsd le a felesleges MCP-ket a claude.ai Settings oldalán.
- **Közvetlen futtatás**: `./install-linux.sh` (Linux) vagy `./install-macos.sh` (macOS) ha az OS-detekciót ki akarod hagyni.

## Követelmények

- Windows 10/11 (WSL), Linux vagy macOS
- Node.js 20+
- Claude Code CLI (Claude Max/Pro előfizetés)
- Telegram fiók

## Dokumentáció

Részletes, funkciónkénti leírások a [`docs/`](docs/README.md) mappában.

| Terület | Lap |
|---------|-----|
| Ügynök-flotta + inter-agent | [docs/agent-fleet.md](docs/agent-fleet.md) |
| Memória-rendszer (FTS5 + vektor + RRF) | [docs/memory-system.md](docs/memory-system.md) |
| Kanban (auto-breakdown, swimlane, WIP, Gantt) | [docs/kanban.md](docs/kanban.md) |
| Heartbeat + fokozatos autonómia | [docs/heartbeat-autonomy.md](docs/heartbeat-autonomy.md) |
| Vault & titkosítás | [docs/vault.md](docs/vault.md) |
| Biztonság-keményítés | [docs/security-hardening.md](docs/security-hardening.md) |
| Ütemezett feladatok | [docs/scheduled-tasks.md](docs/scheduled-tasks.md) |
| Háttér-feladatok | [docs/background-tasks.md](docs/background-tasks.md) |
| Skill-factory (öntanulás) | [docs/skill-factory.md](docs/skill-factory.md) |
| Channels (Telegram / Slack) | [docs/channels.md](docs/channels.md) |
| Költöztetés másik gépre | [docs/MIGRATION.md](docs/MIGRATION.md) |
| Konfiguráció-referencia | [docs/config-reference.md](docs/config-reference.md) |

## Alap és köszönet

Ez a rendszer a **[Marveen](https://github.com/Szotasz/marveen)** (Szota Szabolcs, "AI a mindennapokban") keretrendszerre épül, és több külső projektre. A teljes forrás/szerző/licensz-felsorolás az [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) fájlban. Köszönet a Perplexity AI-nek (Bumblebee), Artem Zhutovnak (handoff / retrospective / skill-management skill-suite), Mike Van Hornnak (printing-press), Andrej Karpathynak (CLAUDE.md-minta és a kódminőségi alapelvek) és Matt Pococknak (handoff-design tippek) a munkájukért.

**Az alap-projekt készítője:** Szota Szabolcs — AI-konzultáns, az "AI a mindennapokban" csatorna alapítója. Az alap-Marveen közössége és támogató-anyagai:

- **Skool közösség**: [skool.com/ai-a-mindennapokban](https://skool.com/ai-a-mindennapokban)
- **YouTube**: [AI a mindennapokban](https://www.youtube.com/@aiamindennapokban)
- **Weboldal**: [aiamindennapokban.hu](https://aiamindennapokban.hu)

Ez a fork (`R4CK/mikrob`) saját, elkülönült telepítés — a fenti csatornák az alap-keretrendszer forrásaihoz vezetnek, nem ehhez a forkhoz.
