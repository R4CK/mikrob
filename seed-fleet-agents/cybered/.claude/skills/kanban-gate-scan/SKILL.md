---
name: kanban-gate-scan
description: Scan the MikroB kanban board for cards needing a specific gate verdict. Returns ungated REVIEW cards ordered by creation date. Use at the start of every self-advance loop iteration to find the oldest card still needing your gate.
---
# Kanban Gate Scan

## Mikor használd
Minden self-advance loop elején (Rule 11): van-e ungated REVIEW kártya amit gate-elni kell?

## Eljárás

```python
import urllib.request, json, re

TOKEN = open('__MARVEEN_INSTALL_DIR__/store/.dashboard-token').read().strip()
BASE = 'http://localhost:3420'
headers = {'Authorization': f'Bearer {TOKEN}'}

def api(path):
    req = urllib.request.Request(f'{BASE}{path}', headers=headers)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

# Regex on opening line only -- avoids "NO-GO" appearing inside a GO verdict
PASS_RE = re.compile(r'^(QA2?\s+PASS|CYBERSEC\s+GO|CYBERED\s+(FULL-CARD\s+)?GO)', re.IGNORECASE)
FAIL_RE = re.compile(r'^(QA2?\s+FAIL|CYBERSEC\s+NO-GO|CYBERED\s+NO-GO)', re.IGNORECASE)

def latest_verdict(comments, gate_author):
    """Latest verdict for a specific gate author. gate_author: 'qa', 'qa2', 'cybersec', 'cybered'"""
    for cm in reversed(comments):
        a = (cm.get('author') or '').lower().strip()
        # EXACT match for qa/qa2/cybered; prefix for cybersec variants
        if gate_author == 'cybersec':
            if not a.startswith('cybersec'): continue
        else:
            if a != gate_author: continue
        first = (cm.get('content') or '').strip().split('\n')[0]
        if FAIL_RE.match(first): return 'fail'
        if PASS_RE.match(first): return 'pass'
    return None

all_cards = api('/api/kanban')
if isinstance(all_cards, dict):
    all_cards = all_cards.get('cards', all_cards)

MY_GATE = 'qa'  # Change to 'qa2', 'cybersec', or 'cybered' for other gate agents

# Authors whose "REVIEW" mentions are structural gate requests (not passing references)
GATE_AUTHORS = {'fullstack', 'backend', 'fron-ted', 'fron-teddy', 'cybersec',
                'cybered', 'cybersecurity-redteam'}

def is_gate_review(cm):
    """True only when a non-gate-admin author posts a structural REVIEW marker.
    Filters: (a) author must be a builder/gate agent, not mikrob/qa/qa2;
             (b) content starts with REVIEW or contains 'REVIEW:' early -- avoids
                 Cybersec NOTEs that mention 'REVIEW' in passing mid-sentence."""
    author = (cm.get('author') or '').lower().strip()
    # 'local-llm' = a local-model DRAFT, never a gate request (card 3307b428): the offload
    # script signs drafts with their own author instead of the orchestrator's name.
    if author in ('qa', 'qa2', 'local-llm'): return False
    content = (cm.get('content') or '').strip()
    first_line = content.split('\n')[0].upper()
    # MikroB is USUALLY the orchestrator (GATE-TIER, bound-block, close notes) -- those are NOT gate
    # requests. BUT when MikroB does its OWN engineering work it posts a REVIEW asking the gates to
    # verify it (rule 4: the author never gates their own work). That REVIEW is a real gate request and
    # must NOT be filtered out just because the author is mikrob (card c615be6e 2026-08-01: a MikroB
    # self-authored card sat un-QA'd because the old filter dropped every mikrob comment). Signal: a
    # first line starting with REVIEW that also carries a self-work marker.
    if author == 'mikrob':
        SELF_WORK = ('SAJAT MUNKA', 'SAJÁT MUNKA', 'GATE KELL', 'EN NEM ZAROM', 'ÉN NEM ZÁROM',
                     'NEM ZAROM A SAJAT', 'NEM ZÁROM A SAJÁT',
                     # Explicit gate-request patterns (91b68885 tanulság 2026-08-02):
                     # MikroB sometimes says "Kerlek QA" / "Kerlek Cybersec" / "gate-eld"
                     # instead of "GATE KELL" -- these are unambiguous gate requests too.
                     'KERLEK QA', 'KERLEK CYBERSEC', 'KERLEK CYBERED', 'KERLEK A GATE',
                     'GATE-ELD', 'KEREM A QA', 'KEREM A CYBERSEC')
        head = content[:500].upper()
        return first_line.startswith('REVIEW') and any(m in head for m in SELF_WORK)
    # Structural: starts with REVIEW, or first 60 chars contain 'REVIEW:'
    return first_line.startswith('REVIEW') or 'REVIEW:' in content[:60].upper()

# MikroB-blocked markers: skip cards where MikroB says the gate is deferred/consolidated
BLOCKED_MARKERS = ('BLOKKOLVA', 'KOTOTT FELTETEL', 'kotott-blokk', 'kötött-blokk',
                   'PETI DONTES', 'HOLD', 'ne churn-old', 'gate consolidated',
                   'GATE OSSZEVONVA', 'blokk:', 'NEM stuck',
                   'NEM gate-elem', 'nincs funkcionális változás, csak prep',
                   'WAITING (bound-block', 'WAITING (bound to', 'bound to CAL-', 'bound to WF-')

# For cybersec/cybered ONLY (not qa/qa2): a recurring low-risk card class is fleet-infra
# "[OFFLOAD]"-titled local-LLM tooling (marveen repo, shell-script/template additions for
# git/i18n/inbox-triage presets) -- no new endpoint, no auth/session/superadmin surface, no
# internet-facing exposure. Below the risk-tiering threshold (rule 4: Cybersec needs a trust-
# boundary, Cybered needs high-stakes public/superadmin/auth surface) -- QA-only is correct.
# Learned 2026-07-25 after posting near-identical tiering notes on 3 separate OFFLOAD cards
# (1faf0527, 4245417b, f184b012) in one session. Title-prefix match is a coarse heuristic --
# if a future OFFLOAD card's REVIEW mentions credentials, external network calls, or anything
# touching a real trust boundary, do NOT skip it; read the REVIEW before trusting the prefix.
SECURITY_GATE_LOW_RISK_TITLE_PREFIXES = ('[OFFLOAD]',)

# Declared gate-tier check (cybersec/cybered ONLY): most card descriptions end with an
# explicit "Gate: QA" / "Gate: QA + Cybersec" / "Gate: QA + Cybersec + Cybered" line (Rule 4
# risk-tiering, stated by the builder/MikroB). Measured 2026-08-17: 18/18 cards a raw cybered
# scan flagged as "ungated" turned out to be QA-only or QA+Cybersec -- the scan doesn't check
# the declared tier, so it burns a full card-read on every one just to confirm "not mine".
# Fix: read the LAST "Gate:" mention in the description; if it names gates but NOT my own, skip
# -- unless there is no "Gate:" mention at all, in which case fall through (surface it, read the
# thread to decide). Last mention wins because scope can widen mid-thread (e.g. MikroB adds
# Cybered later after a chained finding).
# NOT anchored to line-start (77fd0f07 tanulság, 2026-08-17): some descriptions end the LAST
# PARAGRAPH with "... szoveg. Gate: QA." on the same line as prose, not its own line -- a
# `^\s*Gate:` MULTILINE anchor missed it entirely and let a QA-only card through the filter.
GATE_DECL_RE = re.compile(r'Gate:\s*([^\n]+)', re.IGNORECASE)

def declared_gate_excludes_me(description, my_gate):
    if my_gate not in ('cybersec', 'cybered'): return False
    matches = GATE_DECL_RE.findall(description or '')
    if not matches: return False
    declared = matches[-1].lower()
    return my_gate not in declared

def _marker_re(m):
    """Word-bounded where the marker begins/ends in a word character (card 3307b428, F2). A bare
    substring test made 'HOLD' fire inside 'placeholder', 'household', 'stronghold' -- and that
    misfires on ANY mikrob comment, draft or not. Markers ending in punctuation ('blokk:') keep no
    trailing boundary: \b after ':' can never match."""
    pat = re.escape(m)
    if m[:1].isalnum(): pat = r'\b' + pat
    if m[-1:].isalnum(): pat = pat + r'\b'
    return re.compile(pat, re.IGNORECASE)

BLOCKED_RES = tuple(_marker_re(m) for m in BLOCKED_MARKERS)

def mikrob_blocked(comments):
    for cm in reversed(comments):
        if (cm.get('author') or '').lower() != 'mikrob': continue
        content = cm.get('content', '')
        # Card 3307b428, F1: 55 historical drafts are STILL stored under the orchestrator's name
        # (only new ones are signed 'local-llm'). 7B free text is not a MikroB decision, so it must
        # not be able to drop a card out of the sweep through the BLOCKING door either -- the same
        # reasoning that keeps this guard in store/cybersec-gate-scan.py.
        if 'LOCAL-LLM DRAFT' in content: continue
        if any(r.search(content) for r in BLOCKED_RES):
            return True
    return False

needs = []
for c in all_cards:
    if not isinstance(c, dict): continue
    if c.get('status') not in ('waiting', 'in_progress'): continue
    title = c.get('title') or ''
    if MY_GATE in ('cybersec', 'cybered') and title.startswith(SECURITY_GATE_LOW_RISK_TITLE_PREFIXES):
        continue
    if declared_gate_excludes_me(c.get('description'), MY_GATE):
        continue
    cid = c['id']
    try:
        comments = api(f'/api/kanban/{cid}/comments')
    except: continue
    if not isinstance(comments, list): continue

    gate_reviews = [cm for cm in comments if is_gate_review(cm)]
    if not gate_reviews: continue

    last_review_id = max(cm['id'] for cm in gate_reviews)
    last_verdict_id = max(
        (cm['id'] for cm in comments
         if (cm.get('author') or '').lower() in ('qa', 'qa2')
         and any(k in (cm.get('content') or '') for k in ('QA PASS','QA FAIL','QA2 PASS','QA2 FAIL'))),
        default=-1
    )
    if last_review_id <= last_verdict_id: continue  # already gated

    # Skip if QA already posted a STALE REVIEW comment after the last review
    # (stale-handled = QA recognised it as a redundant resubmit, no re-gate needed)
    stale_handled = any(
        cm['id'] > last_review_id
        and (cm.get('author') or '').lower() in ('qa', 'qa2')
        and 'STALE' in (cm.get('content') or '').upper()
        for cm in comments
    )
    if stale_handled: continue

    # Skip if mikrob DONE'd / closed after the last review.
    # Use MIKROB_CLOSED_RE instead of startswith('DONE') to also catch:
    #   - "DUPLIKATUM -- lezárom" (MikroB marks a card as duplicate)
    #   - "KONSZOLIDALVA" (merged into another card)
    #   - "LEZAROM" / "LEZÁRVA" (explicit close without DONE keyword)
    #   - "CLOSE" (English "MIKROB CLOSE: ..." -- e.g. closing one phase of a still-open
    #     parent/epic card, card status may stay in_progress while sub-scope moves to
    #     child cards; 42bc566c tanulság 2026-07-25: "MIKROB CLOSE: Fázis-1 ... Fázis-2 a
    #     gyerek-kártyákon" left the parent's REVIEW un-flagged by the old regex)
    # STILL only match the FIRST LINE -- and only its OPENING (card b3b7e734).
    #
    # First-line-anywhere was still too loose: "Beepult a QA + Cybersec gate sorba ... DONE csak
    # QA PASS + Cybersec GO" is ordinary fleet prose, not a close, and it silently dropped the card
    # from the sweep. Measured over the real board (1196 first-line marker hits on mikrob comments):
    # a hard line-start anchor would have rejected 491 of them -- but many ARE real closes
    # ("[GATE CLOSE] ... -> DONE.", "[AUTO-CLOSE] gyerekek DONE ...", "Ujra DONE."), so the anchor
    # the card proposed would have traded a latent miss for 491 immediate ones.
    #
    # What actually separates them is POSITION: a close leads with its marker (optionally behind a
    # short "[GATE CLOSE]"-style tag), while a false positive mentions it deep in a sentence. So the
    # marker must appear within the first 24 characters, and must not be negated right before it
    # ("HOLD (NEM done)"). Measured: 891 kept, 305 dropped, and the dropped set is all
    # VERIFIED/QA-GATE/PASS prose -- no real close among them.
    #
    # Precision matters more than recall here, and asymmetrically: a false "closed" DROPS a card
    # from the gate sweep silently, while a false "not closed" only re-lists a card whose API status
    # (`status not in ('waiting','in_progress')`, above) already excludes it if it is truly done.
    # That is why "... mindharom zold. Kartya DONE." (marker at the end of a long line) is allowed to
    # fall through: all 75 such comments sit on cards the API already reports as done.
    MIKROB_CLOSED_RE = re.compile(
        r'\b(DONE|CLOSE|DUPLIKATUM|KONSZOLIDALVA|LEZAROM|LEZÁRVA)\b', re.IGNORECASE
    )
    MIKROB_CLOSE_WINDOW = 24
    MIKROB_NEGATED_RE = re.compile(r'\b(NEM|NINCS|NOT|NO)\W{0,3}$', re.IGNORECASE)
    # "DONE csak QA PASS + Cybersec GO" states a CONDITION for closing, not a close -- and the
    # motivating example ("GATE-TIER: DONE csak ...") puts it inside the window, so position alone
    # does not catch it.
    MIKROB_CONDITIONAL_RE = re.compile(r'^\W*(csak|only|akkor|ha)\b', re.IGNORECASE)

    def mikrob_closes(content):
        first = (content or '').strip().split('\n')[0]
        m = MIKROB_CLOSED_RE.search(first)
        if not m or m.start() > MIKROB_CLOSE_WINDOW:
            return False
        if MIKROB_NEGATED_RE.search(first[:m.start()]):
            return False
        return not MIKROB_CONDITIONAL_RE.match(first[m.end():])

    mikrob_done_after = any(
        cm['id'] > last_review_id and mikrob_closes(cm.get('content'))
        for cm in comments if (cm.get('author') or '').lower() == 'mikrob'
    )
    if mikrob_done_after: continue

    if mikrob_blocked(comments): continue

    rev = next((cm for cm in reversed(comments) if is_gate_review(cm)), None)
    needs.append({
        'id': cid, 'status': c.get('status'),
        'created_at': c.get('created_at', ''),
        'title': (c.get('title') or '')[:70],
        'review': (rev.get('content') or '')[:300] if rev else ''
    })

needs.sort(key=lambda x: x['created_at'])
print(f"Ungated ({MY_GATE}): {len(needs)}")
for n in needs:
    print(f"[{n['status']}][{n['id']}] {n['title']}")
    print(f"  REVIEW: {n['review'][:200]}")
```

## Buktatók
- **MikroB-saját-munka REVIEW vakfolt (c615be6e tanulság, 2026-08-01 + 91b68885 2026-08-02):** az `is_gate_review` régen MINDEN mikrob-szerzőt kizárt (mert a mikrob-kommentek túlnyomó része orchestráció: GATE-TIER, bound-block, close). DE amikor MikroB maga FEJLESZT, a saját munkájára REVIEW-t posztol és külső gate-et kér (rule 4: a szerző nem gate-eli magát). Ez a REVIEW valós gate-kérés, de a régi szűrő eldobta -> egy MikroB-saját kártya (c615be6e, server-side newDevStop; majd 91b68885, +15 local-LLM kategória) gate nélkül ragadt `waiting`-ben, Cybersec-GO-val de QA nélkül. Fix (fent): ha `author == 'mikrob'` ÉS az első sor `REVIEW`-val kezdődik ÉS az első 300 char tartalmaz self-work markert (`sajat munka`/`gate KELL`/`en nem zarom`/`KERLEK QA`/`KERLEK CYBERSEC`/`GATE-ELD` stb.), akkor gate_review. A normál mikrob orchestráció-kommentek (nincs self-work marker) továbbra is kiszűrve. **91b68885 tanulság:** MikroB a gate-kérést "Kerlek QA (wire-up + teszt) es Cybersec..." formában írta -- ez nem szerepelt a SELF_WORK listában. Fix: `KERLEK QA`, `KERLEK CYBERSEC`, `KERLEK CYBERED`, `KERLEK A GATE`, `GATE-ELD`, `KEREM A QA`, `KEREM A CYBERSEC` felvéve; a head-ablak 120-ról 500 char-ra bővítve (91b68885-ben a "Kerlek QA" a 363. karakternél állt, 300-as ablak nem fogta el). Ha egy MikroB REVIEW mégis kiesik a scanből, direkten ellenőrizd: `api('/api/kanban/<id>/comments')` és a waiting kártyák listáját.
- **NE `startswith('qa')`** -- `qa2` is illeszkedne rá. Használj `== 'qa'` pontosan.
- **NE `'NO-GO' in content`** -- hamis FAIL-t ad GO-verdikten belüli "NO-GO" hivatkozásra. Mindig a **nyitósor regex** dönt.
- **NE `gates_pass - gates_fail` set-különbség** -- az early NO-GO törli a later GO-t. Latest-verdict-per-gate logika kell: minden gate-nél az utolsó komment dönt.
- **Cybersec NOTE false positive**: ha a Cybersec "deferred NOTE"-ban írja hogy "fron-ted's REVIEW is correct..." -- ez NEM gate-REVIEW kérés. Az `is_gate_review()` a strukturális REVIEW markert nézi (első sor / első 60 char), nem a mid-sentence előfordulást.
- **MikroB-blokkolt kártya**: ha MikroB azt írja "gate consolidated" / "GATE OSSZEVONVA" / más write-path kártyával együtt gate-elünk -- skip, ne gate-elj önállóan.
- **`WAITING (bound to ...)` false-ungated (82ea4267 tanulság):** MikroB néha "WAITING (bound to CAL-5 make-live, ...)" formában blokkolja a kártyát, NEM "WAITING (bound-block)" szövegezéssel. A naiv marker-match ("WAITING (bound-block") nem fogja el. Fix: a `BLOCKED_MARKERS` tartalmazza `'WAITING (bound to'` és `'bound to CAL-'` / `'bound to WF-'` szövegeket is, hogy a változó prefixű bound-block kommentek mind szűrve legyenek. QA FAIL in `waiting` + MikroB bound-block = MikroB-döntés, nem stuck -- ne mozgasd `in_progress`-be.
- **MikroB DONE után nyílt vissza**: ha MikroB DONE'd, majd egy új REVIEW jött be UTÁNA (pl. redundáns fron-teddy REVIEW), a `mikrob_done_after` check csak az AFTER-t nézi, tehát helyesen kiszűri a DONE-at megelőző REVIEW-kat.
- **`mikrob_DONE` false-positive (79213e5a + f11d23eb tanulság):** `'DONE' in content` hamis találatot ad ha MikroB GATE-TIER kommentje tartalmazza a szót (pl. "DONE csak QA PASS + Cybersec GO" -> az f11d23eb kártyát a scan teljesen kihagyta). **Fix (kötelező):** csak az ELSŐ SOR-t ellenőrizd: `content.strip().split('\n')[0].upper().startswith('DONE')`. A card API-státusz (`c.get('status') == 'done'`) a zárás végső forrása -- a `status not in ('waiting','in_progress')` filter eleve kizárja a valóban lezárt kártyákat.
- A scan `waiting` ÉS `in_progress` kártyákat is ellenőriz -- REVIEW bekerülhet mindkét státuszban.
- Ha a scan 0-t ad de sok waiting kártya van: ellenőrizd, hogy nem az auth token érvénytelen-e, és hogy a komment endpoint valóban visszaad adatot.
- **DUPLIKATUM / KONSZOLIDALVA false-positive (2026-07-24 tanulság):** Ha MikroB `DUPLIKATUM -- lezárom` vagy `KONSZOLIDALVA` szöveggel zár egy kártyát (nem `DONE` szóval kezdve), a `startswith('DONE')` check nem kapta el -> a scan tévesen "ungated"-ként mutatta. Fix: `MIKROB_CLOSED_RE` regex a fenti kódban -- a `\b(DONE|CLOSE|DUPLIKATUM|KONSZOLIDALVA|LEZAROM|LEZÁRVA)\b` mintát az ELSŐ SOR-on keresd (nem a teljes tartalomban, hogy a f11d23eb false-positive ne ismétlődjön).
- **"MIKROB CLOSE" (angol) egy RÉSZ-fázist zár, a kártya `status` marad `in_progress` (42bc566c tanulság, 2026-07-25):** egy epic/parent kártyán MikroB lezárhatja csak az ÉPPEN gate-elt fázist ("MIKROB CLOSE: Fázis-1 ... Fázis-2 a gyerek-kártyákon") anélkül, hogy a kártya API-státuszát `done`-ra váltaná -- a hátralévő scope gyerek-kártyákra költözött. A régi regex nem ismerte a "CLOSE" szót (csak DONE/DUPLIKATUM/KONSZOLIDALVA/LEZAROM/LEZÁRVA), ezért a scan tévesen ungated-ként mutatta a mar lezart Fazis-1 REVIEW-t egy `in_progress` allapotban maradt parent kartyan. Fix: "CLOSE" bekerult a MIKROB_CLOSED_RE-be. Ha a scan mégis egy epic/parent kártyát dob ki, ELSŐ lépésként olvasd végig a teljes komment-threadet -- egy korábbi MikroB-komment (bármilyen záró szóhasználattal) gyakran már lezárta a kérdéses REVIEW-t, és a maradék munka a gyerek-kártyákon fut.
- **`kotott-blokk` / `PETI DONTES` / `HOLD` marker (2026-07-31 tanulság, b92c10d4):** MikroB a bound-blockot NEM mindig a `KOTOTT FELTETEL` szöveggel írja -- a valós szövegezés gyakran `WAITING (kotott-blokk, Peti-dontes)` + `Addig ne churn-old`. A régi marker-lista csak a nagybetűs `KOTOTT FELTETEL`-t ismerte, ezért a scan gate-elhetőnek mutatta a Peti által HOLD-ra tett adopt-kártyát. Fix: `kotott-blokk`, `kötött-blokk`, `PETI DONTES`, `HOLD`, `ne churn-old` felvéve a `BLOCKED_MARKERS`-be. **Ha egy kártyán Cybersec már adott verdiktet ÉS MikroB utána HOLD-ra tette egy tulajdonosi döntés miatt, NE adj rá saját verdiktet** -- az nem hiányzó gate, hanem szándékos várakozás; a churn ilyenkor kvótaégés és zajt tesz a kártyára.
- **Nem-deklarált gate churn (2026-08-17 tanulság, cybered sweep):** egy nyers cybered-scan 18 "ungated" kártyát adott -- kártyánkénti manuális ellenőrzés mind QA-only vagy QA+Cybersec volt. Fix: a `declared_gate_excludes_me` filter a description `Gate:` sorát olvassa (az utolsó mention wins -- scope bővülhet thread közben), és ha deklaráltan nem a mi gate-ünk van ott, skip (API-komment lekérés nélkül). 18/18 false-positive megszűnt.
- **`Gate:` sor-eleji horgony hamis negatívot adott (77fd0f07 tanulság, 2026-08-17):** az első verzió `^\s*Gate:` MULTILINE horgonnyal csak a saját sorát kereste, de egyes kártyák leírásában a `Gate:` sor a prózába volt folytatva ("... szoveg. Gate: QA." -- nem saját sor). Fix: MULTILINE horgony elhagyva, `GATE_DECL_RE = re.compile(r'Gate:\s*([^\n]+)', re.IGNORECASE)` bármely pozícióban keres.
- **`[OFFLOAD]` kártyák nem Cybersec/Cybered-kúszöbűek (2026-07-25 tanulság):** a fleet-infra local-LLM offload-preset kártyák (marveen repo, `store/local-llm-skills/*` sablonok, nincs endpoint/auth/trust-boundary) rendszeresen felszínre kerülnek a scanben, de a risk-tiering szabály szerint QA-only elég. `SECURITY_GATE_LOW_RISK_TITLE_PREFIXES` a fenti kódban ezt szűri Cybersec/Cybered scan esetén (QA/QA2 scan-t NEM érinti). Durva heurisztika (cím-prefix) -- ha egy OFFLOAD-kártya REVIEW-ja credentialt/külső hálózati hívást/valódi trust-boundaryt említ, OLVASD EL a REVIEW-t és NE hagyatkozz a prefixre.
- **Redundáns REVIEW ugyanazon commiten (2026-07-24 tanulság):** A scan felszínre hozhat kártyákat ahol fron-ted/fron-teddy ÚJ REVIEW-t posztolt egy MÁR TELJESEN GATE-ELT commitra (pl. `fron-ted#4620 REVIEW: bug már ki van javítva -- commit dc074ab`). Ilyenkor a scan helyesen listázza (új REVIEW-id > utolsó verdict-id), DE: (a) ha a REVIEW-ban említett commit sha UGYANAZ mint amire a meglévő QA PASS szól, és (b) MikroB már DONE-kommentet adott -- NE gate-elj újra, csak posztolj rövid megjegyzést ("már gated @ sha, MikroB lezárhatja") és értesítsd MikroB-ot inter-agent üzenettel. Így a kártyák nem kerülnek ki a scanből (a scan helyesen jelzi a DONE-hiányt), de nem pazarolsz gate-munkát ismételt futtatásra. Valós esetek: 725d3bc9 (dc074ab), 5477ae68 (5986ccc), f1218257 (5986ccc).
- **`npm run typecheck` WIP-interferencia (2026-07-31 tanulság, 82dac857):** A typecheck a WORKING TREE-t futtatja, nem a gate-elt commitot. Ha TS-hibát kapsz gate közben, MINDIG ellenőrizd: `git diff <gated-sha> -- <file>` -- ha a hiba a WIP diff-ben van (másik agent uncommitted kódja), az NEM a gated commit hibája. Ilyenkor: (a) a committed verziót ellenőrzöd (`git show <sha>:file | grep -n ...`), (b) a QA PASS/FAIL kommentben jelzed hogy a hiba WIP-tól jött + melyik kártyától.
- **Closeable-scan false-positive: hiányzó kötelező gate (2026-07-31 tanulság, 82dac857):** A `all_gate_verdicts` csak a JELENLÉVŐ verdict-ek alapján ítél -- ha Cybersec nem adott formális verdiktet (csak "előzetes input" kommentet írt), a scan "closeable"-nak mutatja a kártyát ha QA PASS + Cybered GO van. DE: trust-boundary kártyán (új write path, tenant-scope, authz) Cybersec GO KÖTELEZŐ (rule 4). A closeable-scan csak MikroB-nak adott TÁJÉKOZTATÓ jelzés; a zárást MikroB végzi és ő ellenőrzi hogy minden kötelező gate jelen van.

## Gate reconciliation (closeable cards)

Teljes gate-állapot minden kártyához (latest verdict per gate):

```python
def all_gate_verdicts(comments):
    gates = {}
    for cm in comments:
        a = (cm.get('author') or '').lower().strip()
        if a == 'qa': gate = 'qa'
        elif a == 'qa2': gate = 'qa2'
        elif a.startswith('cybersec'): gate = 'cybersec'
        elif a == 'cybered': gate = 'cybered'
        else: continue
        first = (cm.get('content') or '').strip().split('\n')[0]
        if FAIL_RE.match(first): gates[gate] = 'fail'
        elif PASS_RE.match(first): gates[gate] = 'pass'
    return gates

# Cards where all present gates are PASS and qa2 is among them
closeable = []
for c in all_cards:
    if not isinstance(c, dict) or c.get('status') not in ('waiting', 'in_progress'): continue
    title = c.get('title') or ''
    if 'KOTOTT' in title or 'BLOKKOLT' in title: continue
    cid = c['id']
    try: comments = api(f'/api/kanban/{cid}/comments')
    except: continue
    g = all_gate_verdicts(comments)
    if g.get('qa2') == 'pass' and all(v == 'pass' for v in g.values()):
        closeable.append({'id': cid, 'status': c.get('status'), 'title': title[:60], 'gates': sorted(g)})
```

## Másodlagos scan: "gate-pending" a kártya NEVÉBEN (0d08f623 minta, 2026-08-06)
MikroB olykor a kártya NEVÉBE írja a gate-kérést (`BUILT-live, gate-pending`), nem
posztol külön REVIEW kommentet. A fő scan kihagyja (csak nem-gate kommentre figyel).

```sql
SELECT c.id, c.title, c.status
FROM kanban_cards c
WHERE c.status NOT IN ('done','cancelled')
  AND (UPPER(c.title) LIKE '%GATE-PENDING%' OR UPPER(c.title) LIKE '%BUILT-LIVE%')
  AND c.id NOT IN (
    SELECT DISTINCT card_id FROM kanban_comments
    WHERE author = 'qa2'
      AND (UPPER(content) LIKE '%QA2 PASS%' OR UPPER(content) LIKE '%QA2 FAIL%')
  );
```

Ha megtalálod: nézd meg a MikroB kommentet (commit SHA), gate-eld.
Megjegyzés: `planned -> waiting` move a POST /api/kanban/<id>/move API-n 409-et adhat;
a QA2 PASS komment elég, MikroB zárja done-ba.

## Ellenőrzés
- 0 ungated → semmi teendő, self-improve vagy vár
- N ungated → legrégebbit veszi (`created_at` szerint), gate-eli, majd újraszkenneli
