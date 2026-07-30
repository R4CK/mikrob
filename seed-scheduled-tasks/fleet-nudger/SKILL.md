---
name: fleet-nudger
description: 2 percenkent meglolki az idle agenteket + zar/re-dispatch
---

FLEET-NUDGER (11. szabaly vegrehajtasa). Nezd meg minden fleet-agent tmux paneljet (backend, fullstack, fron-ted, fron-teddy, qa, cybersec, cybered). Ha egy agent IDLE (nincs esc-to-interrupt spinner), lokd meg a sajat tmux sessionjebe egy rovid self-advance uzenettel, hogy vegye a kovetkezo munkajat: mernoki agent a neki cimzett legmagasabb prioritasu planned kartyat (nem blokkoltat) tegye in_progress-re es epitse; gate-agent a kovetkezo waiting REVIEW kartyat a hataskoreben gate-elje. Kozben zard a done-kesz waiting kartyakat (minden kijelolt gate PASS vagy GO), es a FAIL kartyakat tedd vissza in_progress-be a felelosnek. Rutin eseten maradj csendben, csak fontos esetben irj Telegramra.


--- TOKEN-VEDELEM GUARD (Peti 2026-07-30, KOTELEZO) ---
MIELOTT barmely agentet megloksz VAGY egy kartyat re-dispatchelsz/nudge-olsz, futtasd:
  bash /home/neon/marveen/store/redispatch-guard.sh check <cardId> <agent>
CSAK ha a kimenet pontosan ALLOW -> szabad nudge-olni/re-dispatchelni. Barmely DENY:* (progress / agent-busy / backoff / cap-reached / first-seen-baseline / not-active) -> NE nudge-olj, hagyd dolgozni. Ez akadalyozza meg hogy egy lassu-de-elo kartyat 18x ujra-fejlesszunk (token-eges). A ciklus VEGEN futtasd: bash /home/neon/marveen/store/redispatch-guard.sh escalations -- ha a kimenet nem [], azok a kartyak elertek a re-dispatch hard cap-et (3): NE dispatcheld tovabb, hanem jelentsd Petinek EGYSZER Telegramon (reply chat_id 7929620734) hogy melyik kartya ragadt be es kezi beavatkozas kell. Amikor egy kartyat done-ra zarsz: bash /home/neon/marveen/store/redispatch-guard.sh reset <cardId>.