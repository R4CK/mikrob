#!/usr/bin/env bash
# kanban-relations-rollback.sh -- the tested way BACK out of the kanban_relations table (card
# 9d7a247a, Fazis fe3eff9f). Kodminosegi elv 11: a schema change counts as done only when the
# reverse step is written AND has actually been run, not assumed.
#
# WHY A SCRIPT AND NOT A DOWN-MIGRATION FILE. This repo has no numbered-migration framework: the
# whole schema is one idempotent DDL pass in src/db.ts initDatabase() (CREATE TABLE IF NOT EXISTS
# + try/catch ALTER TABLE). There is no down-file to write, so the reverse step is this: drop the
# table, its index and its triggers. The forward step then re-creates them empty on the next
# service start, because initDatabase() runs on every start -- which is also what makes this
# reversible at all.
#
# WHAT IT DOES NOT DO: it does not edit src/db.ts. Dropping the table while the block is still in
# initDatabase() gives you an EMPTY table again on the next restart, which is the useful state for
# backing out a bad backfill. To remove the feature entirely, drop the table AND revert the commit.
#
# Usage:  kanban-relations-rollback.sh [--db <path>] [--yes]
#         (without --yes it only reports what it would drop -- dry run is the default)
# Exit: 0 done or dry-run clean | 2 bad usage | 3 database not found
set -uo pipefail

DB="${MARVEEN_DB:-/home/neon/marveen/store/claudeclaw.db}"
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="${2:-}"; [ -n "$DB" ] || { echo "usage: --db needs a path" >&2; exit 2; }; shift 2 ;;
    --yes) APPLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "usage: $(basename "$0") [--db <path>] [--yes]" >&2; exit 2 ;;
  esac
done

[ -f "$DB" ] || { echo "REFUSED: no database at $DB" >&2; exit 3; }

rows=$(sqlite3 "$DB" "SELECT COUNT(*) FROM kanban_relations" 2>/dev/null)
if [ -z "$rows" ]; then
  echo "kanban_relations: not present in $DB -- nothing to roll back"
  exit 0
fi

echo "database:        $DB"
echo "kanban_relations: $rows row(s)"
echo "would drop:      table kanban_relations, index idx_kanban_relations_to,"
echo "                 triggers trg_kanban_relations_created_at_epoch_{insert,update}"
echo "after this:      the next service start re-creates all of them EMPTY (initDatabase is idempotent)"

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "DRY RUN -- nothing changed. Re-run with --yes to actually drop."
  exit 0
fi

# Triggers and the index go with the table in SQLite's own DROP TABLE, but they are named here
# explicitly so this is readable as the exact inverse of what initDatabase() creates, and so it
# still cleans up if a partial earlier run left one behind.
sqlite3 "$DB" <<'SQL'
BEGIN;
DROP TRIGGER IF EXISTS trg_kanban_relations_created_at_epoch_insert;
DROP TRIGGER IF EXISTS trg_kanban_relations_created_at_epoch_update;
DROP INDEX   IF EXISTS idx_kanban_relations_to;
DROP TABLE   IF EXISTS kanban_relations;
COMMIT;
SQL
status=$?
[ "$status" -eq 0 ] || { echo "DROP FAILED (sqlite3 exit $status)" >&2; exit 3; }

left=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('kanban_relations','idx_kanban_relations_to','trg_kanban_relations_created_at_epoch_insert','trg_kanban_relations_created_at_epoch_update')")
[ "$left" = "0" ] || { echo "INCOMPLETE: $left object(s) still present" >&2; exit 3; }
echo "dropped. Restart the service (or call initDatabase) to re-create it empty."
