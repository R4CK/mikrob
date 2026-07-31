#!/usr/bin/env python3
"""Cybersec self-advance scanner: waiting/in_progress kanban cards carrying a REVIEW
comment with no cybersec verdict after it. Lives in store/ so a scratchpad wipe
does not lose it (store/ is gitignored; ops scripts are the tracked exception)."""
import json
import urllib.request

TOKEN = open('/home/neon/marveen/store/.dashboard-token').read().strip()


def get(path):
    req = urllib.request.Request(f'http://localhost:3420{path}',
                                 headers={'Authorization': f'Bearer {TOKEN}'})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def is_review(c):
    """A build-complete REVIEW comment.

    MikroB is NOT excluded: he authors the REVIEW on his own cards, and excluding him
    hid those cards from this scanner entirely (found 2026-07-31 by auditing every open
    card by hand -- the same silent-skip class flagged on 592e7cd0, in this tool).
    He IS held to the strict prefix only, because his dispatch/relay comments quote the
    word REVIEW mid-text and the loose clause would match them.
    """
    author = (c.get('author') or '').lower()
    if author in ('qa', 'qa2'):
        return False
    # Local-model drafts are not gate requests (card 3307b428). They post under their own author now
    # (store/offload-dispatch.sh), and the old author='mikrob' used to suppress them here by accident;
    # deny-list the draft author so that protection is deliberate instead of incidental.
    if author == 'local-llm':
        return False
    content = c.get('content') or ''
    first = content.split('\n', 1)[0]
    if first.strip().upper().startswith('REVIEW'):
        return True
    if author == 'mikrob':
        return False
    return 'REVIEW:' in content[:60].upper()


def is_cybersec_verdict(c):
    if not (c.get('author') or '').lower().startswith('cybersec'):
        return False
    return (c.get('content') or '').lstrip().upper().startswith('CYBERSEC')


TIER_OUT_PHRASES = (
    'CYBERSEC NEM SZUKSEGES',
    'CYBERSEC NEM KELL',
    'NO CYBERSEC',
    'CYBERSEC NOT NEEDED',
)


def tiered_out(comments):
    """MikroB owns risk-tiering (rule 4): he may assign a card QA-only. Respect that
    instead of resurfacing it every sweep -- an explicit 'Cybersec not needed' is a
    decision, not an omission. Only MikroB's own words count."""
    for c in comments:
        if (c.get('author') or '').lower() != 'mikrob':
            continue
        up = (c.get('content') or '').upper()
        if any(p in up for p in TIER_OUT_PHRASES):
            return True
    return False


def mikrob_marker(c, words):
    """A DIRECTIVE from MikroB (DONE / blocked), not merely a comment bearing his name.

    Dispatch-time local-LLM offload USED TO post 7B free text to the card with
    author='mikrob' (store/offload-dispatch.sh), so an unfiltered author check read
    model output as an orchestrator decision. Measured 2026-07-31: 27 such drafts, 8
    carrying one of these words, 1 of them posted AFTER a REVIEW -- i.e. the ordering
    that silently drops a card from this sweep was reachable, not theoretical.

    Fixed at the source by card 3307b428: new drafts are signed 'local-llm', so they
    never reach the author=='mikrob' branch at all. The content check below STAYS --
    those 27 historical drafts are still in the database under the orchestrator's name
    and would still be misread without it. Removing it would re-open the bug for the
    existing rows.
    """
    if (c.get('author') or '').lower() != 'mikrob':
        return False
    content = c.get('content') or ''
    if 'LOCAL-LLM DRAFT' in content:
        return False
    up = content.upper()
    return any(w in up for w in words)


def main():
    cards = [c for c in get('/api/kanban') if c.get('status') in ('waiting', 'in_progress')]
    out = []
    for card in cards:
        cid = card.get('id')
        try:
            comments = sorted(get(f'/api/kanban/{cid}/comments'),
                              key=lambda c: c.get('created_at', 0))
        except Exception as e:
            print(f'skip {cid}: {e}')
            continue
        review = None
        for c in comments:
            if is_review(c):
                review = c
        if not review:
            continue
        t = review.get('created_at', 0)
        after = [c for c in comments if c.get('created_at', 0) >= t]
        if any(is_cybersec_verdict(c) for c in after):
            continue
        if any(mikrob_marker(c, ('DONE',)) for c in after):
            continue
        if any(mikrob_marker(c, ('BLOKKOLVA', 'KOTOTT', 'KÖTÖTT')) for c in after):
            continue
        if tiered_out(comments):
            continue
        out.append((card, review))

    out.sort(key=lambda x: x[1].get('created_at', 0))
    print(f'Ungated (cybersec): {len(out)}')
    for card, review in out:
        print(f"{card.get('id')} | {card.get('title')} | assignee={card.get('assignee')} "
              f"| review_by={review.get('author')} @ {review.get('created_at')}")


if __name__ == '__main__':
    main()
