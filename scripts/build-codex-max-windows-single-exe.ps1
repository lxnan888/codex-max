param(
  [string]$OutputDir = "",
  [string]$NodePath = ""
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot 'dist\windows\Codex Max SingleExe'
}

function Get-DotnetCli {
  $candidates = @()
  $cmd = Get-Command dotnet.exe -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $userDotnet = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
  if (Test-Path -LiteralPath $userDotnet) { $candidates += $userDotnet }
  $machineDotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
  if (Test-Path -LiteralPath $machineDotnet) { $candidates += $machineDotnet }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    $sdks = & $candidate --list-sdks 2>$null
    if ($sdks) { return $candidate }
  }
  return ''
}

$dotnet = Get-DotnetCli
if (-not $dotnet) {
  throw 'The .NET 8 SDK is required to build the Windows app. Install it from https://dotnet.microsoft.com/download'
}

if (-not $NodePath) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
}

if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) {
  throw 'Node.js is required so node.exe can be bundled into the launcher payload.'
}

if (Test-Path -LiteralPath $OutputDir) {
  Remove-Item -LiteralPath $OutputDir -Recurse -Force
}

$payloadZip = Join-Path $repoRoot 'windows\CodexMini\CodexMaxPayload.zip'
if (Test-Path -LiteralPath $payloadZip) {
  Remove-Item -LiteralPath $payloadZip -Force
}

$payloadTemp = Join-Path $env:TEMP "codex-max-payload-$PID"
if (Test-Path -LiteralPath $payloadTemp) {
  Remove-Item -LiteralPath $payloadTemp -Recurse -Force
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $payloadTemp 'service') | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot 'server.js') -Destination (Join-Path $payloadTemp 'service\server.js') -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination (Join-Path $payloadTemp 'service\package.json') -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'src') -Destination (Join-Path $payloadTemp 'service') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'public') -Destination (Join-Path $payloadTemp 'service') -Recurse -Force

  New-Item -ItemType Directory -Force -Path (Join-Path $payloadTemp 'node') | Out-Null
  Copy-Item -LiteralPath $NodePath -Destination (Join-Path $payloadTemp 'node\node.exe') -Force

  Compress-Archive -Path (Join-Path $payloadTemp '*') -DestinationPath $payloadZip -Force
} finally {
  if (Test-Path -LiteralPath $payloadTemp) {
    Remove-Item -LiteralPath $payloadTemp -Recurse -Force
  }
}

$project = Join-Path $repoRoot 'windows\CodexMini\CodexMiniWin.csproj'
$publishArgs = @(
  'publish',
  $project,
  '-c',
  'Release',
  '-r',
  'win-x64',
  '--self-contained',
  'true',
  '-o',
  $OutputDir,
  '/p:PublishSingleFile=true',
  '/p:IncludeNativeLibrariesForSelfExtract=true',
  '/p:EnableCompressionInSingleFile=true'
)

& $dotnet @publishArgs
if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

Get-ChildItem -LiteralPath $OutputDir -Force | Where-Object { $_.Name -ne 'Codex Max.exe' } | Remove-Item -Recurse -Force
Write-Host "Windows single exe: $(Join-Path $OutputDir 'Codex Max.exe')"
