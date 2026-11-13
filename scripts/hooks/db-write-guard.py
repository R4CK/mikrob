#!/usr/bin/env python3
r"""PreToolUse hook: block a direct sqlite write to the dashboard's auth/approval tables.

Card c1766c6c (7391f09a follow-up): upstream's `db-write-gate.mjs` denies a direct sqlite write to
these tables, but this fork rejected adopting it wholesale (DECISIONS.md, 7391f09a) because it
imports a generalized multi-surface-deny engine (`scheduleSurfaceDeny`/`scheduleSurfaceVariants`)
that this fork's `scripts/self-pace-gate.mjs` has no equivalent of -- porting that engine is its own
refactor, not a drive-by adoption, and that reject reason still stands. This is instead a narrow,
fork-shaped guard, same shape as `git-protect-guard.py` / `npm-protect-guard.py`: it does not try to
cover every table or every write path, only the three security-sensitive ones named by this card.

WHY THESE THREE TABLES: `dashboard_users` (login credentials/password hashes), `auth_sessions`
(live session tokens), `approvals` (the level-2 autonomy approval records) are the dashboard's own
auth/authorization state. The dashboard API already enforces validation, hashing and audit logging
on writes to them; a raw `sqlite3`/`python3 sqlite3` write bypasses all of that -- it can plant a
user, forge a session, or silently approve/deny a pending request with no audit trail. Every other
table in `store/claudeclaw.db` (kanban cards, memories, messages, ...) is explicitly OUT of scope:
widening this guard to the whole database would just be `db-write-gate.mjs`'s rejected engine again,
one table at a time.

RE-GATE ROUND 2 (CYBERSEC NO-GO 28672 + QA FAIL 28673, MikroB dispatch msg_id:16779/16780):
  - M1a: table-name matching is now case-insensitive (SQL identifiers are case-insensitive).
  - M1b: sqlite3/python/node/perl invocation detection no longer anchors on command position --
    it is detected anywhere a top-level statement's text names the interpreter, so
    `/usr/bin/sqlite3`, `env sqlite3`, `timeout 5 sqlite3`, `\sqlite3`, `bash -c '...'`/
    `sh -c "..."` wrapping, and a `python3 - <<'PY'` heredoc all reach the same check as a bare
    `sqlite3` call. Statements are split on `;`/`&&`/`||`/newline WITHOUT splitting inside a
    quoted span or a heredoc body, so a heredoc's SQL stays attached to its invocation line.
  - M1c: `sqlite3 db < file`, `.read file` and `.import file table` feed SQL this guard cannot see
    at all -- those are blocked outright against the protected db (fail-closed on the unverifiable
    case), not evaluated against the usual table+verb rule.
  - M2: the escape hatch now has to be a literal `VAR=1` assignment at the START of the exact
    statement doing the write (real env-assignment command-position syntax), not a substring
    found anywhere in the payload -- a trailing shell comment, a preceding unrelated `echo`, or the
    token sitting inside a quoted SQL string no longer disarms the guard.
  - M3: the write-verb search runs against a copy of the statement with shell comments
    (unquoted `#`-to-EOL) and SQL string literals following an operator (`LIKE`/`=`/`<>`/`!=`/
    `<=`/`>=`/`<`/`>`/`IN`) blanked out first, and `REPLACE` is only a write when NOT immediately
    followed by `(` (the SQL function, not the statement). This stops `LIKE '%delete%'`,
    `category='insert'`, `SELECT replace(...)`, a `# replace later` trailing comment, and an
    unrelated verb word in a later `;`-separated command (e.g. `; curl -X DELETE ...`) from
    false-blocking a read-only statement.
  - L1 (MikroB decision): an internal error while scanning a *well-formed* command string fails
    CLOSED (blocks) if that command names a protected table or the protected db by its literal
    name; otherwise it fails open, same as before. A malformed PreToolUse payload itself (no
    command text to check at all) still fails open, unchanged.
  - Addendum (QA FAIL 28673): a db-path argument that is a filesystem symlink to the protected db
    now resolves via `os.path.realpath` and counts as the protected db; a db-path argument that is
    an unresolvable shell variable (`sqlite3 "$DB_PATH" ...`) is treated as BLOCK, not ALLOW, when
    the rest of the statement already names a protected table and a write verb -- we cannot prove
    it is a different database, so the ambiguous case fails closed.
  - Addendum (QA FAIL 28673): a `Write`/`Edit`/`MultiEdit` tool call whose `file_path` resolves to
    the protected db file is blocked unconditionally (no SQL text to inspect there at all, so no
    escape hatch either -- nobody has a legitimate reason to hand-edit the raw db bytes).

RE-GATE ROUND 3 (QA FAIL 28716 on dd074f2c9, MikroB dispatch msg_id:16807): all round-1 bypasses
confirmed closed; two narrower gaps reopened, same classes as round 2's addenda but generalized:
  - The round-2 "unresolvable db-path variable fails closed" posture only covered the shell-level
    `sqlite3 "$VAR" ...` shape. It did not cover the python/node/perl runtimes' OWN env-var
    accessors (`os.environ[...]`/`os.getenv(...)`/`$ENV{...}`/`process.env...`) even though this
    same round-2 added write-detection signatures for exactly those three runtimes. Now treated
    the same way: a protected table + write verb visible in the command text, with the db target
    resolved only through one of these accessors, fails closed (BLOCK), not allowed through.
  - A plain pipe feeding stdin into a detected `sqlite3` call (`cat file | sqlite3 db`) is the same
    unreadable-SQL-source class M1c already closed for `<`/`.read`/`.import` -- added to the same
    side-channel check, blocked outright against the protected db regardless of whether a
    table/verb is visible (it usually won't be, since the SQL lives in the piped file, not the
    command text).

RE-GATE ROUND 4 (CYBERSEC NO-GO 28718 + 28723 on dd074f2c9/346861211, MikroB dispatch
msg_id:16815, scope fixed to N1/N2/P1/P4 by MikroB's own decision comment -- further shapes go
to card 85a668aa as residuals, not a 5th round here):
  - N1 (regression vs round 1): M3's literal-blanking (round 2) hid a write STORED inside a
    literal rather than compared against one -- `q='DELETE FROM approvals'` (python), a shell
    variable (`Q='DELETE FROM approvals'; sqlite3 db "$Q"`), and a backslash-quote inside a SQL
    string (SQLite has no backslash escape; the old regex's `[^'\\]|\\.` treated it as one, so
    text after the fake-escaped quote was invisible to the scan). Fixed by (a) correcting the
    literal regex to SQLite's actual escaping rule (a doubled quote, never backslash), and (b) a
    new, separate check: any single-quoted literal ANYWHERE in the command whose own content
    names a protected table AND a write verb together is an embedded write statement and blocks,
    regardless of whether it sits after a comparison operator -- a genuine comparison value
    (`category='insert'`, `LIKE '%delete%'`) never has the table name inside that SAME literal,
    so this does not reopen M3's false blocks.
  - N2: the Write/Edit/MultiEdit protection (QA FAIL 28673 addendum 2) was dead code in the
    running fleet -- the hook was registered with matcher `"Bash"` only, so the harness never
    called it for those tools. Fixed at the registration sites (`.claude/settings.json`,
    `injectDbWriteGuard` in `src/web/agent-scaffold.ts`), matcher now `Bash|Write|Edit|MultiEdit`.
  - P1: the round-3 pipe rule matched "sqlite3" ANYWHERE after a pipe, not just as the piped-to
    command -- `lsof claudeclaw.db | grep sqlite3` and `sqlite3 claudeclaw.db "SELECT ..." |
    grep -c sqlite3` false-blocked because the WORD "sqlite3" appeared as grep's search pattern.
    Fixed: "sqlite3" must now be the first command after the pipe (optionally behind a known
    wrapper). Separately, a pipe whose SOURCE is a readable echo/printf literal (`echo '.tables'
    | sqlite3 db`, `printf 'SELECT ...' | sqlite3 db`) no longer forces a block outright -- it
    falls through to the ordinary table+verb scan, same as any other visible argument. A live
    datapoint from the same round (a heredoc that only WROTE a message file whose text quoted an
    example DELETE statement, in the same top-level command as an unrelated real SELECT) is also
    fixed here: a heredoc body is now only kept visible to the scanner when its OPENING command
    is itself a bare sqlite3/python/node/perl invocation (the existing M1b cases); any other
    opener (`cat >file <<'MARKER'`) gets its heredoc body blanked, same shape, no content.
  - P4: the module docstring is now a raw string (prefixed with r) -- it contains `\sqlite3`,
    which under Python 3.14 raised `SyntaxWarning: invalid escape sequence` on every invocation.

RE-GATE ROUND 5 (CYBERSEC NO-GO 28743 on 828428142, MikroB dispatch msg_id:16862, scope R1+R2):
  - R1 (MEDIUM-HIGH, regression vs round 4's own P1 heredoc fix): the heredoc body-consuming
    branch started at the FIRST newline reached after `<<MARK`, which also swallowed the REST OF
    THE OPENER'S OWN LINE as if it were body text -- `cat <<'EOF' | sqlite3 store/claudeclaw.db`
    had `| sqlite3 store/claudeclaw.db` blanked away entirely (heredoc_keep is False for a bare
    `cat` opener), and `cat <<'EOF'; sqlite3 db "DELETE ..."` never reached `_split_top_level`'s
    own `;` handling at all, because that branch was shadowed by the heredoc-body branch at the
    top of the loop. Fixed: text between the `<<MARK` token and the NEXT real newline is now
    processed by the ordinary character loop (quotes/`;`/`&&`/`||` all still apply there) -- only
    the newline ending the opener's own physical line hands off into body-consuming mode. Also
    widened the heredoc-keep interpreter list (bash/sh/zsh/dash/eval/source/ssh, alongside the
    existing sqlite3/python/node/perl), since a shell-wrapper opener can run a real sqlite3 write
    from its body text just as easily as a language runtime can; "cat" and other non-executing
    openers are still excluded, preserving round 4's own false-block fix.
  - R2 (MEDIUM): the "readable echo/printf pipe source" check only verified that echo/printf
    STARTED the source, never what came between the command name and the pipe -- `echo "$Q" |
    sqlite3 db`, `echo "$(cat f)" | sqlite3 db`, `printf '%b' '\x44ELETE...' | sqlite3 db` and
    `echo -e '\x44ELETE...' | sqlite3 db` all matched and were treated as readable even though a
    shell variable, a command substitution, or an escape-interpreting flag/format (`-e`, `%b`,
    `\xHH`) hides or transforms the real bytes. Fixed: "readable" now requires the ENTIRE span
    between the command name and the pipe to be a plain literal -- no `$`, backtick, backslash,
    or `%b` -- anything else falls through to the unreadable-pipe side-channel check instead.
  - R3/R4 (pipe-wrapper closed-form list, N1b false blocks on an unrelated SELECT sharing a
    command with a write-verb-shaped string elsewhere) are OUT of scope this round per MikroB's
    dispatch (msg_id:16862: "fix WhiteHat NO-GO 28743 R1+R2 regressions") -- logged as residuals
    for card 85a668aa, not a 6th round here, same posture as round 4's own P2/P3/P5 residuals.

SCOPE, still deliberately narrow (same philosophy as git-protect-guard.py's docstring):
  - A pure SELECT (no write verb present, outside any blanked literal/comment) is always allowed.
  - Any JSON-payload parse error, or a payload that is not a Bash/Write/Edit/MultiEdit call, still
    exits 0 (fail-open) -- this guard only ever narrows ALLOW into BLOCK for the three named
    tables, it does not become a general command-execution gate.

WHAT THIS STILL DOES NOT DO (stated, not a surprise -- a regex hook is a guardrail, not a full SQL
parser or shell interpreter): SQL arriving via a file this guard cannot read the content of (beyond
the `<`/`.read`/`.import` shapes above, e.g. a `.import`'d CSV whose own rows happen to contain SQL
is not re-parsed); a db-path variable set in an EARLIER, separate Bash tool call and referenced only
by name with no visible table/verb in THIS command; and non-SQLite runtimes this guard has no
signature for. The `<`/`.read`/`.import` and env-var checks intentionally fail closed exactly
because this guard cannot see through them, not because it parsed and understood the content.

Escape hatch: `DB_WRITE_GUARD_ALLOW=1` as the leading token of the exact statement doing the write,
for a reviewed, deliberate one-off (e.g. a MikroB-approved manual data fix) -- same `_ALLOW` pattern
as the other guards. Full disable: `DB_WRITE_GUARD=off` in the environment. Neither hatch applies to
a Write/Edit/MultiEdit call on the db file (see above).
"""
import json
import os
import re
import sys

PROTECTED_DB = "claudeclaw.db"
PROTECTED_TABLES = ("dashboard_users", "auth_sessions", "approvals")
WRITE_VERBS = ("INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE")

_TABLE_RX = re.compile(r"\b(?:" + "|".join(PROTECTED_TABLES) + r")\b", re.IGNORECASE)
# REPLACE is a write statement (REPLACE INTO ...) but also a common SQL function (replace(...));
# only the statement form counts -- the function call is never a write by itself.
_WRITE_VERB_RX = re.compile(
    r"\b(?:" + "|".join(WRITE_VERBS) + r")\b|\bREPLACE\b(?!\s*\()",
    re.IGNORECASE,
)

# Interpreter/CLI detection: word-boundary anywhere in a statement, not anchored to its start --
# catches /usr/bin/sqlite3, env sqlite3, timeout 5 sqlite3, \sqlite3, and text reached through a
# bash -c '...' / sh -c "..." wrapper, since the wrapped text is still part of this statement.
_SQLITE_CLI_RX = re.compile(r"\bsqlite3\b")
_PY_RX = re.compile(r"\bpython3?\b")
_PY_SQLITE_RX = re.compile(
    r"\bimport\s+sqlite3\b|\bfrom\s+sqlite3\s+import\b|\bsqlite3\.connect\s*\("
    r"|__import__\(\s*['\"]sqlite3['\"]\s*\)"
)
_NODE_RX = re.compile(r"\bnode\b")
_NODE_SQLITE_RX = re.compile(
    r"require\(\s*['\"](?:better-sqlite3|node:sqlite)['\"]\s*\)"
    r"|from\s+['\"](?:better-sqlite3|node:sqlite)['\"]"
)
_PERL_RX = re.compile(r"\bperl\b")
_PERL_DBI_RX = re.compile(r"DBI->connect", re.IGNORECASE)

# A bare (unquoted) `sqlite3 <path> < <path>` redirect -- the real shell-redirection shape, not a
# `<`/`<=`/`<>` SQL comparison, which only ever appears inside a quoted SQL argument.
_REDIRECT_IN_RX = re.compile(r"\bsqlite3\b\s+[^\s\"'<>]+\s*<\s*[^\s\"'<>]+")
_DOT_READ_IMPORT_RX = re.compile(r"\.(?:read|import)\s+\S+")

# SQL string literal following a comparison operator -- stripped before the verb/table search so
# a value like '%delete%' or 'insert' cannot masquerade as a write verb or table reference.
# SQLite's own single-quote escaping is a DOUBLED quote ('') -- backslash is not an escape
# character inside a SQL string literal. Round 3's regex used `[^'\\]|\\.` (shell/C-style
# backslash escaping), which let a backslash-quote INSIDE the literal consume text past the
# literal's real end (CYBERSEC NO-GO 28718 N1c): `'1'='x\'; DELETE FROM approvals; --'` was read
# as one literal by the hook and as a SELECT plus a live DELETE by SQLite.
_SQL_LITERAL_OP_RX = re.compile(
    r"(?:\bLIKE\b|\bIN\b|<>|!=|<=|>=|=|<|>)\s*('(?:[^']|'')*')",
    re.IGNORECASE,
)
# Any single-quoted literal in the command, not just one following an operator -- used only to
# detect an EMBEDDED write statement (round 4, N1 a/b), never to blank/suppress anything.
_ANY_LITERAL_RX = re.compile(r"'(?:[^']|'')*'")

# The escape hatch, or an env-var db-path indirection this guard cannot resolve from the command
# text alone -- both anchored to the start of the exact statement, real command-position syntax.
_ALLOW_RX = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*DB_WRITE_GUARD_ALLOW=1(?:\s|$)")
_UNRESOLVABLE_DB_VAR_RX = re.compile(r"\bsqlite3\b[^\n;&|]*\$\{?\w+\}?")
# The python/node/perl equivalent of a shell $VAR db-path: the runtime's own env-var accessor used
# as (or inside) the connect/dbname argument. Just as unresolvable from the command text alone as
# the shell case above -- fails closed the same way (round 3, QA FAIL 28716).
_RUNTIME_ENV_VAR_RX = re.compile(
    r"os\.environ(?:\[|\.get\()|os\.getenv\(|\$ENV\{|process\.env\b"
)

_HEREDOC_START_RX = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")
# Round 5 (WhiteHat NO-GO 28743 R1): round 4's heredoc-opener-awareness check needed widening --
# a shell wrapper that runs the heredoc body as a script (bash/sh/zsh/dash, eval, source, ssh) can
# just as easily carry a real sqlite3 write in its body text as python/node/perl can. Added to the
# keep-list alongside the existing sqlite3/python/node/perl openers; "cat" and other non-executing
# openers are deliberately still excluded (that is the P1 false-block fix this guard already has).
_SHELL_RX = re.compile(r"\b(?:bash|sh|zsh|dash)\b")
_EVAL_RX = re.compile(r"\beval\b")
_SOURCE_RX = re.compile(r"\bsource\b")
_SSH_RX = re.compile(r"\bssh\b")
# Round 5 R1b (WhiteHat NO-GO 28763): `.` is bash's own synonym for `source` (dot-sourcing) --
# `. /dev/stdin <<EOF` runs the heredoc body exactly like `source /dev/stdin <<EOF` does, but only
# the word "source" was in the keep-list. Matches a bare `.` token followed by whitespace (a
# command position), not a `.` inside a path or filename.
_DOT_SOURCE_RX = re.compile(r"(?:^|[\s;&|])\.\s")
# A pipe feeding stdin into a detected sqlite3 CLI call (cat f | sqlite3 db, or wrapped: | env
# sqlite3, | timeout 5 sqlite3, | sudo -u x sqlite3) -- same unreadable-SQL-source class as
# `<`/.read/.import (round 3, QA FAIL 28716). A single `|` is not a top-level statement separator
# (unlike `||`), so it survives _split_top_level intact and both sides stay in the same segment.
# ROUND 4 (CYBERSEC NO-GO 28718/28723 P1): round 3's version matched "sqlite3" ANYWHERE after a
# pipe, not just as the piped-to command itself -- `lsof claudeclaw.db | grep sqlite3` and
# `sqlite3 claudeclaw.db "SELECT ..." | grep -c sqlite3` false-blocked because the WORD "sqlite3"
# appeared as grep's search pattern, not as a command sqlite3 was piped INTO. Fixed: "sqlite3"
# must be the first command after the pipe, optionally behind one of these known wrappers.
_PIPE_WRAPPER_RX = r"(?:(?:env|nice)\s+|timeout\s+\S+\s+|sudo\s+(?:-\S+\s+)*(?:\S+\s+)?)*"
_PIPE_INTO_SQLITE_RX = re.compile(r"\|\s*" + _PIPE_WRAPPER_RX + r"sqlite3\b")
# The pipe's SOURCE is a literal echo/printf argument (readable text, same as any other quoted
# command-line argument) rather than a file/variable/command substitution (unreadable). When the
# source is readable, the usual table+verb scan on the segment already covers it correctly --
# `echo '.tables' | sqlite3 db` and `printf 'SELECT ...' | sqlite3 db` must not be forced-blocked
# just because SOME text was piped; only an unreadable source still fails closed unconditionally.
#
# ROUND 5 (CYBERSEC NO-GO 28743 R2): round 4's version only checked that echo/printf STARTED the
# source -- it never looked at what came between the command name and the pipe, so `echo "$Q" |
# sqlite3 db`, `echo "$(cat f)" | sqlite3 db`, `printf '%b' '\x44ELETE FROM appro\x76als' |
# sqlite3 db` and `echo -e '\x44ELETE...' | sqlite3 db` all matched and were treated as readable,
# even though a shell variable, a command substitution, or an escape-interpreting flag/format
# (`-e`, `%b`, `\xHH`) hides or transforms the real bytes this guard would need to see. "Readable"
# now means the ENTIRE span between the command name and the pipe is a plain literal: no `$`
# (variable or `$(...)` substitution), no backtick (old-style substitution), no backslash (escape
# sequences `printf`/`echo -e` would interpret), and no `%b` (printf's own escape-interpreting
# conversion). Anything else falls through to the unreadable-pipe side-channel check instead.
_PIPE_SOURCE_PREFIX_RX = re.compile(
    r"(?:^|[;\n]|&&|\|\|)\s*(?:echo|printf)\b(?P<rest>[^|]*)\|\s*" + _PIPE_WRAPPER_RX + r"sqlite3\b"
)


def _pipe_from_readable_source(segment: str) -> bool:
    for m in _PIPE_SOURCE_PREFIX_RX.finditer(segment):
        rest = m.group("rest")
        if any(token in rest for token in ("$", "`", "\\", "%b")):
            continue  # a variable, substitution, or escape-interpreting form -- not plain text
        return True
    return False


def _split_top_level(text: str):
    """Split on ; && || and real newlines, without splitting inside a quoted span or a heredoc
    body -- a heredoc's SQL stays attached to the line that opens it.

    ROUND 4 (MikroB live datapoint, CYBERSEC NO-GO 28718/28723, P1 class): a heredoc whose
    OPENING command is not itself an interpreter that could execute the body (e.g. `cat >file
    <<'JSON'`, writing a message that happens to quote an example DELETE statement) must not
    leave its body readable to the table/verb scan just because a later, unrelated sqlite3 call
    sits in the same top-level statement. Only a heredoc opened by a bare sqlite3/python/node/
    perl/bash/sh/zsh/dash/eval/source/ssh invocation keeps its body visible (round 4's M1b cases
    plus round 5's widened shell-wrapper list below) -- anything else gets its body blanked (same
    shape kept, content wiped).

    ROUND 5 (CYBERSEC NO-GO 28743 R1): round 4's heredoc handling started blanking-or-keeping
    lines starting at the FIRST newline after `<<MARK`, which also swallowed the REST OF THE
    OPENER'S OWN LINE as if it were heredoc body -- `cat <<'EOF' | sqlite3 store/claudeclaw.db`
    had `| sqlite3 store/claudeclaw.db` blanked away (heredoc_keep is False for a bare `cat`
    opener), hiding a real pipe into sqlite3 entirely, and `cat <<'EOF'; sqlite3 db "DELETE ..."`
    never even reached `_split_top_level`'s own `;` handling because that branch was shadowed by
    the heredoc-body branch at the top of the loop. Fixed: text between the `<<MARK` token and
    the NEXT real newline is now processed by the ORDINARY char-by-char loop (quotes, `;`, `&&`,
    `||` all still apply there, same as anywhere else) -- only the newline that ends the opener's
    own physical line hands off into heredoc-body-consuming mode for the lines that follow.

    ROUND 5 R1b (CYBERSEC NO-GO 28763, the one case R1's fix left open): heredoc_keep was still
    decided ONLY from the text BEFORE `<<MARK` -- a consumer named AFTER the marker on the same
    opener line was never seen, so `cat <<'EOF' | bash` / `| sh -s` (the heredoc's cat body piped
    into a shell that then runs the sqlite3 write inside it) kept heredoc_keep False and blanked
    a real write. Fixed: the interpreter-keyword check now ALSO runs over the opener-line text
    AFTER `<<MARK` (collected up to the line's closing newline), and heredoc_keep is the OR of
    both checks. Also added dot-sourcing (`. /dev/stdin <<EOF`, bash's `.` synonym for `source`)
    to the keep-list, same class as the existing `source`/`eval`/`ssh` entries."""
    segments = []
    buf = []
    i, n = 0, len(text)
    quote = None
    heredoc_marker = None  # set only once we are actually consuming body lines
    heredoc_pending_marker = None  # captured at `<<MARK`, applied at the end of THIS line
    heredoc_keep = True
    heredoc_tail_start = None  # buf index right after `<<MARK`, for the R1b opener-tail check
    while i < n:
        if heredoc_marker is not None:
            nl = text.find("\n", i)
            line_end = nl if nl != -1 else n
            line = text[i:line_end]
            if heredoc_keep or line.strip() == heredoc_marker:
                buf.append(line)
            else:
                buf.append(" " * len(line))
            if line.strip() == heredoc_marker:
                heredoc_marker = None
            if nl != -1:
                buf.append("\n")
                i = nl + 1
            else:
                i = n
            continue
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if heredoc_pending_marker is None:
            m = _HEREDOC_START_RX.match(text, i)
            if m:
                heredoc_pending_marker = m.group(2)
                opener = "".join(buf)
                heredoc_keep = bool(
                    _SQLITE_CLI_RX.search(opener)
                    or _PY_RX.search(opener)
                    or _NODE_RX.search(opener)
                    or _PERL_RX.search(opener)
                    or _SHELL_RX.search(opener)
                    or _EVAL_RX.search(opener)
                    or _SOURCE_RX.search(opener)
                    or _SSH_RX.search(opener)
                    or _DOT_SOURCE_RX.search(opener)
                )
                buf.append(m.group(0))
                heredoc_tail_start = len(buf)
                i += len(m.group(0))
                continue
        if text[i : i + 2] in ("&&", "||"):
            segments.append("".join(buf))
            buf = []
            i += 2
            continue
        if ch == ";":
            segments.append("".join(buf))
            buf = []
            i += 1
            continue
        if ch == "\n":
            if heredoc_pending_marker is not None:
                # End of the heredoc opener's own line -- NOW the body-consuming branch takes
                # over for the lines that follow, up to the terminator marker line. The newline
                # stays IN the segment (same as the body-consuming branch above keeps its own
                # newlines), since the opener and its body must remain one segment.
                # R1b: a consumer named AFTER `<<MARK` on this same line (e.g. `| bash`) was never
                # checked -- re-check the tail text too, OR'd into the decision already made from
                # the text before the marker.
                if not heredoc_keep and heredoc_tail_start is not None:
                    tail = "".join(buf[heredoc_tail_start:])
                    heredoc_keep = bool(
                        _SQLITE_CLI_RX.search(tail)
                        or _PY_RX.search(tail)
                        or _NODE_RX.search(tail)
                        or _PERL_RX.search(tail)
                        or _SHELL_RX.search(tail)
                        or _EVAL_RX.search(tail)
                        or _SOURCE_RX.search(tail)
                        or _SSH_RX.search(tail)
                        or _DOT_SOURCE_RX.search(tail)
                    )
                buf.append(ch)
                i += 1
                heredoc_marker = heredoc_pending_marker
                heredoc_pending_marker = None
                heredoc_tail_start = None
            else:
                segments.append("".join(buf))
                buf = []
                i += 1
            continue
        buf.append(ch)
        i += 1
    segments.append("".join(buf))
    return segments


def _is_sqlite_invocation(segment: str) -> bool:
    if _SQLITE_CLI_RX.search(segment):
        return True
    if _PY_RX.search(segment) and _PY_SQLITE_RX.search(segment):
        return True
    if _NODE_RX.search(segment) and _NODE_SQLITE_RX.search(segment):
        return True
    if _PERL_RX.search(segment) and _PERL_DBI_RX.search(segment):
        return True
    return False


def _resolved_basename_matches(token: str) -> bool:
    try:
        return os.path.basename(os.path.realpath(token)) == PROTECTED_DB
    except Exception:
        return False


def _db_target_present(segment: str) -> bool:
    """Literal protected-db name, or a path/symlink that resolves to it on this filesystem."""
    if PROTECTED_DB in segment:
        return True
    for tok in re.findall(r"[^\s\"'<>|;&]+", segment):
        if "$" in tok or ("." not in tok and "/" not in tok):
            continue
        if _resolved_basename_matches(tok):
            return True
    return False


def _embedded_write_statement(text: str) -> bool:
    """A single-quoted literal (a python/perl variable assignment, or the source value of a
    shell $VAR later referenced by a sqlite3 call) whose OWN content names a protected table AND
    a write verb TOGETHER is a SQL statement stored for later execution, not a comparison value
    -- round-1 regression N1a/b (CYBERSEC NO-GO 28718/28723): `q='DELETE FROM approvals'` and
    `Q='DELETE FROM approvals'; sqlite3 store/claudeclaw.db "$Q"` must still block, same as a bare
    `DELETE FROM approvals` would. A genuine comparison value never has the table name INSIDE the
    very same literal (`category='insert'` -> content "insert"; `LIKE '%delete%'` -> content
    "%delete%"), so this does not reintroduce M3's false blocks. Checked on the WHOLE command
    (not per-segment), since the assignment and the sqlite3 call that uses it are two different
    top-level statements."""
    for m in _ANY_LITERAL_RX.finditer(text):
        content = m.group(0)[1:-1].replace("''", "'")
        if _TABLE_RX.search(content) and _WRITE_VERB_RX.search(content):
            return True
    return False


def _strip_sql_noise(segment: str) -> str:
    """Blank unquoted shell comments and SQL string literals (after a comparison operator)
    before the table/verb search, so quoted values and trailing comments cannot be mistaken for
    the statement itself."""
    out = []
    quote = None
    for ch in segment:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(ch)
            continue
        if ch == "#":
            break
        out.append(ch)
    no_comment = "".join(out)

    def _blank(m):
        quoted = m.group(1)
        return m.group(0)[: len(m.group(0)) - len(quoted)] + (" " * len(quoted))

    return _SQL_LITERAL_OP_RX.sub(_blank, no_comment)


def _command_blocked(cmd: str):
    """Returns (blocked, reason) for the whole Bash command."""
    segments = _split_top_level(cmd)

    # N1 (round 4): a write statement embedded whole inside a literal/variable assignment, found
    # anywhere in the command, blocks as long as some segment actually invokes sqlite3/python/
    # node/perl against the PROTECTED db (or an unresolvable stand-in for it) and isn't itself the
    # escaped leading statement -- a sqlite3 call against a clearly different, unrelated db stays
    # out of scope, same as the ordinary per-segment check below.
    unescaped_invocations = [
        s
        for s in segments
        if _is_sqlite_invocation(s)
        and not _ALLOW_RX.match(s.lstrip())
        and (
            _db_target_present(s)
            or _UNRESOLVABLE_DB_VAR_RX.search(s)
            or _RUNTIME_ENV_VAR_RX.search(s)
        )
    ]
    if unescaped_invocations and _embedded_write_statement(cmd):
        return True, (
            "a string literal or variable assignment embeds a direct write to a protected "
            "table -- stored for later execution, not a comparison value"
        )

    for segment in segments:
        if not _is_sqlite_invocation(segment):
            continue
        if _ALLOW_RX.match(segment.lstrip()):
            continue

        db_present = _db_target_present(segment)
        db_unresolvable = (not db_present) and bool(
            _UNRESOLVABLE_DB_VAR_RX.search(segment) or _RUNTIME_ENV_VAR_RX.search(segment)
        )
        if not db_present and not db_unresolvable:
            continue  # a clearly different, unrelated database

        # P1 (round 4): a pipe into sqlite3 whose SOURCE is a readable echo/printf literal is not
        # an unreadable side channel -- fall through to the normal table+verb scan below instead
        # of forcing a block regardless of content.
        pipe_into_sqlite = bool(_PIPE_INTO_SQLITE_RX.search(segment))
        pipe_from_readable_source = pipe_into_sqlite and _pipe_from_readable_source(segment)
        if db_present and _SQLITE_CLI_RX.search(segment) and (
            _REDIRECT_IN_RX.search(segment)
            or _DOT_READ_IMPORT_RX.search(segment)
            or (pipe_into_sqlite and not pipe_from_readable_source)
        ):
            return True, (
                "side-channel sqlite3 input (`<`, `.read`, `.import` or an unreadable pipe) "
                "against the protected database -- this guard cannot see the SQL it would run"
            )

        scanned = _strip_sql_noise(segment)
        table_match = _TABLE_RX.search(scanned)
        if not table_match:
            continue
        if not _WRITE_VERB_RX.search(scanned):
            continue

        reason = f"direct write to protected table ('{table_match.group(0)}')"
        if db_unresolvable:
            reason += " via an unresolvable db-path variable -- cannot confirm it is a different database"
        return True, reason
    return False, ""


def _write_tool_blocked(payload: dict):
    ti = payload.get("tool_input")
    if not isinstance(ti, dict):
        return False
    path = ti.get("file_path")
    if not isinstance(path, str) or not path:
        return False
    if PROTECTED_DB in path or _resolved_basename_matches(path):
        return True
    return False


def main():
    if os.environ.get("DB_WRITE_GUARD", "").lower() == "off":
        sys.exit(0)

    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get("tool_name") or ""

    if tool_name in ("Write", "Edit", "MultiEdit"):
        if _write_tool_blocked(payload):
            sys.stderr.write(
                "DB-WRITE-GUARD: a Write/Edit/MultiEdit call targeting the dashboard's database "
                f"file ({PROTECTED_DB}) is blocked -- this tool writes raw bytes with no SQL to "
                "inspect and no escape hatch applies. Use the dashboard API, or a reviewed sqlite3 "
                "write with DB_WRITE_GUARD_ALLOW=1, instead.\n"
            )
            sys.exit(2)
        sys.exit(0)

    if tool_name != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    cmd = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(cmd, str) or not cmd:
        sys.exit(0)

    try:
        blocked, reason = _command_blocked(cmd)
    except Exception:
        if PROTECTED_DB in cmd or _TABLE_RX.search(cmd):
            sys.stderr.write(
                "DB-WRITE-GUARD: internal error while scanning a command naming the protected "
                "db/table -- failing closed rather than letting an unreadable command through.\n"
            )
            sys.exit(2)
        sys.exit(0)

    if blocked:
        sys.stderr.write(
            f"DB-WRITE-GUARD: {reason} ({PROTECTED_DB}) -- dashboard_users/auth_sessions/approvals "
            "carry auth/session/approval state the dashboard API hashes, validates and audit-logs "
            "on write; a raw write bypasses all of that. Use the dashboard API instead. Reviewed "
            "one-off: prefix the exact statement with DB_WRITE_GUARD_ALLOW=1.\n"
        )
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
