#!/usr/bin/env bash
# Selftest for the 6d46c7d3 round-2 findings. Fully sandboxed: own repo, own worktree, own state/lock
# via CC_* env. The live guard state, lock, marker and cron are never touched.
set -uo pipefail
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cleancore-main-suite-guard.sh"
# NOT under /tmp: the guard itself refuses a temp-rooted worktree (suites silently skip there),
# so a /tmp sandbox proves nothing -- every case fails on that check before reaching the logic.
SB="$(mktemp -d "$HOME/fullstack-guard-ctl-XXXXXX")"
trap 'case "$SB" in "$HOME"/fullstack-guard-ctl-*) rm -rf "$SB";; esac' EXIT
fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; else echo "  FAIL $1 -> got '$3', expected '$2'"; fail=1; fi; }

# --- a repo whose "suite" is a fake vitest we control -------------------------------------------
REPO="$SB/repo"; mkdir -p "$REPO/src"
git init -q "$REPO"; git -C "$REPO" -c user.email=a@b -c user.name=t commit -q --allow-empty -m one
git -C "$REPO" branch -q -M main
TREE="$SB/tree"
git clone -q "$REPO" "$TREE" 2>/dev/null
touch "$TREE/.cleancore-main-suite-guard"        # the ownership marker the destructive path needs
mkdir -p "$TREE/node_modules/.bin"

# The fake vitest prints whatever fixture we point it at.
cat > "$TREE/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
cat "$FAKE_VITEST_OUT"
exit "${FAKE_VITEST_RC:-0}"
EOF
chmod +x "$TREE/node_modules/.bin/vitest"

run() { # $1 = fixture file -> prints the RESULT: line, sets $rc
  # CC_MAIN_GUARD_DASH points at a port nothing listens on. A REGRESSION run alerts the real
  # dashboard by default, and this file's own "regression + poisoned name" case genuinely produces
  # one -- earlier runs of this exact selftest, before this override existed, sent real alert
  # messages to mikrob with a fabricated commit range and a repro path into a since-deleted
  # sandbox. The curl failure is swallowed by the script's own `|| echo (note: ...)` fallback, so
  # this changes nothing else about what the selftest observes.
  FAKE_VITEST_OUT="$1" \
  CC_REPO="$REPO" CC_MAIN_GUARD_TREE="$TREE" \
  CC_MAIN_GUARD_STATE="$SB/state.json" CC_MAIN_GUARD_LOCK="$SB/guard.lock" \
  CC_MAIN_GUARD_DASH="http://127.0.0.1:1" \
    bash "$G" --force 2>/dev/null | sed -n 's/^RESULT:\(.*\)/\1/p' | head -1
}

# --- fixtures, copied from MEASURED real vitest output ------------------------------------------
cat > "$SB/green-poisoned.txt" <<'EOF'
 RUN  v3.2.6 /x
 ✓ src/a.test.ts (11 tests) 20ms
   ✓ x > throws a clear message when it Cannot find package 1ms
 Test Files  1 passed (1)
      Tests  0 failed | 11 passed (11)
EOF
cat > "$SB/red-poisoned.txt" <<'EOF'
 RUN  v3.2.6 /x
   × x > throws a clear message when it Cannot find package 1ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  5 failed | 6 passed (11)
EOF
cat > "$SB/real-infra.txt" <<'EOF'
 RUN  v3.2.6 /x
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/a.test.ts
Error: Failed to load url totally-not-a-real-package (resolved id: x). Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
EOF
cat > "$SB/clean.txt" <<'EOF'
 RUN  v3.2.6 /x
 Test Files  1 passed (1)
      Tests  0 failed | 11 passed (11)
EOF

echo "cleancore-main-suite-guard controls (card 6d46c7d3, round 2)"

# Establish a baseline first, so case 1 compares against something -- a first-ever run answers
# "baseline recorded" no matter what, which would not distinguish the fix from the bug.
run "$SB/clean.txt" >/dev/null

# 1. Cybered blocker: a green run whose TEST NAME carries the phrase must measure, not SETUP-FAIL.
git -C "$REPO" -c user.email=a@b -c user.name=t commit -q --allow-empty -m poisoned
git -C "$TREE" fetch -q origin 2>/dev/null
chk "green run, poisoned test name -> measured" "OK (0 failing, unchanged)" "$(run "$SB/green-poisoned.txt")"

# 1b. The chain: a REAL regression must still be reported even with the poisoned name present.
git -C "$REPO" -c user.email=a@b -c user.name=t commit -q --allow-empty -m two
git -C "$TREE" fetch -q origin 2>/dev/null
chk "regression + poisoned name -> REGRESSION" "REGRESSION" "$(run "$SB/red-poisoned.txt")"

# 1c. Positive control: a REAL module-resolution failure must still be caught.
git -C "$REPO" -c user.email=a@b -c user.name=t commit -q --allow-empty -m three
git -C "$TREE" fetch -q origin 2>/dev/null
chk "real Failed Suites error -> SETUP-FAILED" "SETUP-FAILED" "$(run "$SB/real-infra.txt")"

# 3. A run that collected NOTHING must not be recorded as a clean baseline. `Tests  no tests`
# satisfies the summary check and parses as 0 failures, so without this the guard banks a green
# measurement for a suite that never executed.
cat > "$SB/no-tests.txt" <<'FIX'
 RUN  v3.2.6 /x
 Test Files  1 failed (1)
      Tests  no tests
FIX
git -C "$REPO" -c user.email=a@b -c user.name=t commit -q --allow-empty -m five
git -C "$TREE" fetch -q origin 2>/dev/null
chk "collected no tests -> SETUP-FAILED" "SETUP-FAILED" "$(run "$SB/no-tests.txt")"

# 2. Cybersec SEC-1: no flock on PATH must refuse, not run unlocked.
git -C "$REPO" -c user.email=a@b -c user.name=t commit -q --allow-empty -m four
git -C "$TREE" fetch -q origin 2>/dev/null
mkdir -p "$SB/binmask"
for b in git awk sed grep mktemp cat rm mv printf head tail node bash env dirname basename tr wc date curl; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$SB/binmask/$b"
done
out="$(FAKE_VITEST_OUT="$SB/clean.txt" CC_REPO="$REPO" CC_MAIN_GUARD_TREE="$TREE" \
  CC_MAIN_GUARD_STATE="$SB/state2.json" CC_MAIN_GUARD_LOCK="$SB/guard2.lock" \
  PATH="$SB/binmask" bash "$G" --force 2>&1)"
case "$out" in
  *"flock is not on PATH"*) echo "  ok   no flock -> refuses loudly" ;;
  *) echo "  FAIL no flock -> got: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"; fail=1 ;;
esac

[ $fail -eq 0 ] && { echo "controls: PASS"; exit 0; } || { echo "controls: FAIL"; exit 1; }
