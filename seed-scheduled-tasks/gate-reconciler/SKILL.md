---
name: gate-reconciler
description: Minden waiting kartya gate-verdiktjenek azonnali kezelese: PASS->zaras, FAIL->re-dispatch, pending->gate-dispatch. Hogy a flotta SOHA ne varjon MikroB-ra.
---

GATE-RECONCILER (MikroB kotelesseg: a flotta SOHA ne varjon rad egy elvegzett gate-verdikt vagy egy FAIL utan). Nem-trivialis, de rutin -> csendben dolgozz.
1. Ido+kvota: `date`; `bash {{INSTALL_DIR}}/store/quota-check.sh`. Ha limit -> csendben kilep (a kvota-taskok kezelik).
1b. HARD-STOP FLAG (card d08b98f4): `cat {{INSTALL_DIR}}/store/weekly-hard-stop.json`. Ha `active:true` -> a heti test-stop kuszob at van lepve, EVEN GATE-MUNKA leall: NE dispatchelj UJ gate-et (a 3. lepes 3. franciabekezdese TILOS ilyenkor), csak (a) MAR meglevo PASS/GO kartyakat zarj, (b) parkolj minden role-agentet akinek nincs elo munkaja (kiveve {{MAIN_AGENT_ID}}). Ha `active:false` -> tovabb normalisan.
2. Listazd a WAITING kanban kartyakat: `printf 'Authorization: Bearer %s\n' "$(cat {{INSTALL_DIR}}/store/.dashboard-token)" | curl -H @- -s http://localhost:3420/api/kanban` (status==waiting). Mindegyikre olvasd a kommenteket (/api/kanban/<id>/comments) es a kijelolt gate-tiert.
3. Dontes kartyankent:
   - MINDEN kijelolt gate PASS/GO es nincs kotott-blokk -> PUT status:done + zaro komment. Utana ellenorizd a szulo-fazis auto-lezarasat (CLAUDE.md 5. szabaly, rekurzivan felfele).
   - Barmely gate FAIL/NO-GO -> PUT status:in_progress + re-dispatch a felelosnek a pontos bug-jelentessel (ha parkolt: POST /api/agents/<agent>/start, majd inter-agent uzenet vagy tmux send-keys). Ha a finding uj kartyat igenyel, nyisd meg (projekt+szines label).
   - REVIEW-komment van, de a gate-ek MEG nincsenek dispatchelve -> ELOSZOR futtasd a determinisztikus helyi pre-triage-t (card 83191d8d), hogy a gate ne online tokenert deritse ki a mechanikus tenyeket: `bash {{INSTALL_DIR}}/store/gate-pretriage-card.sh <cardId>` (idempotens: a kartya REVIEW-jabol kiszedi a commitot + repot, lefuttatja a gate-pretriage.sh-t, es egy `verdict:null` INPUT kommentet ir a kartyara -- NEM verdikt, nincs PASS/FAIL, nem mozgatja a kartyat; ha mar futott az adott commitra, csendben kihagyja). UTANA dispatcheld a kijelolt gate-eket (QA MINDIG + kockazat szerinti Cybersec/Cybered, 4. szabaly) -- a gate a pre-triage kommentbol indul, a valos reviewt tovabbra is elvegzi.
   - Kotott-blokk (pl. Cybered WC1/WC2, vagy Peti-infra blokk) -> hagyd waiting, egyszer annotald, tobbet ne bolygasd.
   - KARTYA-FUGGOSEG BLOKK (a8aa9ae5, 2026-08-23-tol elesben): ha egy waiting kartya minden kijelolt gate-je PASS/GO, DE a `PUT status:done` 409-et ad `code: "dependency_blocked"` mezovel (JSON valasz `blockedBy` tomb a blokkolo kartyakkal) -> EZ IS kotott-blokk, ugyanugy kezeld mint a WC1/WC2-t: hagyd waiting-ben, EGYSZER annotald ("blokkolt: <blockedBy id-k+cimek>, varja a predecessor(ok) lezarasat"), NE probald ujra minden korben ujabb 409-et gyujtve. Amint a `blockedBy` lista lecsokken (a predecessor idokozben done lett), probald ujra a zarast normalisan.
4. RE-DISPATCH ES NUDGE ELOTT/UTAN -- a statusz elavulasa (kartya ffaa4ff1). Minden altalad kuldott dispatch/re-dispatch uzenet a `POST /api/messages`-en at megy, ami a kuldes pillanataban automatikusan hozzafuzi a hivatkozott kartyak `status`+`updated_at` allapotat (`[card-state @send]`). Ezt NEM kell kezzel beirnod. Amit viszont KOTELEZO: a cimzettnek szolo dispatch szovegeben mondd ki, hogy a munka ELSO lepese a kartya friss statuszanak ujraolvasasa -- a stamp csak azt mondja, mi volt a kuldeskor, es egy percekkel-orakkal kesobb elolvasott dispatch mar elavult lehet (kesz kartya, mas vitte el, ujranyitva mas leletttel).
5. Idle-de-futo agentek parkolasa (nincs elo munkajuk, se in_progress se altaluk vitt gate), kiveve MikroB (7. szabaly).
6. Heti-limit (store/weekly-limit-stop.json active:true): ha aktiv, CSAK gate+zaras+in-flight befejezes, uj feature-t NE indits.
7. Telegram CSAK ha fontos (lezarult kartya amirol Peti tudni akar, vagy FAIL/dontes ami Petit igenyli). Rutin reconciliation -> CSEND.


--- TOKEN-VEDELEM GUARD (Peti 2026-07-30, KOTELEZO) ---
MIELOTT barmely agentet megloksz VAGY egy kartyat re-dispatchelsz/nudge-olsz, futtasd:
  bash {{INSTALL_DIR}}/store/redispatch-guard.sh check <cardId> <agent>
CSAK ha a kimenet pontosan ALLOW -> szabad nudge-olni/re-dispatchelni. Barmely DENY:* (progress / agent-busy / backoff / cap-reached / first-seen-baseline / not-active) -> NE nudge-olj, hagyd dolgozni. Ez akadalyozza meg hogy egy lassu-de-elo kartyat 18x ujra-fejlesszunk (token-eges). A ciklus VEGEN futtasd: bash {{INSTALL_DIR}}/store/redispatch-guard.sh escalations -- ha a kimenet nem [], azok a kartyak elertek a re-dispatch hard cap-et (3): NE dispatcheld tovabb, hanem jelentsd Petinek EGYSZER Telegramon (reply chat_id {{CHAT_ID}}) hogy melyik kartya ragadt be es kezi beavatkozas kell. Amikor egy kartyat done-ra zarsz: bash {{INSTALL_DIR}}/store/redispatch-guard.sh reset <cardId>.
