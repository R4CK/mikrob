## Reggeli napindító

Készíts reggeli napindító üzenetet a Telegram csatornán, MarkdownV2 formátumban.

Formázás:
- Bold: *szöveg* (EGY csillag, nem dupla)
- Speciális karaktereket escapelni kell: ( ) . - + = ! { } [ ] | ~ > #
- NE használj Markdown fejléceket -- a Telegram nem támogatja
- Emoji + félkövér szöveget használj szekciócímeknek

Utasítások:
1. Email: search_emails az elmúlt 24 órából, szűrd ki a spam/promo emaileket
2. Naptár: list-events a mai napra
3. AI hírek: WebSearch a tegnapi dátummal
4. **A NYERS SZÖVEGET A HELYI MODELL ÍRJA MEG ELŐSZÖR** (kártya 8417fa5e). A `store/local-llm-model-routing.json` a `morning-brief` sablont a Qwen3.8-ra irányítja, a prompt megvan, a modell telepítve van -- eddig viszont semmi nem hívta meg, tehát a helyi specialista bekötés nélkül állt. Az 1-3. pontban összegyűjtött nyers adatot add át neki, és az ő draftjából indulj:

   ```bash
   bash /home/neon/marveen/store/local-llm.sh --task morning-brief --caller mikrob \
     "Email: <összefoglalók>. Naptár: <események>. Hírek: <címek>"
   ```

   Mérve (2026-09-04, meleg modell): **37 másodperc**, helyes magyar ékezetekkel, szekciókra bontva.

5. **A DRAFT SZERKEZET ÉS HANGNEM, NEM TÉNY. TE ELLENŐRZÖD, MIELŐTT ELMEGY.** Ez nem formalitás: megmértem, és a hibák nem a stílusban vannak. Három `tg-draft` mintából NULLA em dash és nulla AI-klisé jött ki (a stílus-szabályokat a prompt tartja), viszont **kettő MEGFORDÍTOTT egy tényt** (az "elavult a dist"-ből "rendben a dist" lett), egy pedig KITALÁLT egy műveletet, amit senki nem kért. A morning-brief mintában egy szó is torzult (`árajánlat` -> `Aránylathoz`).

   Tehát amit át kell nézned, az NEM a hangnem: minden állítást vess össze az 1-3. pontban gyűjtött nyers adattal, és javítsd a torzult magyar szavakat. A hangnemet nyugodtan hagyd, azt a modell tartja.

6. Telegram küldés: a reply tool-lal (chat_id: 7929620734 -- a `0` NEM működik, lásd lent)
7. Ha nincs esemény valamelyik kategóriában, hagyd ki a szekciót teljesen

**Ugyanez a minta a többi saját szövegedre** (kártya 8417fa5e, mind a négy sablon a Qwen3.8-on van és mind bekötetlen volt):
- `--task tg-draft` -- NEM kritikus Telegram-üzenet nyers fogalmazványa. Kritikusat (kvóta-riasztás, hibajelentés, döntés-kérés) NE ezzel írj: ott a pontosság a lényeg, és pont az romlik el.
- `--task daily-log` -- a napi napló bejegyzésének nyers szövege az emlékekből.
- `--task board-reconcile` -- a `waiting` kártyák állapot-összefoglalója.

Mindháromra ugyanaz a szabály áll, mint az 5. pontban: a draft a szerkezetet és a hangnemet adja, a TÉNYEKÉRT te felelsz.

<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->
