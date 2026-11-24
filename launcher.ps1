param(
  [ValidateRange(1, 65535)][int]$Port = 8712,
  [switch]$CheckOnly,
  [ValidateRange(1, 60)][int]$StartupTimeoutSeconds = 10
)

# Compatibility entry point for existing desktop shortcuts.
& (Join-Path $PSScriptRoot 'scripts/launcher.ps1') @PSBoundParameters
exit $LASTEXITCODE
