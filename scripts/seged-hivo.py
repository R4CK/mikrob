#!/usr/bin/env python3
"""seged-hivo.py -- run a one-off helper (Codex CLI or agy) inside ONE work folder, and log it.

Lets a Claude agent hand a well-bounded task to an outside helper (OpenAI Codex CLI, Google agy/Gemini)
and records every call, so you can decide from data what each helper is good or weak at compared
with a Claude agent.

Usage:
  seged-hivo.py --seged codex:<model>|agy:<model> --mappa DIR --prompt FILE --hivo AGENT --kartya TASK_ID
                --feladattipus TYPE [--timeout SEC]
  seged-hivo.py --ertekel CALL_ID --eredmeny elfogadva|javitva|eldobva --pont 1-10 --velemeny TEXT --hivo AGENT
                                   record how the caller judged a helper result (CALL_ID = the call's "ido")
  seged-hivo.py --osszesito [--tol YYYY-MM-DD] [--json]
                                   reliability summary per helper:model (ok/error/blocked rates, time,
                                   tokens, and how often the result needed a Claude fix)
  seged-hivo.py --onteszt          self-test of the contact-data gate (positive + negative control)

Rating (after EVERY ok call, by the calling specialist):
  --eredmeny (was a Claude fix needed?): elfogadva = used as is | javitva = usable after a Claude fix |
             eldobva = thrown away, Claude redid it
  --pont 1-10, relative to a Claude agent doing the same task: 5 = as good as Claude would have done it,
             above 5 better, below 5 worse
  --velemeny: at most 2 sentences, what it was good or weak at
Blind A/B: every 5th sent call is marked ab=true in the log (and announced on stderr), so a reviewer
  can score those blind against a Claude result.
Task types (--feladattipus): kod | kod-atnezes | szoveg | kep | weboldal | kutatas | adat | egyeb

What it does:
  codex: codex exec -m <model> -s workspace-write -C DIR --skip-git-repo-check --color never -   (prompt on stdin)
  agy:   agy -p <prompt> --model <model> --dangerously-skip-permissions --output-format json      (cwd = DIR)
  Both inside bubblewrap: $HOME, /run (session bus, WSL interop) and the Windows drives hidden; only DIR
  and the engine's state dir writable; environment cleared; own PID namespace (no process outlives it).
  DIR must be a subfolder of SEGED_BASE (default ~/seged-munka), never the Marveen repo or a credential dir.
  Raw output -> store/seged-hivo/<ts>-<engine>.log, one JSONL row -> store/seged-hivo-naplo.jsonl
  (time, caller, card, helper, model, tokens, duration, exit, status). The JSONL row holds only the
  prompt's sha256; the raw log does contain the prompt (codex echoes it), it stays under store/.

Gate (runs BEFORE the call, client data must not go to an outside provider):
  the prompt file and EVERY file in DIR are checked. Only allowlisted text types may be there
  (.md .txt .html .css .js .json .csv, plus .py .ts .tsx .jsx .mjs .svg); any other file (images, docx,
  xlsx, pdf, zip, .eml, .git content), a symlink, a non-UTF-8 file or one over 2 MB stops the call.
  The text is scanned for e-mail addresses, phone numbers (also written as (at), full-width, with dots
  or slashes, html entities, \\u0040 / %40 escapes, split by tags or string concatenation) and secrets
  (titok-kapu.py, which also reads tagged and minified lines). Any hit -> no call,
  status=blocked, exit 3. Hits are shown masked. agy prompts over 100 KB are refused the same way.

  The gate is strict on purpose: no allowlist beyond reserved example domains. So every brief MUST
  demand undeliverable placeholder contact data, or the helper's own footer
  blocks the next call in the same folder:
    e-mail: info@ceg.example (any *.example / *.test / example.com)
    phone:  the literal text [TELEFON], never digits
  Brief template + which helper for what: docs/seged-hivo-utmutato.md

Quota (runs BEFORE the gate): when many agents call helpers, a subscription used through an unofficial
  client can be banned (Google did it to Gemini users in 2026-02). So, counted from the log per local calendar day, every call that went out counts (ok, error,
  timeout; a blocked call sent nothing and does not count):
    per caller (--hivo) at most 5 calls a day; per engine at most agy 20, codex 40 calls a day (whole fleet);
    at most ONE helper call running at a time in the fleet (flock on store/seged-hivo.lock).
  Over a limit, or while another call runs -> nothing sent, status=blocked, blokk=kvota|zar, exit 5.
  --hivo is normalized (case, spaces, invisible characters) and must name a folder under agents/ (if that
  folder exists), so "My-Agent " cannot start a second count. A status=started row is written before the
  helper starts, so a call whose process is killed (caller-side timeout, Ctrl-C) still counts.
  Pause: between two helper calls in the fleet a random 5-15 s gap (szunet_min_s / szunet_max_s), waited out
  under the lock, so calls never come in a machine-gun rhythm.
  Stop flag: if a call fails with a 403 / 429-type answer (refused or throttled account), store/seged-hivo-STOP.json
  is written and an alert goes to the main agent (POST SEGED_RIASZT_URL, token store/.dashboard-token); every
  later call is refused (blokk=stop, exit 5) until a human has checked the account and deleted the file.
  Limits: defaults above < store/seged-hivo-kvota.json {"hivo_nap": 5, "codex_nap": 40, "agy_nap": 20,
  "zar_var_s": 0} (path: SEGED_KVOTA_FAJL) < env SEGED_HIVO_NAP / SEGED_CODEX_NAP / SEGED_AGY_NAP /
  SEGED_ZAR_VAR_S. zar_var_s = how long to wait for a running call before giving up (default 0: at once).
  0 for an engine = that engine is off. A bad value stops the call (exit 2), it never means "no limit".

Exit: 0 ok | 1 helper failed | 2 bad usage | 3 blocked by the gate | 4 timeout | 5 quota or lock: try later
"""
import argparse, fcntl, hashlib, html, json, os, random, re, stat, subprocess, sys, tempfile, time, unicodedata
import urllib.request, uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get('MARVEEN_ROOT', Path(__file__).resolve().parent.parent))
STORE = ROOT / 'store'
LOG = STORE / 'seged-hivo-naplo.jsonl'
RAW_DIR = STORE / 'seged-hivo'
HOME = Path.home()
BINS = {'codex': os.environ.get('CODEX_BIN', str(HOME / '.local/bin/codex')),
        'agy': os.environ.get('AGY_BIN', str(HOME / '.local/bin/agy'))}
BWRAP = os.environ.get('BWRAP_BIN', '/usr/bin/bwrap')
SEGED_BASE = os.environ.get('SEGED_BASE', str(HOME / 'seged-munka'))
LOCK = STORE / 'seged-hivo.lock'
QUOTA_FILE = Path(os.environ.get('SEGED_KVOTA_FAJL', STORE / 'seged-hivo-kvota.json'))
QUOTA_DEFAULTS = {'hivo_nap': 5, 'codex_nap': 40, 'agy_nap': 20, 'zar_var_s': 0, 'szunet_min_s': 5, 'szunet_max_s': 15}
LAST_CALL = STORE / 'seged-hivo-utolso'   # mtime = when the last helper call started or ended (pause base)
STOP = STORE / 'seged-hivo-STOP.json'     # set on 403/429; every call is refused until a human deletes it
ALERT_URL = os.environ.get('SEGED_RIASZT_URL', 'http://localhost:3420/api/messages')
# what a refused / throttled account looks like (HTTP 403 / 429 and the Google API status names); checked
# only on a call that FAILED, because an ok answer may well contain "429" as plain content
DENIED = re.compile(r'\b(?:http|status|code|error)\W{0,3}(?:403|429)\b|\bhttp/\d(?:\.\d)?\s+(?:403|429)\b|\b(?:403\s+forbidden|429\s+too many requests)\b'
                    r'|too many requests|resource_exhausted|permission_denied', re.I)

# --- contact-data gate ----------------------------------------------------------
# \w is unicode-aware: kovács.jános@példa.hu matches. Quoted local parts and IP literals too.
EMAIL = re.compile(r'(?:"[^"\n]{1,64}"|[\w.%+-]{1,64})@(?:\[\d{1,3}(?:\.\d{1,3}){3}\]|[\w-]+(?:\.[\w-]+)*\.[^\W\d_]{2,})')
_S = r'[\s./()-]'   # separators people put between digit groups
PHONE = re.compile(
    r'(?<![\w+])(?<!\d[-./])(?!06-[0-3]\d/0\d-)(?:'   # not inside a date: 2026-06-14, 06-21/06-23
    r'(?:\+\s?36|\(\+?36\)|0036|06)' + _S + r'{0,3}\d(?:' + _S + r'{0,2}\d){7,9}'   # HU with prefix, any grouping
    r'|36(?:1|20|30|31|50|70)\d{6,7}'                                              # 36301234567
    r'|(?:20|30|31|50|70)' + _S + r'?\d{3}' + _S + r'?(?:\d{4}|\d{2}' + _S + r'?\d{2})'  # 30/123-4567, 30 123 45 67
    r'|\+\d{1,3}' + _S + r'{0,2}\d{1,4}\)?(?:' + _S + r'{0,2}\d{2,4}){2,4}'  # other international; no space after +: "a + 2026-08-08" is a sum
    r')(?![\d])(?!\s?(?:Ft|HUF|EUR|€|%|px|db)\b)')
# obfuscations that a human reads as an address: (at) [at] {at} (kukac), (dot) [pont]
_AT = re.compile(r'\s*[(\[{]\s*(?:at|kukac)\s*[)\]}]\s*', re.I)
_DOT = re.compile(r'\s*[(\[{]\s*(?:dot|pont)\s*[)\]}]\s*', re.I)
_INVISIBLE = re.compile('[\u00ad\u200b-\u200f\u2060\ufeff]')
# how generated html/svg/js really stores an address: split by tags, escaped, concatenated
_TAG = re.compile(r'<[^<>]{0,500}>')
_ESC = re.compile(r'\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|%([0-9a-fA-F]{2})')
_CONCAT = re.compile(r'["\'`]\s*\+\s*["\'`]')
# RFC 2606/6761 reserved names only: these can never reach a real inbox. "pelda.hu" & co. are real domains.
RESERVED_MAIL = re.compile(r'@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|[\w-]+\.(?:example|test|invalid|localhost))$', re.I)
# Every file in DIR is either scanned as text (any extension: sniffed, not trusted by name) or is a
# media file the helper may legitimately make (a generated image). Anything else (docx, xlsx, pdf, zip,
# .git objects ...) cannot be scanned, so the call stops: client data typically arrives in exactly those.
# Allowlist: only known text types go out, everything else stops the call, images included
# (a photo of a business card is client data the gate cannot read). The code types are there for kod tasks.
TEXT_EXT = {'.md', '.txt', '.html', '.css', '.js', '.json', '.csv',
            '.py', '.ts', '.tsx', '.jsx', '.mjs', '.svg'}
MAX_SCAN = 2_000_000


def mask(s):
    return s[:2] + '*' * max(1, len(s) - 4) + s[-2:] if len(s) > 4 else '*' * len(s)


def normalize(text):
    """What a human would read: full-width forms folded (NFKC), invisible characters dropped, (at)/(dot) undone."""
    text = _INVISIBLE.sub('', unicodedata.normalize('NFKC', text))
    return _DOT.sub('.', _AT.sub('@', text))


def decoded(text):
    """Second view: html entities, \\uXXXX / \\xXX / %XX escapes and string concatenation undone, tags dropped.
    The tags are dropped only here: the plain view still sees an address inside an attribute (mailto:)."""
    text = _ESC.sub(lambda m: chr(int(m.group(1) or m.group(2) or m.group(3), 16)), html.unescape(text))
    return _TAG.sub('', _CONCAT.sub('', text))


def scan_text(text):
    """Return masked hits [(kind, masked)] for e-mail/phone patterns, in the plain and the decoded view."""
    hits = []
    for view in (normalize(text), normalize(decoded(text))):
        hits += [('email', mask(m.group())) for m in EMAIL.finditer(view) if not RESERVED_MAIL.search(m.group())]
        hits += [('telefon', mask(m.group())) for m in PHONE.finditer(view)]
    return list(dict.fromkeys(hits))


def read_as_text(p):
    """Text content, or None if the file is not plain UTF-8 text (sniffed, the extension is not trusted)."""
    raw = p.read_bytes()
    if b'\0' in raw[:65536]:
        return None
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return None


def run_gate(prompt, workdir):
    """Returns (problems, scanned): problems is a list of 'file: reason' strings; empty = clean.
    Nothing is skipped silently: a file that cannot be scanned is itself a reason to stop."""
    problems, texts = [], []
    files = [prompt]
    walk_errors = []  # a folder os.walk cannot list (chmod 000) would otherwise be skipped silently
    for d, dirnames, fs in os.walk(workdir, onerror=walk_errors.append):
        # os.walk does not descend into a symlinked directory, so it would go unscanned: report it
        problems += [f'{Path(d) / x}: symlinked directory, not sending (it may point outside DIR)'
                     for x in dirnames if (Path(d) / x).is_symlink()]
        files += sorted(Path(d) / f for f in fs if (Path(d) / f).resolve() != prompt.resolve())
    problems += [f'{e.filename}: unreadable folder ({e.strerror}), not sending' for e in walk_errors]
    for p in files:
        try:
            if p.suffix.lower() not in TEXT_EXT:
                problems.append(f'{p}: file type not on the allowlist ({" ".join(sorted(TEXT_EXT))}), not sending')
                continue
            st = p.lstat()
            if stat.S_ISLNK(st.st_mode):
                problems.append(f'{p}: symlink, not sending (it may point outside DIR)')
                continue
            if not stat.S_ISREG(st.st_mode):  # a FIFO would block the read forever
                problems.append(f'{p}: not a regular file, not sending')
                continue
            if st.st_size > MAX_SCAN:
                problems.append(f'{p}: too large to scan ({st.st_size} B), not sending')
                continue
            text = read_as_text(p)
        except OSError as e:
            problems.append(f'{p}: unreadable ({e.strerror}), not sending')
            continue
        if text is None:
            problems.append(f'{p}: not plain UTF-8 text despite its extension, cannot be scanned, not sending')
            continue
        texts.append(p)
        problems += [f'{p}: {k} {m}' for k, m in scan_text(text)]
    # secrets: reuse the commit gate (scripts/muszertar/titok-kapu.py) on the same files (exit 1 = hit, 2 = broken instrument).
    # Pass them as .txt copies: titok-kapu skips paths under .git/ node_modules/ dist/ and some extensions,
    # and here the decision what is text has already been made above.
    tk = ROOT / 'scripts/muszertar/titok-kapu.py'
    with tempfile.TemporaryDirectory() as td:
        paths = []
        for i, p in enumerate(texts):
            q = Path(td) / f'{i}.txt'
            q.write_bytes(p.read_bytes())
            paths.append(str(q))
        r = subprocess.run([sys.executable, str(tk), *paths], capture_output=True, text=True)
        report = r.stdout + r.stderr
        for q, p in sorted(zip(paths, texts), key=lambda x: -len(x[0])):  # 10.txt before 1.txt
            report = report.replace(q, str(p))
    scanned = len(texts)
    if r.returncode != 0:
        problems.append(f'titok-kapu exit {r.returncode}: {report.strip()[:600]}')
    return problems, scanned


def selftest():
    pos = ['hivj: +36 30 123 4567', 'tel 06-30-123-4567', '06301234567', '+36 1 234 5678',
           'irj: kovacs.janos@pelda-ugyfel.hu', '+44 20 7946 0958',
           # grouping / obfuscation variants
           '06 30 123 45 67', '06-30-123-45-67', '+36.30.123.4567', '30/123-4567', '30 123 4567',
           'tel: 301234567', '36301234567', '+36 20 9 123 456', 'Mobil: +36/30/123-45-67',
           '+ 36 30 123 4567', 'tel 06-30/123-4567', 'kovacs(at)pelda.hu', 'kovacs [at] pelda [pont] hu',
           'kovacs\uff20pelda.hu', 'kovács.jános@példa.hu', '"kovacs janos"@pelda.hu',
           'kovacs@[192.168.1.10]', 'kov\u200bacs@pel\u200bda.hu', '+36 30 12\u200b3 4567',
           # encoded / split forms a generated html/svg/js really holds
           'kovacs&#64;pelda.hu', 'kovacs&commat;pelda.hu', 'kovacs@pelda&period;hu', 'kovacs<span>@</span>pelda.hu',
           '<b>+36</b> <b>30</b> <b>123</b> <b>4567</b>', '<tspan>kovacs</tspan><tspan>@pelda.hu</tspan>',
           '"kovacs\\u0040pelda.hu"', '"kovacs\\x40pelda.hu"', '"kovacs" + "@" + "pelda.hu"',
           'mailto:kovacs%40pelda.hu', '<a href="mailto:kovacs@pelda.hu">irj</a>', 'x' * 70 + '@pelda.hu']
    neg = ['2026-10-03 15:22', 'border-radius: 4px; width: 1200px', 'hash 3f07a81 es 52dc0e9',
           'ar: 14 500 Ft/ora, 95 Ft/km', 'v0.160.0, gpt-6.1-sol', 'id 1234567890x',
           'hello@ceg.example, teszt@example.com', 'telefon: [TELEFON]',
           'ar: 30 000 Ft, 20 000 Ft/ho', '12 345 678 Ft', 'meret 30 x 120 cm', 'codex@0.160.0',
           '2026-06-15 12:30:45', 'npm i @types/node',
           '3f07a81 + 7ce51d42 + 408681BF', 'admin + 31 200-44 900 Ft', 'eredeti + 2026-08-08 23:1x', '+ 0.0002 USD',
           '06-21/06-23/06-29 ota', '(2026-06-14/06-14/06-18, az',
           '<p>ar: <b>30 000</b> Ft</p>', 'width: 100%; content: "\\u2014"', 'a' * 5000]
    bad = [s for s in pos if not scan_text(s)] + [s for s in neg if scan_text(s)]
    for s in bad:
        print('FAIL:', s, scan_text(s))
    print(f'onteszt: {len(pos)} positive, {len(neg)} negative, {len(bad)} failed')
    return 1 if bad or quota_selftest() else 0


def quota_selftest():
    """End-to-end through main() in a throw-away root. A stub stands in for bwrap (BWRAP_BIN): it prints an
    agy-style SUCCESS JSON, so a call that passes quota and gate "runs" in no time and sends nothing. Each case has its control pair:
    the same setup one call below the limit must go (exit 0), else a blocked result proves nothing."""
    import shutil, threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    fails, n = [], 0
    alerts = []

    class Catch(BaseHTTPRequestHandler):  # stands in for the dashboard: records the STOP alert
        def do_POST(self):
            alerts.append((self.headers.get('Authorization'), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{}')

        def log_message(self, *args):
            pass
    srv = HTTPServer(('127.0.0.1', 0), Catch)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        root, base = td / 'root', td / 'base'
        (root / 'scripts/muszertar').mkdir(parents=True)
        (root / 'scripts/muszertar/titok-kapu.py').symlink_to(ROOT / 'scripts/muszertar/titok-kapu.py')
        (base / 'w').mkdir(parents=True)
        (td / 'p.md').write_text('Hozz letre egy hello.txt fajlt.\n')
        stub = td / 'bwrap-stub.sh'
        stub.write_text(f'#!/bin/sh\necho x >> {td}/hivasok\n[ -f {td}/lassu ] && sleep 3\n'
                        f'[ -f {td}/tiltas ] && {{ echo "Error: HTTP 429 Too Many Requests" >&2; exit 1; }}\n'
                        f'[ -f {td}/h2 ] && {{ echo "< HTTP/2 429" >&2; exit 1; }}\n'
                        f'[ -f {td}/hiba ] && {{ echo "Error: model not found" >&2; exit 1; }}\n'
                        f'[ -f {td}/ok429 ] && {{ echo \'{{"status": "SUCCESS", "response": "HTTP 429 Too Many '
                        'Requests is the code to handle", "usage": {"total_tokens": 1}}\'; exit 0; }\n'
                        'echo \'{"status": "SUCCESS", "response": "", "usage": {"total_tokens": 1}}\'\n')
        stub.chmod(0o700)
        log, lock = root / 'store/seged-hivo-naplo.jsonl', root / 'store/seged-hivo.lock'
        today = datetime.now().astimezone().isoformat(timespec='milliseconds')
        env0 = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(HOME), 'MARVEEN_ROOT': str(root),
                'SEGED_BASE': str(base), 'BWRAP_BIN': str(stub), 'SEGED_KVOTA_FAJL': str(td / 'kvota.json'),
                'SEGED_SZUNET_MIN_S': '0', 'SEGED_SZUNET_MAX_S': '0',
                'SEGED_RIASZT_URL': f'http://127.0.0.1:{srv.server_port}/api/messages'}

        cmd = lambda caller, engine='codex': [
            sys.executable, __file__, '--seged', f'{engine}:m', '--mappa', str(base / 'w'), '--prompt',
            str(td / 'p.md'), '--hivo', caller, '--kartya', 'onteszt', '--feladattipus', 'egyeb']

        def case(name, want, seed=(), engine='codex', caller='teszt-a', env=None, conf=None, holder=None,
                 agents=(), mode=None, stop=False, last=None):
            nonlocal n
            n += 1
            alerts.clear()
            shutil.rmtree(root / 'store', ignore_errors=True)
            shutil.rmtree(root / 'agents', ignore_errors=True)
            (root / 'store').mkdir()
            (root / 'store/.dashboard-token').write_text('teszt-token\n')
            if stop == 'dir':
                (root / 'store/seged-hivo-STOP.json').mkdir()
            elif stop:
                (root / 'store/seged-hivo-STOP.json').write_text('{"minta": "HTTP 429"}\n')
            if last is not None:
                (root / 'store/seged-hivo-utolso').touch()
                os.utime(root / 'store/seged-hivo-utolso', (time.time() - last,) * 2)
            if mode:
                (td / mode).touch()
            for ag in agents:
                (root / 'agents' / ag).mkdir(parents=True)
            (td / 'kvota.json').unlink(missing_ok=True)
            if conf is not None:
                (td / 'kvota.json').write_text(conf)
            log.write_text(''.join(json.dumps(r) + '\n' for r in seed))
            h = None
            if holder == 'hivas':  # a real second seged-hivo call, slowed down, holds the lock
                (td / 'lassu').touch()
                h = subprocess.Popen(cmd('teszt-c'), env=env0, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                end = time.monotonic() + 10
                while b'teszt-c' not in (lock.read_bytes() if lock.exists() else b'') and time.monotonic() < end:
                    time.sleep(0.05)
            elif holder == 'kill':  # a real call is killed (SIGKILL) while its helper runs
                (td / 'lassu').touch()
                k = subprocess.Popen(cmd(caller), env=env0, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                end = time.monotonic() + 10
                while b'"hivo"' not in (lock.read_bytes() if lock.exists() else b'') and time.monotonic() < end:
                    time.sleep(0.05)
                time.sleep(1)  # past the gate, inside the 3 s helper; do not wait for our own log row
                k.kill()
                k.wait()
                (td / 'lassu').unlink(missing_ok=True)
            elif holder is not None:  # another process holds the fleet lock for `secs` seconds, then may log a call
                secs, row = holder if isinstance(holder, tuple) else (holder, None)
                h = subprocess.Popen([sys.executable, '-c', 'import fcntl,os,sys,time;fd=os.open(sys.argv[1],os.O_RDWR|'
                                      'os.O_CREAT);fcntl.flock(fd,fcntl.LOCK_EX);print(1,flush=True);'
                                      'time.sleep(float(sys.argv[2]));sys.argv[4] and open(sys.argv[3],"a").write('
                                      'sys.argv[4]+"\\n")', str(lock), str(secs), str(log), json.dumps(row) if row else ''],
                                     stdout=subprocess.PIPE, text=True)
                h.stdout.readline()
            t0 = time.monotonic()
            r = subprocess.run(cmd(caller, engine), env={**env0, **(env or {})},
                               capture_output=True, text=True, timeout=60)
            if h:
                h.wait()
            for f in ('lassu', 'tiltas', 'h2', 'hiba', 'ok429'):
                (td / f).unlink(missing_ok=True)
            last = [x for x in read_jsonl(log) if x.get('hivo') == norm_caller(caller)][-1:] or [{}]
            got = (r.returncode, last[0].get('blokk'))
            if got != want:
                fails.append(f'{name}: want {want}, got {got} after {time.monotonic() - t0:.1f}s; {r.stderr.strip()[-300:]}')
            return time.monotonic() - t0

        seq = iter(range(10 ** 6))  # one call = one ido; rows of the same ido are one call
        sent = lambda k, who='teszt-a', eng='codex', st='ok', ido=today: [
            {'ido': f'{ido[:23]}{next(seq):06d}{ido[23:]}', 'hivo': who, 'seged': eng, 'modell': 'm', 'status': st}
            for _ in range(k)]
        pairs = lambda k: [dict(r, status=st) for r in sent(k) for st in ('started', 'ok')]
        case('4 calls today -> 5th goes (control)', (0, None), sent(4))
        case('5 calls today -> 6th blocked', (5, 'kvota'), sent(5))
        case('error and timeout count too', (5, 'kvota'), sent(3) + sent(1, st='error') + sent(1, st='timeout'))
        case('gate-blocked calls do not count', (0, None), sent(4) + sent(5, st='blocked'))
        case('ratings do not count', (0, None), sent(4) + [{'tipus': 'ertekeles', 'ido': today, 'hivo': 'teszt-a'}] * 3)
        case('5 calls yesterday -> today goes', (0, None), sent(5, ido='2000-01-01T10:00:00.000+01:00'))
        case('other agent at 5 -> mine goes', (0, None), sent(5, who='teszt-b'))
        case('agy fleet cap 20 reached', (5, 'kvota'), [r for i in range(5) for r in sent(4, who=f'x{i}', eng='agy')], 'agy')
        case('agy fleet 19 -> goes (control)', (0, None), [r for i in range(5) for r in sent(4, who=f'x{i}', eng='agy')][:19], 'agy')
        case('agy cap full -> codex still goes', (0, None), [r for i in range(5) for r in sent(4, who=f'x{i}', eng='agy')])
        case('codex fleet cap 40 reached', (5, 'kvota'), [r for i in range(10) for r in sent(4, who=f'x{i}')])
        case('config file hivo_nap=1', (5, 'kvota'), sent(1), conf='{"hivo_nap": 1}')
        case('env beats config file', (0, None), sent(1), conf='{"hivo_nap": 1}', env={'SEGED_HIVO_NAP': '2'})
        case('agy_nap=0 switches agy off', (5, 'kvota'), (), 'agy', env={'SEGED_AGY_NAP': '0'})
        case('bad value stops the call', (2, None), (), env={'SEGED_HIVO_NAP': 'sok'})
        case('unknown config key stops the call', (2, None), (), conf='{"hivo_per_nap": 99}')
        case('name normalized: " Teszt-A" counts with teszt-a', (5, 'kvota'), sent(5), caller=' Teszt-A\u200b')
        case('unknown agent name refused', (2, None), (), caller='teszt-x', agents=('teszt-a', 'teszt-b'))
        case('known agent name goes (control)', (0, None), (), caller='Teszt-B', agents=('teszt-a', 'teszt-b'))
        case('started + final row = one call (control)', (0, None), pairs(4))
        case('started row alone counts', (5, 'kvota'), sent(4) + sent(1, st='started'))
        case('call killed mid-run still counts', (5, 'kvota'), sent(4), holder='kill')
        case('counted after the lock, not before', (5, 'kvota'), sent(4), holder=(1.5, sent(1)[0]),
             env={'SEGED_ZAR_VAR_S': '20'})
        case('second call while one runs -> blocked', (5, 'zar'), holder=3)
        case('two real calls at once -> second blocked', (5, 'zar'), holder='hivas')
        stopf = root / 'store/seged-hivo-STOP.json'
        (root / '.env').write_text('MAIN_AGENT_ID=fo-ugynok\n')
        case('helper answers 429 -> call fails (exit 1)', (1, None), mode='tiltas')
        (root / '.env').unlink()
        if not stopf.exists() or len(alerts) != 1 or alerts[0][0] != 'Bearer teszt-token' \
                or alerts[0][1].get('to') != 'fo-ugynok' or 'STOP' not in alerts[0][1].get('content', ''):
            fails.append(f'429: STOP file {stopf.exists()}, alerts {alerts}')
        (root / '.env').write_text('OTHER=1\nMAIN_AGENT_ID=fo-ugynok\n')
        case('429, recipient from MAIN_AGENT_ID in .env', (1, None), mode='tiltas')
        (root / '.env').unlink()
        if [a[1].get('to') for a in alerts] != ['fo-ugynok']:
            fails.append(f'alert recipient from .env: {[a[1].get("to") for a in alerts]}')
        case('429, alert recipient set by env', (1, None), mode='tiltas', env={'SEGED_RIASZT_CIMZETT': 'mas-cimzett'})
        if [a[1].get('to') for a in alerts] != ['mas-cimzett']:
            fails.append(f'alert recipient from env: {[a[1].get("to") for a in alerts]}')
        case('bare HTTP/2 429 status line -> STOP', (1, None), mode='h2')
        if not stopf.exists():
            fails.append('HTTP/2 429 did not set STOP')
        case('other helper error -> no STOP (control)', (1, None), mode='hiba')
        if stopf.exists() or alerts:
            fails.append(f'plain error set STOP ({stopf.exists()}) or alerted ({len(alerts)})')
        case('ok answer that mentions 429 -> no STOP (control)', (0, None), mode='ok429')
        if stopf.exists() or alerts:
            fails.append('an ok answer mentioning 429 set STOP')
        case('STOP flag set -> every call refused', (5, 'stop'), stop=True)
        case('STOP flag is a folder -> refused, no traceback', (5, 'stop'), stop='dir')
        case('STOP flag refuses before the lock and the count', (5, 'stop'), sent(5), stop=True, holder=3)
        t = case('pause: last call 0 s ago, gap 2-2 s -> waits', (0, None), last=0,
                 env={'SEGED_SZUNET_MIN_S': '2', 'SEGED_SZUNET_MAX_S': '2'})
        if t < 1.5:
            fails.append(f'pause: returned after {t:.1f}s, gap was 2s')
        t = case('pause: last call 1 h ago -> no wait (control)', (0, None), last=3600,
                 env={'SEGED_SZUNET_MIN_S': '2', 'SEGED_SZUNET_MAX_S': '2'})
        if t > 1.5:
            fails.append(f'pause control: waited {t:.1f}s although the last call was 1 h ago')
        case('pause max < min stops the call', (2, None), env={'SEGED_SZUNET_MIN_S': '9', 'SEGED_SZUNET_MAX_S': '3'})
        same_ido = [dict(r, hivas_id=h) for r in sent(1) for h in ('a1', 'a2')]
        case('two calls sharing an ido still count twice (hivas_id)', (5, 'kvota'), sent(3) + same_ido)
        # Regression: 8 callers at once, queued on the lock, limit 5 -> exactly 5 go out. Their clock
        # is frozen for the first reading, so all 8 start in the same millisecond (else it is luck).
        case('parallel: setup', (0, None))
        log.write_text('')
        (td / 'hivasok').unlink(missing_ok=True)
        (td / 'ora').mkdir(exist_ok=True)
        (td / 'ora/sitecustomize.py').write_text(
            'import datetime as d\nclass F(d.datetime):\n    n = 0\n    @classmethod\n    def now(c, tz=None):\n'
            '        F.n += 1\n        t = super().now(tz)\n        return t.replace(hour=0, minute=0, second=1, microsecond=0) if F.n == 1 else t\n'
            'd.datetime = F\n')
        ps = [subprocess.Popen(cmd('teszt-a'), env={**env0, 'SEGED_ZAR_VAR_S': '60', 'PYTHONPATH': str(td / 'ora')},
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(8)]
        rcs = sorted(pr.wait() for pr in ps)
        stub_runs = len((td / 'hivasok').read_text().split()) if (td / 'hivasok').exists() else 0
        idos = [r['ido'] for r in calls_of(read_jsonl(log)) if r.get('status') != 'blocked']
        n += 1
        if rcs != [0] * 5 + [5] * 3 or stub_runs != 5 or len(set(idos)) != 5:
            fails.append(f'parallel 8, limit 5: exits {rcs}, helper ran {stub_runs}x, distinct ido {len(set(idos))}')
        ids = {}
        for r in read_jsonl(log):
            ids.setdefault(r.get('hivas_id'), []).append(r.get('status'))
        if None in ids or sorted(map(sorted, ids.values())) != [['blocked']] * 3 + [['ok', 'started']] * 5:
            fails.append(f'parallel: rows per hivas_id {sorted(map(sorted, ids.values()))}')
        waited = case('second call waits when zar_var_s allows', (0, None), holder=2, env={'SEGED_ZAR_VAR_S': '20'})
        if waited < 1.5:
            fails.append(f'waiting call returned after {waited:.1f}s, before the holder let go (2s)')
    srv.shutdown()
    for f in fails:
        print('FAIL kvota:', f)
    print(f'onteszt kvota: {n} cases, {len(fails)} failed')
    return len(fails)


def read_jsonl(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


# --- helper runs ------------------------------------------------------------------
def codex_tokens(out):
    m = re.findall(r'tokens used\s*\n\s*([\d,]+)', out)
    return int(m[-1].replace(',', '')) if m else None


def jail_cmd(engine, workdir):
    # Both engines run under bubblewrap: the whole $HOME is replaced by an empty read-only tmpfs (so a
    # write outside DIR fails loudly instead of vanishing into a scratch tmpfs), then only
    # ~/.local (the binaries, read-only), the engine's own state dir and DIR are mounted back; the
    # Windows drives (/mnt/c, /mnt/f ...) are hidden too. Measured 2026-10-03: agy's own --sandbox
    # does NOT stop writes outside the cwd, and codex's workspace-write stops writes but still READS
    # the Marveen store (and would read ~/.claude credentials). Not all of /mnt is hidden: on WSL
    # /etc/resolv.conf lives in /mnt/wsl, hiding it kills DNS.
    # /run is replaced too: /run/user/$UID holds the session D-Bus,
    # through which `systemd-run --user` started a command OUTSIDE the jail, and /run/WSL holds the
    # interop sockets that run Windows .exe files outside it. The environment is cleared (it carried the
    # messaging token, SSH/GPG agent sockets, TMUX), bwrap's own too (run_helper); a separate PID
    # namespace makes --die-with-parent take every descendant down with it, setsid'd ones included.
    drives = [p for p in Path('/mnt').glob('?') if p.is_dir() and not workdir.is_relative_to(p)]
    state = HOME / ('.codex' if engine == 'codex' else '.gemini')
    env = {'HOME': str(HOME), 'USER': os.environ.get('USER', HOME.name), 'LANG': 'C.UTF-8',
           'PATH': f'{HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin', 'TERM': 'dumb',
           'TZ': os.environ.get('TZ', 'Europe/Budapest')}
    jail = [BWRAP, '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
            '--tmpfs', '/run', *[x for p in drives for x in ('--tmpfs', str(p))],
            '--tmpfs', str(HOME), '--ro-bind', str(HOME / '.local'), str(HOME / '.local'),
            '--bind', str(state), str(state), '--bind', str(workdir), str(workdir),
            '--remount-ro', str(HOME), '--chdir', str(workdir),
            '--unshare-pid', '--unshare-ipc', '--new-session', '--clearenv',
            *[x for k, v in env.items() for x in ('--setenv', k, v)], '--die-with-parent']
    return jail


def run_helper(engine, model, workdir, prompt_text, timeout):
    jail = jail_cmd(engine, workdir)
    if engine == 'codex':
        cmd = jail + [BINS['codex'], 'exec', '-m', model, '-s', 'workspace-write', '-C', str(workdir),
                      '--skip-git-repo-check', '--color', 'never', '-']
        inp = prompt_text
    else:
        cmd = jail + [BINS['agy'], '-p', prompt_text, '--model', model, '--dangerously-skip-permissions',
                      '--output-format', 'json']
        inp = None
    t0 = time.monotonic()
    try:
        # --clearenv only clears the CHILD's environment; bwrap itself is PID 1 in the jail and its
        # /proc/1/environ is readable from inside, so bwrap must not inherit ours
        r = subprocess.run(cmd, cwd=workdir, input=inp, capture_output=True, text=True, timeout=timeout,
                           env={'PATH': '/usr/bin:/bin'})
        rc, out, err, status = r.returncode, r.stdout, r.stderr, 'ok' if r.returncode == 0 else 'error'
    except subprocess.TimeoutExpired as e:
        rc, status = None, 'timeout'
        out = e.stdout.decode(errors='replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
        err = e.stderr.decode(errors='replace') if isinstance(e.stderr, bytes) else (e.stderr or '')
    dur = round(time.monotonic() - t0, 1)
    shown_cmd = cmd if engine == 'codex' else [c if c != prompt_text else '<prompt>' for c in cmd]
    res = {'exit': rc, 'status': status, 'duracio_s': dur, 'tokens_total': None, 'usage': None,
           'valasz': '', 'cmd': ' '.join(shown_cmd)}
    if engine == 'codex':
        res['tokens_total'] = codex_tokens(err) or codex_tokens(out)
        res['valasz'] = out.strip()
    else:
        try:
            j = json.loads(out)
            res['usage'] = j.get('usage')
            res['tokens_total'] = (j.get('usage') or {}).get('total_tokens')
            res['valasz'] = j.get('response', '')
            if j.get('status') and j['status'] != 'SUCCESS' and status == 'ok':
                res['status'] = 'error'
        except json.JSONDecodeError:
            if status == 'ok':
                res['status'] = 'error'
            res['valasz'] = out.strip()
    return res, out, err


def append_log(row):
    STORE.mkdir(exist_ok=True)
    with open(LOG, 'a') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')


VERDICTS = ('elfogadva', 'javitva', 'eldobva')
AB_EVERY = 5
AGY_MAX_PROMPT = 100_000
TASK_TYPES = ('kod', 'kod-atnezes', 'szoveg', 'kep', 'weboldal', 'kutatas', 'adat', 'egyeb')


def quota_limits():
    """defaults < config file < env. Raises ValueError on anything that is not a non-negative int:
    a typo must stop the call, not lift the limit."""
    lim = dict(QUOTA_DEFAULTS)
    if QUOTA_FILE.exists():
        try:
            conf = json.loads(QUOTA_FILE.read_text())
        except ValueError as e:
            raise ValueError(f'{QUOTA_FILE}: not JSON ({e})')
        if not isinstance(conf, dict) or set(conf) - set(lim):
            raise ValueError(f'{QUOTA_FILE}: must be an object with keys {sorted(lim)} only')
        lim.update(conf)
    for k in lim:
        if os.environ.get('SEGED_' + k.upper()) is not None:
            lim[k] = os.environ['SEGED_' + k.upper()]
    for k, v in lim.items():
        if isinstance(v, str) and v.strip().isdigit():
            v = int(v)
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise ValueError(f'quota {k}={v!r}: must be a whole number >= 0')
        lim[k] = v
    if lim['szunet_max_s'] < lim['szunet_min_s']:
        raise ValueError(f"quota szunet_max_s={lim['szunet_max_s']} < szunet_min_s={lim['szunet_min_s']}")
    return lim


def pause(lim):
    """Under the lock: wait until a random gap has passed since the last call started or ended."""
    gap = random.uniform(lim['szunet_min_s'], lim['szunet_max_s'])
    try:
        left = gap - (time.time() - LAST_CALL.stat().st_mtime)
    except FileNotFoundError:
        left = 0
    if left > 0:
        print(f'[seged-hivo] pause {left:.1f}s (random {lim["szunet_min_s"]}-{lim["szunet_max_s"]}s gap between '
              'helper calls)', file=sys.stderr)
        time.sleep(left)
    return max(left, 0)


def mark_call():
    LAST_CALL.touch()
    os.utime(LAST_CALL)


def stop_problem():
    if not STOP.exists():
        return None
    try:  # unreadable (a folder, no permission) still refuses: the flag is there
        raw = STOP.read_text(errors='replace')
    except OSError as e:
        raw = f'unreadable: {type(e).__name__}'
    try:
        why = json.loads(raw)
    except ValueError:
        why = raw[:200]
    return (f'STOP flag {STOP} is set ({why}): a helper answered 403/429 (account refused or throttled). '
            'Nothing goes out until a human has checked the account and deleted that file.')


def alert_to():
    """Who gets the STOP alert: SEGED_RIASZT_CIMZETT, else the main agent (MAIN_AGENT_ID, env or .env), else 'marveen'."""
    who = os.environ.get('SEGED_RIASZT_CIMZETT') or os.environ.get('MAIN_AGENT_ID')
    if not who:
        try:  # only this one line of .env is read
            who = next((l.split('=', 1)[1].strip().strip('"\'') for l in (ROOT / '.env').read_text().splitlines()
                        if l.startswith('MAIN_AGENT_ID=')), None)
        except OSError:
            pass
    return who or 'marveen'


def set_stop(row, text):
    m = DENIED.search(text)
    info = {'ido': datetime.now().astimezone().isoformat(timespec='seconds'), 'hivas': row['ido'],
            'seged': row['seged'], 'modell': row['modell'], 'hivo': row['hivo'], 'minta': m.group(0)[:40]}
    STOP.write_text(json.dumps(info, ensure_ascii=False) + '\n')
    msg = (f"[seged-hivo] STOP: {row['seged']}:{row['modell']} answered '{info['minta']}' (403/429) on the call of "
           f"{row['hivo']} at {row['ido']}. Every helper call is refused until a human checks the account and "
           f"deletes {STOP}.")
    print(msg, file=sys.stderr)
    try:
        tok = (STORE / '.dashboard-token').read_text().strip()
        req = urllib.request.Request(ALERT_URL, method='POST', data=json.dumps(
            {'from': row['hivo'], 'to': alert_to(), 'content': msg}).encode(),
            headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # the flag file is the durable part; the alert is best effort
        print(f'[seged-hivo] alert to {alert_to()} failed ({type(e).__name__}); the STOP file is set anyway',
              file=sys.stderr)


def quota_problem(caller, engine, lim):
    """None if the call may go, else the reason. Counts today's calls that went out (not blocked)."""
    today = datetime.now().astimezone().date().isoformat()
    sent = [r for r in calls_of(read_log()) if r.get('status') != 'blocked' and str(r.get('ido', ''))[:10] == today]
    mine = sum(1 for r in sent if r.get('hivo') == caller)
    eng = sum(1 for r in sent if r.get('seged') == engine)
    if mine >= lim['hivo_nap']:
        return (f'daily quota: {caller} already made {mine} helper call(s) today (limit {lim["hivo_nap"]} per '
                'agent); do it yourself or wait until tomorrow')
    if eng >= lim[engine + '_nap']:
        return (f'daily quota: {engine} already got {eng} call(s) from the fleet today (limit '
                f'{lim[engine + "_nap"]}); use the other helper or do it yourself')
    return None


def take_lock(caller, wait_s):
    """Fleet-wide: one helper call at a time. Returns (fd, None) holding the lock, or (None, reason).
    flock is released by the kernel when the process dies, so a crashed call leaves no stale lock."""
    STORE.mkdir(exist_ok=True)
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    deadline = time.monotonic() + wait_s
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                holder = os.pread(fd, 300, 0).decode(errors='replace').strip() or 'unknown'
                os.close(fd)
                return None, (f'another helper call is running (one at a time in the fleet): {holder}; '
                              'try again later')
            time.sleep(0.5)
    os.ftruncate(fd, 0)
    os.pwrite(fd, json.dumps({'hivo': caller, 'pid': os.getpid(),
                              'ota': datetime.now().astimezone().isoformat(timespec='seconds')}).encode(), 0)
    return fd, None


def calls_of(rows):
    """Call rows (no ratings), one per call: a call writes a status=started row before the helper runs
    and its final row after; the last row of an ido wins. A started row alone = the process was killed."""
    last = {}
    for r in rows:  # key: hivas_id (one per process); older rows have only ido
        if r.get('tipus') != 'ertekeles':
            last[r.get('hivas_id') or r.get('ido')] = r
    return list(last.values())


def norm_caller(name):
    return _INVISIBLE.sub('', unicodedata.normalize('NFKC', name)).strip().lower()


def read_log(bad=None):
    """Rows of the log that are JSON objects; anything else (truncated line, [1,2], null) is skipped
    and counted in bad[0] when a counter is passed."""
    if not LOG.exists():
        return []
    rows = []
    for line in LOG.read_text(errors='replace').splitlines():  # one bad byte must not stop every call
        try:
            row = json.loads(line)
        except ValueError:
            row = None
        if isinstance(row, dict):
            rows.append(row)
        elif bad is not None and line.strip():
            bad[0] += 1
    return rows


def rate(call_id, verdict, score, opinion, caller):
    matches = [r for r in calls_of(read_log()) if r.get('ido') == call_id]
    if len(matches) != 1:
        print(f'{len(matches)} calls with ido={call_id} in {LOG}; need exactly one', file=sys.stderr)
        return 2
    call = matches[0]
    if call.get('status') != 'ok':
        print(f'call {call_id} has status={call.get("status")}; only ok calls are rated', file=sys.stderr)
        return 2
    append_log({'tipus': 'ertekeles', 'ido': datetime.now().astimezone().isoformat(timespec='seconds'),
                'hivas': call_id, 'seged': call['seged'], 'modell': call['modell'], 'kartya': call.get('kartya'),
                'feladattipus': call.get('feladattipus', 'ismeretlen'), 'ab': call.get('ab', False),
                'hivo': caller, 'eredmeny': verdict, 'pont': score, 'velemeny': opinion})
    print(f'rated {call_id} ({call["seged"]}:{call["modell"]}) = {verdict}, {score}/10 (Claude = 5)')
    return 0


def summary(since, as_json):
    nonobj = [0]
    rows = read_log(nonobj)
    # a row missing a key field or carrying a wrongly typed value is counted and skipped,
    # it must not take the whole summary down
    num = lambda v: v is None or (isinstance(v, (int, float)) and not isinstance(v, bool))
    need = lambda r: ('hivas', 'eredmeny') if r.get('tipus') == 'ertekeles' else ('ido', 'seged', 'modell', 'status')
    good = lambda r: (all(isinstance(r.get(k), str) for k in need(r))
                      and all(num(r.get(k)) for k in ('duracio_s', 'tokens_total', 'pont')))
    bad = nonobj[0] + sum(1 for r in rows if not good(r))
    rows = [r for r in rows if good(r)]
    calls = [r for r in calls_of(rows) if r['ido'][:10] >= since]
    ratings = {}
    for r in rows:  # the last rating of a call wins
        if r.get('tipus') == 'ertekeles':
            ratings[r['hivas']] = r
    out, by_type = {}, {}
    for c in calls:
        helper = f"{c['seged']}:{c['modell']}"
        g = out.setdefault(helper, {
            'hivas': 0, 'ok': 0, 'error': 0, 'blocked': 0, 'timeout': 0, 'ab': 0, 'duracio_s': [], 'tokens': [],
            'pontok': [], **{v: 0 for v in VERDICTS}, 'ertekeletlen': 0})
        rated = ratings.get(c['ido'])
        if c['status'] == 'ok':
            t = by_type.setdefault(f"{c.get('feladattipus', 'ismeretlen')} / {helper}",
                                   {'ok': 0, 'pontok': [], 'javitva': 0, 'eldobva': 0})
            t['ok'] += 1
            if rated:
                if rated.get('pont') is not None:
                    t['pontok'].append(rated['pont'])
                if rated['eredmeny'] in ('javitva', 'eldobva'):
                    t[rated['eredmeny']] += 1
        g['hivas'] += 1
        g['ab'] += bool(c.get('ab'))
        g[c['status'] if c['status'] in ('ok', 'error', 'blocked', 'timeout') else 'error'] += 1
        if c['status'] == 'ok':
            g['duracio_s'].append(c.get('duracio_s') or 0)
            if c.get('tokens_total') is not None:
                g['tokens'].append(c['tokens_total'])
            g[rated['eredmeny'] if rated else 'ertekeletlen'] += 1
            if rated and rated.get('pont') is not None:
                g['pontok'].append(rated['pont'])
    avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    for g in list(out.values()) + list(by_type.values()):
        g['pont_atlag'] = avg(g.pop('pontok'))
    for g in out.values():
        d, t = sorted(g.pop('duracio_s')), g.pop('tokens')
        g['median_s'] = (d[len(d) // 2] if len(d) % 2 else round((d[len(d) // 2 - 1] + d[len(d) // 2]) / 2, 2)) if d else None
        g['tokens_osszes'] = sum(t)
        g['tokens_atlag'] = round(sum(t) / len(t)) if t else None
    if as_json:
        print(json.dumps({'tol': since, 'segedek': out, 'feladattipusonkent': by_type, 'hibas_sor': bad},
                         ensure_ascii=False, indent=1))
        return 0
    dash = lambda v: '-' if v is None else v
    pct = lambda n, d: f'{100 * n / d:.0f}%' if d else '-'
    print(f'seged-hivo summary since {since}: {len(calls)} calls, log {LOG}')
    print(f"{'helper:model':34} {'calls':>5} {'ok':>5} {'err':>5} {'blk':>5} {'t/o':>4} {'med s':>6} "
          f"{'avg tok':>8} | {'as is':>5} {'fixed':>5} {'drop':>5} {'unrated':>7} {'score':>5} {'A/B':>4}")
    for k, g in sorted(out.items()):
        print(f"{k:34} {g['hivas']:>5} {pct(g['ok'], g['hivas']):>5} {pct(g['error'], g['hivas']):>5} "
              f"{pct(g['blocked'], g['hivas']):>5} {g['timeout']:>4} {g['median_s'] if g['median_s'] is not None else '-':>6} "
              f"{g['tokens_atlag'] if g['tokens_atlag'] is not None else '-':>8} | {g['elfogadva']:>5} "
              f"{g['javitva']:>5} {g['eldobva']:>5} {g['ertekeletlen']:>7} {dash(g['pont_atlag']):>5} {g['ab']:>4}")
    if by_type:
        print(f"\n{'task type / helper:model':46} {'ok':>4} {'score':>6} {'fixed':>6} {'drop':>5}")
        for k, t in sorted(by_type.items()):
            print(f"{k:46} {t['ok']:>4} {dash(t['pont_atlag']):>6} {t['javitva']:>6} {t['eldobva']:>5}")
    if bad:
        print(f'\n{bad} malformed log row(s) skipped (not an object, missing key field or wrong type)')
    print('\nas is/fixed/drop = how the calling specialist judged the ok results (--ertekel); fixed and drop'
          ' mean Claude work was still needed. score = average 1-10, Claude = 5.')
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--seged', help='codex:<model> | agy:<model>')
    ap.add_argument('--mappa', help='work folder; the helper may only work here')
    ap.add_argument('--prompt', help='prompt file')
    ap.add_argument('--hivo', help='calling agent, e.g. my-agent')
    ap.add_argument('--kartya', help='kanban card / task id (goes into the log)')
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--onteszt', action='store_true')
    ap.add_argument('--ertekel', metavar='CALL_ID', help='rate an ok call (its "ido" value)')
    ap.add_argument('--eredmeny', choices=VERDICTS)
    ap.add_argument('--pont', type=int, choices=range(1, 11), metavar='1-10', help='1-10, Claude = 5')
    ap.add_argument('--velemeny', help='at most 2 sentences: what was it good or weak at')
    ap.add_argument('--feladattipus', choices=TASK_TYPES)
    ap.add_argument('--osszesito', action='store_true', help='reliability summary per helper')
    ap.add_argument('--tol', default='0000-00-00', help='summary from this date (YYYY-MM-DD)')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    if a.onteszt:
        return selftest()
    if a.osszesito:
        return summary(a.tol, a.json)
    if a.ertekel:
        if not (a.eredmeny and a.pont and a.velemeny and a.hivo):
            ap.error('--ertekel needs --eredmeny, --pont, --velemeny and --hivo')
        if len(re.findall(r'[.!?](?:\s|$)', a.velemeny.strip() + ' ')) > 2:
            ap.error('--velemeny: at most 2 sentences')
        return rate(a.ertekel, a.eredmeny, a.pont, a.velemeny.strip(), a.hivo)
    missing = [n for n in ('seged', 'mappa', 'prompt', 'hivo', 'kartya', 'feladattipus') if not getattr(a, n)]
    if missing:
        ap.error('missing: ' + ', '.join('--' + n for n in missing))
    engine, _, model = a.seged.partition(':')
    if engine not in BINS or not model:
        ap.error('--seged must be codex:<model> or agy:<model>')
    workdir, prompt = Path(a.mappa).resolve(), Path(a.prompt).resolve()
    if not workdir.is_dir():
        ap.error(f'--mappa is not a folder: {workdir}')
    if not prompt.is_file():
        ap.error(f'--prompt is not a file: {prompt}')
    # The folder must be a dedicated one, strictly below a helper base (default ~/seged-munka). An
    # allowlist, not a denylist: a denylist once let two store/ subfolders through. The Marveen repo
    # and credential dirs stay forbidden even if a base is set wide by mistake.
    bases = [Path(b).expanduser().resolve() for b in SEGED_BASE.split(':') if b]
    secret = [ROOT, *(HOME / d for d in ('.claude', '.codex', '.gemini', '.ssh', '.gnupg', '.local', '.config'))]
    if not any(workdir != b and workdir.is_relative_to(b) for b in bases) \
            or any(workdir.is_relative_to(x) or x.is_relative_to(workdir) for x in secret):
        ap.error(f'--mappa must be a subfolder of {SEGED_BASE} (SEGED_BASE), outside the Marveen repo '
                 f'and credential folders: {workdir}')

    try:
        lim = quota_limits()
    except ValueError as e:
        ap.error(str(e))
    # the per-agent count keys on --hivo: "My-Agent " or a typo must not open a fresh count of 5
    a.hivo = norm_caller(a.hivo)
    agents = ROOT / 'agents'
    if agents.is_dir():
        known = sorted(d.name for d in agents.iterdir() if d.is_dir() and not d.name.startswith(('_', '.')))
        if a.hivo not in known:
            ap.error(f'--hivo {a.hivo!r} is not an agent folder under {agents}: {" ".join(known)}')
    prompt_text = prompt.read_text()
    now = datetime.now().astimezone()
    # milliseconds: ido is the CALL_ID for --ertekel, two calls in the same second must differ
    row = {'ido': now.isoformat(timespec='milliseconds'), 'hivas_id': uuid.uuid4().hex, 'hivo': a.hivo, 'kartya': a.kartya,
           'seged': engine, 'modell': model, 'mappa': str(workdir), 'prompt_fajl': str(prompt),
           'prompt_sha256': hashlib.sha256(prompt_text.encode()).hexdigest()[:16], 'feladattipus': a.feladattipus}

    # the lock is taken BEFORE counting: two callers must not both see "4 of 5" and both go.
    # It stays held (lock_fd open) until the process exits, i.e. through the helper run.
    why = stop_problem()
    blokk = 'stop' if why else None
    if not why:
        lock_fd, why = take_lock(a.hivo, lim['zar_var_s'])
        blokk = 'zar' if why else None
    if not why:
        # ido again, under the lock: callers started in the same millisecond and queued on zar_var_s
        # would otherwise share the CALL_ID (parallel starts merged, quota overrun). A call
        # that goes out holds the lock for its whole helper run, so no later call gets its millisecond.
        now = datetime.now().astimezone()  # also names the raw output file
        row['ido'] = now.isoformat(timespec='milliseconds')
        why = quota_problem(a.hivo, engine, lim)
        blokk = 'kvota' if why else None
    if why:
        row.update(status='blocked', blokk=blokk, exit=None, okok=[why], atnezett_fajl=0)
        append_log(row)
        print(f'BLOCKED ({blokk}): nothing sent to {engine}: {why}', file=sys.stderr)
        return 5

    problems, scanned = run_gate(prompt, workdir)
    if engine == 'agy' and len(prompt_text.encode()) > AGY_MAX_PROMPT:
        problems.append(f'{prompt}: {len(prompt_text.encode())} B, agy takes the prompt on the command line '
                        f'(limit {AGY_MAX_PROMPT} B here, the OS refuses ~200 KB): put the material in DIR and '
                        'point the brief at it')
    if problems:
        row.update(status='blocked', blokk='kapu', exit=None, okok=problems[:20], atnezett_fajl=scanned)
        append_log(row)
        print(f'BLOCKED: nothing sent to {engine} ({scanned} files scanned):',
              file=sys.stderr)
        for p in problems[:20]:
            print('  ' + p, file=sys.stderr)
        return 3

    # blind A/B: every AB_EVERY-th call that actually went out (blocked calls do not count)
    sent = sum(1 for r in calls_of(read_log()) if r.get('status') != 'blocked')
    row['ab'] = (sent + 1) % AB_EVERY == 0
    if row['ab']:
        print(f'[seged-hivo] A/B-MARKED call (every {AB_EVERY}th): keep the helper result unchanged in DIR; '
              'a reviewer scores it blind against a Claude result.', file=sys.stderr)
    # counted even if this process is killed while the helper runs (SIGKILL leaves no except branch)
    pause(lim)
    append_log({**row, 'status': 'started', 'exit': None, 'atnezett_fajl': scanned})
    mark_call()
    try:
        res, out, err = run_helper(engine, model, workdir, prompt_text, a.timeout)
    except Exception as e:  # a crash still gets its final row; a kill keeps the started row
        row.update(status='error', exit=None, okok=[f'{type(e).__name__}: {e}'[:400]], atnezett_fajl=scanned)
        append_log(row)
        raise
    finally:
        mark_call()
    if res['status'] != 'ok' and DENIED.search(out + '\n' + err):
        set_stop(row, out + '\n' + err)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    raw = RAW_DIR / f"{now.strftime('%Y%m%d-%H%M%S-%f')[:-3]}-{engine}-{a.kartya}.log"
    raw.write_text(f"$ {res['cmd']}\n--- stdout\n{out}\n--- stderr\n{err}")
    row.update({k: res[k] for k in ('status', 'exit', 'duracio_s', 'tokens_total', 'usage')},
               atnezett_fajl=scanned, nyers_kimenet=str(raw))
    append_log(row)
    print(res['valasz'])
    print(f"[seged-hivo] {engine}:{model} status={res['status']} exit={res['exit']} "
          f"tokens={res['tokens_total']} {res['duracio_s']}s log={raw}", file=sys.stderr)
    if res['status'] == 'ok':
        print(f"[seged-hivo] after review, rate it: --ertekel {row['ido']} --eredmeny elfogadva|javitva|eldobva "
              f"--pont 1-10 --velemeny '<max 2 sentences>' --hivo {a.hivo}", file=sys.stderr)
    return {'ok': 0, 'timeout': 4}.get(res['status'], 1)


if __name__ == '__main__':
    sys.exit(main())
