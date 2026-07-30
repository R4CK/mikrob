---
name: gate-reconciler
description: Minden waiting kartya gate-verdiktjenek azonnali kezelese: PASS->zaras, FAIL->re-dispatch, pending->gate-dispatch. Hogy a flotta SOHA ne varjon MikroB-ra.
---

GATE-RECONCILER (MikroB kotelesseg: a flotta SOHA ne varjon rad egy elvegzett gate-verdikt vagy egy FAIL utan). Nem-trivialis, de rutin -> csendben dolgozz.
1. Ido+kvota: `date`; `bash /home/neon/marveen/store/quota-check.sh`. Ha limit -> csendben kilep (a kvota-taskok kezelik).
2. Listazd a WAITING kanban kartyakat: `curl -s -H "Authorization: Bearer $(cat /home/neon/marveen/store/.dashboard-token)" http://localhost:3420/api/kanban` (status==waiting). Mindegyikre olvasd a kommenteket (/api/kanban/<id>/comments) es a kijelolt gate-tiert.
3. Dontes kartyankent:
   - MINDEN kijelolt gate PASS/GO es nincs kotott-blokk -> PUT status:done + zaro komment. Utana ellenorizd a szulo-fazis auto-lezarasat (CLAUDE.md 5. szabaly, rekurzivan felfele).
   - Barmely gate FAIL/NO-GO -> PUT status:in_progress + re-dispatch a felelosnek a pontos bug-jelentessel (ha parkolt: POST /api/agents/<agent>/start, majd inter-agent uzenet vagy tmux send-keys). Ha a finding uj kartyat igenyel, nyisd meg (projekt+szines label).
   - REVIEW-komment van, de a gate-ek MEG nincsenek dispatchelve -> dispatcheld a kijelolt gate-eket (QA MINDIG + kockazat szerinti Cybersec/Cybered, 4. szabaly).
   - Kotott-blokk (pl. Cybered WC1/WC2, vagy Peti-infra blokk) -> hagyd waiting, egyszer annotald, tobbet ne bolygasd.
4. Idle-de-futo agentek parkolasa (nincs elo munkajuk, se in_progress se altaluk vitt gate), kiveve MikroB (7. szabaly).
5. Heti-limit (store/weekly-limit-stop.json active:true): ha aktiv, CSAK gate+zaras+in-flight befejezes, uj feature-t NE indits.
6. Telegram CSAK ha fontos (lezarult kartya amirol Peti tudni akar, vagy FAIL/dontes ami Petit igenyli). Rutin reconciliation -> CSEND.


--- TOKEN-VEDELEM GUARD (Peti 2026-07-30, KOTELEZO) ---
MIELOTT barmely agentet megloksz VAGY egy kartyat re-dispatchelsz/nudge-olsz, futtasd:
  bash /home/neon/marveen/store/redispatch-guard.sh check <cardId> <agent>
CSAK ha a kimenet pontosan ALLOW -> szabad nudge-olni/re-dispatchelni. Barmely DENY:* (progress / agent-busy / backoff / cap-reached / first-seen-baseline / not-active) -> NE nudge-olj, hagyd dolgozni. Ez akadalyozza meg hogy egy lassu-de-elo kartyat 18x ujra-fejlesszunk (token-eges). A ciklus VEGEN futtasd: bash /home/neon/marveen/store/redispatch-guard.sh escalations -- ha a kimenet nem [], azok a kartyak elertek a re-dispatch hard cap-et (3): NE dispatcheld tovabb, hanem jelentsd Petinek EGYSZER Telegramon (reply chat_id 7929620734) hogy melyik kartya ragadt be es kezi beavatkozas kell. Amikor egy kartyat done-ra zarsz: bash /home/neon/marveen/store/redispatch-guard.sh reset <cardId>.