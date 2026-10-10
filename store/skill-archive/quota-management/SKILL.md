---
name: quota-management
description: >
  Kvóta-limit (5 órás session-limit ÉS heti "All models" sáv) kezelésének
  pontos mechanikája: countdown/auto-resume script-nevek, dinamikus heti
  küszöb-számítás, lokális-LLM offload mód. Trigger: kvóta-limit bannert
  látsz, valamelyik ügynök elakadt kvóta miatt, heti % közelít a küszöbhöz,
  vagy pontosan kell tudnod melyik script mit csinál a reset körül.
---

# Kvóta-figyelmeztetés (5 órás limit) -- SZABÁLY

Ha azért akad el a munka, mert egy ügynök elérte az 5 órás Claude usage-limitet, AZONNAL figyelmeztesd Petit Telegramon (melyik ügynök, és hogy a reset-ig nem tud dolgozni). Ezt automatizálja a `quota-limit-monitor` ütemezett feladat: 6 percenként a `store/quota-check.sh`-val nézi minden ügynök tmux paneljét a usage-limit bannerre (a `src/model-fallback.ts` regexével), és CSAK az ÚJ limitnél ír Telegramra (dedupe a `store/quota-monitor-state.json`-ban). Ha te magad (MikroB) látod bármely kimenetben a limit-bannert, akkor is jelezd.

## 5h05m reset-countdown + auto-resume (Peti szabály 2026-07-04)

A limit-banner a reset UTÁN is bent ragadhat a panelen (a "Stop and wait for limit to reset" modál elavul), ezért NEM elég a bannerre hagyatkozni. Mechanizmus:

- **Countdown indítás:** amikor egy ügynök eléri a limitet (a `quota-check.sh` NEW éle), a script automatikusan elindít egy **5 óra 5 perces** visszaszámlálót: `store/quota-reset-countdown.json` (`hit_at` + 5h05m = `deadline`). A deadline-t egy futó countdown NEM állítja újra (nem nyúlik, ha a limit közben ismét látszik); ha a limit teljesen megszűnik, a countdown törlődik.
- **Auto-resume a lejáratkor:** a `quota-reset-resume` ütemezett feladat 5 percenként futtatja a `store/quota-resume.sh`-t. Amíg a deadline nem járt le → `STATE:counting`, csend. A deadline lejártakor a script: (1) Esc-eli az elavult limit-modálokat a limitelt paneleken, (2) `POST /api/agents/<agent>/start`-tal ÚJRAINDÍTJA az érintett ügynököket, (3) újra lefuttatja a `quota-check.sh`-t. Ha a limit tényleg megszűnt → `RESULT:RESUMED` (a countdown törlődik, a flottát újra dispatcheled és értesíted Petit); ha a valós ablak még nem zárt → `RESULT:STILL-LIMITED`, a következő futás újrapróbálja.
- **Fontos:** a reset megtörténtének perdöntő jele NEM a banner, hanem hogy egy friss/újraindított session tud-e dolgozni (lásd `quota-reset-detection-and-resume` tanulság). A `quota-resume.sh` ezt automatizálja.
- **GROUND-TRUTH a terminál `/status` (Peti szabály 2026-07-05):** a kvóta/reset ellenőrzés perdöntő forrása a `/status`, NEM a beragadó limit-modal (a modal a reset UTÁN is bent ragadhat -> a banner-detektor tévesen "befagyottnak" látja a flottát). Ha kétség van a limit/reset körül, a `/status` a mérvadó. Mechanizmus (MikroB olvassa): `/status`-t egy SPARE claude-panelbe küldeni (`marveen-worker` tmux session, SOHA nem fleet-agent panelbe) és `capture-pane`-nel visszaolvasni a Current session % + Weekly All-models % + reset-időket, végén `Esc`. A banner/quota-check továbbra is a gyors monitor, de ütközésnél a `/status` nyer. (Alternatív strukturált forrás: a `CLAUDE_CODE_OAUTH_TOKEN` + `api.anthropic.com/api/oauth/usage` végpont.)

## Heti limit 90% -- új-fejlesztés stop (Peti szabály 2026-07-05)

Az 5 órás session-limit MELLETT van egy HETI limit is (a Max 5x csomag "Weekly limits / All models" sávja, külön reset-idővel, pl. `Resets Thu 3:59 PM`). Szabály:

- **DINAMIKUS küszöb (Peti 2026-07-05), a heti resetig hátralévő idő alapján** (a reset-idő a usage-képernyőn: `Resets <nap> <idő>`; a hátralévő időt `date`-tel számold, Europe/Budapest):
  - **> 3 nap** a resetig → küszöb **90%**
  - **< 2 nap** a resetig → küszöb **92%**
  - **< 1 nap** a resetig → küszöb **95%**
  - (2--3 nap között a 90% marad; a `< 1 nap` a `< 2 nap`-on belül a szűkebb, ezért 95% nyer. Logika: `days<1 → 95`, `elif days<2 → 92`, `else → 90`.)
  Minél közelebb a reset, annál magasabb a megengedett küszöb (mert a reset úgyis jön).
- **Ha a HETI "All models" sáv eléri az AKTUÁLIS (dinamikus) küszöböt:** a flotta a MÁR FUTÓ, aktuális fejlesztéseket BEFEJEZI (a jelenlegi in_progress kártyák + a hozzájuk tartozó gate-ek lefutnak), de **ÚJ fejlesztést NEM indítasz** (nincs új planned kártya `in_progress`-be, nincs új dispatch) a HETI reset megtörténtéig. A "munka soha nem áll le" elv ilyenkor a heti-limit miatt fel van függesztve az új munkára -- ez a megengedett kivétel, mint a kvóta-limit.
- **Mit szabad 90% felett:** in-flight kártyák befejezése, gate-ek (QA/WhiteHat/RedHat) lefuttatása és a kártyák LEZÁRÁSA, Telegram-válasz Petinek, monitorozás. Amit NEM online: új feature-kártya online-kódolása, önfejlesztő kör, bármi ami ONLINE Claude-tokent éget kódolásra.
- **LOKÁLIS-LLM OFFLOAD MÓD 90% felett (Peti szabály 2026-07-23, a "stop" MÓDOSÍTÁSA):** a heti küszöb felett a kódolás NEM áll le teljesen -- helyette MINDEN programozási feladatot a LOKÁLIS LLM-re kell kiadni (draft-only, `local-llm-draft` label), és a MikroB + gate VISSZAELLENŐRZÉST a következő kvóta-resetig HALASZTANI. Így a helyi (ingyenes) GPU meghosszabbítja a kvótát a kódolásra. Mechanizmus: az online role-agentek NE égessenek Claude-tokent kódolásra; a kódot a `/home/neon/marveen/store/local-llm-rag.sh --agent <agent> --task code` adja draftként (a `local-llm-offload` skill szerint), amit egy `local-llm-draft`-címkés kártyán gyűjtünk. **Korlát (őszinte):** a 7B csak jól körülhatárolt, IZOLÁLT kód-darabot tud megbízhatóan (függvény/teszt/típus/regex/snippet), teljes több-fájlos kártyát/architektúrát/wiringet NEM -- amit nem lehet offloadolni, az a resetig VÁR. **A verifikáció (MikroB + QA/WhiteHat/RedHat gate) MINDIG a reset után, online fut -- draft SOHA nem megy élesbe/DONE-ra ellenőrizetlenül** ([[local-llm-work-must-be-rechecked]]). Reset után: a `local-llm-draft` kártyák elsőbbséggel újra-ellenőrzés + gate, majd normál dispatch.
- **Mérés:** a pontos heti % a Claude usage-képernyőn látszik (session + weekly sávok). Automatikus olvasása nem garantált; a jelzés forrása Peti usage-screenshotja és/vagy a heti-limit banner. Ha bizonytalan a %, a reset-idő közeledtével (a képernyőn látható `Resets <nap> <idő>`) konzervatívan viselkedj: a heti reset előtt ne kezdj nagy új fejlesztésbe, ha a sáv a 90% közelében jár.
- Amint a heti reset megtörtént (a sáv nullázódik), a normál "no idle" folytatódik: dispatcheld a következő planned munkát.
