# gpu-driver-install.ps1 -- the Windows-side admin script for the GPU-driver silent install
# (card 8b588834, GPU-driver figyelo (C), plan-grilling GO-WITH-CHANGES komment 15819).
#
# THIS FILE IS NOT RUN BY THIS REPO. It is copied BY HAND, by Peti, as the final admin-only step
# (comment 5945/8258 on this card), into C:\ProgramData\MikroB -- a folder only Administrators and
# SYSTEM can write to (measured: icacls shows "Felhasznalok RX, SYSTEM F, Rendszergazdak F, no
# inheritance"; WSL-from-neon write attempts into it already measured as "Permission denied",
# comment 8258). It is invoked ONLY by the pre-registered Windows scheduled task
# "MikroB-GPU-Driver-Install" (Run As NEON, Interactive, RunLevel Highest, no trigger -- it only
# runs on `schtasks /run`), which store/gpu-driver-silent-install-trigger.sh fires with NO
# parameters. This script therefore reads NOTHING from its caller -- every input it needs it
# fetches, verifies, and decides for itself, on the Windows side, natively.
#
# WHY THE VERSION QUERY RUNS HERE (not reused from the WSL-side gpu-driver-available-parse.sh):
# plan-grilling point (c)2 requires the version-query, download and verification to run in the
# Windows-side script. The WSL-side "available" figure (store/gpu-driver-state.json) is fed by the
# daily alert prompt via quarantine-reader + WebFetch, whose own tool description (WEBFETCHFAB819)
# warns its content is a MODEL-RECONSTRUCTED description of the page, not a byte-exact copy -- a
# plausible-looking driver version that is a model's reconstruction of the real page, not the real
# page, is exactly the WhiteHat2 N1 "determinisztikus lekérés" concern, and an install decision may
# not rest on it. This script performs its OWN native HTTPS call (Invoke-RestMethod), which never
# passes through an LLM -- so the install-decision version is independently, deterministically
# sourced, not inherited from the alert path. It reuses the alert path's already-researched,
# source-cited endpoint and query parameters (see gpu-driver-available-parse.sh header:
# gfwsl.geforce.com AjaxDriverService, pfid=892/osID=135 for this host's GTX 1660 Ti / Windows 11)
# and the same validated-extraction rules (Success as a NUMBER not a truthy string, IsCRD match,
# LARGEST matching version wins, bounded dotted-numeric segments) ported from
# gpu-driver-available-parse.sh's Python validator -- WhiteHat2 N1-N3 on that script's gate
# (komment 17641) apply here verbatim, and this port keeps the same three rules so a future fix to
# one is not silently missed in the other.
#
# SILENT-INSTALL FLAGS (GitHub-first, cited): "/s /noreboot", retrieved from
# ElPumpo/TinyNvidiaUpdateChecker, TinyNvidiaUpdateChecker/Forms/ReadyInstallForm.cs,
# handleInstall()'s confirmDL branch -- that is the same upstream repo this card's predecessor
# (9482a764) already adopted for the AjaxDriverService endpoint. No official NVIDIA-owned-domain
# page was independently fetched and confirmed for this (docs.nvidia.com/forums.nvidia.com are
# outside quarantine-reader's allowlist, so the only quote actually fetched is this one).
#
# TODO (blocks first real run, NOT fabricated here per the "tenyek es talalgatas" rule --
# Peti/MikroB CLAUDE.md): the installer's Authenticode Subject/Issuer below ($ExpectedSignerSubject)
# is UNVERIFIED -- no cited NVIDIA-owned source for the exact string was found (checked:
# www.nvidia.com GeForce forums and forums.developer.nvidia.com render JS-only or are outside the
# fetch allowlist; one old forum post actually contradicts a DigiCert assumption, mentioning
# Verisign). It must be confirmed by actually running `Get-AuthenticodeSignature` on a real,
# genuinely-downloaded NVIDIA installer BEFORE this script is copied to C:\ProgramData\MikroB for
# the first time -- the value below is a common-knowledge placeholder, not a verified fact. The
# download-URL field name (see the main block below) has the same status: unconfirmed against a
# live response, fail-closed until then.
#
# Exit codes: 0 = installed (or already up to date, nothing to do). Non-zero = refused/failed,
# fail-closed, no install attempted. Every refusal and every step is written to
# $LogPath (C:\ProgramData\MikroB\gpu-driver-install.log) -- Peti/RedHat's gate reads this file,
# this script never silently succeeds or silently skips a check.

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$LogPath = Join-Path $PSScriptRoot 'gpu-driver-install.log'
$CheckpointDir = Join-Path $PSScriptRoot 'checkpoints'

# Fixed to this host's product/OS IDs -- same values gpu-driver-available-parse.sh already cites
# a source for (ZenitH-AT/nvidia-data gpu-data.json/os-data.json): GTX 1660 Ti desktop, Windows 11.
$ProductId = 892
$OsId = 135
$ApiUrl = "https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&pfid=$ProductId&osID=$OsId&dch=1&numberOfResults=10&languageCode=1078"

# Game Ready (0) by default -- matches the WSL-side gpu-driver-available-parse.sh default audience
# for this card's plan-grilling scope; change only with the same decision this card's REVIEW makes.
$WantIsCrd = 0

# UNVERIFIED (see file header TODO) Authenticode identity for a genuine NVIDIA driver package --
# a common-knowledge value, not confirmed against a cited NVIDIA source or a real signed installer.
# Left here as the single named constant the script checks against, so a future correction (after
# someone actually runs Get-AuthenticodeSignature on a real installer) is a one-line change.
$ExpectedSignerSubject = 'CN=NVIDIA Corporation, O=NVIDIA Corporation'

function Write-Log {
    param([string]$Message)
    $line = "[{0:yyyy-MM-dd HH:mm:ss}Z] {1}" -f (Get-Date).ToUniversalTime(), $Message
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

# Mirrors gpu-driver-available-parse.sh's Python validator: WhiteHat2 N2 (Success as a NUMBER, a
# truthy non-empty string "0" must NOT pass), N3 (pick the LARGEST matching version, not the
# first one), N1 (bounded dotted-numeric segments, all-zero rejected). Returns $null on any
# failure to validate -- the caller treats $null as fail-closed, no install.
function Get-ValidatedAvailableVersion {
    param([Parameter(Mandatory)][string]$Json, [Parameter(Mandatory)][int]$WantIsCrd)

    try {
        $data = $Json | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Log "version-query: JSON parse failed: $_"
        return $null
    }

    $successOk = $false
    try { $successOk = ([int]"$($data.Success)" -ne 0) } catch { $successOk = $false }
    if (-not $successOk -or -not $data.IDS) {
        Write-Log "version-query: no numeric non-zero Success or no IDS in response"
        return $null
    }

    $best = $null
    $bestParts = $null
    foreach ($entry in $data.IDS) {
        $info = $entry.downloadInfo
        if (-not $info) { continue }
        $isCrd = $null
        try { $isCrd = [int]"$($info.IsCRD)" } catch { continue }
        if ($isCrd -ne $WantIsCrd) { continue }
        $v = "$($info.Version)".Trim()
        if ($v -notmatch '^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$') { continue }
        $parts = $v.Split('.') | ForEach-Object { [int]$_ }
        if (($parts | Where-Object { $_ -ne 0 }).Count -eq 0) { continue }  # all-zero rejected
        if ($null -eq $bestParts -or (Compare-VersionParts $parts $bestParts) -gt 0) {
            $best = $v
            $bestParts = $parts
        }
    }
    if ($null -eq $best) {
        Write-Log "version-query: no matching IsCRD entry with a valid, non-zero, bounded Version"
        return $null
    }
    return $best
}

function Compare-VersionParts {
    param([int[]]$A, [int[]]$B)
    $n = [Math]::Max($A.Count, $B.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $a = if ($i -lt $A.Count) { $A[$i] } else { 0 }
        $b = if ($i -lt $B.Count) { $B[$i] } else { 0 }
        if ($a -ne $b) { return $a - $b }
    }
    return 0
}

# Fail-closed Authenticode check: Valid signature status AND the pinned Subject. A driver package
# whose signature does not resolve, or resolves to a different signer, is never installed.
function Test-AuthenticodeIsNvidia {
    param([Parameter(Mandatory)][string]$Path)
    $sig = Get-AuthenticodeSignature -FilePath $Path
    if ($sig.Status -ne 'Valid') {
        Write-Log "authenticode: status is $($sig.Status), not Valid -- refusing $Path"
        return $false
    }
    if ($sig.SignerCertificate.Subject -ne $ExpectedSignerSubject) {
        Write-Log "authenticode: signer subject '$($sig.SignerCertificate.Subject)' does not match pinned '$ExpectedSignerSubject' -- refusing $Path"
        return $false
    }
    return $true
}

# Checkpoint before any install attempt (recovery-prev-version.sh's own pattern: preserve the
# PREVIOUS state before touching anything, so a bad driver has a path back). Records the
# currently-installed version string (from nvidia-smi) and the previous downloaded installer, if
# this script still has it, into a timestamped folder -- never overwrites an earlier checkpoint.
function New-Checkpoint {
    param([Parameter(Mandatory)][string]$InstalledVersion)
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $dir = Join-Path $CheckpointDir $stamp
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Set-Content -Path (Join-Path $dir 'installed-version-before.txt') -Value $InstalledVersion
    Write-Log "checkpoint written: $dir (installed-version-before=$InstalledVersion)"
    return $dir
}

function Get-InstalledVersion {
    try {
        $out = & nvidia-smi.exe --query-gpu=driver_version --format=csv,noheader 2>$null
        return ($out | Select-Object -First 1).Trim()
    } catch {
        Write-Log "could not read currently installed driver version via nvidia-smi.exe: $_"
        return $null
    }
}

# Switches cited from ElPumpo/TinyNvidiaUpdateChecker (see file header) -- "/s" silent,
# "/noreboot" so this script, not the installer, controls any reboot (none is taken here; see
# the plan-grilling note in the main block below about wsl --shutdown being a separate step).
function Start-SilentInstall {
    param([Parameter(Mandatory)][string]$InstallerPath)
    $silentArgs = '/s /noreboot'
    Write-Log "starting silent install: $InstallerPath $silentArgs"
    $proc = Start-Process -FilePath $InstallerPath -ArgumentList $silentArgs -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -ne 0) {
        Write-Log "installer exited with code $($proc.ExitCode)"
        return $false
    }
    return $true
}

# --- main -----------------------------------------------------------------------------------
try {
    Write-Log "gpu-driver-install.ps1 starting"

    $installedVersion = Get-InstalledVersion
    if (-not $installedVersion) {
        Write-Log "FAIL-CLOSED: could not determine currently installed version, refusing to proceed"
        exit 1
    }

    $responseJson = $null
    try {
        $responseJson = Invoke-RestMethod -Uri $ApiUrl -Method Get -TimeoutSec 15 | ConvertTo-Json -Depth 10
    } catch {
        Write-Log "FAIL-CLOSED: version-query HTTPS call failed: $_"
        exit 1
    }

    $availableVersion = Get-ValidatedAvailableVersion -Json $responseJson -WantIsCrd $WantIsCrd
    if (-not $availableVersion) {
        Write-Log "FAIL-CLOSED: no validated available version -- refusing to proceed"
        exit 1
    }

    $availableParts = $availableVersion.Split('.') | ForEach-Object { [int]$_ }
    $installedParts = $installedVersion.Split('.') | ForEach-Object { [int]$_ }
    if ((Compare-VersionParts $availableParts $installedParts) -le 0) {
        Write-Log "available ($availableVersion) is not newer than installed ($installedVersion) -- nothing to do"
        exit 0
    }

    # TODO (see file header): the download URL for the actual installer .exe comes from this same
    # validated $downloadInfo entry (a field such as DownloadURL/DownloadURLWin per the upstream
    # schema) -- confirm the exact field name from the real, live response shape before first real
    # run, rather than assuming it here. Fail-closed if it is missing or not an https:// NVIDIA URL.
    Write-Log "FAIL-CLOSED: installer download step is not wired yet (download-URL field name pending confirmation, see file header TODO) -- refusing to proceed. available=$availableVersion installed=$installedVersion"
    exit 1

    # (Unreachable until the TODO above is resolved -- kept here so the intended flow is visible
    # to the gate reviewing this file, not hidden behind the early exit.)
    # $checkpointDir = New-Checkpoint -InstalledVersion $installedVersion
    # if (-not (Test-AuthenticodeIsNvidia -Path $installerPath)) { exit 1 }
    # if (-not (Start-SilentInstall -InstallerPath $installerPath)) { exit 1 }
    # Write-Log "install succeeded: $installedVersion -> $availableVersion. wsl --shutdown is NOT run by this script (separate, approval-gated step)."
    # exit 0
} catch {
    Write-Log "FAIL-CLOSED: unhandled error: $_"
    exit 1
}
