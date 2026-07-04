# LifeOS Pulse - Windows process management.
# Usage: .\manage.ps1 start|stop|restart|status|install|uninstall

[CmdletBinding()]
param(
  [ValidateSet("start", "stop", "restart", "status", "install", "uninstall")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"

$HomeDir = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath("UserProfile") }
if (-not $env:HOME) { $env:HOME = $HomeDir }

$PulseDir = if ($env:LIFEOS_PULSE_DIR) {
  $env:LIFEOS_PULSE_DIR
} elseif ($PSScriptRoot) {
  $PSScriptRoot
} else {
  Join-Path $HomeDir ".claude\LIFEOS\PULSE"
}

$StateDir = Join-Path $PulseDir "state"
$LogsDir = Join-Path $PulseDir "logs"
$PidFile = Join-Path $StateDir "pulse.pid"
$PulseScript = Join-Path $PulseDir "pulse.ts"
$LifeOSDir = Split-Path -Parent $PulseDir
$InstallRoot = Split-Path -Parent $LifeOSDir
$TaskName = "LifeOS Pulse"
$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$StartupShim = Join-Path $StartupDir "LifeOS Pulse.vbs"

$env:LIFEOS_PULSE_DIR = $PulseDir
$env:LIFEOS_DIR = $LifeOSDir
$env:LIFEOS_INSTALL_ROOT = $InstallRoot

function Ensure-Dirs {
  New-Item -ItemType Directory -Force -Path $StateDir, $LogsDir | Out-Null
}

function Normalize-PathEnvironment {
  $PathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
  if (-not $PathValue) {
    $PathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  }

  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  if ($PathValue) {
    [Environment]::SetEnvironmentVariable("Path", $PathValue, "Process")
  }
}

function Get-BunPath {
  $Command = Get-Command bun -ErrorAction SilentlyContinue
  if ($Command) { return $Command.Source }

  $Candidate = Join-Path $HomeDir ".bun\bin\bun.exe"
  if (Test-Path -LiteralPath $Candidate) { return $Candidate }

  throw "bun.exe not found. Install Bun with: powershell -c `"irm bun.sh/install.ps1 | iex`""
}

function Ensure-Dependencies {
  $PackageJson = Join-Path $PulseDir "package.json"
  $NodeModules = Join-Path $PulseDir "node_modules"

  if ((Test-Path -LiteralPath $PackageJson) -and -not (Test-Path -LiteralPath $NodeModules)) {
    $Bun = Get-BunPath
    Write-Host "Installing LifeOS Pulse dependencies..."
    Push-Location $PulseDir
    try {
      & $Bun install
      if ($LASTEXITCODE -ne 0) {
        throw "bun install exited with code $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }
  }
}

function Test-Pulse {
  $Client = $null
  try {
    $Client = New-Object System.Net.Sockets.TcpClient
    $Connect = $Client.BeginConnect("127.0.0.1", 31337, $null, $null)
    if (-not $Connect.AsyncWaitHandle.WaitOne(1000, $false)) {
      return $false
    }
    $Client.EndConnect($Connect)
    return $Client.Connected
  } catch {
    return $false
  } finally {
    if ($Client) { $Client.Close() }
  }
}

function Stop-PulseProcess {
  if (Test-Path -LiteralPath $PidFile) {
    $PidText = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($PidText -match '^\d+$') {
      $Proc = Get-Process -Id ([int]$PidText) -ErrorAction SilentlyContinue
      if ($Proc) {
        Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Start-PulseProcess {
  Ensure-Dirs
  Ensure-Dependencies
  Normalize-PathEnvironment

  if (-not (Test-Path -LiteralPath $PulseScript)) {
    throw "pulse.ts not found at $PulseScript"
  }
  if (Test-Pulse) {
    Write-Host "LifeOS Pulse already running on port 31337"
    return
  }

  $Bun = Get-BunPath
  $Stdout = Join-Path $LogsDir "pulse-stdout.log"
  $Stderr = Join-Path $LogsDir "pulse-stderr.log"

  $Process = Start-Process `
    -FilePath $Bun `
    -ArgumentList @("run", $PulseScript) `
    -WorkingDirectory $PulseDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $Stdout `
    -RedirectStandardError $Stderr `
    -PassThru

  Set-Content -LiteralPath $PidFile -Value $Process.Id
  Write-Host "LifeOS Pulse starting (PID $($Process.Id))"
}

function Wait-ForPulse {
  param([int]$Seconds = 10)
  for ($i = 0; $i -lt ($Seconds * 2); $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Pulse) { return $true }
  }
  return $false
}

function Install-StartupFallback {
  if (-not $StartupDir) {
    throw "Windows Startup folder could not be resolved."
  }

  New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
  $ManagePath = Join-Path $PulseDir "manage.ps1"
  $EscapedManagePath = $ManagePath.Replace('"', '""')
  $Content = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$EscapedManagePath"" start", 0, False
"@
  Set-Content -LiteralPath $StartupShim -Value $Content -Encoding ASCII
  Write-Host "LifeOS Pulse auto-start fallback installed in Startup folder."
}

function Install-PulseTask {
  Ensure-Dirs
  Ensure-Dependencies
  $Bun = Get-BunPath

  Stop-PulseProcess

  $AutoStart = "Windows Scheduled Task"
  $Action = New-ScheduledTaskAction `
    -Execute $Bun `
    -Argument "run `"$PulseScript`"" `
    -WorkingDirectory $PulseDir
  $Trigger = New-ScheduledTaskTrigger -AtLogOn
  $Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

  try {
    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $Action `
      -Trigger $Trigger `
      -Settings $Settings `
      -Description "Starts the LifeOS Pulse daemon at Windows sign-in." `
      -Force | Out-Null
  } catch {
    Write-Warning "Could not register scheduled task '$TaskName': $($_.Exception.Message)"
    Write-Warning "Falling back to the current user's Windows Startup folder."
    Install-StartupFallback
    $AutoStart = "Windows Startup folder"
  }

  Start-PulseProcess
  if (Wait-ForPulse -Seconds 10) {
    Write-Host "LifeOS Pulse installed via $AutoStart and verified on port 31337"
  } else {
    Write-Error "LifeOS Pulse was installed, but port 31337 did not bind within 10s. Check $LogsDir\pulse-stderr.log"
    exit 1
  }
}

switch ($Action) {
  "start" {
    Start-PulseProcess
    if (-not (Wait-ForPulse -Seconds 10)) {
      Write-Error "LifeOS Pulse did not bind port 31337. Check $LogsDir\pulse-stderr.log"
      exit 1
    }
  }
  "stop" {
    Stop-PulseProcess
    Write-Host "LifeOS Pulse stopped"
  }
  "restart" {
    Stop-PulseProcess
    Start-Sleep -Seconds 2
    Start-PulseProcess
    if (-not (Wait-ForPulse -Seconds 10)) {
      Write-Error "LifeOS Pulse did not bind port 31337. Check $LogsDir\pulse-stderr.log"
      exit 1
    }
  }
  "status" {
    if (Test-Pulse) {
      Write-Host "LifeOS Pulse: RUNNING on port 31337"
    } else {
      Write-Host "LifeOS Pulse: NOT RUNNING"
    }
  }
  "install" {
    Install-PulseTask
  }
  "uninstall" {
    Stop-PulseProcess
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $StartupShim -Force -ErrorAction SilentlyContinue
    Write-Host "LifeOS Pulse uninstalled"
  }
}
