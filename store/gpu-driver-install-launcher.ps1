# gpu-driver-install-launcher.ps1 -- hash-checking launcher for gpu-driver-install.ps1
# (cards 8b588834/7857c82c, GPU-driver figyelő (C)).
#
# The scheduled task calls THIS script (with -ExecutionPolicy Bypass), not the main
# gpu-driver-install.ps1 directly.  Before launching the main script, this script:
#   1. Reads the expected SHA-256: first from $args[0] (task command line, set by
#      gpu-driver-install-setup.ps1 Phase 2 via schtasks /Change -- F1 fix), then from
#      gpu-driver-install.sha256 in the same directory (fallback for manual invocation).
#   2. Computes the actual SHA-256 of gpu-driver-install.ps1 (same directory).
#   3. If they match: runs the main script (no params, no extra flags).
#   4. If they DIFFER: logs and exits 1 -- fail-closed, no install.
#
# F1 rationale: the hash file sits in the ACL-protected directory (SYSTEM+Administrators
# only, set by setup.ps1 Phase 1), so neon cannot tamper with it.  But neon cannot READ it
# either, which would have required WSL-side path introspection to verify.  Putting the
# expected hash on the task command line makes the pinned value visible in the task
# definition (admin-only), without requiring neon read-access to the secured directory.
# The hash file remains as a fallback for manual/elevated invocations.
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
# F1: read expected hash from task command line arg ($args[0]) if provided; fall back to file.
if ($args.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($args[0])) {
    $expectedHash = $args[0].Trim().ToUpper()
    Write-Log "Expected hash from task command line: $expectedHash"
} elseif (Test-Path $HashFile) {
    $expectedHash = (Get-Content $HashFile -Raw).Trim().ToUpper()
    if ([string]::IsNullOrWhiteSpace($expectedHash)) {
        Write-Log "FAIL: $HashFile is empty"
        exit 1
    }
    Write-Log "Expected hash from file (fallback): $expectedHash"
} else {
    Write-Log "FAIL: no hash on command line and $HashFile not found -- run gpu-driver-install-setup.ps1 Phase 2 first"
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
