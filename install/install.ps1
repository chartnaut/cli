# Chartnaut CLI installer for Windows.
#
#   irm https://chartnaut.com/install.ps1 | iex
#
# Options (environment variables):
#   CHARTNAUT_VERSION        install this version instead of the latest (e.g. 0.1.0)
#   CHARTNAUT_INSTALL        install directory root (default: %LOCALAPPDATA%\Chartnaut); the binary goes in <root>\bin
#   CHARTNAUT_NO_MODIFY_PATH=1   do not add the bin directory to your user PATH
#   CHARTNAUT_DOWNLOAD_URL   where latest.json lives (default: https://desktop-updates.chartnaut.com/cli)
#
# Reads the manifest (latest.json), downloads the Windows build, checks its SHA-256, and installs a
# single self-contained chartnaut.exe. Node is not needed. No administrator rights needed.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

$base = if ($env:CHARTNAUT_DOWNLOAD_URL) { $env:CHARTNAUT_DOWNLOAD_URL.TrimEnd('/') } else { 'https://desktop-updates.chartnaut.com/cli' }
$root = if ($env:CHARTNAUT_INSTALL) { $env:CHARTNAUT_INSTALL } else { Join-Path $env:LOCALAPPDATA 'Chartnaut' }
$binDir = Join-Path $root 'bin'

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
# ARM64 Windows runs the x64 build under its built-in emulation.
if ($arch -notin @('AMD64', 'ARM64')) { Fail "unsupported CPU architecture: $arch (Chartnaut needs 64-bit Windows)" }
$platform = if ($env:CHARTNAUT_PLATFORM) { $env:CHARTNAUT_PLATFORM } else { 'windows-x64' }

$manifestUrl = if ($env:CHARTNAUT_VERSION) { "$base/$($env:CHARTNAUT_VERSION)/manifest.json" } else { "$base/latest.json" }
try { $manifest = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing } catch { Fail "could not download $manifestUrl ($($_.Exception.Message))" }

$asset = $manifest.assets.$platform
if (-not $asset) { Fail "no Chartnaut CLI build for $platform (version $($manifest.version))" }

Write-Host "Installing Chartnaut CLI $($manifest.version) ($platform)" -ForegroundColor White

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("chartnaut-" + [Guid]::NewGuid().ToString('N') + '.exe')
try {
  try { Invoke-WebRequest -Uri $asset.url -OutFile $tmp -UseBasicParsing } catch { Fail "download failed: $($asset.url)" }
  $got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
  if ($got -ne $asset.sha256.ToLowerInvariant()) { Fail "checksum mismatch for $($asset.url) (expected $($asset.sha256), got $got). Nothing was installed." }

  # Prove it runs here before it replaces anything.
  & $tmp --version *> $null
  if ($LASTEXITCODE -ne 0) { Fail "the $platform build does not run on this machine. Nothing was installed." }

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $target = Join-Path $binDir 'chartnaut.exe'
  # A running chartnaut.exe cannot be overwritten, but it can be renamed out of the way.
  if (Test-Path $target) {
    $old = "$target.old"
    Remove-Item -Force $old -ErrorAction SilentlyContinue
    Rename-Item -Path $target -NewName 'chartnaut.exe.old' -ErrorAction SilentlyContinue
  }
  Move-Item -Force -Path $tmp -Destination $target
  Unblock-File -Path $target -ErrorAction SilentlyContinue
} finally {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host "installed $target" -ForegroundColor Green

if ($env:CHARTNAUT_NO_MODIFY_PATH -ne '1') {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($userPath) { $parts = $userPath.Split(';') | Where-Object { $_ -ne '' } }
  if ($parts -notcontains $binDir) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $binDir) -join ';'), 'User')
    Write-Host "added $binDir to your user PATH" -ForegroundColor Green
  }
  if (($env:Path.Split(';')) -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
  Write-Host 'Open a new terminal for other windows to see it.'
}

Write-Host ''
Write-Host 'Next:'
Write-Host '  chartnaut login      sign in with your browser'
Write-Host '  chartnaut init       set up a project for Claude Code or Codex'
Write-Host '  chartnaut --help'
