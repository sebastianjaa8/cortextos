# Native Windows PM2 startup for cortextOS. Registers a per-user scheduled
# task that runs `pm2 resurrect` at logon after validating live and saved state.

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$TaskName = 'PM2 Resurrect'
)

$ErrorActionPreference = 'Stop'
$requiredFilterPrefixes = @('GITHUB_', 'GH_', 'TOKEN', 'SECRET', 'API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'PASSWORD', 'CREDENTIAL')

function Get-CiValue {
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    if ($property) { return $property.Value }
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
const field = (entry, name) => ci(entry, name) ?? ci(ci(entry, 'pm2_env'), name) ?? ci(ci(ci(entry, 'pm2_env'), 'env'), name) ?? ci(ci(entry, 'env'), name);
const fields = ['name', 'status', 'CTX_INSTANCE_ID', 'CTX_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'PORT', 'pm_exec_path', 'pm_cwd', 'filter_env'];
const rows = (Array.isArray(input) ? input : []).map(entry => Object.fromEntries(fields.map(name => [name, field(entry, name)])));
process.stdout.write(JSON.stringify(rows));
"@
    $sanitized = $Json | & node -e $reducer
    if ($LASTEXITCODE -ne 0 -or -not $sanitized) { throw 'Node failed to reduce PM2 JSON to allowlisted fields' }
    $converted = $sanitized | ConvertFrom-Json
    foreach ($entry in @($converted)) { Write-Output $entry }
}

function ConvertTo-AppSummary {
    param([object]$Entry, [switch]$Saved)
    [pscustomobject]@{
        Name          = [string](Get-CiValue $Entry 'name')
        Status        = if ($Saved) { $null } else { [string](Get-CiValue $Entry 'status') }
        InstanceId    = [string](Get-CiValue $Entry 'CTX_INSTANCE_ID')
        CtxRoot       = [string](Get-CiValue $Entry 'CTX_ROOT')
        FrameworkRoot = [string](Get-CiValue $Entry 'CTX_FRAMEWORK_ROOT')
        ProjectRoot   = [string](Get-CiValue $Entry 'CTX_PROJECT_ROOT')
        Port          = [string](Get-CiValue $Entry 'PORT')
        ScriptPath    = [string](Get-CiValue $Entry 'pm_exec_path')
        Cwd           = [string](Get-CiValue $Entry 'pm_cwd')
        FilterEnv     = @((Get-CiValue $Entry 'filter_env'))
    }
}

function Test-SamePath {
    param([string]$Left, [string]$Right)
    if (-not $Left -or -not $Right) { return $false }
    try { return [IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Right).TrimEnd('\') } catch { return $false }
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

function Assert-CanonicalApp {
    param([object]$App, [switch]$Saved)
    if ($App.Name -notmatch '^cortextos-(daemon|dashboard)-([a-z0-9_-]+)$') {
        throw "Non-canonical cortextOS PM2 app name '$($App.Name)'"
    }
    $kind = $Matches[1]
    $instance = $Matches[2]
    if ($App.InstanceId -ne $instance) { throw "$($App.Name) has non-canonical CTX_INSTANCE_ID" }
    if (-not $Saved -and $App.Status -ne 'online') { throw "$($App.Name) is $($App.Status), not online" }
    $expectedRoot = Join-Path $env:USERPROFILE ".cortextos\$instance"
    if (-not (Test-SamePath $App.CtxRoot $expectedRoot)) { throw "$($App.Name) has non-canonical CTX_ROOT" }
    if (-not $App.FrameworkRoot -or -not (Test-SamePath $App.ProjectRoot $App.FrameworkRoot)) { throw "$($App.Name) has divergent framework/project roots" }
    if ($kind -eq 'daemon') {
        if (-not (Test-SamePath $App.ScriptPath (Join-Path $App.FrameworkRoot 'dist\daemon.js'))) { throw "$($App.Name) has non-canonical script" }
        if (-not (Test-SamePath $App.Cwd $App.FrameworkRoot)) { throw "$($App.Name) has non-canonical cwd" }
    } else {
        if (-not (Test-SamePath $App.Cwd (Join-Path $App.FrameworkRoot 'dashboard'))) { throw "$($App.Name) has non-canonical cwd" }
        if (-not (Test-SamePath $App.ScriptPath (Join-Path $App.FrameworkRoot 'dashboard\node_modules\next\dist\bin\next'))) { throw "$($App.Name) has non-canonical script" }
        $expectedPort = [string](Get-DashboardPortForInstance $instance)
        if ($App.Port -ne $expectedPort) { throw "$($App.Name) uses PORT $($App.Port), expected $expectedPort" }
    }
    foreach ($prefix in $requiredFilterPrefixes) {
        if ($prefix -notin @($App.FilterEnv)) { throw "$($App.Name) is missing required filter_env prefix '$prefix'" }
    }
}

function Assert-SafeManifestEntry {
    param([object]$App, [switch]$Saved)
    if ($App.Name -match '^cortextos-(daemon|dashboard)-') {
        Assert-CanonicalApp $App -Saved:$Saved
        return
    }
    if ($App.Name -ne 'pm2-logrotate') { throw "Unapproved PM2 app '$($App.Name)' exists in live or saved state" }
    if (-not $Saved -and $App.Status -ne 'online') { throw "pm2-logrotate is $($App.Status), not online" }
    $moduleRoot = Join-Path $env:USERPROFILE '.pm2\modules\pm2-logrotate\node_modules\pm2-logrotate'
    if (-not (Test-SamePath $App.Cwd $moduleRoot)) { throw 'pm2-logrotate has non-canonical cwd' }
    if (-not (Test-SamePath $App.ScriptPath (Join-Path $moduleRoot 'app.js'))) { throw 'pm2-logrotate has non-canonical script' }
}
if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[ok] Removed scheduled task: $TaskName"
    } else { Write-Host "[skip] No scheduled task named '$TaskName' is registered." }
    return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe not found on PATH. Install Node.js 20+ before running this script.' }
$pm2BinCandidates = @(
    (Join-Path $env:APPDATA 'npm\node_modules\pm2\bin\pm2'),
    (Join-Path (Split-Path $node -Parent) 'node_modules\pm2\bin\pm2')
)
$pm2Bin = $pm2BinCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pm2Bin) { throw 'Could not locate PM2. Install with: npm install -g pm2' }

$dumpFile = Join-Path $env:USERPROFILE '.pm2\dump.pm2'
if (-not (Test-Path $dumpFile)) { throw "PM2 dump file not found at $dumpFile. Run cortextos start --instance <id> before installing startup." }
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) { throw 'pm2 command not found on PATH.' }
$liveRaw = & pm2 jlist 2>$null | Out-String
if ($LASTEXITCODE -ne 0 -or -not $liveRaw.Trim()) { throw 'pm2 jlist failed; refusing to register an unverified startup task.' }
try {
    $live = @(ConvertFrom-Pm2JsonAllowlist $liveRaw | ForEach-Object { ConvertTo-AppSummary $_ })
    $saved = @(ConvertFrom-Pm2JsonAllowlist (Get-Content $dumpFile -Raw) | ForEach-Object { ConvertTo-AppSummary $_ -Saved })
} catch { throw "Could not parse the live or saved PM2 manifest: $($_.Exception.Message)" }

$duplicateLive = @($live | Group-Object { $_.Name.ToLowerInvariant() } | Where-Object Count -gt 1)
$duplicateSaved = @($saved | Group-Object { $_.Name.ToLowerInvariant() } | Where-Object Count -gt 1)
if ($duplicateLive.Count -gt 0 -or $duplicateSaved.Count -gt 0) { throw 'Duplicate PM2 app names exist in live or saved state.' }
foreach ($app in $live) { Assert-SafeManifestEntry $app }
foreach ($app in $saved) { Assert-SafeManifestEntry $app -Saved }
if (@($live | Where-Object { $_.Name -match '^cortextos-daemon-' }).Count -eq 0) { throw 'No canonical online daemon is live. Run cortextos start --instance <id> first.' }

$liveNames = @($live | ForEach-Object Name | Sort-Object)
$savedNames = @($saved | ForEach-Object Name | Sort-Object)
$manifestDiff = @(Compare-Object -ReferenceObject $liveNames -DifferenceObject $savedNames)
if ($manifestDiff.Count -gt 0) { throw 'Live and saved complete PM2 manifests differ. Rerun cortextos start for each instance.' }
foreach ($liveApp in $live) {
    $savedApp = @($saved | Where-Object Name -eq $liveApp.Name)
    if ($savedApp.Count -ne 1) { throw "Saved manifest does not contain exactly one $($liveApp.Name)" }
    foreach ($field in @('InstanceId', 'CtxRoot', 'FrameworkRoot', 'ProjectRoot', 'ScriptPath', 'Cwd', 'Port')) {
        if ($field -in @('CtxRoot', 'FrameworkRoot', 'ProjectRoot', 'ScriptPath', 'Cwd')) {
            if (-not (Test-SamePath $liveApp.$field $savedApp[0].$field)) { throw "$($liveApp.Name) saved/live $field mismatch" }
        } elseif ($liveApp.$field -ne $savedApp[0].$field) { throw "$($liveApp.Name) saved/live $field mismatch" }
    }
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$pm2Bin`" resurrect"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 72) -MultipleInstances IgnoreNew -Hidden
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'cortextOS: resurrect the verified PM2 manifest at user logon.' | Out-Null

Write-Host ''
Write-Host "[ok] Registered scheduled task: $TaskName"
Write-Host '      Verified: complete live/saved PM2 parity with only canonical cortextOS apps and pm2-logrotate'
Write-Host "      Trigger:  At logon ($env:USERDOMAIN\$env:USERNAME)"
Write-Host "      Action:   $node `"$pm2Bin`" resurrect"
Write-Host ''
Write-Host "Verify with: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Test now:    Start-ScheduledTask -TaskName '$TaskName'"
