param(
  [string]$OutputDir = "",
  [string]$ZipPath = "",
  [string]$NodePath = "",
  [switch]$FrameworkDependent
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot 'dist\windows\Codex Max Portable'
}
if (-not $ZipPath) {
  $ZipPath = Join-Path $repoRoot 'dist\windows\Codex-Max-Windows-Portable.zip'
}

if (Test-Path -LiteralPath $OutputDir) {
  Remove-Item -LiteralPath $OutputDir -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}

$buildArgs = @{
  OutputDir = $OutputDir
  NodePath = $NodePath
}
if ($FrameworkDependent) {
  & (Join-Path $repoRoot 'scripts\build-codex-max-windows.ps1') @buildArgs
} else {
  & (Join-Path $repoRoot 'scripts\build-codex-max-windows.ps1') @buildArgs -SelfContained
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ZipPath) | Out-Null
Compress-Archive -Path (Join-Path $OutputDir '*') -DestinationPath $ZipPath -Force
Write-Host "Windows portable directory: $OutputDir"
Write-Host "Windows portable zip: $ZipPath"
