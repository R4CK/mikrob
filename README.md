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

A MikroB-fork saját fejlesztései a Marveen-bázison felül, főleg a **flotta-workflow, a review-gate-ek és a platform-robusztusság** rétegében. A lista a **jelenlegi állapotot** írja le; a történeti részletek a git-logban és a `DECISIONS.md`-ben élnek.

- **Kártya-függőségek (predecessor/successor)**: irányított sorrend-él két kanban-kártya között, a `parent_id` tartalmazás-hierarchiától függetlenül. Egy nem teljesült előfeltétel visszatartja a kártyát az előrelépéstől; a bypass jogosultsághoz kötött és auditált.
- **Ügynökönkénti worktree + ellenőrzött landolás**: minden ügynök a saját git-worktree-jében dolgozik saját indexszel, a landolás pedig egy eldobható worktree-ben mergel `develop`-ba, teljes teszt után pushol.
- **Self-pace governance hard-gate**: hook, ami megakadályozza, hogy egy ügynök beütemezze a saját jövőbeli körét (cron, `tmux send-keys`, ütemezés-API, `/loop`). Az ügynök bemenet-vezérelt marad.
- **Kockázat-alapú review-gate rendszer**: minden kész kártyát legalább két független ügynök ellenőriz, QA mindig, plusz kockázat szerint Cybersec és/vagy Cybered. A készítő sosem ellenőrzi a sajátját, és csak PASS/GO után zárul a kártya.
- **Teljes értékű audit protokoll**: kötelező, sorrendezett audit-lefedettség (leltár, RBAC pozitív/negatív, superadmin-folyamatok, API + DB, teljesítmény, STRIDE/OWASP, WCAG, i18n, reziliencia). Ami nincs tesztelve, az töröttnek számít.
- **Fleet-workflow**: 4+ szintű Fázis/Feladat/alfeladat bontás parent-child kártyákkal, felelős + `[NN%]` haladásjelző + színes ügynök-label, beragadás-detektálás, dinamikus park-ellenőrzés, frontend-pairing és flow-connectivity kényszerítés.
- **Kvóta-menedzsment, két rendszerben**: az 5 órás session-limit figyelése auto-resume-mal a valós reset-időre, plusz egy heti-százalék rendszer egyetlen forrásból, ami küszöbönként előbb az új kártya-dispatchet állítja le, majd olcsóbb modellre vagy lokális draftra tereli a munkát.
- **npm-only csomagkezelő-őr**: `preinstall`-ban futó guard, ami megtagadja az idegen csomagkezelőt (pnpm/yarn), mert az csendben lecserélheti egy élő szolgáltatás függőségi fáját és eltörheti a natív SQLite-bindinget.
- **Worktree-izoláció a függőség-könyvtárban is**: az ügynök-worktree-k függőség-könyvtára eddig könyvtár-szimlink volt a megosztott klónba, ami egyetlen kontrollra (egy guard-hookra) bízta a védelmet -- egy `cd <worktree>/<dep-dir> && rm -rf ../src` a MEGOSZTOTT klón forrását törölte, mert a `cd` a feloldott könyvtárba visz. A `store/agent-worktree-deps.sh` valódi könyvtárrá alakítja; a bejegyzésenkénti szimlink NEM megoldás, csak eggyel mélyebbre tolja a kijáratot. Opt-in, worktree-nkénti rollouttal, és a lassú másolás külön szkriptben van, hogy a dispatch-utak gyors "biztosítsd hogy megvan" hívása másodperces maradjon.
- **Telepítés-hez kötött lokális-LLM állapot**: a `store/local-llm*.sh` verziókövetett, tehát futtatható másolatuk minden ügynök-worktree-ben ott van. A dashboard állapotát (modell kill-switch, kategória-kapcsolók, aktív modell, használati napló) ezért nem a szkript saját könyvtárából olvassák, hanem a FUTÓ TELEPÍTÉS store-jából, amit a checkout alakjából vezetnek le (`.git` fájl -> worktree -> fő klón). Enélkül egy worktree-ből indított hívás a dashboardon KIKAPCSOLT modellt is lefuttatta volna, mert a hiányzó állapotfájl helyesen azt jelenti, hogy nincs semmi letiltva. Ahol a levezetés nem sikerül, a szkript ezt kimondja stderr-en, nem hallgat.
- **Stray-pnpm riasztás a szolgáltatás-indulásban**: a szolgáltatások indulás előtti ellenőrzése észreveszi egy MÁR megtörtént pnpm-install nyomait, újraépíti a natív bindinget, és riaszt, nem csendben javít.
- **Fork-saját verziójelzés SemVer build-metadatával**: a verzió `X.Y.Z+mikrob.N` alakú, ahol `X.Y.Z` a változatlan upstream verzió és `N` a fork saját számlálója. A `+` szándékos: a kötőjeles pre-release SemVer szerint kisebb lenne az upstream verziónál.
- **Auto-healing update pipeline**: frissítés után health-check futtat a dashboardon, és ha az nem válaszol, magától visszaáll az előző működő verzióra. Upstream nem ismeri.
- **Update-biztonság + recovery**: ff-only pull auto-stash-sel, rollback-pont minden frissítésnél, és egy visszaállító script korábbi ismert-jó verzióra, a `store/` adat érintetlenül hagyásával.
- **Rollback distance-guard**: az automatikus visszaállás megtagadja a célt, ha az nem őse a HEAD-nek, túl messze van, vagy nem tartalmazza a padló-commitot; ilyenkor a jelenlegi verzión marad és értesít.
- **Landed-check**: read-only eszköz, ami megmondja egy commitról, hogy tényleg élesben van-e (merge-elve, a HEAD-fában, a lemezen, és a `dist` ebből épült-e). Sweep módban a kanban gate-elt kártyáit méri végig.
- **Telegram chat_id szerződés-őr**: teszt, ami kikényszeríti, hogy minden Telegram-recept valós chat ID-t adjon a `reply` toolnak. A `chat_id: 0` alak sosem működött, mégis több recept használta. Ugyanez a teszt oldja fel a ténylegesen betöltött plugin-másolatot, és bukik, ha abból hiányzik a fork-lokális `buttons` paraméter.
- **Telegram `buttons` fork-patch**: a `reply` tool koppintható inline gombjai fork-lokális szerkesztés a plugin forrásában, újraalkalmazható patch-készletként verziózva. Minden plugin-frissítés és friss telepítés után újra kell futtatni, különben a gombok némán eltűnnek; elmozdult horgonynál megtagadja az írást ahelyett, hogy félig alkalmazna.
- **Modell-alapértelmezés a fallback-lánc primary-jén**: a distribution default megegyezik a fallback-lánc első elemével, hogy egy kvóta-revert ne kerülhessen az alapértelmezés fölé. Tudatos eltérés az upstream-től.
- **Upstream-frissítés-figyelés, két rétegben**: a dashboard periodikusan összeveti a forkot a felmenő repóval és frissítés-bannert mutat, emellett egy napi Telegram-digest ugyanezt jelenti.
- **Upstream-frissítés telepítése elemzéssel**: a merge ELŐTT megmutatja, hány commit jön, mely fájlokat érinti, és melyiket módosítottuk mi is a merge-base óta (a valódi ütközési zóna), csak utána enged mergelni és biztonságosan újraindítani.
- **WSL-natív üzemeltetés**: cross-platform Node-pin a natív SQLite ABI-hoz, Windows-boot autostart (systemd + linger WSL-en belül), és az installer a szükséges CLI-eszközöket is telepíti.
- **Többrétegű self-healing (befagyás-védelem)**: a channels-session befagyását egymástól független rétegek kapják el, a dashboard in-process monitorától a külön systemd guard-timereken át egy Windows-oldali WSL-watchdogig, tehát akkor is van védelem, ha a dashboard halott.
- **Lint-racsni a landolási kapuban**: a lint-hibák száma nem nőhet egy landolással; a meglévő hátralék megmarad, de minden új hiba blokkol.
- **Blast-radius kapu**: sok modul által importált hub-fájl első szerkesztését blokkolja munkamenetenként egyszer, és kiírja a mért hívói kört, hogy a hatás a szerkesztés ELŐTT látszódjon.
- **`cd <könyvtár> && grep|sed|cat ...` permission-wedge kapu**: blokkolja azt a parancsalakot, aminél a permission-engine nem tudja feloldani a könyvtárat és jóváhagyást kér, mert egy flotta-ügynök paneljében nincs, aki válaszoljon, és a panel órákra beragad.
- **Verziókövetett operatív scriptek + tracked CLAUDE.md**: minden monitor- és operatív script, valamint a `CLAUDE.md` verziókövetett; csak a runtime-adat (DB, token, state) marad ignorált.
- **Symlinken átíró node_modules-írás strukturális blokkja**: hook + gate-worktree recept, ami megakadályozza, hogy egy worktree-ből indított fájlművelet a symlinken keresztül a MEGOSZTOTT klón közös függőségi fáját írja át.
- **Öntanuló skill-flotta**: seed-skillek (köztük mély kód-elemzők és i18n lint-guard), amiket az ügynökök a visszatérő gate-hibákból tanulva maguk patchelnek.
- **Projekt-agnosztikus skillek**: egyetlen skill sem tartalmazhat projekt- vagy terméknevet, és a szállított ügynök-sablonok sem hardkódolnak telepítés-specifikus abszolút utat (portability-sentinelt használnak, amit az installer old fel).
- **Dedikált e2e-tesztelő ügynök (T Eszter)**: külön flotta-ügynök élő, böngészős e2e tesztelésre valós Chromiumon, RBAC-hierarchikus user-story módszertannal, funkciónként pozitív és negatív bizonyítékkal. Nem gate-tag, a bizonyítékait a QA gate használja.
- **MCP-titkok a vaultból, kapcsolódáskor feloldva**: az MCP-bejegyzések nem hordoznak élő kulcsot, és a titok környezeti változóba sem kerül; egy helper adja vissza a fejlécet minden kapcsolódáskor.
- **Per-ügynök skill-hozzárendelés**: a skillek kétszintűek, közös (minden ügynök) és célzott (egy ügynök sajátja); egy napi rutin sorolja be az újakat.
- **Élő skill-másolat drift-szinkron, változás-alapú riasztással**: egy már futó ügynök saját `.claude/skills/` másolatát semmi nem frissítette egy seed-javítás után, tehát a javítás után is a régi utasításokat olvasta. Egy hatóránként futó eszköz ezt zárja: kizárólag a bizonyíthatóan csak-elavult (egy korábban kiadott verzióval byte-azonos) másolatot szinkronizálja, a kézzel patcheltet soha, és TOCTOU-őrrel átugorja azt, amit közben más írt. A riasztás a diverged **halmaz változására** szól, nem a darabszámára -- egy állandó, jogos eltérés-halmaz különben hatóránként ugyanazt az üzenetet küldené, amit két hét után senki nem olvas.
- **Lokális-LLM offload rendszer (WSL GPU)**: a jól körülhatárolt, mechanikus kód- és szövegrészfeladatokat egy helyi Ollama-modell végzi Claude-token helyett, nyers kliens + memória-RAG wrapper formában, több tucat feladat-kategóriára.
- **Lokális-LLM auto-router policy-jel-család**: az offload-router a veszélyes authz/policy-megfogalmazásokat (access-default, tenant-scope, validáció-áthelyezés, jogosultság-emelés) online-ra kényszeríti, jel-családra általánosítva, nem szó szerinti mintára; a bizonytalan vagy üres input szintén online-ra esik.
- **Kétlépcsős offload-routing**: a determinisztikus blokklista `local` verdiktje után egy olcsó lokális hívás triage-osztályozóként még egyszer megkérdezi, biztonsági döntés-e a feladat, mert a szemantikus osztályt a szó-alapú szűrés nem zárja.
- **Internet nélküli first-run**: repóban szállított fallback modell-katalógus, amit a rendszer a tényleges hostra újraszámol, hogy az első futás cache és hálózat nélkül se adjon üres listát.
- **„Telepítve" és „bemérve" két külön állítás**: a modell-katalógus külön tartja nyilván, mikor lett egy modell letöltve és mikor lett ténylegesen bemérve, tehát egy frissen lehúzott súly nem tűnik bemértnek.
- **Kiadó-bizalmi kapu a modellváltáson**: két külön lista dönt két külön kérdésről, hogy egy modell kódoló modell-e (relevancia) és hogy egyáltalán telepíthető-e (bizalmi, biztonsági kontroll), mielőtt a flotta alapértelmezettje lesz.
- **Két helyi modell, feladat szerint választva**: marad egy alapértelmezett modell minden feladatra, de egy routing-config feladattípusonként felülírhatja, ha a hívó nem adott explicit modellt.
- **„Ajánlott modellek" katalógus-nézet**: a modell-katalógus HF-repónként csoportosítva jelenik meg, mért sebességgel, mert a több száz soros lapos lista használhatatlan.
- **Modell-szintű kill switch a helyi LLM-eken**: egyetlen helyi modell kikapcsolható a dashboardról törlés nélkül (rossz kimenet vagy VRAM-hiány esetén); a letiltott modellt sem a router, sem a CLI nem használja, a lista pedig kimondottan jelzi a letiltott állapotot.
- **Update-biztos közösségi átvétel + git-repo-watcher**: a nyílt forrású skillek és eszközök átvétele kizárólag additív fork-fájlként történik, sosem felmenő core-fájl szerkesztésével; egy watcher figyeli a bekötött upstream repókat, és futtatható kód változásánál re-gate-et kér, nem frissít magától.
- **Adopt-9 közösségi átvétel + Karpathy kódminőségi alapelvek**: hat doc/skill/index repó a repón kívülre klónozva, napi szinkronnal és registryvel, plusz a négy anti-pitfall kódolási alapelv beépítve a flotta-szabályokba.
- **anthropics/skills per-skill licenc szerinti átvétel**: a hivatalos Anthropic skill-repóban nincs root licenc, minden skill a sajátját hozza, ezért az átvétel skillenként dől el, és az átvettek pinelt hivatkozással vannak vendorolva.
- **mcp-compressor csak-könyvtár adopció**: a tömörítő N-API modult közvetlenül hívjuk, a sebezhető szerver-út sosem fordul le; pinelt verzió, telepítő-script nélkül, a repón kívül, plusz egy watcher, ami upstream-frissítéskor re-gate-et vált ki.
- **Beépített repók oldal frissesség-jelzéssel**: dashboard-oldal, ami minden adoptált fejlesztést (repó, vendorolt skill, MCP, eszköz) listáz telepítés-állapottal, és repónként kimondott frissesség-státuszt mutat (naprakész / N frissítés / nem mérhető) az utolsó ellenőrzés dátumával.
- **context7 MCP-szerver**: élő, verzió-pontos könyvtár-dokumentáció remote HTTP MCP-ként bekötve, hogy a válaszok a jelenlegi API-t tükrözzék, ne a modell tanuló-adatát.
- **CostOps + heti-limit gauge**: havi költség-főkönyv saját dashboard-oldallal, plusz egy heti Claude-limit százalék-mutató, amit egy izolált credential-tárból futó szonda olvas ki automatikusan.
- **Heti-% modell-lépcső, per-ügynök**: ahogy a heti keret fogy, minden szerep-ügynök egy lépcsővel lejjebb lép a modell-létrán a SAJÁT bázisáról, tehát a munka nem áll le, csak olcsóbban fut. A létra egyetlen forrásból jön.
- **Publikus fleet-digest endpoint** (`GET /api/public-digest`): szándékosan unauth, read-only státusz-végpont, ami csak nem azonosító aggregált adatot ad, és bármely hibára fail-closed minimális választ.
- **Gemini API kulcs (bring-your-own-key)**: opcionális, felhasználó-adta Gemini kulcs a dashboard beállításai közt, titkosított tárolással és mentés előtti probe-validációval; a nyers kulcs sosem jut kliensre, logba vagy URL-be.
- **Host-restart-osztályozás + bot-token health-guard**: két read-only watchdog, az egyik megnevezi az előző leállás okát (OOM, poweroff, crash), a másik külön riaszt, ha a channel bot-tokenje lejár vagy visszavonják.
- **Projekt-prioritás a kiosztásnál**: a valódi termék-feladatok mindig magasabb dispatch-prioritást kapnak, mint az infrastruktúra- vagy meta-munka.
- **Per-kontakt kommunikációs kalibráció**: egy ügynök gépi olvasható profil alapján igazíthatja a kommunikációt egy visszatérő emberi kontaktushoz (nyelv, verbozitás, tiltott fordulatok, fogalom-tudásgráf), amit a beszélgetési jelekből frissít.
- **Token-égés elleni re-dispatch guard**: minden automata meglökés és újra-dispatch egy közös guardon megy át (liveness- és haladás-ellenőrzés, kártyánkénti exponenciális backoff, kemény felső korlát), utána egyszer eszkalál emberhez.
- **Gate-ébresztés csak valódi munkára**: a nudger csak azt a gate-ügynököt ébreszti, akinek ténylegesen van megválaszolandó kártyája, nem minden gate-et minden `waiting` kártyára.
- **Server-oldali brand-bake**: a konfigurált márkanév már az első paintbe be van sütve a címsor- és oldalsáv-slotokba, tehát sosem villan fel és nem ragad be cache-elt default.
- **Lokális-LLM GPU-hangolás mért bizonyítékkal**: az Ollama-szolgáltatás flash-attention és kvantált KV-cache mellett fut, és egy újrafuttatható benchmark-script méri a nyereséget, tehát az állítás ellenőrizhető.
- **Gate pre-triage**: a QA/Cybersec gate előtt lefutó, ingyenes, determinisztikus első kör, ami a visszatérő mechanikus hiba-osztályokat listázza (hiányzó teszt, vacuous assertion, parancssorba került titok, tsc-állapot). Sosem ad verdiktet, a gate bemenete.
- **Rate-limit kulcs-normalizálás**: az IP-alapú rate-limit kulcs a parse-olt IPv6-csoportokból bontja ki az IPv4-mapped címeket, szigorú range-check-kel, így az IPv6-reprezentáció váltogatásával nem lehet megkerülni a limitet.
- **Automatikus kontextus-compact a nagy ügynökökön**: egy ütemezett, nulla-token figyelő tömörítést indít azon az ügynökön, aminek a kontextusa a plafon felé nő, mert a költséget az újraolvasott kontextus mennyisége hajtja.
- **Gate-round-boundary anchoring**: a rendszer a Gate-SHA-hoz köti, mely kommentek tartoznak az aktuális gate-körhöz, tehát egy régi verdikt nem számít friss jóváhagyásnak a legutóbbi commitra.
- **A dashboard frontend folyamatos szeletelése**: a monolit `web/app.js` külön betöltött szeletekre bomlik, ugyanazzal az overlay-mintával, mint a fork-fájlok, így egy jövőbeli upstream módosítás konfliktus-felülete arányosan csökken.
- **Feedback-survey kikapcsolása minden ügynök-induláson**: a CLI saját munkamenet-felmérése mid-session felugorhatott és blokkolt minden bejövő forgalmat, amíg valaki kézzel el nem tüntette; a spawn ezt környezeti változóval kikapcsolja.
- **Load-brake: PSI-alapú fékezés a flotta-ügynökökön**: hiszterézissel debounce-olt terhelés-állapotgép a rendszer-nyomás alapján, ami cgroup CPU-korláttal fékezi az ügynököket túlterhelésnél, és hibás kiértékelés esetén biztonságos csak-naplózó módra esik vissza, nem állítja le a felügyeletet. Upstream nem ismeri.
- **Shebang-futtathatóság guard**: repo-szintű teszt, ami elbukik, ha egy shebanggel kezdődő követett fájl nem futtatható index-móddal van commitolva. Egy nem futtatható operatív script némán bukik (a hívó `|| true`-ja elnyeli az exit 126-ot), és a WSL-es fájlrendszer helyben eltakarja a hibát.
- **Offload-batch mechanikus-első sorrend + Ollama-leállás riasztás**: a napi lokális batch a ténylegesen offloadolható kártyákat veszi előre és kiszűri a blokkoltakat, egy külön guard pedig azonnal Telegramon riaszt, ha a helyi modell-szolgáltatás halott. Upstream nem ismeri.
- **Build-freshness őr**: látható figyelmeztetés landoláskor és egy riasztó timer, ha a lefordított `dist` elmarad a landolt forrástól, mert a landolás szándékosan nem épít és nem indít újra semmit.
- **Gate-verdikt szkenner közös szótára**: a verdikt-felismerő minták egyetlen közös könyvtárban élnek, a gate-enkénti privát másolatok helyett, és felismerik a ténylegesen használt verdikt-alakokat is.
- **Kanban-reláció-gráf**: polimorf él-tábla arról, melyik kártya melyik fájlt érintette, melyik döntéshez tartozik és melyik shán volt gate-elve. A táblát a flotta MÁR használt jelöléseiből (`Gate-SHA:`, `Pair-FE:`/`Pair-BE:`, `parent_id`) tölti fel egy kinyerő és egy git-sweep lépés, tehát nulla új tagging-teher; egy olvasó API (`GET /api/kanban/relations` + két kétugrásos végpont) szolgálja ki, a memória-oldal gráfja pedig bekapcsolható második rétegként rajzolja.
- **Fenntartott, folyamaton belüli küldő-azonosítók**: az üzenet-API megtagadja a fenntartott rendszer-küldőneveket a HTTP-felületen, tehát egy hitelesített rendszer-direktívát csak folyamaton belüli író tud létrehozni, és a címzett ezt ellenőrizni tudja. Upstream nem ismeri.
- **Helyi-LLM modell-elosztás swimlane** (`GET /api/local-llm/model-usage-buckets`): modellenként csoportosított per-feladat sorok és KPI-blokk, állítható időablakkal (30 perctől 4 óráig, csúszkával), hogy mérhető legyen, a feladat-alapú routing tényleg elosztja-e a munkát a modellek között. Az időben átfedő blokkok külön al-sorba kerülnek a modell sávján belül, sok al-sornál vékony, görgethető nézetre váltva. Upstream nem ismeri.
- **Teszt-izolált helyi-LLM állapot**: a tesztfuttatás a helyi-LLM scriptek állapotkönyvtárát eldobható könyvtárba tereli, így a suite nem tud az ÉLES használati naplóba írni. Enélkül a worktree-ből futó teszt az állapot-feloldó szabálya miatt a fő telepítés naplóját írta, és a hamis sorok a dashboard grafikonján külön modellként jelentek meg.
- **Kimenő-szöveg kapu**: hook a fő ügynök saját küldésein, ami elfogja a hiányzó magyar ékezetet, az em dasht, a dupla kötőjelet, a homoglifákat és egy lokális, repón kívüli szabályfájlból töltött névszűrőt. A szabályfájl magánszemély nevét tartalmazza, ezért sosem kerül a repóba.
- **Név-szabály admin felület**: a kimenő-szöveg kapu név/kifejezés-szűrőjét a dashboard Biztonság paneljéről lehet szerkeszteni (felvétel pontos szövegként vagy regexként, törlés, a kapu három állapotának kimondása). A mentés előtt ugyanaz a Python motor ellenőrzi a mintát, amelyik a kaput is futtatja, mert egy le nem forduló minta nem zárná be a kaput, hanem CSENDBEN kikapcsolná; a szabályfájl 0600 marad, és a minták sosem kerülnek naplóba.

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

> A fork emellett követi a felmenő Marveen kiadásait is. Legutóbb integrálva: **v1.31.0** (2026-08-07).

## Upstream-owned vs fork-owned fájlok

Kártya `641aca3f` (Peti weekly-stop kivétel, MikroB-dispatch), újramérve `eba65f46`-ban. A cél: egy jövőbeli `git merge upstream/develop` **NULLA konfliktust** adjon az upstream-owned fájlokon. Mielőtt bármit mozgatnánk, egy valódi `git merge --no-commit --no-ff upstream/develop` dry-run-nal (eldobható worktree) MÉRVE lett a tényleges konfliktus-felület — lásd a `src/__tests__/fork-upstream-conflict-guard.test.ts` guard-tesztet, ami ugyanezt a mérést automatizálja minden futáskor. **A cél 2026-08-14 és 2026-08-17 között teljesült** a `web/` fájlokra (kártya `241532d8`): a guard ZÖLD volt, valódi, ARMED merge dry-runnal. **2026-08-17-én ÚJRA MEGDŐLT (kártya `b91f11d8`)** -- lásd a `web/app.js` bekezdés végén a friss mérést. A guard ugyanígy pirosra vált, ha bárki visszaír fork-kódot egy megosztott upstream-függvénybe.

- **Fork-owned (csak nálunk létezik, upstream sosem nyúl hozzá)**: `CLAUDE.md`, `scripts/hooks/*.py` (guard-hookok), `seed-agents/`, `seed-skills/`, `store/*.sh` (operatív scriptek), `recovery-prev-version.sh`, `docs/*` fork-specifikus fájljai, `scripts/install-guard-timers.sh`, `scripts/install-wsl-watchdog.sh`, `scripts/startup.sh`, `scripts/dashboard-watchdog.sh`, `scripts/wsl-liveness-probe.sh`, `scripts/token-health-guard.sh`, `scripts/assert-npm-package-manager.mjs`, `web/fork-*.js` (fork-overlay scriptek) (476 fájl a jelen mérésnél — sosem szerepel egy upstream diffben, tehát ütközni sem tud).
- **Megosztott, VALÓDI merge-gondosságot igénylő fájlok (mindkét oldal aktívan írja)**: a mérés szerint jelenleg `install-linux.sh`, `install-macos.sh`, `package.json`/`package-lock.json`, `scripts/channels.sh`, `scripts/launchd-unit.sh`, `scripts/start.sh`, `src/web.ts`, `src/web/agent-process.ts`, `src/web/agent-scaffold.ts`, `src/web/heartbeat-agent-scaffold.ts`, `src/web/routes/agents.ts`, néhány `src/__tests__/*` fájl. Ezek közül **`install-linux.sh`-nak van valódi, dokumentált tartalmi divergenciája** (seed-fleet-agents + guard-hook + `MARVEEN_INSTALL_DIR` portability-sentinel réteg, lásd a v1.28.0-integráció kártyáját `3aa02ac6`) — ez marad kézi cherry-pick-kel kezelve, overlay-be nem szervezhető ki (a telepítő egyetlen shell-script, nem moduláris).
- **`web/app.js` -- a NULLA-konfliktus állítás 2026-08-13-án MEGDŐLT, 2026-08-14-én HELYREÁLLT (kártyák `eba65f46` -> `241532d8`).** A guard-teszt pontosan azt tette, amiért megírtuk: pirosra váltott, MIELŐTT egy valódi merge bárkit meglepett volna. A mért ok nem szomszédos beszúrás volt, hanem **háromutas divergencia UGYANAZON a megosztott függvényen**: a fork LECSERÉLTE a `loadUpdates()`-et (78 sor -> 27 soros diszpécser a két-repós nézetre: upstream Marveen + fork MikroB), miközben upstream ugyanezt a függvényt bővítette (#963, `renderUpdatesVersion`). Segédfüggvények kiszervezése ezt NEM oldotta volna fel -- a divergencia magában a függvényben volt. **A megoldás egy valódi overlay-seam:** a `loadUpdates()` a `web/app.js`-ben bájtra az upstream változata (a splice mindkét oldalán azonos kontextussal ellenőrizve), a fork renderelője pedig átkerült a `web/fork-updates.js`-be, ami az `app.js` UTÁN töltődik és egyetlen explicit `window.loadUpdates = forkLoadUpdates` sorral írja felül a globálist (az `app.js` mindhárom hívási helye minősítetlen `loadUpdates()` hivatkozás, tehát híváskor a globálisra oldódik). Mérve: a merge dry-run a `web/app.js`-t MÁR NEM hozza konfliktusként (merge-base `1f2c2c0`, upstream `aefa693`), a guard ARMED állapotban zöld. **Két dolog szándékosan KIMARADT ebből a kártyából:** a `handleRepoInstallClick()` az `app.js`-ben maradt (fork-only, nem ütközik, mozgatása öncélú diff lenne), és az upstream `renderUpdatesVersion` (+ a `window._updatesStatus` beállítása a `loadUpdates`-ből) NINCS beportolva a fork renderelőjébe -- az user-látható változás, saját kártyát érdemel, nem egy olyan refaktor belsejét, aminek épp az az állítása, hogy a viselkedés változatlan. **Ismert következmény:** az `app.js`-ben maradt upstream `loadUpdates()` itt holt kód, és el is szállna, ha valaha lefutna (a fork `index.html`-je az upstream `#updatesCommitList` konténerét `#updatesRepos`-ra cserélte) -- ha a `fork-updates.js` nem töltődik be, a Frissítések-oldal törik, nem degradálódik. Ugyanaz a hibamód, mint magáé az `app.js`-é.
  **2026-08-17 ÚJRA-MÉRÉS (kártya `b91f11d8`, ugyanaz a dry-run módszer):** a guard ismét PIROS a `web/app.js`-en. Merge-base változatlanul `1f2c2c0`; a fork **121 commitot** adott az `app.js`-hez a merge-base óta (a moduralizáció folytatódott, a fájl mostanra **785 sorra** apadt -- a `241532d8`-nál mért állapot óta tovább zsugorodott), upstream **3 commitot**: a már ismert és ELINTÉZETT `#963` (`loadUpdates`/`renderUpdatesVersion`, lásd fent -- ez a fájlban byte-azonos maradt upstream-mel, NEM ez okozza az új ütközést) mellett **két ÚJ**, eddig nem vizsgált: `#877` (`createCardEl` -- kártya-mozgatás `actor` mezője, self-pickup echo elleni védelem) és `#955` (context-guard idle-flush + config PUT kulcs-validáció). Mindkettő olyan függvényt bővít, amit a fork időközben KISZERVEZETT egy `app-*.js` szeletbe -- ugyanaz a mintázat, mint a `loadUpdates()`-nél, csak eggyel korábban elkapva (a `createCardEl`/context-guard kód jelenleg SEHOL nem szerepel szó szerint a fork `app.js`-ében, `grep` szerint). **A konfliktus MÉRETE is megváltozott a mechanizmus miatt, nem csak a darabszáma:** git a hiányzó közös kontextus miatt a fájl közepét (660--11704. sor a merge-worktree-ben, konfliktus-jelölőkkel felfújva) EGYETLEN óriás hunk-ként jelzi, ami a tényleges, egyenkénti eltérési pontokat elfedi -- a `#877`/`#955` azonosítása a fenti upstream-commit-listából jött, NEM a hunk kézi átolvasásából (ami ekkora méretnél nem praktikus). **Ez a kártya (`b91f11d8`) SZÁNDÉKOSAN nem old fel semmit** -- a `loadUpdates()`-mintájú overlay-seam-fix minden egyes érintett függvényre saját vizsgálatot és döntést igényel (1b. munkavégzési szabály: architekturális döntés, plan-grilling szükséges dispatch előtt), a teljes egyeztetés terjedelme a mért arány (121 fork commit vs 3 upstream commit, egyetlen ~11000 soros felfújt hunk) miatt jóval túlnő egy NORMAL kártya keretén. Javaslat: a moduralizációs epic gazdája (Fron Ted / a `241532d8` család) vegye fel önálló al-feladatként `#877`-et és `#955`-öt, és mostantól minden ÚJ, `web/app.js`-t érintő upstream commitot egyenként, a landolása után röviddel kezeljen (ne várjon a következő nagy újramérésre) -- a mostani felhalmozódás pont abból jött, hogy a `241532d8` óta senki nem nézte meg egyenként a 3 upstream commitot.
- **A guard őrzött fájllistája KÉZZEL karbantartott, és alulmér.** A `fork-upstream-conflict-guard.test.ts` négy `web/` fájlt néz; ugyanaz a dry-run **három további** ütköző fájlt hoz, amit senki nem figyel: `src/model-fallback.ts`, `src/__tests__/model-fallback.test.ts`, `src/web/update-checker.ts`. Ezek közül a `src/model-fallback.ts` **viselkedés-kritikus**: a fork SZÁNDÉKOSAN kivette az `upgrade to increase your usage limit` mintát a kvóta-detektor regexéből (2026-06-30, false positive -- a Claude Code minden friss panelben kiírja ezt slash-parancs tippként, így a frissen bootolt ügynökök limitesnek látszottak és feleslegesen downgrade-elődtek volna), upstream viszont visszatette, ÉS hozzávett egy valódi új variánst (`session limit`, 2026-08-08). Helyes feloldás: upstream `session limit` kiegészítése ÁTVÉVE, a fork `/upgrade`-eltávolítása MEGTARTVA -- egy vak "theirs" itt flotta-szintű false positive-ot hozna vissza. **ELINTÉZVE (kártya `f085fd44`, 2026-08-14):** (1) a divergencia feloldva a fenti szabály szerint a `src/model-fallback.ts`-ben, és a két fél EGYÜTT ki van pinnelve egy tesztben (`keeps BOTH halves of the fork/upstream resolution at once`) -- egy jövőbeli, egyik oldalt teljesen átvevő merge pirosra vált, nem csendben szállít; a `session limit` átvétele nem kozmetika: a `You hit your session limit ∙ resets 5:50pm` bannert semmi más minta nem fogta, tehát egy valóban limites ügynök egészségesnek látszott. (2) A guard már NEM kézi négyes listát néz: a **teljes** ütköző halmazt vizsgálja, és minden ütköző fájlnak szerepelnie kell vagy a nulla-konfliktus listán, vagy az `ACKNOWLEDGED_CONFLICTS` térképen a **leírt feloldási szabályával** együtt -- egy új, senki által nem gondozott ütközési hely azonnal piros. **A mentesítés a TARTALOMHOZ kötődik, nem a fájlnévhez** (kártya `a1d613e3`, Cybersec msg 19105): minden szabály mellett ott van az `ACKNOWLEDGED_UPSTREAM_BLOBS`-ban az az upstream blob-sha, ami ellen megírták, és ha az upstream oldal azóta megmozdult, a kapu ÚJRA blokkol (`stale` verdikt) és friss döntést kér. Enélkül a mentesítés végleges volt: ugyanabban a fájlban bármilyen KÉSŐBBI, más ütközés csendben átment -- például a `src/__tests__/installer-start-and-fallback.test.ts`-ben, ami maga egy őr-teszt az installer megszakításáról. A horgony típusa kikényszeríti, hogy minden szabályhoz tartozzon sha és fordítva (fordítási hiba, nem csendes elcsúszás). A három fájl feloldási szabálya ott van bevezetve (a `src/web/update-checker.ts`-nél mérve: a fork többrepós aggregát szerkezetét tartjuk, és upstream új egy-eredményes feature-jeit -- pl. a futó verzió a fejlécben, `aefa693` -- egyenként portoljuk rá).
- **`web/style.css` -- a NULLA-konfliktus állítás 2026-09-01-én megdőlt (heartbeat-reconciliation, kártya `0f7f7fe9` landolása előtt mérve).** Egyetlen hunk, mindkét oldal tisztán additív ugyanazon beszúrási ponton: a fork `.agent-hud*` szabályokat adott (per-agent élő HUD, kártya `f07c5b7c`), upstream `.agent-ctx-badge` szabályokat (kontextusablak-jelvény az Agents rácson). Eltérő class-nevek, eltérő funkció, egyik sem hivatkozik/írja felül a másikat -- nem szemantikus ütközés, csak szomszédos beszúrás. **Feloldás:** mindkét blokk megtartva, `ACKNOWLEDGED_CONFLICTS`-ba került (a `web/app.js`-mintát követve), kikerült a `GUARDED_FILES` listáról.
- **`web/lang/en.js` + `web/lang/hu.js` -- a NULLA-konfliktus állítás 2026-09-04-én megdőlt (kártya `368b77f7`, URGENT: minden marveen-landolást blokkolt).** Ugyanaz a minta, mint a `web/style.css`-nél, csak nagyobb léptékben: mindkét oldal tisztán additív ugyanazon a beszúrási ponton. **Kulcs-szinten mérve** (nem sor-szinten): a merge-base-en 1590 kulcs, a fork **+516**-ot adott (köztük a kimenő-kapu `names.*` szabály-UI-ja, kártya `98dbbcc9`), az upstream **+27**-et (`auth.bridge.err.*`, BRIDGEHU813 `#1170`), a két halmaz **NULLA kulcson ütközik**, és **egyik oldal sem törölt** semmit. A konfliktus tehát textuális, nem szemantikus. **Feloldás:** mindkét blokk megtartva, `ACKNOWLEDGED_CONFLICTS`-ba került, kikerült a `GUARDED_FILES` listáról. **Az overlay-kiemelés megfontolva és ELVETVE** (ezt kéri a guard hibaüzenete): a fork a 2106 kulcsból 516-ot birtokol (24,5%), tehát az overlay valódi szétvágás lenne, és az ellenérv a tooling -- az i18n kulcs-beszúró útnak tudnia kellene, melyik fájlba tartozik egy kulcs, és ezt a forkot már egyszer megharapta egy rossz helyre író beszúró szkript. Egy nulla-kulcsütközésű unió egyetlen merge-döntésbe kerül; egy kétfájlos elrendezés egy loader-változásba és minden új kulcsnál egy állandó helyességi kérdésbe. **Újra kell nézni, ha az ütközések száma valaha nem nulla** -- ott szűnik meg az unió mechanikus lenni.
  **A `GUARDED_FILES` lista ezzel ÜRESSÉ vált**, és ez valós állapot, nem hiányosság: minden valaha ott szereplő fájlt a szigorúbb „minden ütköző fájlnak legyen leírt feloldási szabálya" ellenőrzés figyel. Hogy ez ne váljon csendben vakká, a guard mostantól külön állítja, hogy minden egykori `GUARDED_FILES`-tag ma is szerepel az `ACKNOWLEDGED_CONFLICTS`-ban ÉS a blob-pin térképen -- így egyetlen sor törlésével nem lehet egy fájlt mindkét listáról egyszerre eltüntetni.
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
