#!/usr/bin/env bash
# card-landings-rollback.sh -- the tested way BACK out of the card_landings table (card 8e99d55d,
# Fazis ed332869). Kodminosegi elv 11: a schema change counts as done only when the reverse step
# is written AND has actually been run, not assumed.
#
# WHY A SCRIPT AND NOT A DOWN-MIGRATION FILE. This repo has no numbered-migration framework: the
# whole schema is one idempotent DDL pass in src/db.ts initDatabase() (CREATE TABLE IF NOT EXISTS
# + indexes). There is no down-file to write, so the reverse step is this: drop the table and its
# indexes. The forward step then re-creates them empty on the next service start, because
# initDatabase() runs on every start -- which is also what makes this reversible at all.
#
# WHAT IT DOES NOT DO: it does not edit src/db.ts. Dropping the table while the block is still in
# initDatabase() gives you an EMPTY table again on the next restart, which is the useful state for
# backing out a bad landing-record backfill. To remove the feature entirely, drop the table AND
# revert the commit.
#
# Usage:  card-landings-rollback.sh [--db <path>] [--yes]
#         (without --yes it only reports what it would drop -- dry run is the default)
# Exit: 0 done or dry-run clean | 2 bad usage | 3 database not found
set -uo pipefail

DB="${MARVEEN_DB:-/home/neon/marveen/store/claudeclaw.db}"
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="${2:-}"; [ -n "$DB" ] || { echo "usage: --db needs a path" >&2; exit 2; }; shift 2 ;;
    --yes) APPLY=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "usage: $(basename "$0") [--db <path>] [--yes]" >&2; exit 2 ;;
  esac
done

[ -f "$DB" ] || { echo "REFUSED: no database at $DB" >&2; exit 3; }

rows=$(sqlite3 "$DB" "SELECT COUNT(*) FROM card_landings" 2>/dev/null)
if [ -z "$rows" ]; then
  echo "card_landings: not present in $DB -- nothing to roll back"
  exit 0
fi

echo "database:       $DB"
echo "card_landings:  $rows row(s)"
echo "would drop:     table card_landings, indexes idx_card_landings_card,"
echo "                idx_card_landings_repo_merge_card"
echo "after this:     the next service start re-creates all of them EMPTY (initDatabase is idempotent)"

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "DRY RUN -- nothing changed. Re-run with --yes to actually drop."
  exit 0
fi

# Indexes go with the table in SQLite's own DROP TABLE, but they are named here explicitly so this
# is readable as the exact inverse of what initDatabase() creates, and so it still cleans up if a
# partial earlier run left one behind.
sqlite3 "$DB" <<'SQL'
BEGIN;
DROP INDEX IF EXISTS idx_card_landings_repo_merge_card;
DROP INDEX IF EXISTS idx_card_landings_card;
DROP TABLE IF EXISTS card_landings;
COMMIT;
SQL
status=$?
[ "$status" -eq 0 ] || { echo "DROP FAILED (sqlite3 exit $status)" >&2; exit 3; }

left=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('card_landings','idx_card_landings_card','idx_card_landings_repo_merge_card')")
[ "$left" = "0" ] || { echo "INCOMPLETE: $left object(s) still present" >&2; exit 3; }
echo "dropped. Restart the service (or call initDatabase) to re-create it empty."
