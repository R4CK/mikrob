#!/usr/bin/env bash
# token-opt-adoption-report.sh -- card 340585f6 (child of phase bf03aaa1, Peti 12303).
#
# Two measurements the card asked for, read-only, never blocks, never mutates anything:
#   A) per-agent token-opt adoption table: which solution is active, with evidence
#      (skill-map-provisioner symlink present, skill_usage rows, unlazy hook wired).
#   B) agent-to-agent English-share, using a stopword classifier (elemzo's e060a794 method,
#      NOT an accent-only count -- an accent-only count undercounts Hungarian by about 36
#      points, per that report's E11).
#
# Scope, per MikroB's narrowing on the card (comments 24520/24523/24596/24600) and the
# inventory's own rollout matrix (e060a794 section 3): mcp-compressor and token-optimizer-mcp
# are explicitly NOT rolled out here (unmeasured benefit / no security review yet); graphify
# and code-review-graph need no per-agent action (script-driven / already reachable). This
# script only reports caveman, local-llm-offload (the fleet-core skill-map entries that are
# actual token-opt levers) and the unlazy Stop hook.
#
#   token-opt-adoption-report.sh              # table + 72h language share, human-readable
#   token-opt-adoption-report.sh --hours 24   # a different message window
#   token-opt-adoption-report.sh --json
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARVEEN_ROOT="$(cd "$HERE/.." && pwd)"
DB="${TOKEN_OPT_REPORT_DB:-$HERE/claudeclaw.db}"
AGENTS_DIR="${TOKEN_OPT_REPORT_AGENTS_DIR:-$MARVEEN_ROOT/agents}"
HOURS=72
JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="${2:-72}"; shift 2 ;;
    --json) JSON=1; shift ;;
    *) printf 'usage: token-opt-adoption-report.sh [--hours N] [--json]\n' >&2; exit 2 ;;
  esac
done

[ -f "$DB" ] || { printf 'token-opt-adoption-report: no db at %s\n' "$DB" >&2; exit 1; }

python3 -I - "$DB" "$AGENTS_DIR" "$HOURS" "$JSON" <<'PYEOF'
import sqlite3, sys, os, re, json, time

db_path, agents_dir, hours, as_json = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == '1'

TOKEN_OPT_SKILLS = ['caveman', 'local-llm-offload']

agents = sorted(
    d for d in os.listdir(agents_dir)
    if os.path.isdir(os.path.join(agents_dir, d)) and d != 'mikrob'
)

con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row

# --- A) per-agent token-opt adoption table ---
table = []
for agent in agents:
    row = {'agent': agent}
    skills_dir = os.path.join(agents_dir, agent, '.claude', 'skills')
    for skill in TOKEN_OPT_SKILLS:
        p = os.path.join(skills_dir, skill)
        if os.path.islink(p):
            linked = 'symlink'
        elif os.path.isdir(p):
            linked = 'real-dir'
        else:
            linked = 'missing'
        usage = con.execute(
            "SELECT COUNT(*) FROM skill_usage WHERE agent_id = ? AND skill_name = ?",
            (agent, skill),
        ).fetchone()[0]
        row[skill] = f'{linked}, skill_usage={usage}'
    settings_path = os.path.join(agents_dir, agent, '.claude', 'settings.json')
    unlazy_wired = False
    if os.path.isfile(settings_path):
        with open(settings_path, encoding='utf-8') as f:
            unlazy_wired = 'unlazy' in f.read()
    row['unlazy_stop_hook'] = 'wired' if unlazy_wired else 'absent'
    table.append(row)

# --- B) English-share, stopword classifier (elemzo e060a794 method) ---
HU_STOPWORDS = {
    'a', 'az', 'es', 'hogy', 'nem', 'van', 'egy', 'de', 'ez', 'mert', 'meg', 'mar',
    'is', 'mint', 'vagy', 'csak', 'ha', 'akkor', 'amely', 'aki', 'mi', 'te', 'o',
    'mind', 'kell', 'lesz', 'volt', 'nincs', 'igen', 'benne', 'ezt', 'ezen', 'abban',
    'erre', 'arra', 'szerint', 'miatt', 'kozott', 'alatt', 'felett', 'utan', 'elott',
    'mellett', 'miert', 'hogyan', 'tehat', 'viszont', 'ugyanakkor', 'ezert', 'tudom',
    'ker', 'kerlek', 'koszonom', 'jo', 'rossz', 'most', 'itt', 'ott', 'igy', 'ugy',
    'neki', 'nala', 'ebben', 'azert', 'legyen', 'lehet', 'kesz', 'minden',
}
EN_STOPWORDS = {
    'the', 'and', 'is', 'to', 'of', 'that', 'this', 'not', 'for', 'with', 'on', 'in',
    'at', 'be', 'as', 'it', 'by', 'an', 'or', 'if', 'then', 'we', 'you', 'your', 'i',
    'are', 'was', 'were', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
    'should', 'do', 'does', 'did', 'from', 'but', 'so', 'no', 'yes', 'please',
    'thanks', 'thank', 'all', 'now', 'here', 'there', 'still', 'already', 'done',
}
WORD_RE = re.compile(r'[a-zA-Z]+')

def strip_accents(s: str) -> str:
    table = str.maketrans('áéíóöőúüűÁÉÍÓÖŐÚÜŰ', 'aeiooouuuAEIOOOUUU')
    return s.translate(table)

def classify(body: str) -> str:
    words = WORD_RE.findall(strip_accents(body).lower())
    hu_hits = sum(1 for w in words if w in HU_STOPWORDS)
    en_hits = sum(1 for w in words if w in EN_STOPWORDS)
    if hu_hits > en_hits:
        return 'hu'
    if en_hits > hu_hits:
        return 'en'
    return 'unknown'

cutoff = int(time.time()) - hours * 3600
# "system" and "system-directive" are automated infrastructure senders (context-guard
# handoffs, recovery notices, etc.), not agent-to-agent dialogue -- Peti 12303's rule targets
# agent conversation, and these are both automated and Hungarian by design, which would
# understate the agent-side English share this script exists to measure.
AUTOMATED_SENDERS = {'system', 'system-directive'}
rows = con.execute(
    "SELECT from_agent, to_agent, content FROM agent_messages WHERE created_at >= ?",
    (cutoff,),
).fetchall()
rows = [r for r in rows if r['from_agent'] not in AUTOMATED_SENDERS and r['to_agent'] not in AUTOMATED_SENDERS]

per_sender = {}
totals = {'hu': 0, 'en': 0, 'unknown': 0}
for r in rows:
    sender = r['from_agent']
    cls = classify(r['content'] or '')
    totals[cls] += 1
    s = per_sender.setdefault(sender, {'hu': 0, 'en': 0, 'unknown': 0})
    s[cls] += 1

total_classified = totals['hu'] + totals['en']
english_share = (totals['en'] / total_classified * 100) if total_classified else None

result = {
    'hours': hours,
    'generated_at': int(time.time()),
    'token_opt_adoption': table,
    'language_share': {
        'total_messages': len(rows),
        'hu': totals['hu'],
        'en': totals['en'],
        'unknown': totals['unknown'],
        'english_share_pct': round(english_share, 1) if english_share is not None else None,
        'per_sender': per_sender,
    },
}

if as_json:
    print(json.dumps(result, indent=2, sort_keys=True))
else:
    print(f"token-opt adoption report, last {hours}h")
    print()
    print("A) per-agent token-opt adoption (fleet-core skill-map levers only; see e060a794 section 3 for why")
    print("   mcp-compressor/token-optimizer-mcp/graphify/code-review-graph are not in this table)")
    header = f"{'agent':<12} {'caveman':<28} {'local-llm-offload':<28} {'unlazy'}"
    print(header)
    print('-' * len(header))
    for row in table:
        print(f"{row['agent']:<12} {row['caveman']:<28} {row['local-llm-offload']:<28} {row['unlazy_stop_hook']}")
    print()
    print("B) agent-to-agent English share (stopword classifier, not accent-only)")
    print(f"   total messages: {len(rows)}  hu: {totals['hu']}  en: {totals['en']}  unknown: {totals['unknown']}")
    if english_share is not None:
        print(f"   english share of classified (hu+en): {english_share:.1f}%")
    else:
        print("   no classified (hu or en) messages in window")
    print()
    print("   per sender (hu/en/unknown):")
    for sender in sorted(per_sender):
        s = per_sender[sender]
        print(f"     {sender:<12} hu={s['hu']:<4} en={s['en']:<4} unknown={s['unknown']}")
PYEOF
