---
name: hu-text-curl-post
description: Safely post Hungarian-accented text (kanban comment, inter-agent message, daily-log entry) to the MikroB dashboard API via curl without mangling ékezetek. Use whenever HU text is built inline in a bash heredoc/string before a curl POST.
---
# HU Text Curl Post (UTF-8 safe)

## Mikor használd
Bármikor amikor magyar, ékezetes szöveget (kanban komment, inter-agent üzenet, napi napló bejegyzés) `curl`-lal kell POST-olni a dashboard API-ra, és a szöveget bash heredoc-ból vagy egy python `sys.argv`-be interpolált stringből építenéd. A `hungarian-orthography-rule` (Peti szabály 2026-07-18, KÖTELEZŐ minden ügynökre) miatt egy elveszett/torzult ékezet nem kozmetikai hiba, hanem szabálysértés.

## Buktató (miért kell ez a skill)
Egy bash heredoc -> `python3 -c "..." "$szoveg"` argv-interpoláció NÉMÁN torzíthat egy többbájtos UTF-8 karaktert (pl. "valós" -> "val6s") még akkor is, ha a JSON egyébként jólformált és a legtöbb ékezet túléli. A curl 200 OK-t ad, semmi nem jelez hibát -- csak a poszt utáni visszaolvasás mutatja meg. (2026-08-01, kártya 0c054ebf REVIEW commentje, kétszer is megismétlődött ugyanabban a sessionben: a kanban kommentnél ÉS a MikroB-nak küldött inter-agent üzenetnél is.)

## Eljárás (biztonságos minta)

1. **Írd a HU szöveget egy VALÓDI fájlba** a Write tool-lal (garantáltan helyes UTF-8 byte-ok, nem shell-interpolációval épül):
```
Write(file_path="/tmp/.../msg.txt", content="A teljes ékezetes magyar szöveg...")
```

2. **Egy Python-processz olvassa be `encoding='utf-8'`-fal és `ensure_ascii=False`-szal írja ki a JSON payload-ot** egy külön fájlba:
```bash
python3 -c "
import json
with open('/tmp/.../msg.txt', encoding='utf-8') as f:
    content = f.read().strip()
with open('/tmp/payload.json', 'w', encoding='utf-8') as out:
    json.dump({'author': 'ugynok-neved', 'content': content}, out, ensure_ascii=False)
"
```

3. **`curl --data-binary @payload.json`**, explicit `charset=utf-8` a Content-Type-ban:
```bash
printf 'Authorization: Bearer %s\n' "$(cat store/.dashboard-token)" \
| curl -H @- -s -X POST http://localhost:3420/api/kanban/<id>/comments \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @/tmp/payload.json
```

4. **Olvasd vissza és NÉZD MEG a választ** (a curl válasz visszaadja a posztolt `content` mezőt) -- ellenőrizd szemmel, hogy minden ékezet helyes. Ne bízz a 200 OK-ban önmagában.

5. Töröld a temp fájlokat (`rm -f /tmp/payload.json ...`).

## Amit NE csinálj
- NE építsd a HU szöveget közvetlenül egy bash `-d '...'` vagy `--data '...'` argumentumban -- ez a `curl-payload-backtick-silent-fail` memóriában leírt másik buktatóba is belefuthat (backtick némán eldobja a tartalmat).
- NE interpoláld a HU szöveget közvetlenül egy `python3 -c "... \"$szoveg\""` bash-argv hívásba -- ez a torzulás forrása.
- NE hagyatkozz a curl HTTP státuszkódjára mint "biztos jó" jelre.

## Ellenőrzés
- A curl válasz `content` mezője pontosan tartalmazza az összes ékezetet (á é í ó ö ő ú ü ű), szemmel ellenőrizve.
- Ha kétséged van, egy külön GET hívással olvasd vissza a posztolt rekordot (kommentlista / üzenetlista) és hasonlítsd össze a forrásfájllal.
