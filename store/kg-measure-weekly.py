#!/usr/bin/env python3
"""MT-12 (card f21b4469, parent c65add5a / MODULTERV, EK-MT-11/EK-MT-12): weekly measurement of
whether the "search first" knowledge-graph path (MT-07/MT-08) actually changes anything -- same
"did the thing change behaviour, not just exist" question card-build-route-24h-measure.sh already
asks for the local-LLM router, applied here to the kg-for-card package.

Splits cards that closed an in_progress stay inside the reporting window into two groups:
  - WITH HIT:    the card has at least one kg_usage row with event='offered' (ever) -- a for-card
                 package actually returned a non-empty result for it (src/web/routes/kg.ts only
                 writes 'offered' rows when offeredIds is non-empty).
  - WITHOUT HIT: no 'offered' row for the card at all.
For each group: median build time and average NO-GO-round count. Plus one global number: the
used/offered usage ratio (MT-08 feedback) within the window.

ASSUMPTIONS (karpathy-guidelines rule 1, stated explicitly because the MODULTERV baseline prose
does not spell these out):
  1. "build time" reuses the EXISTING, already-shipped definition from sumInProgressSeconds
     (src/db.ts): a stay opens on a kanban_card_events row with to_status='in_progress' and closes
     on the NEXT event for that card, whatever status it moves to (not specifically 'waiting') --
     this fleet already surfaces that number on every card (active_seconds), so MT-12 reuses it
     rather than inventing a second, narrower "must specifically reach waiting" measure.
  2. One sample per CLOSED stay, not one per card -- a card re-opened and re-closed more than once
     inside the window contributes one sample per closed stay (most cards have exactly one).
  3. "NO-GO rounds" = max(round) - 1 per card, from kanban_verdicts (round 1 is the first attempt;
     every round after that exists only because an earlier one sent the card back).
  4. kg-hit group membership looks at the card's 'offered' history over ALL TIME, not just inside
     the reporting window -- the hit happened once, at dispatch, and the window only filters which
     COMPLETED builds get measured.

RAW SQL (EK-MT-11: "a riport egyezzen a nyers SQL-lel"): every number below comes from one of the
named SQL_* queries; --explain prints them verbatim so a reviewer can re-run the same query by
hand and get the same answer, without reading this file's control flow.

Usage:
  kg-measure-weekly.py [--days 28] [--json] [--explain]
  kg-measure-weekly.py --kanban-db PATH --kg-db PATH   (for tests / a non-default install)
"""
import argparse
import json
import sqlite3
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_KANBAN_DB = HERE / 'claudeclaw.db'
DEFAULT_KG_DB = HERE / 'knowledge-graph.db'

SQL_EVENTS = (
    "SELECT card_id, to_status, created_at FROM kanban_card_events "
    "ORDER BY card_id, created_at ASC, id ASC"
)

SQL_MAX_ROUND_PER_CARD = (
    "SELECT card_id, MAX(round) AS max_round FROM kanban_verdicts GROUP BY card_id"
)

SQL_OFFERED_CARD_IDS = "SELECT DISTINCT card_id FROM kg_usage WHERE event = 'offered'"

SQL_USAGE_COUNTS_IN_WINDOW = (
    "SELECT event, COUNT(*) AS n FROM kg_usage WHERE created_at >= ? GROUP BY event"
)


def closed_stays(events):
    """Mirrors sumInProgressSeconds (src/db.ts) exactly, but yields each CLOSED stay's
    (card_id, opened_at, closed_at) instead of summing -- an open (still-running) stay at the end
    of a card's event list is dropped here (not charged to 'now'): a report is read after the
    fact, and a stay that has not closed yet has no build time to measure."""
    out = []
    current = None
    opened_at = None
    for card_id, to_status, created_at in events:
        if card_id != current:
            current, opened_at = card_id, None
        if opened_at is not None:
            out.append((current, opened_at, created_at))
            opened_at = None
        if to_status == 'in_progress':
            opened_at = created_at
    return out


def median(values):
    return statistics.median(values) if values else None


def run(kanban_db_path, kg_db_path, days, explain):
    now = int(__import__('time').time())
    cutoff = now - days * 86400

    kconn = sqlite3.connect(f'file:{kanban_db_path}?mode=ro', uri=True)
    events = kconn.execute(SQL_EVENTS).fetchall()
    round_rows = kconn.execute(SQL_MAX_ROUND_PER_CARD).fetchall()
    kconn.close()
    max_round = {card_id: r for card_id, r in round_rows}

    offered_cards = set()
    usage_counts = {'offered': 0, 'used': 0, 'not_relevant': 0, 'harmful': 0}
    kg_db_present = kg_db_path.exists()
    if kg_db_present:
        gconn = sqlite3.connect(f'file:{kg_db_path}?mode=ro', uri=True)
        offered_cards = {row[0] for row in gconn.execute(SQL_OFFERED_CARD_IDS).fetchall()}
        for event, n in gconn.execute(SQL_USAGE_COUNTS_IN_WINDOW, (cutoff,)).fetchall():
            usage_counts[event] = n
        gconn.close()

    stays_in_window = [s for s in closed_stays(events) if s[2] >= cutoff]

    with_hit_times, without_hit_times = [], []
    with_hit_rounds, without_hit_rounds = [], []
    seen_for_rounds = set()  # one round sample per card, not per stay
    for card_id, opened_at, closed_at in stays_in_window:
        duration = closed_at - opened_at
        hit = card_id in offered_cards
        (with_hit_times if hit else without_hit_times).append(duration)
        if card_id not in seen_for_rounds:
            seen_for_rounds.add(card_id)
            mr = max_round.get(card_id)
            if mr is not None:
                (with_hit_rounds if hit else without_hit_rounds).append(max(0, mr - 1))

    offered_n = usage_counts.get('offered', 0)
    used_n = usage_counts.get('used', 0)
    used_offered_ratio = (used_n / offered_n) if offered_n > 0 else None

    result = {
        'days': days,
        'kg_db_present': kg_db_present,
        'with_hit': {
            'cards_measured': len(with_hit_times),
            'median_build_seconds': median(with_hit_times),
            'avg_no_go_rounds': (sum(with_hit_rounds) / len(with_hit_rounds)) if with_hit_rounds else None,
        },
        'without_hit': {
            'cards_measured': len(without_hit_times),
            'median_build_seconds': median(without_hit_times),
            'avg_no_go_rounds': (sum(without_hit_rounds) / len(without_hit_rounds)) if without_hit_rounds else None,
        },
        'usage_window': {
            'offered': offered_n,
            'used': used_n,
            'not_relevant': usage_counts.get('not_relevant', 0),
            'harmful': usage_counts.get('harmful', 0),
            'used_offered_ratio': used_offered_ratio,
        },
    }

    if explain:
        sys.stderr.write('-- SQL_EVENTS --\n' + SQL_EVENTS + ';\n')
        sys.stderr.write('-- SQL_MAX_ROUND_PER_CARD --\n' + SQL_MAX_ROUND_PER_CARD + ';\n')
        sys.stderr.write('-- SQL_OFFERED_CARD_IDS (against knowledge-graph.db) --\n' + SQL_OFFERED_CARD_IDS + ';\n')
        sys.stderr.write('-- SQL_USAGE_COUNTS_IN_WINDOW (against knowledge-graph.db, cutoff=%d) --\n' % cutoff
                          + SQL_USAGE_COUNTS_IN_WINDOW + ';\n')

    return result


def human(result):
    lines = []
    lines.append('kg-measure-weekly: last %d day(s)%s' % (
        result['days'], '' if result['kg_db_present'] else ' -- knowledge-graph.db nem letezik meg, csak a kanban-oldali szamok ertekelhetok'))
    wh, wo = result['with_hit'], result['without_hit']
    lines.append('  TALALATTAL (%d kartya): median epitesi ido = %s, atlagos NO-GO-kor = %s' % (
        wh['cards_measured'],
        ('%ds' % wh['median_build_seconds']) if wh['median_build_seconds'] is not None else 'n/a',
        ('%.2f' % wh['avg_no_go_rounds']) if wh['avg_no_go_rounds'] is not None else 'n/a',
    ))
    lines.append('  TALALAT NELKUL (%d kartya): median epitesi ido = %s, atlagos NO-GO-kor = %s' % (
        wo['cards_measured'],
        ('%ds' % wo['median_build_seconds']) if wo['median_build_seconds'] is not None else 'n/a',
        ('%.2f' % wo['avg_no_go_rounds']) if wo['avg_no_go_rounds'] is not None else 'n/a',
    ))
    u = result['usage_window']
    lines.append('  felhasznalas az ablakban: offered=%d used=%d not_relevant=%d harmful=%d, used/offered=%s' % (
        u['offered'], u['used'], u['not_relevant'], u['harmful'],
        ('%.3f' % u['used_offered_ratio']) if u['used_offered_ratio'] is not None else 'n/a',
    ))
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--days', type=int, default=28)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--explain', action='store_true', help='print the raw SQL used, to stderr')
    ap.add_argument('--kanban-db', default=str(DEFAULT_KANBAN_DB))
    ap.add_argument('--kg-db', default=str(DEFAULT_KG_DB))
    args = ap.parse_args()

    kanban_db_path = Path(args.kanban_db)
    if not kanban_db_path.exists():
        sys.stderr.write('kg-measure-weekly: no kanban DB at %s -- nothing to measure yet\n' % kanban_db_path)
        sys.exit(0)

    result = run(kanban_db_path, Path(args.kg_db), args.days, args.explain)
    print(json.dumps(result) if args.json else human(result))
    sys.exit(0)


if __name__ == '__main__':
    main()
