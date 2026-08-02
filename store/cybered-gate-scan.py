#!/usr/bin/env python3
"""Cybered self-advance sweep: waiting/in_progress cards with a structural REVIEW and no
CYBERED verdict newer than that REVIEW. Adapted from the kanban-gate-scan skill (whose
last_verdict_id block is QA-specific)."""
import urllib.request, json, re

TOKEN = open('/home/neon/marveen/store/.dashboard-token').read().strip()
BASE = 'http://localhost:3420'
headers = {'Authorization': f'Bearer {TOKEN}'}

def api(path):
    req = urllib.request.Request(f'{BASE}{path}', headers=headers)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

PASS_RE = re.compile(r'^(QA2?\s+PASS|CYBERSEC\s+GO|CYBERED\s+(FULL-CARD\s+)?GO)', re.IGNORECASE)
FAIL_RE = re.compile(r'^(QA2?\s+FAIL|CYBERSEC\s+NO-GO|CYBERED\s+NO-GO)', re.IGNORECASE)
# My own verdict opener, in any of the shapes I have used (incl. "GO (feltetelekkel)").
# TIER-DÖNTÉS counts too: an explicit "this card is below my tier, and here is why" is a HANDLED
# card, not an ungated one. DUPLIKATUM(-ZARAS) counts too: an explicit "already covered by card X,
# verified by commits not just title" is also HANDLED, not ungated -- without these the sweep
# re-surfaces the same card every round and the only way to silence it would be to post a duplicate
# gate (churn).
MY_VERDICT_RE = re.compile(
    r'^\s*CYBERED\b.*(\b(GO|NO-GO)\b|TIER-D[OÖ]NT[EÉ]S|DUPLIK[AÁ]TUM)', re.IGNORECASE
)

MY_GATE = 'cybered'
SECURITY_GATE_LOW_RISK_TITLE_PREFIXES = ('[OFFLOAD]',)

def is_gate_review(cm):
    author = (cm.get('author') or '').lower().strip()
    if author in ('qa', 'qa2', 'local-llm'): return False
    content = (cm.get('content') or '').strip()
    first_line = content.split('\n')[0].upper()
    # MikroB is normally the orchestrator, not a builder, so his comments are mostly dispatch/
    # decision chatter that must NOT read as a REVIEW. But when a card is assigned to HIM (fork/infra
    # work on this repo) he builds it and posts the REVIEW himself -- blanket-excluding him hid card
    # e33af7c4 (weekly model-ladder) from this sweep entirely. So he is admitted through the STRICT
    # opener only: the first line must literally start with REVIEW, never the loose in-first-60-chars
    # fallback (which his "-> waiting+REVIEW -> QA" dispatch lines would trip).
    if author == 'mikrob': return first_line.startswith('REVIEW')
    return first_line.startswith('REVIEW') or 'REVIEW:' in content[:60].upper()

BLOCKED_MARKERS = ('BLOKKOLVA', 'KOTOTT FELTETEL', 'kotott-blokk', 'kötött-blokk',
                   'PETI DONTES', 'HOLD', 'ne churn-old', 'gate consolidated',
                   'GATE OSSZEVONVA', 'blokk:', 'NEM stuck',
                   'NEM gate-elem', 'nincs funkcionális változás, csak prep',
                   'WAITING (bound-block', 'WAITING (bound to', 'bound to CAL-', 'bound to WF-')

def _marker_re(m):
    pat = re.escape(m)
    if m[:1].isalnum(): pat = r'\b' + pat
    if m[-1:].isalnum(): pat = pat + r'\b'
    return re.compile(pat, re.IGNORECASE)

BLOCKED_RES = tuple(_marker_re(m) for m in BLOCKED_MARKERS)

def mikrob_blocked(comments):
    for cm in reversed(comments):
        if (cm.get('author') or '').lower() != 'mikrob': continue
        content = cm.get('content', '')
        if 'LOCAL-LLM DRAFT' in content: continue
        if any(r.search(content) for r in BLOCKED_RES): return True
    return False

MIKROB_CLOSED_RE = re.compile(r'\b(DONE|CLOSE|DUPLIKATUM|KONSZOLIDALVA|LEZAROM|LEZÁRVA)\b', re.IGNORECASE)
MIKROB_CLOSE_WINDOW = 24
MIKROB_NEGATED_RE = re.compile(r'\b(NEM|NINCS|NOT|NO)\W{0,3}$', re.IGNORECASE)
MIKROB_CONDITIONAL_RE = re.compile(r'^\W*(csak|only|akkor|ha)\b', re.IGNORECASE)

def mikrob_closes(content):
    first = (content or '').strip().split('\n')[0]
    m = MIKROB_CLOSED_RE.search(first)
    if not m or m.start() > MIKROB_CLOSE_WINDOW: return False
    if MIKROB_NEGATED_RE.search(first[:m.start()]): return False
    return not MIKROB_CONDITIONAL_RE.match(first[m.end():])

all_cards = api('/api/kanban')
if isinstance(all_cards, dict): all_cards = all_cards.get('cards', all_cards)

needs, gated_by_me = [], 0
for c in all_cards:
    if not isinstance(c, dict): continue
    if c.get('status') not in ('waiting', 'in_progress'): continue
    title = c.get('title') or ''
    if title.startswith(SECURITY_GATE_LOW_RISK_TITLE_PREFIXES): continue
    cid = c['id']
    try: comments = api(f'/api/kanban/{cid}/comments')
    except Exception: continue
    if not isinstance(comments, list): continue

    gate_reviews = [cm for cm in comments if is_gate_review(cm)]
    if not gate_reviews: continue
    last_review_id = max(cm['id'] for cm in gate_reviews)

    # MY verdict (cybered) newer than the last REVIEW -> already gated by me.
    my_last = max((cm['id'] for cm in comments
                   if (cm.get('author') or '').lower().strip() == MY_GATE
                   and MY_VERDICT_RE.match((cm.get('content') or '').strip())), default=-1)
    if my_last >= last_review_id:
        gated_by_me += 1
        continue

    if any(cm['id'] > last_review_id and mikrob_closes(cm.get('content'))
           for cm in comments if (cm.get('author') or '').lower() == 'mikrob'): continue
    if mikrob_blocked(comments): continue

    # Other gates' state, to see whether QA/Cybersec already ran (risk-tiering context).
    others = {}
    for cm in comments:
        a = (cm.get('author') or '').lower().strip()
        g = 'qa' if a == 'qa' else 'qa2' if a == 'qa2' else 'cybersec' if a.startswith('cybersec') else None
        if not g: continue
        first = (cm.get('content') or '').strip().split('\n')[0]
        if FAIL_RE.match(first): others[g] = 'fail'
        elif PASS_RE.match(first): others[g] = 'pass'

    rev = next((cm for cm in reversed(comments) if is_gate_review(cm)), None)
    needs.append({'id': cid, 'status': c.get('status'), 'created_at': c.get('created_at', 0),
                  'project': c.get('project'), 'assignee': c.get('assignee'),
                  'title': title[:80], 'others': others,
                  'review_author': (rev.get('author') if rev else ''),
                  'review': (rev.get('content') or '')[:400] if rev else ''})

needs.sort(key=lambda x: x['created_at'])
print(f"Ungated by cybered: {len(needs)}   (already gated by me: {gated_by_me})")
for n in needs:
    print(f"\n[{n['status']}][{n['id']}] ({n['project']}/{n['assignee']}) {n['title']}")
    print(f"  other gates: {n['others']}")
    print(f"  REVIEW by {n['review_author']}: {n['review'][:260]}")
