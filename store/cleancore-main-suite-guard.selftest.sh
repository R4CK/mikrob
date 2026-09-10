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
  # CC_MAIN_GUARD_BRANCH=main is REQUIRED here since card 0dadd1e9: the guard now defaults to
  # `origin/main` (the ref the fleet lands on), and this fixture repo IS the origin -- it has no
  # remote at all, so the default cannot resolve. Declaring the sandbox's shape is the point of the
  # override; the cases at the bottom of this file cover the default path against a fixture that
  # DOES have an origin.
  FAKE_VITEST_OUT="$1" \
  CC_REPO="$REPO" CC_MAIN_GUARD_TREE="$TREE" \
  CC_MAIN_GUARD_BRANCH=main \
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


# --- card 0dadd1e9: the guard must measure THE REF THE FLEET LANDS ON -------------------------------
#
# The bug this covers: the default used to be the shared clone's LOCAL `main`, which nothing moves.
# It sat 7 days behind origin/main, so every tick took the "already measured" short-circuit and the
# guard printed STATE:unchanged 1216 times while apps/api went red. A fixture where local main LAGS
# origin/main is therefore the whole test: measuring the local ref is the defect, measuring the
# remote tip is the fix.
UP="$SB/upstream"; mkdir -p "$UP"
git init -q "$UP"
git -C "$UP" -c user.email=a@b -c user.name=t commit -q --allow-empty -m up-one
git -C "$UP" branch -q -M main
REPO2="$SB/clone"
git clone -q "$UP" "$REPO2" 2>/dev/null
mkdir -p "$REPO2/node_modules/.bin"
cat > "$REPO2/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
cat "$FAKE_VITEST_OUT"
exit "${FAKE_VITEST_RC:-0}"
EOF
chmod +x "$REPO2/node_modules/.bin/vitest"
# origin moves; the clone's LOCAL main deliberately does not.
git -C "$UP" -c user.email=a@b -c user.name=t commit -q --allow-empty -m up-two
LOCAL_MAIN="$(git -C "$REPO2" rev-parse main)"

run2() { # $1 = fixture, $2.. = extra env assignments -> prints the first STATE: or RESULT: line
  env FAKE_VITEST_OUT="$1" \
    CC_REPO="$REPO2" CC_MAIN_GUARD_TREE="$SB/tree2" \
    CC_MAIN_GUARD_STATE="$SB/state3.json" CC_MAIN_GUARD_LOCK="$SB/guard3.lock" \
    CC_MAIN_GUARD_DASH="http://127.0.0.1:1" \
    "${@:2}" bash "$G" --force 2>/dev/null | sed -n 's/^\(STATE\|RESULT\):\([a-zA-Z-]*\).*/\2/p' | head -1
}

# 4. THE FIX: with no override, the guard fetches and measures origin/main -- NOT the lagging local
# ref. Asserted on the recorded sha, because "it measured something" is not the claim.
out="$(run2 "$SB/clean.txt")"
chk "default branch -> measures (origin/main)" "measured" "$out"
recorded="$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$SB/state3.json" | head -1)"
chk "records the UPSTREAM tip -- so it fetched" "$(git -C "$UP" rev-parse main)" "$recorded"
[ "$recorded" = "$LOCAL_MAIN" ] && { echo "  FAIL it recorded the lagging local main"; fail=1; }

# 4b. The state file must say WHEN, so "has this thing measured lately" is answerable from outside.
case "$(cat "$SB/state3.json")" in
  *'"measuredAt":'[0-9]*) echo "  ok   state file carries measuredAt" ;;
  *) echo "  FAIL state file has no measuredAt: $(cat "$SB/state3.json")"; fail=1 ;;
esac

# 5. THE ASSERT THAT KEEPS THE FIX FROM ROTTING BACK: pointed at a ref that LAGS origin/main -- an
# inherited env var, or someone restoring the old default -- it must refuse loudly, not measure a
# state nobody lands on, and above all not print the reassuring "unchanged".
out="$(run2 "$SB/clean.txt" CC_MAIN_GUARD_BRANCH=main)"
chk "lagging ref -> refuses" "SETUP-FAILED" "$out"
msg="$(env FAKE_VITEST_OUT="$SB/clean.txt" CC_REPO="$REPO2" CC_MAIN_GUARD_TREE="$SB/tree2" \
  CC_MAIN_GUARD_STATE="$SB/state3.json" CC_MAIN_GUARD_LOCK="$SB/guard3.lock" \
  CC_MAIN_GUARD_DASH="http://127.0.0.1:1" CC_MAIN_GUARD_BRANCH=main bash "$G" --force 2>&1)"
case "$msg" in
  *"behind origin/main"*) echo "  ok   lagging ref -> names the lag" ;;
  *) echo "  FAIL lagging ref -> got: $(printf '%s' "$msg" | head -2 | tr '\n' ' ')"; fail=1 ;;
esac
case "$msg" in
  *"STATE:unchanged"*) echo "  FAIL lagging ref still printed STATE:unchanged"; fail=1 ;;
  *) echo "  ok   lagging ref does not print the reassuring 'unchanged'" ;;
esac

# 5b. CONTROL for case 5: once the local ref CATCHES UP, the same override measures normally -- so
# the refusal above is about the lag, not about the override being present at all.
git -C "$REPO2" fetch -q origin 2>/dev/null
git -C "$REPO2" merge -q --ff-only origin/main 2>/dev/null
out="$(run2 "$SB/clean.txt" CC_MAIN_GUARD_BRANCH=main)"
chk "CONTROL: caught-up ref -> measures again" "measured" "$out"

[ $fail -eq 0 ] && { echo "controls: PASS"; exit 0; } || { echo "controls: FAIL"; exit 1; }
