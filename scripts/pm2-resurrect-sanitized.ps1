[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NodePath,
    [Parameter(Mandatory = $true)]
    [string]$Pm2Path
)

$ErrorActionPreference = 'Stop'
$blockedPrefixes = @(
    'GITHUB_', 'GH_', 'TOKEN', 'SECRET', 'API_KEY', 'ACCESS_KEY',
    'PRIVATE_KEY', 'PASSWORD', 'CREDENTIAL'
)

foreach ($entry in Get-ChildItem Env:) {
    foreach ($prefix in $blockedPrefixes) {
        if ($entry.Name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath Env:$($entry.Name) -ErrorAction SilentlyContinue
            break
        }
    }
}

& $NodePath $Pm2Path resurrect
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
