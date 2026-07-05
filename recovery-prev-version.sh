#!/bin/bash
# Marveen / MikroB -- Recovery to a previous version
#
# Rolls the install back to an earlier known-good commit when an update (or a
# local change) breaks the running system. It is the reverse of update.sh:
# checkout an older commit (detached, non-destructive to the branch), reinstall
# deps + rebuild only if needed, re-stamp the build marker, and restart the
# services -- exactly the way update.sh restarts them (transient systemd scope
# so the restart survives the service self-kill).
#
# Rollback targets, in priority order:
#   1) --to <sha>            explicit commit
#   2) (default)             the version we were on BEFORE the most recent
#                            update, read from store/.update-history (written by
#                            update.sh). If history is empty it errors and shows
#                            `git log` so you can pick a commit with --to.
#
# Runtime data (store/, the SQLite DB, tokens) is gitignored, so a checkout
# never touches it -- your memories/kanban/tokens survive a rollback.
#
# Usage:
#   ./recovery-prev-version.sh                 # roll back to the pre-update version (asks to confirm)
#   ./recovery-prev-version.sh --to <sha>      # roll back to a specific commit
#   ./recovery-prev-version.sh --list          # show recorded rollback points + current HEAD
#   ./recovery-prev-version.sh checkpoint [msg] # record current HEAD as a known-good point (non-destructive)
#   ./recovery-prev-version.sh --dry-run       # print the plan, change nothing
#   ./recovery-prev-version.sh --yes           # skip the confirmation prompt
#
# To go forward again after a rollback:  git checkout <branch> && ./update.sh
set -e

BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'; ORANGE='\033[0;33m'; DIM='\033[2m'; NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"
HIST="$INSTALL_DIR/store/.update-history"
LOG="$INSTALL_DIR/store/recovery.log"
mkdir -p "$INSTALL_DIR/store"

TARGET=""; DRY_RUN=0; ASSUME_YES=0; ACTION="rollback"
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TARGET="$2"; shift 2 ;;
    --to=*) TARGET="${1#*=}"; shift ;;
    --list) ACTION="list"; shift ;;
    checkpoint) ACTION="checkpoint"; CKPT_MSG="${2:-manual}"; shift; [ $# -gt 0 ] && shift || true ;;
    --dry-run|-n) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo -e "${RED}Ismeretlen argumentum:${NC} $1"; exit 2 ;;
  esac
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
CUR_FULL="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
CUR_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

show_history() {
  echo -e "${BOLD}Jelenlegi verzió:${NC} $CUR_SHORT  ${DIM}(${BRANCH})${NC}"
  if [ -s "$HIST" ]; then
    echo -e "${BOLD}Rögzített pontok (store/.update-history):${NC}"
    # columns: ISO_TS  EVENT  BRANCH  FROM_SHA  TO_SHA  NOTE
    awk -F'\t' '{printf "  %s  %-10s %-9s %s -> %s  %s\n",$1,$2,$3,substr($4,1,9),substr($5,1,9),$6}' "$HIST" | tail -20
  else
    echo -e "${ORANGE}Nincs rögzített rollback-pont${NC} (store/.update-history üres vagy hiányzik)."
    echo -e "Válassz commitot a naplóból és add meg: ${BOLD}--to <sha>${NC}"
    echo -e "${DIM}Legutóbbi commitok:${NC}"
    git log --oneline -n 12 || true
  fi
}

# ---- checkpoint: record current HEAD as known-good (non-destructive) ---------
if [ "$ACTION" = "checkpoint" ]; then
  printf '%s\tcheckpoint\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$BRANCH" "$CUR_FULL" "$CUR_FULL" "$CKPT_MSG" >>"$HIST"
  echo -e "${GREEN}✓ Checkpoint rögzítve:${NC} $CUR_SHORT (${BRANCH}) -- \"$CKPT_MSG\""
  log "checkpoint $CUR_FULL ($BRANCH) \"$CKPT_MSG\""
  exit 0
fi

# ---- list -------------------------------------------------------------------
if [ "$ACTION" = "list" ]; then
  show_history; exit 0
fi

# ---- resolve rollback target ------------------------------------------------
if [ -z "$TARGET" ]; then
  # default: the FROM_SHA of the most recent `update` entry = the version we
  # were on before the last update.
  if [ -s "$HIST" ]; then
    TARGET="$(awk -F'\t' '$2=="update"{v=$4} END{print v}' "$HIST")"
  fi
  if [ -z "$TARGET" ]; then
    echo -e "${RED}Nincs automatikus rollback-cél.${NC} Nincs 'update' bejegyzés a történetben."
    echo
    show_history
    echo
    echo -e "Add meg kézzel: ${BOLD}./recovery-prev-version.sh --to <sha>${NC}"
    exit 1
  fi
fi

# validate target exists
if ! git cat-file -e "${TARGET}^{commit}" 2>/dev/null; then
  echo -e "${RED}A cél commit nem létezik:${NC} $TARGET"; exit 1
fi
TARGET_FULL="$(git rev-parse "${TARGET}^{commit}")"
TARGET_SHORT="$(git rev-parse --short "$TARGET_FULL")"

if [ "$TARGET_FULL" = "$CUR_FULL" ]; then
  echo -e "${ORANGE}A cél megegyezik a jelenlegi verzióval${NC} ($CUR_SHORT). Nincs teendő."
  exit 0
fi

echo -e "${BOLD}Visszaállítás:${NC} $CUR_SHORT  ->  $TARGET_SHORT   ${DIM}(${BRANCH})${NC}"
git --no-pager log --oneline -n 1 "$TARGET_FULL" | sed 's/^/  cél: /'
echo -e "${DIM}A store/ (DB, tokenek, memória) érintetlen marad -- gitignored.${NC}"

# does the dependency set change between current and target?
DEPS_CHANGED=0
if ! git diff --quiet "$CUR_FULL" "$TARGET_FULL" -- package.json package-lock.json 2>/dev/null; then
  DEPS_CHANGED=1
fi
echo -e "  Lépések: git checkout (detached) $( [ $DEPS_CHANGED = 1 ] && echo '-> npm ci + better-sqlite3 rebuild' ) -> npm run build -> restart"

if [ "$DRY_RUN" = "1" ]; then
  echo -e "${ORANGE}[--dry-run] Nem történik változás.${NC}"
  echo -e "  git -c advice.detachedHead=false checkout $TARGET_SHORT"
  [ $DEPS_CHANGED = 1 ] && echo -e "  npm ci --silent && npm rebuild better-sqlite3 --build-from-source --silent"
  echo -e "  npm run build --silent && echo $TARGET_FULL > dist/.built-commit"
  echo -e "  systemd-run --user --scope --collect -- bash -c 'stop.sh; start.sh'"
  exit 0
fi

# confirmation (the checkout + restart WILL bounce the live MikroB service,
# which also restarts the mikrob-channels session).
if [ "$ASSUME_YES" != "1" ]; then
  echo
  read -r -p "Biztosan visszaállítod és újraindítod a szolgáltatást? [y/N] " ans
  case "$ans" in y|Y|yes|igen) ;; *) echo "Megszakítva."; exit 0 ;; esac
fi

# From here on we mutate + rebuild. Capture the full output (npm/build too) to
# recovery.log so a failed rollback is inspectable after the fact, mirroring
# update.sh. Placed AFTER the interactive confirm so the tee pipe cannot
# interfere with the prompt.
if : >> "$LOG" 2>/dev/null; then
  exec > >(tee -a "$LOG") 2>&1
fi

log "rollback START $CUR_FULL -> $TARGET_FULL ($BRANCH)"

# record a pre-rollback point so a rollback can itself be undone
printf '%s\trollback\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$BRANCH" "$CUR_FULL" "$TARGET_FULL" "recovery" >>"$HIST"

# stash any local changes (mirror update.sh) so checkout can't be blocked
STASHED=0
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  if git stash push -m "recovery-auto-stash $(date +%Y%m%d-%H%M%S)"; then STASHED=1; fi
fi

git -c advice.detachedHead=false checkout "$TARGET_FULL"

if [ "$DEPS_CHANGED" = "1" ]; then
  echo -e "  Függőségek visszaállítása (npm ci)..."
  npm ci --silent || { echo -e "${RED}npm ci sikertelen. Futtasd kézzel: npm ci${NC}"; }
  npm rebuild better-sqlite3 --build-from-source --silent || true
fi

echo -e "  Fordítás..."
# Guard the build under set -e: if the target commit does not compile, aborting
# here (bare `npm run build`) would leave a half-rolled-back state -- detached at
# the target, services NOT restarted, and an active auto-stash NOT restored.
# Instead: restore the stash, keep the old (in-memory) service running untouched,
# and exit with a clear pointer so the operator can pick another target.
if ! npm run build --silent; then
  echo -e "${RED}HIBA: a fordítás sikertelen a cél commiton (${TARGET_SHORT}).${NC}"
  echo -e "       A checkout megtörtént (detached ${TARGET_SHORT}), de a szolgáltatás NEM indult"
  echo -e "       újra -- a régi, memóriában futó folyamat érintetlen. Válassz másik célt:"
  echo -e "         ./recovery-prev-version.sh --list"
  if [ "$STASHED" = "1" ]; then
    echo -e "  Auto-stash visszaállítása..."
    git stash pop || echo -e "${ORANGE}Auto-stash pop konfliktus; benne marad a 'git stash list'-ben.${NC}"
  fi
  log "rollback BUILD FAILED at $TARGET_FULL (services untouched)"
  exit 1
fi
echo "$TARGET_FULL" > "$INSTALL_DIR/dist/.built-commit"

if [ "$STASHED" = "1" ]; then
  echo -e "  Auto-stash visszaállítása..."
  git stash pop || echo -e "${ORANGE}Auto-stash pop konfliktus; benne marad a 'git stash list'-ben.${NC}"
fi

echo -e "  Szolgáltatások újraindítása..."
if command -v systemd-run >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  systemd-run --user --scope --collect --quiet \
    bash -c '"$1/scripts/stop.sh"; "$1/scripts/start.sh"' _ "$INSTALL_DIR" \
    || { "$INSTALL_DIR/scripts/stop.sh"; "$INSTALL_DIR/scripts/start.sh"; }
else
  "$INSTALL_DIR/scripts/stop.sh"; "$INSTALL_DIR/scripts/start.sh"
fi

log "rollback DONE now at $TARGET_FULL"
echo
echo -e "${GREEN}✓ Visszaállítva: ${CUR_SHORT} -> ${TARGET_SHORT}${NC}"
echo -e "${DIM}Előre lépés újra: git checkout ${BRANCH} && ./update.sh${NC}"
