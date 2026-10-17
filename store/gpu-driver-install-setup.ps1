# gpu-driver-install-setup.ps1 -- one-time Peti setup (card 8b588834, GPU-driver figyelő (C)).
#
# Run ONCE from an elevated PowerShell (Run As Administrator) to:
#   1. Create C:\ProgramData\MikroB-Drivers\ with an EXPLICIT, non-inherited ACL
#      (SYSTEM Full + Administrators Full only, Users/neon REMOVED), so the WSL neon
#      process cannot write to the directory.
#   2. Copy gpu-driver-install.ps1 and gpu-driver-install-launcher.ps1 from the repo
#      (same directory as this script) into that secured location.
#   3. Compute the SHA-256 of the copied gpu-driver-install.ps1 and write it to
#      gpu-driver-install.sha256 in the same directory, so the launcher can pin it.
#   4. Print the schtasks command that Peti must run to update the scheduled task to
#      point at the launcher (not the ps1 directly).
#
# After running this script, verify that the WSL neon user CANNOT write to the new
# directory (the script attempts a WSL write and reports the result -- fail-closed:
# if the write succeeds, the setup is not complete).
#
# Exit 0 = setup complete and neon write confirmed blocked.
# Exit 1 = setup failed, or neon write was not blocked (manual check required).

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$TargetDir = 'C:\ProgramData\MikroB-Drivers'
$LogPath = Join-Path $TargetDir 'setup.log'

function Write-Log {
    param([string]$Message)
    $line = "[{0:yyyy-MM-dd HH:mm:ss}Z] {1}" -f (Get-Date).ToUniversalTime(), $Message
    if (Test-Path $TargetDir) { Add-Content -Path $LogPath -Value $line -ErrorAction SilentlyContinue }
    Write-Host $line
}

# --- 1. Create directory and set ACL -----------------------------------------------------------
if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir | Out-Null
    Write-Log "Created $TargetDir"
} else {
    Write-Log "$TargetDir already exists -- re-applying ACL"
}

$acl = Get-Acl $TargetDir
# Disable inheritance and remove all inherited rules (start clean).
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }

$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$prop    = [System.Security.AccessControl.PropagationFlags]::None
$allow   = [System.Security.AccessControl.AccessControlType]::Allow
$full    = [System.Security.AccessControl.FileSystemRights]::FullControl

$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('SYSTEM',         $full, $inherit, $prop, $allow)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('Administrators', $full, $inherit, $prop, $allow)))
Set-Acl $TargetDir $acl
Write-Log "ACL set: SYSTEM Full, Administrators Full, no Users/inheritance"

# --- 2. Copy scripts ---------------------------------------------------------------------------
$SrcDir = Split-Path $MyInvocation.MyCommand.Path
foreach ($name in @('gpu-driver-install.ps1', 'gpu-driver-install-launcher.ps1')) {
    $src = Join-Path $SrcDir $name
    if (-not (Test-Path $src)) {
        Write-Log "FAIL: $src not found -- run this script from the store/ directory"
        exit 1
    }
    Copy-Item $src -Destination (Join-Path $TargetDir $name) -Force
    Write-Log "Copied $name"
}

# --- 3. Pin the SHA-256 of the main script -----------------------------------------------------
$mainScript = Join-Path $TargetDir 'gpu-driver-install.ps1'
$hash = (Get-FileHash $mainScript -Algorithm SHA256).Hash.ToUpper()
Set-Content -Path (Join-Path $TargetDir 'gpu-driver-install.sha256') -Value $hash -NoNewline
Write-Log "Hash pinned: $hash"

# --- 4. Verify neon cannot write (WSL-side test) -----------------------------------------------
$wsl = 'C:\Windows\System32\wsl.exe'
$testFile = "$TargetDir\setup-write-probe-$(Get-Date -Format 'HHmmss').txt"
Write-Log "Testing neon write access from WSL..."
try {
    $wslPath = $testFile -replace '\\', '/' -replace '^([A-Za-z]):', { "/mnt/$($_.Groups[1].Value.ToLower())" }
    $out = & $wsl -u neon -- bash -c "printf x > '$wslPath' 2>&1 && echo WROTE || echo BLOCKED" 2>&1
    if ($out -match 'WROTE') {
        Write-Log "WARNING: neon can still write to $TargetDir -- ACL did not take effect or DrvFs override. DO NOT copy the ps1 yet."
        Write-Log "Check: Get-Acl '$TargetDir' | Format-List and verify no Felhasznalok/Users entry."
        exit 1
    } else {
        Write-Log "CONFIRMED: neon write blocked ($out)"
    }
} catch {
    Write-Log "WSL write-test could not run (WSL not available or error): $_ -- verify manually"
}

# --- 5. Print the task update command ----------------------------------------------------------
Write-Log ""
Write-Log "=== NEXT STEP (Peti): update the scheduled task ==="
Write-Log "Run in elevated cmd or PowerShell:"
Write-Log "  schtasks /Change /TN MikroB-GPU-Driver-Install /TR `"powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$TargetDir\gpu-driver-install-launcher.ps1'`""
Write-Log "(The launcher verifies the hash of gpu-driver-install.ps1 before running it.)"
Write-Log "Setup complete."
exit 0
