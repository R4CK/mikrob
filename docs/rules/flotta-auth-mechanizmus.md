# Flotta-szintű AUTH mechanizmus (háttér)

A sub-agentek alapértelmezés szerint a `CLAUDE_CODE_OAUTH_TOKEN` úton hitelesítenek
(`store/.claude-oauth-token`), auto-provisionált `CLAUDE_CONFIG_DIR`-rel. Ez az út
szünteti meg a visszatérő 401-kaszkádot, amit a kézzel elhelyezett, lejáró
`.credentials.json` okozott.

A fő channels-agent ettől SZÁNDÉKOSAN eltér: alapértelmezésben a közös `~/.claude`-ot
használja. A `MAIN_AGENT_ISOLATED_CONFIG=1` kapcsolja át a flotta setup-tokenjére; ha
a botnak SAJÁT Claude-loginja van, arra a `MAIN_AGENT_CONFIG_DIR` való, és az
elsőbbséget élvez.

A per-agent `claudeConfigDir` TÁMOGATOTT mező (nevesített plan-en keresztül is), arra
az esetre, ha egy agentnek saját Claude-loginra vagy saját plan-re van szüksége. A
használata döntés kérdése, nem tilalom.

Ez a mechanizmus-leírás a háttér a CLAUDE.md-ben generált, rövidített
"Flotta-szintű AUTH-szabály" szekció két MEGSZEGHETETLEN szabályához (ott maradnak
inline, mert azok akció-vezérlő leletek egy élő hibára, nem háttér-magyarázat) --
lásd card 2ec21127, Token 8: base prompt diet.
