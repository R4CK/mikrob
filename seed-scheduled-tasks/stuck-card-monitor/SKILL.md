---
name: stuck-card-monitor
description: Beragadt kanban kartyak detektalasa (10 perc no-progress), az aktiv subagent-kartyak kiveteleve
---

Beragadas-ellenorzes. Listazd az in_progress kanban kartyakat, de az AKTIV subagent altal birtokolt kartyakat NE szamitsd beragadtnak (a subagent nem frissiti a kanban %-ot, ezert false-positive lenne), KIVEVE ha mar tul regota (>40 perc) all -- akkor a subagent valoszinuleg meghalt, jelezd. Ugyanigy NE szamitsd beragadtnak egy olyan ugynok kartyajat, aki eppen a load-guard altal terheles miatt szuneteltetve/lefagyasztva van (kartya 1128002b, store/load-guard-bookkeeping.sh marker-je), DE csak akkor, ha a marker-bejegyzes MEG FRISS (last_seen 300 masodpercnel nem regebbi) -- Cybersec NO-GO + QA FAIL (Gate-SHA fce0df4e): egy elavult/orokre beragadt marker-bejegyzes (a bookkeeping sajat leallasa miatt) korabban vegtelensegig kizarta volna az erintett ugynokot ebbol az ellenorzesbol is. Futtasd:

printf 'Authorization: Bearer %s\n' "$(cat {{INSTALL_DIR}}/store/.dashboard-token)" | curl -H @- -s http://localhost:3420/api/kanban | python3 -c "import json,sys,time,os; cards=json.load(sys.stdin); now=time.time(); sp='{{INSTALL_DIR}}/store/active-subagents.json'; act=set(json.load(open(sp))) if os.path.exists(sp) else set(); pp='{{INSTALL_DIR}}/store/load-paused-agents.json'; pd=json.load(open(pp)) if os.path.exists(pp) else {}; paused={a for a,e in pd.items() if e.get('last_seen') is None or (now-e.get('last_seen',now))<300}; stuck=[c for c in cards if c.get('status')=='in_progress' and (now-c.get('updated_at',now))>600 and (c.get('assignee') not in paused) and ((c.get('assignee') not in act) or (now-c.get('updated_at',now))>2400)]; print(json.dumps([{'id':c['id'],'title':c['title'],'assignee':c.get('assignee'),'mins':round((now-c['updated_at'])/60)} for c in stuck], ensure_ascii=False))"

Minden beragadt (>10 perc nem mozdult, NEM aktiv subagent-e, ES NEM load-paused) kartyanal: nezd meg a blokkot, es inditsd ujra -- re-dispatch az assignee-nek inter-agent uzenettel/subagenttel, vagy vedd at/ruhazd at. Ha egy >40 perces kartya aktiv subagent-e volt (act-ban van), a subagent valoszinuleg meghalt: tisztitsd ki az active-subagents.json-bol es re-dispatch. Ha nincs beragadt kartya, maradj csendben, ne irj Telegramra.


--- TOKEN-VEDELEM GUARD (Peti 2026-07-30, KOTELEZO) ---
MIELOTT barmely agentet megloksz VAGY egy kartyat re-dispatchelsz/nudge-olsz, futtasd:
  bash {{INSTALL_DIR}}/store/redispatch-guard.sh check <cardId> <agent>
CSAK ha a kimenet pontosan ALLOW -> szabad nudge-olni/re-dispatchelni. Barmely DENY:* (progress / agent-busy / backoff / cap-reached / first-seen-baseline / not-active) -> NE nudge-olj, hagyd dolgozni. Ez akadalyozza meg hogy egy lassu-de-elo kartyat 18x ujra-fejlesszunk (token-eges). A ciklus VEGEN futtasd: bash {{INSTALL_DIR}}/store/redispatch-guard.sh escalations -- ha a kimenet nem [], azok a kartyak elertek a re-dispatch hard cap-et (3): NE dispatcheld tovabb, hanem jelentsd Petinek EGYSZER Telegramon (reply chat_id {{CHAT_ID}}) hogy melyik kartya ragadt be es kezi beavatkozas kell. Amikor egy kartyat done-ra zarsz: bash {{INSTALL_DIR}}/store/redispatch-guard.sh reset <cardId>.
