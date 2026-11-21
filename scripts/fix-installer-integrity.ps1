param(
  [string]$Root = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  Write-Host 'Not Windows; skipping installer integrity fix.'
  exit 0
}

$rootPath = (Resolve-Path -LiteralPath $Root).Path
$targets = @()

$releaseExe = Join-Path $rootPath 'src-tauri\target\release\tauriview.exe'
if (Test-Path -LiteralPath $releaseExe) {
  $targets += $releaseExe
}

$nsisDir = Join-Path $rootPath 'src-tauri\target\release\bundle\nsis'
if (Test-Path -LiteralPath $nsisDir) {
  $targets += Get-ChildItem -LiteralPath $nsisDir -Filter '*.exe' -File |
    ForEach-Object { $_.FullName }
}

$targets = $targets | Select-Object -Unique
if (-not $targets) {
  Write-Warning "No built Windows executable found under $rootPath. Run 'tauri build' first."
  exit 0
}

foreach ($path in $targets) {
  & icacls.exe $path /setintegritylevel M | Out-Null
  if ($LASTEXITCODE -eq 5) {
    throw "Access denied setting integrity on $path. Run this from a normal (non-sandboxed) terminal."
  }
  if ($LASTEXITCODE -ne 0) {
    throw "icacls failed for $path (exit $LASTEXITCODE)"
  }

  # Low integrity is the failure mode we care about. Medium may be implicit,
  # so SDDL does not necessarily contain an explicit ME label.
  $sddl = (Get-Acl -LiteralPath $path).Sddl
  if ($sddl -match ';;;LW\)') {
    throw "Integrity is still Low: $path"
  }
  Write-Host "Integrity set to Medium: $path"
}
