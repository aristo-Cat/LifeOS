# LifeOS statusline - Windows wrapper.
#
# Uses the full Bash statusline when Git for Windows provides bash.exe.
# Falls back to a compact native PowerShell statusline if bash is unavailable.

[CmdletBinding()]
param()

$ErrorActionPreference = "SilentlyContinue"

$HomeDir = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath("UserProfile") }
if (-not $env:HOME) { $env:HOME = $HomeDir }

$LifeOSDir = if ($env:LIFEOS_DIR) {
  $env:LIFEOS_DIR
} elseif ($PSScriptRoot) {
  $PSScriptRoot
} else {
  Join-Path $HomeDir ".claude\LIFEOS"
}

$ConfigRoot = Split-Path -Parent $LifeOSDir
$BashStatusline = Join-Path $LifeOSDir "LIFEOS_StatusLine.sh"
$Bash = Get-Command bash.exe -ErrorAction SilentlyContinue

if ($Bash -and (Test-Path -LiteralPath $BashStatusline)) {
  & $Bash.Source $BashStatusline
  exit $LASTEXITCODE
}

$VersionPath = Join-Path $LifeOSDir "VERSION"
$AlgoPath = Join-Path $LifeOSDir "ALGORITHM\LATEST"
$SettingsPath = Join-Path $ConfigRoot "settings.json"

$LifeOSVersion = "unknown"
if (Test-Path -LiteralPath $VersionPath) {
  $LifeOSVersion = (Get-Content -LiteralPath $VersionPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $LifeOSVersion) { $LifeOSVersion = "unknown" }
}

$Algo = "unknown"
if (Test-Path -LiteralPath $AlgoPath) {
  $Algo = (Get-Content -LiteralPath $AlgoPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $Algo) { $Algo = "unknown" }
}

$DaName = "Assistant"
if (Test-Path -LiteralPath $SettingsPath) {
  try {
    $Settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
    if ($Settings.daidentity.name) { $DaName = $Settings.daidentity.name }
    elseif ($Settings.daidentity.displayName) { $DaName = $Settings.daidentity.displayName }
  } catch {}
}

$Branch = ""
try {
  $Branch = git branch --show-current 2>$null
} catch {}

$CwdName = Split-Path -Leaf (Get-Location)
$Parts = @("LifeOS", "v:$LifeOSVersion", "ALG:$Algo", "DA:$DaName")
if ($Branch) { $Parts += "git:$Branch" }
if ($CwdName) { $Parts += $CwdName }

Write-Output ($Parts -join " | ")
