#!/usr/bin/env bash
# Selftest for store/kg-measure-weekly.py (card f21b4469, MT-12/EK-MT-11/EK-MT-12).
#
# Builds synthetic kanban + knowledge-graph fixture DBs with hand-computed expected numbers, so
# this pins the ACTUAL arithmetic (median/average/ratio), not just "the script runs" -- the exact
# gap EK-MT-11 calls out ("egyezzen a nyers SQL-lel").
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

KANBAN_DB="$WORKDIR/claudeclaw.db"
KG_DB="$WORKDIR/knowledge-graph.db"

NOW="$(date +%s)"
T0=$(( NOW - 100000 ))     # inside the 28-day window
OLD=$(( NOW - 40 * 86400 )) # outside the 28-day window

sqlite3 "$KANBAN_DB" <<SQL
CREATE TABLE kanban_card_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT,
  created_at INTEGER NOT NULL,
  forced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE kanban_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  verdict TEXT NOT NULL,
  sha TEXT,
  round INTEGER NOT NULL DEFAULT 1,
  findings_ref TEXT,
  proposer TEXT,
  author TEXT NOT NULL,
  author_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- cardA (hit): in_progress -> waiting, duration 1000s
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardA', 'in_progress', $T0);
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardA', 'waiting', $T0 + 1000);
-- cardB (hit): in_progress -> planned (NOT waiting -- exercises assumption 1), duration 2000s
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardB', 'in_progress', $T0);
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardB', 'planned', $T0 + 2000);
-- cardC (no hit): in_progress -> waiting, duration 3000s
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardC', 'in_progress', $T0);
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardC', 'waiting', $T0 + 3000);
-- cardD (no hit): in_progress -> waiting, duration 4000s
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardD', 'in_progress', $T0);
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardD', 'waiting', $T0 + 4000);
-- cardOLD (no hit): stay closes OUTSIDE the 28-day window -- must be excluded entirely
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardOLD', 'in_progress', $OLD - 500);
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardOLD', 'waiting', $OLD);
-- cardOPEN: in_progress with no closing event -- an open stay, must NOT be counted (nothing to measure yet)
INSERT INTO kanban_card_events (card_id, to_status, created_at) VALUES ('cardOPEN', 'in_progress', $T0);

INSERT INTO kanban_verdicts (card_id, gate, verdict, author, round, created_at) VALUES ('cardA', 'qa', 'QA PASS', 'qa', 1, $T0 + 1000);
INSERT INTO kanban_verdicts (card_id, gate, verdict, author, round, created_at) VALUES ('cardB', 'qa', 'QA PASS', 'qa', 2, $T0 + 2000);
INSERT INTO kanban_verdicts (card_id, gate, verdict, author, round, created_at) VALUES ('cardC', 'qa', 'QA PASS', 'qa', 1, $T0 + 3000);
INSERT INTO kanban_verdicts (card_id, gate, verdict, author, round, created_at) VALUES ('cardD', 'qa', 'QA PASS', 'qa', 3, $T0 + 4000);
SQL

sqlite3 "$KG_DB" <<SQL
CREATE TABLE kg_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('offered','used','not_relevant','harmful')),
  created_at INTEGER NOT NULL
);
INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES ('sol:1', 'cardA', 'fullstack', 'offered', $T0);
INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES ('sol:1', 'cardA', 'fullstack', 'used', $T0 + 1);
INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES ('sol:2', 'cardB', 'fullstack', 'offered', $T0);
SQL

OUT="$(python3 -I "$SCRIPT_DIR/kg-measure-weekly.py" --kanban-db "$KANBAN_DB" --kg-db "$KG_DB" --days 28 --json)"

PASS_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "PASS $1"; }
fail() { echo "FAIL: $1 -- full output: $OUT" >&2; exit 1; }

get() { printf '%s' "$OUT" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }

# --- with_hit: cardA (1000s) + cardB (2000s) -> median 1500, cardOLD/cardOPEN excluded ---
[ "$(get "['with_hit']['cards_measured']")" = "2" ] || fail "with_hit cards_measured expected 2"
[ "$(get "['with_hit']['median_build_seconds']")" = "1500.0" ] || fail "with_hit median expected 1500.0, got $(get "['with_hit']['median_build_seconds']")"
pass "F1 (EK-MT-11): with-hit median build time = 1500s (cardA 1000s, cardB 2000s -- cardB closed to 'planned', not 'waiting', and still counted per assumption 1)"

# --- without_hit: cardC (3000s) + cardD (4000s) -> median 3500 ---
[ "$(get "['without_hit']['cards_measured']")" = "2" ] || fail "without_hit cards_measured expected 2"
[ "$(get "['without_hit']['median_build_seconds']")" = "3500.0" ] || fail "without_hit median expected 3500.0, got $(get "['without_hit']['median_build_seconds']")"
pass "F2 (EK-MT-11): without-hit median build time = 3500s (cardC 3000s, cardD 4000s)"

# --- NO-GO rounds: with_hit avg(0,1)=0.5, without_hit avg(0,2)=1.0 ---
[ "$(get "['with_hit']['avg_no_go_rounds']")" = "0.5" ] || fail "with_hit avg_no_go_rounds expected 0.5, got $(get "['with_hit']['avg_no_go_rounds']")"
[ "$(get "['without_hit']['avg_no_go_rounds']")" = "1.0" ] || fail "without_hit avg_no_go_rounds expected 1.0, got $(get "['without_hit']['avg_no_go_rounds']")"
pass "F3: avg NO-GO rounds = max(round)-1 per card, with_hit 0.5 (cardA round1->0, cardB round2->1), without_hit 1.0 (cardC round1->0, cardD round3->2)"

# --- used/offered ratio: offered=2 (cardA, cardB), used=1 (cardA) -> 0.5 ---
[ "$(get "['usage_window']['offered']")" = "2" ] || fail "offered expected 2"
[ "$(get "['usage_window']['used']")" = "1" ] || fail "used expected 1"
[ "$(get "['usage_window']['used_offered_ratio']")" = "0.5" ] || fail "used_offered_ratio expected 0.5, got $(get "['usage_window']['used_offered_ratio']")"
pass "F4 (EK-MT-11): used/offered ratio = 1/2 = 0.5"

# --- cardOLD (closed 40 days ago) must be EXCLUDED from both groups entirely ---
TOTAL_MEASURED=$(( $(get "['with_hit']['cards_measured']") + $(get "['without_hit']['cards_measured']") ))
[ "$TOTAL_MEASURED" = "4" ] || fail "expected exactly 4 measured stays (cardA/B/C/D), cardOLD excluded and cardOPEN excluded, got $TOTAL_MEASURED"
pass "F5: a stay that closed outside the --days window is excluded from both groups"

# --- missing knowledge-graph.db: must degrade gracefully (kg_db_present=false), not crash ---
OUT_NOKG="$(python3 -I "$SCRIPT_DIR/kg-measure-weekly.py" --kanban-db "$KANBAN_DB" --kg-db "$WORKDIR/does-not-exist.db" --days 28 --json)"
printf '%s' "$OUT_NOKG" | python3 -I -c "import json,sys; d=json.load(sys.stdin); assert d['kg_db_present'] is False; assert d['usage_window']['offered'] == 0" \
  || fail "expected kg_db_present=false and offered=0 when knowledge-graph.db is missing"
pass "F6: missing knowledge-graph.db degrades to kg_db_present=false, no crash, no fake data"

# --- missing kanban DB entirely: exit 0, informational stderr, no crash (same posture as the
#     other store/*-measure.sh scripts when their source has no data yet) ---
RC=0
python3 -I "$SCRIPT_DIR/kg-measure-weekly.py" --kanban-db "$WORKDIR/no-such-kanban.db" --kg-db "$KG_DB" > /dev/null 2>&1 || RC=$?
[ "$RC" = "0" ] || fail "expected exit 0 when the kanban DB is missing, got $RC"
pass "F7: missing kanban DB -> exit 0, nothing to measure yet"

echo "selftest: $PASS_COUNT passed, 0 failed"
