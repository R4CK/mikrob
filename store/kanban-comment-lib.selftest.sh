#!/usr/bin/env bash
# Selftest for store/kanban-comment-lib.sh (card d28888cd).
#
# Bug: the old _kc_hdr() created its mktemp header file inside a `h="$(_kc_hdr)"`
# command-substitution subshell, so $_KC_HDR was only ever set in that subshell -- the parent's
# EXIT trap always ran `rm -f ""`. Every kanban_comment_card_id/kanban_comment_on call leaked one
# 0600 token-bearing /tmp file. The fix removes the temp file entirely (pipe the token straight
# into curl's stdin via -H @-), so there is nothing left to leak.
#
# This test runs against a disposable, local-only Python HTTP server, never the real dashboard.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

WORKDIR="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

FAKE_TOKEN="kanban-comment-lib-selftest-token-$$-$RANDOM"
printf '%s' "$FAKE_TOKEN" > "$WORKDIR/.dashboard-token"

CAPTURE_LOG="$WORKDIR/capture.log"
: > "$CAPTURE_LOG"
PORT=$(( (RANDOM % 5000) + 22000 ))

python3 - "$PORT" "$CAPTURE_LOG" > "$WORKDIR/server.log" 2>&1 <<'PYEOF' &
import http.server
import json
import sys

port = int(sys.argv[1])
log_path = sys.argv[2]


class Handler(http.server.BaseHTTPRequestHandler):
    def _log_auth(self):
        with open(log_path, "a") as f:
            f.write((self.headers.get("Authorization") or "") + "\n")

    def do_GET(self):
        self._log_auth()
        body = json.dumps([{"id": "cccccccc", "status": "in_progress", "assignee": "backend2"}]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self._log_auth()
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
PYEOF
SERVER_PID=$!

for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.1
done

FAILS=0
CHECKS=0
check() {
  CHECKS=$((CHECKS + 1))
  if [ "$1" = "0" ]; then
    echo "PASS: $2"
  else
    echo "FAIL: $2"
    FAILS=$((FAILS + 1))
  fi
}

# From here on every assertion is routed through check(), which collects all failures instead of
# aborting on the first one -- also exactly the failure mode this test must survive when run
# against the pre-fix script (that is the whole point of the mutation check).
set +e

# -s suppresses "Is a directory" noise (the same tmp.* glob also matches other processes' temp
# DIRECTORIES, e.g. other mktemp -d callers on this shared box).
before=$(grep -slF "$FAKE_TOKEN" /tmp/tmp.* 2>/dev/null | wc -l)

(
  export KANBAN_COMMENT_API="http://127.0.0.1:$PORT"
  export KANBAN_COMMENT_AGENT="backend2"
  export KANBAN_COMMENT_TOKEN_FILE="$WORKDIR/.dashboard-token"
  . "$SCRIPT_DIR/kanban-comment-lib.sh"
  for i in 1 2 3 4 5; do
    kanban_comment "selftest body $i"
  done
  kanban_comment_on "dddddddd" "explicit-card body"
) >/dev/null 2>"$WORKDIR/run.err"

after=$(grep -slF "$FAKE_TOKEN" /tmp/tmp.* 2>/dev/null | wc -l)
[ "$after" -le "$before" ]
check "$?" "no token-bearing /tmp file left behind after 6 calls (kanban_comment x5 + kanban_comment_on x1) ($before -> $after)"

grep -q "Bearer $FAKE_TOKEN" "$CAPTURE_LOG"
check "$?" "sanity: server actually received the real Bearer token via the pipe"

post_count=$(grep -c '^Bearer' "$CAPTURE_LOG" || true)
[ "$post_count" -ge 1 ]
check "$?" "sanity: at least one authenticated request reached the server ($post_count)"

# --- _kc_token_file resolves to its OWN repo's token file, not the caller's cwd (card 56b14f14
# round 2, qa2 comment 26511) -------------------------------------------------------------------
# `--path-format=absolute` is already in place at the git-common-dir call, but gate-worktree-
# pattern/fleet-test.sh always run this script from inside a LINKED WORKTREE, where
# --git-common-dir is already absolute with or without that flag (a worktree's .git is a FILE
# pointing at an absolute gitdir) -- so testing from this worktree alone cannot tell the fix apart
# from the pre-fix line. Build a REAL (non-worktree) repo via `git init`, with the sourced script
# living somewhere WITHOUT a local .dashboard-token beside it (so the fallback branch, the one this
# card's fix touches, actually runs instead of taking the short-circuit at line ~40), and call from
# an UNRELATED repo's cwd so a caller-cwd dependency cannot coincidentally still resolve right.
(
  MAIN_REPO="$(mktemp -d)"; MAIN_REPO="$(cd "$MAIN_REPO" && pwd -P)"
  CALLER_REPO="$(mktemp -d)"
  trap 'rm -rf "$MAIN_REPO" "$CALLER_REPO"' EXIT
  git init -q "$MAIN_REPO"
  mkdir -p "$MAIN_REPO/other-dir" "$MAIN_REPO/store"
  cp "$SCRIPT_DIR/kanban-comment-lib.sh" "$MAIN_REPO/other-dir/kanban-comment-lib.sh"
  printf 'main-repo-token' > "$MAIN_REPO/store/.dashboard-token"
  git init -q "$CALLER_REPO"
  cd "$CALLER_REPO" || exit 1
  unset KANBAN_COMMENT_TOKEN_FILE
  . "$MAIN_REPO/other-dir/kanban-comment-lib.sh"
  tf="$(_kc_token_file)"
  [ "$tf" = "$MAIN_REPO/store/.dashboard-token" ]
)
check "$?" "_kc_token_file resolves to its own repo's token file from a real (non-worktree) checkout, called from an unrelated repo's cwd"

if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed"
  exit 1
fi
echo "All $CHECKS checks pass."
