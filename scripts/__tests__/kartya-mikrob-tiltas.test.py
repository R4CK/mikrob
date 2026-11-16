#!/usr/bin/env python3
"""Card 30aa8b29 R3: scripts/kartya-es-ertesites.py writes INSERT/UPDATE kanban_cards.assignee
directly, bypassing src/web/kanban-assignee-guard.ts's structural refusal of assignee="mikrob"
(Peti 10943). This pins that the script's OWN check (_tiltott_felelos, mirroring
isForbiddenAssignee) now closes that gap on both write paths (create, comment-mode move) --
without breaking this tool's unrelated, legitimate COORDINATOR='marveen' convention (see
kartya-fleet-koordinator.test.py, which this suite does not touch).

Run: python3 scripts/__tests__/kartya-mikrob-tiltas.test.py
Exit 0 = all pass; non-zero = a failure (also printed).
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-mikrob-sandbox-')
DB_PATH = None
FAILS = []
N = 0


def check(name, cond, detail=''):
    global N
    N += 1
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def fresh_db(path):
    db = sqlite3.connect(path)
    db.executescript('''
      CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'planned', assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal',
        project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
        parent_id TEXT, dispatched_at INTEGER);
      CREATE TABLE kanban_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE kanban_card_events (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
        from_status TEXT, to_status TEXT NOT NULL, actor TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE kanban_card_field_events (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
        field TEXT NOT NULL, old_value TEXT, new_value TEXT, actor TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER);
    ''')
    now = int(time.time())
    db.execute("INSERT INTO kanban_cards (id,title,assignee,status,priority,created_at,updated_at)"
               " VALUES ('EXIST01','meglevo','backend2','planned','normal',?,?)", (now, now))
    db.commit(); db.close()


def env():
    e = dict(os.environ)
    e['KARTYA_DB'] = DB_PATH; e['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    return e


def card_row(cid):
    db = sqlite3.connect(DB_PATH)
    row = db.execute('SELECT assignee FROM kanban_cards WHERE id=?', (cid,)).fetchone()
    db.close()
    return row[0] if row else None


def letrehoz(card_id, assignee):
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--assignee', assignee,
         '--title', f'{card_id} teszt kartya', '--author', 'Geri', '--no-msg'],
        capture_output=True, text=True, env=env(), timeout=30)


def mozgat(card_id, assignee):
    d = tempfile.mkdtemp(prefix='kartya-mikrob-c-')
    cf = os.path.join(d, 'k.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write('Próba-komment, ékezetes szöveggel, elég hosszan.')
    # --assignee-uj bypasses the UNRELATED "unknown name" typo-gate (not in ISMERT_FELELOSOK and
    # no other card carries it), which would otherwise also say MEGTAGADVA for "mikrob" and mask
    # whether THIS fix's own check fired.
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--assignee', assignee, '--assignee-uj',
         '--comment-file', cf, '--author', 'Geri'],
        capture_output=True, text=True, env=env(), timeout=30)


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-mikrob-'); os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH)

    # 1. Create path: plain and disguised forms of "mikrob" are all refused.
    for label, val in (
        ('plain', 'mikrob'), ('case', 'MikroB'), ('spaced', '  mikrob  '),
        ('at-prefixed', '@mikrob'), ('zwsp', 'mi​krob'), ('cyrillic-a', 'mиkrob'),
        ('hun-accent-sub', 'mikrób'),
    ):
        p = letrehoz(f'NEW_{label.upper()}', val)
        out = p.stdout + p.stderr
        check(f'1 create refuses assignee "{val}" ({label})',
              p.returncode != 0 and 'MEGTAGADVA' in out, out)
        check(f'1 and no card was created ({label})', card_row(f'NEW_{label.upper()}') is None)

    # 2. Comment-mode move path: same refusal, existing assignee unchanged.
    p = mozgat('EXIST01', 'mikrob')
    out = p.stdout + p.stderr
    check('2 comment-mode move to assignee=mikrob is refused',
          p.returncode != 0 and 'MEGTAGADVA' in out, out)
    check('2 and the existing assignee is unchanged', card_row('EXIST01') == 'backend2',
          f'assignee={card_row("EXIST01")}')

    # 3. Negative control: a real role agent still works normally (no regression).
    p = letrehoz('NEW_OK', 'backend3')
    out = p.stdout + p.stderr
    check('3 control: a real role agent is still accepted',
          p.returncode == 0 and card_row('NEW_OK') == 'backend3', out)

    # 4. Negative control: this tool's OWN, unrelated COORDINATOR='marveen' convention is
    # untouched by this fix (see kartya-fleet-koordinator.test.py for the full behaviour).
    p = letrehoz('NEW_MARVEEN', 'marveen')
    out = p.stdout + p.stderr
    check('4 control: assignee="marveen" (this tool\'s own coordinator) still works',
          p.returncode == 0 and card_row('NEW_MARVEEN') == 'marveen', out)

    print('')
    print(f'kartya-mikrob-tiltas: {N - len(FAILS)}/{N} allitas zold')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
