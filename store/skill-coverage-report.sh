#!/usr/bin/env bash
# skill-coverage-report.sh
# Per-agent skill coverage: seen (skill_usage 7d) vs required (skill-role-map.md)
# Output: text lines for Dream Engine Bucket 5
# Usage: bash store/skill-coverage-report.sh [--days N] [--agent AGENT_ID]
#        Defaults: last 7 days, all agents
# Exit 0: ok (even if no data); non-zero: tool error

set -euo pipefail

DAYS=7
AGENT_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --agent) AGENT_FILTER="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

DB="${MARVEEN_DB:-/home/neon/marveen/store/claudeclaw.db}"
MAP="${SKILL_ROLE_MAP:-/home/neon/marveen/store/skill-role-map.md}"

if [[ ! -f "$DB" ]]; then
  echo "HIBA: DB nem talalhato: $DB" >&2; exit 1
fi
if [[ ! -f "$MAP" ]]; then
  echo "HIBA: skill-role-map nem talalhato: $MAP" >&2; exit 1
fi

python3 -I - "$DB" "$MAP" "$DAYS" "$AGENT_FILTER" <<'PYEOF'
import sys, sqlite3, re

db_path, map_path, days_str, agent_filter = sys.argv[1:]
days = int(days_str)

# Parse skill-role-map.md: required = "mar bekotve" | "KOTELEZO-GAP"
agent_required: dict[str, set] = {}
current_agent: str | None = None

with open(map_path, encoding="utf-8") as f:
    for line in f:
        m = re.match(r'^### (\S+)', line)
        if m:
            current_agent = m.group(1)
            agent_required.setdefault(current_agent, set())
        if current_agent and '|' in line:
            parts = [p.strip() for p in line.split('|')]
            if len(parts) >= 3:
                skill_m = re.match(r'`([^`]+)`', parts[1])
                if skill_m:
                    status = parts[2]
                    if 'mar bekotve' in status or 'KOTELEZO-GAP' in status \
                            or 'már bekötve' in status or 'KÖTELEZŐ-GAP' in status:
                        agent_required[current_agent].add(skill_m.group(1))

# Query skill_usage for last N days
con = sqlite3.connect(db_path)
sql = """
    SELECT agent_id, skill_name
    FROM skill_usage
    WHERE created_at > CAST(strftime('%s','now',? || ' days') AS INTEGER)
    GROUP BY agent_id, skill_name
"""
rows = con.execute(sql, (f'-{days}',)).fetchall()
con.close()

agent_seen: dict[str, set] = {}
for agent_id, skill_name in rows:
    agent_seen.setdefault(agent_id, set()).add(skill_name)

agents = sorted(agent_required.keys())
if agent_filter:
    agents = [a for a in agents if a == agent_filter]

results = []
for agent in agents:
    required = agent_required[agent]
    if not required:
        continue
    seen = agent_seen.get(agent, set())
    covered = required & seen
    pct = round(len(covered) / len(required) * 100)
    missing = sorted(required - seen)
    results.append((agent, len(covered), len(required), pct, missing))

if not results:
    print("  Nincs skill_usage adat az elmult " + days_str + " napban.")
else:
    for agent, cov, tot, pct, missing in results:
        filled = pct // 10
        bar = '#' * filled + '.' * (10 - filled)
        sample = missing[:3]
        suffix = ('...' if len(missing) > 3 else '')
        sample_str = ''
        if sample:
            sample_str = '  (nincs: ' + ', '.join(sample) + suffix + ')'
        print(f'  {agent}: {cov}/{tot} ({pct}%) [{bar}]{sample_str}')
PYEOF
