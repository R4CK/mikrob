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
import json, re, subprocess, sys, tempfile, os

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

PATTERNS = [
    # card ec5173a5: the dashboard token as a curl argv element -> /proc/<pid>/cmdline leak.
    ('bearer-token-in-curl-argv', AUTH_ARGV, rewrite_auth_argv),
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
        open(path, 'w', encoding='utf-8').write(new)
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
  for rel in CLAUDE.md .claude/settings.json .claude-config/settings.json; do
    [[ -f "$dir$rel" ]] && targets+=("$dir$rel")
  done
done

if [[ ${#targets[@]} -eq 0 ]]; then echo "sync-agent-templates: no target files"; exit 0; fi
echo "sync-agent-templates: ${#targets[@]} file(s), mode=$([[ $APPLY -eq 1 ]] && echo APPLY || echo DRY-RUN)"
_run_python "$([[ $APPLY -eq 1 ]] && echo apply || echo dry)" "${targets[@]}"
