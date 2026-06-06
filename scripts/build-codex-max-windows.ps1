param(
  [string]$OutputDir = "",
  [string]$NodePath = "",
  [switch]$SelfContained,
  [switch]$SingleExe
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot 'dist\windows\Codex Max'
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

$sdkList = & $dotnet --list-sdks 2>$null
if (-not $sdkList) {
  throw 'The .NET 8 SDK is required to build the Windows app. Install it from https://dotnet.microsoft.com/download'
}

$payloadZip = Join-Path $repoRoot 'windows\CodexMini\CodexMaxPayload.zip'
if (Test-Path -LiteralPath $payloadZip) {
  Remove-Item -LiteralPath $payloadZip -Force
}

if (-not $NodePath) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
}

$payloadTemp = Join-Path $env:TEMP "codex-max-payload-$PID"
if (Test-Path -LiteralPath $payloadTemp) {
  Remove-Item -LiteralPath $payloadTemp -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $payloadTemp 'service') | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'server.js') -Destination (Join-Path $payloadTemp 'service\server.js') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination (Join-Path $payloadTemp 'service\package.json') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'src') -Destination (Join-Path $payloadTemp 'service') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'public') -Destination (Join-Path $payloadTemp 'service') -Recurse -Force
if ($NodePath -and (Test-Path -LiteralPath $NodePath)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $payloadTemp 'node') | Out-Null
  Copy-Item -LiteralPath $NodePath -Destination (Join-Path $payloadTemp 'node\node.exe') -Force
}
Compress-Archive -Path (Join-Path $payloadTemp '*') -DestinationPath $payloadZip -Force
Remove-Item -LiteralPath $payloadTemp -Recurse -Force

$project = Join-Path $repoRoot 'windows\CodexMini\CodexMiniWin.csproj'
$publishArgs = @('publish', $project, '-c', 'Release', '-r', 'win-x64', '--self-contained', $(if ($SelfContained -or $SingleExe) { 'true' } else { 'false' }), '-o', $OutputDir)
if ($SingleExe) {
  $publishArgs += @('/p:PublishSingleFile=true', '/p:IncludeNativeLibrariesForSelfExtract=true', '/p:EnableCompressionInSingleFile=true')
}
& $dotnet @publishArgs
if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

if ((-not $SingleExe) -and $NodePath -and (Test-Path -LiteralPath $NodePath)) {
  $nodeDir = Join-Path $OutputDir 'Resources\node'
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  $targetNode = Join-Path $nodeDir 'node.exe'
  try {
    Copy-Item -LiteralPath $NodePath -Destination $targetNode -Force
  } catch {
    if (Test-Path -LiteralPath $targetNode) {
      Write-Warning "Could not update bundled node.exe because it is in use; keeping existing runtime: $targetNode"
    } else {
      throw
    }
  }
}

if ($SingleExe) {
  Get-ChildItem -LiteralPath $OutputDir -Force | Where-Object { $_.Name -ne 'Codex Max.exe' } | Remove-Item -Recurse -Force
}

Write-Host "Windows app output: $OutputDir"
