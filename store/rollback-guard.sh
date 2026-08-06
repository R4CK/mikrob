#!/usr/bin/env bash
# Rollback distance-guard (card 980454f7).
#
# WHY THIS EXISTS -- incident 2026-08-06 19:50
# -------------------------------------------
# A stale rollback target sent the live install back 529 commits, to a July-24
# commit (45004ec), on a detached HEAD. It then repeated: 45004ec still carries
# the old store/update-health-watchdog.sh, which re-reads the same stale target
# and rolls back again. Three rollbacks, all to the same SHA, all "successful".
# Nothing was corrupt and nothing errored -- the rollback machinery did exactly
# what it was told, with a target nobody sanity-checked.
#
# The lesson is not "fix that one script". It is that an auto-rollback with an
# unvalidated target is a loaded gun: it preserves uptime while silently
# deleting weeks of forward progress, and it looks like success in every log.
#
# WHAT IT CHECKS
# --------------
# A rollback target is accepted only if all three hold:
#   1. ANCESTRY   -- the target is an ancestor of the current HEAD. A target off
#                    the current history is not "the previous version", it is a
#                    different timeline; restoring it is a merge, not a revert.
#   2. DISTANCE   -- at most $ROLLBACK_GUARD_MAX_DISTANCE commits back (50).
#                    A legitimate "undo the update I just did" is a handful of
#                    commits. Hundreds means the target came from stale state.
#   3. FLOOR      -- the target contains $ROLLBACK_GUARD_MIN_SHA (5bc0983, the
#                    commit that removed the duplicate update-health-watchdog).
#                    Below that line, rolling back re-arms the very loop this
#                    guard exists to stop.
#
# Anything else is REFUSED and escalated to the operator. Refusing is the safer
# failure: a refused rollback leaves a visibly broken version that someone fixes
# today, while a wrong rollback leaves a plausibly-working old version that
# nobody notices for two weeks.
#
# USAGE
#   Library:  . store/rollback-guard.sh
#             if rollback_guard_check "$INSTALL_DIR" "$CUR_SHA" "$TARGET_SHA"; then ... fi
#   CLI:      store/rollback-guard.sh --check <target> [current]   # exit 0 = allowed
#             store/rollback-guard.sh --quarantine-stray [dir]     # boot hygiene
#             store/rollback-guard.sh --selftest                   # no repo needed
#
# Env overrides (tests / forks). A non-numeric MAX_DISTANCE falls back to the
# default instead of disabling the check, and any non-default value is written to
# store/rollback-guard.log -- a weakened control must not be silent.
#   ROLLBACK_GUARD_MAX_DISTANCE   default 50 (non-numeric -> back to 50)
#   ROLLBACK_GUARD_MIN_SHA        default 5bc0983 (empty string disables the floor)
#   ROLLBACK_GUARD_NOTIFY         0 = do not send an operator notification

ROLLBACK_GUARD_DEFAULT_MAX_DISTANCE=50
ROLLBACK_GUARD_DEFAULT_MIN_SHA="5bc09832367c530dbc9796c3efc90d29f54ae728"

ROLLBACK_GUARD_MAX_DISTANCE="${ROLLBACK_GUARD_MAX_DISTANCE:-$ROLLBACK_GUARD_DEFAULT_MAX_DISTANCE}"
# Set explicitly to "" to disable the floor check; unset falls back to the default.
if [ -z "${ROLLBACK_GUARD_MIN_SHA+x}" ]; then
  ROLLBACK_GUARD_MIN_SHA="$ROLLBACK_GUARD_DEFAULT_MIN_SHA"
fi

# A non-numeric threshold makes `[ "$distance" -gt "$MAX" ]` print an integer
# error to stderr and evaluate FALSE -- so the "over the limit, refuse" branch
# never runs and the guard fails OPEN. A typo in a fork or test env would then
# silently disable the only control against a deep rollback (Cybersec NO-GO on
# 0006c5f: MAX=abc / 50x / "  " all ALLOWED the real 529-commit target).
# Validated at USE time, not just at source time, so a caller that sets the
# variable after sourcing is covered too. Same `case` shape the repo already
# uses in scripts/disk-space-guard.sh.
_rg_validate_max() {
  case "$ROLLBACK_GUARD_MAX_DISTANCE" in
    ''|*[!0-9]*)
      echo "[rollback-guard] ervenytelen ROLLBACK_GUARD_MAX_DISTANCE=($ROLLBACK_GUARD_MAX_DISTANCE); vissza a(z) ${ROLLBACK_GUARD_DEFAULT_MAX_DISTANCE}-es alapertekre" >&2
      ROLLBACK_GUARD_MAX_DISTANCE="$ROLLBACK_GUARD_DEFAULT_MAX_DISTANCE" ;;
  esac
}

# A weakened control must never be silent: a permissive override (huge distance
# limit, disabled floor) is exactly the configuration under which a bad rollback
# would sail through, so it leaves a trace to read afterwards.
_rg_config_note() {
  local notes=""
  [ "$ROLLBACK_GUARD_MAX_DISTANCE" = "$ROLLBACK_GUARD_DEFAULT_MAX_DISTANCE" ] || \
    notes="max-distance=$ROLLBACK_GUARD_MAX_DISTANCE"
  if [ "$ROLLBACK_GUARD_MIN_SHA" != "$ROLLBACK_GUARD_DEFAULT_MIN_SHA" ]; then
    notes="${notes:+$notes }floor=${ROLLBACK_GUARD_MIN_SHA:-<kikapcsolva>}"
  fi
  printf '%s' "$notes"
}

# rollback_guard_reason <install_dir> <current_sha> <target_sha>
# Prints an empty string when the rollback is allowed, otherwise a one-line
# human-readable refusal reason. Always exits 0 -- the caller reads the string,
# so this stays usable under `set -e` and inside command substitution.
rollback_guard_reason() {
  local dir="$1" cur="$2" target="$3"
  local reason=""
  _rg_validate_max
  local cfg; cfg="$(_rg_config_note)"
  [ -z "$cfg" ] || echo "[rollback-guard] NEM-ALAPERTELMEZETT konfig: $cfg" >&2

  if [ -z "$target" ]; then
    printf '%s' "nincs rollback-cel (ures SHA)"; return 0
  fi
  if [ -z "$cur" ] || [ "$cur" = "unknown" ]; then
    printf '%s' "a jelenlegi HEAD ismeretlen, a tavolsag nem ellenorizheto"; return 0
  fi
  if ! git -C "$dir" cat-file -e "${target}^{commit}" 2>/dev/null; then
    printf '%s' "a cel commit nem letezik ebben a repoban: $target"; return 0
  fi

  local target_full cur_full
  target_full="$(git -C "$dir" rev-parse "${target}^{commit}" 2>/dev/null)"
  cur_full="$(git -C "$dir" rev-parse "${cur}^{commit}" 2>/dev/null)"
  [ -n "$cur_full" ] || { printf '%s' "a jelenlegi HEAD nem feloldhato: $cur"; return 0; }

  # 1. ancestry
  if ! git -C "$dir" merge-base --is-ancestor "$target_full" "$cur_full" 2>/dev/null; then
    printf '%s' "a cel ($(_rg_short "$dir" "$target_full")) NEM ose a jelenlegi HEAD-nek ($(_rg_short "$dir" "$cur_full"))"
    return 0
  fi

  # 2. distance
  local distance
  distance="$(git -C "$dir" rev-list --count "${target_full}..${cur_full}" 2>/dev/null || echo "")"
  if [ -z "$distance" ]; then
    printf '%s' "a tavolsag nem szamolhato ki ($target -> $cur)"; return 0
  fi
  if [ "$distance" -gt "$ROLLBACK_GUARD_MAX_DISTANCE" ]; then
    printf '%s' "a cel $distance committal van hatra (max $ROLLBACK_GUARD_MAX_DISTANCE) -- ez elavult rollback-cel, nem egy frissites visszavonasa"
    return 0
  fi

  # 3. floor. Skipped (with a note on stderr) when the floor commit is not in
  # this repo -- a fork that never had it cannot be judged against it, and
  # failing there would break every rollback on that fork.
  if [ -n "$ROLLBACK_GUARD_MIN_SHA" ]; then
    if git -C "$dir" cat-file -e "${ROLLBACK_GUARD_MIN_SHA}^{commit}" 2>/dev/null; then
      if ! git -C "$dir" merge-base --is-ancestor "$ROLLBACK_GUARD_MIN_SHA" "$target_full" 2>/dev/null; then
        printf '%s' "a cel regebbi mint a padlo-commit ($(_rg_short "$dir" "$ROLLBACK_GUARD_MIN_SHA")) -- alatta ujra elo a duplikalt update-health-watchdog rollback-hurok"
        return 0
      fi
    else
      echo "[rollback-guard] a padlo-commit ($ROLLBACK_GUARD_MIN_SHA) nincs meg ebben a repoban; a padlo-ellenorzes kimarad" >&2
    fi
  fi

  printf '%s' "$reason"
}

_rg_short() { git -C "$1" rev-parse --short "$2" 2>/dev/null || printf '%s' "$2"; }

# rollback_guard_check <install_dir> <current_sha> <target_sha> [context]
# Returns 0 when the rollback may proceed. On refusal: returns 1, prints the
# reason, records a `rollback-refused` row in store/.update-history, appends to
# store/rollback-guard.log, and best-effort notifies the operator.
rollback_guard_check() {
  local dir="$1" cur="$2" target="$3" context="${4:-rollback}"
  local reason cfg
  reason="$(rollback_guard_reason "$dir" "$cur" "$target")"
  # Record a weakened configuration even when the rollback is ALLOWED -- that is
  # precisely the case where the trace matters afterwards.
  cfg="$(_rg_config_note)"
  if [ -n "$cfg" ]; then
    mkdir -p "$dir/store" 2>/dev/null || true
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] NON-DEFAULT-CONFIG ($context) $cfg" \
      >>"$dir/store/rollback-guard.log" 2>/dev/null || true
  fi
  [ -z "$reason" ] && return 0

  local line="[$(date '+%Y-%m-%d %H:%M:%S')] REFUSED ($context) $cur -> $target :: $reason"
  echo "[rollback-guard] MEGTAGADVA: $reason" >&2
  echo "[rollback-guard] a rendszer a jelenlegi verzion marad; kezi dontes kell (./recovery-prev-version.sh --list)" >&2
  mkdir -p "$dir/store" 2>/dev/null || true
  echo "$line" >>"$dir/store/rollback-guard.log" 2>/dev/null || true
  printf '%s\trollback-refused\t%s\t%s\t%s\t%s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$context" "$cur" "$target" "$reason" \
    >>"$dir/store/.update-history" 2>/dev/null || true

  if [ "${ROLLBACK_GUARD_NOTIFY:-1}" = "1" ] && [ -f "$dir/scripts/notify.sh" ]; then
    bash "$dir/scripts/notify.sh" \
      "🛑 Rollback MEGTAGADVA ($context): $reason. A rendszer a jelenlegi verzion maradt, kezi dontes kell: ./recovery-prev-version.sh --list" \
      >/dev/null 2>&1 || true
  fi
  return 1
}

# rollback_guard_quarantine_stray <install_dir>
# Moves a stray store/update-health-watchdog.sh out of the way. That script was
# removed upstream (v1.23.1) in favour of the integrated store/update-finalize.sh
# and is the loop's second half: it re-reads the same stale target and rolls back
# again after every rollback that lands below the floor commit.
# Any tree new enough to run THIS file has the watchdog deliberately deleted, so
# a copy on disk is stray by construction -- untracked leftovers survive a
# checkout, which is exactly how it came back. Quarantined (moved + de-executed),
# not deleted, so the file is still inspectable afterwards.
rollback_guard_quarantine_stray() {
  local dir="${1:-.}"
  local stray="$dir/store/update-health-watchdog.sh"
  [ -e "$stray" ] || return 0
  local qdir="$dir/store/quarantine"
  mkdir -p "$qdir" 2>/dev/null || true
  local dest="$qdir/update-health-watchdog.sh.$(date +%Y%m%d-%H%M%S)"
  if mv "$stray" "$dest" 2>/dev/null; then
    chmod -x "$dest" 2>/dev/null || true
    echo "stray update-health-watchdog.sh karantenezve: $dest"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] QUARANTINED $stray -> $dest" >>"$dir/store/rollback-guard.log" 2>/dev/null || true
  else
    echo "stray update-health-watchdog.sh megvan, de nem sikerult karantenezni: $stray" >&2
    return 1
  fi
}

# ---- CLI --------------------------------------------------------------------
# Only runs when executed directly, never when sourced.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _rg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  case "${1:-}" in
    --check)
      _rg_cur="${3:-$(git -C "$_rg_dir" rev-parse HEAD 2>/dev/null || echo unknown)}"
      if rollback_guard_check "$_rg_dir" "$_rg_cur" "${2:-}" "cli"; then
        echo "[rollback-guard] OK: ${2:-} elfogadhato rollback-cel"
      else
        exit 1
      fi
      ;;
    --quarantine-stray)
      rollback_guard_quarantine_stray "${2:-$_rg_dir}"
      ;;
    --selftest)
      # Builds a throwaway repo so the guard's three rules are provable without
      # touching (or needing) the real install.
      _rg_tmp="$(mktemp -d)"
      trap 'rm -rf "$_rg_tmp"' EXIT
      git -C "$_rg_tmp" init -q
      git -C "$_rg_tmp" config user.email selftest@local
      git -C "$_rg_tmp" config user.name selftest
      for _i in $(seq 1 12); do
        echo "$_i" > "$_rg_tmp/f"
        git -C "$_rg_tmp" add f
        git -C "$_rg_tmp" commit -q -m "c$_i"
      done
      _rg_head="$(git -C "$_rg_tmp" rev-parse HEAD)"
      _rg_c10="$(git -C "$_rg_tmp" rev-parse HEAD~2)"
      _rg_c1="$(git -C "$_rg_tmp" rev-parse HEAD~11)"
      git -C "$_rg_tmp" checkout -q -b side HEAD~5
      echo side > "$_rg_tmp/g"; git -C "$_rg_tmp" add g; git -C "$_rg_tmp" commit -q -m side
      _rg_side="$(git -C "$_rg_tmp" rev-parse HEAD)"
      _rg_fail=0
      _rg_case() { # name expect_refused reason_substring target maxdist minsha
        local got
        got="$(ROLLBACK_GUARD_MAX_DISTANCE="$5" ROLLBACK_GUARD_MIN_SHA="$6" \
               rollback_guard_reason "$_rg_tmp" "$_rg_head" "$4")"
        if [ "$2" = "1" ] && [ -z "$got" ]; then
          echo "FAIL $1: engedelyezte, pedig meg kellett volna tagadni"; _rg_fail=1; return
        fi
        if [ "$2" = "0" ] && [ -n "$got" ]; then
          echo "FAIL $1: megtagadta ($got)"; _rg_fail=1; return
        fi
        if [ -n "$3" ] && ! printf '%s' "$got" | grep -q "$3"; then
          echo "FAIL $1: rossz indok ($got)"; _rg_fail=1; return
        fi
        echo "ok   $1"
      }
      _rg_case "kozeli os elfogadva"        0 ""            "$_rg_c10"  50 ""
      _rg_case "tul tavoli cel megtagadva"  1 "committal"   "$_rg_c1"    5 ""
      _rg_case "nem-os cel megtagadva"      1 "NEM ose"     "$_rg_side" 50 ""
      _rg_case "nemletezo cel megtagadva"   1 "nem letezik" "deadbeef"  50 ""
      _rg_case "ures cel megtagadva"        1 "ures SHA"    ""          50 ""
      _rg_case "padlo alatti cel megtagadva" 1 "padlo"      "$_rg_c1"   50 "$_rg_c10"
      _rg_case "padlo feletti cel elfogadva" 0 ""           "$_rg_head" 50 "$_rg_c10"
      [ "$_rg_fail" = "0" ] && echo "[rollback-guard] selftest OK"
      exit "$_rg_fail"
      ;;
    *)
      grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 2
      ;;
  esac
fi
