#!/usr/bin/env bash
# external-repos-sync-selftest.sh -- controls for the pull() fix in external-repos-sync.sh
# (card 9b9422d1). Fully sandboxed: a throwaway $HOME per case, so the script's own
# $HOME/.claude/external + $HOME/.claude/skills derivation needs no override. Never touches the
# real ~/.claude/external.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/external-repos-sync.sh"
SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT
fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 -> got '$3', expected '$2'"; fail=1; fi; }

mkbare() { # $1 = dir -> a bare repo with one commit on "main", "origin" pointed at it
  git init -q --bare "$1"
  local tmp; tmp="$(mktemp -d)"
  git clone -q "$1" "$tmp"
  git -C "$tmp" -c user.email=a@b -c user.name=t commit -q --allow-empty -m one
  git -C "$tmp" branch -q -M main
  git -C "$tmp" push -q origin main
  rm -rf "$tmp"
  # The bare repo's HEAD symref still points at whatever init.defaultBranch produced (often
  # "master"), a branch that was never created here -- so it dangles even though "main" now has a
  # commit. A later clone of a dangling-HEAD repo checks out nothing and, worse, a subsequent
  # commit on that clone lands on the DANGLING branch name, not "main", so a follow-up push of
  # "main" fails with "src refspec main does not match any". Point HEAD at the branch that is
  # actually populated.
  git --git-dir="$1" symbolic-ref HEAD refs/heads/main
}

run() { # $1 = fake HOME -> runs the real script with that HOME, returns its stdout
  HOME="$1" bash "$SCRIPT" 2>&1
}

echo "external-repos-sync.sh selftest (card 9b9422d1)"

# --- Case 1: clean fast-forward still works -----------------------------------------------------
H1="$SB/home1"; mkdir -p "$H1/.claude/external" "$H1/.claude/skills"
mkbare "$SB/loki-mode.git"
git clone -q "$SB/loki-mode.git" "$H1/.claude/external/loki-mode"
git clone -q "$SB/loki-mode.git" "$SB/loki-mode-advance"
git -C "$SB/loki-mode-advance" -c user.email=a@b -c user.name=t commit -q --allow-empty -m two
git -C "$SB/loki-mode-advance" push -q origin main
out="$(run "$H1")"
if echo "$out" | grep -q "^updated: loki-mode"; then echo "  ok   clean ff-only still updates"
else echo "  FAIL clean ff-only still updates -> $(echo "$out" | grep loki-mode)"; fail=1; fi

# --- Case 2: non-ff divergence (upstream rebased), no local commits -> SAFE RESET ----------------
H2="$SB/home2"; mkdir -p "$H2/.claude/external" "$H2/.claude/skills"
mkbare "$SB/awesome-agent-skills.git"
git clone -q "$SB/awesome-agent-skills.git" "$H2/.claude/external/awesome-agent-skills"
# Simulate an upstream rebase: force-push a DIFFERENT history over main.
git clone -q "$SB/awesome-agent-skills.git" "$SB/aas-rebase"
git -C "$SB/aas-rebase" -c user.email=a@b -c user.name=t commit -q --amend --allow-empty -m "rebased-history"
git -C "$SB/aas-rebase" push -q -f origin main
new_upstream_tip="$(git -C "$SB/aas-rebase" rev-parse HEAD)"
out="$(run "$H2")"
after="$(git -C "$H2/.claude/external/awesome-agent-skills" rev-parse HEAD)"
chk "non-ff, no local commits -> reset to new upstream tip" "$new_upstream_tip" "$after"
if echo "$out" | grep -q "non-ff, reset to"; then echo "  ok   reports the recovery, not a bare 'current'"
else echo "  FAIL missing 'non-ff, reset to' in output: $out"; fail=1; fi

# --- Case 3: non-ff divergence, but the vendored clone has a LOCAL commit -> REFUSE, never reset --
H3="$SB/home3"; mkdir -p "$H3/.claude/external" "$H3/.claude/skills"
mkbare "$SB/claude-code-best-practice.git"
git clone -q "$SB/claude-code-best-practice.git" "$H3/.claude/external/claude-code-best-practice"
git -C "$H3/.claude/external/claude-code-best-practice" -c user.email=a@b -c user.name=t \
  commit -q --allow-empty -m "local-only, must survive"
local_sha="$(git -C "$H3/.claude/external/claude-code-best-practice" rev-parse HEAD)"
git clone -q "$SB/claude-code-best-practice.git" "$SB/ccbp-rebase"
git -C "$SB/ccbp-rebase" -c user.email=a@b -c user.name=t commit -q --amend --allow-empty -m "upstream-diverged"
git -C "$SB/ccbp-rebase" push -q -f origin main
out="$(run "$H3")"
after="$(git -C "$H3/.claude/external/claude-code-best-practice" rev-parse HEAD)"
chk "local commit ahead -> NEVER reset, local commit survives" "$local_sha" "$after"
if echo "$out" | grep -q "DIVERGED (HEAD is not where the last known"; then echo "  ok   reports DIVERGED instead of silently claiming 'current'"
else echo "  FAIL missing the DIVERGED report: $out"; fail=1; fi

# --- Case 4: no upstream tracking configured at all -> reported, never guessed at --------------
H4="$SB/home4"; mkdir -p "$H4/.claude/external" "$H4/.claude/skills"
mkbare "$SB/superpowers.git"
git clone -q "$SB/superpowers.git" "$H4/.claude/external/superpowers"
git -C "$H4/.claude/external/superpowers" branch -q --unset-upstream
# Advance the remote so --ff-only has something to refuse (it fails anyway with no upstream, but
# this keeps the scenario realistic: real drift, not just a config accident).
git clone -q "$SB/superpowers.git" "$SB/sp-advance"
git -C "$SB/sp-advance" -c user.email=a@b -c user.name=t commit -q --allow-empty -m two
git -C "$SB/sp-advance" push -q origin main
out="$(run "$H4")"
if echo "$out" | grep -q "DIVERGED (no upstream tracking branch"; then echo "  ok   no tracking branch -> reported, not silently skipped"
else echo "  FAIL missing the no-tracking-branch report: $out"; fail=1; fi

# --- Case 5: this IS the old bug, proven against a copy of the pre-fix pull() --------------------
# Isolates the ONE line that mattered: `git pull --ff-only --quiet 2>/dev/null` with no exit-status
# check. Same scenario as case 3 (upstream diverged) but through the unguarded old form -- must
# report "current" (the false claim the card measured against the real repos), not DIVERGED.
old_out="$(cd "$H3/.claude/external/claude-code-best-practice" && \
  before=$(git rev-parse HEAD 2>/dev/null); \
  git pull --ff-only --quiet 2>/dev/null; \
  after=$(git rev-parse HEAD 2>/dev/null); \
  [ "$before" != "$after" ] && echo "updated" || echo "current")"
chk "OLD unguarded form falsely reports 'current' on real divergence" "current" "$old_out"

[ $fail -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
