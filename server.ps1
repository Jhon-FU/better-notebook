param(
  [ValidateRange(1, 65535)][int]$Port = 8712,
  [string]$DataDirectory = ''
)

# Compatibility entry point; implementation lives with the other scripts.
& (Join-Path $PSScriptRoot 'scripts/server.ps1') @PSBoundParameters
