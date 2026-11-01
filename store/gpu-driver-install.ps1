# gpu-driver-install.ps1 -- the Windows-side admin script for the GPU-driver silent install
# (card 8b588834, GPU-driver figyelo (C), plan-grilling GO-WITH-CHANGES komment 15819).
#
# THIS FILE IS NOT RUN BY THIS REPO. It is copied BY HAND, by Peti, as the final admin-only step
# (comment 5945/8258 on this card), into C:\ProgramData\MikroB-Drivers -- a folder with an EXPLICIT, non-inherited ACL
# (SYSTEM Full + Administrators Full, Users/neon removed; verified by gpu-driver-install-setup.ps1).
# It is invoked ONLY via the hash-checking launcher (gpu-driver-install-launcher.ps1), itself
# called by the pre-registered Windows scheduled task "MikroB-GPU-Driver-Install" (Run As NEON,
# Interactive, RunLevel Highest, no trigger -- it only runs on `schtasks /run`), which
# store/gpu-driver-silent-install-trigger.sh fires with NO parameters. This script therefore reads NOTHING from its caller -- every input it needs it
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
# genuinely-downloaded NVIDIA installer BEFORE this script is copied to C:\ProgramData\MikroB-Drivers for
# the first time -- the value below is a common-knowledge placeholder, not a verified fact. The
# download-URL field name (see the main block below) has the same status: unconfirmed against a
# live response, fail-closed until then.
#
# Exit codes: 0 = installed (or already up to date, nothing to do). Non-zero = refused/failed,
# fail-closed, no install attempted. Every refusal and every step is written to
# $LogPath (C:\ProgramData\MikroB-Drivers\gpu-driver-install.log) -- Peti/RedHat's gate reads this file,
# this script never silently succeeds or silently skips a check.
#
# F1 (card 78696360, WhiteHat finding): `schtasks /run /TN MikroB-GPU-Driver-Install` can be
# invoked by ANY local process, bypassing store/gpu-driver-silent-install-trigger.sh entirely --
# that script's own approval/board-idle checks protect nothing once the task is fired directly.
# This script therefore now performs its OWN approval check (Test-FreshApproval below) before
# doing anything else, using the SAME /api/approvals category and the SAME shared dashboard
# bearer token the WSL side uses. IMPORTANT, STATED EXPLICITLY SO IT IS NOT MISTAKEN FOR A FULL
# FIX: this closes the "bypass the WSL trigger script" path (an unapproved direct schtasks /run
# no longer silently proceeds), but it does NOT close the underlying forgeability -- anyone who
# can reach the dashboard with the shared bearer can still POST a fake approval, same as the WSL
# side already could. Full closure needs a non-forgeable, per-caller approval channel (card
# 3fb0ef97, BLOCKED-terv, not done). This is the "do the ps1-side check now regardless" half of
# MikroB's decision (card comment, F1); the other half stays blocked on 3fb0ef97.
# This script keeps its OWN used-approval-id marker file ($UsedApprovalsPath, on the Windows
# side), separate from the WSL trigger's own state -- a direct schtasks bypass never goes through
# the WSL script, so it cannot share that script's replay-guard state, and must not be able to
# reuse an approval the WSL side already consumed either (hence the two markers are each
# independently sufficient to block a replay, not alternatives to pick one of).
#
# F3 (card 78696360, WhiteHat finding): the only prior Authenticode check pinned the certificate
# SUBJECT string alone, with no fingerprint/issuer pin and no pinned expected download host.
# $ExpectedSignerThumbprint and $ExpectedDownloadHost below add both, each following the EXACT
# same "unverified placeholder, must be confirmed before first real run" convention this file
# already uses for $ExpectedSignerSubject (see TODO above) -- no fabricated value is asserted as
# fact. Test-AuthenticodeIsNvidia now REQUIRES the thumbprint to be non-empty and match, so until
# a human fills in a real, verified thumbprint, this check can never pass on subject alone (a
# strengthening, not a loosening, of the previous behaviour).

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

# F3: UNVERIFIED, intentionally empty -- no real NVIDIA installer has been signature-inspected yet
# (same TODO as $ExpectedSignerSubject above). Left empty rather than guessed, which means
# Test-AuthenticodeIsNvidia below FAILS CLOSED until a human runs Get-AuthenticodeSignature on a
# real, genuinely-downloaded installer and fills this in -- a real driver can never install on
# subject-match alone any more.
$ExpectedSignerThumbprint = ''

# F3: UNVERIFIED placeholder, same status as the two constants above -- no cited NVIDIA-owned
# source for the real download host was found (see file header TODO: docs.nvidia.com and
# forums.developer.nvidia.com are outside quarantine-reader's fetch allowlist). Populate with the
# real, confirmed host before the (currently unwired, see main block below) download step is ever
# implemented; Test-DownloadHostIsPinned fails closed while this is empty.
$ExpectedDownloadHost = ''

# F1 (card 2a80c6cb): scoped token for this category ONLY. This is NOT the shared fleet
# .dashboard-token -- that file must NEVER be placed in C:\ProgramData\MikroB-Drivers. The scoped
# token is provisioned separately (per-agent token plan, card 3fb0ef97) and is valid for
# /api/approvals?category=gpu-driver-silent-install reads and /api/approvals/:id/consume-oneshot
# calls only. gpu-driver-install-setup.ps1 Phase 2 verifies the ACL is narrowed (SYSTEM+Admin,
# no Users) BEFORE placing this token.
$ApprovalApiBase = 'http://localhost:3420'
$ApprovalCategory = 'gpu-driver-silent-install'
$ApprovalWindowSeconds = 3600
$GpuDriverTokenPath = Join-Path $PSScriptRoot 'gpu-driver-approval.token'
# F1: this script's OWN used-approval marker, independent of the WSL trigger's state file (see
# file header) -- a direct schtasks bypass never touches the WSL side's state.
$UsedApprovalsPath = Join-Path $PSScriptRoot 'gpu-driver-install-used-approvals.json'
# F3: mutex name for atomic check-and-record (prevents concurrent schtasks runs consuming
# the same approval independently).
$ApprovalMutexName = 'Global\MikroB-GPU-Driver-ApprovalConsume'

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

# Fail-closed Authenticode check: Valid signature status, the pinned Subject, AND (F3) the pinned
# certificate thumbprint. A subject string alone can be present on more than one certificate (a
# reissued or differently-scoped cert can carry the same Subject); the thumbprint identifies the
# ONE specific certificate this script trusts. A driver package whose signature does not resolve,
# resolves to a different signer, or does not match the pinned thumbprint is never installed.
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
    if ([string]::IsNullOrEmpty($ExpectedSignerThumbprint)) {
        Write-Log "authenticode: FAIL-CLOSED -- `$ExpectedSignerThumbprint is not yet populated (see file header TODO), subject-match alone is no longer sufficient -- refusing $Path"
        return $false
    }
    if ($sig.SignerCertificate.Thumbprint -ne $ExpectedSignerThumbprint) {
        Write-Log "authenticode: signer thumbprint '$($sig.SignerCertificate.Thumbprint)' does not match pinned '$ExpectedSignerThumbprint' -- refusing $Path"
        return $false
    }
    return $true
}

# F4 (card 2a80c6cb): pins the download URL before any download is attempted.
# Checks: (a) HTTPS-only, (b) INITIAL host matches pinned $ExpectedDownloadHost, (c) follows
# redirects to the FINAL URI and re-checks the host (a cdn.geforce.com redirect from
# international.download.nvidia.com is a known pattern; the final host must also be pinned),
# (d) certificate public-key pin ($ExpectedCertPublicKeyPin, UNVERIFIED placeholder -- empty
# means fail-closed, same convention as $ExpectedSignerThumbprint above). Not yet called from
# the main block because the download step itself is not wired yet (see file header TODO).
#
# $ExpectedCertPublicKeyPin format: base64(SHA256(SubjectPublicKeyInfo DER bytes)) -- the
# standard HPKP / curl --pinnedpubkey format. Populate with the real pin before first real run.
$ExpectedCertPublicKeyPin = ''

function Test-DownloadHostIsPinned {
    param([Parameter(Mandatory)][string]$Url)
    if ([string]::IsNullOrEmpty($ExpectedDownloadHost)) {
        Write-Log "download-host: FAIL-CLOSED -- `$ExpectedDownloadHost is not yet populated (see file header TODO) -- refusing $Url"
        return $false
    }
    # (a) HTTPS-only: reject any non-https URL before making any network call.
    try {
        $parsedUri = [Uri]$Url
    } catch {
        Write-Log "download-host: could not parse '$Url' as a URL -- refusing"
        return $false
    }
    if ($parsedUri.Scheme -ne 'https') {
        Write-Log "download-host: '$Url' is not https -- refusing (only https downloads allowed)"
        return $false
    }
    # (b) Initial host check.
    if ($parsedUri.Host -ne $ExpectedDownloadHost) {
        Write-Log "download-host: initial host '$($parsedUri.Host)' does not match pinned '$ExpectedDownloadHost' -- refusing $Url"
        return $false
    }
    # (c) Follow redirects and re-check the FINAL URI host (cdn.geforce.com redirect pattern).
    try {
        $resp = Invoke-WebRequest -Uri $Url -Method Head -MaximumRedirection 10 -UseBasicParsing `
            -TimeoutSec 15 -ErrorAction Stop
        $finalHost = ([Uri]$resp.BaseResponse.ResponseUri.ToString()).Host
    } catch {
        Write-Log "download-host: FAIL-CLOSED -- redirect-follow HEAD call failed: $_ -- refusing $Url"
        return $false
    }
    if ($finalHost -ne $ExpectedDownloadHost) {
        Write-Log "download-host: final (post-redirect) host '$finalHost' does not match pinned '$ExpectedDownloadHost' -- refusing $Url"
        return $false
    }
    # (d) Certificate public-key pin (fail-closed while placeholder is empty).
    if ([string]::IsNullOrEmpty($ExpectedCertPublicKeyPin)) {
        Write-Log "download-host: FAIL-CLOSED -- `$ExpectedCertPublicKeyPin is not yet populated (see file header TODO) -- refusing $Url"
        return $false
    }
    # NOTE: PowerShell's Invoke-WebRequest does not expose the raw certificate in a
    # cross-platform way; the caller of the download step must verify the chain/key pin
    # using [System.Net.HttpWebRequest] with a custom ServerCertificateValidationCallback,
    # or via certutil after download. This placeholder ensures the requirement is visible
    # and fail-closed until the full implementation is wired.
    Write-Log "download-host: FAIL-CLOSED -- certificate public-key pin verification not yet implemented -- refusing $Url"
    return $false
}

# F1/F2/F3 (card 2a80c6cb): the ps1-side approval check. Returns $true only if a FRESH,
# approved, not-yet-used-by-THIS-script approval exists for $ApprovalCategory.
# F1: uses $GpuDriverTokenPath (scoped token), NOT the shared fleet .dashboard-token.
# F2: after local record, calls POST /api/approvals/:id/consume-oneshot for server-side
#     atomic consumption; if the server returns 409 (already consumed), the approval is
#     rejected even when the local state file was corrupt/missing (replay from a wiped state
#     is blocked server-side).
# F3: the check-and-record block runs under a named mutex to prevent concurrent schtasks
#     runs from each independently consuming the same approval.
# Fail-closed on every unexpected shape (no token, unreachable API, malformed response).
function Test-FreshApproval {
    if (-not (Test-Path $GpuDriverTokenPath)) {
        Write-Log "approval: FAIL-CLOSED -- no scoped token at $GpuDriverTokenPath (must be provisioned separately from the shared fleet token; see file header F1)"
        return $false
    }
    $token = (Get-Content -Path $GpuDriverTokenPath -Raw).Trim()

    # F3: acquire the named mutex before reading usedIds, so two concurrent runs cannot
    # each see the approval as fresh and both proceed.
    $mutex = New-Object System.Threading.Mutex($false, $ApprovalMutexName)
    $gotMutex = $false
    try {
        $gotMutex = $mutex.WaitOne(5000)  # wait up to 5s; fail-closed if not acquired
    } catch [System.Threading.AbandonedMutexException] {
        $gotMutex = $true  # previous holder crashed; mutex is ours
        Write-Log "approval: inherited abandoned mutex (previous holder crashed)"
    }
    if (-not $gotMutex) {
        Write-Log "approval: FAIL-CLOSED -- could not acquire mutex $ApprovalMutexName within 5s (another install in progress?)"
        $mutex.Dispose()
        return $false
    }
    try {
        $usedIds = @()
        if (Test-Path $UsedApprovalsPath) {
            try {
                $parsed = Get-Content -Path $UsedApprovalsPath -Raw | ConvertFrom-Json
                if ($parsed.usedApprovalIds) { $usedIds = @($parsed.usedApprovalIds) }
            } catch {
                Write-Log "approval: could not parse $UsedApprovalsPath, treating as empty: $_"
            }
        }

        $uri = "$ApprovalApiBase/api/approvals?category=$ApprovalCategory&status=approved&limit=5"
        try {
            $approvals = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 10 -Headers @{ Authorization = "Bearer $token" }
        } catch {
            Write-Log "approval: FAIL-CLOSED -- /api/approvals call failed: $_"
            return $false
        }
        if (-not $approvals) {
            Write-Log "approval: FAIL-CLOSED -- empty/unexpected /api/approvals response"
            return $false
        }

        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        foreach ($a in @($approvals)) {
            if ($a.status -ne 'approved') { continue }
            if ($null -eq $a.resolved_at) { continue }
            if (($now - [int64]$a.resolved_at) -gt $ApprovalWindowSeconds) { continue }
            if (-not $a.id) { continue }
            if ($usedIds -contains $a.id) { continue }

            # F2: server-side atomic consume BEFORE local record. If 409, the server has
            # already consumed this approval (replay from a wiped/corrupt local state file).
            $consumeUri = "$ApprovalApiBase/api/approvals/$($a.id)/consume-oneshot"
            try {
                $consumeBody = [System.Text.Encoding]::UTF8.GetBytes(('{"category":"' + $ApprovalCategory + '"}'))
                $consumeResp = Invoke-WebRequest -Uri $consumeUri -Method Post -TimeoutSec 10 `
                    -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } `
                    -Body $consumeBody -UseBasicParsing -ErrorAction Stop
                if ($consumeResp.StatusCode -ne 200) {
                    Write-Log "approval: server-side consume returned $($consumeResp.StatusCode) for $($a.id) -- skipping"
                    continue
                }
            } catch {
                # A 409 from Invoke-WebRequest throws; any non-200 means do not proceed.
                Write-Log "approval: FAIL-CLOSED -- server-side consume call failed for $($a.id): $_ -- skipping (replay blocked)"
                continue
            }

            # Server accepted; record locally (belt-and-suspenders -- server-side is the
            # authoritative guard, local file prevents a useless re-query on restart).
            $usedIds += $a.id
            $out = @{ usedApprovalIds = $usedIds } | ConvertTo-Json
            Set-Content -Path $UsedApprovalsPath -Value $out
            Write-Log "approval: fresh approval $($a.id) accepted and consumed server-side, recorded locally"
            return $true
        }
        Write-Log "approval: no fresh, unused, approved request for category=$ApprovalCategory within ${ApprovalWindowSeconds}s"
        return $false
    } finally {
        if ($gotMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
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

    if (-not (Test-FreshApproval)) {
        Write-Log "FAIL-CLOSED: no fresh approval found by this script's own check -- refusing to proceed (see file header F1)"
        exit 1
    }

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
    # if (-not (Test-DownloadHostIsPinned -Url $downloadUrl)) { exit 1 }
    # if (-not (Test-AuthenticodeIsNvidia -Path $installerPath)) { exit 1 }
    # if (-not (Start-SilentInstall -InstallerPath $installerPath)) { exit 1 }
    # Write-Log "install succeeded: $installedVersion -> $availableVersion. wsl --shutdown is NOT run by this script (separate, approval-gated step)."
    # exit 0
} catch {
    Write-Log "FAIL-CLOSED: unhandled error: $_"
    exit 1
}
