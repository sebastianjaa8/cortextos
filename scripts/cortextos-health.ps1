[CmdletBinding()]
param(
    [string]$Instance = 'default',
    [int]$MaxLogSizeMB = 100
)

$ErrorActionPreference = 'Stop'
$script:HealthFailures = 0
$ctxRoot = Join-Path $env:USERPROFILE ".cortextos\$Instance"
$pm2Root = Join-Path $env:USERPROFILE '.pm2'
$pm2LogDir = Join-Path $pm2Root 'logs'
$dumpFile = Join-Path $pm2Root 'dump.pm2'
$expectedDaemonName = "cortextos-daemon-$Instance"
$expectedDashboardName = "cortextos-dashboard-$Instance"
$nowEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$requiredFilterEnv = @('GITHUB_', 'GH_', 'TOKEN', 'SECRET', 'API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'PASSWORD', 'CREDENTIAL')

function Get-CiValue {
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    if ($property) { return $property.Value }
    return $null
}

function Get-ManifestValue {
    param([object]$Entry, [string]$Name)
    $direct = Get-CiValue $Entry $Name
    if ($null -ne $direct) { return $direct }
    foreach ($containerName in @('pm2_env', 'env')) {
        $container = Get-CiValue $Entry $containerName
        $nested = Get-CiValue $container $Name
        if ($null -ne $nested) { return $nested }
    }
    return $null
}

function ConvertFrom-Pm2JsonAllowlist {
    param([string]$Json)
    $reducer = @"
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const ci = (value, name) => {
  if (!value || typeof value !== 'object') return undefined;
  const key = Object.keys(value).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : value[key];
};
const field = (entry, name) => ci(entry, name) ?? ci(ci(entry, 'pm2_env'), name) ?? ci(ci(entry, 'env'), name);
const fields = ['name', 'pid', 'status', 'restart_time', 'pm_uptime', 'CTX_INSTANCE_ID', 'CTX_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'PORT', 'pm_exec_path', 'pm_cwd', 'kill_timeout', 'listen_timeout', 'wait_ready', 'shutdown_with_message', 'filter_env'];
const rows = (Array.isArray(input) ? input : []).map(entry => Object.fromEntries(fields.map(name => [name, field(entry, name)])));
process.stdout.write(JSON.stringify(rows));
"@
    $sanitized = $Json | & node -e $reducer
    if ($LASTEXITCODE -ne 0 -or -not $sanitized) { throw 'Node failed to reduce PM2 JSON to allowlisted fields' }
    $converted = $sanitized | ConvertFrom-Json
    foreach ($entry in @($converted)) { Write-Output $entry }
}

function Test-AgentExplicitlyDisabled {
    param([object]$Registry, [string]$Name)
    $entry = Get-CiValue $Registry $Name
    return $null -ne $entry -and (Get-CiValue $entry 'enabled') -eq $false
}
function ConvertFrom-JsonItems {
    param([string]$Json)
    $parsed = $Json | ConvertFrom-Json
    if ($null -eq $parsed) { return }
    foreach ($item in @($parsed)) {
        if ($null -ne $item) { Write-Output $item }
    }
}
function ConvertTo-Pm2Summary {
    param([object]$Entry, [switch]$Saved)
    $name = Get-ManifestValue $Entry 'name'
    if (-not ($name -is [string])) { return $null }
    $pidValue = Get-ManifestValue $Entry 'pid'
    $uptimeValue = Get-ManifestValue $Entry 'pm_uptime'
    [pscustomobject]@{
        Name          = $name
        Pid           = if ($pidValue -as [long]) { [long]$pidValue } else { 0 }
        Status        = if ($Saved) { $null } else { [string](Get-ManifestValue $Entry 'status') }
        Restarts      = if ($Saved) { 0 } else { [int](Get-ManifestValue $Entry 'restart_time') }
        PmUptimeMs    = if ($uptimeValue -as [long]) { [long]$uptimeValue } else { 0 }
        InstanceId    = [string](Get-ManifestValue $Entry 'CTX_INSTANCE_ID')
        CtxRoot       = [string](Get-ManifestValue $Entry 'CTX_ROOT')
        FrameworkRoot = [string](Get-ManifestValue $Entry 'CTX_FRAMEWORK_ROOT')
        ProjectRoot   = [string](Get-ManifestValue $Entry 'CTX_PROJECT_ROOT')
        Port          = [string](Get-ManifestValue $Entry 'PORT')
        ScriptPath    = [string](Get-ManifestValue $Entry 'pm_exec_path')
        Cwd           = [string](Get-ManifestValue $Entry 'pm_cwd')
        KillTimeout   = [int](Get-ManifestValue $Entry 'kill_timeout')
        ListenTimeout = [int](Get-ManifestValue $Entry 'listen_timeout')
        WaitReady     = [bool](Get-ManifestValue $Entry 'wait_ready')
        ShutdownMsg   = [bool](Get-ManifestValue $Entry 'shutdown_with_message')
        FilterEnv     = @((Get-ManifestValue $Entry 'filter_env'))
    }
}

function Add-HealthFailure {
    param([string]$Message)
    $script:HealthFailures++
    Write-Host "  [FAIL] $Message" -ForegroundColor Red
}

function Write-HealthOk {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Test-SamePath {
    param([string]$Left, [string]$Right)
    if (-not $Left -or -not $Right) { return $false }
    try { return [IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Right).TrimEnd('\') } catch { return $false }
}

function Test-CanonicalPm2App {
    param([object]$App)
    if ($App.Name -notmatch '^cortextos-(daemon|dashboard)-([a-z0-9_-]+)$') {
        Add-HealthFailure "non-canonical PM2 app name '$($App.Name)'"
        return
    }
    $kind = $Matches[1]
    $instanceId = $Matches[2]
    if ($App.InstanceId -ne $instanceId) { Add-HealthFailure "$($App.Name) has non-canonical CTX_INSTANCE_ID" }
    $expectedRoot = Join-Path $env:USERPROFILE ".cortextos\$instanceId"
    if (-not (Test-SamePath $App.CtxRoot $expectedRoot)) { Add-HealthFailure "$($App.Name) has non-canonical CTX_ROOT" }
    if (-not $App.FrameworkRoot -or -not (Test-SamePath $App.ProjectRoot $App.FrameworkRoot)) { Add-HealthFailure "$($App.Name) has divergent framework/project roots" }
    if ($kind -eq 'daemon') {
        if (-not (Test-SamePath $App.ScriptPath (Join-Path $App.FrameworkRoot 'dist\daemon.js'))) { Add-HealthFailure "$($App.Name) has non-canonical script" }
        if (-not (Test-SamePath $App.Cwd $App.FrameworkRoot)) { Add-HealthFailure "$($App.Name) has non-canonical cwd" }
        if (-not $App.WaitReady) { Add-HealthFailure "$($App.Name) is missing wait_ready" }
        if (-not $App.ShutdownMsg) { Add-HealthFailure "$($App.Name) is missing shutdown_with_message" }
    } else {
        if (-not (Test-SamePath $App.Cwd (Join-Path $App.FrameworkRoot 'dashboard'))) { Add-HealthFailure "$($App.Name) has non-canonical cwd" }
        if (-not (Test-SamePath $App.ScriptPath (Join-Path $App.FrameworkRoot 'dashboard\node_modules\next\dist\bin\next'))) { Add-HealthFailure "$($App.Name) has non-canonical script" }
        if ($App.Port -ne [string](Get-DashboardPortForInstance $instanceId)) { Add-HealthFailure "$($App.Name) has non-canonical PORT" }
    }
    if ($App.KillTimeout -ne 60000) { Add-HealthFailure "$($App.Name) kill_timeout is $($App.KillTimeout), expected 60000" }
    if ($App.ListenTimeout -ne 120000) { Add-HealthFailure "$($App.Name) listen_timeout is $($App.ListenTimeout), expected 120000" }
    $actualFilters = @($App.FilterEnv | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $filterDiff = @(Compare-Object -ReferenceObject @($requiredFilterEnv | Sort-Object) -DifferenceObject $actualFilters)
    if ($filterDiff.Count -gt 0) { Add-HealthFailure "$($App.Name) filter_env does not match the required policy" }
}
function Test-PidAlive {
    param([long]$PidValue)
    if ($PidValue -le 0) { return $false }
    return $null -ne (Get-Process -Id $PidValue -ErrorAction SilentlyContinue)
}

function Get-DashboardPortForInstance {
    param([string]$InstanceId)
    if ($InstanceId -eq 'default') { return 3000 }
    [uint32]$hash = 2166136261
    foreach ($char in $InstanceId.ToCharArray()) {
        $xor = [uint32]($hash -bxor [uint32][char]$char)
        $hash = [uint32](([uint64]$xor * 16777619) -band 0xffffffff)
    }
    return 3100 + ([uint32]$hash % 20000)
}
function Get-LogMatchCount {
    param([string[]]$Paths, [string]$Pattern)
    $count = 0
    foreach ($path in $Paths) {
        if (-not (Test-Path $path)) { continue }
        $matches = Select-String -Path $path -Pattern $Pattern -AllMatches -ErrorAction SilentlyContinue
        foreach ($match in @($matches)) { $count += $match.Matches.Count }
    }
    return $count
}

Write-Host ''
Write-Host '===== cortextOS Health Check =====' -ForegroundColor Cyan
Write-Host "Instance: $Instance"
Write-Host "CTX_ROOT: $ctxRoot"
Write-Host "Time: $([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz'))"
Write-Host ''

Write-Host '--- PM2 processes ---' -ForegroundColor Yellow
$liveSummaries = @()
$pm2Available = $false
try {
    $pm2Raw = & pm2 jlist 2>$null | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $pm2Raw.Trim()) { throw 'pm2 jlist returned no usable data' }
    $parsed = @(ConvertFrom-Pm2JsonAllowlist $pm2Raw)
    $liveSummaries = @($parsed | ForEach-Object { ConvertTo-Pm2Summary $_ } | Where-Object { $null -ne $_ })
    $parsed = $null
    $pm2Raw = $null
    $pm2Available = $true
} catch {
    Add-HealthFailure "PM2 unavailable or unreadable: $($_.Exception.Message)"
}

foreach ($app in $liveSummaries | Where-Object { $_.Name -match '^cortextos-(daemon|dashboard)(-|$)' }) {
    Test-CanonicalPm2App $app
}
$relevantLive = @($liveSummaries | Where-Object {
    $_.Name -match '^cortextos-(daemon|dashboard)(-|$)' -and
    ($_.InstanceId -eq $Instance -or $_.Name -eq $expectedDaemonName -or $_.Name -eq $expectedDashboardName -or ($Instance -eq 'default' -and $_.Name -in @('cortextos-daemon', 'cortextos-dashboard')))
})
foreach ($process in $relevantLive) {
    $uptimeMinutes = if ($process.PmUptimeMs -gt 0) {
        [math]::Round([math]::Max(0, $nowEpochMs - $process.PmUptimeMs) / 60000, 1)
    } else { 0 }
    $color = if ($process.Status -eq 'online') { 'Green' } else { 'Red' }
    Write-Host ("  {0,-34} {1,-9} pid={2,-7} restarts={3,-4} uptime={4}min" -f $process.Name, $process.Status, $process.Pid, $process.Restarts, $uptimeMinutes) -ForegroundColor $color
    if ($process.Status -ne 'online') { Add-HealthFailure "$($process.Name) is $($process.Status), not online" }
}

$duplicateNames = @($liveSummaries | Where-Object { $_.Name -match '^cortextos-(daemon|dashboard)(-|$)' } | Group-Object { $_.Name.ToLowerInvariant() } | Where-Object Count -gt 1)
foreach ($duplicate in $duplicateNames) { Add-HealthFailure "duplicate PM2 app name '$($duplicate.Name)' ($($duplicate.Count) entries)" }
$duplicateInstances = @($liveSummaries | Where-Object { $_.Name -match '^cortextos-daemon(-|$)' -and $_.InstanceId } | Group-Object InstanceId | Where-Object Count -gt 1)
foreach ($duplicate in $duplicateInstances) { Add-HealthFailure "instance '$($duplicate.Name)' is owned by $($duplicate.Count) daemon apps" }

$expectedDaemons = @($liveSummaries | Where-Object Name -eq $expectedDaemonName)
$legacyDaemons = @($liveSummaries | Where-Object { $_.Name -eq 'cortextos-daemon' -and ($_.InstanceId -eq $Instance -or (-not $_.InstanceId -and $Instance -eq 'default')) })
$legacyDashboards = @($liveSummaries | Where-Object { $_.Name -eq 'cortextos-dashboard' -and ($_.InstanceId -eq $Instance -or (-not $_.InstanceId -and $Instance -eq 'default')) })
if ($legacyDaemons.Count -gt 0) { Add-HealthFailure "legacy app 'cortextos-daemon' still owns this instance; migrate to '$expectedDaemonName'" }
if ($legacyDashboards.Count -gt 0) { Add-HealthFailure "legacy app 'cortextos-dashboard' still owns this instance; migrate to '$expectedDashboardName'" }
if ($pm2Available -and $expectedDaemons.Count -ne 1) { Add-HealthFailure "expected exactly one '$expectedDaemonName' app, found $($expectedDaemons.Count)" }
$instanceDashboards = @($liveSummaries | Where-Object Name -eq $expectedDashboardName)
if ($instanceDashboards.Count -gt 1) { Add-HealthFailure "expected at most one '$expectedDashboardName' app, found $($instanceDashboards.Count)" }
if ($instanceDashboards.Count -eq 1) {
    $expectedPort = [string](Get-DashboardPortForInstance $Instance)
    if ($instanceDashboards[0].Port -ne $expectedPort) { Add-HealthFailure "$expectedDashboardName uses PORT $($instanceDashboards[0].Port), expected $expectedPort" }
}
$dashboardPortCollisions = @($liveSummaries | Where-Object { $_.Name -match '^cortextos-dashboard-' -and $_.Port } | Group-Object Port | Where-Object Count -gt 1)
foreach ($collision in $dashboardPortCollisions) { Add-HealthFailure "dashboard port $($collision.Name) is shared by $($collision.Count) apps" }
Write-Host ''

Write-Host '--- Saved/live PM2 manifest ---' -ForegroundColor Yellow
if (-not (Test-Path $dumpFile)) {
    Add-HealthFailure "saved PM2 manifest missing at $dumpFile; rerun cortextos start for this instance"
} elseif ($pm2Available) {
    try {
        $dumpParsed = @(ConvertFrom-Pm2JsonAllowlist (Get-Content $dumpFile -Raw))
        $savedSummaries = @($dumpParsed | ForEach-Object { ConvertTo-Pm2Summary $_ -Saved } | Where-Object { $null -ne $_ })
        $dumpParsed = $null
        $liveNames = @($liveSummaries | Where-Object { $_.Name -match '^cortextos-(daemon|dashboard)(-|$)' } | ForEach-Object Name | Sort-Object)
        $savedNames = @($savedSummaries | Where-Object { $_.Name -match '^cortextos-(daemon|dashboard)(-|$)' } | ForEach-Object Name | Sort-Object)
        $duplicateSavedNames = @($savedNames | Group-Object | Where-Object Count -gt 1)
        foreach ($duplicate in $duplicateSavedNames) { Add-HealthFailure "duplicate saved PM2 app name '$($duplicate.Name)' ($($duplicate.Count) entries)" }
        $manifestDiff = @(Compare-Object -ReferenceObject $liveNames -DifferenceObject $savedNames)
        if ($manifestDiff.Count -gt 0) {
            $details = ($manifestDiff | ForEach-Object { "$($_.InputObject) $($_.SideIndicator)" }) -join ', '
            Add-HealthFailure "live/saved app sets differ: $details"
        } else {
            Write-HealthOk 'live and saved cortextOS app sets match'
        }

        foreach ($live in $liveSummaries | Where-Object { $_.Name -match '^cortextos-(daemon|dashboard)(-|$)' }) {
            $saved = @($savedSummaries | Where-Object Name -eq $live.Name)
            if ($saved.Count -ne 1) { continue }
            foreach ($field in @('InstanceId', 'CtxRoot', 'FrameworkRoot', 'ProjectRoot', 'ScriptPath', 'Cwd', 'Port', 'KillTimeout', 'ListenTimeout', 'WaitReady', 'ShutdownMsg')) {
                if ($live.$field -ne $saved[0].$field) {
                    Add-HealthFailure "$($live.Name) saved/live $field mismatch"
                }
            }
            $liveFilters = @($live.FilterEnv | ForEach-Object { [string]$_ } | Sort-Object -Unique)
            $savedFilters = @($saved[0].FilterEnv | ForEach-Object { [string]$_ } | Sort-Object -Unique)
            if (($liveFilters -join '|') -ne ($savedFilters -join '|')) {
                Add-HealthFailure "$($live.Name) saved/live FilterEnv mismatch"
            }        }
    } catch {
        Add-HealthFailure "saved manifest is unreadable: $($_.Exception.Message)"
    }
}
Write-Host ''

Write-Host '--- Daemon PID and lock ownership ---' -ForegroundColor Yellow
$daemonPidFile = Join-Path $ctxRoot 'daemon.pid'
$lockPidFile = Join-Path $ctxRoot '.daemon-instance\.lock.d\pid'
$lockMetadataFile = Join-Path $ctxRoot '.daemon-instance\.lock.d\metadata.json'
$lockHeartbeatFile = Join-Path $ctxRoot '.daemon-instance\.lock.d\heartbeat'
$daemonPid = 0L
$lockPid = 0L
if (Test-Path $daemonPidFile) {
    $rawPid = (Get-Content $daemonPidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if (-not [long]::TryParse($rawPid, [ref]$daemonPid) -or $daemonPid -le 0) {
        Add-HealthFailure "daemon PID file is invalid: $daemonPidFile"
    } elseif (-not (Test-PidAlive $daemonPid)) {
        Add-HealthFailure "daemon.pid points to dead PID $daemonPid"
    } else {
        Write-HealthOk "daemon PID $daemonPid is alive"
    }
} else {
    Add-HealthFailure "daemon PID file missing: $daemonPidFile"
}

if (Test-Path $lockPidFile) {
    $rawLockPid = (Get-Content $lockPidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if (-not [long]::TryParse($rawLockPid, [ref]$lockPid) -or $lockPid -le 0) {
        Add-HealthFailure "daemon instance lock PID is invalid: $lockPidFile"
    } elseif ($daemonPid -gt 0 -and $lockPid -ne $daemonPid) {
        Add-HealthFailure "lock/PID mismatch: daemon.pid=$daemonPid lock=$lockPid"
    } elseif (-not (Test-PidAlive $lockPid)) {
        Add-HealthFailure "daemon instance lock belongs to dead PID $lockPid"
    } else {
        Write-HealthOk "daemon lock owner matches PID $lockPid"
    }
} else {
    Add-HealthFailure "daemon instance lock missing: $lockPidFile"
}

try {
    if (-not (Test-Path $lockMetadataFile) -or -not (Test-Path $lockHeartbeatFile)) { throw 'metadata or heartbeat is missing' }
    $lockMetadata = Get-Content $lockMetadataFile -Raw | ConvertFrom-Json
    $lockHeartbeat = Get-Content $lockHeartbeatFile -Raw | ConvertFrom-Json
    $metadataToken = [string](Get-CiValue $lockMetadata 'ownerToken')
    $heartbeatToken = [string](Get-CiValue $lockHeartbeat 'ownerToken')
    $metadataPid = [long](Get-CiValue $lockMetadata 'pid')
    $heartbeatTouched = [DateTimeOffset]::Parse([string](Get-CiValue $lockHeartbeat 'touchedAt'))
    $heartbeatAgeMs = $nowEpochMs - $heartbeatTouched.ToUnixTimeMilliseconds()
    if ((Get-CiValue $lockMetadata 'version') -ne 1 -or $metadataToken -notmatch '^[a-f0-9]{64}$') { throw 'metadata is invalid' }
    if ($metadataPid -ne $daemonPid -or $metadataPid -ne $lockPid) { throw 'metadata PID mismatch' }
    if ($heartbeatToken -ne $metadataToken) { throw 'heartbeat token mismatch' }
    if ($heartbeatAgeMs -lt -5000 -or $heartbeatAgeMs -gt 90000) { throw 'heartbeat is stale or future-dated' }
    Write-HealthOk ('daemon fenced-lock token matches and heartbeat is fresh ({0}ms)' -f $heartbeatAgeMs)
} catch {
    Add-HealthFailure ('daemon fenced-lock validation failed: {0}' -f $PSItem.Exception.Message)
}

if ($expectedDaemons.Count -eq 1 -and $daemonPid -gt 0 -and $expectedDaemons[0].Pid -gt 0 -and $expectedDaemons[0].Pid -ne $daemonPid) {
    Add-HealthFailure "PM2 PID $($expectedDaemons[0].Pid) does not match daemon.pid $daemonPid"
}
Write-Host ''

$daemonAlive = $daemonPid -gt 0 -and (Test-PidAlive $daemonPid)
Write-Host '--- Enabled agent runtime status ---' -ForegroundColor Yellow
$cliPath = Join-Path $PSScriptRoot '..\dist\cli.js'
$frameworkRoot = if ($expectedDaemons.Count -eq 1) { $expectedDaemons[0].FrameworkRoot } else { $null }
if (-not (Test-Path $cliPath)) {
    Add-HealthFailure ('built CLI missing at {0}' -f $cliPath)
} elseif (-not $frameworkRoot -or -not (Test-Path $frameworkRoot)) {
    Add-HealthFailure 'canonical CTX_FRAMEWORK_ROOT is absent from the live daemon manifest'
} elseif ($daemonAlive) {
    $previousFrameworkRoot = $env:CTX_FRAMEWORK_ROOT
    $previousCtxRoot = $env:CTX_ROOT
    try {
        $env:CTX_FRAMEWORK_ROOT = $frameworkRoot
        $env:CTX_ROOT = $ctxRoot
        $agentStatusRaw = & node $cliPath status --instance $Instance --json 2>$null | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $agentStatusRaw.Trim()) { throw 'status IPC returned no usable data' }
        $agentStatuses = @(ConvertFrom-JsonItems $agentStatusRaw)
        $configuredRaw = & node $cliPath list-agents --instance $Instance --format json 2>$null | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $configuredRaw.Trim()) { throw 'configured agent discovery returned no usable data' }
        $configuredAgents = @(ConvertFrom-JsonItems $configuredRaw)
        $enabledRegistryPath = Join-Path $ctxRoot 'config\enabled-agents.json'
        if (-not (Test-Path $enabledRegistryPath)) { throw 'enabled-agents.json is missing' }
        $enabledRegistry = Get-Content $enabledRegistryPath -Raw | ConvertFrom-Json
        $enabledNames = @($configuredAgents | Where-Object {
            $_.enabled -eq $true -and
            -not [string]::IsNullOrWhiteSpace([string]$_.name) -and
            -not (Test-AgentExplicitlyDisabled $enabledRegistry ([string]$_.name))
        } | ForEach-Object { [string]$_.name } | Sort-Object -Unique)
        $agentStatuses = @($agentStatuses | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.name) })
        $liveNames = @($agentStatuses | ForEach-Object { [string]$_.name } | Sort-Object)
        foreach ($duplicate in @($liveNames | Group-Object | Where-Object Count -gt 1)) { Add-HealthFailure "live daemon registry contains duplicate agent '$($duplicate.Name)'" }
        $liveNames = @($liveNames | Sort-Object -Unique)
        $agentSetDiff = @(Compare-Object -ReferenceObject $enabledNames -DifferenceObject $liveNames)
        foreach ($difference in $agentSetDiff) {
            if ($difference.SideIndicator -eq '<=') { Add-HealthFailure "enabled agent '$($difference.InputObject)' is absent from the live daemon registry" }
            else { Add-HealthFailure "disabled or unconfigured agent '$($difference.InputObject)' is unexpectedly live" }
        }
        foreach ($agentStatus in $agentStatuses) {
            if ([string]$agentStatus.status -ne 'running') {
                $reason = if ($agentStatus.lastError) { ': {0}' -f $agentStatus.lastError } else { '' }
                Add-HealthFailure ('live agent ''{0}'' is {1}{2}' -f $agentStatus.name, $agentStatus.status, $reason)
            }
        }
        if ($agentSetDiff.Count -eq 0 -and @($agentStatuses | Where-Object status -ne 'running').Count -eq 0) { Write-HealthOk ('live agent set exactly matches {0} enabled agents' -f $enabledNames.Count) }

        Write-Host ''
        Write-Host '--- Runtime process records ---' -ForegroundColor Yellow
        $runtimeRaw = & node $cliPath status --instance $Instance --runtime-records-json 2>$null | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $runtimeRaw.Trim()) { throw 'runtime ownership diagnostic returned no usable data' }
        $runtimeDiagnostics = @(ConvertFrom-JsonItems $runtimeRaw)
        if ($runtimeDiagnostics.Count -eq 0) { Write-Host '  no runtime ownership records (valid when no marker-based runtimes are configured)' -ForegroundColor DarkGray }
        foreach ($duplicate in @($runtimeDiagnostics | Where-Object status -eq 'owned' | Group-Object agent | Where-Object Count -gt 1)) { Add-HealthFailure "agent '$($duplicate.Name)' has multiple owned runtime records" }
        foreach ($diagnostic in $runtimeDiagnostics) {
            if ($diagnostic.status -eq 'owned') { Write-HealthOk "$($diagnostic.agent) PID $($diagnostic.pid) has PID-reuse-safe daemon ownership" }
            else { Add-HealthFailure "$($diagnostic.agent) runtime record is $($diagnostic.status): $($diagnostic.detail)" }
        }

        Write-Host ''
        Write-Host '--- Telegram delivery health ---' -ForegroundColor Yellow
        $deliveryRaw = & node $cliPath status --instance $Instance --telegram-delivery-health-json 2>$null | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $deliveryRaw.Trim()) { throw 'Telegram delivery health returned no usable data' }
        $deliveryHealth = $deliveryRaw | ConvertFrom-Json
        if ($null -eq $deliveryHealth -or $deliveryHealth -isnot [psobject]) { throw 'Telegram delivery health is not an object' }
        $deliveryChecked = 0
        foreach ($property in @($deliveryHealth.PSObject.Properties)) {
            if ($null -eq $property.Value) { continue }
            $deliveryChecked++
            if ((Get-CiValue $property.Value 'healthy') -ne $true) {
                Add-HealthFailure ("Telegram delivery for '{0}' is unhealthy: pending={1} dead-letter={2} stale={3} corrupt={4}" -f $property.Name, (Get-CiValue $property.Value 'pending'), (Get-CiValue (Get-CiValue $property.Value 'counts') 'dead-letter'), (Get-CiValue $property.Value 'stale_delivering'), (Get-CiValue $property.Value 'corrupt_records'))
            }
        }
        if ($deliveryChecked -eq 0) { Write-Host '  no active Telegram delivery journals' -ForegroundColor DarkGray }
        elseif (@($deliveryHealth.PSObject.Properties | Where-Object { $null -ne $_.Value -and (Get-CiValue $_.Value 'healthy') -ne $true }).Count -eq 0) {
            Write-HealthOk "$deliveryChecked Telegram delivery journals are healthy"
        }
    } catch { Add-HealthFailure ('agent or runtime status unreadable: {0}' -f $_.Exception.Message) }
    finally { $env:CTX_FRAMEWORK_ROOT = $previousFrameworkRoot; $env:CTX_ROOT = $previousCtxRoot }
} else { Add-HealthFailure 'agent status unavailable because daemon is not alive' }
Write-Host ''
Write-Host '--- Log size bounds ---' -ForegroundColor Yellow
$maxLogBytes = [long]$MaxLogSizeMB * 1MB
$logFiles = @()
foreach ($dir in @($pm2LogDir, (Join-Path $ctxRoot 'logs'))) {
    if (-not (Test-Path $dir)) { continue }
    $found = @(Get-ChildItem -Path $dir -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue)
    if ($dir -eq $pm2LogDir) { $found = @($found | Where-Object Name -like 'cortextos-*.log') }
    $logFiles += $found
}
$oversized = @($logFiles | Where-Object Length -gt $maxLogBytes | Sort-Object Length -Descending)
if ($oversized.Count -eq 0) {
    Write-HealthOk "$($logFiles.Count) log files are within the ${MaxLogSizeMB}MB bound"
} else {
    foreach ($log in $oversized | Select-Object -First 10) {
        Add-HealthFailure ("log exceeds ${MaxLogSizeMB}MB: {0} ({1:N1}MB)" -f $log.FullName, ($log.Length / 1MB))
    }
    if ($oversized.Count -gt 10) { Add-HealthFailure "$($oversized.Count - 10) additional logs exceed the size bound" }
}
Write-Host ''

Write-Host '--- Daemon crash signals ---' -ForegroundColor Yellow
$daemonErrorLogs = @($logFiles | Where-Object { $_.Name -in @("$expectedDaemonName-error.log", 'cortextos-daemon-error.log') } | ForEach-Object FullName)
if ($daemonErrorLogs.Count -gt 0) {
    $attachAll = Get-LogMatchCount $daemonErrorLogs 'AttachConsole failed'
    $bug011All = Get-LogMatchCount $daemonErrorLogs 'BUG-011 REGRESSION CHECK'
    $benignAll = Get-LogMatchCount $daemonErrorLogs 'benign node-pty conpty cleanup race'
    Write-Host "  AttachConsole failures: $attachAll"
    Write-Host "  BUG-011 regression alarms: $bug011All"
    Write-Host "  benign recoveries: $benignAll"
    if ($bug011All -gt 0) { Write-Host '  [WARN] historical BUG-011 regression alarms are present' -ForegroundColor Yellow }
    if ($attachAll -gt 0 -and $benignAll -eq 0) { Write-Host '  [WARN] historical AttachConsole failures exist without recovery-filter evidence' -ForegroundColor Yellow }
} else {
    Write-Host '  no daemon error log found' -ForegroundColor DarkGray
}
Write-Host ''

$crashHistFile = Join-Path $ctxRoot 'state\.daemon-crash-history.json'
Write-Host '--- Daemon crash history (last 5) ---' -ForegroundColor Yellow
if (Test-Path $crashHistFile) {
    try {
        $hist = Get-Content $crashHistFile -Raw | ConvertFrom-Json
        $recent = @($hist.crashes) | Select-Object -Last 5
        foreach ($crash in $recent) {
            $oneLine = ([string]$crash.err -split "`n")[0]
            if ($oneLine.Length -gt 120) { $oneLine = $oneLine.Substring(0, 120) + '...' }
            Write-Host "  $($crash.ts)  $oneLine"
        }
        if ($recent.Count -eq 0) { Write-HealthOk 'no recorded crashes' }
    } catch {
        Add-HealthFailure "crash history is unreadable: $($_.Exception.Message)"
    }
} else {
    Write-HealthOk 'no crash history file'
}

Write-Host ''
if ($script:HealthFailures -gt 0) {
    Write-Host "===== UNHEALTHY ($script:HealthFailures failures) =====" -ForegroundColor Red
    exit 1
}
Write-Host '===== HEALTHY =====' -ForegroundColor Green
exit 0
