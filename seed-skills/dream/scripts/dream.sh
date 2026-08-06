#!/usr/bin/env bash
# /dream helper -- memory-store git bootstrap + Peti-turns collector.
# Constraints live in ~/.claude/skills/dream/SKILL.md (0a-0e). This script is
# best-effort evidence collection; the agent STILL applies 0d judgment.
set -euo pipefail

MEM="/home/neon/.claude/projects/-home-neon-marveen/memory"
PROJECTS="/home/neon/.claude/projects"
PETI_ID="7929620734"

ensure_git() {
  [ -d "$MEM" ] || { echo "STOP: memory dir missing: $MEM" >&2; exit 1; }
  cd "$MEM"
  if [ ! -d .git ]; then
    git init -q || { echo "STOP: git init FAILED in $MEM" >&2; exit 1; }
    git config user.name "MikroB"
    git config user.email "mikrob@marveen.local"
  fi
  grep -qxF 'dream-report.md' .gitignore 2>/dev/null || echo 'dream-report.md' >> .gitignore
  if ! git rev-parse HEAD >/dev/null 2>&1; then
    git add .gitignore
    for f in *.md; do [ -e "$f" ] && git add -- "$f"; done
    git commit -q -m "dream: initialize memory store version control [proposal #0, $(date +%F)]"
  fi
  echo "git OK ($(git -C "$MEM" rev-list --count HEAD) commits, $(git -C "$MEM" ls-files '*.md' | wc -l) md tracked)"
}

# Extract Peti's OWN typed turns from jsonl transcripts modified in last 24h.
collect() {
  python3 - "$PROJECTS" "$PETI_ID" <<'PY'
import json, os, sys, time, re
root, peti = sys.argv[1], sys.argv[2]
cutoff = time.time() - 24*3600
files = []
for dp, _, fns in os.walk(root):
    for fn in fns:
        if fn.endswith('.jsonl'):
            p = os.path.join(dp, fn)
            try:
                if os.path.getmtime(p) >= cutoff: files.append(p)
            except OSError: pass

SKIP = ('<scheduled-task', 'SCHEDULED TASK NOTICE', '<system-reminder',
        '<command-name>', '<command-message>', '<local-command-stdout>',
        'UserPromptSubmit hook', 'SessionStart', 'caveMAN', 'CAVEMAN MODE',
        'Stop hook feedback', '[Request interrupted', 'felügyelet nélküli stabilitás',
        'Reggeli napindító', 'search_emails az elmúlt', 'heartbeat logika')
chan_re = re.compile(r'<channel\b[^>]*>(.*?)</channel>', re.S)
attr_re = re.compile(r'source="([^"]*)"[^>]*user_id="([^"]*)"')

def text_of(msg):
    c = msg.get('content')
    if isinstance(c, str): return c
    if isinstance(c, list):
        out = []
        for b in c:
            if isinstance(b, dict):
                if b.get('type') == 'tool_result': return None  # tool output, not Peti
                if b.get('type') == 'text' and isinstance(b.get('text'), str):
                    out.append(b['text'])
            elif isinstance(b, str):
                out.append(b)
        return '\n'.join(out) if out else None
    return None

seen = set()
rows = []
for p in files:
    try: lines = open(p, encoding='utf-8', errors='replace').read().splitlines()
    except OSError: continue
    for ln in lines:
        ln = ln.strip()
        if not ln: continue
        try: obj = json.loads(ln)
        except Exception: continue
        msg = obj.get('message') if isinstance(obj.get('message'), dict) else obj
        if not isinstance(msg, dict): continue
        if msg.get('role') != 'user' and obj.get('type') != 'user': continue
        txt = text_of(msg)
        if not txt: continue
        ts = obj.get('timestamp') or msg.get('timestamp') or ''
        base = os.path.basename(p)
        # Case A: telegram channel block(s) -> keep ONLY Peti's
        chans = chan_re.findall(txt)
        if '<channel' in txt:
            for full in re.findall(r'<channel\b.*?</channel>', txt, re.S):
                m = attr_re.search(full)
                inner = chan_re.search(full)
                inner = inner.group(1).strip() if inner else ''
                if not m: continue
                src, uid = m.group(1), m.group(2)
                if 'telegram' in src and uid == peti and inner:
                    key = inner[:200]
                    if key not in seen:
                        seen.add(key); rows.append((ts, base, 'telegram', inner))
            continue
        # Case B: plain terminal user turn -> keep unless it's a wrapper/hook/command
        if any(s in txt for s in SKIP): continue
        stripped = txt.strip()
        if not stripped: continue
        key = stripped[:200]
        if key not in seen:
            seen.add(key); rows.append((ts, base, 'terminal', stripped))

rows.sort(key=lambda r: r[0])
print(f"# Peti turns, last 24h ({len(rows)} found across {len(files)} recent transcripts)")
print("# SOURCE OF TRUTH per 0d: these are the ONLY admissible candidates. Everything else is context.\n")
for ts, base, kind, txt in rows:
    q = txt if len(txt) <= 600 else txt[:600] + ' [...]'
    print(f"[{ts}] ({kind} :: {base})")
    for line in q.splitlines():
        print(f"    {line}")
    print()
if not rows:
    print("(no Peti-authored turns in the last 24h -- nothing to consolidate; report accordingly)")
PY
}

case "${1:-}" in
  --ensure-git) ensure_git ;;
  --collect)    ensure_git >/dev/null; collect ;;
  --unattended) ensure_git >/dev/null; echo "MODE: unattended (read-only). Collector output follows."; collect ;;
  *) echo "usage: dream.sh --ensure-git | --collect | --unattended" >&2; exit 2 ;;
esac
