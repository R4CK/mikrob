#!/usr/bin/env bash
# git-object-integrity-monitor.sh -- catch a silently corrupted git object store BEFORE someone
# stumbles into it (cards c6e9758f -> 269ac710 + 07e07bae, merged).
#
# WHY. On 2026-08-13 a `git fetch` in the CleanCore clone on /mnt/h triggered an auto-gc that
# repacked 10282 objects and produced ONE unreadable object. The gc reported nothing, wrote no
# gc.log, and believed it had succeeded. It was found only because backend2 happened to be landing
# a commit at that moment and hit the bad object. Nothing was watching, so a quieter corruption --
# in a repo nobody touched that week -- would have sat there indefinitely and only surfaced when
# the content was needed, which is the worst possible time.
#
# The immediate trigger was mitigated by turning auto-gc off in every repo on that drive, but the
# suspected root cause (a Windows drive mounted through WSL) is not fixed by a git setting: the
# write/read path itself is what produced bad bytes. And the transient-read explanation is an
# explanation, not a proof -- so the defence has to be DETECTION, not the explanation.
#
# WHY fsck AND NOT verify-pack (Cybered's correction, card 07e07bae -- and it was right).
# The first version of this script ran `git verify-pack`, which reads PACKS ONLY. In the CleanCore
# clone the loose objects are the MAJORITY: 7307 files, more bytes than the packed part -- and the
# recovery of this very incident created one. Cybered proved the blind spot by appending garbage to
# a loose object: verify-pack still says OK, fsck says "garbage at end of loose object ... is
# corrupt" and exits 128.
# Measured before switching, so this is not a swap on faith: fsck ALSO catches a corrupted PACKED
# object (pack checksum mismatch + index CRC mismatch, exit 4), so it strictly subsumes verify-pack
# and running both would cost ~85s per sweep for no extra coverage. Both directions are pinned by
# the selftest below.
#
# COST, measured 2026-08-14 over all 14 repos under /mnt/h/LM_Studio_Workdir: 309 seconds total
# (CleanCore alone 149s with its 7307 loose objects; the smallest repos under 5s). That is what
# makes a weekly cadence comfortable.
#
# WHAT IT STILL DOES NOT CHECK: this is object integrity, not repo health. fsck --no-dangling
# deliberately hides unreachable objects (normal after a rebase, and pure noise here). A clean run
# means every object in the store inflates to its own SHA -- not that branches point where you
# expect or that a working tree is intact.
#
# LOUD ON FAILURE. The 2026-08-13 lesson (card 35533cca) is that a control whose only output goes
# into a log nobody reads is decoration, so a failure sends an inter-agent message to MikroB and
# does not rely on anyone opening the log. A clean run stays silent apart from the log line.
#
# Usage:
#   git-object-integrity-monitor.sh            # check, alert on failure
#   git-object-integrity-monitor.sh --dry-run  # report per repo, alert nobody
#   git-object-integrity-monitor.sh --selftest # corrupt throwaway repos and prove detection
#
# Exit: 0 every repo clean | 1 at least one repo failed | 2 bad usage | 3 environment problem
set -uo pipefail

ROOT="/home/neon/marveen"
# Every git repo ANYWHERE under here is checked, at any depth (card 34c4840e). The default is the
# drive the incident happened on.
SCAN_ROOT="${OBJECT_SCAN_ROOT:-${PACK_SCAN_ROOT:-/mnt/h/LM_Studio_Workdir}}"
LOG="${OBJECT_MONITOR_LOG:-$ROOT/store/git-object-integrity-monitor.log}"
# A repo on a slow/flaky mount must not hang the sweep forever; a timeout counts as a FAILURE, not
# a pass, because "we could not read it" is exactly the symptom being hunted. Generous against the
# measured worst case (CleanCore 149s).
PER_REPO_TIMEOUT="${OBJECT_FSCK_TIMEOUT:-900}"
# DISCOVERY has its own timeout, separate from PER_REPO_TIMEOUT: it is a single `find`, not a
# per-repo loop, and on this drive walking the tree is itself slow (measured 2026-08-16: ~134s for
# 15 repos under /mnt/h/LM_Studio_Workdir with node_modules pruned). Generous margin over that.
DISCOVERY_TIMEOUT="${OBJECT_DISCOVERY_TIMEOUT:-600}"
# Card fe2f71ca: on the fleet's busiest clone (90+ concurrent worktrees), Cybered proved on card
# 34c4840e that a `git fsck` mid-fetch can see a ref before its tree is fully written and report
# "missing tree X" for an object that resolves fine seconds later -- 7/7 observed cases had object
# mtimes matching active fetch/merge traffic, and the SAME repo never reproduced the SAME missing
# SHA twice. That is a STRUCTURAL discriminator (a half-written object can only ever look "missing",
# never "garbage at end"/checksum-mismatch, which only real bitrot produces -- 2026-08-13). One retry
# after a short pause turns that race from an immediate false alert into a quiet self-heal, without
# weakening detection of an actually corrupt object (a different failure signature, or one that is
# STILL missing on retry, alerts exactly as before).
RETRY_DELAY="${OBJECT_FSCK_RETRY_DELAY:-10}"

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  --selftest) ;;
  "") ;;
  -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
  *) echo "git-object-integrity-monitor.sh: unknown argument '$1'" >&2; exit 2 ;;
esac

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# --- the check itself, isolated so the selftest runs the SAME code the live path does ------------
# check_repo <repo-dir> -> exit 0 clean / non-zero corrupt; git's own diagnosis on stdout.
# --no-progress keeps the log free of carriage-return spinner noise; --no-dangling drops the
# unreachable-object listing, which is normal history, not damage.
check_repo() {
  timeout "$PER_REPO_TIMEOUT" git -C "$1" fsck --no-dangling --no-progress 2>&1
}

# is_missing_only_failure <fsck-output> -> true iff every non-blank line is a "missing X" line.
# This is exactly the race signature (see RETRY_DELAY above): a half-written object is absent, not
# invalid, so fsck can only ever say "missing", never "garbage"/"mismatch"/"invalid". Anything else
# in the output (even one line) means this is not that race, and must not be retried.
is_missing_only_failure() {
  local out="$1" line
  [ -n "$out" ] || return 1
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      missing\ *) ;;
      *) return 1 ;;
    esac
  done <<< "$out"
  return 0
}

# check_repo_with_retry <repo-dir> [checker=check_repo] -> same contract as check_repo, but a
# missing-only failure gets ONE re-check after RETRY_DELAY before being reported. `checker` is
# swappable so the selftest can prove the retry/no-retry decision deterministically, without a real
# timing race against a flaky mount.
check_repo_with_retry() {
  local repo="$1" checker="${2:-check_repo}" out out2
  if out="$("$checker" "$repo")"; then
    printf '%s' "$out"; return 0
  fi
  if is_missing_only_failure "$out"; then
    sleep "$RETRY_DELAY"
    if out2="$("$checker" "$repo")"; then
      log "self-healed after ${RETRY_DELAY}s retry: $repo (was: $(printf '%s' "$out" | head -1))"
      printf '%s' "$out2"; return 0
    fi
    out="$out2"
  fi
  printf '%s' "$out"; return 1
}

# find_repos <scan-root> -> one repo (working-tree) dir per line, ANY depth (card 34c4840e). The
# old scan was `"$SCAN_ROOT"/*/`, one fixed level -- a clone two levels down (the card's own real
# example, /mnt/h/LM_Studio_Workdir/Mikrobi/marveen/.git) was invisible to it and stayed unwatched.
#
# `-type d -name .git` finds only .git DIRECTORIES -- a worktree's `.git` is a FILE (a gitdir:
# pointer), so it never matches and stays excluded, exactly the card 269ac710 decision this card
# says to keep.
#
# PRUNED, not a bare recursive find, for two reasons:
#   * `-name .git ... -prune` (after printing) stops descent INTO a found repo's own object store --
#     nothing useful lives deeper than the .git dir itself, and objects/pack directories are exactly
#     the large trees this walk has no reason to enter.
#   * `-name node_modules -prune` skips vendored dependency trees, which on a real checkout can bury
#     the walk under thousands of package directories for zero security value (nobody fetches/gcs a
#     vendored copy the way the 2026-08-13 incident happened to a real clone). Measured: WITHOUT this
#     prune the walk did not finish in 60s; WITH it, 15 repos in ~134s.
find_repos() {
  find "$1" -type d -name node_modules -prune -o -type d -name .git -print -prune 2>/dev/null \
    | while IFS= read -r gitdir; do dirname "$gitdir"; done
}
export -f find_repos

if [ "${1:-}" = "--selftest" ]; then
  fails=0
  s() { # s <label> <expect> <got>
    if [ "$3" != "$2" ]; then echo "FAIL: $1 want=[$2] got=[$3]"; fails=$((fails+1)); fi
  }
  command -v git >/dev/null 2>&1 || { echo "selftest SKIPPED: no git"; exit 0; }
  t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
  seed() { # seed <dir> [pack]
    git init -q "$1"
    git -C "$1" config user.email selftest@local
    git -C "$1" config user.name selftest
    for i in 1 2 3; do printf 'content %s\n' "$i" > "$1/f$i.txt"; git -C "$1" add "f$i.txt"; done
    git -C "$1" commit -qm seed >/dev/null 2>&1
    [ "${2:-}" = "pack" ] && git -C "$1" gc -q 2>/dev/null
    return 0
  }
  verdict() { check_repo "$1" >/dev/null 2>&1 && echo clean || echo corrupt; }

  seed "$t/healthy" pack
  s "a healthy repo is clean" "clean" "$(verdict "$t/healthy")"

  # DISCRIMINATOR 1 -- the reason this script is fsck-based at all (Cybered, card 07e07bae).
  # Garbage appended to a LOOSE object: verify-pack, which reads packs only, calls this repo fine.
  # In the CleanCore clone loose objects are the majority (7307 files), so a pack-only sweep would
  # have been blind to most of the store.
  seed "$t/loose"
  loose="$(find "$t/loose/.git/objects" -type f -not -path '*/pack/*' -not -path '*/info/*' | head -1)"
  chmod u+w "$loose" 2>/dev/null; printf 'GARBAGE' >> "$loose"
  s "a corrupted LOOSE object is detected" "corrupt" "$(verdict "$t/loose")"
  packs="$(find "$t/loose/.git/objects/pack" -name '*.idx' 2>/dev/null | wc -l)"
  s "...and that repo has no packs at all, so verify-pack had nothing to look at" "0" "$packs"

  # DISCRIMINATOR 2 -- proves dropping verify-pack costs no coverage. Flip bytes in the MIDDLE of a
  # pack (object data, not the header and not the trailing checksum), which is the "one object went
  # bad" shape the 2026-08-13 incident produced rather than an obviously truncated file.
  seed "$t/packed" pack
  pack="$(ls "$t/packed"/.git/objects/pack/*.pack | head -1)"
  chmod u+w "$pack" 2>/dev/null
  python3 - "$pack" <<'PY'
import sys
path = sys.argv[1]
with open(path, 'r+b') as fh:
    size = len(fh.read())
    fh.seek(size // 2)
    b = fh.read(8)
    fh.seek(size // 2)
    fh.write(bytes((x ^ 0xFF) for x in b))
PY
  s "a corrupted PACKED object is detected too" "corrupt" "$(verdict "$t/packed")"

  # An empty repo is not a failure -- there is simply nothing in the store yet.
  git init -q "$t/empty"
  s "an empty repo is clean, not a failure" "clean" "$(verdict "$t/empty")"

  # --- RECURSIVE DISCOVERY (card 34c4840e) --------------------------------------------------------
  # The real failure this card fixes: the old scan only checked "$SCAN_ROOT"/*/, one fixed level, so
  # a nested clone was invisible to the whole monitor -- not "found but skipped", never even
  # discovered. Reproduces the card's own real example shape (SCAN_ROOT/Mikrobi/marveen/.git).
  disc="$(mktemp -d)"
  mkdir -p "$disc/Mikrobi"
  seed "$disc/Mikrobi/marveen"
  found="$(find_repos "$disc" | sort)"
  s "a repo TWO levels down is discovered (the card's own real example)" \
    "$disc/Mikrobi/marveen" "$found"

  # A node_modules tree is pruned, not walked -- on the real drive this is what keeps discovery
  # from taking many minutes (measured: unpruned did not finish in 60s; pruned, 15 repos in ~134s).
  mkdir -p "$disc/Mikrobi/marveen/node_modules/some-pkg"
  seed "$disc/Mikrobi/marveen/node_modules/some-pkg"
  found="$(find_repos "$disc" | sort)"
  s "a repo nested under node_modules is NOT discovered (pruned for cost, not a real clone)" \
    "$disc/Mikrobi/marveen" "$found"

  # Two repos sharing a leaf name at different depths must not collide in the discovery output --
  # each is its own full path, which is also why the live scan now labels alerts by path, not by
  # basename (a bare "marveen" would not say WHICH marveen).
  mkdir -p "$disc/top-level/marveen" "$disc/Mikrobi"
  seed "$disc/top-level/marveen"
  found="$(find_repos "$disc" | sort)"
  s "two same-named repos at different depths are BOTH discovered, as distinct paths" \
    "$disc/Mikrobi/marveen
$disc/top-level/marveen" "$found"
  rm -rf "$disc"

  # --- RETRY-ON-RACE-SIGNATURE (card fe2f71ca) ----------------------------------------------------
  # `checker` is swapped for a stub so these three cases are deterministic call-count assertions,
  # not a real timing race against sleep/disk -- a race REPRODUCED by chance would be exactly the
  # kind of flaky test this fleet has been burned by before.
  RETRY_DELAY=0
  calls_file="$(mktemp)"

  # Case: fails once with a pure "missing" signature, then succeeds -- must be swallowed as clean,
  # and the retry must actually have happened (proves this isn't just "always report clean").
  echo 0 > "$calls_file"
  self_heals_once() {
    n="$(cat "$calls_file")"; n=$((n + 1)); echo "$n" > "$calls_file"
    if [ "$n" -eq 1 ]; then echo "missing tree deadbeef"; return 1; fi
    return 0
  }
  result="$(check_repo_with_retry "$t/healthy" self_heals_once > /dev/null 2>&1; echo $?)"
  s "a missing-only failure that clears on retry is reported clean" "0" "$result"
  s "...and the retry actually ran (checker called twice)" "2" "$(cat "$calls_file")"

  # Case: still "missing" on the retry too -- this is a REAL persistent absence (or the race just
  # didn't clear in time), and must still be reported corrupt, not silently swallowed forever.
  echo 0 > "$calls_file"
  still_missing() {
    n="$(cat "$calls_file")"; n=$((n + 1)); echo "$n" > "$calls_file"
    echo "missing blob deadbeef"; return 1
  }
  result="$(check_repo_with_retry "$t/healthy" still_missing > /dev/null 2>&1; echo $?)"
  s "a missing-only failure that persists through the retry is still corrupt" "1" "$result"
  s "...checked exactly twice, not retried forever" "2" "$(cat "$calls_file")"

  # Case: a NON-missing signature (real corruption shape) must not be retried at all -- one call,
  # immediate failure, same as before this card. Retrying a genuine corruption would only delay the
  # alert, and (if it ever intermittently read differently) could risk masking it.
  echo 0 > "$calls_file"
  real_corruption() {
    n="$(cat "$calls_file")"; n=$((n + 1)); echo "$n" > "$calls_file"
    echo "garbage at end of loose object deadbeef"; return 1
  }
  result="$(check_repo_with_retry "$t/healthy" real_corruption > /dev/null 2>&1; echo $?)"
  s "a non-missing (real corruption) signature is reported corrupt immediately" "1" "$result"
  s "...and is NEVER retried (checked exactly once)" "1" "$(cat "$calls_file")"

  rm -f "$calls_file"

  [ "$fails" -eq 0 ] && { echo "selftest OK (11 cases)"; exit 0; } || { echo "selftest FAILED: $fails"; exit 1; }
fi

[ -d "$SCAN_ROOT" ] || { echo "git-object-integrity-monitor.sh: cannot read $SCAN_ROOT" >&2; exit 3; }

REPOS_FILE="$(mktemp)"
trap 'rm -f "$REPOS_FILE"' EXIT
if ! timeout "$DISCOVERY_TIMEOUT" bash -c 'find_repos "$1"' _ "$SCAN_ROOT" > "$REPOS_FILE"; then
  # A discovery timeout means the walk itself could not finish, which on this drive IS the symptom
  # (a mount slow/flaky enough to hang a plain `find` is exactly what corrupted an object before).
  # Failing loud here, not falling back to a partial/empty repo list that would silently under-scan.
  log "DISCOVERY TIMEOUT: find under $SCAN_ROOT did not finish within ${DISCOVERY_TIMEOUT}s"
  echo "git-object-integrity-monitor.sh: repo discovery under $SCAN_ROOT timed out after ${DISCOVERY_TIMEOUT}s" >&2
  exit 3
fi

BAD_REPOS=""
DETAIL=""
TOTAL_REPOS=0
STARTED=$(date +%s)
while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  TOTAL_REPOS=$((TOTAL_REPOS + 1))
  # Path relative to SCAN_ROOT, not a bare basename: two nested clones can share a leaf name (the
  # card's own example, .../Mikrobi/marveen vs the top-level CleanCore/marveen-shaped clones), and a
  # bare basename would make an alert ambiguous about which one is actually corrupt.
  name="${repo#"$SCAN_ROOT"/}"
  if out="$(check_repo_with_retry "$repo")"; then
    [ "$DRY" = "1" ] && say "ok   $name"
  else
    BAD_REPOS="$BAD_REPOS $name"
    # git's own first line is the useful part; keep the alert short but specific.
    first="$(printf '%s' "$out" | head -2 | tr '\n' ' ')"
    DETAIL="$DETAIL
  $name: $first"
    [ "$DRY" = "1" ] && say "FAIL $name -- $first"
  fi
done < "$REPOS_FILE"
ELAPSED=$(( $(date +%s) - STARTED ))

if [ -z "$BAD_REPOS" ]; then
  log "clean: $TOTAL_REPOS repos under $SCAN_ROOT (${ELAPSED}s)"
  [ "$DRY" = "1" ] && say "RESULT: clean ($TOTAL_REPOS repos, ${ELAPSED}s)"
  exit 0
fi

log "CORRUPTION:$BAD_REPOS (scanned $TOTAL_REPOS repos under $SCAN_ROOT, ${ELAPSED}s)$DETAIL"
if [ "$DRY" = "1" ]; then
  say "RESULT: CORRUPTION:$BAD_REPOS -- a live run would alert MikroB"
  exit 1
fi

# Token from a 0600 header file, never argv.
HDR=""
if [ -r "$ROOT/store/.dashboard-token" ]; then
  HDR="$(mktemp)"; chmod 600 "$HDR"
  printf 'Authorization: Bearer %s\n' "$(cat "$ROOT/store/.dashboard-token")" > "$HDR"
fi
if [ -n "$HDR" ]; then
  python3 -c 'import json,sys; print(json.dumps({"from":"mikrob","to":"mikrob","content":sys.argv[1]}))' \
"[git-object-integrity-monitor] RIASZTAS: git fsck bukott a(z) $SCAN_ROOT alatt --$BAD_REPOS
$DETAIL

Ez ugyanaz a hibaosztaly, mint a 2026-08-13-i CleanCore-eset (c6e9758f): egy objektum nem inflalodik
vissza a sajat SHA-jara. A tartalom gyakran megvan sertetlenul egy worktree-ben vagy egy masik
klonban -- ELOSZOR azt keresd meg, es SEMMIT ne torolj (a 08-13-i helyreallitas pont igy ment jol).
Reszletek: git -C <repo> fsck --no-dangling" \
    | curl -fsS -m 15 -o /dev/null -H "@$HDR" -H 'Content-Type: application/json' \
        -X POST "http://127.0.0.1:${WEB_PORT:-3420}/api/messages" --data-binary @- 2>/dev/null \
    || log "WARN: could not deliver the corruption alert"
  rm -f "$HDR"
else
  log "WARN: no dashboard token, corruption found but MikroB could not be alerted"
fi
exit 1
