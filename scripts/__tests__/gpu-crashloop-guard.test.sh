#!/bin/bash
# Contract tests for scripts/gpu-crashloop-guard.sh.
# Run: bash scripts/__tests__/gpu-crashloop-guard.test.sh
#
# Exercises the boot-loop detection (short boots + dxg oops + recency +
# baseline), the mask action, the alert cooldown, and the negative controls
# (short-but-not-dxg, dxg-but-not-short, too-few-boots) -- all through the
# real script via its GPU_GUARD_* test hooks (no real journalctl/systemctl/
# Telegram touched).

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/gpu-crashloop-guard.sh"

fresh_case() { local d; d="$TMPDIR_BASE/case-$1"; mkdir -p "$d"; echo "$d"; }

# Writes a `journalctl --list-boots`-shaped fixture: N short (35s) boots with
# a dxg oops, each 5 minutes apart, ending at NOW - END_AGO_SEC (newest last).
# Args: outfile n end_ago_sec
write_short_dxg_boots() {
  local out="$1" n="$2" end_ago="$3"
  python3 - "$out" "$n" "$end_ago" << 'PYEOF'
import sys, datetime
out, n, end_ago = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
now = datetime.datetime.now(datetime.timezone.utc)
lines = []
end = now - datetime.timedelta(seconds=end_ago)
for i in range(n):
    e = end - datetime.timedelta(seconds=(n - 1 - i) * 300)
    s = e - datetime.timedelta(seconds=35)
    idx = f"-{n - i}"
    lines.append(f"{idx} deadbeef{i} {s.strftime('%a %Y-%m-%d %H:%M:%S')} UTC {e.strftime('%a %Y-%m-%d %H:%M:%S')} UTC")
open(out, "w").write("\n".join(lines) + "\n")
PYEOF
}

# Run the guard with an isolated state dir; args: state_dir boots_file kernel_file
run_guard() {
  GPU_GUARD_STATE_DIR="$1" GPU_GUARD_BOOTS_OVERRIDE="$2" GPU_GUARD_KERNEL_LOG_OVERRIDE="$3" \
    GPU_GUARD_ALERT_DRYRUN=1 GPU_GUARD_MASK_DRYRUN=1 bash "$GUARD" 2>&1
}

# Run the guard with the mask path REALLY exercised (no MASK_DRYRUN), against a fake systemctl and
# a fake user-unit directory. This is the seam card d5c05548 added: the fallback it fixes cannot be
# reached under MASK_DRYRUN, which is why the defect survived twelve passing tests.
# Args: state_dir boots_file kernel_file fake_systemctl unit_dir [units]
run_guard_masking() {
  GPU_GUARD_STATE_DIR="$1" GPU_GUARD_BOOTS_OVERRIDE="$2" GPU_GUARD_KERNEL_LOG_OVERRIDE="$3" \
    GPU_GUARD_SYSTEMCTL="$4" GPU_GUARD_USER_UNIT_DIR="$5" GPU_GUARD_UNITS="${6:-ollama.service}" \
    GPU_GUARD_ALERT_DRYRUN=1 bash "$GUARD" 2>&1
}

# A stand-in for systemctl that behaves the way this host really does (measured on a throwaway probe
# unit, card d5c05548): `mask` REFUSES over a regular unit file, and the unit only reports masked
# once a /dev/null symlink is actually in place.
write_fake_systemctl() {
  local path="$1" unit_dir="$2"
  cat > "$path" <<FAKE
#!/bin/bash
# argv: --user <verb> [args...]
shift            # drop --user
verb="\$1"; shift
case "\$verb" in
  stop|daemon-reload) exit 0 ;;
  mask)
    for a in "\$@"; do case "\$a" in --*) continue;; esac; u="\$a"; done
    # The real refusal: a regular file already occupies the path.
    if [ -f "$unit_dir/\$u" ] && [ ! -L "$unit_dir/\$u" ]; then
      echo "Failed to mask unit: File $unit_dir/\$u already exists" >&2
      exit 1
    fi
    ln -sf /dev/null "$unit_dir/\$u"; exit 0 ;;
  show)
    for a in "\$@"; do case "\$a" in --*|-p) continue;; esac; u="\$a"; done
    if [ -L "$unit_dir/\$u" ] && [ "\$(readlink "$unit_dir/\$u")" = /dev/null ]; then
      echo masked
    elif [ -e "$unit_dir/\$u" ]; then
      echo static
    fi
    exit 0 ;;
esac
exit 0
FAKE
  chmod +x "$path"
}

echo "gpu-crashloop-guard tests"
echo "========================="

# ---------------------------------------------------------------------------
# (a) First-ever run only stamps a baseline -- never masks/alerts on whatever
#     crash history already existed before the guard was installed.
# ---------------------------------------------------------------------------
echo ""
echo "(a) First-run baseline, no action"
ST="$(fresh_case a)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"
write_short_dxg_boots "$BOOTS" 5 60
echo "dxgk_ioctl fault dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "first run -- baseline stamped"; then pass "first run: baseline stamped, no verdict"; else fail "first run: unexpected output: $OUT"; fi
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN\|ALERT_DRYRUN"; then fail "first run: must NOT act on pre-install history"; else pass "first run: no mask/alert on pre-install history"; fi
[ -f "$ST/.gpu-crashloop-guard-baseline" ] && pass "first run: baseline file written" || fail "first run: baseline file missing"

# ---------------------------------------------------------------------------
# (b) Crash-loop AFTER baseline (>= 3 short + dxg-oops boots, recent) -> mask + alert
# ---------------------------------------------------------------------------
echo ""
echo "(b) Crash-loop detected after baseline"
ST="$(fresh_case b)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"
echo "$(($(date +%s) - 3600))" > "$ST/.gpu-crashloop-guard-baseline"   # installed well before these boots
write_short_dxg_boots "$BOOTS" 4 60
echo "dxgk_ioctl fault dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "GPU crash-loop DETECTED"; then pass "detect: crash-loop found"; else fail "detect: not found: $OUT"; fi
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN: ollama.service"; then pass "detect: ollama.service masked"; else fail "detect: mask not issued"; fi
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then pass "detect: owner alerted"; else fail "detect: no alert"; fi
[ -f "$ST/.gpu-crashloop-guard-masked.json" ] && pass "detect: masked-state flag written" || fail "detect: masked-state flag missing"

# ---------------------------------------------------------------------------
# (c) Alert cooldown -> immediate second detection re-masks (idempotent) but
#     suppresses the repeat alert.
# ---------------------------------------------------------------------------
echo ""
echo "(c) Alert cooldown"
OUT2="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT2" | grep -q "MASK_DRYRUN"; then pass "cooldown: still (idempotently) masks"; else fail "cooldown: mask skipped unexpectedly"; fi
if printf '%s' "$OUT2" | grep -q "ALERT_DRYRUN"; then fail "cooldown: re-alerted within the hour"; else pass "cooldown: repeat alert suppressed"; fi

# ---------------------------------------------------------------------------
# (d) Negative control -- short boots WITHOUT the dxg oops signature (e.g. a
#     host sleep/resume or manual `wsl --shutdown`) must NOT trigger a mask.
# ---------------------------------------------------------------------------
echo ""
echo "(d) Short boots without dxg signature -> no action"
ST="$(fresh_case d)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel_clean.txt"
date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 60
echo "unrelated kernel line, nothing about a GPU fault" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN\|ALERT_DRYRUN"; then fail "negative: masked/alerted without a dxg oops"; else pass "negative: no action without a dxg oops"; fi

# ---------------------------------------------------------------------------
# (e) Negative control -- too few short boots (below MIN_SHORT_BOOTS) -> no action
# ---------------------------------------------------------------------------
echo ""
echo "(e) Too few short boots -> no action"
ST="$(fresh_case e)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"
date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 2 60
echo "dxgk_ioctl fault dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN\|ALERT_DRYRUN"; then fail "too-few: masked/alerted on only 2 short boots"; else pass "too-few: no action below the 3-boot threshold"; fi

# ---------------------------------------------------------------------------
# (f) Negative control -- crash-loop history exists but is OLD (outside the
#     recency window) -> no action.
# ---------------------------------------------------------------------------
echo ""
echo "(f) Old crash-loop history -> no action"
ST="$(fresh_case f)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"
date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 7200   # ended 2h ago, well outside the 30min window
echo "dxgk_ioctl fault dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard "$ST" "$BOOTS" "$KERN")"
if printf '%s' "$OUT" | grep -q "MASK_DRYRUN\|ALERT_DRYRUN"; then fail "stale: masked/alerted on a 2h-old crash-loop"; else pass "stale: no action on a stale crash-loop"; fi

# ---------------------------------------------------------------------------
echo ""
# ---------------------------------------------------------------------------
# (g) THE MASK THAT NEVER HAPPENED (card d5c05548). A regular unit file at the
#     path makes `systemctl --user mask` refuse -- measured on this host, with
#     --force refusing identically. The old code logged that and wrote a state
#     flag naming the unit as masked anyway, so the protection was apparent
#     only: stopped, never masked, re-armable by any `systemctl --user start`.
#     Reachable ONLY without MASK_DRYRUN, which is why twelve green tests
#     never saw it.
# ---------------------------------------------------------------------------
echo ""
echo "(g) mask over a REAL unit file falls back and is verified"
ST="$(fresh_case g)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"; UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
printf '[Unit]\nDescription=probe\n' > "$UNITS_DIR/ollama.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
date -d '-1 day' +%s > "$ST/.gpu-crashloop-guard-baseline" 2>/dev/null || date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 60
echo "dxgk_ioctl: dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard_masking "$ST" "$BOOTS" "$KERN" "$SCTL" "$UNITS_DIR")"
[ -L "$UNITS_DIR/ollama.service" ] && [ "$(readlink "$UNITS_DIR/ollama.service")" = /dev/null ] \
  && pass "fallback: the /dev/null symlink is in place" \
  || fail "fallback: unit is not a /dev/null symlink"
[ -f "$UNITS_DIR/ollama.service.real-unit-backup" ] \
  && pass "fallback: the real unit file is preserved as .real-unit-backup" \
  || fail "fallback: real unit file lost"
echo "$OUT" | grep -q "verified" \
  && pass "fallback: the guard says VERIFIED, not just that it ran mask" \
  || fail "fallback: no verification in the log ($OUT)"
grep -q '"units": "ollama.service"' "$ST/.gpu-crashloop-guard-masked.json" 2>/dev/null \
  && pass "fallback: the state flag names the unit that is genuinely masked" \
  || fail "fallback: state flag missing or wrong"

# ---------------------------------------------------------------------------
# (h) NOTHING MASKED -> NO FLAG, AND A LOUD ALERT. The flag is consumed by the
#     landing gate (card 970156ce): a flag claiming a mask that never happened
#     would make that gate go quiet about an unprotected machine. So the
#     failure has to be loud and flagless, not quietly reassuring.
# ---------------------------------------------------------------------------
echo ""
echo "(h) a mask that cannot take writes NO flag and alerts"
ST="$(fresh_case h)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"; UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
# No unit file at all: mask "succeeds" into a symlink the fake then cannot see as a unit... so make
# it genuinely unmaskable instead -- a DIRECTORY at the path defeats both mask and the fallback.
mkdir -p "$UNITS_DIR/ollama.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
date -d '-1 day' +%s > "$ST/.gpu-crashloop-guard-baseline" 2>/dev/null || date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 60
echo "dxgk_ioctl: dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard_masking "$ST" "$BOOTS" "$KERN" "$SCTL" "$UNITS_DIR")"
[ ! -f "$ST/.gpu-crashloop-guard-masked.json" ] \
  && pass "no-mask: NO state flag is written when nothing could be masked" \
  || fail "no-mask: a state flag was written for a protection that does not exist"
echo "$OUT" | grep -q "ALERT_DRYRUN" && echo "$OUT" | grep -qi "NINCS védve\|NINCS vedve" \
  && pass "no-mask: the owner is told the machine is NOT protected" \
  || fail "no-mask: no alert about the unprotected machine ($OUT)"

# ---------------------------------------------------------------------------
# (i) THE FLAG LISTS ONLY WHAT IS VERIFIED. Two units, one maskable and one
#     not: the artefact must name the first and not the second, because every
#     consumer reads it as a statement of fact.
# ---------------------------------------------------------------------------
echo ""
echo "(i) the flag lists only the units actually masked"
ST="$(fresh_case i)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"; UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR" "$UNITS_DIR/stubborn.service"
printf '[Unit]\nDescription=probe\n' > "$UNITS_DIR/ollama.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
date -d '-1 day' +%s > "$ST/.gpu-crashloop-guard-baseline" 2>/dev/null || date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 60
echo "dxgk_ioctl: dxgadapter_release_lock_shared" > "$KERN"
run_guard_masking "$ST" "$BOOTS" "$KERN" "$SCTL" "$UNITS_DIR" "ollama.service stubborn.service" >/dev/null
grep -q '"units": "ollama.service"' "$ST/.gpu-crashloop-guard-masked.json" 2>/dev/null \
  && pass "partial: the flag names the masked unit" \
  || fail "partial: the flag does not name the masked unit"
grep -q 'stubborn.service' "$ST/.gpu-crashloop-guard-masked.json" 2>/dev/null \
  && fail "partial: the flag claims a unit that was NOT masked" \
  || pass "partial: the flag does NOT claim the unit that could not be masked"

# ---------------------------------------------------------------------------
# (j) AN EXISTING BACKUP IS NOT OVERWRITTEN. Running twice, or running after a
#     hand-made mitigation, must never destroy the only copy of the real unit.
# ---------------------------------------------------------------------------
echo ""
echo "(j) an existing .real-unit-backup is never overwritten"
ST="$(fresh_case j)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"; UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
printf '[Unit]\nDescription=NEW\n' > "$UNITS_DIR/ollama.service"
printf '[Unit]\nDescription=ORIGINAL\n' > "$UNITS_DIR/ollama.service.real-unit-backup"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
date -d '-1 day' +%s > "$ST/.gpu-crashloop-guard-baseline" 2>/dev/null || date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 60
echo "dxgk_ioctl: dxgadapter_release_lock_shared" > "$KERN"
run_guard_masking "$ST" "$BOOTS" "$KERN" "$SCTL" "$UNITS_DIR" >/dev/null
grep -q ORIGINAL "$UNITS_DIR/ollama.service.real-unit-backup" \
  && pass "backup: the pre-existing backup is intact" \
  || fail "backup: the pre-existing backup was overwritten"

# ---------------------------------------------------------------------------
# (k) THE ALERT CARRIES THE REAL RESTORE COMMAND. Measured: `unmask` alone
#     removes the /dev/null symlink and stops, leaving the unit not-found --
#     the real file is still sitting under its .real-unit-backup name. The
#     owner reads the alert, not the source.
# ---------------------------------------------------------------------------
echo ""
echo "(k) the alert says how to actually restore the unit"
ST="$(fresh_case k)"
BOOTS="$ST/boots.txt"; KERN="$ST/kernel.txt"; UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
printf '[Unit]\nDescription=probe\n' > "$UNITS_DIR/ollama.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
date -d '-1 day' +%s > "$ST/.gpu-crashloop-guard-baseline" 2>/dev/null || date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$BOOTS" 4 60
echo "dxgk_ioctl: dxgadapter_release_lock_shared" > "$KERN"
OUT="$(run_guard_masking "$ST" "$BOOTS" "$KERN" "$SCTL" "$UNITS_DIR")"
# THE ASSERTION IS ON THE ALERT LINE, NOT ON THE WHOLE OUTPUT, and that distinction was measured
# rather than reasoned: the first version grepped $OUT for "real-unit-backup" and stayed GREEN when
# the restore command was deleted from the alert -- because mask_one's own LOG line mentions the
# backup path too. A coarser assertion than the behaviour pins whichever guard happens to fire
# first, and here that was the wrong one. The owner reads the ALERT.
ALERT_LINE="$(echo "$OUT" | grep "ALERT_DRYRUN" | head -1)"
[ -n "$ALERT_LINE" ] \
  && echo "$ALERT_LINE" | grep -q "real-unit-backup" \
  && echo "$ALERT_LINE" | grep -q "unmask" \
  && pass "alert: the ALERT itself carries the full restore command, not just unmask" \
  || fail "alert: a bare unmask would lose the unit and the ALERT does not say so ($ALERT_LINE)"

# ---------------------------------------------------------------------------
# THE FLAG HAS TO DESCRIBE THE MACHINE NOW (Cybersec on card 970156ce, folded
# into d5c05548 by MikroB). The flag is consumed by the landing gate as "the
# guard is deliberately holding ollama down, so skip these two routing cases".
# Nothing ever deleted it, so after the documented end of an incident -- a human
# unmasks -- those cases would be skipped forever on a healthy machine, silently.
# These cases run the guard with NO crash-loop signature, i.e. the ordinary path
# a recovered machine takes from then on.
# ---------------------------------------------------------------------------
# A boots fixture that does NOT trigger detection: one short boot is below
# MIN_SHORT_BOOTS, so the guard reaches its "no signature" branch.
quiet_case() {
  local st="$1"
  write_short_dxg_boots "$st/boots.txt" 1 60
  echo "nothing interesting here" > "$st/kernel.txt"
  date -d '-1 day' +%s > "$st/.gpu-crashloop-guard-baseline" 2>/dev/null || date +%s > "$st/.gpu-crashloop-guard-baseline"
}

echo ""
echo "(l) a still-masked unit keeps its flag"
ST="$(fresh_case l)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
ln -s /dev/null "$UNITS_DIR/ollama.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
quiet_case "$ST"
echo '{"detected_at": 1, "short_boots": 4, "units": "ollama.service", "reason": "dxgkrnl GPU-passthrough crash-loop"}' > "$ST/.gpu-crashloop-guard-masked.json"
OUT="$(run_guard_masking "$ST" "$ST/boots.txt" "$ST/kernel.txt" "$SCTL" "$UNITS_DIR")"
grep -q '"units": "ollama.service"' "$ST/.gpu-crashloop-guard-masked.json" 2>/dev/null \
  && pass "reconcile: a genuinely masked unit keeps its flag" \
  || fail "reconcile: the flag was dropped for a unit that IS masked ($OUT)"

echo ""
echo "(m) a MANUAL unmask deletes the flag"
ST="$(fresh_case m)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
# What the documented restore leaves behind: a real unit file back at the path.
printf '[Unit]\nDescription=restored by hand\n' > "$UNITS_DIR/ollama.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
quiet_case "$ST"
echo '{"detected_at": 1, "short_boots": 4, "units": "ollama.service", "reason": "dxgkrnl GPU-passthrough crash-loop"}' > "$ST/.gpu-crashloop-guard-masked.json"
OUT="$(run_guard_masking "$ST" "$ST/boots.txt" "$ST/kernel.txt" "$SCTL" "$UNITS_DIR")"
[ ! -f "$ST/.gpu-crashloop-guard-masked.json" ] \
  && pass "reconcile: the flag is REMOVED once the unit is no longer masked" \
  || fail "reconcile: the flag outlived the mask -- the routing cases stay skipped forever ($OUT)"
echo "$OUT" | grep -q "flag REMOVED" \
  && pass "reconcile: the removal is stated in the log, not silent" \
  || fail "reconcile: nothing in the log says the flag was removed ($OUT)"

echo ""
echo "(n) a partial unmask keeps only what is still true"
ST="$(fresh_case n)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
ln -s /dev/null "$UNITS_DIR/ollama.service"
printf '[Unit]\nDescription=back\n' > "$UNITS_DIR/other.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
quiet_case "$ST"
echo '{"detected_at": 1, "short_boots": 4, "units": "ollama.service other.service", "reason": "dxgkrnl GPU-passthrough crash-loop"}' > "$ST/.gpu-crashloop-guard-masked.json"
run_guard_masking "$ST" "$ST/boots.txt" "$ST/kernel.txt" "$SCTL" "$UNITS_DIR" >/dev/null
grep -q '"units": "ollama.service"' "$ST/.gpu-crashloop-guard-masked.json" 2>/dev/null \
  && pass "reconcile: the still-masked unit survives" \
  || fail "reconcile: the still-masked unit was dropped"
grep -q 'other.service' "$ST/.gpu-crashloop-guard-masked.json" 2>/dev/null \
  && fail "reconcile: the flag still claims a unit that is NOT masked" \
  || pass "reconcile: the unmasked unit is gone from the flag"

echo ""
echo "(o) an UNREADABLE flag is left alone, not treated as refuted"
ST="$(fresh_case o)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
printf '[Unit]\nDescription=back\n' > "$UNITS_DIR/ollama.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
quiet_case "$ST"
printf 'this is not json at all\n' > "$ST/.gpu-crashloop-guard-masked.json"
OUT="$(run_guard_masking "$ST" "$ST/boots.txt" "$ST/kernel.txt" "$SCTL" "$UNITS_DIR")"
[ -f "$ST/.gpu-crashloop-guard-masked.json" ] \
  && pass "reconcile: a flag we cannot parse is not a flag we can refute -- kept" \
  || fail "reconcile: an unparseable flag was deleted"
echo "$OUT" | grep -qi "unreadable\|malformed" \
  && pass "reconcile: the unreadable flag is reported, not swallowed" \
  || fail "reconcile: nothing said the flag could not be read ($OUT)"

echo ""
echo "(p) MASK_DRYRUN must not reconcile a flag a REAL run wrote"
ST="$(fresh_case p)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
# The unit is NOT masked here, so a reconcile WOULD delete the flag -- that is what makes this a
# real control. Without the fake systemctl the guard would ask the HOST about ollama.service, which
# on this machine genuinely IS masked, and the case would pass no matter what the code did (measured:
# the dry-run mutant survived exactly that way).
printf '[Unit]\nDescription=not masked\n' > "$UNITS_DIR/ollama.service"
write_fake_systemctl "$SCTL" "$UNITS_DIR"
quiet_case "$ST"
echo '{"detected_at": 1, "short_boots": 4, "units": "ollama.service", "reason": "dxgkrnl GPU-passthrough crash-loop"}' > "$ST/.gpu-crashloop-guard-masked.json"
GPU_GUARD_SYSTEMCTL="$SCTL" GPU_GUARD_USER_UNIT_DIR="$UNITS_DIR" \
  run_guard "$ST" "$ST/boots.txt" "$ST/kernel.txt" >/dev/null
[ -f "$ST/.gpu-crashloop-guard-masked.json" ] \
  && pass "reconcile: a dry run masks nothing, so it deletes nothing" \
  || fail "reconcile: a DRY RUN deleted a real run's flag"

# ---------------------------------------------------------------------------
# (q) THE RESTORE IS ASKABLE, not buried in a source comment (MikroB's point 3
#     on d5c05548). Measured: `unmask` alone removes the /dev/null symlink and
#     stops, leaving the unit at LoadState=not-found -- the service is gone, not
#     restored. Whoever needs that fact is mid-incident.
# ---------------------------------------------------------------------------
echo ""
echo "(q) --restore-hint prints the command that actually works"
ST="$(fresh_case q)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
echo '{"detected_at": 1, "short_boots": 4, "units": "ollama.service", "reason": "dxgkrnl GPU-passthrough crash-loop"}' > "$ST/.gpu-crashloop-guard-masked.json"
OUT="$(GPU_GUARD_STATE_DIR="$ST" GPU_GUARD_SYSTEMCTL="$SCTL" GPU_GUARD_USER_UNIT_DIR="$UNITS_DIR" bash "$GUARD" --restore-hint 2>&1)"
echo "$OUT" | grep -q "real-unit-backup" \
  && pass "restore-hint: names the backup file the restore depends on" \
  || fail "restore-hint: no backup file in the output ($OUT)"
echo "$OUT" | grep -qi "not enough" \
  && pass "restore-hint: says a plain unmask is NOT enough" \
  || fail "restore-hint: does not warn that unmask alone loses the unit ($OUT)"
echo "$OUT" | grep -q "MASK_DRYRUN\|crash-loop DETECTED" \
  && fail "restore-hint: ran a guard cycle instead of just answering" \
  || pass "restore-hint: answers without running a detection cycle"

# ---------------------------------------------------------------------------
# (r) THE HEADER NO LONGER ADVERTISES A LAYER THAT DOES NOT EXIST. Measured on
#     2026-09-06: ~/.config/systemd/user/ollama.service.d/ does not exist; Peti
#     removed the CPU-only drop-in on 2026-08-24 wanting GPU as the primary
#     path. A reader deciding how hard this guard must try would otherwise
#     believe a stronger mitigation stands behind it. This is a PROSE claim, so
#     it is pinned as prose (CLAUDE.md code-quality rule 12's stated exception).
# ---------------------------------------------------------------------------
echo ""
echo "(r) the header does not claim a layer 1 that is gone"
grep -q "This is layer 2 of the defense" "$GUARD" \
  && fail "header: still calls itself layer 2 under a drop-in that was removed on purpose" \
  || pass "header: no longer claims to be the second layer of two"
grep -q "THERE IS NO LAYER 1 TODAY" "$GUARD" \
  && pass "header: states that this guard is the only layer" \
  || fail "header: does not say what the actual situation is"

# ---------------------------------------------------------------------------
# (s)-(u) "SYSTEMD COULD NOT BE ASKED" IS NOT "NOT MASKED" (Cybersec F-1/F-2 on
#         Gate-SHA e2be6386). Cybersec named the coverage gap outright: the fake
#         systemctl above ALWAYS answers, so the branch where systemd cannot be
#         reached had zero coverage -- which is exactly why the defect shipped.
#         These cases give it a systemctl that fails the way a missing user bus
#         really does.
# ---------------------------------------------------------------------------
# A systemctl that cannot reach the bus: non-zero exit, nothing on stdout.
write_dead_systemctl() {
  cat > "$1" <<'DEAD'
#!/bin/bash
echo "Failed to connect to bus: No medium found" >&2
exit 1
DEAD
  chmod +x "$1"
}

echo ""
echo "(s) an unanswerable systemd must NOT delete the flag of a masked machine"
ST="$(fresh_case s)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
ln -s /dev/null "$UNITS_DIR/ollama.service"     # genuinely masked, on disk
write_dead_systemctl "$SCTL"
quiet_case "$ST"
echo '{"detected_at": 1, "short_boots": 4, "units": "ollama.service", "reason": "dxgkrnl GPU-passthrough crash-loop"}' > "$ST/.gpu-crashloop-guard-masked.json"
OUT="$(run_guard_masking "$ST" "$ST/boots.txt" "$ST/kernel.txt" "$SCTL" "$UNITS_DIR")"
[ -f "$ST/.gpu-crashloop-guard-masked.json" ] \
  && pass "unknown-state: the flag SURVIVES when systemd cannot be asked" \
  || fail "unknown-state: the flag of a genuinely masked machine was deleted on an unanswerable systemd ($OUT)"
echo "$OUT" | grep -q "could not be asked" \
  && pass "unknown-state: the log says it could not ask, not that nothing is masked" \
  || fail "unknown-state: the log does not distinguish 'cannot ask' from 'not masked' ($OUT)"
echo "$OUT" | grep -q "is masked any more" \
  && fail "unknown-state: it still CLAIMS nothing is masked, which is false here" \
  || pass "unknown-state: no false 'nothing is masked any more' claim"

echo ""
echo "(t) an unanswerable systemd must NOT move the real unit file aside"
ST="$(fresh_case t)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
printf '[Unit]\nDescription=probe\n' > "$UNITS_DIR/ollama.service"
write_dead_systemctl "$SCTL"
date -d '-1 day' +%s > "$ST/.gpu-crashloop-guard-baseline" 2>/dev/null || date +%s > "$ST/.gpu-crashloop-guard-baseline"
write_short_dxg_boots "$ST/boots.txt" 4 60
echo "dxgk_ioctl: dxgadapter_release_lock_shared" > "$ST/kernel.txt"
OUT="$(run_guard_masking "$ST" "$ST/boots.txt" "$ST/kernel.txt" "$SCTL" "$UNITS_DIR")"
[ -f "$UNITS_DIR/ollama.service" ] && [ ! -L "$UNITS_DIR/ollama.service" ] \
  && pass "unknown-state: the real unit file is left where it was" \
  || fail "unknown-state: the unit file was moved aside on an unverifiable answer"
[ -e "$UNITS_DIR/ollama.service.real-unit-backup" ] \
  && fail "unknown-state: a backup was created for a mask that was never confirmed" \
  || pass "unknown-state: no orphan .real-unit-backup left behind"
[ ! -f "$ST/.gpu-crashloop-guard-masked.json" ] \
  && pass "unknown-state: no flag is written for a mask that did not happen" \
  || fail "unknown-state: a flag claims a mask that was never verified"
echo "$OUT" | grep -q "ALERT_DRYRUN" \
  && pass "unknown-state: the owner is still alerted that the machine is unprotected" \
  || fail "unknown-state: failed silently ($OUT)"

echo ""
echo "(u) systemctl MISSING ENTIRELY behaves the same as an unreachable bus"
ST="$(fresh_case u)"
UNITS_DIR="$ST/units"
mkdir -p "$UNITS_DIR"
ln -s /dev/null "$UNITS_DIR/ollama.service"
quiet_case "$ST"
echo '{"detected_at": 1, "short_boots": 4, "units": "ollama.service", "reason": "dxgkrnl GPU-passthrough crash-loop"}' > "$ST/.gpu-crashloop-guard-masked.json"
OUT="$(run_guard_masking "$ST" "$ST/boots.txt" "$ST/kernel.txt" "$ST/no-such-systemctl" "$UNITS_DIR")"
[ -f "$ST/.gpu-crashloop-guard-masked.json" ] \
  && pass "unknown-state: a missing systemctl binary does not delete the flag either" \
  || fail "unknown-state: a missing systemctl binary deleted the flag ($OUT)"

# ---------------------------------------------------------------------------
# (v) EXIT 0 WITH AN EMPTY VALUE IS ALSO "CANNOT ANSWER", and it is not a
#     hypothetical: measured on this host, a real `systemctl --user show -p
#     UnitFileState --value <unit it does not know>` exits 0 and prints NOTHING.
#     So an exit-code-only check would read a vanished unit as a live, unmasked
#     one and delete the flag. Found by mutation: checking only $? left 43/43
#     green while genuinely changing that behaviour.
#
#     The choice pinned here is to KEEP the flag. A unit that is simply gone
#     cannot be confirmed unmasked, and the documented restore path puts a real
#     unit file back (state "static", not empty), so the ordinary recovery still
#     clears the flag through case (m). This only holds the flag when the unit
#     itself has disappeared.
# ---------------------------------------------------------------------------
echo ""
echo "(v) exit 0 with an EMPTY UnitFileState does not refute the flag either"
ST="$(fresh_case v)"
UNITS_DIR="$ST/units"; SCTL="$ST/systemctl"
mkdir -p "$UNITS_DIR"
cat > "$SCTL" <<'QUIET'
#!/bin/bash
# Succeeds, says nothing -- exactly what a real systemctl does for an unknown unit.
exit 0
QUIET
chmod +x "$SCTL"
quiet_case "$ST"
echo '{"detected_at": 1, "short_boots": 4, "units": "ollama.service", "reason": "dxgkrnl GPU-passthrough crash-loop"}' > "$ST/.gpu-crashloop-guard-masked.json"
OUT="$(run_guard_masking "$ST" "$ST/boots.txt" "$ST/kernel.txt" "$SCTL" "$UNITS_DIR")"
[ -f "$ST/.gpu-crashloop-guard-masked.json" ] \
  && pass "unknown-state: an empty answer with exit 0 keeps the flag" \
  || fail "unknown-state: an empty-but-successful answer deleted the flag ($OUT)"

echo "========================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
