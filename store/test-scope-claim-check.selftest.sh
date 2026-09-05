#!/usr/bin/env bash
# test-scope-claim-check.selftest.sh -- cases for store/test-scope-claim-check.py (card e5b7ff19).
#
# Built on a SYNTHETIC repo, never the real tree: the real tree's answer changes every landing, so a
# selftest reading it would go red or green for reasons unrelated to this code.
#
# Case 4 is the load-bearing one. The first version of the checker matched the serving module by
# basename SUBSTRING, and the word 'spans' occurs throughout a test about spans -- so the checker
# reported "reached" for a file that imports only vitest, and MISSED the exact case it was written
# for. That regression must stay caught.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/test-scope-claim-check.py"
pass=0; fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "  FAIL: $1"; }
chk() { if [ "$2" = "$3" ]; then ok; else bad "$1 -- expected [$2] got [$3]"; fi }

R="$TMP/repo"
mkdir -p "$R/src/web/routes" "$R/src/__tests__"

cat > "$R/src/web/routes/spans.ts" <<'EOF'
import type { RouteContext } from './types.js'
export async function tryHandleSpans(ctx: RouteContext): Promise<boolean> {
  if (ctx.path === '/api/spans' && ctx.method === 'POST') { return true }
  if (ctx.path === '/api/traces') { return true }
  return false
}
EOF

run() { python3 "$SUT" --repo "$R" 2>&1; }
runjson() { python3 "$SUT" --repo "$R" --json 2>/dev/null; }
claims_unreached() { runjson | python3 -c "
import json,sys
rows=json.load(sys.stdin)
print(sum(1 for r in rows if r['test']==sys.argv[1] and not r['reached']))" "$1"; }

# 1. imports the serving module -> reached ---------------------------------------------------
cat > "$R/src/__tests__/a.test.ts" <<'EOF'
// Scope: the API route (POST /api/spans).
import { tryHandleSpans } from '../web/routes/spans.js'
EOF
chk "case1 import counts as reached" "0" "$(claims_unreached a.test.ts)"

# 2. calls the handler by name without a matching import path -> reached ----------------------
cat > "$R/src/__tests__/b.test.ts" <<'EOF'
// Scope: the API route (POST /api/spans).
const h = tryHandleSpans
EOF
chk "case2 handler call counts as reached" "0" "$(claims_unreached b.test.ts)"

# 3. THE OTEL SHAPE: claims the route, reaches nothing ----------------------------------------
cat > "$R/src/__tests__/c.test.ts" <<'EOF'
// Scope: DB layer and the API route (POST /api/spans, GET /api/traces).
import Database from 'better-sqlite3'
EOF
chk "case3 the otel shape is reported, both claims" "2" "$(claims_unreached c.test.ts)"

# 4. THE RECALL REGRESSION: the basename is all over the CODE but never imported ---------------
#    Substring matching called this "reached" and lost the founding case.
cat > "$R/src/__tests__/d.test.ts" <<'EOF'
// Scope: the API route (POST /api/spans).
import Database from 'better-sqlite3'
const spans = []
function readSpans() { return spans }
// spans spans spans
EOF
chk "case4 a bare 'spans' in the code is NOT reachability" "1" "$(claims_unreached d.test.ts)"

# 5. a claim in the BODY, not the header, is not a scope claim ---------------------------------
cat > "$R/src/__tests__/e.test.ts" <<'EOF'
import Database from 'better-sqlite3'
// later on, in passing: POST /api/spans is the writer
EOF
chk "case5 body mentions are ignored" "0" "$(claims_unreached e.test.ts)"

# 6. a claim nobody serves is not reported -- unknown is not a finding -------------------------
cat > "$R/src/__tests__/f.test.ts" <<'EOF'
// Scope: /api/nothing-serves-this
import Database from 'better-sqlite3'
EOF
chk "case6 unowned claims are skipped" "0" "$(claims_unreached f.test.ts)"

# 7. exit codes ---------------------------------------------------------------------------------
run >/dev/null; chk "case7 exit 1 while a mismatch exists" "1" "$?"
rm -f "$R/src/__tests__/c.test.ts" "$R/src/__tests__/d.test.ts"
run >/dev/null; chk "case7b exit 0 once the tree is clean" "0" "$?"

# 8. a bad repo is an error, not a silent clean pass --------------------------------------------
out="$(python3 "$SUT" --repo "$TMP/nope" 2>&1)"; rc=$?
chk "case8 exit 2 on a missing tree" "2" "$rc"
case "$out" in ERROR:*) ok ;; *) bad "case8 line: $out" ;; esac

echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
