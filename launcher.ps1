param([ValidateRange(1, 65535)][int]$Port = 8712)

# Compatibility entry point for existing desktop shortcuts.
& (Join-Path $PSScriptRoot 'scripts/launcher.ps1') @PSBoundParameters
