---
name: kanban-blokkolt-reconcile
description: Find BLOKKOLT-landolasra waiting cards whose gate commit is NOW on origin/main. Reports which are ready for DONE, sends reconciliation to MikroB. Run at session start or when notified of a push to origin/main.
---
# Kanban BLOKKOLT Reconciliation

## Mikor használd
- Session start: check if any stale BLOKKOLT cards have resolved
- After a `git push origin main` or a fetch that shows origin/main moved
- When MikroB's landed-check sweep marked cards BLOKKOLT but time has passed
- Rule 4a: "minden MikroB-ébredéskor kötelező board-reconciliation sweep"

## Eljárás

```python
import os, subprocess, re, json
import urllib.request

TOKEN = open('/home/neon/marveen/store/.dashboard-token').read().strip()
BASE = 'http://localhost:3420'
# A FŐ klón, szándékosan (kártya 973ed6eb): ez a kérdés az, hogy egy sha LANDOLT-e az
# origin/main-en -- landolás-ellenőrzés, nem munka. Ügynök-worktree-t itt ne használj, és ide
# ne is commitolj.
CLEANCORE = os.environ.get('CLEANCORE_MAIN', '/mnt/h/LM_Studio_Workdir/CleanCore')

def api(path, method='GET', body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f'{BASE}{path}',
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'},
        data=data, method=method)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

def git_on_main(sha):
    """True if sha is an ancestor of origin/main."""
    r = subprocess.run(
        ['git', '-C', CLEANCORE, 'merge-base', '--is-ancestor', sha, 'origin/main'],
        capture_output=True)
    return r.returncode == 0

def last_commit_from_comments(comments):
    """Extract the most recent 8+ char hex hash from gate/mikrob comments."""
    SHA_RE = re.compile(r'\b([0-9a-f]{8,10})\b')
    # Reverse-chronological, skip backend2 (its hashes reference sweep state, not the fix)
    for c in reversed(sorted(comments, key=lambda x: x.get('created_at', 0))):
        author = (c.get('author') or '').lower()
        if 'backend2' in author or 'pretriage' in author:
            continue
        content = c.get('content', '')
        # Only look at comments that mention PASS/GO/DONE with a commit ref
        if not any(k in content[:200] for k in ('PASS', 'GO', 'DONE', 'GATE-TELJES')):
            continue
        hashes = SHA_RE.findall(content)
        if hashes:
            return hashes[0]
    return None

def gate_verdicts(comments):
    """Returns set of gate agents that gave PASS/GO."""
    PASS_RE = re.compile(r'^(QA2?\s+PASS|CYBERSEC\s+GO|CYBERED\s+(FULL-CARD\s+)?GO)', re.IGNORECASE)
    verdicts = set()
    for c in comments:
        first = (c.get('content') or '').strip().split('\n')[0]
        if PASS_RE.match(first):
            verdicts.add((c.get('author') or '').lower())
    return verdicts

# 1. Fetch all waiting cards
cards = api('/api/kanban?status=waiting')
if isinstance(cards, dict):
    cards = cards.get('cards', [])

# 2. Filter BLOKKOLT-landolasra
blokkolt = [c for c in cards if 'BLOKKOLT-landolasra' in c.get('title', '')]
print(f'Found {len(blokkolt)} BLOKKOLT-landolasra cards')

# 3. For each, find commit hash and check origin/main
ready = []
for card in blokkolt:
    cid = card['id']
    comments = api(f'/api/kanban/{cid}/comments')
    if not isinstance(comments, list):
        continue
    sha = last_commit_from_comments(comments)
    if not sha:
        print(f'  {cid[:8]} -- no commit hash found, skip')
        continue
    if git_on_main(sha):
        verdicts = gate_verdicts(comments)
        ready.append({
            'id': cid[:8],
            'priority': card.get('priority', '?'),
            'title': card['title'][:70],
            'sha': sha,
            'verdicts': list(verdicts),
        })
        print(f'  READY: {cid[:8]} ({card.get("priority","?")}) @ {sha} -- {verdicts}')
    else:
        print(f'  blocked: {cid[:8]} @ {sha} -- NOT on main')

# 4. Send reconciliation to MikroB if any ready
if ready:
    lines = ['[BLOKKOLT-reconcilialas -- automatikus]\n']
    for r in ready:
        lines.append(f"- {r['id']} ({r['priority']}) @ {r['sha']}: {', '.join(r['verdicts'])} -- ON main, zarhatoa DONE")
    lines.append('\nForrás: kanban-blokkolt-reconcile skill (fron-ted)')
    msg = '\n'.join(lines)
    api('/api/messages', 'POST', {'from': 'fron-ted', 'to': 'mikrob', 'content': msg})
    print(f'\nSent {len(ready)} cards to MikroB for reconciliation.')
else:
    print('No stale BLOKKOLT cards found -- board is clean.')
```

## Buktatók

- `backend2` comments contain the sweep-time SHA (9cc72f2c / a5dcabb7), not the fix commit -- skip `backend2` author when looking for the commit hash
- `gate-pretriage` comments also reference the fix commit but are NOT gate verdicts -- safe to include for hash extraction, exclude for verdicts
- `git merge-base --is-ancestor` returns 0 (True) if sha is an ancestor; non-zero if not. Fatal error if sha is completely unknown (not a valid object) -- catch that case.
- SHA collision: 8-char hex collisions are rare but possible; prefer longer hashes from comments

## Ellenőrzés

- Every `READY` card should have at least 2 gate verdicts (QA always; risk-appropriate second gate)
- Content-verify for borderline cases (MikroB's "SÚLYOS" correction pattern) -- if MikroB said "túl korai DONE" after a DONE close, re-read the code to confirm the fix is actually present before sending to reconciliation
- After MikroB closes the cards, re-run to confirm the board is clean
