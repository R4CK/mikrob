#!/usr/bin/env bash
# Periodic markdown export of the kanban board's essentials.
#
# WHY (2026-09-08 incident, Peti's request): kanban_cards/kanban_comments went
# from populated to 0 rows overnight, and the only asset that survived intact
# was DECISIONS.md -- because it is a plain file on disk, not a SQLite row.
# This script deliberately produces the same kind of asset for the kanban
# board: a human-readable, git-trackable KANBAN-SNAPSHOT.md that lets a human
# or agent reconstruct the board's essentials (title, status, assignee,
# priority, project, hierarchy, description, recent comments) even if the
# database itself is empty. It is a lossy summary, not a backup -- see
# db-backup.sh for the full, restorable SQLite backup.
#
# Uses the dashboard API (not the sqlite3 CLI) so this stays consistent with
# every other kanban-facing script in this repo (see the kanban-audit
# heartbeat's documented buktato: sqlite3/jq are not guaranteed installed on
# every fleet host).
set -euo pipefail
# Both outputs below are private (card 90e4cbdf, Cybersec sibling-check under e804262d). Same shape
# as db-backup.sh: umask FIRST, so anything created here starts at 600, whatever the caller's umask.
#
# WHY IT LOOKED FINE AND WAS NOT: a `>` redirect keeps the mode of an ALREADY EXISTING file, so both
# files read 600 today purely because they were first created by a hand-run with umask 077. Delete
# either one and let the 15-minute OS cron recreate it -- cron runs with umask 022 and the new file
# is silently 644. Latent, not exploited, and invisible to any check that only looks at what is
# currently on disk.
umask 077

STORE=/home/neon/marveen/store
INSTALL_DIR="$(cd "$STORE/.." && pwd)"
PORT="$(sed -n 's/^WEB_PORT=//p' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | tr -d '"')"
PORT="${PORT:-3420}"
TOKEN="$(cat "$STORE/.dashboard-token")"
OUT="$INSTALL_DIR/KANBAN-SNAPSHOT.md"

printf 'Authorization: Bearer %s\n' "$TOKEN" \
  | curl -H @- -s "http://localhost:$PORT/api/kanban" \
  > "$STORE/.kanban-snapshot-cards.json.tmp"
# Belt and suspenders, the same argument db-backup.sh makes: umask governs CREATION only, so a
# future caller that writes this path differently (or a pre-existing file with a looser mode) would
# slip past it. This is the FULL /api/kanban dump -- every card title, description and comment.
chmod 600 "$STORE/.kanban-snapshot-cards.json.tmp"

python3 - "$STORE/.kanban-snapshot-cards.json.tmp" "$OUT" "$STORE/.dashboard-token" "$PORT" <<'PYEOF'
import json, sys, time, urllib.request

cards_path, out_path, token_path, port = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

with open(cards_path) as f:
    cards = json.load(f)
with open(token_path) as f:
    token = f.read().strip()

def fetch_comments(card_id):
    req = urllib.request.Request(
        f"http://localhost:{port}/api/kanban/{card_id}/comments",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.load(resp)
    except Exception:
        return []

def fmt_ts(ts):
    if not ts:
        return "-"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
    except Exception:
        return str(ts)

active = [c for c in cards if not c.get("archived_at")]
archived = [c for c in cards if c.get("archived_at")]

by_project = {}
for c in active:
    by_project.setdefault(c.get("project") or "(nincs projekt)", []).append(c)

lines = []
lines.append("# Kanban snapshot")
lines.append("")
lines.append(f"Generalva: {fmt_ts(time.time())} -- automatikus, periodikus export a `kanban-snapshot.sh`-bol.")
lines.append("")
lines.append("Ez EGY LOSSY, ember-olvashato kivonat a tabla legfontosabb mezoirol, nem")
lines.append("teljes backup (ahhoz lasd `store/backups/*.db.gz`, `db-backup.sh`). A celja: ha")
lines.append("a SQLite adatbazis kiurulne, ebbol a fajlbol kezzel vagy szkripttel")
lines.append("visszaepithetok a kartyak lenyegi adatai (cim, statusz, felelos, prioritas,")
lines.append("hierarchia, leiras, legutobbi kommentek).")
lines.append("")
lines.append(f"Aktiv (nem archivalt) kartyak: {len(active)}. Archivalt: {len(archived)}.")
lines.append("")

STATUS_ORDER = ["in_progress", "waiting", "planned", "testing", "done"]

for project in sorted(by_project.keys()):
    project_cards = by_project[project]
    lines.append(f"## {project}")
    lines.append("")
    project_cards.sort(key=lambda c: (
        STATUS_ORDER.index(c.get("status")) if c.get("status") in STATUS_ORDER else len(STATUS_ORDER),
        -(c.get("updated_at") or 0),
    ))
    for c in project_cards:
        cid = c.get("id")
        title = c.get("title") or "(nincs cim)"
        status = c.get("status") or "-"
        priority = c.get("priority") or "-"
        assignee = c.get("assignee") or "(nincs felelos)"
        parent = c.get("parent_id") or "-"
        created = fmt_ts(c.get("created_at"))
        updated = fmt_ts(c.get("updated_at"))
        desc = (c.get("description") or "").strip()
        if len(desc) > 600:
            desc = desc[:600] + f"...(+{len(desc)-600} karakter)"

        lines.append(f"### {cid} [{status}] ({priority}) -- {title}")
        lines.append(f"Felelos: {assignee} | Szulo: {parent} | Letrehozva: {created} | Frissitve: {updated}")
        if desc:
            lines.append("")
            lines.append(desc)

        all_comments = fetch_comments(cid)
        if all_comments:
            total = len(all_comments)
            recent = sorted(all_comments, key=lambda x: x.get("created_at") or 0)[-5:]
            lines.append("")
            lines.append(f"Legutobbi kommentek ({len(recent)}/{total}):")
            for cm in recent:
                body = (cm.get("content") or cm.get("text") or "").strip().replace("\n", " ")
                if len(body) > 200:
                    body = body[:200] + "..."
                who = cm.get("author") or cm.get("agent_id") or "?"
                lines.append(f"- [{fmt_ts(cm.get('created_at'))}] {who}: {body}")
        lines.append("")
    lines.append("")

with open(out_path, "w") as f:
    f.write("\n".join(lines))

print(f"wrote {out_path} ({len(active)} active, {len(archived)} archived cards)")
PYEOF

# The python above opens $OUT with a plain open(..., "w"), which preserves an existing file's mode --
# so this is not redundant with the umask either. It carries the board's contents and fresh comments.
chmod 600 "$OUT"

rm -f "$STORE/.kanban-snapshot-cards.json.tmp"
