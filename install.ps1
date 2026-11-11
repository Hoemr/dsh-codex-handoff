#Requires -Version 5.1
<#
  dsh-codex-handoff — Windows installer (upstream ships a macOS-only install.sh).

  What it does:
    1. Copies this package to %LOCALAPPDATA%\dsh-codex-handoff (source stays untouched).
    2. Writes dsh-bridge launchers into %APPDATA%\npm (already on PATH with npm).
    3. Installs the Codex-side skill into ~\.codex\skills\dsh-bridge.
    4. Registers the DSH plugin against one profile (dsh plugin add).
    5. Runs "dsh-bridge doctor".

  Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Profile web] [-SkipPlugin] [-SkipSkill]
#>
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'dsh-codex-handoff'),
  [switch]$SkipPlugin,
  [switch]$SkipSkill
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot

function Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "!!  $Message" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. payload
if ((Resolve-Path -LiteralPath $source).Path.TrimEnd('\') -ne $InstallDir.TrimEnd('\')) {
  Step "安装文件 -> $InstallDir"
  if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $skip = @('.git', 'node_modules')
  Get-ChildItem -LiteralPath $source -Force |
    Where-Object { $skip -notcontains $_.Name } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $InstallDir -Recurse -Force }
}

$entry = Join-Path $InstallDir 'bin\bridge.mjs'
if (-not (Test-Path -LiteralPath $entry)) { Fail "缺少 $entry" }

# ---------------------------------------------------------------- 2. launchers
$npmBin = Join-Path $env:APPDATA 'npm'
if (-not (Test-Path -LiteralPath $npmBin)) { New-Item -ItemType Directory -Path $npmBin -Force | Out-Null }
Step "启动器 -> $npmBin"
$cmdShim = @("@echo off", "node ""$entry"" %*")
foreach ($shimName in @('dsh-bridge.cmd', 'dsh-codex-handoff.cmd')) {
  Set-Content -LiteralPath (Join-Path $npmBin $shimName) -Value $cmdShim -Encoding ascii
}
$posixEntry = $entry -replace '\\', '/'
$shShim = @('#!/bin/sh', ('exec node "' + $posixEntry + '" "$@"'))
Set-Content -LiteralPath (Join-Path $npmBin 'dsh-bridge') -Value $shShim -Encoding ascii
$onPath = @($env:PATH -split ';' | Where-Object { $_.TrimEnd('\') -eq $npmBin.TrimEnd('\') }).Count -gt 0
if (-not $onPath) { Write-Host "   note: $npmBin is not on PATH" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 3. skill
if (-not $SkipSkill) {
  $skillSrc = Join-Path $InstallDir 'skills\dsh-bridge\SKILL.md'
  $skillDst = Join-Path $env:USERPROFILE '.codex\skills\dsh-bridge'
  if (Test-Path -LiteralPath $skillSrc) {
    Step "Codex skill -> $skillDst"
    New-Item -ItemType Directory -Path $skillDst -Force | Out-Null
    Copy-Item -LiteralPath $skillSrc -Destination (Join-Path $skillDst 'SKILL.md') -Force
  } else {
    Write-Host "   skip: $skillSrc not found" -ForegroundColor Yellow
  }
}

# ---------------------------------------------------------------- 4. plugin
if (-not $SkipPlugin) {
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if (-not $dsh) { Fail 'dsh is not on PATH; register the plugin manually or pass -SkipPlugin' }
  Step "registering DSH plugin on profile '$Profile'"
  & $dsh.Source plugin --profile $Profile add $InstallDir
  if ($LASTEXITCODE -ne 0) { Fail "dsh plugin add failed (exit $LASTEXITCODE)" }
}

# ---------------------------------------------------------------- 5. doctor
Step 'doctor'
& node $entry doctor
exit $LASTEXITCODE