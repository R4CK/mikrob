---
name: telegram-reply-fallback
description: Reply to a Telegram user when the telegram channel MCP reply tool (mcp__plugin_telegram_telegram__reply) is NOT loaded in the session. Use when ToolSearch cannot find any telegram tool yet a channel message needs an answer.
---
# Telegram reply fallback (Bot API curl)

## Mikor használd
- A session-start hook vagy egy heartbeat azt mondja, válaszolj a felhasználónak a `mcp__plugin_telegram_telegram__reply` tool-lal, DE `ToolSearch "+telegram"` / `select:mcp__plugin_telegram_telegram__reply` semmit nem ad vissza (a telegram plugin MCP nincs csatlakoztatva ehhez a sessionhöz).
- Ilyenkor NE add fel a választ -- küldd el közvetlenül a Telegram Bot API-n.

## Eljárás
1. Bot token a channel configból:
   `TOKEN=$(grep -oE '[0-9]+:[A-Za-z0-9_-]+' ~/.claude/channels/telegram/.env | head -1)`
2. chat_id: a valós felhasználói chat ID az allowlistából (`~/.claude/channels/telegram/access.json` -> `allowFrom[0]`), NEM a 0. A `chat_id: 0` SEHOL nem működik: sem a nyers Bot API-nál, sem az MCP `reply` tool-nál. Korábban ez a skill azt állította, hogy a `0` a reply tool belső konvenciója a fő csatornára -- ez téves volt (2026-09-04-én mérve, kártya 0264b294). A plugin `assertAllowedChat()`-je feltétel nélkül dob mindenre, ami nincs az `allowFrom`-ban vagy a `groups`-ban, és `0`-ra vonatkozó ág egyik verziójában sem létezett, az upstream történetében sem. Mindkét úton a valós ID kell.
3. Küldés (plain text a legbiztosabb, parse_mode nélkül -- nincs escaping-buktató):
   ```bash
   # A bot token a Bot API-nál KÖTELEZŐEN az URL útvonalában van, headerbe nem tehető -- ezért az
   # URL-t curl-configon (stdin) adjuk át, nem argv-ben: a /proc/<pid>/cmdline bárki számára
   # olvasható, tehát egy argv-ben átadott URL a tokent is odaadja minden helyi processznek.
   printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TOKEN" \
   | curl -s -X POST -K - \
     --data-urlencode "chat_id=<REAL_ID>" \
     --data-urlencode "text=${MSG}" -o out.json
   ```
4. Ellenőrzés: a válasz JSON `ok:true` + `result.message_id`.

## Buktatók
- `chat_id=0` a Bot API-nak HIBÁS ("chat not found"). Mindig a valós ID kell az access.json allowFrom-jából.
- MarkdownV2-vel ne bajlódj fallbackban: a sok escapelendő karakter ( ) . - + = ! miatt könnyen 400-at kapsz. Sima szöveget küldj, hacsak nem kell kifejezetten formázás.
- A token a `~/.claude/channels/telegram/.env`-ben van (0600), nem a projekt .env-jében.

## Ellenőrzés
- `python3 -c "import json;d=json.load(open('out.json'));print(d['result']['message_id'] if d.get('ok') else d)"` -> számot ír ki, nem hibát.
