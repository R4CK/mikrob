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

# PRENOGO: the exact gpu-driver-install-setup.ps1 text at Gate-SHA 28c87019f (the sha CYBERED
# NO-GO 30643 was given against), BEFORE this round's F1/F2/F4 fixes. A literal fixture, like
# $OLD above, not re-derived from git history -- the R1/R2b/F1/F2/F4 checks below run against both
# $CURRENT (expect fixed) and $PRENOGO (expect the NO-GO'd shape still present), so a check that
# would pass on EITHER version proves nothing.
PRENOGO="$TMP/prenogo.ps1"
cat > "$PRENOGO" <<'PRENOGO_PS1_EOF'
$launcherHash      = (Get-FileHash $LauncherPath -Algorithm SHA256).Hash.ToUpper()
$launcherHashShort = $launcherHash.Substring(0, 20)
Write-Log "Launcher hash computed: $launcherHash (pinned prefix: $launcherHashShort)"

$InlineCheck = "`$p='$LauncherPath';if((Get-FileHash `$p).Hash.Substring(0,20)-ne'$launcherHashShort'){exit 1};&`$p '$hash'"
$TaskCommand = "powershell.exe -nop -ep Bypass -c `"$InlineCheck`""

if ($TaskCommand.Length -gt 250) {
    Write-Log "FAIL: task command is $($TaskCommand.Length) chars, over the safe 250-char budget for schtasks /TR -- aborting before schtasks /Change"
    exit 1
}

Write-Log "Updating scheduled task '$TaskName' with launcher-hash pre-check + main hash $hash on command line..."
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
if ($queryStr -notmatch [regex]::Escape($launcherHashShort)) {
    Write-Log "FAIL: task command line does not contain expected launcher-hash prefix $launcherHashShort after update"
    exit 1
}
if ($queryStr -notmatch [regex]::Escape($hash)) {
    Write-Log "FAIL: task command line does not contain expected main-script hash $hash after update"
    exit 1
}
Write-Log "Task verified: launcher-hash prefix $launcherHashShort and main hash $hash present in task command line"

$freshAcl       = Get-Acl $TargetDir
$freshAceCount  = @($freshAcl.Access).Count
$freshInherited = @($freshAcl.Access | Where-Object { $_.IsInherited }).Count
$freshOwnerSid  = $freshAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($freshOwnerSid -ne $recordedState.ownerSid -or $freshAceCount -ne $recordedState.aceCount -or $freshInherited -ne $recordedState.inherited) {
    Write-Log "FAIL: ACL state diverged from Phase 1 recording -- recorded owner=$($recordedState.ownerSid) aceCount=$($recordedState.aceCount) inherited=$($recordedState.inherited); fresh owner=$freshOwnerSid aceCount=$freshAceCount inherited=$freshInherited"
    exit 1
}
Write-Log "ACL state matches Phase 1 recording (owner=$freshOwnerSid, aceCount=$freshAceCount, inherited=$freshInherited)"
PRENOGO_PS1_EOF

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

echo "== B3: scheduled-task hash read-back guard present in current, diagnostic logging absent from old =="
# B3: the schtasks /Query read-back check ensures the task command line actually contains the hash
# after the /Change call. A mutant removing this check (legacy migration path) would silently
# complete Phase 2 even if schtasks /Change returned 0 but did not update the command line.
# Positive: the guard AND its failure exit must be structurally present as code (not comments).
# Negative: the old fixture LACKS the diagnostic "Query output:" log line added in card 2a80c6cb.
# M3 fix (2a80c6cb delta, round 2 -- CYBERSEC NO-GO 27873 SM2/SM3): the first M3 fix only
# stripped WHOLE-LINE comments ('^\s*#'), which a mutant defeats by keeping the original
# condition as a TRAILING comment on the mutated line (SM2: `if ($false) {  # if (...)`) --
# the line does not start with #, so it survived unstripped and the needle still matched.
# Strip from the first '#' to end of EVERY line instead (verified: no line in this file uses
# '#' inside a string literal, so this cannot eat real code -- checked by hand, 2a80c6cb).
strip_comments() { sed -E 's/#.*$//' "$1"; }
CURRENT_NOCOMMENT="$(strip_comments "$CURRENT")"
OLD_NOCOMMENT="$(strip_comments "$OLD")"
PRENOGO_NOCOMMENT="$(strip_comments "$PRENOGO")"

check_stripped() {
  local label="$1" src_nocomment="$2" needle="$3" mode="$4"
  if [ "$mode" = present ]; then
    printf '%s\n' "$src_nocomment" | grep -qF "$needle" \
      && echo "PASS: $label" || { echo "FAIL: $label (needle absent in code after stripping comments)"; fail=$((fail+1)); }
  else
    printf '%s\n' "$src_nocomment" | grep -qF "$needle" \
      && { echo "FAIL: $label (needle present in code even after stripping comments)"; fail=$((fail+1)); } \
      || echo "PASS: $label"
  fi
}
check_stripped "B3 hash read-back guard present (comment-stripped)"  "$CURRENT_NOCOMMENT" 'notmatch [regex]::Escape($hash)'  present
# F1 fix (CYBERED NO-GO 30643) replaced the schtasks /Query CSV diagnostic log ("Query output:")
# with the task's own Actions[0].Arguments value ("Action argument:"), since the read-back itself
# moved from schtasks /Query text to the Task Scheduler COM object -- same guard intent (log the
# actual value on a read-back failure), new source.
check_stripped "B3 diagnostic log present (comment-stripped)"        "$CURRENT_NOCOMMENT" 'Write-Log "Action argument:'      present
check_stripped "B3 diagnostic log absent from old (comment-stripped)" "$OLD_NOCOMMENT"    'Write-Log "Action argument:'      absent

# SM3 fix: 'exit 1' alone occurs 20+ times in this file for unrelated guards, so a mutant that
# comments out (or removes) ONLY the B3 guard's own exit 1 still finds the needle elsewhere and
# the old check passed anyway (fail-open blind spot). Anchor to the line itself and the line
# following it -- that is this guard's own failure branch, not any other guard's.
B3_BLOCK="$(printf '%s\n' "$CURRENT_NOCOMMENT" | grep -A1 -F 'Write-Log "Action argument:')"
if printf '%s\n' "$B3_BLOCK" | grep -qF 'exit 1'; then
  echo "PASS: B3 failure exit 1 present in the guard's own block (comment-stripped, anchored)"
else
  echo "FAIL: B3 failure exit 1 missing from the guard's own block (comment-stripped, anchored)"
  fail=$((fail+1))
fi

echo "== F1 (2a80c6cb delta): gpu-driver-approval.token must NOT be in the allowlist (H1 fix) =="
# H1 fix: no token ever goes to the Windows side; the allowlist must NOT include the old token name.
check "F1 scoped token removed from allowlist"        "$CURRENT" "gpu-driver-approval.token"  absent
check "F1 trigger-receipt in allowlist"               "$CURRENT" "gpu-driver-install-trigger-receipt.json"  present
check "F1 shared fleet token not in allowlist"        "$CURRENT" '.dashboard-token'            absent

echo "== R1 (eb12a5dd): the launcher's OWN hash must be checked outside TargetDir, before invoking it =="
# Old fixture has no such mechanism at all -- pure presence/absence against $OLD confirms this is
# genuinely new, not a pre-existing check this test just started looking for.
check_stripped "R1 launcher hash computed (comment-stripped)" "$CURRENT_NOCOMMENT" '$launcherHash' present
check_stripped "R1 launcher hash computed (comment-stripped)" "$OLD_NOCOMMENT"     '$launcherHash' absent
check_stripped "R1 task action built from an inline pre-check, not -File (comment-stripped)" \
  "$CURRENT_NOCOMMENT" '$InlineCheck' present
check_stripped "R1 old -File invocation of the launcher is gone (comment-stripped)" \
  "$CURRENT_NOCOMMENT" ' -File `"$LauncherPath`" $hash' absent
check "R1 old -File invocation present in old fixture" "$OLD" ' -File `"$LauncherPath`" $hash' present
# R1's whole point is that the launcher hash check must run BEFORE the launcher is invoked --
# anchor to the actual $InlineCheck line, not just "the words exist somewhere in the file".
INLINECHECK_LINE="$(printf '%s\n' "$CURRENT_NOCOMMENT" | grep -F '$InlineCheck =')"
if printf '%s\n' "$INLINECHECK_LINE" | grep -qF 'Get-FileHash' && printf '%s\n' "$INLINECHECK_LINE" | grep -qF 'exit 1'; then
  echo "PASS: R1 inline check line itself hashes the launcher and can exit before invoking it"
else
  echo "FAIL: R1 inline check line does not both hash and fail-closed in one place"
  fail=$((fail+1))
fi

echo "== F1 (CYBERED NO-GO 30643): the task action must be set via Set-ScheduledTask, not schtasks /TR =="
# schtasks /Change round-trips the command text through PowerShell 5.1's native-command argument
# handling, which RedHat's argv emulation showed mis-escaping an embedded-quotes-plus-whitespace
# argument (the old $InlineCheck's exact shape) into 9 tokens instead of 6. Pin that the migration
# actually happened, both ways: gone from current, still present in the pre-fix fixture.
check_stripped "F1 schtasks /Change removed (comment-stripped)" "$CURRENT_NOCOMMENT" 'schtasks /Change' absent
check_stripped "F1 schtasks /Change present in pre-fix fixture (comment-stripped)" "$PRENOGO_NOCOMMENT" 'schtasks /Change' present
check_stripped "F1 New-ScheduledTaskAction present (comment-stripped)" "$CURRENT_NOCOMMENT" 'New-ScheduledTaskAction -Execute' present
check_stripped "F1 New-ScheduledTaskAction absent from pre-fix fixture (comment-stripped)" "$PRENOGO_NOCOMMENT" 'New-ScheduledTaskAction -Execute' absent
check_stripped "F1 Set-ScheduledTask applies the new action (comment-stripped)" "$CURRENT_NOCOMMENT" 'Set-ScheduledTask -TaskName $TaskName -Action $newAction' present
# Read-back must use the task's own stored Actions[0].Arguments, not schtasks /Query CSV text.
check_stripped "F1 read-back via Actions[0].Arguments (comment-stripped)" "$CURRENT_NOCOMMENT" '$verifyTask.Actions[0].Arguments' present

echo "== F2 (CYBERED NO-GO 30643): the launcher pre-check must fail closed on an erroring hash read =="
# Old shape: (Get-FileHash $p).Hash.Substring(0,20) -ne '...' -- a terminating method-call-on-null
# only aborts that ONE if-statement in a -Command script, falling through to invoke the launcher
# anyway. New shape: try{$h=(Get-FileHash ... -ErrorAction Stop).Hash}catch{exit 1}, so a failed
# read exits before any comparison runs, and the comparison itself is a value compare ($h -ne
# literal), never a method call that could crash past the gate.
check_stripped "F2 fail-closed try/catch around the launcher hash read (comment-stripped)" \
  "$CURRENT_NOCOMMENT" 'try{`$h=(Get-FileHash `$p -Algorithm SHA256 -ErrorAction Stop).Hash}catch{exit 1}' present
check_stripped "F2 fail-closed try/catch absent from pre-fix fixture (comment-stripped)" \
  "$PRENOGO_NOCOMMENT" 'try{`$h=(Get-FileHash `$p -Algorithm SHA256 -ErrorAction Stop).Hash}catch{exit 1}' absent
check_stripped "F2 old crash-prone Substring-on-possibly-null form removed (comment-stripped)" \
  "$CURRENT_NOCOMMENT" '(Get-FileHash `$p).Hash.Substring(0,20)' absent
check "F2 old crash-prone Substring-on-possibly-null form present in pre-fix fixture" \
  "$PRENOGO" '(Get-FileHash `$p).Hash.Substring(0,20)' present

echo "== F3 (CYBERED NO-GO 30643): R1's comparison must be pinned by OPERATOR and ORDER, not just token presence =="
# Operator direction: -ne (refuse on mismatch), not -eq (the exact inversion RedHat's mutant #1
# applied and the old text-presence-only selftest never noticed, because -eq and -ne both contain
# the same variable-name tokens).
check_stripped "F3 R1 compares with -ne (fail on mismatch), anchored to the launcher-hash variable (comment-stripped)" \
  "$CURRENT_NOCOMMENT" "if(\`\$h -ne '\$launcherHash')" present
check_stripped "F3 R1 inverted -eq form is absent (comment-stripped)" \
  "$CURRENT_NOCOMMENT" "if(\`\$h -eq '\$launcherHash')" absent
# Comparison target: must be the REAL computed $launcherHash variable (interpolated into the
# string), not a hardcoded or substituted constant -- RedHat's mutant #3 ("wrong value").
check_stripped "F3 R1 compares against the real \$launcherHash variable, not a literal (comment-stripped)" \
  "$CURRENT_NOCOMMENT" "-ne '\$launcherHash'" present
# Order: the hash check (if(...){exit 1}) must appear BEFORE the launcher invocation (& `$p) on
# the same line -- RedHat's mutant #5 (launcher invoked before its own check).
R1_LINE="$(printf '%s\n' "$CURRENT_NOCOMMENT" | grep -F '$InlineCheck = ')"
IF_POS="$(printf '%s' "$R1_LINE" | grep -abo "if(\`\$h -ne" | head -1 | cut -d: -f1)"
INVOKE_POS="$(printf '%s' "$R1_LINE" | grep -abo '& `$p' | head -1 | cut -d: -f1)"
if [ -n "$IF_POS" ] && [ -n "$INVOKE_POS" ] && [ "$IF_POS" -lt "$INVOKE_POS" ]; then
  echo "  ok   F3 R1 hash check (position $IF_POS) runs before launcher invocation (position $INVOKE_POS)"
else
  echo "  FAIL F3 R1 ordering -- check at '$IF_POS', invocation at '$INVOKE_POS' (expected check < invocation)"
  fail=1
fi
# No truncation left anywhere in the pre-check construction -- full-length hash now that the
# schtasks /TR length ceiling (the only reason for truncating) no longer applies.
check_stripped "F3 R1 pre-check no longer truncates the launcher hash (comment-stripped)" \
  "$CURRENT_NOCOMMENT" 'Substring(0,20)' absent
check "F3 sanity length budget present (8000-char ceiling, Action.Arguments headroom)" "$CURRENT" 'TaskArgument.Length -gt 8000' present

echo "== R2(b) (eb12a5dd): Phase 2 must compare against Phase 1's RECORDED state, not just re-derive its own checks =="
check_stripped "R2b state filename referenced (comment-stripped)"  "$CURRENT_NOCOMMENT" 'gpu-driver-install-state.json' present
check_stripped "R2b state filename referenced (comment-stripped)"  "$OLD_NOCOMMENT"     'gpu-driver-install-state.json' absent
# Anchor to the ACTUAL write statement, not just the filename -- a mutant that comments out only
# the write (leaving $StatePath's own assignment line untouched) still has the filename string
# present, so the check above alone would miss it.
check_stripped "R2b Phase 1 actually WRITES the state (comment-stripped, anchored to the write call)" \
  "$CURRENT_NOCOMMENT" 'ConvertTo-Json -Compress) | Set-Content -Path $StatePath' present
check_stripped "R2b Phase 1 actually WRITES the state (comment-stripped, anchored to the write call)" \
  "$OLD_NOCOMMENT" 'ConvertTo-Json -Compress) | Set-Content -Path $StatePath' absent
check_stripped "R2b Phase 2 reads the recorded state (comment-stripped)" "$CURRENT_NOCOMMENT" 'recordedState' present
check "R2b state file added to the filename allowlist" "$CURRENT" "'gpu-driver-install-state.json')" present
# Anchor the comparison itself: the divergence check must fail closed on owner OR ACE-set drift,
# and must be able to exit 1 in the same block (mutation target: deleting the -or chain silently
# turns this into an always-true-pass).
R2B_BLOCK="$(printf '%s\n' "$CURRENT_NOCOMMENT" | grep -A3 -F 'if ($freshOwnerSid -ne $recordedState.ownerSid')"
if printf '%s\n' "$R2B_BLOCK" | grep -qF 'exit 1'; then
  echo "PASS: R2b divergence check's own block can fail closed"
else
  echo "FAIL: R2b divergence check block missing its own exit 1"
  fail=$((fail+1))
fi

# b64cfc09 (follow-up, CYBERED GO 30750 F3): the owner/ACE divergence check above was pinned, but
# the two branches that make reaching it conditional on an actually-present, actually-parseable
# state file were not -- RedHat's mut3.py showed "Phase 2 missing-state-file no longer exits 1" and
# "unparsable-state no longer exits 1" both surviving. Anchor each branch to its own exit 1, same
# technique as the divergence check above.
R2B_MISSING_BLOCK="$(printf '%s\n' "$CURRENT_NOCOMMENT" | grep -A3 -F 'if (-not (Test-Path $StatePath))')"
if printf '%s\n' "$R2B_MISSING_BLOCK" | grep -qF 'exit 1'; then
  echo "PASS: R2b missing-state-file check can fail closed"
else
  echo "FAIL: R2b missing-state-file check missing its own exit 1"
  fail=$((fail+1))
fi

R2B_PARSE_BLOCK="$(printf '%s\n' "$CURRENT_NOCOMMENT" | grep -A3 -F '$recordedState = Get-Content $StatePath -Raw | ConvertFrom-Json')"
if printf '%s\n' "$R2B_PARSE_BLOCK" | grep -qF 'exit 1'; then
  echo "PASS: R2b unparsable-state check can fail closed"
else
  echo "FAIL: R2b unparsable-state check missing its own exit 1"
  fail=$((fail+1))
fi

echo "== N2 (b64cfc09, follow-up of eb12a5dd): Phase 1's adoption loop must reject a junction CHILD, not just a junction/owner-mismatch on TargetDir itself =="
check "N2 reparse-point check present on adopted children" "$CURRENT" "is a junction or symlink -- refusing to adopt it" present
check "N2 reparse-point check absent from old fixture"     "$OLD"     "is a junction or symlink -- refusing to adopt it" absent
# Anchor the comparison itself: a junction child inside the loop must be able to exit 1 in the
# same block (mutation target: deleting the exit 1 but leaving the Write-Log line, or deleting
# the reparse-point branch entirely while keeping the owner-check branch below it).
N2_BLOCK="$(printf '%s\n' "$CURRENT_NOCOMMENT" | grep -A3 -F 'if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint)')"
if printf '%s\n' "$N2_BLOCK" | grep -qF 'exit 1'; then
  echo "PASS: N2 junction-child check's own block can fail closed"
else
  echo "FAIL: N2 junction-child check block missing its own exit 1"
  fail=$((fail+1))
fi

echo "== F4 (CYBERED NO-GO 30643): R2(b) must compare the FULL ACE set, not just a bare ACE count =="
# A count-only compare (the pre-fix shape) passes when one required ACE is swapped for a different
# one of the same count -- same owner, same total, 0 inherited, different actual grant.
check_stripped "F4 Get-AceSnapshot function present (comment-stripped)" "$CURRENT_NOCOMMENT" 'function Get-AceSnapshot' present
check_stripped "F4 Get-AceSnapshot function absent from pre-fix fixture (comment-stripped)" "$PRENOGO_NOCOMMENT" 'function Get-AceSnapshot' absent
check_stripped "F4 Phase 1 records an ACE snapshot, not just a count (comment-stripped)" "$CURRENT_NOCOMMENT" 'aceSnapshot   = $aceSnapshot' present
check_stripped "F4 Phase 2 diffs the ACE snapshot via Compare-Object (comment-stripped)" "$CURRENT_NOCOMMENT" 'Compare-Object -ReferenceObject @($recordedState.aceSnapshot) -DifferenceObject $freshAceSnapshot' present
# The divergence CONDITION itself must include the ACE diff, not just owner+count+inherited --
# anchor to the real if-line so a mutant that keeps $aceDiff computed but drops it from the `-or`
# chain (an always-true-pass on ACE drift specifically) is caught.
check_stripped "F4 divergence condition includes the ACE diff (comment-stripped, anchored)" \
  "$CURRENT_NOCOMMENT" 'if ($freshOwnerSid -ne $recordedState.ownerSid -or $aceDiff)' present
check_stripped "F4 old count-only divergence condition is gone (comment-stripped)" \
  "$CURRENT_NOCOMMENT" 'freshAceCount -ne $recordedState.aceCount' absent
check "F4 old count-only divergence condition present in pre-fix fixture" \
  "$PRENOGO" 'freshAceCount -ne $recordedState.aceCount' present

if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
