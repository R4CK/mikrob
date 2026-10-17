# gpu-driver-install-launcher.ps1 -- hash-checking launcher for gpu-driver-install.ps1
# (card 8b588834, GPU-driver figyelő (C), RedHat fix point 2).
#
# The scheduled task calls THIS script (with -ExecutionPolicy Bypass), not the main
# gpu-driver-install.ps1 directly.  Before launching the main script, this script:
#   1. Reads the expected SHA-256 from gpu-driver-install.sha256 (same directory).
#   2. Computes the actual SHA-256 of gpu-driver-install.ps1 (same directory).
#   3. If they match: runs the main script (no params, no extra flags).
#   4. If they DIFFER: logs and exits 1 -- fail-closed, no install.
#
# The hash file is written by gpu-driver-install-setup.ps1 (admin-only, Peti-run).
# Because the directory is SYSTEM+Administrators-only (ACL set by setup.ps1), the neon
# WSL user cannot tamper with either gpu-driver-install.ps1 OR gpu-driver-install.sha256.
# This launcher adds defence-in-depth: even if the ACL is somehow bypassed, an attacker
# who replaces the ps1 but not the hash file is blocked here.
#
# Exit 0 = main script ran (or will run; it exits separately).
# Exit 1 = hash mismatch, missing file, or error -- no install attempted.

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path $MyInvocation.MyCommand.Path
$MainScript = Join-Path $ScriptDir 'gpu-driver-install.ps1'
$HashFile   = Join-Path $ScriptDir 'gpu-driver-install.sha256'
$LogPath    = Join-Path $ScriptDir 'launcher.log'

function Write-Log {
    param([string]$Message)
    $line = "[{0:yyyy-MM-dd HH:mm:ss}Z] {1}" -f (Get-Date).ToUniversalTime(), $Message
    try { Add-Content -Path $LogPath -Value $line -ErrorAction SilentlyContinue } catch {}
    Write-Host $line
}

if (-not (Test-Path $MainScript)) {
    Write-Log "FAIL: $MainScript not found"
    exit 1
}
if (-not (Test-Path $HashFile)) {
    Write-Log "FAIL: $HashFile not found -- run gpu-driver-install-setup.ps1 first"
    exit 1
}

$expectedHash = (Get-Content $HashFile -Raw).Trim().ToUpper()
if ([string]::IsNullOrWhiteSpace($expectedHash)) {
    Write-Log "FAIL: $HashFile is empty"
    exit 1
}

$actualHash = (Get-FileHash $MainScript -Algorithm SHA256).Hash.ToUpper()

if ($actualHash -ne $expectedHash) {
    Write-Log "FAIL: SHA-256 mismatch -- expected $expectedHash, got $actualHash -- install BLOCKED"
    exit 1
}

Write-Log "SHA-256 verified ($actualHash) -- launching $MainScript"
& $MainScript
exit $LASTEXITCODE
