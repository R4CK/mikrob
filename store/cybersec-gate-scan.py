#!/usr/bin/env python3
"""Cybersec self-advance scanner: waiting/in_progress kanban cards carrying a REVIEW
comment with no cybersec verdict after it. Lives in store/ so a scratchpad wipe
does not lose it (store/ is gitignored; ops scripts are the tracked exception)."""
import json
import re
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


def _marker_pattern(w):
    """Word-bounded ONLY where the marker begins/ends in a word character.

    `\\b` is defined between a word and a non-word character, so wrapping a marker that
    already starts or ends in punctuation -- 'WAITING (bound to', 'blokk:' -- in
    unconditional `\\b` produces a regex that can never match. Those markers were
    therefore silently inert before this helper existed (same class as the shared
    gate-scan skill's `_marker_re`).
    """
    pat = re.escape(w)
    if w[:1].isalnum():
        pat = r'\b' + pat
    if w[-1:].isalnum():
        pat = pat + r'\b'
    return pat


# Every phrasing MikroB actually uses to park a card. Narrower lists surfaced HOLD'd
# cards as ungated and cost redundant tiering notes (b92c10d4 2026-07-31: the real text
# was 'WAITING (kotott-blokk, Peti-dontes)' + 'Addig ne churn-old', none of which the
# BLOKKOLVA/KOTOTT pair matched; 82ea4267: 'WAITING (bound to CAL-5 make-live, ...)').
# Direction of failure matters here: a missing marker only causes churn, never a missed
# gate -- but the churn is quota, and it repeats every sweep until the card closes.
BLOCK_MARKERS = (
    'BLOKKOLVA', 'KOTOTT', 'KÖTÖTT', 'kotott-blokk', 'kötött-blokk',
    'PETI DONTES', 'PETI DÖNTÉS', 'HOLD', 'ne churn-old',
    'gate consolidated', 'GATE OSSZEVONVA', 'blokk:',
    'WAITING (bound-block', 'WAITING (bound to', 'bound to CAL-', 'bound to WF-',
)

# Fleet-infra local-LLM offload cards (marveen repo, shell/template presets) carry no
# endpoint, auth surface or trust boundary, so rule 4 risk-tiering puts them at QA-only.
# Coarse heuristic by design: if such a card's REVIEW mentions credentials, an external
# network call or any real trust boundary, READ IT -- do not trust the prefix.
LOW_RISK_TITLE_PREFIXES = ('[OFFLOAD]',)


def mikrob_marker(c, words, anchored=False):
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
    # FIRST LINE only, WORD-BOUNDED (card 3307b428 F3, the same class as lesson f11d23eb which the
    # shared gate-scan skill already learned and this scanner never did). Matching the whole body
    # meant the standard tiering sentence "DONE csak QA PASS + Cybersec GO" -- a REQUEST for gating,
    # written mid-comment -- dropped the card out of the sweep, and 'DONE' also hides inside
    # 'ABANDONED', exactly like 'HOLD' inside 'placeholder'.
    #
    # `anchored` = CLOSE marker (card b3b7e734). My first version demanded a hard line-start anchor;
    # backend measured that against the real board and it was WRONG -- 491 of 1196 first-line hits
    # sit behind a short tag or lead-in and are REAL closes ("[GATE CLOSE] ... -> DONE.",
    # "RE-CLOSE DONE (...)", "CLOSED done: QA PASS ..."). I re-measured on my own sweep data: a hard
    # anchor recognises 147 of 258, this rule 176. So position + shape, matching the shared skill:
    # the marker must fall within the first 24 characters, must not be negated right before it
    # ("HOLD (NEM done)"), and must not be followed by a condition -- "DONE csak QA PASS + Cybersec
    # GO" states what WOULD close the card, which is the sentence that started this whole thread.
    # BLOCK markers stay an unanchored word-bounded search: they legitimately appear mid-line
    # ("WAITING (kotott-blokk, Peti-dontes)").
    first = content.strip().split('\n')[0]
    if not anchored:
        return any(re.search(_marker_pattern(w), first, re.IGNORECASE) for w in words)
    for w in words:
        m = re.search(_marker_pattern(w), first, re.IGNORECASE)
        if not m or m.start() > 24:
            continue
        if re.search(r'\b(NEM|NINCS|NOT|NO)\W{0,3}$', first[:m.start()], re.IGNORECASE):
            continue
        if re.match(r'^\W*(csak|only|akkor|ha)\b', first[m.end():], re.IGNORECASE):
            continue
        return True
    return False


def main():
    cards = [c for c in get('/api/kanban') if c.get('status') in ('waiting', 'in_progress')]
    out = []
    skipped_low_risk = []
    for card in cards:
        cid = card.get('id')
        if (card.get('title') or '').startswith(LOW_RISK_TITLE_PREFIXES):
            skipped_low_risk.append(cid)
            continue
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
        if any(mikrob_marker(c, ('DONE', 'CLOSE', 'LEZAROM', 'LEZÁRVA'), anchored=True) for c in after):
            continue
        if any(mikrob_marker(c, BLOCK_MARKERS) for c in after):
            continue
        if tiered_out(comments):
            continue
        out.append((card, review))

    out.sort(key=lambda x: x[1].get('created_at', 0))
    # Never let a coverage reduction be silent: a skipped card must be visible, or the
    # sweep reads as "nothing to gate" when it means "I chose not to look".
    if skipped_low_risk:
        print(f'Skipped (low-risk title prefix, QA-only tier): {", ".join(skipped_low_risk)}')
    print(f'Ungated (cybersec): {len(out)}')
    for card, review in out:
        print(f"{card.get('id')} | {card.get('title')} | assignee={card.get('assignee')} "
              f"| review_by={review.get('author')} @ {review.get('created_at')}")


if __name__ == '__main__':
    main()
