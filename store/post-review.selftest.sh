#!/usr/bin/env bash
# Self-test for post-review.sh (card 88b67fb4). No live dashboard: a fake `curl` is prepended to
# PATH that answers from fixed JSON instead of hitting the network, so this runs anywhere.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/post-review.sh"
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A fake curl: decides its answer from the argv it was called with. Logs every call so tests can
# assert "move was never attempted" etc.
cat >"$WORK/curl" <<'STUB'
#!/usr/bin/env bash
echo "CALL: $*" >>"$WORK_LOG"
is_post=0
url=""
for a in "$@"; do
  case "$a" in
    POST) is_post=1 ;;
    http*) url="$a" ;;
  esac
done
case "$url" in
  */comments)
    if [ "$is_post" -eq 1 ]; then
      # find the --data-binary payload
      data=""; prev=""
      for a in "$@"; do [ "$prev" = "--data-binary" ] && data="$a"; prev="$a"; done
      python3 -c '
import json, sys
d = json.loads(sys.argv[1])
d["id"] = 1
print(json.dumps(d))' "$data" | tee "$WORK/posted.json"
    else
      if [ -f "$WORK/posted.json" ] && [ "${MATCH_MODE:-match}" = "match" ]; then
        echo "[$(cat "$WORK/posted.json")]"
      else
        echo "[]"
      fi
    fi
    ;;
  */move)
    echo '{"ok":true}'
    ;;
  *)
    echo '{}'
    ;;
esac
STUB
chmod +x "$WORK/curl"

run() { # $1 label, remaining = args to post-review.sh, env already exported by caller
  WORK_LOG="$WORK/calls.log"; : >"$WORK_LOG"
  export WORK WORK_LOG MATCH_MODE AGENT_CHECKPOINT_SCRIPT AGENT_WORKTREE_SCRIPT
  PATH="$WORK:$PATH" bash "$SCRIPT" "$@"
}

n=0
t_ok()  { n=$((n+1)); if [ "$1" -eq "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 -> expected exit $2, got $1"; fail=1; fi; }

# 1. Blank file refuses BEFORE touching the board at all (no curl call logged).
echo "" >"$WORK/blank.txt"
: >"$WORK/calls.log"
MATCH_MODE=match
rc=0; run "cardX" "$WORK/blank.txt" "backend" >"$WORK/out1.txt" 2>&1 || rc=$?
t_ok "$rc" 1 "blank review file refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL blank file still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   blank file never touched the board"; fi

# 2. Good content, readback matches -> moves to waiting, exit 0.
printf 'REVIEW: all good\nGate-SHA: n/a (config-only)\n' >"$WORK/good.txt"
MATCH_MODE=match
rc=0; run "card1" "$WORK/good.txt" "backend" "gate ready" >"$WORK/out2.txt" 2>&1 || rc=$?
t_ok "$rc" 0 "matching readback moves the card to waiting"
grep -q "/move" "$WORK/calls.log" || { echo "  FAIL move was never attempted on the success path"; fail=1; }

# 3. Readback does NOT match what was posted (simulated garbled/empty body on the board's side) ->
#    refuses, exit 2, and move must NEVER be attempted.
printf 'REVIEW: all good\nGate-SHA: n/a (config-only)\n' >"$WORK/good2.txt"
MATCH_MODE=mismatch
rc=0; run "card2" "$WORK/good2.txt" "backend" >"$WORK/out3.txt" 2>&1 || rc=$?
t_ok "$rc" 2 "mismatched readback refuses with exit 2"
grep -q "/move" "$WORK/calls.log" && { echo "  FAIL move was attempted despite a mismatched readback"; fail=1; } || echo "  ok   move was never attempted after a mismatch"

# 4. L1 delta: invisible-only / too-short bodies refuse before touching the board, same as a
#    fully blank file -- a visually-empty REVIEW should not sail through just because it has a
#    stray byte in it.
printf '\xe2\x80\x8b\xe2\x80\x8b\xe2\x80\x8b' >"$WORK/invisible.txt"   # three U+200B zero-width spaces
: >"$WORK/calls.log"
rc=0; run "card3" "$WORK/invisible.txt" "backend" >"$WORK/out4.txt" 2>&1 || rc=$?
t_ok "$rc" 1 "invisible-only (U+200B) body refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL invisible-only file still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   invisible-only file never touched the board"; fi

printf 'x' >"$WORK/onechar.txt"
: >"$WORK/calls.log"
rc=0; run "card4" "$WORK/onechar.txt" "backend" >"$WORK/out5.txt" 2>&1 || rc=$?
t_ok "$rc" 1 "1-character body refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL 1-char file still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   1-char file never touched the board"; fi

# 5. L1b (WhiteHat NO-GO 28731 delta): the Cf/Cc/Zs-only filter let 6 of 9 invisible probes
#    through -- repeating each probe 12x (WhiteHat's own count) so it clears the old length-10
#    floor and would have sailed through before this fix.
assert_refused() { # $1 label, $2 file, $3 card
  : >"$WORK/calls.log"
  rc=0; run "$3" "$2" "backend" >"$WORK/out-$3.txt" 2>&1 || rc=$?
  t_ok "$rc" 1 "$1 refuses with exit 1"
  if [ -s "$WORK/calls.log" ]; then echo "  FAIL $1 still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   $1 never touched the board"; fi
}
python3 -c "open(r'$WORK/braille.txt','wb').write('⠀'.encode()*12)"
assert_refused "Braille-blank-only (U+2800 x12) body" "$WORK/braille.txt" card5
python3 -c "open(r'$WORK/hangulfiller.txt','wb').write('ㅤ'.encode()*12)"
assert_refused "Hangul-filler-only (U+3164 x12) body" "$WORK/hangulfiller.txt" card6
python3 -c "open(r'$WORK/choseong.txt','wb').write('ᅟ'.encode()*12)"
assert_refused "Hangul-choseong-filler-only (U+115F x12) body" "$WORK/choseong.txt" card7
python3 -c "open(r'$WORK/combining.txt','wb').write(('̀͏️'*4).encode())"
assert_refused "combining-marks-only (U+0300/U+034F/U+FE0F) body" "$WORK/combining.txt" card8

# card 9d1ee327 (CYBERSEC NO-GO 28823 LOW item 4): 3 more blank-rendering characters that still
# passed before this fix -- none are Mark/Separator/Other category, so the old broad-category
# rule alone never caught them, same gap class as L1b above.
python3 -c "open(r'$WORK/hanguljungseong.txt','wb').write('ᅠ'.encode()*12)"
assert_refused "Hangul-jungseong-filler-only (U+1160 x12) body" "$WORK/hanguljungseong.txt" card10
python3 -c "open(r'$WORK/objreplace.txt','wb').write('￼'.encode()*12)"
assert_refused "object-replacement-character-only (U+FFFC x12) body" "$WORK/objreplace.txt" card11
python3 -c "open(r'$WORK/nullnotehead.txt','wb').write('\U0001D159'.encode()*12)"
assert_refused "musical-null-notehead-only (U+1D159 x12) body" "$WORK/nullnotehead.txt" card12

# Visible content must still pass -- this is the non-vacuity check for L1b: ten visible dots
# (WhiteHat's own counter-example) must NOT be refused.
printf '..........\nGate-SHA: n/a (config-only)\n' >"$WORK/dots.txt"
: >"$WORK/calls.log"
MATCH_MODE=match
rc=0; run "card9" "$WORK/dots.txt" "backend" >"$WORK/out-card9.txt" 2>&1 || rc=$?
t_ok "$rc" 0 "ten visible dots (real content) are still accepted, not treated as blank"

# 6. Gate-SHA validation (card 2a15eb5f, 88b67fb4 S1 follow-up, WhiteHat S1 comment 28612).
# Builds a small, local, throwaway git repo so gate-sha-repo.sh's cat-file/merge-base lookups are
# real (not a fake curl), and points MARVEEN_MAIN/CLEANCORE_MAIN at it instead of the live clones.
# GATE_SHA_REPO_NO_BOARD=1 skips the live-board card-id lookup -- a non-commit sha then just comes
# back "unlanded" (rc 3) and is refused as nonexistent, which is the outcome this fixture needs.
GFIX="$WORK/gitfix"
mkdir -p "$GFIX"
git -C "$GFIX" init -q
git -C "$GFIX" config user.email "t@test"
git -C "$GFIX" config user.name "t"
echo "a" >"$GFIX/foo.txt"
git -C "$GFIX" add foo.txt
git -C "$GFIX" commit -q -m "fix(cardA): seed foo"
LANDED_SHA="$(git -C "$GFIX" rev-parse HEAD)"
git -C "$GFIX" update-ref refs/remotes/origin/develop "$LANDED_SHA"
echo "b" >"$GFIX/bar.txt"
git -C "$GFIX" add bar.txt
git -C "$GFIX" commit -q -m "fix(cardA): unlanded follow-up"
UNLANDED_SHA="$(git -C "$GFIX" rev-parse HEAD)"
echo "c" >"$GFIX/baz.txt"
git -C "$GFIX" add baz.txt
git -C "$GFIX" commit -q -m "fix(cardB): unrelated card, different files"
OTHER_CARD_SHA="$(git -C "$GFIX" rev-parse HEAD)"
NONEXISTENT_SHA="0123456789abcdef0123456789abcdef01234567"

echo "fake-token" >"$WORK/fake-token"

run_gs() { # $1 label, $2 content, $3 cardId
  : >"$WORK/calls.log"
  printf '%s' "$2" >"$WORK/gs.txt"
  MATCH_MODE=match
  rc=0
  MARVEEN_MAIN="$GFIX" CLEANCORE_MAIN="$GFIX" GATE_SHA_REPO_NO_BOARD=1 \
    POST_REVIEW_TOKEN_FILE="$WORK/fake-token" \
    run "$3" "$WORK/gs.txt" "backend" >"$WORK/out-gs-$3.txt" 2>&1 || rc=$?
}

# 6a. Missing Gate-SHA line entirely -> refuse, board untouched.
run_gs "missing Gate-SHA line" "REVIEW: did the thing, no sha line at all." gsA
t_ok "$rc" 1 "missing Gate-SHA line refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL missing-Gate-SHA still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   missing-Gate-SHA never touched the board"; fi

# 6b. Nonexistent sha -> refuse, board untouched.
run_gs "nonexistent sha" "REVIEW: done.
Gate-SHA: $NONEXISTENT_SHA" gsB
t_ok "$rc" 1 "nonexistent Gate-SHA refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL nonexistent-sha still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   nonexistent-sha never touched the board"; fi

# 6c. Another card's id, written where a sha belongs -> same shape as a sha, not a commit ->
# refused as nonexistent (with GATE_SHA_REPO_NO_BOARD=1 there is no live board to confirm it is
# a real card id, so it falls through to "unlanded/not-found" exactly like 6b -- same required
# outcome: refuse, board untouched).
run_gs "another card's id instead of a sha" "REVIEW: done.
Gate-SHA: deadbee1" gsC
t_ok "$rc" 1 "card-id-as-sha refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL card-id-as-sha still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   card-id-as-sha never touched the board"; fi

# 6d. Explicit config-only n/a (rule 4e) -> accepted, no warning, posts and moves normally.
run_gs "n/a (config-only)" "REVIEW: config change only.
Gate-SHA: n/a (config-only)" gsD
t_ok "$rc" 0 "n/a (config-only) Gate-SHA is accepted"
grep -qi "WARNING\|REFUSED" "$WORK/out-gs-gsD.txt" && { echo "  FAIL n/a (config-only) produced a warning/refusal: $(cat "$WORK/out-gs-gsD.txt")"; fail=1; } || echo "  ok   n/a (config-only) produced no warning"

# 6e. Unlanded sha (real commit, not yet an ancestor of origin/develop) -> WARNING only, still
# posts and moves to waiting (exit 0).
run_gs "unlanded sha" "REVIEW: done.
Gate-SHA: $UNLANDED_SHA" gsE
t_ok "$rc" 0 "unlanded Gate-SHA still moves to waiting (warning only)"
grep -q "/move" "$WORK/calls.log" || { echo "  FAIL unlanded-sha never attempted the move"; fail=1; }
grep -qi "WARNING.*unlanded" "$WORK/out-gs-gsE.txt" && echo "  ok   unlanded-sha produced the unlanded warning" || { echo "  FAIL unlanded-sha produced no unlanded warning: $(cat "$WORK/out-gs-gsE.txt")"; fail=1; }

# 6f. Landed sha, but its diff touches none of the files any other commit mentioning THIS card
# id ever touched (it is actually cardB's commit, cited on cardA's review by mistake) -> WARNING
# only, still posts and moves (exit 0).
run_gs "sha touches none of the card's files" "REVIEW: done.
Gate-SHA: $OTHER_CARD_SHA" cardA
t_ok "$rc" 0 "wrong-card sha still moves to waiting (warning only)"
grep -q "/move" "$WORK/calls.log" || { echo "  FAIL wrong-card-sha never attempted the move"; fail=1; }
grep -qi "WARNING.*touches none" "$WORK/out-gs-cardA.txt" && echo "  ok   wrong-card-sha produced the touches-none-of-the-files warning" || { echo "  FAIL wrong-card-sha produced no touches-none warning: $(cat "$WORK/out-gs-cardA.txt")"; fail=1; }

# 6g. Non-vacuity: a correctly-landed sha that DOES touch the card's own files -> no warnings.
run_gs "landed sha touching the card's own files" "REVIEW: done.
Gate-SHA: $LANDED_SHA" cardA
t_ok "$rc" 0 "correctly-landed, correctly-attributed sha moves cleanly"
grep -qi "WARNING\|REFUSED" "$WORK/out-gs-cardA.txt" && { echo "  FAIL correct sha produced a warning/refusal: $(cat "$WORK/out-gs-cardA.txt")"; fail=1; } || echo "  ok   correct sha produced no warning"

# 6h-6m (Cybersec NO-GO 29011, N1/N1b): validate_gate_sha used to check only the FIRST
# `Gate-SHA:` line (grep -m1), but gate-closure-check.py's _GATE_SHA_LINE and
# gate-dispatch-check.sh's gate_sha_rx both read EVERY matching line, case-insensitively, with an
# optional bullet prefix and optional space before the colon. A valid first line plus a bogus
# second line in any of those shapes used to pass (rc=0); each must now refuse.
run_gs "second Gate-SHA line bogus" "REVIEW: done.
Gate-SHA: $LANDED_SHA
Gate-SHA: $NONEXISTENT_SHA" cardA
t_ok "$rc" 1 "a bogus second Gate-SHA line refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL second-line-bogus still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   second-line-bogus never touched the board"; fi

run_gs "second line lower-case gate-sha: bogus" "REVIEW: done.
Gate-SHA: $LANDED_SHA
gate-sha: $NONEXISTENT_SHA" cardA
t_ok "$rc" 1 "a lower-case 'gate-sha:' bogus line refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL lower-case-bogus still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   lower-case-bogus never touched the board"; fi

run_gs "second line spaced colon Gate-SHA : bogus" "REVIEW: done.
Gate-SHA: $LANDED_SHA
Gate-SHA : $NONEXISTENT_SHA" cardA
t_ok "$rc" 1 "a spaced-colon 'Gate-SHA :' bogus line refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL spaced-colon-bogus still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   spaced-colon-bogus never touched the board"; fi

run_gs "second line bulleted - Gate-SHA: bogus" "REVIEW: done.
Gate-SHA: $LANDED_SHA
- Gate-SHA: $NONEXISTENT_SHA" cardA
t_ok "$rc" 1 "a bulleted '- Gate-SHA:' bogus line refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL bulleted-bogus still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   bulleted-bogus never touched the board"; fi

run_gs "n/a (config-only) with a trailing bogus sha on the same line" "REVIEW: config change only.
Gate-SHA: n/a (config-only) $NONEXISTENT_SHA" gsL
t_ok "$rc" 1 "n/a plus a trailing sha-shaped token refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL n/a-plus-hex still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   n/a-plus-hex never touched the board"; fi

run_gs "n/a on line 1, bogus Gate-SHA on line 2" "REVIEW: config change only.
Gate-SHA: n/a (config-only)
Gate-SHA: $NONEXISTENT_SHA" gsM
t_ok "$rc" 1 "n/a on line 1 plus a bogus Gate-SHA on line 2 refuses with exit 1"
if [ -s "$WORK/calls.log" ]; then echo "  FAIL n/a-then-bogus still called curl: $(cat "$WORK/calls.log")"; fail=1; else echo "  ok   n/a-then-bogus never touched the board"; fi

# F1.3 (card 14bfc893): a successful REVIEW post records a checkpoint via the (faked) F1.1
# script and POSTs it to the (faked) F1.2 checkpoints endpoint, with sha/head_sha/agent correct.
CKPT_WT="$WORK/ckpt-worktree"
git init -q "$CKPT_WT"
git -C "$CKPT_WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
CKPT_HEAD="$(git -C "$CKPT_WT" rev-parse HEAD)"
CKPT_SHA="0123456789012345678901234567890123456789"

cat >"$WORK/fake-agent-checkpoint.sh" <<FAKECKPT
#!/usr/bin/env bash
echo "refs/mikrob/ckpt/\$2/1 $CKPT_SHA"
FAKECKPT
chmod +x "$WORK/fake-agent-checkpoint.sh"

cat >"$WORK/fake-agent-worktree.sh" <<FAKEWT
#!/usr/bin/env bash
echo "$CKPT_WT"
FAKEWT
chmod +x "$WORK/fake-agent-worktree.sh"

printf 'REVIEW: all good\nGate-SHA: n/a (config-only)\n' >"$WORK/ckpt.txt"
MATCH_MODE=match
: >"$WORK/calls.log"
AGENT_CHECKPOINT_SCRIPT="$WORK/fake-agent-checkpoint.sh"
AGENT_WORKTREE_SCRIPT="$WORK/fake-agent-worktree.sh"
rc=0; run "cardCkpt" "$WORK/ckpt.txt" "backend" >"$WORK/out-ckpt.txt" 2>&1 || rc=$?
t_ok "$rc" 0 "successful REVIEW post with checkpoint wiring still exits 0"
ckpt_call="$(grep '/checkpoints' "$WORK/calls.log" || true)"
n=$((n+1))
if printf '%s' "$ckpt_call" | grep -q "$CKPT_SHA" && printf '%s' "$ckpt_call" | grep -q "$CKPT_HEAD" && printf '%s' "$ckpt_call" | grep -q 'backend'; then
  echo "  ok   checkpoint POST carries the checkpoint sha, head sha, and agent"
else
  echo "  FAIL checkpoint POST missing expected fields: $ckpt_call"; fail=1
fi
n=$((n+1))
if grep -q '/checkpoints' "$WORK/calls.log"; then
  echo "  ok   checkpoint endpoint was actually called"
else
  echo "  FAIL checkpoint endpoint was never called"; fail=1
fi

# F1.3 negative: no worktree resolvable for the actor (fake-agent-worktree.sh prints an empty
# path) -- checkpoint recording is skipped silently, the REVIEW itself still succeeds.
cat >"$WORK/fake-agent-worktree-empty.sh" <<'FAKEWTEMPTY'
#!/usr/bin/env bash
echo ""
FAKEWTEMPTY
chmod +x "$WORK/fake-agent-worktree-empty.sh"
printf 'REVIEW: all good\nGate-SHA: n/a (config-only)\n' >"$WORK/ckptnowt.txt"
: >"$WORK/calls.log"
AGENT_CHECKPOINT_SCRIPT="$WORK/fake-agent-checkpoint.sh"
AGENT_WORKTREE_SCRIPT="$WORK/fake-agent-worktree-empty.sh"
rc=0; run "cardCkptNoWt" "$WORK/ckptnowt.txt" "backend" >"$WORK/out-ckptnowt.txt" 2>&1 || rc=$?
t_ok "$rc" 0 "no resolvable worktree: REVIEW still succeeds (checkpoint recording is best-effort)"
n=$((n+1))
if grep -q '/checkpoints' "$WORK/calls.log"; then
  echo "  FAIL checkpoint endpoint was called despite no worktree"; fail=1
else
  echo "  ok   checkpoint endpoint not called when no worktree resolves"
fi

# Card 06334c7d (CYBERSEC LOW-1, 14bfc893 follow-up): a hung agent-checkpoint.sh must not stall
# the REVIEW -> waiting move. Short timeout for the test; the stub sleeps well past it.
cat >"$WORK/fake-agent-checkpoint-slow.sh" <<'FAKESLOW'
#!/usr/bin/env bash
sleep 30
echo "refs/mikrob/ckpt/x/1 deadbeef"
FAKESLOW
chmod +x "$WORK/fake-agent-checkpoint-slow.sh"
printf 'REVIEW: all good\nGate-SHA: n/a (config-only)\n' >"$WORK/ckptslow.txt"
: >"$WORK/calls.log"
AGENT_CHECKPOINT_SCRIPT="$WORK/fake-agent-checkpoint-slow.sh"
AGENT_WORKTREE_SCRIPT="$WORK/fake-agent-worktree.sh"
POST_REVIEW_CHECKPOINT_TIMEOUT_S=1
export POST_REVIEW_CHECKPOINT_TIMEOUT_S
start="$(date +%s)"
rc=0; run "cardCkptSlow" "$WORK/ckptslow.txt" "backend" >"$WORK/out-ckptslow.txt" 2>&1 || rc=$?
elapsed=$(( $(date +%s) - start ))
unset POST_REVIEW_CHECKPOINT_TIMEOUT_S
t_ok "$rc" 0 "a hung checkpoint call still lets the REVIEW post and the card move to waiting"
n=$((n+1))
if [ "$elapsed" -le 6 ]; then
  echo "  ok   the hung checkpoint call was cut off by the timeout (${elapsed}s, within timeout(1s)+5s)"
else
  echo "  FAIL took ${elapsed}s -- the timeout did not cut off the hung checkpoint call"; fail=1
fi
n=$((n+1))
if grep -q '/checkpoints' "$WORK/calls.log"; then
  echo "  FAIL checkpoint endpoint was called despite the checkpoint call timing out"; fail=1
else
  echo "  ok   checkpoint endpoint not called when agent-checkpoint.sh times out"
fi

# CYBERED C3 / NO-GO 32965 condition 3 (LOW-1 only half met): a plain `timeout N` only bounds a
# KILLABLE hang -- a checkpoint script that traps/ignores SIGTERM is NOT bounded by it (CYBERED
# measured 20s against a 3s limit). `timeout -k 2 N` must still cut this off promptly via SIGKILL.
cat >"$WORK/fake-agent-checkpoint-termignore.sh" <<'FAKETERMIGNORE'
#!/usr/bin/env bash
trap '' TERM
sleep 10
echo "refs/mikrob/ckpt/x/1 deadbeef"
FAKETERMIGNORE
chmod +x "$WORK/fake-agent-checkpoint-termignore.sh"
printf 'REVIEW: all good\nGate-SHA: n/a (config-only)\n' >"$WORK/ckptterm.txt"
: >"$WORK/calls.log"
AGENT_CHECKPOINT_SCRIPT="$WORK/fake-agent-checkpoint-termignore.sh"
AGENT_WORKTREE_SCRIPT="$WORK/fake-agent-worktree.sh"
POST_REVIEW_CHECKPOINT_TIMEOUT_S=1
export POST_REVIEW_CHECKPOINT_TIMEOUT_S
start="$(date +%s)"
rc=0; run "cardCkptTermIgnore" "$WORK/ckptterm.txt" "backend" >"$WORK/out-ckptterm.txt" 2>&1 || rc=$?
elapsed=$(( $(date +%s) - start ))
unset POST_REVIEW_CHECKPOINT_TIMEOUT_S
t_ok "$rc" 0 "a TERM-ignoring checkpoint call still lets the REVIEW post and the card move to waiting"
n=$((n+1))
if [ "$elapsed" -le 6 ]; then
  echo "  ok   the TERM-ignoring checkpoint call was still cut off promptly (${elapsed}s, -k 2 grace)"
else
  echo "  FAIL took ${elapsed}s -- a TERM-ignoring checkpoint call was not bounded (missing -k)"; fail=1
fi
n=$((n+1))
if grep -q '/checkpoints' "$WORK/calls.log"; then
  echo "  FAIL checkpoint endpoint was called despite the TERM-ignoring checkpoint call hanging"; fail=1
else
  echo "  ok   checkpoint endpoint not called when the TERM-ignoring checkpoint call is killed"
fi

# Card 06334c7d (CYBERSEC LOW-3 / CYBERED C2, same finding): in card mode the checkpoint must
# read the CARD worktree's HEAD, not the agent's default worktree -- the fake worktree script
# returns a DIFFERENT (card) worktree when --card is passed, so this proves the card worktree is
# actually preferred, not just accepted as one option among equals.
CKPT_WT_CARD="$WORK/ckpt-worktree-card"
git init -q "$CKPT_WT_CARD"
git -C "$CKPT_WT_CARD" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "card head"
CKPT_HEAD_CARD="$(git -C "$CKPT_WT_CARD" rev-parse HEAD)"
cat >"$WORK/fake-agent-worktree-cardaware.sh" <<FAKEWTCARD
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "--card" ]; then
    echo "$CKPT_WT_CARD"
    exit 0
  fi
done
echo "$CKPT_WT"
FAKEWTCARD
chmod +x "$WORK/fake-agent-worktree-cardaware.sh"
printf 'REVIEW: all good\nGate-SHA: n/a (config-only)\n' >"$WORK/ckptcard.txt"
: >"$WORK/calls.log"
AGENT_CHECKPOINT_SCRIPT="$WORK/fake-agent-checkpoint.sh"
AGENT_WORKTREE_SCRIPT="$WORK/fake-agent-worktree-cardaware.sh"
rc=0; run "cardCkptCard" "$WORK/ckptcard.txt" "backend" >"$WORK/out-ckptcard.txt" 2>&1 || rc=$?
t_ok "$rc" 0 "card-mode checkpoint REVIEW still succeeds"
ckpt_call_card="$(grep '/checkpoints' "$WORK/calls.log" || true)"
n=$((n+1))
if printf '%s' "$ckpt_call_card" | grep -q "$CKPT_HEAD_CARD"; then
  echo "  ok   checkpoint recorded the CARD worktree's HEAD, not the agent default worktree's"
else
  echo "  FAIL checkpoint did not record the card worktree's HEAD: $ckpt_call_card"; fail=1
fi
n=$((n+1))
if printf '%s' "$ckpt_call_card" | grep -q "$CKPT_HEAD"; then
  echo "  FAIL checkpoint recorded the agent DEFAULT worktree's HEAD instead of the card one"; fail=1
else
  echo "  ok   checkpoint did not fall back to the agent default worktree when a card worktree exists"
fi

# CYBERED C2 / NO-GO 32965 condition 1: the REAL agent-checkpoint.sh, not the fake stub above,
# with a card worktree that genuinely DIFFERS from the agent default worktree -- the bug the
# fake-checkpoint tests above cannot see, since they never run the real snapshot logic against
# two different trees. Proves the checkpoint commit's PARENT equals the recorded head_sha (the
# card worktree's HEAD), i.e. the snapshot was taken of the SAME tree that was recorded, not of
# the unrelated default worktree.
CKPT_WT_DEFAULT_REAL="$WORK/ckpt-real-default"
git init -q "$CKPT_WT_DEFAULT_REAL"
git -C "$CKPT_WT_DEFAULT_REAL" config user.email t@t
git -C "$CKPT_WT_DEFAULT_REAL" config user.name t
git -C "$CKPT_WT_DEFAULT_REAL" commit -q --allow-empty -m "default head"
echo def_only_file > "$CKPT_WT_DEFAULT_REAL/def.txt"
git -C "$CKPT_WT_DEFAULT_REAL" add def.txt

CKPT_WT_CARD_REAL="$WORK/ckpt-real-card"
git init -q "$CKPT_WT_CARD_REAL"
git -C "$CKPT_WT_CARD_REAL" config user.email t@t
git -C "$CKPT_WT_CARD_REAL" config user.name t
git -C "$CKPT_WT_CARD_REAL" commit -q --allow-empty -m "card head"
echo card_only_file > "$CKPT_WT_CARD_REAL/card.txt"
CKPT_HEAD_CARD_REAL="$(git -C "$CKPT_WT_CARD_REAL" rev-parse HEAD)"

cat >"$WORK/fake-agent-worktree-realcard.sh" <<FAKEWTREALCARD
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "--card" ]; then
    echo "$CKPT_WT_CARD_REAL"
    exit 0
  fi
done
echo "$CKPT_WT_DEFAULT_REAL"
FAKEWTREALCARD
chmod +x "$WORK/fake-agent-worktree-realcard.sh"

printf 'REVIEW: all good\nGate-SHA: n/a (config-only)\n' >"$WORK/ckptrealcard.txt"
: >"$WORK/calls.log"
AGENT_CHECKPOINT_SCRIPT="$HERE/agent-checkpoint.sh"
AGENT_WORKTREE_SCRIPT="$WORK/fake-agent-worktree-realcard.sh"
MARVEEN_MAIN="$CKPT_WT_DEFAULT_REAL"
export MARVEEN_MAIN
rc=0; run "cafe1234" "$WORK/ckptrealcard.txt" "backend" >"$WORK/out-ckptrealcard.txt" 2>&1 || rc=$?
unset MARVEEN_MAIN
t_ok "$rc" 0 "real agent-checkpoint.sh with a card worktree still lets the REVIEW succeed"

ckpt_call_real="$(grep '/checkpoints' "$WORK/calls.log" || true)"
n=$((n+1))
if printf '%s' "$ckpt_call_real" | grep -q "$CKPT_HEAD_CARD_REAL"; then
  echo "  ok   real checkpoint recorded the card worktree's HEAD as head_sha"
else
  echo "  FAIL real checkpoint did not record the card worktree's HEAD: $ckpt_call_real"; fail=1
fi

# Read the checkpoint commit straight from the ref the REAL script created (in CKPT_WT_CARD_REAL,
# its own repo, not an actual --worktree of another one) -- more robust than parsing the sha back
# out of the logged curl call, whose JSON payload is space-separated by json.dumps' own default
# separators.
ckpt_sha_real="$(git -C "$CKPT_WT_CARD_REAL" for-each-ref "refs/mikrob/ckpt/cafe1234/" --format='%(objectname)' | head -1)"
n=$((n+1))
if [ -n "$ckpt_sha_real" ] && git -C "$CKPT_WT_CARD_REAL" cat-file -e "$ckpt_sha_real" 2>/dev/null \
   && [ "$(git -C "$CKPT_WT_CARD_REAL" rev-parse "$ckpt_sha_real^")" = "$CKPT_HEAD_CARD_REAL" ] \
   && git -C "$CKPT_WT_CARD_REAL" ls-tree -r --name-only "$ckpt_sha_real" | grep -qx card.txt \
   && ! git -C "$CKPT_WT_CARD_REAL" ls-tree -r --name-only "$ckpt_sha_real" | grep -qx def.txt; then
  echo "  ok   checkpoint commit's parent equals head_sha and its tree is the CARD tree (not the default worktree's)"
else
  echo "  FAIL checkpoint commit does not match the recorded head_sha's own tree: sha=$ckpt_sha_real call=$ckpt_call_real"
  fail=1
fi

echo "post-review.sh selftest: $n checks"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"
