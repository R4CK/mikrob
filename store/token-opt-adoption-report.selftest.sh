#!/usr/bin/env bash
# token-opt-adoption-report.selftest.sh -- does the report count what it claims to count?
# (card 340585f6) Builds a fixture sqlite db + a fixture agents/ tree, never touches the live db.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/token-opt-adoption-report.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
declare -a FAILED=()
check() { if [ "$1" = "$2" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED+=("$3: expected [$2] got [$1]"); fi; }

# --- fixture agents/ tree ---------------------------------------------------
AGENTS="$TMP/agents"
GLOBAL_SKILLS="$TMP/global-skills"
mkdir -p "$GLOBAL_SKILLS/caveman" "$GLOBAL_SKILLS/local-llm-offload"

mkdir -p "$AGENTS/agentA/.claude/skills" "$AGENTS/agentB/.claude/skills" "$AGENTS/mikrob"
ln -s "$GLOBAL_SKILLS/caveman" "$AGENTS/agentA/.claude/skills/caveman"
ln -s "$GLOBAL_SKILLS/local-llm-offload" "$AGENTS/agentA/.claude/skills/local-llm-offload"
# agentB: neither skill symlinked (simulates a not-yet-restarted agent)
printf '{"hooks":{"Stop":[{"hooks":[{"command":"node ~/.claude/skills/unlazy/scripts/stop-hook.mjs"}]}]}}' \
  > "$AGENTS/agentA/.claude/settings.json"
printf '{}' > "$AGENTS/agentB/.claude/settings.json"
# mikrob must be excluded from the per-agent table entirely
touch "$AGENTS/mikrob/CLAUDE.md"

# --- fixture db --------------------------------------------------------------
DB="$TMP/fixture.db"
sqlite3 "$DB" <<'SQL'
CREATE TABLE skill_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
SQL

now="$(date +%s)"
sqlite3 "$DB" "INSERT INTO skill_usage (agent_id, skill_name, trigger_type, created_at) VALUES ('agentA', 'local-llm-offload', 'tool_call', $now);"

# one clearly-English message, one clearly-Hungarian (accented AND accent-stripped), one tie (no
# stopword from either list -- protocol-token-only), one from an excluded automated sender, one
# to an excluded automated sender.
sqlite3 "$DB" "INSERT INTO agent_messages (from_agent, to_agent, content, created_at) VALUES
  ('agentA', 'agentB', 'This is the plan and we should do it now', $now),
  ('agentB', 'agentA', 'Ezt most meg kell csinalni, mert igy lesz jo', $now),
  ('agentA', 'agentB', 'Gate-SHA: abc123', $now),
  ('system-directive', 'agentA', 'Ez egy automatikus direktiva, nem agens-beszelgetes', $now),
  ('agentB', 'system', 'Ez sem agens-beszelgetes', $now);"

OUT="$(TOKEN_OPT_REPORT_DB="$DB" TOKEN_OPT_REPORT_AGENTS_DIR="$AGENTS" "$SCRIPT" --hours 24 --json)"

get() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))" "$OUT" "$1"; }

# A) adoption table: agentA has both symlinked + 1 local-llm-offload usage + unlazy wired;
#    agentB has neither symlinked, no usage, unlazy absent; mikrob never appears.
check "$(get "sorted(r['agent'] for r in d['token_opt_adoption'])")" "['agentA', 'agentB']" "mikrob excluded from table"
check "$(get "[r for r in d['token_opt_adoption'] if r['agent']=='agentA'][0]['caveman']")" "symlink, skill_usage=0" "agentA caveman symlink detected"
check "$(get "[r for r in d['token_opt_adoption'] if r['agent']=='agentA'][0]['local-llm-offload']")" "symlink, skill_usage=1" "agentA local-llm-offload usage counted"
check "$(get "[r for r in d['token_opt_adoption'] if r['agent']=='agentA'][0]['unlazy_stop_hook']")" "wired" "agentA unlazy hook detected"
check "$(get "[r for r in d['token_opt_adoption'] if r['agent']=='agentB'][0]['caveman']")" "missing, skill_usage=0" "agentB caveman missing (not yet restarted)"
check "$(get "[r for r in d['token_opt_adoption'] if r['agent']=='agentB'][0]['unlazy_stop_hook']")" "absent" "agentB unlazy hook absent"

# B) language share: only the English + Hungarian messages count (2 classified, system-directive
#    and system-facing rows excluded, the Gate-SHA-only tie lands in 'unknown').
check "$(get "d['language_share']['total_messages']")" "3" "automated senders excluded from total"
check "$(get "d['language_share']['hu']")" "1" "accent-stripped Hungarian still classified hu"
check "$(get "d['language_share']['en']")" "1" "plain English classified en"
check "$(get "d['language_share']['unknown']")" "1" "protocol-token-only message classified unknown, not hu or en"
check "$(get "d['language_share']['english_share_pct']")" "50.0" "english share of classified (hu+en) only"

echo
echo "token-opt-adoption-report.selftest.sh: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  printf '  FAILED: %s\n' "${FAILED[@]}"
  exit 1
fi
exit 0
