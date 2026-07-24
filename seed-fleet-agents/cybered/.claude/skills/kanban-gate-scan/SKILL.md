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

TOKEN = open('{{INSTALL_DIR}}/store/.dashboard-token').read().strip()
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
    if author in ('mikrob', 'qa', 'qa2'): return False
    content = (cm.get('content') or '').strip()
    first_line = content.split('\n')[0].upper()
    # Structural: starts with REVIEW, or first 60 chars contain 'REVIEW:'
    return first_line.startswith('REVIEW') or 'REVIEW:' in content[:60].upper()

# MikroB-blocked markers: skip cards where MikroB says the gate is deferred/consolidated
BLOCKED_MARKERS = ('BLOKKOLVA', 'KOTOTT FELTETEL', 'gate consolidated',
                   'GATE OSSZEVONVA', 'blokk:', 'NEM stuck')

def mikrob_blocked(comments):
    for cm in reversed(comments):
        if (cm.get('author') or '').lower() != 'mikrob': continue
        content = cm.get('content', '')
        if any(m.lower() in content.lower() for m in BLOCKED_MARKERS):
            return True
    return False

needs = []
for c in all_cards:
    if not isinstance(c, dict): continue
    if c.get('status') not in ('waiting', 'in_progress'): continue
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

    # Skip if mikrob DONE'd after the last review
    mikrob_done_after = any(
        cm['id'] > last_review_id and 'DONE' in (cm.get('content') or '')
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
- **NE `startswith('qa')`** -- `qa2` is illeszkedne rá. Használj `== 'qa'` pontosan.
- **NE `'NO-GO' in content`** -- hamis FAIL-t ad GO-verdikten belüli "NO-GO" hivatkozásra. Mindig a **nyitósor regex** dönt.
- **NE `gates_pass - gates_fail` set-különbség** -- az early NO-GO törli a later GO-t. Latest-verdict-per-gate logika kell: minden gate-nél az utolsó komment dönt.
- **Cybersec NOTE false positive**: ha a Cybersec "deferred NOTE"-ban írja hogy "fron-ted's REVIEW is correct..." -- ez NEM gate-REVIEW kérés. Az `is_gate_review()` a strukturális REVIEW markert nézi (első sor / első 60 char), nem a mid-sentence előfordulást.
- **MikroB-blokkolt kártya**: ha MikroB azt írja "gate consolidated" / "GATE OSSZEVONVA" / más write-path kártyával együtt gate-elünk -- skip, ne gate-elj önállóan.
- **MikroB DONE után nyílt vissza**: ha MikroB DONE'd, majd egy új REVIEW jött be UTÁNA (pl. redundáns fron-teddy REVIEW), a `mikrob_done_after` check csak az AFTER-t nézi, tehát helyesen kiszűri a DONE-at megelőző REVIEW-kat.
- A scan `waiting` ÉS `in_progress` kártyákat is ellenőriz -- REVIEW bekerülhet mindkét státuszban.
- Ha a scan 0-t ad de sok waiting kártya van: ellenőrizd, hogy nem az auth token érvénytelen-e, és hogy a komment endpoint valóban visszaad adatot.
- **Redundáns REVIEW ugyanazon commiten (2026-07-24 tanulság):** A scan felszínre hozhat kártyákat ahol fron-ted/fron-teddy ÚJ REVIEW-t posztolt egy MÁR TELJESEN GATE-ELT commitra (pl. `fron-ted#4620 REVIEW: bug már ki van javítva -- commit dc074ab`). Ilyenkor a scan helyesen listázza (új REVIEW-id > utolsó verdict-id), DE: (a) ha a REVIEW-ban említett commit sha UGYANAZ mint amire a meglévő QA PASS szól, és (b) MikroB már DONE-kommentet adott -- NE gate-elj újra, csak posztolj rövid megjegyzést ("már gated @ sha, MikroB lezárhatja") és értesítsd MikroB-ot inter-agent üzenettel. Így a kártyák nem kerülnek ki a scanből (a scan helyesen jelzi a DONE-hiányt), de nem pazarolsz gate-munkát ismételt futtatásra. Valós esetek: 725d3bc9 (dc074ab), 5477ae68 (5986ccc), f1218257 (5986ccc).

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

## Ellenőrzés
- 0 ungated → semmi teendő, self-improve vagy vár
- N ungated → legrégebbit veszi (`created_at` szerint), gate-eli, majd újraszkenneli
