#!/usr/bin/env bash
# Idempotent installer: refuse a push that would publish the live dashboard token.
# Auto-run by scripts/sync-hooks.sh on update.
#
# WHY A HOOK AND NOT A TEST (card 755e576b). The obvious home for a "the token must not be in a
# tracked file" rule is the test suite, and that is exactly where it would be useless: the token
# lives in store/.dashboard-token, which is GITIGNORED, so it does not exist in a worktree -- and
# the suite runs in worktrees. The test would take its skip path and go green forever, vacuous in
# the one environment where it runs. A pre-push hook runs on the live install, where the token
# exists, at the moment the exposure would become permanent.
#
# WHY IT MATTERS MORE THAN THE TRANSCRIPT EXPOSURE. Token rotation is declined on this install (too
# many re-logins), and the mitigation for the transcript copies is permission-hardening. A COMMITTED
# token is a different order of problem: pushed, it is public to everyone with repo access and
# survives in history even after deletion -- and with rotation off the table, undoing it is
# expensive. So this is the one place worth blocking outright.
#
# Override (deliberate, and almost always the wrong answer -- if the token really is in the push,
# rotate it instead of publishing it): ALLOW_TOKEN_IN_PUSH=1 git push ...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)/hooks"
GUARD="$HOOK_DIR/pre-push.d/20-no-dashboard-token-in-push"
DISPATCH="$HOOK_DIR/pre-push"
MARK="marveen-pre-push-dispatcher"
mkdir -p "$HOOK_DIR/pre-push.d"

cat > "$GUARD" <<'EOF'
#!/usr/bin/env bash
# Refuse a push whose commits contain the live dashboard token.
#
# The token is NEVER passed as an argument to anything here: it is fed to grep through a pattern
# file descriptor produced by bash's own `printf` builtin, so it never appears in any process's
# /proc/<pid>/cmdline. (Writing this guard the argv way would leak the very secret it protects.)
set -euo pipefail
ZERO="0000000000000000000000000000000000000000"

ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
TOKEN_FILE="$ROOT/store/.dashboard-token"

# No token on this install -> there is nothing that could be published. This is not a hole: the
# rule is about THIS install's own secret.
[ -r "$TOKEN_FILE" ] || exit 0
TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
# A short/empty token would turn the search into a substring match on noise.
[ "${#TOKEN}" -ge 16 ] || exit 0

fail=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO" ] && continue                 # branch deletion pushes nothing
  if [ "$remote_sha" = "$ZERO" ]; then
    range=("$local_sha" --not --remotes)                 # new branch: only its unpushed commits
  else
    range=("$remote_sha..$local_sha")
  fi

  # FAIL CLOSED: if the range cannot be read we do not know what is being pushed, so we stop.
  if ! payload="$(git log -p --no-color "${range[@]}" -- 2>/dev/null)"; then
    echo "" >&2
    echo "BLOCKED: could not read the commits being pushed to ${remote_ref}, so the dashboard" >&2
    echo "token could not be checked for. Refusing rather than guessing." >&2
    fail=1
    continue
  fi

  if printf '%s' "$payload" | grep -q -F -f <(printf '%s\n' "$TOKEN"); then
    if [ "${ALLOW_TOKEN_IN_PUSH:-0}" = "1" ]; then
      echo "pre-push: ALLOW_TOKEN_IN_PUSH=1 set; publishing the dashboard token to ${remote_ref}." >&2
    else
      echo "" >&2
      echo "BLOCKED: the commits being pushed to ${remote_ref} contain the LIVE dashboard token." >&2
      echo "It is a root-equivalent credential; pushed, it is readable by everyone with repo" >&2
      echo "access and stays in history after any later deletion." >&2
      echo "" >&2
      echo "Find it with:  git log -p ${remote_sha:0:12}..${local_sha:0:12} | grep -F \"\$(cat store/.dashboard-token)\"" >&2
      echo "Then rewrite that commit so the token is read at run time instead:" >&2
      echo "  printf 'Authorization: Bearer %s\\n' \"\$(cat store/.dashboard-token)\" | curl -H @- ..." >&2
      echo "" >&2
      echo "If the token really is already published, ROTATE it -- do not override this." >&2
      fail=1
    fi
  fi
done
exit $fail
EOF
chmod +x "$GUARD"

# The dispatcher: run every executable in pre-push.d/, passing the ref list to each. Written only
# if absent or if some OTHER pre-push hook is in place (which is then preserved as 00-legacy).
if [ ! -f "$DISPATCH" ]; then
  cat > "$DISPATCH" <<'EOF'
#!/usr/bin/env bash
# marveen-pre-push-dispatcher : run every executable in pre-push.d/, passing the ref list to each.
set -euo pipefail
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
payload="$(cat)"
status=0
for h in "$HOOK_DIR"/pre-push.d/*; do
  [ -x "$h" ] || continue
  printf '%s\n' "$payload" | "$h" "$@" || status=1
done
exit $status
EOF
  chmod +x "$DISPATCH"
elif ! grep -q "$MARK" "$DISPATCH"; then
  mv "$DISPATCH" "$HOOK_DIR/pre-push.d/00-legacy-pre-push"
  chmod +x "$HOOK_DIR/pre-push.d/00-legacy-pre-push"
  cat > "$DISPATCH" <<'EOF'
#!/usr/bin/env bash
# marveen-pre-push-dispatcher : run every executable in pre-push.d/, passing the ref list to each.
set -euo pipefail
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
payload="$(cat)"
status=0
for h in "$HOOK_DIR"/pre-push.d/*; do
  [ -x "$h" ] || continue
  printf '%s\n' "$payload" | "$h" "$@" || status=1
done
exit $status
EOF
  chmod +x "$DISPATCH"
fi

echo "✓ token-push guard installed: $GUARD"
