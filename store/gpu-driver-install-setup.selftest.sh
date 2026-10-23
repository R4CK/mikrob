#!/usr/bin/env bash
# gpu-driver-install-setup.selftest.sh -- static controls for X1/X2/X3 on
# gpu-driver-install-setup.ps1 (card 7857c82c, RedHat NO-GO comment 22570).
#
# This host has no pwsh/powershell: the actual PowerShell semantics cannot be executed here --
# both WhiteHat (22466) and RedHat (22570) state the same limitation, and the real Windows-side
# measurement (RedHat's M1-M4) is a separate, host-permissioned step, not this test. What CAN be
# checked hermetically is that the specific defects RedHat found are structurally gone from the
# CURRENT source text (positive control), and that the SAME check correctly flags them as
# present in the exact PRE-FIX text (negative control, embedded below as a literal fixture --
# never executed, not re-derived from git history, so this test has no external dependency).
#
# Usage: gpu-driver-install-setup.selftest.sh   (exit 0 = PASS, 1 = FAIL)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT="$HERE/gpu-driver-install-setup.ps1"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# $1 label, $2 file, $3 pattern, $4 "present"|"absent" (what we expect in $2)
check() {
  local label="$1" file="$2" pattern="$3" expect="$4"
  local n
  n="$(grep -cF "$pattern" "$file" 2>/dev/null || true)"
  n="${n:-0}"
  if [ "$expect" = "present" ] && [ "$n" -gt 0 ]; then echo "  ok   $label ($(basename "$file"), found ${n}x)"
  elif [ "$expect" = "absent" ] && [ "$n" -eq 0 ]; then echo "  ok   $label ($(basename "$file"), absent as expected)"
  else echo "  FAIL $label ($(basename "$file")) -> expected $expect of '$pattern', found ${n}x"; fail=1; fi
}

OLD="$TMP/old.ps1"
cat > "$OLD" <<'OLD_PS1_EOF'
# gpu-driver-install-setup.ps1 -- one-time Peti setup (cards 8b588834/7857c82c, GPU-driver figyelő (C)).
#
# Run from an elevated PowerShell (Run As Administrator). Two distinct phases:
#
#   Phase 1 (default): create C:\ProgramData\MikroB-Drivers with an explicit, non-inherited ACL
#     (SYSTEM Full + Administrators Full, SID-based, locale-independent), set owner to Administrators,
#     verify with Get-Acl read-back, then confirm from WSL that the neon user CANNOT write there.
#     A positive-control write test verifies the WSL write-test mechanism works BEFORE testing the
#     secured directory. No payload (ps1/hash) is copied in Phase 1 -- fail-closed: if the write-test
#     fails or errors, setup aborts (exit 1) before any content exists in the secured directory.
#
#   Phase 2: check for junctions/reparse points in the target directory, copy
#     gpu-driver-install.ps1 and gpu-driver-install-launcher.ps1, pin the SHA-256, and update
#     (+ verify by read-back) the scheduled task to call the launcher with the expected hash on the
#     command line (F1: hash on the task command line, not next to the ps1 where neon can read it).
#
# Run Phase 1 first, confirm neon is blocked, then run with -Phase 2.
# -Phase 2 alone (without Phase 1) will fail if the directory does not exist yet.
#
# Exit 0 = phase completed successfully.
# Exit 1 = setup failed; do not proceed to Phase 2.
#
#Requires -RunAsAdministrator

param(
    [ValidateSet('1','2')]
    [string]$Phase = '1'
)

$ErrorActionPreference = 'Stop'

$TargetDir = 'C:\ProgramData\MikroB-Drivers'
$SrcDir    = Split-Path $MyInvocation.MyCommand.Path
$WslBin    = 'C:\Windows\System32\wsl.exe'
$LogPath   = Join-Path $TargetDir 'setup.log'

function Write-Log {
    param([string]$Message)
    $line = "[{0:yyyy-MM-dd HH:mm:ss}Z] {1}" -f (Get-Date).ToUniversalTime(), $Message
    if (Test-Path $TargetDir) {
        try { Add-Content -Path $LogPath -Value $line -ErrorAction SilentlyContinue } catch {}
    }
    Write-Host $line
}

# Convert a Windows path to a WSL /mnt/<drive>/... path -- PS 5.1 compatible (no scriptblock replace).
function ConvertTo-WslPath {
    param([string]$WinPath)
    $drive = $WinPath[0].ToString().ToLower()
    $rest  = $WinPath.Substring(2) -replace '\\', '/'
    return "/mnt/$drive$rest"
}

if ($Phase -eq '1') {
    Write-Log "=== Phase 1: directory + ACL + write-test ==="

    # --- 1a. Create directory -----------------------------------------------------------------
    if (-not (Test-Path $TargetDir)) {
        New-Item -ItemType Directory -Path $TargetDir | Out-Null
        Write-Log "Created $TargetDir"
    } else {
        Write-Log "$TargetDir already exists -- re-applying ACL"
    }

    # --- 1b. ACL: SID-based, explicit only, owner = Administrators ----------------------------
    # Use well-known SIDs to avoid locale/translation issues on non-English Windows hosts:
    #   S-1-5-18     = SYSTEM (LocalSystem)
    #   S-1-5-32-544 = BUILTIN\Administrators
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $adminSid  = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $ntSystem  = $systemSid.Translate([System.Security.Principal.NTAccount])
    $ntAdmin   = $adminSid.Translate([System.Security.Principal.NTAccount])

    $acl = Get-Acl $TargetDir
    # Disable inheritance and clear ALL existing rules -- start with a clean slate.
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
    # Set owner to Administrators (SID).
    $acl.SetOwner($adminSid)

    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $prop    = [System.Security.AccessControl.PropagationFlags]::None
    $allow   = [System.Security.AccessControl.AccessControlType]::Allow
    $full    = [System.Security.AccessControl.FileSystemRights]::FullControl

    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($ntSystem, $full, $inherit, $prop, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($ntAdmin,  $full, $inherit, $prop, $allow)))
    Set-Acl $TargetDir $acl
    Write-Log "ACL applied: SYSTEM Full + Administrators Full (SID-based), owner=Administrators, no Users, no inheritance"

    # --- 1c. Get-Acl read-back: verify exactly 2 ACEs, 0 inherited, correct owner ------------
    $chk       = Get-Acl $TargetDir
    $aceCount  = @($chk.Access).Count
    $inherited = @($chk.Access | Where-Object { $_.IsInherited }).Count
    $ownerVal  = $chk.Owner
    if ($aceCount -ne 2) {
        Write-Log "FAIL: expected 2 ACEs after Set-Acl, got $aceCount"
        exit 1
    }
    if ($inherited -ne 0) {
        Write-Log "FAIL: $inherited inherited ACE(s) remain after SetAccessRuleProtection"
        exit 1
    }
    $expectedOwner = $ntAdmin.Value
    if ($ownerVal -ne $expectedOwner) {
        # Non-fatal: display form can vary on locale; SID-translate is correct.
        Write-Log "NOTE: owner display is '$ownerVal' (expected '$expectedOwner'); acceptable if SID matches"
    }
    Write-Log "ACL verified: $aceCount ACEs, $inherited inherited, owner=$ownerVal"

    # --- 1d. Positive control: verify the WSL write-test MECHANISM works --------------------
    $posWin = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "setup-pos-ctrl-$([System.Diagnostics.Process]::GetCurrentProcess().Id).txt")
    $posWsl = ConvertTo-WslPath $posWin
    try {
        $posOut = & $WslBin -u neon -- bash -c "printf x > '$posWsl' 2>&1 && echo WROTE || echo BLOCKED" 2>&1
        if ($posOut -notmatch 'WROTE') {
            Write-Log "FAIL: positive control failed -- neon CANNOT write to $posWin ($posOut)"
            exit 1
        }
        Remove-Item $posWin -ErrorAction SilentlyContinue
        Write-Log "Positive control OK: neon can write to temp (mechanism verified)"
    } catch {
        Write-Log "FAIL: positive control WSL call errored: $_ -- cannot verify write-test mechanism"
        exit 1
    }

    # --- 1e. Fail-closed write-test on TargetDir -------------------------------------------
    $testWin = Join-Path $TargetDir ("setup-write-probe-" + (Get-Date -Format 'HHmmss') + ".txt")
    $testWsl = ConvertTo-WslPath $testWin
    Write-Log "Testing neon write access to $TargetDir from WSL..."
    try {
        $out = & $WslBin -u neon -- bash -c "printf x > '$testWsl' 2>&1 && echo WROTE || echo BLOCKED" 2>&1
        if ($out -match 'WROTE') {
            Write-Log "FAIL: neon CAN write to $TargetDir -- ACL did not take effect."
            exit 1
        }
        Write-Log "CONFIRMED: neon write blocked ($out)"
    } catch {
        Write-Log "FAIL: WSL write-test errored: $_ -- cannot confirm neon is blocked"
        exit 1
    }

    Write-Log "Phase 1 complete. Run '-Phase 2' to copy scripts and update the scheduled task."
    exit 0
}

Write-Log "=== Phase 2: copy scripts + pin hash + update scheduled task ==="

if (-not (Test-Path $TargetDir)) {
    Write-Log "FAIL: $TargetDir does not exist -- run Phase 1 first"
    exit 1
}

foreach ($name in @('gpu-driver-install.ps1', 'gpu-driver-install-launcher.ps1')) {
    $src = Join-Path $SrcDir $name
    if (-not (Test-Path $src)) {
        Write-Log "FAIL: $src not found -- run this script from the store/ directory"
        exit 1
    }
}

# --- 2b. Check existing folder contents for junctions / unexpected entries (F3) ---------------
$existing = Get-ChildItem $TargetDir -ErrorAction SilentlyContinue
foreach ($item in @($existing)) {
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Write-Log "FAIL: $($item.Name) is a junction or symlink in $TargetDir -- aborting for safety"
        exit 1
    }
    Write-Log "Existing: $($item.Name) [$($item.Attributes)]"
}
$dirOwner = (Get-Acl $TargetDir).Owner
Write-Log "Directory owner before copy: $dirOwner"

foreach ($name in @('gpu-driver-install.ps1', 'gpu-driver-install-launcher.ps1')) {
    $src  = Join-Path $SrcDir $name
    $dest = Join-Path $TargetDir $name
    Copy-Item $src -Destination $dest -Force
    Write-Log "Copied $name"
}

$mainScript = Join-Path $TargetDir 'gpu-driver-install.ps1'
$hash = (Get-FileHash $mainScript -Algorithm SHA256).Hash.ToUpper()
Set-Content -Path (Join-Path $TargetDir 'gpu-driver-install.sha256') -Value $hash -NoNewline
Write-Log "Hash pinned: $hash"

$LauncherPath = Join-Path $TargetDir 'gpu-driver-install-launcher.ps1'
$TaskName     = 'MikroB-GPU-Driver-Install'
$TaskCommand  = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$LauncherPath`" $hash"

Write-Log "Updating scheduled task '$TaskName' with hash $hash on command line..."
$changeOut = & schtasks /Change /TN $TaskName /TR $TaskCommand 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Log "FAIL: schtasks /Change exited $LASTEXITCODE -- $changeOut"
    exit 1
}
Write-Log "schtasks /Change: $changeOut"

$queryOut = & schtasks /Query /TN $TaskName /FO CSV /V 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Log "FAIL: schtasks /Query exited $LASTEXITCODE -- $queryOut"
    exit 1
}
$queryStr = $queryOut -join "`n"
if ($queryStr -notmatch [regex]::Escape($hash)) {
    Write-Log "FAIL: task command line does not contain expected hash $hash after update"
    exit 1
}
Write-Log "Task verified: hash $hash present in task command line"
Write-Log "Phase 2 complete. Setup done."
exit 0
OLD_PS1_EOF

echo "== X1(a): a pre-existing TargetDir must be refused, not silently adopted =="
check "X1a fail-closed adoption guard present"  "$CURRENT" "refusing to adopt it"        present
check "X1a fail-closed adoption guard present"  "$OLD"     "refusing to adopt it"        absent
check "X1a old silent-adopt text gone"          "$CURRENT" "already exists -- re-applying ACL" absent
check "X1a old silent-adopt text present (old)" "$OLD"     "already exists -- re-applying ACL" present

echo "== X1(c): owner mismatch must fail closed (SID), not just NOTE (display name) =="
check "X1c old NOTE-only owner check gone"   "$CURRENT" "NOTE: owner display"   absent
check "X1c old NOTE-only owner check present (old)" "$OLD" "NOTE: owner display" present
check "X1c SID-based fail-closed owner check present" "$CURRENT" "FAIL: owner SID is" present
check "X1c SID-based fail-closed owner check present" "$OLD"     "FAIL: owner SID is" absent

echo "== X1(b): Phase 2 must re-verify directory state before copying, not just check for junctions =="
check "X1b Phase-2 re-verification present"   "$CURRENT" "Re-verify the directory and its contents before copying" present
check "X1b Phase-2 re-verification present"   "$OLD"     "Re-verify the directory and its contents before copying" absent
check "X1b Phase-2 filename allowlist present" "$CURRENT" '$expectedNames'                                        present
check "X1b Phase-2 filename allowlist present" "$OLD"     '$expectedNames'                                        absent

echo "== X2: the neon write-probe must require the EXACT 'BLOCKED' string, not any non-WROTE output =="
check "X2 exact-match probe present"      "$CURRENT" "-ne 'BLOCKED'" present
check "X2 exact-match probe present"      "$OLD"     "-ne 'BLOCKED'" absent
check "X2 WSL path-existence pre-check present" "$CURRENT" "DIREXISTS" present
check "X2 WSL path-existence pre-check present" "$OLD"     "DIREXISTS" absent

echo "== X3: the REVIEW's HKLM claim must not be in the code (it never was; this pins that it still isn't) =="
check "X3 no HKLM reference (hash travels on the task command line, per the header)" "$CURRENT" "HKLM" absent

if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
