param(
  [ValidateRange(1, 65535)][int]$Port = 8712,
  [switch]$CheckOnly,
  [ValidateRange(1, 60)][int]$StartupTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$url = 'http://127.0.0.1:' + $Port + '/notebook.html'
$logDirectory = Join-Path $root 'logs'
$errorLog = Join-Path $logDirectory ('server-' + $Port + '.error.log')
$server = $null
$ready = $false

try {
  . (Join-Path $PSScriptRoot 'startup.ps1')
  $build = Get-NotebookBuildId -Root $root
  $service = Get-NotebookServiceState -Port $Port -Root $root -Build $build
  if ($service.State -eq 'incompatible') {
    throw "Port $Port is occupied by an incompatible service ($($service.Reason)). Close the old notebook server or choose another -Port. No browser was opened."
  }

  if ($service.State -eq 'absent') {
    $null = [System.IO.Directory]::CreateDirectory($logDirectory)
    $serverPath = Join-Path $PSScriptRoot 'server.ps1'
    $server = Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $serverPath + '"'), '-Port', $Port
    ) -RedirectStandardOutput (Join-Path $logDirectory ('server-' + $Port + '.out.log')) -RedirectStandardError $errorLog -PassThru
    # Keep a process handle so Windows PowerShell retains the child's exit code.
    $null = $server.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    do {
      Start-Sleep -Milliseconds 150
      $service = Get-NotebookServiceState -Port $Port -Root $root -Build $build
      if ($service.State -eq 'ready') { break }
      $server.Refresh()
      if ($server.HasExited) {
        $server.WaitForExit()
        throw "Notebook server exited before becoming ready (exit $($server.ExitCode)). See $errorLog"
      }
      if ($service.State -eq 'incompatible') { throw "Notebook service identity check failed ($($service.Reason)). See $errorLog" }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($service.State -ne 'ready') { throw "Notebook server startup timed out after $StartupTimeoutSeconds seconds. See $errorLog" }
  }
  $ready = $true

  if ($CheckOnly) {
    Write-Output ('Notebook service ready: ' + $url)
    exit 0
  }

  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  $browser = $null
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $browser = $candidate; break }
  }
  if (-not $browser) { $browser = (Get-Command msedge -ErrorAction SilentlyContinue).Source }
  if (-not $browser) { throw 'No Edge or Chrome browser found. Install one, or open the notebook URL in a compatible browser.' }
  $profileDirectory = Join-Path $root 'profile'
  Start-Process -FilePath $browser -ArgumentList @('--no-first-run', '--no-default-browser-check', ('--user-data-dir="' + $profileDirectory + '"'), ('--app=' + $url)) -ErrorAction Stop
  exit 0
} catch {
  $message = "Lingdong Notes could not start.`r`n`r`n" + $_.Exception.Message + "`r`n`r`nApplication: $root`r`nURL: $url"
  # Only stop the child this invocation started, and only if it never became ready.
  if ($null -ne $server -and -not $ready) {
    try { $server.Refresh(); if (-not $server.HasExited) { $server.Kill(); $server.WaitForExit() } } catch {}
  }
  Write-Error $message -ErrorAction Continue
  if (-not $CheckOnly) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      $null = [System.Windows.Forms.MessageBox]::Show($message, 'Lingdong Notes - Startup failed', 'OK', 'Error')
    } catch {}
  }
  exit 1
}
