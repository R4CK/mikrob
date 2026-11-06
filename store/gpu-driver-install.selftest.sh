#!/usr/bin/env bash
# gpu-driver-install.selftest.sh -- static controls for the R1 fix on gpu-driver-install.ps1
# (card 2a80c6cb delta, CYBERSEC NO-GO 27873 finding R1).
#
# This host has no pwsh/powershell, so Test-FreshApproval's actual runtime behaviour cannot be
# executed here (same limitation documented in gpu-driver-install-setup.selftest.sh). What CAN be
# checked hermetically is that the specific R1 defect is structurally gone from the CURRENT source
# text (positive control), and that the same check correctly flags it as present in the exact
# pre-fix text (negative control, embedded below as a literal fixture -- never executed, not
# re-derived from git history).
#
# R1: a parse failure of the local used-approvals replay-guard marker file used to be treated as
# an EMPTY used-list ("treating as empty") -- i.e. fail-OPEN. A truncated, corrupted, or externally
# reset marker file let a receipt still inside its freshness window be accepted again as if never
# used. The fix refuses (fail-closed, return $false) instead of treating the parse failure as "no
# prior use".
#
# Usage: gpu-driver-install.selftest.sh   (exit 0 = PASS, 1 = FAIL)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT="$HERE/gpu-driver-install.ps1"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() {
  local label="$1" file="$2" pattern="$3" expect="$4"
  local n
  n="$(grep -cF "$pattern" "$file" 2>/dev/null || true)"
  n="${n:-0}"
  if [ "$expect" = "present" ] && [ "$n" -gt 0 ]; then echo "  ok   $label ($(basename "$file"), found ${n}x)"
  elif [ "$expect" = "absent" ] && [ "$n" -eq 0 ]; then echo "  ok   $label ($(basename "$file"), absent as expected)"
  else echo "  FAIL $label ($(basename "$file")) -> expected $expect of '$pattern', found ${n}x"; fail=1; fi
}

# Pre-fix fixture: the exact used-approvals parse-failure block before the R1 fix, embedded
# literally (never executed). Only the relevant function body is needed for these checks.
OLD="$TMP/old.ps1"
cat > "$OLD" <<'OLD_PS1_EOF'
        # Verify not already used by THIS script (prevents a direct schtasks re-run with the same receipt).
        $usedIds = @()
        if (Test-Path $UsedApprovalsPath) {
            try {
                $parsed = Get-Content -Path $UsedApprovalsPath -Raw | ConvertFrom-Json
                if ($parsed.usedApprovalIds) { $usedIds = @($parsed.usedApprovalIds) }
            } catch {
                Write-Log "approval: could not parse $UsedApprovalsPath, treating as empty: $_"
            }
        }
        if ($usedIds -contains $receipt.approvalId) {
OLD_PS1_EOF

echo "== R1: used-approvals parse failure must FAIL CLOSED, not silently treat as empty =="
check "R1 old fail-open phrasing present (old)"    "$OLD"     "treating as empty"                         present
check "R1 old fail-open phrasing gone (current)"   "$CURRENT" "could not parse \$UsedApprovalsPath, treating as empty" absent
check "R1 new fail-closed log line present"        "$CURRENT" "FAIL-CLOSED -- could not parse \$UsedApprovalsPath"      present

# Anchored mutation check (same reasoning as the B3 SM3 fix in gpu-driver-install-setup.selftest.sh):
# 'return $false' alone occurs 20 times in this file for unrelated guards, so a bare needle check
# cannot tell a mutant that removes/comments out ONLY this guard's return from one that keeps it.
# Anchor to the 2 lines following the new FAIL-CLOSED log line -- that is this guard's own branch.
strip_comments() { sed -E 's/#.*$//' "$1"; }
CURRENT_NOCOMMENT="$(strip_comments "$CURRENT")"
R1_BLOCK="$(printf '%s\n' "$CURRENT_NOCOMMENT" | grep -A2 -F 'FAIL-CLOSED -- could not parse $UsedApprovalsPath')"
if printf '%s\n' "$R1_BLOCK" | grep -qF 'return $false'; then
  echo "  ok   R1 return \$false present in the guard's own block (comment-stripped, anchored)"
else
  echo "  FAIL R1 return \$false missing from the guard's own block (comment-stripped, anchored)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
