#!/usr/bin/env bash
# Self-test for unlazy-stop-hook-cutover.sh (card 9ed32347, CYBERED NO-GO 39489 F-6: "no committed
# or tested rollback"). Everything here runs under a scratch --root; it NEVER touches the real
# /home/neon/.claude or /home/neon/marveen/agents paths.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/unlazy-stop-hook-cutover.sh"
fail=0
n=0

OLD_CMD="'/usr/bin/node' '/home/neon/.claude/skills/unlazy/scripts/stop-hook.mjs' --unlazy"
NEW_CMD="'/usr/bin/bash' '/home/neon/marveen/store/unlazy-stop-hook-verified.sh' --unlazy"

WORK="$(mktemp -d)"
ROOT="$WORK/root"

make_settings() {
  local path="$1" cmd="$2"
  mkdir -p "$(dirname "$path")"
  python3 -c "
import json, sys
cmd = sys.argv[1]
doc = {
  'hooks': {
    'Stop': [
      {'hooks': [{'type': 'command', 'command': '/usr/bin/python3 /home/neon/.claude/hooks/telegram_progress_clear.py', 'timeout': 15}]},
      {'hooks': [{'type': 'command', 'command': cmd, 'timeout': 20}]}
    ]
  }
}
json.dump(doc, open(sys.argv[2], 'w'), indent=2)
" "$cmd" "$path"
}

agents=(backend backend2 cybered cybersec fron-ted fron-teddy fullstack jogasz marketing penzugy qa qa2 teszter videooo)
seed_fixture() {
  local root="$1"
  rm -rf "$root"
  for a in "${agents[@]}"; do
    make_settings "$root/home/neon/marveen/agents/$a/.claude/settings.json" "$OLD_CMD"
  done
  make_settings "$root/home/neon/.claude/settings.json" "$OLD_CMD"
  make_settings "$root/home/neon/marveen/agents/penzugy/.claude-config/settings.json" "$OLD_CMD"
}

# Scoped to settings.json files only -- a recursive grep over the whole root also matches the
# .bak copies under the backups dir, double-counting (caught live: first run of this selftest).
count_old() { find "$1" -name settings.json -exec grep -lF "$OLD_CMD" {} + 2>/dev/null | wc -l; }
count_new() { find "$1" -name settings.json -exec grep -lF "$NEW_CMD" {} + 2>/dev/null | wc -l; }

n=$((n + 1))
seed_fixture "$ROOT"
before_old=$(count_old "$ROOT"); before_new=$(count_new "$ROOT")
if [ "$before_old" -eq 16 ] && [ "$before_new" -eq 0 ]; then
  echo "  ok   fixture seeded with 16 files on the old command, 0 on the new one"
else
  echo "  FAIL fixture seed wrong: old=$before_old new=$before_new (expected 16/0)"; fail=1
fi

n=$((n + 1))
dry_out="$("$SCRIPT" --dry-run --root "$ROOT" 2>&1)"
after_old=$(count_old "$ROOT"); after_new=$(count_new "$ROOT")
if [ "$after_old" -eq 16 ] && [ "$after_new" -eq 0 ] && printf '%s' "$dry_out" | grep -q "changed=16 fail=0"; then
  echo "  ok   --dry-run reports 16 would-change, touches nothing"
else
  echo "  FAIL --dry-run changed the fixture or reported wrong count -> old=$after_old new=$after_new out=$dry_out"; fail=1
fi

n=$((n + 1))
apply_out="$("$SCRIPT" --apply --root "$ROOT" 2>&1)"
after_apply_old=$(count_old "$ROOT"); after_apply_new=$(count_new "$ROOT")
if [ "$after_apply_old" -eq 0 ] && [ "$after_apply_new" -eq 16 ] && printf '%s' "$apply_out" | grep -q "changed=16 fail=0"; then
  echo "  ok   --apply flips all 16 files from the old command to the new one"
else
  echo "  FAIL --apply did not flip all 16 -> old=$after_apply_old new=$after_apply_new out=$apply_out"; fail=1
fi

n=$((n + 1))
all_valid=1
while IFS= read -r f; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" >/dev/null 2>&1 || all_valid=0
done < <(find "$ROOT" -name settings.json)
if [ "$all_valid" -eq 1 ]; then
  echo "  ok   all 16 files are still valid JSON after --apply"
else
  echo "  FAIL at least one settings.json is invalid JSON after --apply"; fail=1
fi

n=$((n + 1))
backup_count=$(find "$ROOT/home/neon/.claude/unlazy-stop-hook-cutover-backups" -name '*.bak' 2>/dev/null | wc -l)
if [ "$backup_count" -eq 16 ]; then
  echo "  ok   --apply wrote 16 pre-edit backups"
else
  echo "  FAIL expected 16 backup files, found $backup_count"; fail=1
fi

n=$((n + 1))
# idempotency: running --apply again on an already-applied tree must report already-apply for
# every file and change nothing, not error or double-wrap the command.
reapply_out="$("$SCRIPT" --apply --root "$ROOT" 2>&1)"
reapply_old=$(count_old "$ROOT"); reapply_new=$(count_new "$ROOT")
if [ "$reapply_old" -eq 0 ] && [ "$reapply_new" -eq 16 ] && printf '%s' "$reapply_out" | grep -q "changed=0 fail=0"; then
  echo "  ok   --apply is idempotent: re-running on an already-applied tree changes nothing"
else
  echo "  FAIL re-apply was not a no-op -> old=$reapply_old new=$reapply_new out=$reapply_out"; fail=1
fi

n=$((n + 1))
# THE ROLLBACK, tested: --rollback must restore every file to the exact old command.
rollback_out="$("$SCRIPT" --rollback --root "$ROOT" 2>&1)"
after_rb_old=$(count_old "$ROOT"); after_rb_new=$(count_new "$ROOT")
if [ "$after_rb_old" -eq 16 ] && [ "$after_rb_new" -eq 0 ] && printf '%s' "$rollback_out" | grep -q "changed=16 fail=0"; then
  echo "  ok   --rollback restores all 16 files to the exact old direct-exec command"
else
  echo "  FAIL --rollback did not restore all 16 -> old=$after_rb_old new=$after_rb_new out=$rollback_out"; fail=1
fi

n=$((n + 1))
all_valid_rb=1
while IFS= read -r f; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" >/dev/null 2>&1 || all_valid_rb=0
done < <(find "$ROOT" -name settings.json)
if [ "$all_valid_rb" -eq 1 ]; then
  echo "  ok   all 16 files are still valid JSON after --rollback"
else
  echo "  FAIL at least one settings.json is invalid JSON after --rollback"; fail=1
fi

n=$((n + 1))
# A file with more than one occurrence of the source command must be REFUSED, never guessed at.
seed_fixture "$ROOT"
dup_file="$ROOT/home/neon/marveen/agents/backend/.claude/settings.json"
python3 -c "
import json, sys
cmd = sys.argv[1]
doc = {'hooks': {'Stop': [
  {'hooks': [{'type': 'command', 'command': cmd, 'timeout': 20}]},
  {'hooks': [{'type': 'command', 'command': cmd, 'timeout': 20}]}
]}}
json.dump(doc, open(sys.argv[2], 'w'), indent=2)
" "$OLD_CMD" "$dup_file"
dup_out="$("$SCRIPT" --apply --root "$ROOT" 2>&1)"
if printf '%s' "$dup_out" | grep -q "REFUSING $dup_file" && printf '%s' "$dup_out" | grep -q "fail=1"; then
  echo "  ok   a file with 2 occurrences of the source command is refused, not silently rewritten"
else
  echo "  FAIL expected a REFUSING line for the duplicate-occurrence file -> out=$dup_out"; fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
