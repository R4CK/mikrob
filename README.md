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

## Teljes funkciólista

A `CLAUDE.md` "Teljes funkciólista karbantartás" szabálya szerint: a kilenc alaprendszer mindegyikéhez user story, tényleges user flow, frontend-státusz (konkrét dashboard-oldalra hivatkozva) és ismert-hiány jelölés. A dashboard-oldalak azonosítói (`data-page`) és a `web/index.html`/`web/app-sidebar-groups.js` tényleges menüszerkezete ellen ellenőrizve, nem feltételezve. Ahol egy user flow élő böngészős végigjárása erősebb bizonyíték lenne, azt jelöltem — ez a lista kódalapú audit, nem T Eszter-féle élő UI-bejárás.

### 1. Memória-rendszer
- **User story:** Mint Peti, szeretném, hogy MikroB emlékezzen a korábbi döntésekre és kontextusra anélkül, hogy mindent újra el kellene mondanom, hogy a beszélgetéseink folytatólagosak legyenek.
- **User flow:** Az ügynök munka közben automatikusan ment emléket (hot/warm/cold/shared tier) → a dashboard **Memóriák** oldalán (`memories`) kulcsszó/kategória szerint kereshető, hibrid FTS5+vektor (RRF) találati sorrenddel → egy emlék szerkeszthető/törölhető a listából → a napi napló automatikusan összefoglalja a nap emlékeit, megtekinthető a **Napló** oldalon (`naplo`).
- **Frontend:** van — Memóriák oldal (`memories`, a `knowledge` sidebar-csoportban) + Napló oldal (`naplo`, a `system` csoportban, ide olvadt be a korábbi külön Recall nézet).
- **Hiányzó funkció:** nincs ismert hiány ezen az ellenőrzésen; élő UI-bejárással (T Eszter/QA) erősíthető meg a szerkesztés/törlés flow pontossága.

### 2. Kanban tábla
- **User story:** Mint Peti, szeretném látni és irányítani tudni, hogy a flotta melyik ügynöke min dolgozik éppen, hogy ne kelljen minden feladatot manuálisan követnem.
- **User flow:** Kártya létrejön (Peti kérésére vagy AI auto-bontással) → felelős + prioritás + `[NN%]` haladás a címben → állapot-oszlopok között mozog (planned → in_progress → waiting → done) → swimlane/Gantt-nézet a **Kanban** oldalon (`kanban`, önálló, nem csoportosított sidebar-link, mindjárt az Áttekintés alatt) → kártya-esemény audit a **Napló** oldalon követhető.
- **Frontend:** van — Kanban oldal (`kanban`), pinned top-level link.
- **Hiányzó funkció:** nincs ismert hiány.

### 3. Heartbeat + fokozatos autonómia
- **User story:** Mint Peti, szeretném, hogy MikroB proaktívan ellenőrizze a háttérben a fontos dolgokat (naptár, email, kanban), de csak akkor szóljon, ha tényleg van tennivaló, és szintenként szabályozhassam, mennyit tehet egyedül.
- **User flow:** Heartbeat-ütemezés létrehozása/szerkesztése az **Ütemezések** oldalon (`tasks`, "Heartbeat (csak ha fontos)" típus + sablon-választó) → a heartbeat lefut, csendben ellenőriz → csak fontos találatnál küld Telegram-üzenetet → az autonómia-szint kategóriánként állítható a **Beállítások** oldalon (`settings`, Autonómia-szekció, `app-autonomy.js`) → 1/2/3 szint (csak jelez / javasol+jóváhagyás / autonóm+jelent).
- **Frontend:** részleges — a funkció két külön oldalra oszlik (Ütemezések a heartbeat-ütemezéshez, Beállítások az autonómia-szintekhez), nincs egy dedikált "Heartbeat" oldal ami a kettőt együtt mutatná.
- **Hiányzó funkció:** egy összevont heartbeat-áttekintő nézet (utolsó futás, mit talált, mit jelzett) jelenleg nincs — a heartbeat-találatok a Telegram-üzenetekben/naplóban élnek, nincs dedikált dashboard-widget rájuk.

### 4. Web dashboard (Mission Control)
- **User story:** Mint Peti, szeretnék böngészőből egy helyen mindent látni és irányítani (memória, kanban, ügynökök, ütemezés, Vault), hogy ne kelljen mindent Telegramon keresztül intéznem.
- **User flow:** Bejelentkezés (Bearer-token vagy per-device jelszó, `resolveAuth`/`requiresAuth`) → **Áttekintés** oldal (`overview`, pinned top-level, ez a landing) → oldalsáv 5 csoportba rendezve (Csapat, Tudás, Statisztika, Rendszer, Kapcsolatok) + 3 pinned link (Áttekintés, Kanban, Jóváhagyások) → mobilon PWA-ként telepíthető (lásd [docs/mobil-dashboard.md](docs/mobil-dashboard.md)).
- **Frontend:** van — ez maga a frontend, http://localhost:3420.
- **Hiányzó funkció:** nincs ismert hiány.

### 5. Napi napló
- **User story:** Mint Peti, szeretnék egy automatikus, olvasható összefoglalót kapni arról, mi történt aznap az ügynökökkel, hogy ne kelljen a nyers memória-bejegyzéseket egyenként átnéznem.
- **User flow:** Ügynök munka közben appendeli a napi naplót (`POST /api/daily-log`) → a **Napló** oldalon (`naplo`) időrendben, forrás-fülek szerint szűrve (Összes / napi napló / beállítás-változás / ötletláda-státuszváltás / store-fájlesemény) megtekinthető.
- **Frontend:** van — Napló oldal (`naplo`), a korábbi külön Recall nézet is ebbe olvadt.
- **Hiányzó funkció:** nincs ismert hiány.

### 6. Inter-agent kommunikáció
- **User story:** Mint egy flotta-ügynök, szeretnék feladatot delegálni egy másik ügynöknek anélkül, hogy Petinek kellene közvetítenie, hogy a munka gyorsabban haladjon.
- **User flow:** Ügynök `POST /api/messages`-t hív (`from`/`to`/`content`) → a célpont ügynök tmux session-jébe automatikusan beíródik `[Üzenet @küldő-től]:` formátumban → a célpont feldolgozza és a saját csatornáján válaszol → a teljes üzenetváltás megtekinthető az **Üzenetek** oldalon (`messages`, Csapat csoport).
- **Frontend:** van — Üzenetek oldal (`messages`).
- **Hiányzó funkció:** nincs ismert hiány.

### 7. Föderáció
- **User story:** Mint Peti, szeretném két önálló MikroB-példányt (pl. két gépen futó telepítést) össze tudni kötni, hogy az egyik ügynökei a másik szakértőit is elérhessék.
- **User flow:** **Föderáció** oldal (`federation`, Kapcsolatok csoport) → "Kapcsolódási adataim" szekció: Tailscale-bejelentkezés egy gombbal (automatikusan futtatja a `tailscale up` + `tailscale serve --bg`-t, kitölti a Rendszer-azonosító + Elérési cím mezőket) → ezeket átadva a másik rendszer adminjának, társ-párosítás → utána `<rendszer>/<ügynök>` alakú címzéssel üzenet küldhető a társ ügynökeinek a megszokott üzenet-API-n.
- **Frontend:** van — Föderáció oldal (`federation`).
- **Hiányzó funkció:** nincs ismert hiány (a Tailscale-bekötés user flow-ja és biztonsági korlátai kártyákkal `0985ac83`/`b68ddae8` dokumentáltak, gate-elve).

### 8. Skill-rendszer (öntanulás)
- **User story:** Mint egy flotta-ügynök, szeretném, hogy a visszatérő, összetett feladatokból tanuljak, és a megoldást újrafelhasználható recept (skill) formájában elmentsem, hogy legközelebb ne kelljen újra kitalálnom.
- **User flow:** Komplex feladat/hiba-recovery után az ügynök automatikusan `SKILL.md`-t ír (`~/.claude/skills/` globális vagy `agents/<ügynök>/.claude/skills/` egyéni) → progresszív betöltés (3 szint: név+leírás / teljes SKILL.md / segédfájlok) → a **Skillek** oldalon (`skills`, Tudás csoport) böngészhető, kereshető → egy napi ütemezett rutin (`skill-besorolas-napi`) besorolja az új skilleket közös vagy célzott-ügynök kategóriába.
- **Frontend:** van — Skillek oldal (`skills`).
- **Hiányzó funkció:** nincs ismert hiány.

### 9. Kvóta-kezelés + lokális-LLM offload
- **User story:** Mint Peti, szeretném látni, mennyi van hátra az 5 órás és heti Claude-keretből, és szeretném, hogy a flotta a mechanikus munkát automatikusan a helyi GPU-ra terelje, hogy ne fogyjon el a keret idő előtt.
- **User flow:** **Áttekintés** oldalon (`overview`, a landing lap) — heti-limit % gauge, modell-lépcső panel (melyik ügynök melyik modellen fut, read-only), token-költség widget "Részletek →" linkkel → a link a **Költségek** oldalra (`costs`, Statisztika csoport) navigál, ahol a havi $ költség-főkönyv (jelenlegi költés, hónap-végi előrejelzés) látszik — ez a monthly CostOps-ledger, elkülönítve a heti Claude-limit %-tól → **Lokális LLM** oldal (`localLlm`, Rendszer csoport) — Ollama-státusz (modell/GPU/quota-bridge), modellcsere, Kategóriák-szekció (mely feladat-típusok mennek helyi modellre, élő be/ki kapcsolóval) → limit-elérésnél automatikus Telegram-figyelmeztetés + reset-countdown.
- **Frontend:** van — Áttekintés oldal (`overview`, heti-limit + modell-lépcső) + Költségek oldal (`costs`, havi $ ledger) + Lokális LLM oldal (`localLlm`).
- **Hiányzó funkció:** nincs ismert hiány.

## Szerepkörönkénti user story és user flow

**Fontos, elöljáróban (a `src/web/auth-gate.ts` ellen ellenőrizve):** ennek a rendszernek nincs finomszemcsés, kódolt jogosultsági mátrixa a dashboard API-n — az `resolveAuth()` öt hitelesítési MÓDOT különböztet meg (Bearer dashboard-token / per-device kulcs / SSE-token / föderációs token / session-cookie), de a `kind: 'token'`, `kind: 'device'` és `kind: 'session'` UGYANAZT az API-hozzáférést kapja: bármelyik érvényes hitelesítés bármelyik `/api/*` végponthoz hozzáfér, nincs kódban ellenőrzött "csak a saját kártyáját módosíthatja" vagy "csak Peti törölhet" szabály. Az alábbi szerepek tehát **operatív/társadalmi megkülönböztetések** (ki mit csinál a flotta-workflow szerint, `CLAUDE.md`), NEM API-szinten kikényszerített jogosultsági szintek — az egyetlen KÓDBAN kikényszerített korlátozás a föderációs társ szűkítése (lásd lent). Ez maga is egy jelzett hiányosság, nem elhallgatva.

### Peti (tulajdonos)
- **User story:** Mint a rendszer tulajdonosa, szeretnék teljes rálátást és irányítást a flotta felett, Telegramon és böngészőből egyaránt, hogy bármikor beavatkozhassak.
- **User flow:** Telegramon a saját fiókjából ír bármelyik ügynöknek (owner-csatorna, `chat_id: 0` a reply toolban) → a dashboardra Bearer-tokennel vagy saját jelszavas session-nel lép be → minden oldalt, minden API-t elér (a fenti bekezdés szerint nincs is kódolt korlátozás, ami ezt szűkítené) → Level-2 autonómia-kéréseket jóváhagy/elutasít (`/api/approvals`) → Vault-tartalmat, kanban force-close-t, rollback-öt csak ő indíthat élesben (`recovery-prev-version.sh --to <sha> --force` — ez emberi kéz, MikroB magától nem futtatja).
- **Frontend:** van, teljes — minden oldal.
- **Hiányzó funkció:** nincs (ő a legmagasabb jogú szerep operatívan, még ha kódban ez nincs is külön kikényszerítve).

### MikroB (orchestrator ügynök)
- **User story:** Mint MikroB, szeretnék koordinálni a flottát, dispatchelni a kártyákat, és csak akkor zavarni Petit, ha tényleg szükséges, hogy a munka önjáró maradjon.
- **User flow:** Saját Telegram-csatornán fogadja Peti kéréseit → a kanbanon Fázis/Feladat/alfeladat bontást csinál, felelősöket rendel → figyeli a `waiting`+REVIEW kártyákat, a gate-verdikteket, és zárja a `done`-ra kész kártyákat (4-5. szabály) → a dashboardot ugyanazzal a Bearer-tokennel éri el, mint bárki más hitelesített fél (lásd fent — nincs neki külön "orchestrator" API-scope).
- **Frontend:** van, teljes API-hozzáférés — de nincs a dashboardon egy dedikált "orchestrátor" nézet, ami KIFEJEZETTEN az ő dispatch-munkafolyamatát vizualizálná (pl. "kire vár most melyik kártya" egy nézetben); ezt jelenleg kanban-szűréssel + kártya-kommentekkel oldja meg.
- **Hiányzó funkció:** dedikált orchestrátor-munkafelület (dispatch-sor, gate-státusz egy nézetben) — jelenleg a sima Kanban oldal szolgál erre, szűréssel.

### Szerep-ügynök (backend, backend2, qa, qa2, cybersec, cybered, fron-ted, fron-teddy, fullstack, jogasz, marketing, penzugy, teszter, videooo)
- **User story:** Mint egy szerep-ügynök, szeretném elvégezni a rám osztott kártyákat, és ha kész vagyok, a helyes gate-hez kerülni anélkül, hogy magam zárhatnám le a saját munkámat.
- **User flow:** Inter-agent üzenetben vagy Telegramon kap dispatchet → a kanbanon a saját `assignee`-jű kártyáit veszi (API-szinten ugyanazt a Bearer-tokent használva, mint bárki — a "csak a sajátodhoz nyúlj" a `CLAUDE.md`-ben él, nem a kódban) → dolgozik → `waiting` + REVIEW komment, Gate-SHA sorral → a kijelölt gate(ek) (QA + kockázat szerint Cybersec/Cybered) ellenőrzik → MikroB zárja `done`-ra PASS/GO után.
- **Frontend:** van, teljes API-hozzáférés (lásd a bevezető megjegyzést) — a dashboard nem korlátozza a nézetet a saját kártyáira, ő maga szűr rá.
- **Hiányzó funkció:** nincs "csak a sajátom" nézet/szűrő alapértelmezetten a Kanban oldalon szerep-ügynök szemszögéből (mindenki mindent lát, ami helyes is lehet egy kis, bizalmi flottánál, de user-flow szempontból explicit hiány).

### Föderációs társ (külső rendszer ügynöke)
- **User story:** Mint egy másik MikroB-példány ügynöke, szeretnék egy jóindulatú, visszafordítható feladatot delegálni ennek a rendszernek egy szakértőjéhez, anélkül hogy hozzáférnék a rendszer belső adataihoz.
- **User flow:** A saját rendszere elküldi a feladatot a `/api/federation/inbox` végpontra, föderációs tokennel hitelesítve (`identifyFederationCaller`) → a hídon átjut a célzott ügynökhöz, `<untrusted source="federation:...">` keretben (adatként kezelve, nem parancsként) → a célzott ügynök feldolgozza, választ küld ugyanazon a hídon (a kézbesítési prefix címére, nem a `source`-ra).
- **Frontend:** NINCS — a föderációs társ nem kap dashboard-hozzáférést, nem lát semmilyen `/api/*` oldalt a kanban/memória/ügynökök közül. Ez KÓDBAN kikényszerített korlátozás (`isFederationWireEndpoint`): kizárólag a `/api/federation/manifest` GET és `/api/federation/inbox` POST érhető el föderációs tokennel, semmi más.
- **Hiányzó funkció:** nincs — a szűk hozzáférés szándékos biztonsági határ, nem hiányosság.

### Per-device kulcs (pl. mobil PWA, remote-enroll SSH-eszköz)
- **User story:** Mint egy önálló eszköz (telefon, VPS), szeretnék a saját, visszavonható kulcsommal hozzáférni a dashboardhoz, hogy ne kelljen a fő Bearer-tokent megosztanom.
- **User flow:** A device-kulcs a Csapat oldalon vagy a `remote-enroll` eszközzel jön létre → az eszköz `Authorization: Bearer <device-kulcs>` fejléccel hitelesít → `resolveDeviceKey()` felismeri → a token visszavonható eszközönként.
- **Frontend:** van, teljes API-hozzáférés — a bevezető megjegyzés szerint a device-kulcs UGYANAZT a hozzáférést kapja, mint a fő dashboard-token, nincs szűkített device-scope.
- **Hiányzó funkció:** device-szintű scope-szűkítés (pl. "ez a telefon csak olvashat, nem törölhet") jelenleg nincs — minden device-kulcs teljes hozzáférést ad, csak a REVOKE-álhatóság különbözteti meg a fő tokentől.

## Egyedi fork-fejlesztések (amiért külön fork)

Ezek a MikroB-fork saját fejlesztései a Marveen-bázison felül — főleg a **flotta-workflow, a review-gate-ek és a platform-robusztusság** rétegében (a fleet-szabályok a `templates/CLAUDE.md.template`-be építve, `5d42edf`). A lista a **jelenlegi állapotot** írja le; a korábbi, azóta felülírt/megszűnt fejlesztéseket nem tartalmazza (a történeti részletek a git-log-ban élnek).

- **Kockázat-alapú review-gate rendszer**: minden kész kártyát min. 2 független ügynök ellenőriz — **QA mindig**, plusz a kockázat szerint **Cybersec** (trust-boundary: auth, publikus endpoint, RBAC, pénz, PII, file-upload) és/vagy **Cybered** (magas-tétű: publikus write path, session, superadmin). A készítő SOHA nem ellenőrzi a sajátját; MikroB kártyánként rotálja a gate-tagokat, és csak PASS/GO után zár.
- **Teljes értékű audit protokoll**: kötelező leltár (MINDEN gomb + endpoint) → RBAC pozitív/negatív (fail-closed) → superadmin-folyamatok → minden API + DB-művelet → optimalizálás számokkal → STRIDE/OWASP + WCAG + i18n + reziliencia. Semmi nem implicit: ami nincs tesztelve, az „töröttnek" számít.
- **Fleet-workflow**: 4+ szintű Fázis→Feladat→alfeladat bontás (parent/child kanban), felelős + `[NN%]`-marker + színes ügynök-label, 10 perces beragadás-detektálás, **dinamikus park-ellenőrzés** (minden futó szerep-agentet — nem hardkódolt névlistát — leállít, ha nincs élő munkája, a kvóta védelmére), **frontend-pairing** (user-facing feature automatikusan kap Fron Ted UI + user-flow kártyát), **flow-connectivity** (minden user-flow a valós backend-funkciókhoz drótozva).
- **Kvóta-menedzsment, két rendszerben**: (1) **5 órás session-limit** figyelés + banner-detektálás, auto-resume a valós reset-időre. (2) **Heti-% rendszer**, EGYETLEN forrásból (egy script olvassa ki a heti %-ot, egy fájlba írja mindkét küszöböt) — ugyanaz a szám két fokozatú választ vált ki: **60%-nál** (`newDevStopActive`) csak az ÚJ planned-kártya dispatch áll le (gate-munka + folyamatban lévő kártyák mennek tovább, idle nem-gate ügynökök parkolásra kerülnek); **90/92/95%-nál** (dinamikus, a resetig hátralévő idő szerint) minden — a gate-munka is — leáll. A két küszöb ugyanabból az adatból, ugyanazon a válaszúton fut, csak eltérő szigorral.
- **npm-only csomagkezelő-őr (`preinstall`)**: a `package-lock.json` a követett lockfile (az `update.sh`/`install-*.sh`/`recovery-prev-version.sh` mind `npm ci` + `npm rebuild better-sqlite3 --build-from-source` + `npm run build`) — egy idegen csomagkezelő (pnpm/yarn) csendben lecserélheti egy ÉLŐ szolgáltatás függőségi fáját és eltörheti a better-sqlite3 natív bindingját. A `scripts/assert-npm-package-manager.mjs` `preinstall`-őr ezt hangossá teszi: kizárólag POZITÍV pnpm/yarn jelre utasít el, ismeretlen/hiányzó agent esetén átenged.
- **Update-biztonság + recovery**: `update.sh` ff-only pull + auto-stash + rollback-pont (`store/.update-history`), `recovery-prev-version.sh` korábbi known-good verzióra (a `store/` adat érintetlen); fork-tudatos verzió-ellenőrzés (az update-checker a tracked branchet — `develop` — kérdezi).
- **Rollback distance-guard (`store/rollback-guard.sh`)**: az automatikus visszaállás nem hisz vakon a rollback-célnak. Mindhárom hívó (`update.sh` build-bukás, `store/update-finalize.sh` health-check, `recovery-prev-version.sh`) csak akkor állít vissza, ha a cél őse a HEAD-nek, legfeljebb 50 committal van hátra, és tartalmazza a padló-commitot (`5bc0983`); különben MEGTAGADJA, a jelenlegi verzión marad, és értesít (`rollback-refused` a `store/.update-history`-ban). Emberi felülbírálás: `--force`. A `scripts/start.sh` induláskor karanténba teszi a duplikált `store/update-health-watchdog.sh`-t, ha visszakerülne. Oka: 2026-08-06-án egy elavult cél háromszor, egyenként 529 committal vitte vissza az élő installt, minden alkalommal „sikerként" naplózva.
- **Landed-check (`store/fix-landed-check.sh`)**: a „kész" kártya és a valóság közti szakadékot méri. Egy commitra megmondja, merge-elve van-e az integrációs ágba, benne van-e az élő install HEAD-fájában, a fájljai a lemezen vannak-e, és a `dist` ebből épült-e; `--sweep` móddal a kanban REVIEW-kommentjeiből kiszedett commitokra futtatva megmutatja, mely gate-elt munka nincs valójában élesben. Read-only. Oka: 2026-08-06-án egy délután alatt három kártyán derült ki ugyanaz — a fix megvolt, tesztelt és gate-elt, de csak egy feature-ágon élt, és a legrosszabb esetben maga a recidiva-védelem (rollback-guard) volt csak papíron.
- **Modell-alapértelmezés: a distribution default EGYENLŐ a fallback-lánc primary-jével** (Peti 2026-08-06, kártya `d041760b`). A `DISTRIBUTION_DEFAULT_AGENT_MODEL` nálunk `claude-opus-5`, míg az upstream `claude-opus-5[1m]`-et szállít. Ez tudatos fork-divergencia, nem lemaradás: a `DEFAULT_MODEL_CHAIN[0]` az, amire egy kvóta-revert VISSZAKAPASZKODIK, tehát egy a lánc primary-je FÖLÖTT álló alapértelmezés az új ágens első revertjét néma DOWNGRADE-dé tenné. Az upstream lánc primary-je ráadásul még `claude-opus-4-8[1m]`, amit Peti kivezetett a mi létránkból. A `model-suggest` teszt a konstanst a lánc-primaryhez köti, nem literálhoz — így a kettő nem tud szétcsúszni, és egy jövőbeli upstream-bump sem csúszhat be némán.
- **Upstream-frissítés-figyelés, két rétegben**: a dashboard áttekintés-nézete folyamatosan (15 percenként, `update-checker.ts`) összeveti a forkot a felmenő Szotasz/marveen-nel és FRISSÍTÉS-BANNERT mutat, ha van lemaradás (`/api/overview`, `getUpdateStatus().marveen.behind`). Emellett egy **napi ütemezett Telegram-digest** (`szotasz-marveen-daily-check.sh`) ugyanezt a cache-et olvassa ki és jelez Petinek, ha a lemaradás száma változott (dedupe azonos értékre) — a passzív dashboard-banner mellett egy aktív napi jelzés is van.
- **Upstream-frissítés telepítése: elemzés + kockázat + biztonságos restart** (Peti 2026-08-04): a „Frissítés telepítése" gomb (Eredeti Marveen blokk) a mergeelés ELŐTT elemzi a bejövő upstream-commiteket (`analyzeUpstreamChanges`) — hány commit, mely fájlokat érinti, és melyik fájlt módosítottuk MI IS a merge-base óta (a valódi ütközés-kockázati zóna) —, ezt Telegramon jelzi, majd fetch+merge után átadja az irányítást az `update.sh`-nak egy új `POST_MERGE_MODE=1` módban: a pull-lépést kihagyva ugyanaz a rebuild + restart + health-check + auto-rollback fut le, mint a fork-saját frissítésnél (`store/update-finalize.sh`), és a kimenetről Peti Telegramon kap visszajelzést (siker/rollback/kézi-beavatkozás).
- **WSL-natív üzemeltetés**: cross-platform Node-pin (Linux/WSL rendszer-node fallback a better-sqlite3 ABI-hoz), Windows-boot autostart (WSL-en belül systemd + linger, Windows-oldali indító); az installer a `sqlite3` és `jq` CLI-t is telepíti.
- **Többrétegű self-healing (befagyás-védelem)**: a channels-session befagyását több, egymástól független réteg kapja el, sebészi recovery-vel. (1) A dashboard in-process channel-monitorja respawnolja a süket paneleket; (2) három független systemd --user guard-timer — `channel-watchdog`, `stuck-modal-guard`, `disk-space-guard` — akkor is futnak, ha a dashboard halott; (3) egy Windows-oldali WSL-watchdog (Scheduled Task) a TELJES VM-akadásra, csak tartós (≈15 perc) akadás után indítja újra a distrót. Reprodukálható installerek (`scripts/install-guard-timers.sh`, `scripts/install-wsl-watchdog.sh`) → újrainstall és minden boot után magától települ/self-heal.
- **Verziókövetett operatív scriptek + tracked CLAUDE.md**: a monitor-scriptek (`store/*.sh`: kvóta, beragadás, pre-dispatch) trackeltek, és a **`CLAUDE.md` is verziókövetett** (nem gitignored) — a runtime-adat (DB, token, state) ignorált marad.
- **Öntanuló skill-flotta**: 83 seed-skill, köztük mély kód-elemzők (`code-comprehension`, `function-explanation`, `refactoring-support`, `defensive-security-analysis`) és egy i18n-locale lint-guard; az ügynökök a visszatérő gate-hibákból tanulnak és patchelik a saját skilljeiket.
- **Projekt-agnosztikus skillek (kötelező szabály)**: egyetlen skill sem tartalmazhat projekt/termék nevet — a `seed-fleet-agents/` NEM hardkódol telepítés-specifikus abszolút utat sem (`__MARVEEN_INSTALL_DIR__` / `__MARVEEN_HOME__` portability-sentinel, amit az installer a valós útra old fel).
- **Dedikált e2e-tesztelő ügynök (T Eszter)**: külön flotta-ügynök az élő, böngészős e2e tesztelésre (Playwright MCP, valós Chromium). RBAC-hierarchikus, user-story-vezérelt módszertan: funkciónként/flow-nként min. 5 user story, mindegyik pozitív + negatív (jogosulatlan szerver-oldali fail-closed) bizonyítékkal. NEM gate-tag: a bizonyítékait a QA gate használja.
- **MCP-titkok a vaultból, kapcsolódáskor feloldva — sem a configokban, sem környezeti változóban**: az `mcpServers` bejegyzések nem hordoznak élő kulcsot, és a titok már környezeti változóba sem kerül. A `resend` MCP-szerver bejegyzésében nincs `headers`, helyette `headersHelper: "<repo>/scripts/vault-headers-helper.sh Authorization=Bearer:::ReSend"` — Claude Code minden kapcsolódáskor (és 401/403 után újra) lefuttatja a helpert, az a vaultból oldja fel a `ReSend` bejegyzést, és a kész `Authorization` fejlécet adja vissza JSON-ként. A lemezen csak a vault-azonosító marad. Egyik indító út sem exportál `RESEND_API_KEY`-t (`startAgentProcess` flotta-ügynökök, `buildMainSessionRespawnCmd` fő-session respawn, worker-launcher, `scripts/channels.sh` hidegindítás), és a korábbi `store/.resend-api-key` kulcsfájl is megszűnt (kártyák `0ea08957` / `5b7aba05`, az `f8db701c` env-dump incidens után) — így a titok sem a felépített parancs-stringben, sem a `ps`/argv-ben, sem egy ágens-folyamat KÖRNYEZETÉBEN nem jelenik meg, tehát egy `env`-kiíratás sem szivárogtathatja ki. Ha a vault-bejegyzés hiányzik, a helper a fejlécet KIHAGYJA (stderr-figyelmeztetéssel) és a Resend-hívás hitelesítés nélkül elbukik — nincs csendes visszaesés beégetett kulcsra. Regressziós teszt (`src/__tests__/resend-key-env.test.ts`) őrzi: ALAKRA keres (`export RESEND_API_KEY`, `RESEND_API_KEY=`), nem névre, hogy egy átnevezett visszaszivárgás se ússza meg.
- **Per-ügynök skill-hozzárendelés (közös + célzott)**: a skillek kétszintűek — közös (`~/.claude/skills/`, minden ügynök) és egyéni/célzott (`agents/<ügynök>/.claude/skills/`). Egy napi ütemezett rutin (`skill-besorolas-napi`) az ÚJ skilleket besorolja közös vagy célzott-ügynök kategóriába.
- **Lokális-LLM offload rendszer (WSL GPU)**: a flotta a jól körülhatárolt, mechanikus kód/szöveg-részfeladatokat egy helyi Ollama-modellre (GTX 1660 Ti, `qwen2.5-coder:7b`) offloadolja Claude-token helyett — `store/local-llm.sh` (nyers kliens) + `store/local-llm-rag.sh` (memória-RAG wrapper). A taxonómia jelenleg **67 kategóriát** fed le (kód, backend/infra, frontend/minőség, dokumentáció, feature/architektúra-jellegű draftok), egy napi felülvizsgálati rutinnal (`local-llm-category-weekly-review`, péntekenként) bővítve. A dashboard **Lokális LLM** oldala: státusz (ollama/modell/GPU/quota-bridge), modellcsere + `ollama pull`, egy **Kategóriák** szekció ami MINDEN preset-et élőben listáz hívásszámmal + valódi be/ki kapcsolóval (`/api/local-llm/categories`, nem dekoratív — a funnel-pont ellenőrzi), és egy Használat-mérő. Egy **kódolási-nehézségi küszöb** (triviális < izolált < modul < feature < architektúra) a 7B megbízható határánál (`module`) KEMÉNYEN sapkázva: a `feature`/`architektúra` szint MINDIG online marad. Egy **proaktív offload-flag** a heti-limit ALATT is bekapcsolja az aktív offloadot (SessionStart-hookon keresztül minden ügynök sessionjébe automatikusan bekerül). **Ghost vészmód-híd** (`quota-bridge`): kvóta-fagyáskor a helyi modell + memória-RAG felel a Telegramon a resetig.
- **Lokális-LLM auto-router policy-jel-család** (`src/local-llm-router.ts`): az offload-router a mechanikus-vs-online döntésnél a veszélyes authz/policy-megfogalmazásokat (access-default, tenant-scope-drop, validáció-kliensre-tolás, jogosultság-emelés) ONLINE-ra kényszeríti — a döntés a jel-CSALÁDRA általánosít, nem szó szerinti string-mintára, hedge/bizonytalan vagy üres input szintén ONLINE-ra esik (fail-closed alapállás). A router MINDEN `local-llm-rag.sh` híváson lefut, ALAPÉRTELMEZÉSBEN (`--no-route` az explicit kilépő); korábban egy `--auto` flag mögött ült, amit egyetlen dokumentált flotta-hívás sem adott át, tehát a gyakorlatban egyik ügynök útján sem futott. Ha a router nincs lefordítva (nincs `dist/local-llm-router.js`), a hívás ONLINE-ra esik a helyi draft helyett -- a megítéletlen irány a veszélyes. **Az ELAVULT build ugyanígy viselkedik** (kártya `a3611ecc`): minden hívás összeveti a betöltendő artefaktumot a forrással, amiből épült (`store/build-freshness.mjs`, a router dist-import-closure-je, ~1,8 ms hívásonként), és ha bármelyik forrás újabb -- vagy ha a frissesség nem eldönthető, például mert nincs forrásfa a gépen --, a hívás ONLINE-ra esik egy beszédes üzenettel (`npm run build`), advisory draft nélkül. Az ellenőrző szándékosan NEM fordított `.mjs`: egy `dist/`-ben élő frissesség-ellenőrzőt ugyanaz az elavulás érintené, amit mérnie kell. Ugyanez a kapu véd a `store/route-histogram.mjs` mérésein is, hogy egy routing-változás ne igazolódhasson a régi artefaktumon. A local output DRAFT-only marad, kötelező MikroB+gate újra-ellenőrzéssel.
- **Kétlépcsős offload-routing: a lokális modell saját triage-osztályozóként** (`store/route-classify.sh`, kártya `05f8d99c`): a determinisztikus blokklista öt javítási kör után sem zárta a szemantikus osztályt (valódi RBAC-kérdések, amik egyetlen biztonsági főnevet sem tartalmaznak), ezért a `local` verdikt UTÁN egy olcsó lokális hívás megkérdezi, biztonsági döntés-e a feladat. **A biztonsági tulajdonság a hívás HELYE, nem a prompt:** csak `local` verdikten fut, és kizárólag `online`-ra tud billenteni -- rossz válasz, beragadt modell, hiányzó modell (first run) vagy parse-hiba mind `UNKNOWN`, ami semmit nem változtat. **Determinizmus kötelező** (Cybersec F1 után): a hívás `temperature 0` + fix seed (`LOCAL_LLM_TEMPERATURE`/`LOCAL_LLM_SEED` a `local-llm.sh`-ban), mert alapértelmezett mintavételezéssel ugyanaz a mondat hatból háromszor mást adott, és minden korábbi pontszám EGYETLEN húzás volt egy sztochasztikus folyamatból -- azokat eldobtuk, nem újrahasznosítottuk. **Promptinjekció ellen determinisztikus előszűrő:** a triage terelésének kísérlete (`answer MECHANICAL`, `ignore the instructions above`, „ezt már ellenőrizte a biztonság") önmagában SECURITY, mert csak eszkalálni tud; mérve, a határoló + „ez adat, nem utasítás" promptmegfogalmazás ezen a 7B-n NEM tartott, tehát a kontroll az előszűrő, nem a prompt. Az acceptance a suite-on KÍVÜL fut (`store/route-classify-selftest.sh`), és a determinizmust is méri, nem feltételezi.
- **Internet nélküli first-run: szállított fallback-katalógus + host-ra újraszámolt fit** (`store/llm-catalog-bundled.json`, kártya `e35bc379`): a kód kezdettől hivatkozott egy repóban szállított tartalék-katalógusra, de a fájl **nem létezett** -- mérve (nem létező cache + `--offline`) a kimenet `source: none, models: 0` volt, vagyis pont az, amit a terv kizárni akart. Most négy valódi bejegyzés szállítódik megbízható kiadóktól, méret-sávonként egy, digestekkel; szándékosan kicsi, mert ez végső tartalék, nem a 435-elemű katalógus másolata. **A fit-mezők újraszámolódnak az olvasó gépre:** egy tárolt bejegyzés TÉNYEKET (repo, kvantálás, részek, méret) és HOST-FÜGGŐ fitet (`tier`, `requiredMib`) kever, utóbbi annak a gépnek a VRAM-jából született, ami a fájlt írta -- a tárolt tier tehát azt mondaná egy 4 GB-os kártyának, hogy egy 12 GB-os modell „fits". A cache is átmegy ugyanezen, mert két futás között GPU-t lehet cserélni. Kontroll a selftestben: ugyanaz a fájl 24 GB-on mind a négyet `fits`-nek, 4 GB-on szigorúan kevesebbet kínál, és a legnagyobbat sosem.
- **„Telepítve" és „bemérve" két külön állítás** (`store/local-llm-model-state.json`, kártya `d730070e`): a katalógus-séma kezdettől hordozta az `installedAt`/`benchmarkedAt` mezőt, mindkettőt null-ra drótozva (a selftest még állította is, hogy mindig az marad) -- vagyis két mező volt, állapot nélkül, és semmi nem tudta megkülönböztetni a bemért modellt attól, amit egy perce húztunk le. Ez a kártya lényege: „letöltődött" nem bizonyíték arra, hogy használható kódot ad. Két tény, két forrás: az `installedAt` az ollama saját `modified_at`-jéből jön (kézzel húzott modellre is helyes, nincs új író), a `benchmarkedAt` pedig abból az állapot-fájlból, amit **kizárólag** a `store/local-llm-bench.sh` ír, és csak sikeres futás után -- egy fájlt, ami azt állítja hogy mérés történt, a mérő írjon. **Szándékosan NEM a `trusted` mezőbe olvad** (a kártya szó szerinti szövege ellenére): a `trusted` a KIADÓ-bizalmat jelenti, és ha egy gyors bemérés átbillentené, akkor egy nem jóváhagyott kiadó modellje attól lenne „megbízható", hogy gyors -- egy flag, két kérdés, pont az a hibaosztály, amit ez az EPIC most távolított el ugyanebből a fájlból. A `--use` mostantól tényt mond (bemérve mikor és mennyivel, vagy hogy még nincs), nem minden váltásnál ugyanazt a figyelmeztetést.
- **Kiadó-bizalmi kapu a flotta-alapértelmezett modell váltásán** (`store/first-run-llm.sh --use`, kártya `eb843c46`): a telepített súly a flotta kód-javasló orákuluma lesz, ezért két külön kérdés dől el két külön listán (`store/llm-catalog-trust.json`): a RELEVANCIA-lista azt mondja meg, kódoló modell-e (olcsó adat-szerkesztés), a BIZALMI lista azt, hogy **telepíthető**-e (biztonsági kontroll). A már meglévő digest-ellenőrzés arra felel, hogy a bájtok azok-e, amiket katalogizáltunk -- a kiadó megbízhatóságára nem, mert egy hűségesen leszállított backdoor is illeszkedik a saját digestjéhez. Ezért a `trustedPublishers`-en KÍVÜLI kiadó (és a katalógus-bejegyzés nélküli modell, ami ennél is gyengébb) esetén a váltás megáll, kiírja **mire épül a döntés** (kiadó, letöltésszám, részek száma, teljes 64-hexes digestek részenként), és az operátornak vissza kell **neveznie a kiadót** (`--i-trust <publisher>`) -- egy puszta i/n válaszolható lenne olvasás nélkül. TTY nélkül ugyanígy viselkedik (egy cső nem „igen"), de nem is zsákutca: a megnevezés az egyetlen, naplózott kiút. **A döntés FORRÁSA a felülvizsgált lista, nem a cache** (Cybersec F1 után): a `store/llm-catalog-cache.json` (gitignore-olt, ügynökök által írható, derivált) csak TÉNYT szolgáltat (kiadó, letöltésszám, részek, digestek), a bizalmi döntést a kapu **döntés-időben újraszámolja** a trackelt `llm-catalog-trust.json`-ból -- különben egy cache-flag átbillentése kapu nélkül tenné a flotta orákulumává bármelyik modellt, és egy incidens utáni visszavonás nulla hatással lenne a már cache-elt bejegyzésekre. Hiányzó/olvashatatlan bizalmi lista = NEM megbízható (fail-closed). Viselkedési tesztek: `src/__tests__/first-run-publisher-trust-gate.test.ts`. **Második ajtó, ugyanaz a döntés** (Cybersec talált, `src/local-llm-model-trust.ts`): a dashboard "használd ezt a modellt" gombja a `POST /api/local-llm/model` útvonalon a CLI-től FÜGGETLEN logikával csak a modell nevét és a letöltöttségét ellenőrizte -- egy őrzött és egy őrizetlen ajtó ugyanarra az erőforrásra (`store/local-llm-model`, amiből minden ügynök draftja készül) nem kontroll, hanem megkerülés. A döntés mostantól EGY implementációban van, mindkét ajtó ugyanazt hívja: digest-eltérésnél a végpont `409`-et ad, felülbírálás nélkül (a lemezen lévő bájtok nem azok, amiket katalogizáltunk -- erre nincs mit tudatosan jóváhagyni). **Nem-jóváhagyott kiadónál a HTTP-ajtó NINCS megerősíthető -- egyáltalán nem fogad el ilyen váltást** (kártya `d297f26f`, Cybersec maradék-lelet a `eb843c46`-on, MikroB döntése). Korábban egy `iTrust` mezőt fogadott el, a `basis.confirmWith` ellen ellenőrizve -- de az az érték UGYANEBBŐL a válaszból jött egy kéréssel korábban, tehát a "megerősítés" hitelesítés nélküli visszhang volt: bármi, ami a dashboard tokent birtokolja (minden flotta-ügynök), két automata kéréssel törölhette, anélkül hogy egy ember valaha elolvasta volna a kiadó/letöltésszám/digest bizonyítékot, amit a megerősítő képernyő mutatni hivatott. A CLI saját `--i-trust` válasza ugyanolyan alakú, de az odáig jutáshoz VALÓDI shell-hozzáférés kell a hoszthoz -- ez az egyetlen csatorna, ami őszintén állíthatja, hogy egy ember olvasta el a képernyőt. Ez az ajtó tehát MINDIG elutasítja a nem-jóváhagyott kiadót (a válasz megmutatja a teljes döntés-alapot és a pontos CLI-parancsot, de a HTTP-ajtóra semmi visszaküldött adat nem tudja ezt megkerülni) -- a **már aktív modell újbóli megerősítésére sincs kivétel**: egy szűkített, csak-erre-az-esetre szóló HTTP-visszhang ugyanaz a hitelesítés nélküli bypass-alak maradna, csak ritkábban kihasználható. A Fron Ted UI (korábban kártya `fa8959cd`, megerősítő modallal) és a hozzá tartozó `src/__tests__/local-llm-trust-confirm-ui-wiring.test.ts` emiatt TÖRLÉSRE kerültek -- nincs mit megerősíteni egy ajtón, ami semmilyen választ nem fogad el.
- **Az „Ajánlott modellek" katalógus-nézet repónkénti csoportosítva, mért sebességgel** (`web/app.js`, kártya `88ea5050`, Peti direktívája 2026-08-14): a lapos katalógus egy sor kvantálásonként -- a valódi cache ezen a gépen 448 sor 37 HF repón, tehát flat listaként használhatatlan. A csoportosítás kulcsa a `repo` mező: ez pontosan az a granularitás, amit Peti kért ("Qwen2.5-Coder család egy csoport"), és nem igényel névelemzést, mert a letöltésszám/kiadó-bizalom már eleve repó-szintű tény (minden kvantálás ugyanazt hordozza, lásd a backend sort-komment). Csoportonként EGY kártya, fejlécben a repó-szintű tényekkel (kiadó-bizalom, letöltésszám) és egy `<select>`-tel a további kvantálás-változatokhoz, ha egynél több van -- a változtás a már letöltött adatból újrarendereli csak azt a kártyát, nincs újra-fetch. A rendezett lista első csoportja kap egy **Ajánlott** jelölést (a backend sorrend maga az ajánlat, lásd a `models.sort` kommentjét). **`tokensPerSecond` végre megjelenik** (MikroB/backend2 lelete, `4117f98e` következménye: a mező korábban SEHOL nem jelent meg, se 0-ként, se hiányzóként -- a "null amíg nincs mérve" szerződés az utolsó lépésnél veszett el): mért szám esetén a szám, egyébként egy explicit "nem mért" állapot, sosem 0 vagy kihagyva. Belépő animáció (`prefers-reduced-motion` tiszteletben tartva), a kvantálás-`<select>` a meglévő `.llm-select` alapot örökli, tehát a 44px érintési célméret (13. szabály) ingyen jár. UI-drótozás: `src/__tests__/local-llm-catalog-ui-wiring.test.ts`.
- **Update-biztos közösségi átvétel + git-repo-watcher**: a bevált nyílt-forrású skillek/eszközök átvétele KIZÁRÓLAG additív fork-fájlként (`seed-skills/`, `store/*.sh`, MCP a repón kívül) — sosem felmenő core-fájl szerkesztésével. A `git-repo-watcher` scheduled task figyeli a bekötött upstream repókat: szöveg-adoptációk (skill/doc) azonnal ff-frissülnek, külső **futtatható kód** változásnál csak DETEKTÁL + FLAG-el (supply-chain-ellenőrzés + Peti-értesítés) — sosem fut vakon kompromittálható upstream commit a flottán.
- **Adopt-9 közösségi átvétel + Karpathy kódminőségi alapelvek**: 6 doc/skill/index repo (anthropics/skills, shanraisshan/claude-code-best-practice, jqueryscript/awesome-claude-code, VoltAgent/awesome-agent-skills, alirezarezvani/claude-skills, FlorianBruniaux/claude-code-ultimate-guide) klónozva a repón kívülre (`~/.claude/external/`) + napi sync + registry. A 3 futtatható eszköz (atlassian-labs/mcp-compressor, ooples/token-optimizer-mcp, yamadashy/repomix) NEM települ vakon: Cybersec-gate előbb. Andrej Karpathy 4 kódminőségi alapelve (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution) beolvasztva a `CLAUDE.md`-be, attribúcióval.
- **anthropics/skills: per-skill licenc szerinti kettős átvétel (ADOPT 1/10)**: a hivatalos Anthropic példa-skill repóban NINCS root LICENSE — minden skill a SAJÁT `LICENSE.txt`-ét hozza, és a kettő nem ugyanaz. Az Apache-2.0-s skillekből a helyi könyvtárból hiányzó kettő VENDOROLVA van (`~/.claude/skills/mcp-builder`, `~/.claude/skills/webapp-testing`, `store/vendor-skill.sh --ref f17010c9`, `VENDORED.md` + `UPSTREAM-LICENSE` mellette, két külön `watched-repos.json` bejegyzéssel, hogy egy upstream változás subdir-enként külön reviewt kapjon). A négy dokumentum-skill (`docx`/`pdf`/`pptx`/`xlsx`) EZZEL SZEMBEN Anthropic-proprietary source-available: a licencük kifejezetten tiltja a másolatok Services-en kívüli tartását és a származékos művet, ezért NEM vendoroljuk — a hivatalos plugin-marketplace-en jönnek be (`document-skills@anthropic-agent-skills`, commit-SHA-ra pinelve). A `doc-coauthoring` egyáltalán nem hoz LICENSE-t, tehát kimarad. A korábbi „README-MIT, informális grant" besorolás javítva a registryben: az engedett volna egy licencsértő verbatim vendorolást.
- **mcp-compressor: csak-könyvtár adopció, GO-ra zárva**: az `@atlassian/mcp-compressor` N-API tömörítő modulja KÖZVETLENÜL hívva, a sebezhető `serve` út SOHA nem fordul le — prebuilt addon, pinelt verzió, `--ignore-scripts`, a csomag a repón KÍVÜL él (`store/mcp-compress.sh`). Kísérő: `mcp-compressor-upstream-watch` scheduled task, ami re-gate-et vált ki, ha az upstream csomag frissül.
- **Beépített repók oldal — teljes adoptáció-lista + install-állapot**: a dashboard „Beépített repók" oldala (`/api/integrated-repos`) MINDEN adoptált fejlesztést listáz — kézzel hozzáadott GitHub-repókat ÉS vendorolt skilleket/MCP-ket/eszközöket, `adoption` + `pinnedVersion` + származtatott `installed` mezővel (a pipx-adopciók helyesen „✓ telepítve"-ként jelennek meg, nem hiányzóként).
- **CostOps + heti-limit % gauge, auto-olvasással**: havi költség-főkönyv (`src/costops/`, `/api/costs/*` + Költségek dashboard-oldal) plusz egy heti Claude-limit % gauge az áttekintésen. Az elsődleges forrás egy dedikált, izolált credential-tárban élő `/usage` panel (`mikrob-usage-probe`): a `weekly-usage-panel-read.sh` 30 percenként kiolvassa MINDEN sávot (session/heti/Fable/promo), és reboot után is magától újraéleszti a panelt az izolált tárból — csak akkor kér böngészős újra-belépést, ha maga a refresh token is lejárt. A manuális pillanatkép (`/api/costs/weekly` POST) fallback marad arra az esetre, ha az auto-olvasás nem elérhető.
- **Heti-% modell-lépcső, per-ügynök a SAJÁT bázisáról, hard Haiku-tiltással**: ahogy a heti Claude-keret %-a nő, minden szerep-ügynök egy lépcsővel lejjebb lép a modell-létrán (a munka NEM áll le, csak olcsóbb modellen fut). A létra **egyetlen forrásból** jön (`src/model-catalog.ts`: `CLAUDE_MODELS` + `MODEL_LADDER`, ár/képesség szerint csökkenő: **Fable 5 > Opus 5 > Opus 4.8 > Sonnet 5 > Sonnet 4.6 > Haiku 4.5**), ugyanabból, mint az ügynök-modellválasztó dropdown. A lépés **per-ügynök, a saját bázis-modelljéről** relatív (`weeklyTargetModel(base, tier)`), a bázis tartósan perzisztált (`store/model-tier-baseline.json`) — egy dashboard-restart alatt leléptetett ügynök is a saját bázisára áll vissza a heti resetkor. **Kódoló ügynökök (backend, backend2, cybered, cybersec, fullstack) SOHA nem eshetnek a legolcsóbb (Haiku) rungra** (`NO_HAIKU_AGENTS` + `applyNoHaikuFloor` — a heti rámpa ilyenkor a második legolcsóbb rungon állj meg). A dashboard **Modell-lépcső** panelje read-only ügynök-állapotot mutat (`GET /api/costs/model-fallback/agents`). mikrob-channels kivétel (sosem lép le).
- **Publikus fleet-digest endpoint** (`GET /api/public-digest`): egyetlen, szándékosan unauth read-only státusz-végpont, ami CSAK nem-azonosító aggregált adatot ad (ügynök-darabszám, verzió, timestamp) — SOHA nem szivárogtat ügynök-nevet/id-t, utat, tokent vagy PII-t. Fail-closed: bármely hibára minimális `{ ok:false }`.
- **Gemini API kulcs (bring-your-own-key) integráció**: opcionális, felhasználó-adta Gemini API kulcs a dashboard Settings/Integrációk menüjében — AES-256-GCM-titkosított tárolás, probe-validáció mentés előtt (fail-closed), a nyers kulcs SOHA nem jut kliensre/logba/URL-be.
- **Host-restart-osztályozás + bot-token health-guard**: a self-healing réteg két read-only diagnosztikai watchdoggal bővült — a host-restart-watchdog megnevezi az előző leállás okát (OOM-kill / poweroff / crash / unknown), egy periodikus bot-token health-guard külön 401/revoked-riasztást ad, ha a channel-token lejár/visszavonják (a token SOHA nem kerül argv-be/logba).
- **Projekt-prioritás a kiosztásnál (14. szabály)**: a valódi projekt-(termék-)feladatok mindig magasabb dispatch-prioritást élveznek a nem-projekt (infrastruktúra/fork-integráció/meta) munkánál.
- **Per-kontakt kommunikációs kalibráció (`contact-calibration-profile` skill)**: egy ügynök egy visszatérő emberi kontaktushoz igazíthatja a kommunikációt egy gépi-olvasható profil alapján — nyelv/verbozitás/tiltott fordulatok + egy fogalom-tudásgráf (0-3 szint), amit az ügynök beszélgetési jelekre (megkérdezi „mi az X" / helyesen használja) frissít. Nincs backend-kód/endpoint, csak a meglévő fájl+memória mechanizmus.
- **Token-égés elleni re-dispatch guard** (`store/redispatch-guard.sh`): mielőtt bármely monitor (stuck-card, fleet-nudger, gate-reconciler, folyamatos-munka) meglökne vagy újra-dispatchelne egy kártyát, egy közös guardon kell átmennie — liveness-check, progress-check, kártyánkénti exponenciális backoff és HARD CAP 3 (utána EGYSZER Petinek eszkalál). Közös atomikus ledger (`store/redispatch-ledger.json`), a token headerfile-ból olvasva, sosem argv-ben. Ez zárja ki a „lassú-de-élő kártyát Xszer újra-fejlesztjük" token-spirált.
- **Gate-ébresztés csak valódi munkára** (`store/fleet-nudger.sh`): a nudger korábban „van bármilyen `waiting` kártya" alapon ébresztette mind a négy gate-ügynököt — ez ezen a táblán állandóan igaz (70 waiting kártya, ebből 49 `BLOKKOLT-*`), tehát percenként felébresztett négy ügynököt, akiknek gyakran nulla megválaszolandó kártyájuk volt (Cybered mérése: 17 találatból 17 hamis pozitív). Most kártyánként ÜGYNÖKÖNKÉNT dönt: kiesnek a `BLOKKOLT-*` címűek, a maradékra pedig a meglévő `store/gate-dispatch-check.sh` mondja meg, hogy az adott ügynök verdiktje-e a legfrissebb szó (új: `decide` alparancs stdin-ről + `ADVISE-SKIP:no-review` a beadás nélküli kártyákra). Egy kártya kommentjeit futásonként legfeljebb EGYSZER kéri le (mérve: 5 lekérés/futás a naiv 84 helyett). Ellenőrizhető: `store/fleet-nudger-selftest.sh` hamis dashboardon futtatja a VALÓDI scriptet és állítja, kit ébresztene (pozitív + két negatív kontroll); `--dry-run` a valós táblán mutatja a döntést ébresztés nélkül.
- **Server-oldali brand-bake**: a dashboard a konfigurált `BRAND_NAME`-et (`.env`) már az ELSŐ paintbe besüti a tab-title + mobil-topbar + oldalsáv-brand slotokba, így soha nem villan fel és nem ragad be egy cache-elt „Marveen" default.
- **Lokális-LLM GPU-hangolás + mért bizonyíték**: az Ollama-szolgáltatás `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0` beállítással fut — mérve (`store/local-llm-bench.sh`) mérhető GPU-arány/KV-cache/tok-s javulás a 6 GiB-os GTX 1660 Ti-n. A benchmark-script újrafuttatható, tehát az állítás ellenőrizhető, nem hitre épül.
- **Gate pre-triage (helyi, determinisztikus)** (`store/gate-pretriage.sh`): a QA/Cybersec gate ELŐTT lefutó, ingyenes, gép-oldali első kör, ami a visszatérő mechanikus hiba-osztályokat listázza (hiányzó teszt a változott kódra, vacuous assertion, parancssorba került titok, CSP-t sértő inline style, tsc-állapot stb.). **Sosem ad verdiktet** (`verdict: null`) — a gate bemenete, nem helyettesítője. Bekötve a gate-folyamatba (`store/gate-pretriage-card.sh <cardId>`): a `gate-reconciler` ezt futtatja, mielőtt egy gate-et dispatchelne.
- **Rate-limit kulcs-normalizálás keményítés**: az IP-alapú rate-limit kulcs a PARSE-olt IPv6-csoportokból bontja ki az IPv4-mapped címeket, szigorú range-check-kel — bezárja az IPv6-reprezentáció-váltogatásos rate-limit-bypasst anélkül, hogy IPv4-kizárásos DoS-t nyitna.
- **Automatikus kontextus-compact a nagy ügynökökön** (`store/context-compact-monitor.sh` + `context-compact-live` ütemezett feladat, 15 percenként, `type=command` → 0 token/futás): a flotta prompt-cache találati aránya 98,4%, tehát nem a cache-busting a költség, hanem az ÚJRAOLVASOTT kontextus MENNYISÉGE (mérve: 49,3 Mrd cache-read token; backend/backend2/cybered 450-480k/hívás a ~1M-es plafon felé). A monitor a `token_usage` táblából olvassa ki ügynökönként a friss kontextus-méretet, és a küszöb fölött `/compact`-ot küld a dashboard `POST /api/agents/<ügynök>/compact` útján. A küszöb **SZÁZALÉKOS és SZÁMÍTOTT** (Peti szabálya, `CLAUDE.md` 2026-08-14): a cél-ügynök modelljének kontextusablakából `COMPACT_PCT`% (alap: 75%) -- nem rögzített token-szám, mert az modellenként mást jelent. Az ablak a flotta SAJÁT `contextLimitForModel` függvényéből jön (`src/context-guard.ts`), nem külön táblából: az opus-családot 1M-nek, a sonnetet 200k-nak méri (mérésre hivatkozva), ismeretlen modellt pedig konzervatívan 200k-nak. A számláló a hívás TELJES prompt-mérete (`input + cache_read + cache_creation`), nem a `cache_read` önmagában -- utóbbi kihagyja a nem-cachelt prefixet, tehát egy arányszáma nem az ablak aránya. A mérés MINDIG egyetlen sorból jön (a legfrissebb valós hívás), így egy halott session csúcsa nem párosulhat egy friss időbélyeggel — ugyanazon a panel-mutexen, sosem közvetlen `tmux send-keys`-szel. Négy anti-burn kapu: csak a mért plafon-futó ügynökök (a `mikrob` orchestrator szándékosan KIMARAD), csak a küszöb fölött, ügynökönkénti 45 perces cooldown, és 20 percnél régebbi mérésre nem lép (a parkolt ügynököt nem ébreszti fel). A sérülés-ág egyben **tripwire**: két EGYMÁS UTÁNI karanténtól inter-agent riasztást küld MikroB-nak, mert ez az ág soha nem legitim (ismételt sérüléssel a compact-védelem tartósan kikapcsolható lenne). A cooldown-állapot **fail-CLOSED**: sérült/olvashatatlan state-fájlnál a kör kimarad, a fájl karanténba kerül és minden cél-ügynök „épp most compactolva" bélyeget kap — a korábbi fail-open változat egy csonka JSON-tól csendben kikapcsolta volna a cooldown-t az egész flottára. Az állapotírás atomi (temp + `fsync` + `os.replace`). A döntési logika és a state-réteg `--selftest`-tel ellenőrizhető (20 eset), a hatás `--dry-run`-nal előre megnézhető.
- **Gate-round-boundary anchoring a Gate-SHA-ra, négy adverzariális kör után keményítve** (`src/web/kanban-gate-completeness-guard.ts`, kártya `1da2367a`): a 4. munkavégzési szabály (minden kijelölt gate-nek FRISS verdiktet kell adnia a legutóbbi commitra) mögötti tényleges kérdés — melyik komment számít "az aktuális kör kezdetének" — négy Cybersec-NO-GO próba alatt bizonyult finomabbnak, mint elsőre tűnt. 1. kör: a határ a legutóbb EMLÍTETT Gate-SHA-hoz kötve, nem a komment-szöveghez ("REVIEW" szó), hogy egy szöveg nélküli builder-átadás is mozdítsa a határt. 2. kör: a saját QA "REVIEW: QA PASS" verdikt-szövege ne induljon el új körnek csak azért, mert a "REVIEW" szót tartalmazza. 3-4. kör: a határ a MINDEN valaha idézett Gate-SHA közül a LEGUTÓBB ELŐSZÖR EMLÍTETT sha bevezetési ideje, függetlenül attól, melyik komment említette utoljára — mert egy késői, csak egy már lecserélt sha-t visszaidéző retrospektív komment ("a regressziót erre vezettük vissza") a korábbi (3. köri) logikával vissza tudta rántani a határt egy elavult, azóta felülírt verdikthez. Minden kört adverzariális Cybersec-teszteset rögzít a `kanban-gate-completeness-guard.test.ts`-ben, hogy a hibaosztály ne térjen vissza.
- **`web/app.js` folyamatos szeletelése — a NULLA-konfliktus overlay-elv skálázása** (kártya `241532d8` folytatása, 44 `web/app-*.js` szelet ezen a mérésen, az eredeti monolit 785 sorra apadt): minden szelet saját fájl + saját `<script>`-tag, ugyanazzal a mintával mint a `web/fork-*.js` overlay-ek — egy jövőbeli upstream `app.js`-módosítás konfliktus-felülete a szeletelt résszel arányosan csökken, mert a `git merge` diff-alapú, nem fájl-alapú. A `fork-upstream-conflict-guard.test.ts` minden szeletelésnél újramér, tehát egy szeletelés, ami véletlenül visszaír egy upstream-owned függvényt egyetlen fájlba, azonnal piros.

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
| Konfiguráció-referencia | [docs/config-reference.md](docs/config-reference.md) |
| Dashboard belépés — visszaút, vészhelyzeti reset | [docs/dashboard-auth-recovery.md](docs/dashboard-auth-recovery.md) |
| Flotta migráció (export / import másik gépre) | [docs/flotta-migracio.md](docs/flotta-migracio.md) |
| Google Docs helper | [docs/google-docs.md](docs/google-docs.md) |
| Ötletláda | [docs/ideabox.md](docs/ideabox.md) |
| Proaktív hírszerző (intel registry) | [docs/intel-registry.md](docs/intel-registry.md) |
| Kutatás oldal | [docs/kutatas.md](docs/kutatas.md) |
| Dashboard mobilon (Tailscale, PWA) | [docs/mobil-dashboard.md](docs/mobil-dashboard.md) |
| Napló — Audit idővonal | [docs/naplo-audit.md](docs/naplo-audit.md) |
| Tippek, trükkök | [docs/tippek-trukkok.md](docs/tippek-trukkok.md) |
| Token Usage Monitor | [docs/token-usage.md](docs/token-usage.md) |
| Hangüzenetek (per-agent voice) | [docs/voice.md](docs/voice.md) |
| Archivált kártyák | [docs/archivalt-kartyak.md](docs/archivalt-kartyak.md) |

> A fork emellett követi a felmenő Marveen kiadásait is (pl. **v1.19.0**: SSH Vault, owner-gated terminál-input, kanban kártya-esemény audit, dashboard auth-keményítés). Legutóbb integrálva: **v1.31.0** (2026-08-07, kártya `f5e4279b`) — 9 commit, `git merge upstream/main`, egyetlen tartalmi konfliktussal (`src/__tests__/setup/assert-not-live-install.ts`: mindkét oldal UGYANAZT a hibát javította, hogy a teszt-megtagadás ne `/tmp`-be küldje a futtatót; a fork `store/fleet-test.sh` remedyjét tartottuk meg, mert az többet tud egy csupasz worktree-nél, és upstream indoklását átvettük) plusz a szokásos `package-lock.json` (upstream oldalról regenerálva). **Mérve, nem feltételezve:** a merge által ELTÁVOLÍTOTT sorokat fájlonként visszaellenőriztem a merge-base ellen — mind a 34 eltávolított sor upstream SAJÁT régi kódja volt, fork-specifikus sor NEM veszett el. Új: telepítéskori Telegram bot-token próba-hívás, a foglalt token elutasítása mentéskor emberi remedyvel, a modell-feloldás egységesítése minden respawn-úton, macOS disk-space-reaper javítás. FORK-DIVERGENCIA, tudatosan megtartva: az upstream `DISTRIBUTION_DEFAULT_AGENT_MODEL` értéke `claude-opus-5[1m]`, a miénk `claude-opus-5` — a mi invariánsunk (`d041760b`, Peti 2026-08-06), hogy a distribution default EGYENLŐ a `DEFAULT_MODEL_CHAIN[0]`-val, különben egy új ágens első kvóta-revertje néma DOWNGRADE lenne; ráadásul az upstream lánc primary-je még `claude-opus-4-8[1m]`, amit Peti kivezetett a mi létránkból. Az upstream idevágó tesztjét a fork-invariánsra igazítottam (a konstans a lánc-primaryhez van kötve, nem literálhoz, hogy a kettő ne tudjon szétcsúszni). Előtte: **v1.30.3** (2026-08-07, kártya `12893509`) — 6 commit, egyetlen mechanikus lockfile-konfliktussal. Előtte: **v1.28.1** (2026-08-02, Peti jóváhagyás, fázis-kártya `97403f62`) — a napi Szotasz/marveen frissítés-ellenőrzés jelezte a 23-commit lemaradást. Módszer ezúttal ELTÉR a korábbi cherry-pick-mintától: teljes `git merge upstream/main` (nem egyenkénti cherry-pick), mert a `git merge-tree` előzetes ellenőrzés csak **4 konfliktust** mutatott, mind a már ismert megosztott fájlokban (`install-linux.sh`, `package-lock.json`, `scripts/channels.sh`, egy add/add teszt-ütközés) — a blanket merge itt biztonságos volt, mert a fork-divergencia pontosan behatárolható és minden konfliktust kézzel, a fork-érték megtartásával oldottam fel. 9 új commit: telepítő-őszinteség folytatása (heartbeat-riport mérésen alapul, nem feltételezésen), **apt-lock guard, ami néma gépeken ölte meg a telepítést**, egy később hozzáadott MCP-szerver mostantól eléri a már létező izolált config-direkeket, minden alap telepítés helyesen kap saját (nem rotálódó megosztott) hitelesítő adatot, restart-badge szöveg pontosítás. Konfliktus-feloldás: `install-linux.sh` — upstream hibakezelés-javítását (`if`/`else` néma-hiba helyett) vettem át, DE a fork `${WD_UNIT}.timer` sorát megtartottam az engedélyezési listában; `scripts/channels.sh` — a fork biztonsági javítását (token 0600 header-fájlban, nem argv-ban, `b267df80`) megtartottam upstream régebbi, sebezhető változata helyett; `package-lock.json` — upstream verzióból regenerálva (`npm install --package-lock-only`); egy teszt add/add ütközésnél a fork bash-verzió-toleránsabb assertion-jét tartottam meg. Teljes ellenőrzés: 274/274 teszt-fájl, 3775/3777 teszt zöld (2 skip), tsc + syntax-check tiszta, build+szolgáltatás-újraindítás+élő-ellenőrzés utólag. Előtte: **v1.28.0** (2026-08-01, kártya `3aa02ac6`) — merge-base diffből, egyenkénti `cherry-pick -x`-szel: 15 commit átvéve (telepítő-őszinteség: csak mért állítás a banner/ok-sorban; ágens-létrehozás: nem törli a könyvtárat placeholder-personalitynál + regressziós guard; **3 hook-security fix**: abszolút node-út a hook-parancsban [a bare `node` nvm alatt CSENDES gate-megkerülés volt], egy idézőjelezett hook-parancs-építő + escape-elt wired-check, és a hiányzó hook-interpreter mostantól HANGOSAN blokkol 127-es néma kilépés helyett; quarantine/agent-scaffold; MCP-szerver elér a meglévő izolált config-direkbe). **NEM átvéve, jelezve:** 3 `install-linux.sh` commit (valós fork-divergencia: a mi telepítőnk seed-fleet-agents/guard-hook/portability-sentinel réteget hordoz) (azóta **átvéve**, miután a blokkoló dashboard-munka commitolódott: `#822` placeholder-personality jelzés, `#837` restart-badge szöveg -- a fork local-LLM panelje sértetlen) + a release-rollup (duplikálna). Előtte: **v1.27.0** (2026-07-31, kártya `266d8248`) — merge-base diffből, egyenkénti `cherry-pick -x`-szel, sosem blanket merge-dzsel: worker-session halál-detektálás + naplózás (`worker-liveness.ts`, #801), az onboarding-varázsló a VALÓS agent-id-t oldja fel a függő párosítások előtt (#802), a telepítő a SZOLGÁLTATÁSOKNAK is ad auth-credentialt és **fail-closed** ha nincs (#799), a teljes lánc a `WEB_PORT`-ot követi a fix 3420 helyett (#800), a quarantine-reader fetch-allowlistje a tulajdonos egress-gate-jéből származik (#797), plusz egy dashboard-komment javítás (#805). A `v1.27.0` release-rollup commit (`489b35a`) szándékosan KIMARADT: ugyanezeket a változásokat csomagolja, átvétele duplikálna. Előtte: **v1.26.0** (2026-07) — a fork-divergencia megőrzésével átvéve: kiszervezett auth-gate (`resolveAuth`/`requiresAuth` — per-device dashboard-kulcsok + opcionális felhasználónév/jelszó böngésző-login, a Bearer-token út byte-azonos marad, a fork `/api/public-digest` unauth-kivétele megőrizve), oldalsáv-menü csoportosítás (a fork `Lokális LLM` menüpontja a RENDSZER csoportba fűzve), verziózott statikus asszetek cache-elhetősége, upstream-drift branch-figyelmeztetés a Frissítések oldalon, `remote-enroll` eszköz (device-SSH-kulcs onboarding), plusz telepítő/ütemező javítások (WSL home-clone, node@22 launchd-pin, apt-lock kivárás, token-usage költségtábla #737).

## Upstream-owned vs fork-owned fájlok

Kártya `641aca3f` (Peti weekly-stop kivétel, MikroB-dispatch), újramérve `eba65f46`-ban. A cél: egy jövőbeli `git merge upstream/develop` **NULLA konfliktust** adjon az upstream-owned fájlokon. Mielőtt bármit mozgatnánk, egy valódi `git merge --no-commit --no-ff upstream/develop` dry-run-nal (eldobható worktree) MÉRVE lett a tényleges konfliktus-felület — lásd a `src/__tests__/fork-upstream-conflict-guard.test.ts` guard-tesztet, ami ugyanezt a mérést automatizálja minden futáskor. **A cél 2026-08-14 és 2026-08-17 között teljesült** a `web/` fájlokra (kártya `241532d8`): a guard ZÖLD volt, valódi, ARMED merge dry-runnal. **2026-08-17-én ÚJRA MEGDŐLT (kártya `b91f11d8`)** -- lásd a `web/app.js` bekezdés végén a friss mérést. A guard ugyanígy pirosra vált, ha bárki visszaír fork-kódot egy megosztott upstream-függvénybe.

- **Fork-owned (csak nálunk létezik, upstream sosem nyúl hozzá)**: `CLAUDE.md`, `scripts/hooks/*.py` (guard-hookok), `seed-agents/`, `seed-skills/`, `store/*.sh` (operatív scriptek), `recovery-prev-version.sh`, `docs/*` fork-specifikus fájljai, `scripts/install-guard-timers.sh`, `scripts/install-wsl-watchdog.sh`, `scripts/startup.sh`, `scripts/dashboard-watchdog.sh`, `scripts/wsl-liveness-probe.sh`, `scripts/token-health-guard.sh`, `scripts/assert-npm-package-manager.mjs`, `web/fork-*.js` (fork-overlay scriptek) (476 fájl a jelen mérésnél — sosem szerepel egy upstream diffben, tehát ütközni sem tud).
- **Megosztott, VALÓDI merge-gondosságot igénylő fájlok (mindkét oldal aktívan írja)**: a mérés szerint jelenleg `install-linux.sh`, `install-macos.sh`, `package.json`/`package-lock.json`, `scripts/channels.sh`, `scripts/launchd-unit.sh`, `scripts/start.sh`, `src/web.ts`, `src/web/agent-process.ts`, `src/web/agent-scaffold.ts`, `src/web/heartbeat-agent-scaffold.ts`, `src/web/routes/agents.ts`, néhány `src/__tests__/*` fájl. Ezek közül **`install-linux.sh`-nak van valódi, dokumentált tartalmi divergenciája** (seed-fleet-agents + guard-hook + `MARVEEN_INSTALL_DIR` portability-sentinel réteg, lásd a v1.28.0-integráció kártyáját `3aa02ac6`) — ez marad kézi cherry-pick-kel kezelve, overlay-be nem szervezhető ki (a telepítő egyetlen shell-script, nem moduláris).
- **`web/app.js` -- a NULLA-konfliktus állítás 2026-08-13-án MEGDŐLT, 2026-08-14-én HELYREÁLLT (kártyák `eba65f46` -> `241532d8`).** A guard-teszt pontosan azt tette, amiért megírtuk: pirosra váltott, MIELŐTT egy valódi merge bárkit meglepett volna. A mért ok nem szomszédos beszúrás volt, hanem **háromutas divergencia UGYANAZON a megosztott függvényen**: a fork LECSERÉLTE a `loadUpdates()`-et (78 sor -> 27 soros diszpécser a két-repós nézetre: upstream Marveen + fork MikroB), miközben upstream ugyanezt a függvényt bővítette (#963, `renderUpdatesVersion`). Segédfüggvények kiszervezése ezt NEM oldotta volna fel -- a divergencia magában a függvényben volt. **A megoldás egy valódi overlay-seam:** a `loadUpdates()` a `web/app.js`-ben bájtra az upstream változata (a splice mindkét oldalán azonos kontextussal ellenőrizve), a fork renderelője pedig átkerült a `web/fork-updates.js`-be, ami az `app.js` UTÁN töltődik és egyetlen explicit `window.loadUpdates = forkLoadUpdates` sorral írja felül a globálist (az `app.js` mindhárom hívási helye minősítetlen `loadUpdates()` hivatkozás, tehát híváskor a globálisra oldódik). Mérve: a merge dry-run a `web/app.js`-t MÁR NEM hozza konfliktusként (merge-base `1f2c2c0`, upstream `aefa693`), a guard ARMED állapotban zöld. **Két dolog szándékosan KIMARADT ebből a kártyából:** a `handleRepoInstallClick()` az `app.js`-ben maradt (fork-only, nem ütközik, mozgatása öncélú diff lenne), és az upstream `renderUpdatesVersion` (+ a `window._updatesStatus` beállítása a `loadUpdates`-ből) NINCS beportolva a fork renderelőjébe -- az user-látható változás, saját kártyát érdemel, nem egy olyan refaktor belsejét, aminek épp az az állítása, hogy a viselkedés változatlan. **Ismert következmény:** az `app.js`-ben maradt upstream `loadUpdates()` itt holt kód, és el is szállna, ha valaha lefutna (a fork `index.html`-je az upstream `#updatesCommitList` konténerét `#updatesRepos`-ra cserélte) -- ha a `fork-updates.js` nem töltődik be, a Frissítések-oldal törik, nem degradálódik. Ugyanaz a hibamód, mint magáé az `app.js`-é.
  **2026-08-17 ÚJRA-MÉRÉS (kártya `b91f11d8`, ugyanaz a dry-run módszer):** a guard ismét PIROS a `web/app.js`-en. Merge-base változatlanul `1f2c2c0`; a fork **121 commitot** adott az `app.js`-hez a merge-base óta (a moduralizáció folytatódott, a fájl mostanra **785 sorra** apadt -- a `241532d8`-nál mért állapot óta tovább zsugorodott), upstream **3 commitot**: a már ismert és ELINTÉZETT `#963` (`loadUpdates`/`renderUpdatesVersion`, lásd fent -- ez a fájlban byte-azonos maradt upstream-mel, NEM ez okozza az új ütközést) mellett **két ÚJ**, eddig nem vizsgált: `#877` (`createCardEl` -- kártya-mozgatás `actor` mezője, self-pickup echo elleni védelem) és `#955` (context-guard idle-flush + config PUT kulcs-validáció). Mindkettő olyan függvényt bővít, amit a fork időközben KISZERVEZETT egy `app-*.js` szeletbe -- ugyanaz a mintázat, mint a `loadUpdates()`-nél, csak eggyel korábban elkapva (a `createCardEl`/context-guard kód jelenleg SEHOL nem szerepel szó szerint a fork `app.js`-ében, `grep` szerint). **A konfliktus MÉRETE is megváltozott a mechanizmus miatt, nem csak a darabszáma:** git a hiányzó közös kontextus miatt a fájl közepét (660--11704. sor a merge-worktree-ben, konfliktus-jelölőkkel felfújva) EGYETLEN óriás hunk-ként jelzi, ami a tényleges, egyenkénti eltérési pontokat elfedi -- a `#877`/`#955` azonosítása a fenti upstream-commit-listából jött, NEM a hunk kézi átolvasásából (ami ekkora méretnél nem praktikus). **Ez a kártya (`b91f11d8`) SZÁNDÉKOSAN nem old fel semmit** -- a `loadUpdates()`-mintájú overlay-seam-fix minden egyes érintett függvényre saját vizsgálatot és döntést igényel (1b. munkavégzési szabály: architekturális döntés, plan-grilling szükséges dispatch előtt), a teljes egyeztetés terjedelme a mért arány (121 fork commit vs 3 upstream commit, egyetlen ~11000 soros felfújt hunk) miatt jóval túlnő egy NORMAL kártya keretén. Javaslat: a moduralizációs epic gazdája (Fron Ted / a `241532d8` család) vegye fel önálló al-feladatként `#877`-et és `#955`-öt, és mostantól minden ÚJ, `web/app.js`-t érintő upstream commitot egyenként, a landolása után röviddel kezeljen (ne várjon a következő nagy újramérésre) -- a mostani felhalmozódás pont abból jött, hogy a `241532d8` óta senki nem nézte meg egyenként a 3 upstream commitot.
- **A guard őrzött fájllistája KÉZZEL karbantartott, és alulmér.** A `fork-upstream-conflict-guard.test.ts` négy `web/` fájlt néz; ugyanaz a dry-run **három további** ütköző fájlt hoz, amit senki nem figyel: `src/model-fallback.ts`, `src/__tests__/model-fallback.test.ts`, `src/web/update-checker.ts`. Ezek közül a `src/model-fallback.ts` **viselkedés-kritikus**: a fork SZÁNDÉKOSAN kivette az `upgrade to increase your usage limit` mintát a kvóta-detektor regexéből (2026-06-30, false positive -- a Claude Code minden friss panelben kiírja ezt slash-parancs tippként, így a frissen bootolt ügynökök limitesnek látszottak és feleslegesen downgrade-elődtek volna), upstream viszont visszatette, ÉS hozzávett egy valódi új variánst (`session limit`, 2026-08-08). Helyes feloldás: upstream `session limit` kiegészítése ÁTVÉVE, a fork `/upgrade`-eltávolítása MEGTARTVA -- egy vak "theirs" itt flotta-szintű false positive-ot hozna vissza. **ELINTÉZVE (kártya `f085fd44`, 2026-08-14):** (1) a divergencia feloldva a fenti szabály szerint a `src/model-fallback.ts`-ben, és a két fél EGYÜTT ki van pinnelve egy tesztben (`keeps BOTH halves of the fork/upstream resolution at once`) -- egy jövőbeli, egyik oldalt teljesen átvevő merge pirosra vált, nem csendben szállít; a `session limit` átvétele nem kozmetika: a `You hit your session limit ∙ resets 5:50pm` bannert semmi más minta nem fogta, tehát egy valóban limites ügynök egészségesnek látszott. (2) A guard már NEM kézi négyes listát néz: a **teljes** ütköző halmazt vizsgálja, és minden ütköző fájlnak szerepelnie kell vagy a nulla-konfliktus listán, vagy az `ACKNOWLEDGED_CONFLICTS` térképen a **leírt feloldási szabályával** együtt -- egy új, senki által nem gondozott ütközési hely azonnal piros. A három fájl feloldási szabálya ott van bevezetve (a `src/web/update-checker.ts`-nél mérve: a fork többrepós aggregát szerkezetét tartjuk, és upstream új egy-eredményes feature-jeit -- pl. a futó verzió a fejlécben, `aefa693` -- egyenként portoljuk rá).
- **Konvenció ÚJ fork-feature-ökre a `web/`-ben (mostantól)**: minden ÚJ, a meglévő upstream-függvényektől független fork-funkció saját `web/fork-<név>.js` fájlba kerül, külön `<script>`-taggel a `web/index.html`-ben (a plain-script világ valódi overlay-formája) -- a meglévő interleaved kód visszamenőleg NEM kerül kiszervezésre (kockázat/haszon rossz), de az új kód innentől ténylegesen elkülönül. A kiszolgálás EGY prefix-szabály (`src/web/routes/static.ts`): a `/fork-*.js` út alakra van engedélyezve (`fork-<kisbetűs-név>.js`, ami nem enged elválasztót, tehát traversalt sem), így a KÖVETKEZŐ overlayhez már nem kell route-módosítás. Nincs `cacheSeconds`: ezek az URL-ek nincsenek verziózva mint az `/app.js`, ezért ETag-gel revalidálnak és nem tudnak beragadni.

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
./install.sh
```

Az `install.sh` egy OS-detect wrapper: nyelvet kérdez (Magyar/English, `MARVEEN_LANG`), majd az észlelt rendszer szerint tovább-indítja a valódi telepítőt (`install-macos.sh` Darwinon, `install-linux.sh` Linuxon). A telepítő végigvezet: függőségek, Claude Code bejelentkezés, Telegram bot, a bot/márka neve, szolgáltatások indítása. Frissítés a forkból: `./update.sh` (ff-only pull az `origin`-ról).

Ha az OS-detektálást ki akarod kerülni, az OS-specifikus szkript közvetlenül is hívható (`./install-linux.sh` / `./install-macos.sh`) — funkcionálisan ugyanoda vezet, csak a nyelv-prompt és a wrapper-kényelem marad ki. **macOS-en NE hívd az `install-linux.sh`-t közvetlenül**: a két szkript ténylegesen eltérő (launchd vs. systemd guard-timerek), az `install.sh` ezért route-olja külön.

Alapértelmezés szerint a dashboard a 3420-as porton indul (`http://localhost:3420`). Egyedi port beállításához:

```bash
./install-linux.sh --port 3421   # vagy: WEB_PORT=3421 ./install-linux.sh (install-macos.sh ugyanígy)
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
./store/rollback-guard.sh --check <sha>  # elfogadható-e ez a rollback-cél?
./store/fix-landed-check.sh --commit <sha>  # tényleg földet ért-e ez a fix?
./store/fix-landed-check.sh --sweep         # mely "kész" kártyák kódja nincs élesben?
```

**Landed-check (`store/fix-landed-check.sh`).** A „commitolva" nem azonos azzal, hogy „élesben van".
Egy commitra négy kérdést válaszol meg: benne van-e az integrációs ágban (`origin/develop`), benne
van-e az élő install HEAD-fájában, az általa érintett fájlok ott vannak-e a lemezen is, és a
`dist/.built-commit` szerint tartalmazza-e a lefordított build. Első sora gép-olvasható
(`LANDED` / `NOT-LANDED <ok-lista>` / `UNKNOWN <mit-nem-lehetett-ellenőrizni>` / `ERROR:<ok>`),
exit 0/1/3/2. Az `UNKNOWN` azért kell, mert **egy le nem futott ellenőrzés nem sikeres ellenőrzés**:
hiányzó `origin/develop` ref (friss klón) vagy hiányzó `dist/.built-commit` nem lehet néma zöld.
Ugyanezért utasít el a `--sweep` érvénytelen `--limit`/`--status` értéket és a nulla lefedettséget
(`ERROR:nothing-checked`, exit 2) — egy elgépelt paraméter nem jelenthet „minden landolt"-at.
A `--sweep` a kanban REVIEW-kommentjeiből szedi ki a commitokat, és megmondja, mely késznek jelentett
kártya kódja nincs valójában élesben.
Szigorúan **csak olvas**: git plumbing, read-only SQLite, `stat` — nem mergel, nem checkoutol, nem
indít újra semmit.

A valós rollback újraindítja a szolgáltatást — éles visszaállást a tulajdonos futtat manuálisan.

**Rollback distance-guard (`store/rollback-guard.sh`).** Minden automatikus visszaállás átmegy rajta:
az `update.sh` build-bukás ága, a `store/update-finalize.sh` health-check ága és a
`recovery-prev-version.sh` is. A cél csak akkor fogadható el, ha (1) őse a jelenlegi HEAD-nek,
(2) legfeljebb 50 committal van hátra, és (3) tartalmazza a padló-commitot (`5bc0983`, ez vezette ki a
duplikált `update-health-watchdog.sh`-t). Minden más esetben a visszaállás **megtagadva**: a rendszer a
jelenlegi verzión marad, a döntés bekerül a `store/.update-history`-ba (`rollback-refused`) és a
`store/rollback-guard.log`-ba, és a tulajdonos értesítést kap. Tudatos, mélyebb visszaállás emberi
kézzel továbbra is lehetséges: `./recovery-prev-version.sh --to <sha> --force` (automata hívónak nincs
ilyen felülbírálása). Érvénytelen (nem numerikus) `ROLLBACK_GUARD_MAX_DISTANCE` az alapértékre esik
vissza, nem kapcsolja ki az ellenőrzést; minden nem-alapértelmezett konfig nyomot hagy a
`store/rollback-guard.log`-ban, mert egy gyengített biztonsági kontroll nem lehet néma.

Miért: 2026-08-06-án egy elavult rollback-cél 529 committal vitte vissza az élő installt, egymás után
háromszor, mindannyiszor „sikeres" naplóbejegyzéssel — a visszaállított fa ugyanis újra magával hozta a
régi `store/update-health-watchdog.sh`-t, ami ugyanazt az elavult célt olvasta. A `scripts/start.sh`
ezért induláskor karanténba is teszi ezt a scriptet, ha bárhogy visszakerülne
(`store/quarantine/`).

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
