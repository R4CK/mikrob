#!/usr/bin/env python3
"""One-off backfill cleanup for the token_usage cross-agent duplication (card a9e07e5c).

The unique index on token_usage is (agent, session_id, timestamp, input_tokens,
output_tokens).  Because `agent` is the first field, the SAME loader event recorded under
N different agent names produces N rows that the index happily accepts.  The content key
below drops `agent` and is what a real event is identified by:

    (session_id, timestamp, input_tokens, output_tokens)

Three survivor rules are implemented so they can be COMPARED on the live data before
anything is deleted:

  minid            keep MIN(id) of the group.  The obvious rule; measurably drops filled
                   project/task_title/model values that only a later row carries.

  completeness     the rule the card asks for: rank by filled(model), filled(project),
                   filled(task_title), then id.  Keeps the most field values -- but see
                   the FABRICATION block of the report: in a cross-agent group every agent
                   stamped its OWN card title onto the same event, so "most filled" can
                   mean "most invented".

  attribution-safe the rule this script proposes:
                     - group contains a `mikrob` row  -> keep that row verbatim.  mikrob is
                       the only non-isolated agent, so its row is the clean baseline.
                     - otherwise, cross-agent group   -> keep MIN(id) but relabel
                       agent='unattributed', and keep model/project/task_title ONLY where
                       every non-empty value in the group agrees.  A disagreeing field is
                       nulled rather than picked, because picking is fabrication.
                     - single-agent group             -> keep MIN(id), fields merged by the
                       same unanimity rule.

Default mode is --dry-run and opens the database read-only.  --apply mutates and REQUIRES
an explicit rule plus --yes; it always writes a gzipped JSONL rollback file BEFORE the
first delete, and --rollback <file> puts the rows back.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sqlite3
import sys
import tempfile
import time
from itertools import groupby

DEFAULT_DB = "/home/neon/marveen/store/claudeclaw.db"
COLUMNS = [
    "id",
    "agent",
    "session_id",
    "timestamp",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "content_preview",
    "tool_name",
    "task_title",
    "project",
    "thinking_tokens",
    "model",
]
KEY_COLUMNS = ("session_id", "timestamp", "input_tokens", "output_tokens")
MERGED_FIELDS = ("model", "project", "task_title")
UNATTRIBUTED = "unattributed"
BASELINE_AGENT = "mikrob"
RULES = ("minid", "completeness", "attribution-safe")


def filled(value) -> bool:
    return value is not None and str(value) != ""


def norm(value):
    """Empty string and NULL mean the same thing here; collapse them so a no-op override
    (rewriting '' to NULL) is never emitted."""
    return value if filled(value) else None


def open_ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def stream_groups(conn: sqlite3.Connection):
    """Yield (key, [row, ...]) for every content key, rows ordered by id.

    Streams in key order so memory stays proportional to the largest group, not to the
    table.  The table has ~4M rows; loading it whole is not an option.
    """
    sql = "SELECT %s FROM token_usage ORDER BY %s, id" % (
        ", ".join(COLUMNS),
        ", ".join(KEY_COLUMNS),
    )
    cur = conn.execute(sql)
    keyfunc = lambda r: tuple(r[c] for c in KEY_COLUMNS)  # noqa: E731
    for key, rows in groupby(cur, key=keyfunc):
        yield key, list(rows)


def completeness_key(row):
    # Higher is better, so negate; id ascending breaks ties.
    return (
        -int(filled(row["model"])),
        -int(filled(row["project"])),
        -int(filled(row["task_title"])),
        row["id"],
    )


def unanimous(rows, field):
    """The single non-empty value of `field` across rows, or None if they disagree."""
    values = {r[field] for r in rows if filled(r[field])}
    if len(values) == 1:
        return next(iter(values))
    return None


def pick_survivor(rows, rule):
    """Return (survivor_row, overrides) for one group under `rule`.

    `overrides` is a dict of column -> new value that must be written onto the survivor.
    """
    if rule == "minid":
        return min(rows, key=lambda r: r["id"]), {}

    if rule == "completeness":
        return min(rows, key=completeness_key), {}

    if rule == "attribution-safe":
        mikrob_rows = [r for r in rows if r["agent"] == BASELINE_AGENT]
        if mikrob_rows:
            return min(mikrob_rows, key=lambda r: r["id"]), {}
        survivor = min(rows, key=lambda r: r["id"])
        overrides = {}
        if len({r["agent"] for r in rows}) > 1:
            overrides["agent"] = UNATTRIBUTED
        for field in MERGED_FIELDS:
            value = unanimous(rows, field)
            if value != norm(survivor[field]):
                overrides[field] = value
        return survivor, overrides

    raise ValueError("unknown rule: %s" % rule)


class Report:
    def __init__(self):
        self.rows = 0
        self.keys = 0
        self.singleton_keys = 0
        self.dup_keys = 0
        self.dup_rows = 0
        self.cross_agent_keys = 0
        self.same_agent_dup_keys = 0
        self.keys_with_mikrob = 0
        self.kept = {r: 0 for r in RULES}
        self.field_kept = {r: {f: 0 for f in MERGED_FIELDS} for r in RULES}
        self.relabelled = 0
        self.kept_as_mikrob = 0
        # Fabrication evidence, all about the card's own rule.
        self.mikrob_group_lost_to_other = 0
        self.disagreeing = {f: 0 for f in MERGED_FIELDS}

    def observe(self, rows):
        self.rows += len(rows)
        self.keys += 1
        agents = {r["agent"] for r in rows}
        if len(rows) == 1:
            self.singleton_keys += 1
        else:
            self.dup_keys += 1
            self.dup_rows += len(rows)
            if len(agents) > 1:
                self.cross_agent_keys += 1
            else:
                self.same_agent_dup_keys += 1
        has_mikrob = BASELINE_AGENT in agents
        if has_mikrob:
            self.keys_with_mikrob += 1

        for field in MERGED_FIELDS:
            if len({r[field] for r in rows if filled(r[field])}) > 1:
                self.disagreeing[field] += 1

        for rule in RULES:
            survivor, overrides = pick_survivor(rows, rule)
            self.kept[rule] += 1
            for field in MERGED_FIELDS:
                value = overrides[field] if field in overrides else survivor[field]
                if filled(value):
                    self.field_kept[rule][field] += 1
            if rule == "attribution-safe":
                if overrides.get("agent") == UNATTRIBUTED:
                    self.relabelled += 1
                elif has_mikrob:
                    self.kept_as_mikrob += 1
            if rule == "completeness" and has_mikrob and len(rows) > 1:
                if survivor["agent"] != BASELINE_AGENT:
                    self.mikrob_group_lost_to_other += 1

    def render(self, db_path, elapsed):
        out = []
        add = out.append
        add("token-usage-dedup-backfill: DRY-RUN (read-only, nothing was written)")
        add("db: %s" % db_path)
        add("scanned in %.1fs" % elapsed)
        add("")
        add("rows                          %d" % self.rows)
        add("content keys                  %d" % self.keys)
        add("  singleton keys              %d" % self.singleton_keys)
        add("  duplicated keys             %d  (rows in them: %d)" % (self.dup_keys, self.dup_rows))
        add("    cross-agent               %d" % self.cross_agent_keys)
        add("    same-agent only           %d" % self.same_agent_dup_keys)
        add("keys holding a %-14s %d" % (BASELINE_AGENT + " row", self.keys_with_mikrob))
        add("")
        add("SURVIVORS AND DELETIONS (identical row counts, the rules differ in WHICH row)")
        for rule in RULES:
            add("  %-16s keep %8d   delete %8d" % (rule, self.kept[rule], self.rows - self.kept[rule]))
        if self.relabelled or self.kept_as_mikrob:
            add(
                "  attribution-safe writes agent='%s' on %d survivors, keeps '%s' on %d"
                % (UNATTRIBUTED, self.relabelled, BASELINE_AGENT, self.kept_as_mikrob)
            )
        add("")
        add("FIELD VALUES SURVIVING (non-empty, one per key)")
        add("  %-16s %10s %10s %10s" % ("rule", "model", "project", "task_title"))
        for rule in RULES:
            add(
                "  %-16s %10d %10d %10d"
                % (
                    rule,
                    self.field_kept[rule]["model"],
                    self.field_kept[rule]["project"],
                    self.field_kept[rule]["task_title"],
                )
            )
        add("")
        add("FABRICATION CHECK (why 'more filled' is not 'more correct')")
        add(
            "  duplicated keys where the %s rows disagree on project:    %d"
            % ("group's", self.disagreeing["project"])
        )
        add("  ... on task_title:                                          %d" % self.disagreeing["task_title"])
        add("  ... on model:                                               %d" % self.disagreeing["model"])
        add(
            "  keys WITH a %s row where 'completeness' picks another agent: %d"
            % (BASELINE_AGENT, self.mikrob_group_lost_to_other)
        )
        add("      ^ on those keys the card's rule prefers a stamped-on attribution")
        add("        over the row the fixed loader would actually produce.")
        return "\n".join(out)


def do_dry_run(db_path):
    started = time.time()
    conn = open_ro(db_path)
    report = Report()
    try:
        for _key, rows in stream_groups(conn):
            report.observe(rows)
    finally:
        conn.close()
    print(report.render(db_path, time.time() - started))
    return 0


def build_plan(db_path, rule, plan_path):
    """Write the delete/update plan to a scratch sqlite file, reading the live DB read-only."""
    src = open_ro(db_path)
    plan = sqlite3.connect(plan_path)
    plan.execute("CREATE TABLE deletes (id INTEGER PRIMARY KEY)")
    plan.execute(
        "CREATE TABLE updates (id INTEGER PRIMARY KEY, agent TEXT, model TEXT, project TEXT, task_title TEXT)"
    )
    deletes = 0
    updates = 0
    try:
        for _key, rows in stream_groups(src):
            if len(rows) == 1:
                survivor, overrides = pick_survivor(rows, rule)
                if not overrides:
                    continue
            else:
                survivor, overrides = pick_survivor(rows, rule)
                doomed = [(r["id"],) for r in rows if r["id"] != survivor["id"]]
                plan.executemany("INSERT INTO deletes (id) VALUES (?)", doomed)
                deletes += len(doomed)
            if overrides:
                plan.execute(
                    "INSERT INTO updates (id, agent, model, project, task_title) VALUES (?,?,?,?,?)",
                    (
                        survivor["id"],
                        overrides.get("agent", survivor["agent"]),
                        overrides.get("model", survivor["model"]),
                        overrides.get("project", survivor["project"]),
                        overrides.get("task_title", survivor["task_title"]),
                    ),
                )
                updates += 1
        plan.commit()
    finally:
        src.close()
        plan.close()
    return deletes, updates


def write_rollback(db_path, plan_path, rollback_path):
    """Dump every row the plan touches, BEFORE anything is mutated."""
    src = open_ro(db_path)
    plan = sqlite3.connect(plan_path)
    written = 0
    try:
        ids = [r[0] for r in plan.execute("SELECT id FROM deletes")]
        ids += [r[0] for r in plan.execute("SELECT id FROM updates")]
        with gzip.open(rollback_path, "wt", encoding="utf-8") as fh:
            for start in range(0, len(ids), 5000):
                chunk = ids[start : start + 5000]
                placeholders = ",".join("?" * len(chunk))
                sql = "SELECT %s FROM token_usage WHERE id IN (%s)" % (", ".join(COLUMNS), placeholders)
                for row in src.execute(sql, chunk):
                    fh.write(json.dumps({c: row[c] for c in COLUMNS}, ensure_ascii=False) + "\n")
                    written += 1
    finally:
        src.close()
        plan.close()
    return written


def apply_plan(db_path, plan_path):
    plan = sqlite3.connect(plan_path)
    conn = sqlite3.connect(db_path)
    deleted = 0
    updated = 0
    try:
        conn.execute("BEGIN IMMEDIATE")
        for row in plan.execute("SELECT id, agent, model, project, task_title FROM updates"):
            conn.execute(
                "UPDATE token_usage SET agent=?, model=?, project=?, task_title=? WHERE id=?",
                (row[1], row[2], row[3], row[4], row[0]),
            )
            updated += 1
        ids = [r[0] for r in plan.execute("SELECT id FROM deletes")]
        for start in range(0, len(ids), 5000):
            chunk = ids[start : start + 5000]
            placeholders = ",".join("?" * len(chunk))
            cur = conn.execute("DELETE FROM token_usage WHERE id IN (%s)" % placeholders, chunk)
            deleted += cur.rowcount
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        plan.close()
        conn.close()
    return deleted, updated


def do_apply(db_path, rule, rollback_path):
    started = time.time()
    scratch = tempfile.mkdtemp(prefix="token-usage-backfill-")
    plan_path = os.path.join(scratch, "plan.db")
    deletes, updates = build_plan(db_path, rule, plan_path)
    print("plan: %d rows to delete, %d survivors to rewrite" % (deletes, updates))
    saved = write_rollback(db_path, plan_path, rollback_path)
    print("rollback: %d rows saved to %s" % (saved, rollback_path))
    if saved != deletes + updates:
        print("ABORT: rollback file holds %d rows but the plan touches %d" % (saved, deletes + updates))
        return 1
    deleted, updated = apply_plan(db_path, plan_path)
    print("applied: %d deleted, %d rewritten in %.1fs" % (deleted, updated, time.time() - started))
    print("rollback with: %s --db %s --rollback %s" % (sys.argv[0], db_path, rollback_path))
    return 0


def do_rollback(db_path, rollback_path):
    conn = sqlite3.connect(db_path)
    restored = 0
    try:
        conn.execute("BEGIN IMMEDIATE")
        with gzip.open(rollback_path, "rt", encoding="utf-8") as fh:
            for line in fh:
                row = json.loads(line)
                conn.execute(
                    "INSERT OR REPLACE INTO token_usage (%s) VALUES (%s)"
                    % (", ".join(COLUMNS), ",".join("?" * len(COLUMNS))),
                    [row[c] for c in COLUMNS],
                )
                restored += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print("rollback: %d rows restored from %s" % (restored, rollback_path))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=os.environ.get("TOKEN_USAGE_DB", DEFAULT_DB))
    parser.add_argument("--dry-run", action="store_true", help="default; read-only report")
    parser.add_argument("--apply", action="store_true", help="mutate the table (needs --rule and --yes)")
    parser.add_argument("--rule", choices=RULES, help="survivor rule for --apply")
    parser.add_argument("--rollback", metavar="FILE", help="restore rows from a rollback file")
    parser.add_argument("--rollback-file", metavar="FILE", help="where --apply writes its rollback dump")
    parser.add_argument("--yes", action="store_true", help="required confirmation for --apply")
    args = parser.parse_args(argv)

    if args.rollback:
        return do_rollback(args.db, args.rollback)

    if not args.apply:
        return do_dry_run(args.db)

    if not args.rule:
        print("--apply needs --rule (%s)" % "|".join(RULES), file=sys.stderr)
        return 2
    if not args.yes:
        print("--apply is destructive and needs --yes; run without --apply for the dry-run", file=sys.stderr)
        return 2
    rollback_path = args.rollback_file or os.path.join(
        os.path.dirname(os.path.abspath(args.db)),
        "token-usage-backfill-%s.rollback.jsonl.gz" % time.strftime("%Y%m%d-%H%M%S"),
    )
    if os.path.exists(rollback_path):
        print("refusing to overwrite an existing rollback file: %s" % rollback_path, file=sys.stderr)
        return 2
    return do_apply(args.db, args.rule, rollback_path)


if __name__ == "__main__":
    sys.exit(main())
