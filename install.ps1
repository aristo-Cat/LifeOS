# LifeOS Windows installer shortcut.
#
# Local update from this repository:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Target codex
#
# Install both Claude Code and Codex skill roots:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Target both

[CmdletBinding()]
param(
  [ValidateSet("claude", "codex", "both")]
  [string]$Target = "claude",

  [string]$Version = "6.0.3",
  [string]$Repo = "aristo-Cat/LifeOS",
  [string]$ArchiveUrl = "",
  [string]$Source = "",
  [string]$SkillsDir = "",

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$HomeDir = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath("UserProfile") }
if (-not $env:HOME) { $env:HOME = $HomeDir }

$BlockStart = "<!-- LIFEOS-CODEX-COMPAT:START -->"
$BlockEnd = "<!-- LIFEOS-CODEX-COMPAT:END -->"

function Test-LifeOSSkill {
  param([string]$Path)
  return (
    $Path -and
    (Test-Path -LiteralPath (Join-Path $Path "SKILL.md")) -and
    (Test-Path -LiteralPath (Join-Path $Path "Tools\DetectEnv.ts"))
  )
}

function Resolve-LocalSkillSource {
  $Candidates = @()
  if ($Source) { $Candidates += $Source }
  if ($env:LIFEOS_SRC) { $Candidates += $env:LIFEOS_SRC }
  $Candidates += (Join-Path $PSScriptRoot "LifeOS")
  $Candidates += (Split-Path -Parent $PSScriptRoot)

  foreach ($Candidate in $Candidates) {
    if (Test-LifeOSSkill -Path $Candidate) {
      return (Resolve-Path -LiteralPath $Candidate).Path
    }
  }
  return ""
}

function Get-ArchiveSkillSource {
  $Tag = "v$Version"
  $Url = if ($ArchiveUrl) { $ArchiveUrl } else { "https://github.com/$Repo/archive/refs/tags/$Tag.zip" }
  $Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lifeos-install-" + [System.Guid]::NewGuid().ToString("N"))
  $Zip = Join-Path $Tmp "lifeos.zip"
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

  Write-Host "Downloading LifeOS $Tag from $Repo..."
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Zip
  Expand-Archive -LiteralPath $Zip -DestinationPath $Tmp -Force

  $Extracted = Get-ChildItem -LiteralPath $Tmp -Directory | Select-Object -First 1
  if (-not $Extracted) { throw "Archive did not contain a release directory." }

  $Skill = Join-Path $Extracted.FullName "LifeOS"
  if (-not (Test-LifeOSSkill -Path $Skill)) {
    throw "LifeOS skill not found in archive at $Skill"
  }
  return $Skill
}

function Get-InstallTargets {
  if ($SkillsDir) {
    return @(@{ Name = "custom"; Root = (Split-Path -Parent $SkillsDir); Skills = $SkillsDir })
  }

  $ClaudeRoot = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HomeDir ".claude" }
  $CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HomeDir ".codex" }
  $Targets = @()

  if ($Target -eq "claude" -or $Target -eq "both") {
    $Targets += @{ Name = "claude"; Root = $ClaudeRoot; Skills = (Join-Path $ClaudeRoot "skills") }
  }
  if ($Target -eq "codex" -or $Target -eq "both") {
    $Targets += @{ Name = "codex"; Root = $CodexRoot; Skills = (Join-Path $CodexRoot "skills") }
  }
  return $Targets
}

function Copy-LifeOSSkill {
  param(
    [string]$SkillSource,
    [hashtable]$InstallTarget
  )

  $TargetSkill = Join-Path $InstallTarget.Skills "LifeOS"
  $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Write-Host "Installing LifeOS into $($InstallTarget.Name): $TargetSkill"

  if ($DryRun) {
    if (Test-Path -LiteralPath $TargetSkill) {
      Write-Host "  [dry-run] would back up existing LifeOS skill to LifeOS.backup-$Stamp"
    }
    Write-Host "  [dry-run] would copy $SkillSource to $TargetSkill"
    return
  }

  New-Item -ItemType Directory -Force -Path $InstallTarget.Skills | Out-Null
  if (Test-Path -LiteralPath $TargetSkill) {
    $Backup = Join-Path $InstallTarget.Skills "LifeOS.backup-$Stamp"
    Move-Item -LiteralPath $TargetSkill -Destination $Backup
    Write-Host "  Backed up previous LifeOS skill to $Backup"
  }

  Copy-Item -LiteralPath $SkillSource -Destination $TargetSkill -Recurse
  Write-Host "  Installed."
}

function Update-CodexAgentsFile {
  param([string]$CodexRoot)

  $AgentsPath = Join-Path $CodexRoot "AGENTS.md"
  $LifeOSRoot = (Join-Path $CodexRoot "LIFEOS").Replace("\", "/")
  $CodexRootForText = $CodexRoot.Replace("\", "/")
  $Block = @"
$BlockStart
# LifeOS for Codex

## Runtime Contract

- This Codex install lives in $CodexRootForText.
- Treat $LifeOSRoot/LIFEOS_SYSTEM_PROMPT.md as LifeOS doctrine for non-trivial work. Codex does not use Claude Code's append-system-prompt-file flag, so this AGENTS block is the Codex bridge.
- Durable user context lives in $LifeOSRoot/USER/; memory and work state live in $LifeOSRoot/MEMORY/.
- Use Codex-native skills from $CodexRootForText/skills and global skills from ~/.agents/skills.
- Claude Code hooks do not auto-wire in Codex. Prefer Codex-native surfaces (AGENTS.md, config.toml, hooks.json, and skills) for Codex-only behavior.

## Compatibility Boundaries

- Do not remove or rewrite ~/.claude when working in Codex compatibility mode.
- If a LifeOS instruction mentions Claude-only mechanisms, translate the intent to the closest Codex mechanism instead of assuming the mechanism exists.
$BlockEnd
"@

  if ($DryRun) {
    Write-Host "  [dry-run] would update $AgentsPath"
    return
  }

  New-Item -ItemType Directory -Force -Path $CodexRoot | Out-Null
  $Current = if (Test-Path -LiteralPath $AgentsPath) { Get-Content -LiteralPath $AgentsPath -Raw } else { "" }
  $Pattern = [regex]::Escape($BlockStart) + "[\s\S]*?" + [regex]::Escape($BlockEnd)
  if ($Current -match $Pattern) {
    $Next = [regex]::Replace($Current, $Pattern, $Block)
  } else {
    $Next = ($Current.TrimEnd() + "`n`n" + $Block + "`n").TrimStart()
  }
  Set-Content -LiteralPath $AgentsPath -Value $Next -Encoding UTF8
  Write-Host "  Updated Codex AGENTS.md bridge."
}

$SkillSource = Resolve-LocalSkillSource
if (-not $SkillSource) {
  $SkillSource = Get-ArchiveSkillSource
}

Write-Host "LifeOS source: $SkillSource"
$InstallTargets = Get-InstallTargets
foreach ($InstallTarget in $InstallTargets) {
  Copy-LifeOSSkill -SkillSource $SkillSource -InstallTarget $InstallTarget
  if ($InstallTarget.Name -eq "codex") {
    Update-CodexAgentsFile -CodexRoot $InstallTarget.Root
  }
}

Write-Host ""
Write-Host "LifeOS skill installed."
Write-Host "Next: open your harness and run the LifeOS setup workflow:"
Write-Host "  /lifeos-setup"
Write-Host ""
Write-Host "For an installed local update, run the setup/update workflow from the new LifeOS skill and keep the dry-run reports before applying changes."
