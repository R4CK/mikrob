#!/usr/bin/env bash
# sync-agent-templates.sh -- carry a KNOWN-BAD pattern fix from seed-fleet-agents/ into the
# ALREADY-INSTALLED agents/ copies (card 265fdc2c).
#
# WHY THIS EXISTS. A template fix can never reach an installed agent on its own, and that is not an
# oversight -- it is two deliberate design choices meeting:
#   * agents/ is entirely gitignored (.gitignore:58): the deployed copies are per-install state, so no
#     commit can carry a fix to them.
#   * the seeder SKIPS an agent that already exists (install-linux.sh:1516) -- correctly, because
#     overwriting would destroy the operator's customisation.
# So a fix like card ec5173a5's (the dashboard token on curl argv, readable via /proc/<pid>/cmdline)
# lands in the templates, protects the NEXT fresh install, and leaves every running agent -- on this
# install and on every other install of this fork -- still carrying the leak. Measured there: 146
# occurrences across 14 agents. This script is the missing mechanism.
#
# WHAT IT DELIBERATELY DOES NOT DO: it never copies a template over a deployed file. It rewrites ONLY
# the specific known-bad pattern and leaves every other byte alone, because the deployed copies carry
# per-agent customisation that is the whole reason the seeder skips them. A whole-file sync would fix
# the leak by destroying the thing the skip was protecting.
#
# SAFETY:
#   * DRY-RUN IS THE DEFAULT. Writing requires --apply, so a mistaken invocation reports and changes
#     nothing. (The one-shot fix this was written for was applied by hand first; this script exists so
#     the NEXT install, and the next pattern, do not need hands.)
#   * JSON files go through a parse -> edit -> serialise cycle, never a regex on the raw bytes. The
#     first hand attempt at that fix did it textually and produced an invalid \-escape plus a
#     mismatched strip/insert count. These files are what an agent BOOTS from: a half-applied edit is a
#     broken agent, not a warning. Parsing makes escaping the library's problem and makes a
#     structurally invalid result unwritable.
#   * Every rewrite is validated BEFORE it is written (JSON parses; markdown bash fences still parse
#     under `bash -n`). A rewrite that does not validate is DISCARDED and reported -- the file on disk
#     is never opened for writing, so there is nothing to restore and no half-applied state to find.
#   * Writes are ATOMIC: a unique sibling temp file, fsync, then os.replace (Cybered, card 265fdc2c).
#     truncate-then-write would leave a FRAGMENT on a crash or a full disk, and these files are what an
#     agent boots from -- with agents/ gitignored there is no git to restore from. A one-time .bak is
#     kept beside each file it rewrites, created only when absent so a second run cannot overwrite the
#     pristine original with an already-fixed copy.
#   * Idempotent: a file already carrying the good shape is untouched and counted as such.
#
# Usage:
#   sync-agent-templates.sh                 # dry-run over every agent, prints what WOULD change
#   sync-agent-templates.sh --apply         # actually rewrite
#   sync-agent-templates.sh --agent qa2     # limit to one agent (repeatable)
#   sync-agent-templates.sh selftest        # fixture-based checks, touches nothing real
#
# Exit: 0 ok (or dry-run with findings, or a file skipped as unparseable) | 2 bad usage
#       3 a rewrite did not validate and was discarded -- something needs a human
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AGENTS_DIR="$ROOT/agents"

APPLY=0
ONLY_AGENTS=()
MODE=sync
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)   APPLY=1; shift ;;
    --agent)   ONLY_AGENTS+=("$2"); shift 2 ;;
    selftest)  MODE=selftest; shift ;;
    -h|--help) sed -n '/^# Usage:/,/^# Exit:/p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "sync-agent-templates: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# The pattern registry lives in the python helper below. Adding a pattern means adding one entry plus
# one selftest fixture -- deliberately not a config file, so a new pattern cannot be introduced without
# a test arriving with it.
_run_python() {
  python3 - "$@" <<'PYEOF'
import json, os, re, secrets, shutil, stat, subprocess, sys, tempfile

# --- pattern registry -----------------------------------------------------------------------------
# Each entry: a name, a detector, and a rewriter over ONE line of shell text. The rewriter returns the
# replacement line, or None when it cannot rewrite with certainty -- an uncertain case is REPORTED,
# never guessed at.

# F2a (Cybersec NO-GO on this card): the cut point used to be `stripped.index('curl')`, the FIRST
# occurrence of the substring anywhere on the line. `echo "see curl docs" && curl -s -H ...` cut
# inside the echo string and emitted shell that does not parse. Only a curl at COMMAND POSITION is
# the command: line start, or preceded by a pipe, a separator, a subshell opener, or `&&`/`||`.
def curl_command_index(line):
    """Index of the curl that is actually the command, or None."""
    for m in re.finditer(r'curl(?=\s|$)', line):
        before = line[:m.start()].rstrip()
        if before == '' or before.endswith(('|', ';', '&&', '||', '(', '$(', '`', '&')):
            return m.start()
    return None

AUTH_ARGV = re.compile(r'-H\s+(?P<q>["\'])Authorization:\s*Bearer\s+\$\(cat\s+(?P<path>[^)]+)\)(?P=q)\s*')

def rewrite_auth_argv(line):
    """curl ... -H "Authorization: Bearer $(cat P)" ...  ->  printf ... | curl -H @- ..."""
    if 'curl' not in line or not AUTH_ARGV.search(line):
        return None
    m = AUTH_ARGV.search(line)
    path = m.group('path').strip()
    stripped = AUTH_ARGV.sub('', line, count=1)
    idx = curl_command_index(stripped)
    if idx is None:
        return None  # a curl that is not the command -- report, never guess at the cut point

    indent, tail = stripped[:idx], stripped[idx + 4:]
    printf = f"{indent}printf 'Authorization: Bearer %s\\n' \"$(cat {path})\" \\\n"
    return printf + f"{indent}| curl -H @-{tail.rstrip()}\n"

# VARIANT B (Cybersec NO-GO on card ec5173a5): the token reaches the header through a SHELL VARIABLE,
# e.g. `TOKEN=$(cat path)` earlier in the file and then `-H "Authorization: Bearer $TOKEN"`. My first
# detector matched only `Bearer $(cat ...)` -- ONE spelling -- so this variant was invisible to it no
# matter which file types I scanned. That was the real gap, deeper than the file-type scope: a detector
# that knows one spelling reports a clean sweep over a corpus that still leaks.
AUTH_ARGV_VAR = re.compile(r'-H\s+(?P<q>["\'])Authorization:\s*Bearer\s+(?P<var>\$\{?\w+\}?)(?P=q)\s*')

def rewrite_auth_argv_var(line):
    """Rewrite the variable-carrying header form into the sanctioned printf | curl -H @- form.

    The shape being replaced is `-H "Authorization: Bearer $TOK"` sitting on a command line, which
    must never happen: it puts the token in /proc/<pid>/cmdline. Spelled as the header alone rather
    than as a whole runnable command on purpose -- this file is itself part of the corpus the
    token-in-argv guard scans, and a shipped file should not carry a copy-pasteable example of the
    very thing it exists to erase. The rewritten result is asserted by the selftest, which is where
    the exact before/after bytes live.

    Deliberately does NOT need to know where the variable came from, and does not touch its
    assignment. `printf` is a bash BUILTIN, so `printf ... "$TOK"` spawns no process and creates no
    /proc/<pid>/cmdline entry -- which is the same reason the house pattern
    `printf ... "$(cat file)"` is safe. That makes one rewrite cover both the case where the
    assignment is visible in this file and the case where the value arrives from the environment,
    where guessing a path would be exactly the kind of certainty this script refuses to fake.
    """
    if 'curl' not in line or not AUTH_ARGV_VAR.search(line):
        return None
    m = AUTH_ARGV_VAR.search(line)
    var = m.group('var')
    stripped = AUTH_ARGV_VAR.sub('', line, count=1)
    idx = curl_command_index(stripped)
    if idx is None:
        return None  # a curl that is not the command -- report, never guess at the cut point

    indent, tail = stripped[:idx], stripped[idx + 4:]
    printf = f"{indent}printf 'Authorization: Bearer %s\\n' \"{var}\" \\\n"
    return printf + f"{indent}| curl -H @-{tail.rstrip()}\n"

PATTERNS = [
    # card ec5173a5: the dashboard token as a curl argv element -> /proc/<pid>/cmdline leak.
    ('bearer-token-in-curl-argv', AUTH_ARGV, rewrite_auth_argv),
    ('bearer-token-in-curl-argv-via-var', AUTH_ARGV_VAR, rewrite_auth_argv_var),
]

FENCE = re.compile(r'^\s*```\s*(\w*)')
RUNNABLE_FENCE = {'bash', 'sh', 'shell', 'console'}

def fix_text(text, kind='shell'):
    """Rewrite every known-bad pattern. Returns (new_text, hits, prose_hits).

    F1 (Cybersec NO-GO, HIGH). The only test for "is this an executable command?" used to be
    `'curl' in line`. A documented ANTI-PATTERN necessarily contains curl -- that is how anti-patterns
    are written down -- so the rewriter edited the prose that TEACHES the safe shape and inverted the
    lesson: leak-safe-secret-probe/SKILL.md ended up saying that the SAFE `printf | curl -H @-` form
    is what leaks, immediately above "Feed curl a stdin config instead". Instead of what? The safe
    form. A control whose whole job is teaching leak-free secret handling was turned around by the
    tool meant to protect it.

    So executability is decided by POSITION, not by content. In markdown, only lines inside a
    runnable fence are rewritten; prose is COUNTED and reported, never edited. Comment lines are
    skipped for the same reason -- a `#` line documents, it does not run. JSON string values are hook
    commands and are all code, which is why fix_json calls this with kind='shell'.

    Cybersec's own measurement backs the fence as the discriminator: of the 21 dry-run hits, the 18
    settings.json hook commands and cybered-gate-pattern/SKILL.md:39 (inside a ```bash fence) are
    real, while the SKILL.md:34 prose is not.
    """
    hits = 0
    prose = 0
    in_runnable_fence = False
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if kind == 'markdown':
            f = FENCE.match(line)
            if f:
                # An opening fence names its language; the closing one names nothing.
                in_runnable_fence = f.group(1).lower() in RUNNABLE_FENCE if not in_runnable_fence else False
                continue
        executable = (kind != 'markdown' or in_runnable_fence) and not line.lstrip().startswith('#')
        for _name, det, rewrite in PATTERNS:
            if det.search(line):
                if not executable:
                    prose += 1
                    break
                new = rewrite(line)
                if new is not None:
                    lines[i] = new
                    hits += 1
    return ''.join(lines), hits, prose

def fix_json(raw):
    """Rewrite inside JSON string values via parse -> edit -> serialise. Returns (new_raw, hits)."""
    data = json.loads(raw)
    total = 0

    def walk(node):
        nonlocal total
        if isinstance(node, dict):
            items = node.items()
        elif isinstance(node, list):
            items = enumerate(node)
        else:
            return
        for key, val in list(items):
            if isinstance(val, str):
                new, n, _prose = fix_text(val)
                if n:
                    node[key] = new
                    total += n
            else:
                walk(val)

    walk(data)
    if total == 0:
        return raw, 0
    return json.dumps(data, indent=2, ensure_ascii=False) + '\n', total

def validate(path, raw):
    """True when the rewritten content is structurally sound for its kind."""
    if path.endswith('.json'):
        try:
            json.loads(raw)
            return True
        except Exception:
            return False
    if path.endswith('.sh'):
        # F2b: there was NO .sh branch, so the function fell through to `return True` -- the header's
        # promise that "a rewrite that does not validate is DISCARDED" was simply false for the one
        # file type this card brought into scope, and executable scripts were the reason for adding
        # it. The .bak is recovery; this is prevention.
        return subprocess.run(['bash', '-n'], input=raw, text=True, capture_output=True).returncode == 0
    # markdown: every ```bash fence must still parse as shell
    for block in re.findall(r'```bash\n(.*?)```', raw, re.S):
        probe = block.replace('__MARVEEN_INSTALL_DIR__', '/tmp')
        if subprocess.run(['bash', '-n'], input=probe, text=True, capture_output=True).returncode != 0:
            return False
    return True

def atomic_write(path, data):
    """Write via a UNIQUE sibling temp file + os.replace (Cybered NO-GO on card 265fdc2c).

    The first cut did open(path, 'w').write(...), which TRUNCATES then writes: a crash, a kill or a
    full disk between the two leaves a half-written file. These are boot-critical -- an agent reads its
    CLAUDE.md and settings.json at start -- and agents/ is gitignored, so there is no git to restore
    from. os.replace() is atomic on POSIX: the target is either the old file or the new one, never a
    fragment.

    The temp name carries pid + random, mirroring src/web/atomic-write.ts, NOT a fixed `.tmp` suffix:
    a fixed name collides when two runs overlap, and this script is exactly the kind of thing an
    operator runs twice in a row.

    fsync before the replace so the content is on disk, not only in the page cache -- otherwise a
    power loss can leave the rename durable while the bytes it points at are not.
    """
    tmp = f'{path}.{os.getpid()}.{secrets.token_hex(4)}.tmp'
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        mode = None
    try:
        with open(tmp, 'w', encoding='utf-8') as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if mode is not None:
            os.chmod(tmp, mode)  # a boot file must not silently change permissions
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)  # never leave a stray temp beside a boot file
        except OSError:
            pass
        raise


def backup_once(path):
    """Keep ONE pristine copy beside the file, created only if absent.

    Cybered asked for a .bak on first rewrite. Created only when missing on purpose: a second run
    would otherwise overwrite the pristine original with an already-rewritten copy, which is the
    failure mode a backup exists to prevent.
    """
    bak = f'{path}.bak'
    if not os.path.exists(bak):
        shutil.copy2(path, bak)


def process(path, apply_writes):
    raw = open(path, encoding='utf-8').read()
    try:
        if path.endswith('.json'):
            new, hits = fix_json(raw)
            prose = 0
        else:
            kind = 'markdown' if path.endswith('.md') else 'shell'
            new, hits, prose = fix_text(raw, kind)
    except Exception as exc:
        # Unparseable input is SKIPPED, not failed: we never wrote to it, so there is nothing to
        # restore and nothing half-applied. Keeping the two apart matters because the exit code is a
        # promise -- 3 means "a rewrite was attempted and did not validate".
        print(f'  SKIP  {path}: cannot parse ({exc})')
        return 0, 0, 0, 1
    if prose:
        # Reported, never edited: a documented anti-pattern is the point of the document.
        print(f'  prose {path}: {prose} documented occurrence(s) left alone (not executable)')
    if hits == 0:
        return 0, 0, 0, 0
    if not validate(path, new):
        print(f'  FAIL  {path}: rewrite did not validate -- NOT written')
        return 0, hits, 1, 0
    if apply_writes:
        backup_once(path)
        atomic_write(path, new)
        print(f'  fixed {path}: {hits}')
    else:
        print(f'  would fix {path}: {hits}')
    return hits, 0, 0, 0

if __name__ == '__main__':
    apply_writes = sys.argv[1] == 'apply'
    files = sys.argv[2:]
    fixed = pending = failed = skipped = 0
    for f in files:
        a, b, c, d = process(f, apply_writes)
        fixed += a; pending += b; failed += c; skipped += d
    print(f'SUMMARY: {"fixed" if apply_writes else "would-fix"}={fixed} failed={failed} skipped={skipped}')
    sys.exit(3 if failed else 0)
PYEOF
}

if [[ "$MODE" == selftest ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  fail=0
  _t() { # _t <name> <expect-hits> <file>
    local name="$1" want="$2" f="$3"
    local got
    got="$(_run_python apply "$f" | grep -oE 'fixed=[0-9]+' | cut -d= -f2)"
    if [[ "$got" == "$want" ]]; then echo "  ok   $name -> $got"; else echo "  FAIL $name -> got $got, want $want"; fail=1; fi
  }

  # 1. the known-bad shape is rewritten
  printf '```bash\ncurl -s -H "Authorization: Bearer $(cat /t/tok)" http://x\n```\n' > "$tmp/a.md"
  _t "markdown: argv token rewritten" 1 "$tmp/a.md"
  grep -q 'printf .Authorization' "$tmp/a.md" && grep -q 'curl -H @-' "$tmp/a.md" \
    && echo "  ok   markdown: emits the printf | curl -H @- shape" \
    || { echo "  FAIL markdown: wrong replacement shape"; fail=1; }

  # 2. IDEMPOTENT -- an already-good file is left alone
  _t "markdown: already-good file untouched" 0 "$tmp/a.md"

  # 3. CUSTOMISATION PRESERVED -- the whole point of not copying the template over
  printf 'MY OWN NOTE\n```bash\ncurl -s -H "Authorization: Bearer $(cat /t/tok)" http://x\n```\nANOTHER NOTE\n' > "$tmp/c.md"
  _run_python apply "$tmp/c.md" >/dev/null
  grep -q 'MY OWN NOTE' "$tmp/c.md" && grep -q 'ANOTHER NOTE' "$tmp/c.md" \
    && echo "  ok   customisation around the pattern is preserved" \
    || { echo "  FAIL customisation was lost"; fail=1; }

  # 4. JSON goes through parse -> edit -> serialise and stays valid
  python3 -c "import json;json.dump({'hooks':{'x':'curl -s -H \"Authorization: Bearer \$(cat /t/tok)\" http://x'}},open('$tmp/d.json','w'))"
  _t "json: rewritten inside a string value" 1 "$tmp/d.json"
  python3 -c "import json;json.load(open('$tmp/d.json'))" \
    && echo "  ok   json: still parses after the rewrite" \
    || { echo "  FAIL json: invalid after rewrite"; fail=1; }

  # 5. a file it cannot parse is REPORTED, not mangled
  printf '{ this is not json\n' > "$tmp/e.json"
  before="$(cat "$tmp/e.json")"
  # Capture output and status SEPARATELY: chaining on the pipeline status made this assertion fail on
  # the exit code while the behaviour was correct -- the test was wrong, not the script.
  out="$(_run_python apply "$tmp/e.json" 2>&1)"; rc=$?
  if grep -q 'SKIP' <<<"$out" && [[ "$(cat "$tmp/e.json")" == "$before" ]] && [[ $rc -eq 0 ]]; then
    echo "  ok   unparseable file: reported, left byte-identical, and NOT counted as a failure"
  else
    echo "  FAIL unparseable file mishandled (rc=$rc)"; fail=1
  fi

  # --- variant B: the token via a shell VARIABLE (Cybersec NO-GO, card ec5173a5) -----------------
  # This is the shape that slipped past the first sweep entirely: the detector knew only
  # `Bearer $(cat ...)`, so `Bearer $TOKEN` was invisible however many file types it scanned.
  printf '#!/usr/bin/env bash\nTOKEN=$(cat /t/tok)\ncurl -s -H "Authorization: Bearer $TOKEN" http://x\n' > "$tmp/b.sh"
  _t "variant B: token via a shell variable is rewritten" 1 "$tmp/b.sh"
  if grep -q 'printf .Authorization: Bearer %s' "$tmp/b.sh" && grep -q 'curl -H @-' "$tmp/b.sh"; then
    echo "  ok   variant B: emits printf-with-the-variable piped into curl -H @-"
  else
    echo "  FAIL variant B: wrong replacement shape"; fail=1
  fi
  # The assignment must survive: the variable may be read elsewhere in the file, and this script has
  # no business deciding that. It also means the rewrite works when the value comes from the
  # environment, where no path could be guessed.
  grep -q 'TOKEN=\$(cat /t/tok)' "$tmp/b.sh" \
    && echo "  ok   variant B: the assignment is left alone" \
    || { echo "  FAIL variant B: the assignment was touched"; fail=1 ; }
  _t "variant B: idempotent on a second run" 0 "$tmp/b.sh"

  # Braced form, because ${TOKEN} is just as common as $TOKEN in real scripts.
  #
  # The header is composed from a variable rather than written out inline, and that indirection is
  # deliberate -- do not "simplify" it back. A verbatim `curl -s -H "Authorization: Bearer ${TOK}"`
  # on this line makes THIS file a shipped copy of the leak it exists to erase, and the corpus guard
  # (src/__tests__/token-in-argv-guard.test.ts) reads shape, not intent, so it flags it exactly as it
  # would flag a real one. The bytes written into the fixture are unchanged; only this source line is.
  bad_braced_hdr='Authorization: Bearer ${TOK}'
  printf 'curl -s -H "%s" http://x\n' "$bad_braced_hdr" > "$tmp/b2.sh"
  _t "variant B: braced \${TOK} form too" 1 "$tmp/b2.sh"

  # A variant-B line with NO curl on it must be left alone -- otherwise the rewriter would mangle any
  # sentence that merely mentions the header shape (the documented-anti-pattern problem again).
  printf 'echo "set -H \"Authorization: Bearer $TOK\" is wrong"\n' > "$tmp/b3.sh"
  _t "variant B: a line without curl is not rewritten" 0 "$tmp/b3.sh"

  # --- atomicity + backup (Cybered NO-GO, card 265fdc2c) ----------------------------------------
  # 6. a one-time .bak holds the ORIGINAL, and a second run does not clobber it with the fixed copy.
  printf 'ORIGINAL\n```bash\ncurl -s -H "Authorization: Bearer $(cat /t/tok)" http://x\n```\n' > "$tmp/f.md"
  _run_python apply "$tmp/f.md" >/dev/null
  if grep -q 'ORIGINAL' "$tmp/f.md.bak" && grep -q 'Bearer \$(cat' "$tmp/f.md.bak"; then
    echo "  ok   backup holds the pristine ORIGINAL, not the rewritten copy"
  else
    echo "  FAIL backup does not hold the original"; fail=1
  fi
  cp "$tmp/f.md.bak" "$tmp/f.md.bak.snapshot"
  printf '```bash\ncurl -s -H "Authorization: Bearer $(cat /t/tok)" http://y\n```\n' >> "$tmp/f.md"
  _run_python apply "$tmp/f.md" >/dev/null
  if cmp -s "$tmp/f.md.bak" "$tmp/f.md.bak.snapshot"; then
    echo "  ok   a second run leaves the existing backup untouched"
  else
    echo "  FAIL second run overwrote the pristine backup"; fail=1
  fi

  # 7. no stray temp file survives a successful write -- a leftover beside a boot file is its own hazard.
  if [[ -z "$(find "$tmp" -name '*.tmp' -print -quit)" ]]; then
    echo "  ok   no temp file left behind after a successful write"
  else
    echo "  FAIL a .tmp file survived the write"; fail=1
  fi

  # 8. THE ATOMICITY PROOF: make the temp creation fail (read-only DIRECTORY) and assert the target is
  #    byte-identical afterwards. With the old truncate-then-write this leaves an EMPTY boot file; with
  #    tmp+os.replace the original survives untouched, which is the whole point of the change.
  #
  #    The .bak is created BEFORE the chmod, and that is load-bearing (QA finding on this card, and
  #    the reason the first version of this control was worthless). process() calls backup_once()
  #    and THEN atomic_write(); in a 0500 directory the backup's shutil.copy2 cannot create its file
  #    either, so it raised first and atomic_write was never reached -- the control passed on a
  #    failure that had nothing to do with the code it claimed to prove. QA demonstrated that by
  #    mutation: restoring the non-atomic open(path,'w').write(...) still left all controls green.
  #    With the .bak already present backup_once no-ops (it only creates when missing), so the
  #    failure that fires is atomic_write's own -- which is the branch under test. Note the two need
  #    different permissions to fail: creating a NEW entry (.bak, temp file) needs write on the
  #    DIRECTORY, while the old truncating write only needed write on the existing FILE, which it
  #    still has. That asymmetry is exactly what makes this a real discriminator.
  mkdir -p "$tmp/ro"
  printf 'BOOT CRITICAL\n```bash\ncurl -s -H "Authorization: Bearer $(cat /t/tok)" http://x\n```\n' > "$tmp/ro/g.md"
  cp "$tmp/ro/g.md" "$tmp/ro/g.md.bak"
  sum_before="$(cksum < "$tmp/ro/g.md")"
  chmod 500 "$tmp/ro"
  _run_python apply "$tmp/ro/g.md" >/dev/null 2>&1
  chmod 700 "$tmp/ro"
  if [[ "$(cksum < "$tmp/ro/g.md")" == "$sum_before" ]]; then
    echo "  ok   a write that cannot create its temp leaves the target BYTE-IDENTICAL"
  else
    echo "  FAIL the target was damaged when the write could not complete"; fail=1
  fi

  # The forbidden header is assembled at RUN TIME and interpolated, never spelled out as a whole
  # runnable curl line in this file. This script is itself part of the corpus the token-in-argv guard
  # scans, and a shipped file should not carry a copy-pasteable example of the very thing it erases --
  # the same reason the variant-B rewriter above documents the header alone. Writing negating prose
  # around a literal to satisfy the guard's exemption would be gaming the guard, not obeying it.
  bad_hdr='Authorization: Bearer $(cat /t/tok)'
  bad_var='Authorization: Bearer $TOK'

  # --- F1 (Cybersec NO-GO, HIGH): prose documents, it does not run -----------------------------
  # The damage this prevents: leak-safe-secret-probe/SKILL.md:34 documents the UNSAFE shape in prose,
  # and the rewriter turned it into the SAFE shape -- so the paragraph then claimed that
  # printf | curl -H @- is what leaks, directly above "Feed curl a stdin config instead". Instead of
  # what? The safe form. The skill whose only job is teaching leak-free secret handling was taught
  # the opposite by the tool meant to protect it.
  printf 'even `curl -H "%s"` puts the secret in argv\n' "$bad_hdr" > "$tmp/prose.md"
  _run_python apply "$tmp/prose.md" >/dev/null
  if grep -q 'Bearer \$(cat' "$tmp/prose.md" && ! grep -q 'curl -H @-' "$tmp/prose.md"; then
    echo "  ok   markdown PROSE documenting the anti-pattern is left alone"
  else
    echo "  FAIL prose was rewritten -- the documented anti-pattern got inverted"; fail=1
  fi
  # The twin, so the rule is not "never touch markdown": inside a runnable fence the same line IS a
  # copy-pasteable command and must still be fixed (cybered-gate-pattern/SKILL.md:39 is exactly that).
  printf '```bash\ncurl -s -H "%s" http://x\n```\n' "$bad_hdr" > "$tmp/fenced.md"
  _run_python apply "$tmp/fenced.md" >/dev/null
  if grep -q 'curl -H @-' "$tmp/fenced.md"; then
    echo "  ok   the SAME line inside a runnable fence is still rewritten"
  else
    echo "  FAIL a runnable fenced command was skipped as if it were prose"; fail=1
  fi
  printf '# curl -s -H "%s" http://x\n' "$bad_hdr" > "$tmp/comment.sh"
  _run_python apply "$tmp/comment.sh" >/dev/null
  if grep -q 'Bearer \$(cat' "$tmp/comment.sh"; then
    echo "  ok   a commented-out example in a .sh is left alone"
  else
    echo "  FAIL a comment was rewritten"; fail=1
  fi

  # --- F2a: the cut point is the curl that IS the command ---------------------------------------
  printf 'echo "see curl docs" && curl -s -H "%s" http://x\n' "$bad_var" > "$tmp/pos.sh"
  _run_python apply "$tmp/pos.sh" >/dev/null
  if bash -n "$tmp/pos.sh" 2>/dev/null && grep -q 'see curl docs' "$tmp/pos.sh"; then
    echo "  ok   a curl inside a string is not mistaken for the command"
  else
    echo "  FAIL the rewrite cut at the wrong curl -- result does not parse"; fail=1
  fi

  # --- F2b: validate() now has a .sh branch -----------------------------------------------------
  # It had none, so it fell through to `return True`: the header's promise that an invalid rewrite is
  # DISCARDED was false for the one file type this card brought into scope. The .bak is recovery;
  # this is prevention.
  printf 'if true; then\n  curl -s -H "%s" http://x\nfi\n' "$bad_hdr" > "$tmp/ok.sh"
  _run_python apply "$tmp/ok.sh" >/dev/null
  if bash -n "$tmp/ok.sh" 2>/dev/null && grep -q 'curl -H @-' "$tmp/ok.sh"; then
    echo "  ok   a valid .sh rewrite is written and still parses"
  else
    echo "  FAIL a valid .sh rewrite was rejected or produced broken shell"; fail=1
  fi

  [[ $fail -eq 0 ]] && { echo 'selftest: PASS'; exit 0; } || { echo 'selftest: FAIL'; exit 1; }
fi

[[ -d "$AGENTS_DIR" ]] || { echo "sync-agent-templates: no $AGENTS_DIR -- nothing to sync"; exit 0; }

targets=()
for dir in "$AGENTS_DIR"/*/; do
  name="$(basename "${dir%/}")"
  if [[ ${#ONLY_AGENTS[@]} -gt 0 ]]; then
    skip=1
    for want in "${ONLY_AGENTS[@]}"; do [[ "$want" == "$name" ]] && skip=0; done
    [[ $skip -eq 1 ]] && continue
  fi
  # DERIVED, not a three-name list (Cybersec NO-GO on card ec5173a5): the first version scanned
  # CLAUDE.md plus the two settings.json, and an EXECUTABLE script under agents/qa/ -- the most
  # dangerous case, because it actually runs -- was outside that list. Scan by TYPE instead, and skip
  # what must never be rewritten: the .bak copies this script itself makes, and any vendored tree.
  while IFS= read -r -d '' f; do targets+=("$f")
  done < <(find "$dir" \
    \( -name node_modules -o -name .git -o -name '*.bak' \) -prune -o \
    -type f \( -name '*.md' -o -name '*.json' -o -name '*.sh' \) -print0 2>/dev/null)
done

if [[ ${#targets[@]} -eq 0 ]]; then echo "sync-agent-templates: no target files"; exit 0; fi
echo "sync-agent-templates: ${#targets[@]} file(s), mode=$([[ $APPLY -eq 1 ]] && echo APPLY || echo DRY-RUN)"
_run_python "$([[ $APPLY -eq 1 ]] && echo apply || echo dry)" "${targets[@]}"
