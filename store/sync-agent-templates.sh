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

AUTH_ARGV = re.compile(r'-H\s+(?P<q>["\'])Authorization:\s*Bearer\s+\$\(cat\s+(?P<path>[^)]+)\)(?P=q)\s*')

def rewrite_auth_argv(line):
    """curl ... -H "Authorization: Bearer $(cat P)" ...  ->  printf ... | curl -H @- ..."""
    if 'curl' not in line or not AUTH_ARGV.search(line):
        return None
    m = AUTH_ARGV.search(line)
    path = m.group('path').strip()
    stripped = AUTH_ARGV.sub('', line, count=1)
    idx = stripped.index('curl')
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
    """curl ... -H "Authorization: Bearer $TOK" ...  ->  printf ... "$TOK" | curl -H @- ...

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
    idx = stripped.index('curl')
    indent, tail = stripped[:idx], stripped[idx + 4:]
    printf = f"{indent}printf 'Authorization: Bearer %s\\n' \"{var}\" \\\n"
    return printf + f"{indent}| curl -H @-{tail.rstrip()}\n"

PATTERNS = [
    # card ec5173a5: the dashboard token as a curl argv element -> /proc/<pid>/cmdline leak.
    ('bearer-token-in-curl-argv', AUTH_ARGV, rewrite_auth_argv),
    ('bearer-token-in-curl-argv-via-var', AUTH_ARGV_VAR, rewrite_auth_argv_var),
]

def fix_text(text):
    """Rewrite every known-bad pattern in a shell/markdown text. Returns (new_text, hits)."""
    hits = 0
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        for _name, det, rewrite in PATTERNS:
            if det.search(line):
                new = rewrite(line)
                if new is not None:
                    lines[i] = new
                    hits += 1
    return ''.join(lines), hits

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
                new, n = fix_text(val)
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
        new, hits = fix_json(raw) if path.endswith('.json') else fix_text(raw)
    except Exception as exc:
        # Unparseable input is SKIPPED, not failed: we never wrote to it, so there is nothing to
        # restore and nothing half-applied. Keeping the two apart matters because the exit code is a
        # promise -- 3 means "a rewrite was attempted and did not validate".
        print(f'  SKIP  {path}: cannot parse ({exc})')
        return 0, 0, 0, 1
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
  printf 'curl -s -H "Authorization: Bearer $(cat /t/tok)" http://x\n' > "$tmp/a.md"
  _t "markdown: argv token rewritten" 1 "$tmp/a.md"
  grep -q 'printf .Authorization' "$tmp/a.md" && grep -q 'curl -H @-' "$tmp/a.md" \
    && echo "  ok   markdown: emits the printf | curl -H @- shape" \
    || { echo "  FAIL markdown: wrong replacement shape"; fail=1; }

  # 2. IDEMPOTENT -- an already-good file is left alone
  _t "markdown: already-good file untouched" 0 "$tmp/a.md"

  # 3. CUSTOMISATION PRESERVED -- the whole point of not copying the template over
  printf 'MY OWN NOTE\ncurl -s -H "Authorization: Bearer $(cat /t/tok)" http://x\nANOTHER NOTE\n' > "$tmp/c.md"
  _run_python apply "$tmp/c.md" >/dev/null
  grep -q 'MY OWN NOTE' "$tmp/c.md" && grep -q 'ANOTHER NOTE' "$tmp/c.md" \
    && echo "  ok   customisation around the pattern is preserved" \
    || { echo "  FAIL customisation was lost"; fail=1; }

  # 4. JSON goes through parse -> edit -> serialise and stays valid
  python3 -c "import json;json.dump({'hooks':{'x':'run: curl -s -H \"Authorization: Bearer \$(cat /t/tok)\" http://x'}},open('$tmp/d.json','w'))"
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

  # --- atomicity + backup (Cybered NO-GO, card 265fdc2c) ----------------------------------------
  # 6. a one-time .bak holds the ORIGINAL, and a second run does not clobber it with the fixed copy.
  printf 'ORIGINAL\ncurl -s -H "Authorization: Bearer $(cat /t/tok)" http://x\n' > "$tmp/f.md"
  _run_python apply "$tmp/f.md" >/dev/null
  if grep -q 'ORIGINAL' "$tmp/f.md.bak" && grep -q 'Bearer \$(cat' "$tmp/f.md.bak"; then
    echo "  ok   backup holds the pristine ORIGINAL, not the rewritten copy"
  else
    echo "  FAIL backup does not hold the original"; fail=1
  fi
  cp "$tmp/f.md.bak" "$tmp/f.md.bak.snapshot"
  printf 'curl -s -H "Authorization: Bearer $(cat /t/tok)" http://y\n' >> "$tmp/f.md"
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
  mkdir -p "$tmp/ro"
  printf 'BOOT CRITICAL\ncurl -s -H "Authorization: Bearer $(cat /t/tok)" http://x\n' > "$tmp/ro/g.md"
  sum_before="$(cksum < "$tmp/ro/g.md")"
  chmod 500 "$tmp/ro"
  _run_python apply "$tmp/ro/g.md" >/dev/null 2>&1
  chmod 700 "$tmp/ro"
  if [[ "$(cksum < "$tmp/ro/g.md")" == "$sum_before" ]]; then
    echo "  ok   a write that cannot create its temp leaves the target BYTE-IDENTICAL"
  else
    echo "  FAIL the target was damaged when the write could not complete"; fail=1
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
