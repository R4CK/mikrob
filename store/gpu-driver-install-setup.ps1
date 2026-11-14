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
#   Phase 2: re-check the directory against the state Phase 1 recorded (R2(b), eb12a5dd -- catches
#     ACL drift between the two runs, not just reparse-points/owner), copy gpu-driver-install.ps1
#     and gpu-driver-install-launcher.ps1, pin the SHA-256 of BOTH files, and update (+ verify by
#     read-back) the scheduled task so its command line: (1) checks the LAUNCHER's own hash first
#     (R1, eb12a5dd -- the launcher used to be unpinned itself: if the ACL is ever bypassed, a
#     replaced launcher would simply ignore the hash argument), then (2) calls the launcher with
#     the main script's expected hash (F1: hash on the task command line, not next to the ps1 where
#     neon can read it). The launcher hash check uses a truncated 80-bit prefix, not the full
#     SHA-256, because schtasks /TR has a real but inconsistently-documented length limit; see the
#     comment at the task-command construction below for the measured budget.
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

# Use well-known SIDs to avoid locale/translation issues on non-English Windows hosts, and so
# both phases can compare an existing owner by SID instead of a display name (X1/X3, RedHat 22570):
#   S-1-5-18     = SYSTEM (LocalSystem)
#   S-1-5-32-544 = BUILTIN\Administrators
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$adminSid  = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$ntSystem  = $systemSid.Translate([System.Security.Principal.NTAccount])
$ntAdmin   = $adminSid.Translate([System.Security.Principal.NTAccount])

# True when $Path's owner SID is Administrators or SYSTEM -- the only two identities this setup
# ever grants on the target directory. Used fail-closed: an unrecognized owner is NOT trusted.
function Test-TrustedOwner {
    param([string]$Path)
    $ownerSid = (Get-Acl $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    return ($ownerSid -eq $adminSid.Value) -or ($ownerSid -eq $systemSid.Value)
}

if ($Phase -eq '1') {
    Write-Log "=== Phase 1: directory + ACL + write-test ==="

    # --- 1a. Create directory, or verify a pre-existing one is still ours (X1, RedHat 22570) --
    # The old code adopted any pre-existing $TargetDir silently ("already exists -- re-applying
    # ACL") and only re-applied the ACL -- it never checked who created it or what is in it. By
    # default a non-elevated user CAN create a subdirectory under C:\ProgramData, so a neon-level
    # attacker could pre-create the directory (or a junction) before Phase 1 ever runs. Refuse
    # fail-closed unless the existing entry is a real directory already owned by
    # Administrators/SYSTEM, with every child also owned by Administrators/SYSTEM.
    if (Test-Path $TargetDir) {
        $existingItem = Get-Item $TargetDir -Force
        if ($existingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            Write-Log "FAIL: $TargetDir is a junction or symlink -- refusing to adopt it"
            exit 1
        }
        if (-not (Test-TrustedOwner $TargetDir)) {
            $ownerSid = (Get-Acl $TargetDir).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            Write-Log "FAIL: $TargetDir already exists, owned by SID $ownerSid (expected Administrators or SYSTEM) -- refusing to adopt it"
            exit 1
        }
        foreach ($child in @(Get-ChildItem $TargetDir -Force -ErrorAction SilentlyContinue)) {
            if (-not (Test-TrustedOwner $child.FullName)) {
                Write-Log "FAIL: existing entry '$($child.Name)' in $TargetDir is not owned by Administrators/SYSTEM -- refusing to adopt it"
                exit 1
            }
        }
        Write-Log "$TargetDir already exists, owner and contents verified (Administrators/SYSTEM) -- re-applying ACL"
    } else {
        New-Item -ItemType Directory -Path $TargetDir | Out-Null
        Write-Log "Created $TargetDir"
    }

    # --- 1b. ACL: SID-based, explicit only, owner = Administrators ----------------------------
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
    # X1 (RedHat 22570): compare by SID, not the locale-dependent display name, and fail
    # CLOSED on a mismatch -- the old code only logged a NOTE and continued.
    $ownerSid = $chk.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ne $adminSid.Value) {
        Write-Log "FAIL: owner SID is $ownerSid, expected $($adminSid.Value) (Administrators)"
        exit 1
    }
    Write-Log "ACL verified: $aceCount ACEs, $inherited inherited, owner=$ownerVal (SID $ownerSid)"

    # --- 1c2. Record what THIS run measured, so Phase 2 can detect drift (R2(b), eb12a5dd) --
    # Phase 2 used to only re-derive its OWN owner/reparse-point checks -- that catches those two
    # specific tampers, but says nothing about a subtler ACL change (e.g. an extra ACE) between
    # the Phase 1 and Phase 2 runs. Record the measured state inside the directory itself: it is
    # only writable by Administrators/SYSTEM from this point on (the Set-Acl above already ran),
    # so this file carries the same trust guarantee as the rest of the directory's contents.
    $state = [ordered]@{
        ownerSid      = $ownerSid
        aceCount      = $aceCount
        inherited     = $inherited
        recordedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $StatePath = Join-Path $TargetDir 'gpu-driver-install-state.json'
    ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -NoNewline
    Write-Log "Phase 1 state recorded: $StatePath"

    # --- 1d. Positive control: verify the WSL write-test MECHANISM works --------------------
    # Test on a path neon CAN write, to confirm the bash printf + WSL path conversion is working
    # BEFORE we test the secured directory. A failing positive control means the test itself is
    # broken, not that neon is blocked -- these are different failures.
    $posWin = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "setup-pos-ctrl-$([System.Diagnostics.Process]::GetCurrentProcess().Id).txt")
    $posWsl = ConvertTo-WslPath $posWin
    try {
        $posOut = & $WslBin -u neon -- bash -c "printf x > '$posWsl' 2>&1 && echo WROTE || echo BLOCKED" 2>&1
        if ($posOut -notmatch 'WROTE') {
            Write-Log "FAIL: positive control failed -- neon CANNOT write to $posWin ($posOut)"
            Write-Log "The write-test mechanism itself does not work; cannot trust a 'BLOCKED' result."
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
        # X2 (RedHat 22570): first confirm WSL actually resolves to $TargetDir at this path --
        # a wrong or missing path answers "BLOCKED" the same way a real permission denial would.
        $dirCheck = (& $WslBin -u neon -- bash -c "test -d '$(ConvertTo-WslPath $TargetDir)' && echo DIREXISTS || echo DIRMISSING" 2>&1 | Out-String).Trim()
        if ($dirCheck -ne 'DIREXISTS') {
            Write-Log "FAIL: WSL cannot see $TargetDir at the translated path ($dirCheck) -- cannot trust a write-test result against it"
            exit 1
        }
        # Redirect stderr to /dev/null on the WSL side (not merged into stdout) so an unrelated
        # error cannot be mistaken for the exact "BLOCKED" confirmation below.
        $out = (& $WslBin -u neon -- bash -c "{ printf x > '$testWsl'; } 2>/dev/null && echo WROTE || echo BLOCKED" 2>&1 | Out-String).Trim()
        if ($out -eq 'WROTE') {
            Write-Log "FAIL: neon CAN write to $TargetDir -- ACL did not take effect."
            Write-Log "Diagnose: Get-Acl '$TargetDir' | Format-List"
            exit 1
        }
        # X2: only the exact expected refusal counts as confirmation. The old check treated ANY
        # non-"WROTE" output -- including empty or an unrelated error -- as "neon is blocked".
        if ($out -ne 'BLOCKED') {
            Write-Log "FAIL: write-test gave neither WROTE nor BLOCKED ('$out') -- cannot confirm neon is blocked"
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

# ==================================================================================================
# Phase 2: copy scripts, pin hash, update + verify scheduled task
# ==================================================================================================
Write-Log "=== Phase 2: copy scripts + pin hash + update scheduled task ==="

if (-not (Test-Path $TargetDir)) {
    Write-Log "FAIL: $TargetDir does not exist -- run Phase 1 first"
    exit 1
}

# --- 2a. Check source files -------------------------------------------------------------------
foreach ($name in @('gpu-driver-install.ps1', 'gpu-driver-install-launcher.ps1')) {
    $src = Join-Path $SrcDir $name
    if (-not (Test-Path $src)) {
        Write-Log "FAIL: $src not found -- run this script from the store/ directory"
        exit 1
    }
}

# --- 2b. Re-verify the directory and its contents before copying (X1(b), RedHat 22570) --------
# A Phase 1 pass minutes or hours earlier does not guarantee the directory is still in that state
# when Phase 2 runs -- re-run the SAME trust checks as Phase 1's adoption guard, plus an allowlist
# on existing filenames, instead of only checking children for junctions (the old F3 check).
$targetItem = Get-Item $TargetDir -Force
if ($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    Write-Log "FAIL: $TargetDir is a junction or symlink -- aborting for safety"
    exit 1
}
if (-not (Test-TrustedOwner $TargetDir)) {
    Write-Log "FAIL: $TargetDir is not owned by Administrators/SYSTEM -- aborting for safety"
    exit 1
}
$expectedNames = @('setup.log', 'launcher.log', 'gpu-driver-install.ps1', 'gpu-driver-install-launcher.ps1', 'gpu-driver-install.sha256',
                   'gpu-driver-install-trigger-receipt.json', 'gpu-driver-install-used-approvals.json', 'gpu-driver-install-state.json')
# H1 fix (2a80c6cb delta): no token ever placed on the Windows side; ps1 verifies via the
# trigger receipt written by the WSL trigger instead of calling consume-oneshot.
# The shared fleet token must never appear in this directory.
$existing = Get-ChildItem $TargetDir -Force -ErrorAction SilentlyContinue
foreach ($item in @($existing)) {
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Write-Log "FAIL: $($item.Name) is a junction or symlink in $TargetDir -- aborting for safety"
        exit 1
    }
    if (-not (Test-TrustedOwner $item.FullName)) {
        Write-Log "FAIL: $($item.Name) in $TargetDir is not owned by Administrators/SYSTEM -- aborting for safety"
        exit 1
    }
    if ($expectedNames -notcontains $item.Name) {
        Write-Log "FAIL: unexpected entry '$($item.Name)' in $TargetDir -- aborting for safety"
        exit 1
    }
    Write-Log "Existing: $($item.Name) [$($item.Attributes)]"
}
Write-Log "Directory and contents verified (Administrators/SYSTEM owner, no unexpected entries)"

# --- 2b2. Compare a FRESH ACL measurement against what Phase 1 recorded (R2(b), eb12a5dd) -----
# The loop above re-derives its own owner/reparse-point checks (catches those two tampers); this
# step additionally catches drift the loop above does not look for (e.g. an extra ACE) by
# comparing against the state Phase 1 actually measured and wrote, inside the same
# Administrators/SYSTEM-only directory.
$StatePath = Join-Path $TargetDir 'gpu-driver-install-state.json'
if (-not (Test-Path $StatePath)) {
    Write-Log "FAIL: $StatePath not found -- Phase 1 state was never recorded (or was removed) -- aborting"
    exit 1
}
try {
    $recordedState = Get-Content $StatePath -Raw | ConvertFrom-Json
} catch {
    Write-Log "FAIL: could not parse $StatePath -- aborting: $_"
    exit 1
}
$freshAcl       = Get-Acl $TargetDir
$freshAceCount  = @($freshAcl.Access).Count
$freshInherited = @($freshAcl.Access | Where-Object { $_.IsInherited }).Count
$freshOwnerSid  = $freshAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($freshOwnerSid -ne $recordedState.ownerSid -or $freshAceCount -ne $recordedState.aceCount -or $freshInherited -ne $recordedState.inherited) {
    Write-Log "FAIL: ACL state diverged from Phase 1 recording -- recorded owner=$($recordedState.ownerSid) aceCount=$($recordedState.aceCount) inherited=$($recordedState.inherited); fresh owner=$freshOwnerSid aceCount=$freshAceCount inherited=$freshInherited"
    exit 1
}
Write-Log "ACL state matches Phase 1 recording (owner=$freshOwnerSid, aceCount=$freshAceCount, inherited=$freshInherited)"

# --- 2c. Copy scripts -------------------------------------------------------------------------
foreach ($name in @('gpu-driver-install.ps1', 'gpu-driver-install-launcher.ps1')) {
    $src  = Join-Path $SrcDir $name
    $dest = Join-Path $TargetDir $name
    Copy-Item $src -Destination $dest -Force
    Write-Log "Copied $name"
}

# --- 2d. Pin SHA-256 of the main script -------------------------------------------------------
$mainScript = Join-Path $TargetDir 'gpu-driver-install.ps1'
$hash = (Get-FileHash $mainScript -Algorithm SHA256).Hash.ToUpper()
Set-Content -Path (Join-Path $TargetDir 'gpu-driver-install.sha256') -Value $hash -NoNewline
Write-Log "Hash pinned: $hash"

# --- 2e. Update scheduled task and verify by read-back (B3) -----------------------------------
$LauncherPath = Join-Path $TargetDir 'gpu-driver-install-launcher.ps1'
$TaskName     = 'MikroB-GPU-Driver-Install'

# R1 fix (eb12a5dd, WhiteHat 22466 residual R1): the main script's hash travelled on the task
# command line (F1), but the LAUNCHER itself was not pinned anywhere outside TargetDir -- if the
# directory's ACL is ever bypassed, a replaced launcher just ignores the hash argument and runs
# whatever it wants. Verify the launcher's OWN hash inline, in the task's own command line
# (admin-only, outside TargetDir -- the SAME channel as F1, not a registry value: a prior
# selftest, X3, already pins that this script must not reference the registry-key approach that
# an earlier REVIEW incorrectly described), BEFORE invoking it.
#
# The launcher-hash comparison uses a truncated 20-hex-char (80-bit) prefix, not the full
# SHA-256 -- schtasks /TR has a real but inconsistently documented length limit (public sources
# disagree: 255, 260, 261 and 262 characters have all been cited; none could be confirmed as
# the authoritative figure). Rather than trust any one of them, this script measures the actual
# command length below and fails closed over a conservative 250-char budget. 80 bits of
# preimage-search difficulty is far beyond what a non-elevated local process could brute-force in
# any practical time; this truncation is a NEW, narrowly-scoped convention for this one check --
# it does not touch the existing full-hash F1 check the launcher itself does on the main script.
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

# Read-back: confirm the task command line now contains BOTH the launcher-hash prefix and the
# main-script hash -- a mutant that dropped the new launcher pre-check but kept the main hash
# intact would still satisfy a read-back that only checked $hash, so both are checked
# independently.
$queryOut = & schtasks /Query /TN $TaskName /FO CSV /V 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Log "FAIL: schtasks /Query exited $LASTEXITCODE -- $queryOut"
    exit 1
}
$queryStr = $queryOut -join "`n"
if ($queryStr -notmatch [regex]::Escape($launcherHashShort)) {
    Write-Log "FAIL: task command line does not contain expected launcher-hash prefix $launcherHashShort after update"
    Write-Log "Query output: $queryStr"
    exit 1
}
if ($queryStr -notmatch [regex]::Escape($hash)) {
    Write-Log "FAIL: task command line does not contain expected main-script hash $hash after update"
    Write-Log "Query output: $queryStr"
    exit 1
}
Write-Log "Task verified: launcher-hash prefix $launcherHashShort and main hash $hash present in task command line"
Write-Log "Phase 2 complete. Setup done."
exit 0
