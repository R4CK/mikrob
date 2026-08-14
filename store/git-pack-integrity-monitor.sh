#!/usr/bin/env bash
# git-pack-integrity-monitor.sh -- catch a silently corrupted git object store BEFORE someone
# stumbles into it (card c6e9758f follow-up, MikroB approved).
#
# WHY. On 2026-08-13 a `git fetch` in the CleanCore clone on /mnt/h triggered an auto-gc that
# repacked 10282 objects and produced ONE unreadable object. The gc reported nothing, wrote no
# gc.log, and believed it had succeeded. It was found only because backend2 happened to be landing
# a commit at that moment and hit the bad object. Nothing was watching, so a quieter corruption --
# in a repo nobody touched that week -- would have sat there indefinitely and only surfaced when
# the content was needed, which is the worst possible time.
#
# The immediate cause was mitigated by turning auto-gc off in every repo on that drive, but the
# suspected root cause (a Windows drive mounted through WSL) is not fixed by a git setting: the
# write/read path itself is what produced bad bytes. So this is the detection half, and it is
# deliberately cheap enough to run weekly and forever.
#
# WHAT IT CHECKS, and what it does NOT. `git verify-pack` on every pack index: it re-inflates each
# packed object and re-derives its SHA, so it detects exactly the damage class seen here. It does
# NOT check loose objects, refs or connectivity -- that is `git fsck`, which costs minutes per repo
# and is the right tool for a follow-up once this one has flagged something. Stated rather than
# implied: a clean run here means "every packed object is intact", not "the repo is healthy".
#
# LOUD ON FAILURE. The 2026-08-13 lesson (card 35533cca) is that a control whose only output goes
# into a log nobody reads is decoration, so a failure sends an inter-agent message to MikroB and
# does not rely on anyone opening the log. A clean run stays silent apart from the log line.
#
# Usage:
#   git-pack-integrity-monitor.sh            # check, alert on failure
#   git-pack-integrity-monitor.sh --dry-run  # report per repo, alert nobody
#   git-pack-integrity-monitor.sh --selftest # corrupt a throwaway repo and prove detection
#
# Exit: 0 all packs verify | 1 at least one pack failed | 2 bad usage | 3 environment problem
set -uo pipefail

ROOT="/home/neon/marveen"
# Every git repo under here is checked. The default is the drive the incident happened on; a
# different root is a plain argument to the env, not a code change.
SCAN_ROOT="${PACK_SCAN_ROOT:-/mnt/h/LM_Studio_Workdir}"
LOG="${PACK_MONITOR_LOG:-$ROOT/store/git-pack-integrity-monitor.log}"
# A pack on a slow/flaky mount must not hang the run forever; a timeout counts as a FAILURE, not a
# pass, because "we could not read it" is exactly the symptom being hunted.
PER_PACK_TIMEOUT="${PACK_VERIFY_TIMEOUT:-600}"

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  --selftest) ;;
  "") ;;
  -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  *) echo "git-pack-integrity-monitor.sh: unknown argument '$1'" >&2; exit 2 ;;
esac

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# --- the check itself, isolated so the selftest runs the SAME code the live path does ------------
# check_repo <repo-dir> -> prints "<packs_checked> <packs_failed>"; nothing on stdout per pack.
check_repo() {
  local repo="$1" idx checked=0 failed=0
  for idx in "$repo"/.git/objects/pack/*.idx; do
    [ -e "$idx" ] || continue
    checked=$((checked + 1))
    timeout "$PER_PACK_TIMEOUT" git -C "$repo" verify-pack "$idx" >/dev/null 2>&1 || failed=$((failed + 1))
  done
  echo "$checked $failed"
}

if [ "${1:-}" = "--selftest" ]; then
  fails=0
  s() { # s <label> <expect> <got>
    if [ "$3" != "$2" ]; then echo "FAIL: $1 want=[$2] got=[$3]"; fails=$((fails+1)); fi
  }
  command -v git >/dev/null 2>&1 || { echo "selftest SKIPPED: no git"; exit 0; }
  t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT

  # A real repo with a real pack: commit, then `git gc` to force the loose objects into one.
  git init -q "$t/repo" 2>/dev/null
  git -C "$t/repo" config user.email selftest@local
  git -C "$t/repo" config user.name selftest
  printf 'hello pack integrity\n' > "$t/repo/a.txt"
  git -C "$t/repo" add a.txt >/dev/null 2>&1
  git -C "$t/repo" commit -qm "seed" >/dev/null 2>&1
  git -C "$t/repo" gc -q 2>/dev/null

  s "a healthy repo verifies" "1 0" "$(check_repo "$t/repo")"

  # THE DISCRIMINATOR. Flip bytes in the middle of the pack, where object data lives -- not the
  # header and not the trailing checksum, so this is the "one object went bad" shape the incident
  # produced, rather than a file that is obviously truncated. Without a mutation like this the
  # healthy case above would pass just as happily against a check that verifies nothing at all.
  pack="$(ls "$t/repo"/.git/objects/pack/*.pack | head -1)"
  chmod u+w "$pack" 2>/dev/null
  size=$(wc -c < "$pack")
  python3 - "$pack" "$size" <<'PY'
import sys
path, size = sys.argv[1], int(sys.argv[2])
with open(path, 'r+b') as fh:
    fh.seek(size // 2)
    b = fh.read(8)
    fh.seek(size // 2)
    fh.write(bytes((x ^ 0xFF) for x in b))
PY
  s "a corrupted pack is detected" "1 1" "$(check_repo "$t/repo")"

  # A repo with no packs at all (everything loose) is not a failure -- it is nothing to check.
  git init -q "$t/loose" 2>/dev/null
  s "a repo with no packs reports nothing to check" "0 0" "$(check_repo "$t/loose")"

  [ "$fails" -eq 0 ] && { echo "selftest OK (3 cases)"; exit 0; } || { echo "selftest FAILED: $fails"; exit 1; }
fi

[ -d "$SCAN_ROOT" ] || { echo "git-pack-integrity-monitor.sh: cannot read $SCAN_ROOT" >&2; exit 3; }

BAD_REPOS=""
TOTAL_PACKS=0
TOTAL_REPOS=0
for dir in "$SCAN_ROOT"/*/; do
  repo="${dir%/}"
  [ -d "$repo/.git" ] || continue
  TOTAL_REPOS=$((TOTAL_REPOS + 1))
  read -r checked failed <<< "$(check_repo "$repo")"
  TOTAL_PACKS=$((TOTAL_PACKS + checked))
  if [ "${failed:-0}" -gt 0 ]; then
    BAD_REPOS="$BAD_REPOS $(basename "$repo"):${failed}/${checked}"
    [ "$DRY" = "1" ] && say "FAIL $(basename "$repo") -- ${failed} of ${checked} packs did not verify"
  else
    [ "$DRY" = "1" ] && say "ok   $(basename "$repo") -- ${checked} packs"
  fi
done

if [ -z "$BAD_REPOS" ]; then
  log "clean: $TOTAL_PACKS packs across $TOTAL_REPOS repos under $SCAN_ROOT"
  [ "$DRY" = "1" ] && say "RESULT: clean ($TOTAL_PACKS packs, $TOTAL_REPOS repos)"
  exit 0
fi

log "CORRUPTION:$BAD_REPOS (scanned $TOTAL_PACKS packs across $TOTAL_REPOS repos under $SCAN_ROOT)"
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
"[git-pack-integrity-monitor] RIASZTAS: serult git pack a(z) $SCAN_ROOT alatt --$BAD_REPOS (repo:hibas/osszes pack).
Ez ugyanaz a hibaosztaly, mint a 2026-08-13-i CleanCore-eset (c6e9758f): a csomagolt objektum nem
inflalodik vissza a sajat SHA-jara. A tartalom gyakran megvan sertetlenul egy worktree-ben vagy loose
objektumkent -- ELOSZOR azt keresd meg, es SEMMIT ne torolj. Reszletek: git -C <repo> fsck --no-dangling.
A monitor csak PACKOKAT nez, loose objektumot/refeket nem." \
    | curl -fsS -m 15 -o /dev/null -H "@$HDR" -H 'Content-Type: application/json' \
        -X POST "http://127.0.0.1:${WEB_PORT:-3420}/api/messages" --data-binary @- 2>/dev/null \
    || log "WARN: could not deliver the corruption alert"
  rm -f "$HDR"
else
  log "WARN: no dashboard token, corruption found but MikroB could not be alerted"
fi
exit 1
